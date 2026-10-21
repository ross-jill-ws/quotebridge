# libzmq for the QuoteBridge EA (x86)

`libzmq-mt-4_3_5.dll` is the ZeroMQ library the QuoteBridge EA imports. ZeroMQ publishes 4.3.5 as source only, so it is built here:

- The unchanged upstream `zeromq-4.3.5.zip` is downloaded from the [v4.3.5 release](https://github.com/zeromq/libzmq/releases/tag/v4.3.5) and checked against pinned SHA-256 and SHA-1 hashes, then built as a static library (CURVE, TLS, WebSocket, drafts and tests off).
- `adapter.cpp` wraps it in a DLL. MQL4 calls imported functions with `__stdcall` ([docs](https://docs.mql4.com/runtime/imports)) while upstream uses cdecl; `adapter.def` exports the wrappers under the plain `zmq_*` names the EA imports.
- `probe.cpp` loads the built DLL and checks version, exports, socket options, non-blocking I/O and 10,000 calls without stack drift. It uses `inproc://` only and never opens a network connection.

Built by `.github/workflows/native-libzmq.yml` (MSVC, Win32, Release, static CRT). The build is reproducible (`/Brepro` for compiler, librarian and linker): the same commit on the same runner image gives a byte-identical DLL, so its SHA-256 only changes when the source or toolchain does.

## License

The files in this folder are MPL-2.0, like upstream libzmq. The DLL ships with the MPL-2.0 text, the wepoll BSD notice and a pointer to this source.
