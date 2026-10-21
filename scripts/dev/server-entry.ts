// The server process for `npm run dev`, bundled by the dev runner into .dev-build/server-entry.mjs and
// launched like src/server/entry.ts: by the runner (Node child, IPC) or by the app (Electron utility
// process, with QUOTEBRIDGE_DEV_SERVER_ENTRY). It serves the dev dashboard build and, unless --real,
// swaps in fake terminals and their fake EAs;
// with --real, the Terminals view warns that its terminals are real.
import { join } from "node:path";
import { ipcTransport, parentPortTransport, type HostTransport, type ParentPortLike } from "../../src/shared/host-transport.js";
import type { HostMessage, ServerMessage } from "../../src/shared/server-host-protocol.js";
import { runServerHost } from "../../src/server/host.js";
import { fakeTerminalEAs, fakeTerminalOptions } from "./fake-terminals.js";
import { realTerminalOptions } from "./real-run.js";

const parentPort = (process as { parentPort?: ParentPortLike }).parentPort;
const transport = parentPort
  ? parentPortTransport<HostMessage, ServerMessage>(parentPort)
  : process.send
    ? ipcTransport<HostMessage, ServerMessage>(process)
    : undefined;
if (!transport) {
  console.error("The dev server must be started by `npm run dev`.");
  process.exit(2);
}

const dashboardFolder = process.env.QUOTEBRIDGE_DEV_DASHBOARD_FOLDER;
const fakes = process.env.QUOTEBRIDGE_DEV_FAKES === "1";
const real = process.env.QUOTEBRIDGE_DEV_REAL === "1";

/** The bundled dashboard path resolves from this bundle's folder, so the runner names the dev build's. */
const withDashboard: HostTransport<HostMessage, ServerMessage> = {
  ...transport,
  onMessage: (listener) => transport.onMessage((message) => listener(message?.type === "start" && dashboardFolder ? { ...message, config: { ...message.config, dashboardFolder } } : message)),
};

runServerHost(withDashboard, {
  ...(fakes
    ? {
        terminals: (options) => fakeTerminalOptions(join(options.appDataFolder, "fake-terminals"), options),
        onRunning: (server, config) => fakeTerminalEAs(server, `tcp://127.0.0.1:${config.eaPort}`),
      }
    : real
      ? { terminals: realTerminalOptions }
      : {}),
  onStopped() {
    setTimeout(() => process.exit(0), 50);
  },
});

process.on("disconnect", () => process.exit(0));
// Ctrl+C reaches every process in the console: the runner stops this one through the stop path.
process.on("SIGINT", () => {});
