// Server host protocol (ADR 10): the messages between the main process (host) and the server process.
// Plain JSON-compatible objects so they survive structured clone and Node IPC serialisation.
import type { Settings } from "./settings-store.js";

/**
 * The settings main changes. The server process is the single writer of the settings file, so main
 * sends these with `update-settings` instead of writing the file itself.
 */
export type HostSettingsChange = Partial<Pick<Settings, "startWithWindows" | "firstCloseNotificationShown">>;

export const HOST_SETTINGS_KEYS = ["startWithWindows", "firstCloseNotificationShown"] as const satisfies readonly (keyof HostSettingsChange)[];

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
  /**
   * The bridge files the app installs into managed terminals: the EA sources folder (`mt4/`) and
   * the folder with the ZeroMQ DLL and its notices. Omitted, the server does not manage terminals.
   */
  bridgeBundle?: { sourceFolder: string; dllFolder: string };
};

/** The view a screenshot shows; the window is switched to it and left there. */
export type ScreenshotView = "feeds";

/** The app window as the user left it; a capture leaves it so. */
export type WindowState = "visible" | "hidden" | "minimised";

/** The page's live link to the server, as the rail's bridge status shows it. */
export type LiveLinkState = "connecting" | "live" | "reconnecting" | "session-ended";

/** A screenshot of the app window, taken by main. */
export type WindowCapture = {
  view: ScreenshotView;
  window: WindowState;
  /** The PNG's size in physical pixels, at the window's display scale. */
  width: number;
  height: number;
  scale: number;
  live: LiveLinkState;
  /** Epoch milliseconds. */
  capturedAt: number;
  /** Base64. */
  png: string;
};

export type CaptureErrorCode =
  /** A dialog is open in the window; nothing was switched or taken. */
  | "window-busy"
  /** No window to capture: main still starting, the renderer being recreated, or no app window at all. */
  | "window-unavailable"
  /** The capture took longer than its deadline. */
  | "screenshot-timeout";

/** Why a capture failed, in plain words. */
export type CaptureError = { code: CaptureErrorCode; message: string };

/** Host → server. */
export type HostMessage =
  | { type: "start"; config: ServerStartConfig }
  /** Asks for a `status` now (the server also sends one whenever the summary changes). */
  | { type: "get-status" }
  /**
   * Another one-time window token, e.g. for an app window recreated after a renderer crash. Answered with
   * `window-token-issued` or an `error` carrying the same `requestId`.
   */
  | { type: "issue-window-token"; token: string; requestId: number }
  /** Main's setting changes (Start with Windows, first-close notification shown); answered with `settings`. Needs a started server. */
  | { type: "update-settings"; change: HostSettingsChange }
  /** Answers the server's `capture-window` with the same `requestId`. */
  | { type: "window-captured"; requestId: number; capture: WindowCapture }
  | { type: "window-capture-failed"; requestId: number; error: CaptureError }
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

/** A managed terminal that needs the user's attention (compile failed, no MetaEditor, failed copy). */
export type TerminalAttentionStatus = { terminalId: string; name: string; message: string };

/** What the host needs to supervise and to drive the tray warning; the app window gets full detail over HTTP. */
export type ServerStatus = {
  feeds: { total: number; online: number; offline: number; stale: number; noQuote: number; duplicateCharts: number; dropped: number };
  terminals: TerminalPresenceStatus[];
  /** Managed terminals needing attention; the tray shows a warning while this is not empty. */
  terminalsNeedingAttention: TerminalAttentionStatus[];
  /** EA messages the server could not parse since start. */
  invalidMessages: number;
  /** Dispatched requests awaiting a definitive outcome or explicit review. Absent in older hosts. */
  unresolvedRequests?: number;
};

/** Server → host. */
export type ServerMessage =
  | { type: "ready"; eaPort: number; httpPort: number; httpOrigin: string; databaseFile: string; schemaVersion: number }
  | { type: "status"; status: ServerStatus }
  | { type: "window-token-issued"; requestId: number }
  /** The settings after the server saved a change (main applies Start with Windows from here). */
  | { type: "settings"; settings: Settings }
  /**
   * A screenshot asked through the REST API: main switches the app window to `view`, captures it and answers with
   * `window-captured` or `window-capture-failed` carrying the same `requestId` (the server's own numbering).
   */
  | { type: "capture-window"; view: ScreenshotView; requestId: number }
  /** `during: "start"` means the start failed and nothing is left bound or open; the host may send `start` again. */
  | {
      type: "error";
      during: "start" | "stop" | "message";
      error: ServerError;
      /** For `during: "message"`: the `requestId` of the host message it answers, when that message had one. */
      requestId?: number;
    }
  /** `checkpoint: false` when there was no database open, or CHECKPOINT failed (the WAL is then left for replay). */
  | { type: "stopped"; checkpoint: boolean };
