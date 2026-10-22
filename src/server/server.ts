// Starts the bridge server: the EA endpoint and the HTTP server, both on 127.0.0.1 only.
import { BridgeServer } from "./bridge/index.js";
import { CandleBuilder } from "./candles/index.js";
import { ClockRules, memoryClockRuleStore } from "./clock/index.js";
import type { AppDatabase } from "./database.js";
import { startHttpServer } from "./http/http-server.js";
import { WindowSessions } from "./http/window-session.js";
import { AppSettings, type AppSettingsOptions } from "./settings/index.js";
import { TerminalManager, type TerminalManagerOptions } from "./terminals/index.js";

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
  /** Terminal management (Terminals view, setup screen, tray attention); omitted, those endpoints answer 404. */
  terminals?: TerminalManagerOptions;
  /** The Settings view (GET and POST /api/settings); omitted, those endpoints answer 404. */
  settings?: AppSettingsOptions;
  /** The app's database (clock rules); omitted, clock rules are kept in memory only. */
  database?: AppDatabase;
  /** The PC's local time minus UTC at an instant, in minutes (reads the EA's sampled time); injectable for tests. */
  localOffsetMinutes?: (utcMs: number) => number;
};

export type RunningServer = {
  bridge: BridgeServer;
  terminals: TerminalManager | undefined;
  /** e.g. "http://127.0.0.1:43123". */
  httpOrigin: string;
  /** Accepts another one-time window token, e.g. for an app window recreated after a renderer crash. Throws if too short. */
  addWindowToken(token: string): void;
  close(): Promise<void>;
};

/** Rejects with PortInUseError when the EA or HTTP port is taken; nothing stays bound then. */
export async function startServer(config: ServerConfig): Promise<RunningServer> {
  // Snapshots carry each market's clock rule, read when they are taken.
  let clockRules: ClockRules | undefined;
  const bridge = new BridgeServer({ now: config.now, marketInfo: (market) => ({ clockRule: clockRules?.rule(market.brokerServer) ?? null, recording: false }) });
  // Before the first sample: the stored rules decide what later samples confirm or contradict.
  const rules = (clockRules = await ClockRules.open(bridge, config.database?.clockRules ?? memoryClockRuleStore(), {
    now: config.now,
    localOffsetMinutes: config.localOffsetMinutes,
  }));
  try {
    await bridge.start(`tcp://127.0.0.1:${config.eaPort}`);
  } catch (e) {
    await rules.close();
    throw e;
  }
  const candles = new CandleBuilder(bridge, { now: config.now, clockRule: (brokerServer) => rules.rule(brokerServer) });
  const sessions = new WindowSessions();
  const settings = config.settings ? new AppSettings(config.settings, { ea: config.eaPort, http: config.httpPort }) : undefined;
  sessions.addToken(config.windowToken);
  let http;
  try {
    http = await startHttpServer({ port: config.httpPort, bridge, candles, clockRules: rules, sessions, dashboardFolder: config.dashboardFolder, terminals: () => terminals, settings });
  } catch (e) {
    candles.close();
    await bridge.close();
    await rules.close();
    throw e;
  }
  // Only after both ports are bound: a failed start must not have begun recovery or detection.
  const terminals = config.terminals ? new TerminalManager(config.terminals, {
        bridge,
        eaPort: config.eaPort,
        now: config.now ?? Date.now,
        brokerClock: (brokerServer) => rules.get(brokerServer),
      }) : undefined;
  return {
    bridge,
    terminals,
    httpOrigin: http.origin,
    addWindowToken: (token) => sessions.addToken(token),
    async close() {
      await terminals?.close();
      await http.close();
      candles.close();
      await bridge.close();
      await rules.close();
    },
  };
}
