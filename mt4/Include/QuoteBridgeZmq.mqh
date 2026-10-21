// Minimal 32-bit MT4 bindings. Existing include files are not modified.
#ifndef QUOTE_BRIDGE_ZMQ
#define QUOTE_BRIDGE_ZMQ
#define QB_DEALER 5
#define QB_IDENTITY 5
#define QB_DONTWAIT 1
#define QB_LINGER 17
#define QB_SNDHWM 23
#define QB_RCVHWM 24
#define QB_IMMEDIATE 39
#import "libzmq-mt-4_3_5.dll"
int zmq_ctx_new();
int zmq_ctx_term(int context);
int zmq_socket(int context,int type);
int zmq_close(int socket);
int zmq_connect(int socket,uchar &endpoint[]);
int zmq_setsockopt(int socket,int option,const uchar &value[],int length);
int zmq_send(int socket,const uchar &buffer[],int length,int flags);
int zmq_recv(int socket,uchar &buffer[],int length,int flags);
int zmq_errno();
#import
bool QBOption(int handle,int option,int value) {
 uchar bytes[4];
 bytes[0]=(uchar)(value&255);bytes[1]=(uchar)((value>>8)&255);
 bytes[2]=(uchar)((value>>16)&255);bytes[3]=(uchar)((value>>24)&255);
 return zmq_setsockopt(handle,option,bytes,4)==0;
}
#endif
