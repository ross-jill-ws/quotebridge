// Demo-only order adapter. Included AFTER Send() and the quote bridge globals.
// Enable on EXACTLY ONE chart per account. No trailing comment: MT4 would show it in Inputs instead of the name the docs use.
input bool EnableDemoTrading=false;
input double MaxDemoOrderLots=1.0;
input int DemoMagicNumber=27012026;
// All 1000 supported orders (20 per page) can leave in one timer, even at a 1000 ms interval.
#define QB_ACCOUNT_FLUSH_PAGES 50
string accountRows[],accountHeader="";
int accountOffset=0,accountCount=0,accountLogin=0;
string TradeText(string s){s=Clean(s);StringReplace(s,",","_");StringReplace(s,";","_");return s;}
string N(double n){return DoubleToString(n,10);}
datetime lastServerClock=0;uint lastServerClockTick=0;bool clockObserved=false;
void ObserveTradingClock(){
 datetime now=TimeCurrent();
 if(now!=lastServerClock){if(lastServerClock!=0)clockObserved=true;lastServerClock=now;lastServerClockTick=GetTickCount();}
}
bool TradeReady(){return IsConnected() && IsTradeAllowed() && IsExpertEnabled() && clockObserved && GetTickCount()-lastServerClockTick<=30000;}
void AccountHello(){
 if(AccountNumber()<=0)return;
 // EA 1.12: append the configured new-order cap; preserve the first eight fields.
 Send("I|1|"+session+"|"+IntegerToString(AccountNumber())+"|"+TradeText(AccountCurrency())+"|"+(IsDemo()?"1":"0")+"|"+(EnableDemoTrading?"1":"0")+"|"+(TradeReady()?"1":"0")+"|"+N(MaxDemoOrderLots));
}
void ReadError(string request,string message){Send("E|1|"+session+"|"+request+"|"+IntegerToString(AccountNumber())+"|"+TradeText(message));}
void AccountSnapshot(string request){
 accountHeader="";accountCount=0;accountOffset=0;accountLogin=AccountNumber();
 int total=OrdersTotal();
 if(total>1000){ReadError(request,"Account exceeds the 1000-order snapshot limit");return;}
 ArrayResize(accountRows,total);
 for(int i=0;i<total;i++){
  if(!OrderSelect(i,SELECT_BY_POS,MODE_TRADES)){ReadError(request,"Orders changed while reading; refresh");return;}
  int kind=OrderType();if(kind<0||kind>5)continue;
  accountRows[accountCount++]=IntegerToString(OrderTicket())+","+IntegerToString(kind)+","+TradeText(OrderSymbol())+","+N(OrderLots())+","+N(OrderOpenPrice())+","+IntegerToString((long)OrderOpenTime())+","+N(OrderStopLoss())+","+N(OrderTakeProfit())+","+IntegerToString((long)OrderExpiration())+","+N(OrderProfit())+","+N(OrderSwap())+","+N(OrderCommission())+","+IntegerToString(OrderMagicNumber())+","+N(OrderClosePrice());
 }
 accountHeader="V|1|"+session+"|"+request+"|"+IntegerToString(accountLogin)+"|"+TradeText(AccountServer())+"|"+TradeText(AccountCurrency())+"|"+(IsDemo()?"1":"0")+"|"+N(AccountBalance())+"|"+N(AccountEquity())+"|"+N(AccountMargin())+"|"+N(AccountFreeMargin())+"|"+N(AccountProfit())+"|"+IntegerToString(AccountLeverage())+"|"+(TradeReady()?"1":"0")+"|"+IntegerToString((long)TimeCurrent())+"|"+IntegerToString(accountCount)+"|";
}
void FlushAccount(){
 if(accountHeader=="")return;
 if(accountLogin!=AccountNumber()){accountHeader="";return;}
 for(int batch=0;batch<QB_ACCOUNT_FLUSH_PAGES;batch++){
  int end=MathMin(accountOffset+20,accountCount);string payload="";
  for(int i=accountOffset;i<end;i++){if(i>accountOffset)payload+=";";payload+=accountRows[i];}
  if(!Send(accountHeader+IntegerToString(accountOffset)+"|"+payload))return;
  accountOffset=end;if(accountOffset>=accountCount){accountHeader="";ArrayResize(accountRows,0);return;}
 }
}
void MarketSnapshot(string request,string symbol){
 if(!SymbolSelect(symbol,true)){ReadError(request,"Unknown symbol");return;}
 double point=MarketInfo(symbol,MODE_POINT),minlot=MarketInfo(symbol,MODE_MINLOT),step=MarketInfo(symbol,MODE_LOTSTEP);
 double tick=SymbolInfoDouble(symbol,SYMBOL_TRADE_TICK_SIZE);if(tick<=0)tick=point;
 if(point<=0||minlot<=0||step<=0||MarketInfo(symbol,MODE_TIME)<=0){ReadError(request,"Symbol metadata or quotes unavailable");return;}
 Send("P|1|"+session+"|"+request+"|"+IntegerToString(AccountNumber())+"|"+TradeText(symbol)+"|"+N(MarketInfo(symbol,MODE_BID))+"|"+N(MarketInfo(symbol,MODE_ASK))+"|"+IntegerToString((int)MarketInfo(symbol,MODE_DIGITS))+"|"+N(point)+"|"+N(tick)+"|"+N(minlot)+"|"+N(MarketInfo(symbol,MODE_MAXLOT))+"|"+N(step)+"|"+IntegerToString((int)MarketInfo(symbol,MODE_STOPLEVEL))+"|"+IntegerToString((int)MarketInfo(symbol,MODE_FREEZELEVEL))+"|"+(MarketInfo(symbol,MODE_TRADEALLOWED)>0?"1":"0")+"|"+IntegerToString((long)MarketInfo(symbol,MODE_TIME))+"|"+N(MarketInfo(symbol,MODE_TICKVALUE))
  +"|"+N(MarketInfo(symbol,MODE_LOTSIZE))+"|"+N(MarketInfo(symbol,MODE_MARGINREQUIRED))+"|"+N(MarketInfo(symbol,MODE_SWAPLONG))+"|"+N(MarketInfo(symbol,MODE_SWAPSHORT))+"|"+IntegerToString((int)MarketInfo(symbol,MODE_SWAPTYPE))+"|"+TradeText(SymbolInfoString(symbol,SYMBOL_CURRENCY_PROFIT))+"|"+IntegerToString((long)MarketInfo(symbol,MODE_STARTING))+"|"+IntegerToString((long)MarketInfo(symbol,MODE_EXPIRATION)));
}
void TradeResult(string request,int login,string status,int ticket,int code,string message){
 // Remember preflight rejections too: a duplicate must not become executable
 // merely because permissions, price or account later change.
 string key="QB1."+IntegerToString(login)+"."+request;
 if(status=="rejected" && !GlobalVariableCheck(key))TradeMarker(key,-10000-code);
 Send("X|1|"+session+"|"+request+"|"+IntegerToString(login)+"|"+status+"|"+IntegerToString(MathMax(0,ticket))+"|"+IntegerToString(code)+"|"+TradeText(message));
}
bool TradeRequestId(string value){
 if(StringLen(value)!=32)return false;
 for(int i=0;i<32;i++){int c=StringGetCharacter(value,i);if(!((c>=48&&c<=57)||(c>=97&&c<=102)))return false;}
 return true;
}
bool TradeMarker(string key,double value){
 ResetLastError();if(GlobalVariableSet(key,value)==0)return false;
 GlobalVariablesFlush();return GetLastError()==0;
}
void ExecuteDemo(string &f[]){
 string request=f[3],action=f[6],symbol=f[8];int login=(int)StringToInteger(f[4]);
 int kind=(int)StringToInteger(f[7]),ticket=(int)StringToInteger(f[9]),slippage=(int)StringToInteger(f[15]);
 double lots=StringToDouble(f[10]),price=StringToDouble(f[11]),sl=StringToDouble(f[12]),tp=StringToDouble(f[13]),cap=StringToDouble(f[16]);
 datetime expiry=(datetime)StringToInteger(f[14]);
 if(!TradeRequestId(request))return;
 string key="QB1."+IntegerToString(login)+"."+request;
 if(GlobalVariableCheck(key)){
  double result=GlobalVariableGet(key);
  if(result>=1)TradeResult(request,login,"succeeded",(int)result,0,"Previously executed request; not executed again");
  else if(result<=-10000)TradeResult(request,login,"rejected",0,(int)(-result-10000),"Previously rejected request; not executed again");
  else TradeResult(request,login,"unknown",0,0,"Request already seen; verify MT4 orders and history");
  return;
 }
 if(login!=AccountNumber() || f[5]!=TradeText(AccountServer()) || !IsDemo() || !EnableDemoTrading || !TradeReady() || IsTradeContextBusy()){
  TradeResult(request,login,"rejected",0,9001,"Demo execution disabled or account connection changed");return;
 }
 if((action!="N"&&action!="C"&&action!="M"&&action!="D") || kind<0||kind>5||slippage<0||slippage>10000||cap<=0||MaxDemoOrderLots<=0||!SymbolSelect(symbol,true)){
  TradeResult(request,login,"rejected",0,9002,"Invalid order parameters");return;
 }
 for(int n=10;n<=16;n++)if(!MathIsValidNumber(StringToDouble(f[n]))||StringToDouble(f[n])<0){TradeResult(request,login,"rejected",0,9002,"Invalid numeric parameter");return;}
 if(action!="N"){
  if(!OrderSelect(ticket,SELECT_BY_TICKET)||OrderCloseTime()!=0||OrderSymbol()!=symbol||OrderType()!=kind||
   OrderOpenTime()!=(datetime)StringToInteger(f[17])||MathAbs(OrderOpenPrice()-StringToDouble(f[18]))>0.00000001||MathAbs(OrderLots()-StringToDouble(f[19]))>0.00000001||
   MathAbs(OrderStopLoss()-StringToDouble(f[20]))>0.00000001||MathAbs(OrderTakeProfit()-StringToDouble(f[21]))>0.00000001||OrderExpiration()!=(datetime)StringToInteger(f[22])){
   TradeResult(request,login,"rejected",0,9003,"Order changed since confirmation; refresh Holding");return;
  }
  if((action=="C"&&kind>1)||(action=="D"&&kind<2)){TradeResult(request,login,"rejected",0,9002,"Wrong operation for order type");return;}
  if(action=="M" && MathAbs(lots-OrderLots())>0.00000001){TradeResult(request,login,"rejected",0,9002,"Changing order volume is not supported");return;}
 }
 double bid=MarketInfo(symbol,MODE_BID),ask=MarketInfo(symbol,MODE_ASK),point=MarketInfo(symbol,MODE_POINT);
 double step=MarketInfo(symbol,MODE_LOTSTEP),minlot=MarketInfo(symbol,MODE_MINLOT),maxlot=MarketInfo(symbol,MODE_MAXLOT),distance=MarketInfo(symbol,MODE_STOPLEVEL)*point;
 int digits=(int)MarketInfo(symbol,MODE_DIGITS);bool buy=(kind%2==0),pending=(kind>=2);
 if(bid<=0||ask<bid||point<=0||step<=0||MarketInfo(symbol,MODE_TRADEALLOWED)==0){TradeResult(request,login,"rejected",0,9004,"Quotes or trading unavailable");return;}
 datetime quoteTime=(datetime)MarketInfo(symbol,MODE_TIME);
 if(TimeCurrent()-quoteTime>30||quoteTime-TimeCurrent()>5){TradeResult(request,login,"rejected",0,9012,"Stale symbol quote; wait for fresh ticks");return;}
 // Broker slippage alone is relative to OrderSend/OrderClose's supplied price. Keep that price
 // anchored to the approved preview, not a newer quote that could silently widen the approval.
 if((action=="N"&&!pending)||action=="C"){
  double approvedQuote=(action=="C"?(buy?bid:ask):(buy?ask:bid));
  if(price<=0||MathAbs(approvedQuote-price)>slippage*point+0.00000001){TradeResult(request,login,"rejected",0,9014,"Price moved beyond approved slippage; preview again");return;}
 }
 double tickSize=SymbolInfoDouble(symbol,SYMBOL_TRADE_TICK_SIZE);if(tickSize<=0)tickSize=point;
 if(action=="N"||action=="M"){
  if((sl>0&&MathAbs(sl/tickSize-MathRound(sl/tickSize))>0.0001)||(tp>0&&MathAbs(tp/tickSize-MathRound(tp/tickSize))>0.0001)||(pending&&MathAbs(price/tickSize-MathRound(price/tickSize))>0.0001)){
   TradeResult(request,login,"rejected",0,9013,"Price does not match symbol tick size");return;
  }
 }
 if(action=="N" && (ticket!=0||lots<minlot-0.00000001||lots>MathMin(maxlot,MathMin(cap,MaxDemoOrderLots))+0.00000001||MathAbs(lots/step-MathRound(lots/step))>0.000001)){
  TradeResult(request,login,"rejected",0,9005,"Invalid lot size or demo lot cap exceeded");return;
 }
 if(action=="N"||action=="M"){
  if(expiry!=0 && (!pending||expiry<=TimeCurrent())){TradeResult(request,login,"rejected",0,9006,"Invalid pending expiration");return;}
  double reference=pending?price:(buy?bid:ask);
  if(pending){bool above=(kind==3||kind==4);double quote=buy?ask:bid;
   if(price<=0||(above?price<=quote:price>=quote)||MathAbs(price-quote)+0.00000001<distance){TradeResult(request,login,"rejected",0,9007,"Pending entry wrong side or too close to market");return;}
  }
  if(sl>0&&((buy?sl>=reference:sl<=reference)||MathAbs(sl-reference)+0.00000001<distance)){TradeResult(request,login,"rejected",0,9008,"Invalid stop loss");return;}
  if(tp>0&&((buy?tp<=reference:tp>=reference)||MathAbs(tp-reference)+0.00000001<distance)){TradeResult(request,login,"rejected",0,9009,"Invalid take profit");return;}
  if(action=="N"){ResetLastError();if(AccountFreeMarginCheck(symbol,buy?OP_BUY:OP_SELL,lots)<=0 || GetLastError()==134){TradeResult(request,login,"rejected",0,134,"Insufficient free margin");return;}}
 }
 datetime deadline=(datetime)StringToInteger(f[23]);
 if(TimeGMT()>deadline || deadline-TimeGMT()>60){TradeResult(request,login,"rejected",0,9010,"Command expired or server clock differs; preview again");return;}
 // Persist the seen marker BEFORE calling any broker operation. Never replay an
 // ambiguous execution after restart. MT4 terminal globals are explicitly flushed.
 if(!TradeMarker(key,-1)){TradeResult(request,login,"rejected",0,9011,"Could not persist duplicate guard; no order sent");return;}
 ResetLastError();bool success=false;int resultTicket=ticket;
 if(action=="N"){
  double entry=price;
  resultTicket=OrderSend(symbol,kind,lots,NormalizeDouble(entry,digits),slippage,NormalizeDouble(sl,digits),NormalizeDouble(tp,digits),"QB:"+StringSubstr(request,0,24),DemoMagicNumber,expiry,clrNONE);
  success=resultTicket>0;
 }else if(action=="C")success=OrderClose(ticket,OrderLots(),NormalizeDouble(price,digits),slippage,clrNONE);
 else if(action=="D")success=OrderDelete(ticket,clrNONE);
 else if(action=="M")success=OrderModify(ticket,pending?NormalizeDouble(price,digits):OrderOpenPrice(),NormalizeDouble(sl,digits),NormalizeDouble(tp,digits),pending?expiry:0,clrNONE);
 int error=GetLastError();
 if(success){TradeMarker(key,resultTicket);TradeResult(request,login,"succeeded",resultTicket,0,"MT4 confirmed operation");}
 else if(error==0||error==2||error==6||error==128){TradeResult(request,login,"unknown",0,error,"Broker result uncertain; inspect MT4 orders and history before retrying");}
 else{TradeMarker(key,-10000-error);TradeResult(request,login,"rejected",0,error,"MT4 rejected operation; error "+IntegerToString(error));}
}
bool TradingReceive(string &f[],int parts){
 if(f[0]!="V"&&f[0]!="P"&&f[0]!="X")return false;
 if(parts<6||!TradeRequestId(f[3]))return true;
 if(f[0]=="X" && parts==24){ExecuteDemo(f);return true;}
 if((int)StringToInteger(f[4])!=AccountNumber()||f[5]!=TradeText(AccountServer())){ReadError(f[3],"Account changed; reload account selection");return true;}
 if(f[0]=="V" && parts==6)AccountSnapshot(f[3]);
 if(f[0]=="P" && parts==7)MarketSnapshot(f[3],f[6]);
 return true;
}
