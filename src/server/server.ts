// Starts the bridge server: the EA endpoint and the HTTP server, both on 127.0.0.1 only.
import { BridgeServer } from "./bridge/index.js";
import { startHttpServer } from "./http/http-server.js";
import { WindowSessions } from "./http/window-session.js";

export type ServerConfig = {
  /** ZeroMQ port QuoteBridge EAs connect to (default setting 5555). */
  eaPort: number;
  /** HTTP port of the dashboard, state endpoint and live WebSocket. */
  httpPort: number;
  /** One-time token the app window exchanges for its session (ADR 5). */
  windowToken: string;
  /** Folder holding the dashboard bundle; defaults to the bundled dashboard (a placeholder page until it is built). */
  dashboardFolder?: string;
  /** Clock in epoch milliseconds; injectable for tests. */
  now?: () => number;
};

export type RunningServer = {
  bridge: BridgeServer;
  /** e.g. "http://127.0.0.1:43123". */
  httpOrigin: string;
  close(): Promise<void>;
};

/** Rejects with PortInUseError when the EA or HTTP port is taken; nothing stays bound then. */
export async function startServer(config: ServerConfig): Promise<RunningServer> {
  const bridge = new BridgeServer({ now: config.now });
  await bridge.start(`tcp://127.0.0.1:${config.eaPort}`);
  const sessions = new WindowSessions();
  sessions.addToken(config.windowToken);
  let http;
  try {
    http = await startHttpServer({ port: config.httpPort, bridge, sessions, dashboardFolder: config.dashboardFolder });
  } catch (e) {
    await bridge.close();
    throw e;
  }
  return {
    bridge,
    httpOrigin: http.origin,
    async close() {
      await http.close();
      await bridge.close();
    },
  };
}
