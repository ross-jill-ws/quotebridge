// Server process entry point. In the app it runs as an Electron utility process and talks to main
// over `process.parentPort`; in tests it runs as a forked Node child over the IPC channel.
import { ipcTransport, parentPortTransport, type ParentPortLike } from "../shared/host-transport.js";
import type { HostMessage, ServerMessage } from "../shared/server-host-protocol.js";
import { runServerHost } from "./host.js";

const parentPort = (process as { parentPort?: ParentPortLike }).parentPort;
const transport = parentPort
  ? parentPortTransport<HostMessage, ServerMessage>(parentPort)
  : process.send
    ? ipcTransport<HostMessage, ServerMessage>(process)
    : undefined;

if (!transport) {
  console.error("The QuoteBridge server must be started by the app (no parentPort or IPC channel).");
  process.exit(2);
}

runServerHost(transport, {
  onStopped() {
    // Everything is closed; leave a moment for `stopped` to reach main, then exit.
    setTimeout(() => process.exit(0), 50);
  },
});

// Main going away without `stop` (it crashed or killed us): nothing else will stop the server.
process.on("disconnect", () => process.exit(0));
