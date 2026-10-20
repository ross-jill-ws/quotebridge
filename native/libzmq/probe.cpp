#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdint>
#include <cstdio>
#include <stdexcept>
#include <cstring>
static void require(bool ok, const char *message) { if (!ok) throw std::runtime_error(message); }
template<typename T> T symbol(HMODULE dll, const char *name) {
    FARPROC result = GetProcAddress(dll, name);
    require(result != nullptr, name);
#pragma warning(suppress: 4191)
    return reinterpret_cast<T>(result);
}
int wmain(int argc, wchar_t **argv) {
    static_assert(sizeof(void *) == 4, "x86 probe only");
    HMODULE dll = nullptr;
    std::int32_t context = 0, socket = 0;
    using Unary = int (__stdcall *)(std::int32_t);
    Unary closeSocket = nullptr, term = nullptr;
    int result = 1;
    try {
        require(argc == 2, "absolute DLL path required");
        require(SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32) != FALSE, "SetDefaultDllDirectories");
        dll = LoadLibraryExW(argv[1], nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
        require(dll != nullptr, "LoadLibraryExW");
        const auto version = symbol<void (__stdcall *)(int *, int *, int *)>(dll, "zmq_version");
        const auto create = symbol<std::int32_t (__stdcall *)()>(dll, "zmq_ctx_new");
        term = symbol<Unary>(dll, "zmq_ctx_term");
        const auto makeSocket = symbol<std::int32_t (__stdcall *)(std::int32_t, int)>(dll, "zmq_socket");
        closeSocket = symbol<Unary>(dll, "zmq_close");
        const auto connectSocket = symbol<int (__stdcall *)(std::int32_t, const char *)>(dll, "zmq_connect");
        const auto setOption = symbol<int (__stdcall *)(std::int32_t, int, const void *, int)>(dll, "zmq_setsockopt");
        const auto getOption = symbol<int (__stdcall *)(std::int32_t, int, void *, size_t *)>(dll, "zmq_getsockopt");
        const auto send = symbol<int (__stdcall *)(std::int32_t, const void *, int, int)>(dll, "zmq_send");
        const auto recv = symbol<int (__stdcall *)(std::int32_t, void *, int, int)>(dll, "zmq_recv");
        const auto error = symbol<int (__stdcall *)()>(dll, "zmq_errno");
        int major = 0, minor = 0, patch = 0;
        version(&major, &minor, &patch);
        require(major == 4 && minor == 3 && patch == 5, "version mismatch");
        std::printf("Pointer size: %zu; ZeroMQ %d.%d.%d; all required exports found\n", sizeof(void *), major, minor, patch);
        context = create(); require(context != 0, "context creation");
        socket = makeSocket(context, 5); require(socket != 0, "DEALER creation");
        const int options[][2] = {{17,0},{23,64},{24,64},{39,1},{79,3000},{66,5000}};
        for (const auto &pair : options) {
            // Mirror QBOption's byte-array packing, not just a C int pointer.
            const unsigned int v = static_cast<unsigned int>(pair[1]);
            const unsigned char bytes[] = {static_cast<unsigned char>(v), static_cast<unsigned char>(v >> 8), static_cast<unsigned char>(v >> 16), static_cast<unsigned char>(v >> 24)};
            require(setOption(socket, pair[0], bytes, 4) == 0, "setsockopt");
            int actual = -1; size_t length = sizeof(actual);
            require(getOption(socket, pair[0], &actual, &length) == 0 && length == 4 && actual == pair[1], "option readback");
            std::printf("Option %d = %d verified\n", pair[0], actual);
        }
        const char identity[] = "QuoteBridge-isolated-ABI-probe";
        require(setOption(socket, 5, identity, static_cast<int>(sizeof(identity)-1)) == 0, "identity");
        char identityReadback[64] = {}; size_t identityLength = sizeof(identityReadback);
        require(getOption(socket, 5, identityReadback, &identityLength) == 0 && identityLength == sizeof(identity)-1 && std::memcmp(identityReadback, identity, identityLength) == 0, "identity buffer readback");
        // Only an in-process endpoint; never connects to a server, broker or TCP port.
        require(connectSocket(socket, "inproc://QuoteBridge-isolated-ABI-probe") == 0, "inproc connect");
        std::uintptr_t before = 0, after = 0;
        __asm mov before, esp
        for (int i = 0; i < 10000; ++i) {
            require(setOption(socket, 17, &options[0][1], 4) == 0, "repeated stdcall");
            (void)error();
        }
        __asm mov after, esp
        require(before == after, "stack drift");
        char buffer[32] = {};
        require(recv(socket, buffer, sizeof(buffer), 1) == -1 && error() == 11, "nonblocking recv EAGAIN");
        const int sent = send(socket, buffer, 1, 1);
        require(sent == 1 || (sent == -1 && error() == 11), "nonblocking inproc send");
        require(closeSocket(socket) == 0, "socket close"); socket = 0;
        require(term(context) == 0, "context termination"); context = 0;
        std::puts("PASS: StdCall ABI, 10000 repeated calls without stack drift, context/DEALER/options and nonblocking IO; no TCP connections");
        result = 0;
    } catch (const std::exception &e) { std::fprintf(stderr, "FAIL: %s (Win32=%lu)\n", e.what(), GetLastError()); }
    if (socket && closeSocket) closeSocket(socket);
    if (context && term) term(context);
    if (dll) FreeLibrary(dll);
    return result;
}
