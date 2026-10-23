#property strict
#property version "1.09"
#property description "Quote Bridge: live quotes and holdings; opt-in DEMO trading only."
// Installed and compiled by QuoteBridge for MetaTrader with the terminal's own MetaEditor; do not edit here.
// Sent as the last hello field; keep equal to #property version.
#define QB_EA_VERSION "1.09"
#include "..\Include\QuoteBridgeZmq.mqh"
input string ServerEndpoint="tcp://127.0.0.1:5555";
input string TerminalId="mt4-main";
input int SamplingMilliseconds=500;
input int BufferCapacity=1200;
int context=0,socket=0,head=0,count=0;
string session,rows[],quoteStatus="no-quote";
long sequences[],nextSequence=0,dropped=0,inflightLast=0;
string inflight="";
bool subscribed=false;
uint lastHello=0,lastSend=0,lastReply=0,lastConnect=0,lastWarning=0;
bool serverConfirmed=false;
int sendError=0;
string Clean(string s) {StringReplace(s,"|","_");StringReplace(s,"\r","_");StringReplace(s,"\n","_");return s;}
bool Send(string message) {
 uchar bytes[];int n=StringToCharArray(message,bytes,0,WHOLE_ARRAY,CP_UTF8)-1;
 if(socket==0 || n<=0)return false;
 int sent=zmq_send(socket,bytes,n,QB_DONTWAIT);
 if(sent==n){sendError=0;return true;}
 sendError=zmq_errno();
 if((uint)(GetTickCount()-lastWarning)>=10000){Print("QuoteBridge send pending/failed, errno=",sendError," endpoint=",ServerEndpoint," (connect is asynchronous)");lastWarning=GetTickCount();}
 return false;
}
#include "..\Include\QuoteBridgeTrading.mqh"

// A frozen CopyRates snapshot is streamed in small messages after quote flushing.
// No history files, orders, DLL changes, or additional ZeroMQ ports are needed.
MqlRates candleRates[];
string candleRequest="";
int candleOffset=0,candleTotal=0,candleAvailable=0,candleTimeframe=0;
int HigherTimeframe(int period) {
 switch(period){case 1:return 5;case 5:return 15;case 15:return 30;case 30:return 60;case 60:return 240;case 240:return 1440;case 1440:return 10080;case 10080:return 43200;}
 return 0;
}
void RequestCandles(string request,int timeframe,int limit) {
 if((timeframe!=Period() && timeframe!=HigherTimeframe(Period())) || (limit!=2 && limit!=2000) || StringToInteger(request)<=0)return;
 if(candleRequest==request)return;
 candleRequest=request;candleOffset=0;candleTimeframe=timeframe;
 ArraySetAsSeries(candleRates,false);
 candleAvailable=iBars(Symbol(),timeframe);
 int copied=CopyRates(Symbol(),timeframe,0,limit,candleRates);
 candleTotal=MathMax(0,copied);
 candleAvailable=MathMax(candleAvailable,candleTotal);
}
void FlushCandles() {
 if(candleRequest=="")return;
 for(int batch=0;batch<8;batch++) {
  int end=MathMin(candleOffset+32,candleTotal);
  string payload="";
  for(int i=candleOffset;i<end;i++) {
   if(i>candleOffset)payload+=";";
   payload+=IntegerToString((long)candleRates[i].time)+","+DoubleToString(candleRates[i].open,Digits)+","+DoubleToString(candleRates[i].high,Digits)+","+DoubleToString(candleRates[i].low,Digits)+","+DoubleToString(candleRates[i].close,Digits);
  }
  string wire="B|1|"+session+"|"+candleRequest+"|"+IntegerToString(candleTimeframe)+"|"+IntegerToString(candleAvailable)+"|"+IntegerToString(candleTotal)+"|"+IntegerToString(candleOffset)+"|"+payload;
  if(!Send(wire))return;
  candleOffset=end;
  if(candleOffset>=candleTotal){candleRequest="";ArrayResize(candleRates,0);return;}
 }
}

void Hello() {
 Send("H|1|"+session+"|"+Clean(TerminalId)+"|"+Clean(AccountServer())+"|"+Clean(Symbol())+"|"+IntegerToString(Digits)+"|"+IntegerToString(SamplingMilliseconds)+"|"+IntegerToString(dropped)+"|"+quoteStatus+"|"+IntegerToString(Period())+"|2000|1|"+QB_EA_VERSION);
 AccountHello();
 lastHello=GetTickCount();
}
void Cleanup() {
 EventKillTimer();
 if(socket!=0){zmq_close(socket);socket=0;}
 if(context!=0){zmq_ctx_term(context);context=0;}
 Comment("");
}
bool ConnectSocket() {
 if(socket!=0){zmq_close(socket);socket=0;}
 lastConnect=GetTickCount();serverConfirmed=false;candleRequest="";ArrayResize(candleRates,0);
 socket=zmq_socket(context,QB_DEALER);if(socket==0){return false;}
 if(!QBOption(socket,QB_LINGER,0)||!QBOption(socket,QB_SNDHWM,64)||!QBOption(socket,QB_RCVHWM,64)||!QBOption(socket,QB_IMMEDIATE,1)){return false;}
 if(!QBOption(socket,79,3000)||!QBOption(socket,66,5000))return false; // CONNECT_TIMEOUT / HANDSHAKE_IVL
 uchar identity[];int n=StringToCharArray(session,identity,0,WHOLE_ARRAY,CP_UTF8)-1;
 if(zmq_setsockopt(socket,QB_IDENTITY,identity,n)!=0){return false;}
 uchar endpoint[];StringToCharArray(ServerEndpoint,endpoint,0,WHOLE_ARRAY,CP_UTF8);
 if(zmq_connect(socket,endpoint)!=0){Print("QuoteBridge connect failed: ",zmq_errno());Cleanup();return false;}
 Print("QuoteBridge connecting to ",ServerEndpoint,"; waiting for server registration confirmation");
 return true;
}
int OnInit() {
 if(!MathIsValidNumber(MaxDemoOrderLots)||MaxDemoOrderLots<=0)return INIT_PARAMETERS_INCORRECT;
 if(!IsDllsAllowed()){Print("QuoteBridge requires Allow DLL imports");return INIT_FAILED;}
 if((SamplingMilliseconds!=500 && SamplingMilliseconds!=1000)||BufferCapacity<32||BufferCapacity>20000||StringLen(TerminalId)<1||StringLen(TerminalId)>100||StringFind(ServerEndpoint,"tcp://127.0.0.1:")!=0) return INIT_PARAMETERS_INCORRECT;
 // A chart or parameter change re-inits the EA but keeps its globals. The batch in flight names the old session, which
 // the server refuses from the new one, so it is rebuilt from the queue; a resized buffer no longer fits its positions.
 inflight="";inflightLast=0;
 if(ArraySize(rows)!=BufferCapacity){head=0;count=0;}
 ArrayResize(rows,BufferCapacity);ArrayResize(sequences,BufferCapacity);
 // Chart ID + local epoch + monotonic clock separates simultaneous attachments/restarts.
 session=IntegerToString(ChartID())+"-"+IntegerToString((long)TimeLocal())+"-"+IntegerToString((long)GetMicrosecondCount());
 context=zmq_ctx_new();if(context==0)return INIT_FAILED;
 if(!ConnectSocket()){Cleanup();return INIT_FAILED;}
 if(!EventSetMillisecondTimer(SamplingMilliseconds)){Cleanup();return INIT_FAILED;}
 Hello();return INIT_SUCCEEDED;
}
void Receive() {
 uchar buffer[4096];
 for(int i=0;i<16;i++) {
  int n=zmq_recv(socket,buffer,4096,QB_DONTWAIT);if(n<0)break;
  if(n==0||n>4096)continue;
  string fields[];int parts=StringSplit(CharArrayToString(buffer,0,n,CP_UTF8),StringGetCharacter("|",0),fields);
  if(parts<3||fields[1]!="1"||fields[2]!=session)continue;
  if(fields[0]!="R" && fields[0]!="C" && fields[0]!="A" && fields[0]!="B" && fields[0]!="V" && fields[0]!="P" && fields[0]!="X")continue;
  lastReply=GetTickCount();
  if(!serverConfirmed){Print("QuoteBridge server confirmed connection for ",Symbol());serverConfirmed=true;}
  if(TradingReceive(fields,parts))continue;
  if(fields[0]=="R"){Hello();continue;}
  if(fields[0]=="B" && parts==6){RequestCandles(fields[3],(int)StringToInteger(fields[4]),(int)StringToInteger(fields[5]));continue;}
  if(parts!=4)continue;
  if(fields[0]=="C" && (fields[3]=="0"||fields[3]=="1")){subscribed=fields[3]=="1";continue;}
  if(fields[0]=="A") {
   long ack=StringToInteger(fields[3]);
   // Acknowledge only the exact outstanding batch; ignore stale/malformed ACKs.
   if(inflight==""||ack!=inflightLast)continue;
   while(count>0 && sequences[head]<=ack){rows[head]="";head=(head+1)%BufferCapacity;count--;}
   inflight="";inflightLast=0;
  }
 }
}
void Capture() {
 if(!subscribed)return;
 MqlTick tick;
 if(!SymbolInfoTick(Symbol(),tick)||tick.time<=0||!MathIsValidNumber(tick.bid)||!MathIsValidNumber(tick.ask)||tick.bid<=0||tick.ask<tick.bid){quoteStatus="no-quote";return;}
 quoteStatus="ok";nextSequence++;
 // Preserve oldest unacknowledged records. Report dropped new samples explicitly.
 if(count==BufferCapacity){dropped++;return;}
 int index=(head+count)%BufferCapacity;
 sequences[index]=nextSequence;
 rows[index]=IntegerToString(nextSequence)+","+DoubleToString(tick.bid,Digits)+","+DoubleToString(tick.ask,Digits)+","+IntegerToString((long)tick.time)+","+IntegerToString((long)TimeLocal());
 count++;
}
void Flush() {
 if(count==0)return;
 uint now=GetTickCount();
 if(inflight!="") {if((uint)(now-lastSend)>=2000){Send(inflight);lastSend=now;}return;}
 string payload="";int length=MathMin(count,32);
 for(int i=0;i<length;i++){int index=(head+i)%BufferCapacity;if(i>0)payload+=";";payload+=rows[index];inflightLast=sequences[index];}
 inflight="T|1|"+session+"|"+payload;Send(inflight);lastSend=now;
}
void OnTimer() {
 // Refresh the safety clock even when recording is off, before handling trades.
 ObserveTradingClock();
 if(socket!=0)Receive();
 uint now=GetTickCount();
 uint since=serverConfirmed?lastReply:lastConnect;
 if((uint)(now-since)>=15000){
  Print("QuoteBridge: no server reply for 15 seconds; reconnecting, queued samples preserved");
  if(!ConnectSocket()){if(socket!=0){zmq_close(socket);socket=0;}Print("QuoteBridge socket reset failed, errno=",zmq_errno());}
  if(socket!=0)Hello();
 }
 Capture();
 if(socket!=0){if((uint)(GetTickCount()-lastHello)>=2000)Hello();Flush();FlushAccount();FlushCandles();}
 Comment("QuoteBridge | ",Symbol()," | ",serverConfirmed?"server connected":"SERVER NOT CONFIRMED"," | errno ",sendError," | ",subscribed?"subscribed":"idle"," | queued ",count," | dropped ",dropped," | ",quoteStatus);
}
void OnDeinit(const int reason) {
 // A chart or parameter change keeps the EA loaded, queue and all; any other reason unloads it.
 bool kept=reason==REASON_CHARTCHANGE||reason==REASON_PARAMETERS;
 Print("QuoteBridge stopped; queued samples ",kept?"kept for the restart: ":"lost: ",count,"; dropped: ",dropped);
 Cleanup();
}
