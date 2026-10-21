// Server host protocol (ADR 10): the messages between the main process (host) and the server process.
// Plain JSON-compatible objects so they survive structured clone and Node IPC serialisation.

/** Configuration the host sends with `start`. */
export type ServerStartConfig = {
  /** ZeroMQ port QuoteBridge EAs connect to (setting, default 5555). */
  eaPort: number;
  /** HTTP port of the dashboard, state endpoint and live WebSocket. */
  httpPort: number;
  /** One-time token the app window exchanges for its session (ADR 5). */
  windowToken: string;
  /** The app's data folder (`%APPDATA%\QuoteBridge\`); the database lives here. */
  dataFolder: string;
  /** Overrides the bundled dashboard folder. */
  dashboardFolder?: string;
};

/** Host → server. */
export type HostMessage =
  | { type: "start"; config: ServerStartConfig }
  /** Asks for a `status` now (the server also sends one whenever the summary changes). */
  | { type: "get-status" }
  /** Another one-time window token, e.g. for an app window recreated after a renderer crash. */
  | { type: "issue-window-token"; token: string }
  | { type: "stop" };

export type ServerErrorCode =
  /** The EA or HTTP port is taken by another program (e.g. the legacy server). */
  | "port-in-use"
  /** The database could not be opened (e.g. locked by another process) or checkpointed. */
  | "database"
  /** A host message the server does not understand, or one that is invalid in the current phase. */
  | "bad-message"
  | "internal";

export type ServerError = {
  code: ServerErrorCode;
  /** Plain words, fit to show the user. */
  message: string;
  /** For `port-in-use`: which port. */
  which?: "ea" | "http";
  port?: number;
};

export type TerminalPresenceStatus = { terminalId: string; lastHello: number; eaVersion: string | null };

/** What the host needs to supervise and to drive the tray warning; the app window gets full detail over HTTP. */
export type ServerStatus = {
  feeds: { total: number; online: number; offline: number; stale: number; noQuote: number; duplicateCharts: number; dropped: number };
  terminals: TerminalPresenceStatus[];
  /** EA messages the server could not parse since start. */
  invalidMessages: number;
};

/** Server → host. */
export type ServerMessage =
  | { type: "ready"; eaPort: number; httpPort: number; httpOrigin: string; databaseFile: string; schemaVersion: number }
  | { type: "status"; status: ServerStatus }
  | { type: "window-token-issued" }
  /** `during: "start"` means the start failed and nothing is left bound or open; the host may send `start` again. */
  | { type: "error"; during: "start" | "stop" | "message"; error: ServerError }
  /** `checkpoint: false` when there was no database open, or CHECKPOINT failed (the WAL is then left for replay). */
  | { type: "stopped"; checkpoint: boolean };
