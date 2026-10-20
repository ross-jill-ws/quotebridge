// Local ABI adapter, not an upstream libzmq modification. SPDX-License-Identifier: MPL-2.0
// The static upstream library retains its Cdecl ABI. Only these wrappers use
// StdCall, as required by https://docs.mql4.com/runtime/imports .
#include <cstdint>
#include <zmq.h>
static_assert(sizeof(void *) == 4 && sizeof(size_t) == 4, "x86 only");
static void *pointer(std::int32_t value) { return reinterpret_cast<void *>(static_cast<std::uintptr_t>(value)); }
static std::int32_t handle(void *value) { return static_cast<std::int32_t>(reinterpret_cast<std::uintptr_t>(value)); }
extern "C" {
std::int32_t __stdcall qb_zmq_ctx_new() { return handle(zmq_ctx_new()); }
int __stdcall qb_zmq_ctx_term(std::int32_t context) { return zmq_ctx_term(pointer(context)); }
std::int32_t __stdcall qb_zmq_socket(std::int32_t context, int type) { return handle(zmq_socket(pointer(context), type)); }
int __stdcall qb_zmq_close(std::int32_t socket) { return zmq_close(pointer(socket)); }
int __stdcall qb_zmq_connect(std::int32_t socket, const char *endpoint) { return zmq_connect(pointer(socket), endpoint); }
int __stdcall qb_zmq_setsockopt(std::int32_t socket, int option, const void *value, int length) {
    return zmq_setsockopt(pointer(socket), option, value, static_cast<size_t>(length));
}
int __stdcall qb_zmq_send(std::int32_t socket, const void *buffer, int length, int flags) {
    return zmq_send(pointer(socket), buffer, static_cast<size_t>(length), flags);
}
int __stdcall qb_zmq_recv(std::int32_t socket, void *buffer, int length, int flags) {
    return zmq_recv(pointer(socket), buffer, static_cast<size_t>(length), flags);
}
int __stdcall qb_zmq_errno() { return zmq_errno(); }
// Diagnostics only; not required by the current EA imports.
void __stdcall qb_zmq_version(int *major, int *minor, int *patch) { zmq_version(major, minor, patch); }
int __stdcall qb_zmq_getsockopt(std::int32_t socket, int option, void *value, size_t *length) {
    return zmq_getsockopt(pointer(socket), option, value, length);
}
}
