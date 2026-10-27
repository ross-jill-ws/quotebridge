// Supervisor (ADR 10): the main process's pure state machine for the server process. It starts the
// server, hands the app window its one-time token, restarts the server after a crash with exponential
// backoff, warns after repeated failures, and runs the one stop path for Quit, update, shutdown and logoff.
// It talks to the server only through the server host protocol; processes and time come in as ports.
import { randomBytes } from "node:crypto";
import type { HostTransport } from "../../shared/host-transport.js";
import { CAPTURE_ERROR_CODES, type CaptureError, type CaptureErrorCode, type HostMessage, type HostSettingsChange, type ScreenshotTarget, type ServerError, type ServerMessage, type ServerStartConfig, type ServerStatus, type WindowCapture } from "../../shared/server-host-protocol.js";
import type { Settings } from "../../shared/settings-store.js";

/** One launched server process (an Electron utility process in the app). */
export interface ServerProcess {
  readonly transport: HostTransport<ServerMessage, HostMessage>;
  /** Called once when the process has exited, whatever the cause. */
  onExit(listener: (code: number | null) => void): void;
  /** Ends the process now. Its exit is still reported through `onExit`. */
  kill(): void;
}

export interface SupervisorClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: SupervisorClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export type SupervisorThresholds = {
  /** First restart delay after a failure; doubles with each consecutive failure. */
  initialBackoffMs: number;
  /** Cap on the restart delay. */
  maxBackoffMs: number;
  /** Consecutive failures that raise the tray warning. */
  warnAfterFailures: number;
  /** Running this long without a failure resets the failure count and clears the warning. */
  stableAfterMs: number;
  /** A server that sends no `ready` within this time is killed and counted as a failure. */
  startTimeoutMs: number;
  /** While a port is in use, how often to try again (slowly, not a crash loop). */
  portInUseRetryMs: number;
  /** How long the stop path waits for `stopped` before ending the server process. */
  stopDeadlineMs: number;
};

export const DEFAULT_THRESHOLDS: SupervisorThresholds = {
  initialBackoffMs: 1_000,
  maxBackoffMs: 30_000,
  warnAfterFailures: 3,
  stableAfterMs: 60_000,
  startTimeoutMs: 60_000,
  portInUseRetryMs: 30_000,
  stopDeadlineMs: 5_000,
};

export type SupervisorState =
  /** `start()` not called yet. */
  | "idle"
  /** A server process is launched and `start` sent; waiting for `ready`. */
  | "starting"
  | "running"
  /** The server failed; waiting out the backoff before the next launch. */
  | "restarting"
  /** The EA or HTTP port is taken by another program; retrying slowly. */
  | "port-in-use"
  /** The start configuration cannot work (e.g. equal EA and HTTP ports); no server launched, retrying slowly. */
  | "invalid-config"
  /** The stop path is running. */
  | "stopping"
  /** Final: the stop path finished; the app exits. */
  | "stopped";

export type SupervisorWarning =
  | { reason: "repeated-failures"; failures: number; message: string }
  | { reason: "port-in-use"; message: string }
  | { reason: "invalid-config"; message: string };

export type SupervisorStatus = {
  state: SupervisorState;
  /** Non-null means the tray shows its warning state. */
  warning: SupervisorWarning | null;
  /** Consecutive failures since the server last ran stably. */
  failures: number;
  /** In `restarting`, `port-in-use` and `invalid-config`: when the next launch happens (clock time). */
  nextLaunchAt: number | null;
  /** The last error the server reported, or the last failure. */
  lastError: ServerError | null;
  /** While running: where the server listens. */
  server: { eaPort: number; httpPort: number; httpOrigin: string } | null;
  /** The latest `status` the server pushed. */
  serverStatus: ServerStatus | null;
};

export type StopReason = "quit" | "update" | "shutdown" | "logoff";

export type StopResult = {
  reason: StopReason;
  /**
   * `stopped`: the server sent `stopped` within the deadline.
   * `deadline-missed`: it did not; the process was ended and DuckDB replays the WAL on the next start.
   * `exited`: the process exited during the stop path without `stopped`.
   * `not-running`: no server was running (restarting, port in use, idle).
   */
  outcome: "stopped" | "deadline-missed" | "exited" | "not-running";
  checkpoint: boolean;
};

export type SupervisorEvent =
  | { type: "state"; status: SupervisorStatus }
  /** Load the app window at this URL: a fresh one-time token, after every server (re)start. */
  | { type: "window-url"; url: string }
  | { type: "server-status"; status: ServerStatus }
  /** The settings the server saved after an `updateSettings` change. */
  | { type: "settings"; settings: Settings };

export type SupervisorOptions = {
  launch: () => ServerProcess;
  /** Read at every launch, so changed ports apply on the next (re)start. May throw when it cannot work (e.g. equal ports). */
  config: () => Omit<ServerStartConfig, "windowToken">;
  clock?: SupervisorClock;
  createToken?: () => string;
  thresholds?: Partial<SupervisorThresholds>;
  /**
   * Switches the app window to the target and captures it, for the server's `capture-window`. Rejects with an error whose
   * `code` is a CaptureErrorCode when it refuses; any other failure answers `window-unavailable`.
   */
  captureWindow?: (target: ScreenshotTarget) => Promise<WindowCapture>;
};

/** A 256-bit random one-time window token (ADR 5). */
export function createWindowToken() {
  return randomBytes(32).toString("base64url");
}

export function windowUrl(httpOrigin: string, token: string) {
  return `${httpOrigin}/session?token=${encodeURIComponent(token)}`;
}

type Current = { process: ServerProcess; unsubscribe: () => void };

export class Supervisor {
  private readonly clock: SupervisorClock;
  private readonly createToken: () => string;
  private readonly limits: SupervisorThresholds;
  private readonly listeners = new Set<(event: SupervisorEvent) => void>();
  private current: Current | null = null;
  /** One timer at a time: start timeout, backoff, stable period, port retry or stop deadline. */
  private timer: unknown = null;
  /** The token sent with the current `start`; handed to the window on `ready`. */
  private startToken: string | null = null;
  /** `issue-window-token` requests awaiting `window-token-issued` (or an error) with their request id. */
  private readonly tokenRequests = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  private nextRequestId = 1;
  private stopping: Promise<StopResult> | null = null;
  /** A restart's stop path in progress. */
  private restarting: Promise<void> | null = null;
  /** Setting changes waiting for a running server, merged (latest value wins). */
  private pendingSettings: HostSettingsChange | null = null;
  private finishStop: ((result: Omit<StopResult, "reason">) => void) | null = null;
  private state: SupervisorState = "idle";
  private status_: Omit<SupervisorStatus, "state"> = {
    warning: null,
    failures: 0,
    nextLaunchAt: null,
    lastError: null,
    server: null,
    serverStatus: null,
  };

  constructor(private readonly options: SupervisorOptions) {
    this.clock = options.clock ?? systemClock;
    this.createToken = options.createToken ?? createWindowToken;
    this.limits = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  }

  onEvent(listener: (event: SupervisorEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  status(): SupervisorStatus {
    return structuredClone({ state: this.state, ...this.status_ });
  }

  /** Launches the server. Call once, at app start. */
  start() {
    if (this.state !== "idle") return;
    this.launch();
  }

  /**
   * The one stop path (ADR 10) for Quit, update, Windows shutdown and logoff: ask the server to stop
   * (it stops EA messages, flushes, runs CHECKPOINT and closes), wait for `stopped` up to the deadline,
   * then end the process. Missing the deadline leaves the WAL for DuckDB to replay on the next start.
   * After this the supervisor never launches a server again; the shell exits the app when it resolves.
   * A second call (e.g. shutdown during Quit) returns the first call's promise.
   */
  stop(reason: StopReason): Promise<StopResult> {
    if (this.stopping) return this.stopping;
    // A restart's stop path cannot be joined (it launches afterwards): stop the server it brings up.
    if (this.restarting) return (this.stopping = this.restarting.then(() => {
      this.stopping = null;
      return this.stop(reason);
    }));
    this.clearTimer();
    this.startToken = null;
    this.status_.nextLaunchAt = null;
    const process = this.current?.process;
    if (!process) {
      this.stopping = Promise.resolve({ reason, outcome: "not-running", checkpoint: false });
      this.setState("stopped");
      return this.stopping;
    }
    this.stopping = new Promise<StopResult>((resolve) => {
      this.finishStop = (result) => {
        this.finishStop = null;
        this.clearTimer();
        this.detach();
        this.status_.server = null;
        this.setState("stopped");
        resolve({ reason, ...result });
      };
    });
    this.setState("stopping");
    this.setTimer(this.limits.stopDeadlineMs, () => {
      this.detach()?.kill();
      this.finishStop?.({ outcome: "deadline-missed", checkpoint: false });
    });
    process.transport.send({ type: "stop" });
    return this.stopping;
  }

  /**
   * A fresh one-time token for an app window that was recreated (e.g. after a renderer crash), from the
   * running server. Resolves to the URL the window loads. Rejects when no server is running; the next
   * `ready` then brings a `window-url` event anyway.
   */
  issueWindowToken(): Promise<string> {
    const current = this.current;
    const origin = this.status_.server?.httpOrigin;
    if (this.state !== "running" || !current || !origin) {
      return Promise.reject(Error(`The QuoteBridge server is not running (it is ${this.state}).`));
    }
    const token = this.createToken();
    const requestId = this.nextRequestId++;
    const issued = new Promise<void>((resolve, reject) => this.tokenRequests.set(requestId, { resolve, reject }));
    current.process.transport.send({ type: "issue-window-token", token, requestId });
    return issued.then(() => windowUrl(origin, token));
  }

  /**
   * Saves main's setting changes through the server, the single writer of the settings file. While no
   * server runs (starting, restarting, port in use) changes are kept and sent, merged, on the next `ready`.
   * After stop they are dropped. The saved settings come back as a `settings` event.
   */
  updateSettings(change: HostSettingsChange) {
    if (this.stopping) return;
    this.pendingSettings = { ...this.pendingSettings, ...change };
    if (this.state === "running") this.flushSettings();
  }

  private flushSettings() {
    const change = this.pendingSettings;
    if (!change || !this.current) return;
    this.pendingSettings = null;
    this.current.process.transport.send({ type: "update-settings", change });
  }

  /**
   * Stops the server through the stop path (as for Quit, ending it if it misses the deadline), then
   * launches a new one. Not a failure: the backoff and warning are unchanged. Used by a dev run after
   * the server code was rebuilt. Waiting out a backoff or a port retry, it launches at once; before
   * `start()` and after `stop()` it does nothing. Resolves once the new server has been launched.
   */
  restart(): Promise<void> {
    if (this.restarting) return this.restarting;
    if (this.stopping || this.state === "idle") return Promise.resolve();
    const process = this.current?.process;
    if (!process) {
      this.retry();
      return Promise.resolve();
    }
    this.clearTimer();
    this.startToken = null;
    this.restarting = new Promise<void>((resolve) => {
      this.finishStop = () => {
        this.finishStop = null;
        this.clearTimer();
        this.detach();
        this.status_.server = null;
        this.restarting = null;
        this.launch();
        resolve();
      };
    });
    const restarting = this.restarting;
    this.setState("stopping");
    this.setTimer(this.limits.stopDeadlineMs, () => {
      this.detach()?.kill();
      this.finishStop?.({ outcome: "deadline-missed", checkpoint: false });
    });
    process.transport.send({ type: "stop" });
    return restarting;
  }

  /** Launches now instead of waiting out a backoff or a port-in-use retry. */
  retry() {
    if (this.state === "restarting" || this.state === "port-in-use" || this.state === "invalid-config") this.launch();
  }

  private launch() {
    this.status_.nextLaunchAt = null;
    // Before launching, so a configuration that cannot work leaves no server process behind.
    let config: Omit<ServerStartConfig, "windowToken">;
    try {
      config = this.options.config();
    } catch (e) {
      this.invalidConfig(e);
      return;
    }
    if (this.status_.warning?.reason === "invalid-config") this.status_.warning = null;
    let process: ServerProcess;
    try {
      process = this.options.launch();
    } catch (e) {
      this.fail({ code: "internal", message: `The QuoteBridge server could not be launched: ${(e as Error).message}` });
      return;
    }
    const current: Current = { process, unsubscribe: () => {} };
    this.current = current;
    current.unsubscribe = process.transport.onMessage((message) => {
      if (this.current === current) this.onMessage(message);
    });
    process.onExit((code) => {
      if (this.current === current) this.onExit(code);
    });
    const windowToken = this.createToken();
    this.startToken = windowToken;
    this.setState("starting");
    this.setTimer(this.limits.startTimeoutMs, () =>
      this.fail({ code: "internal", message: `The QuoteBridge server did not start within ${this.limits.startTimeoutMs / 1000} seconds.` }, { kill: true }),
    );
    // A process may answer (or exit) before `send` returns, so nothing follows it.
    process.transport.send({ type: "start", config: { ...config, windowToken } });
  }

  private onMessage(message: ServerMessage) {
    switch (message.type) {
      case "ready": {
        if (this.state !== "starting") return;
        const { eaPort, httpPort, httpOrigin } = message;
        this.status_.server = { eaPort, httpPort, httpOrigin };
        if (this.status_.warning?.reason === "port-in-use") this.status_.warning = null;
        this.setTimer(this.limits.stableAfterMs, () => {
          this.status_.failures = 0;
          this.status_.warning = null;
          this.setState(this.state);
        });
        const token = this.startToken;
        this.startToken = null;
        this.setState("running");
        if (token) this.emit({ type: "window-url", url: windowUrl(httpOrigin, token) });
        this.flushSettings();
        return;
      }
      case "window-token-issued":
        this.settleTokenRequest(message.requestId)?.resolve();
        return;
      case "stopped":
        if (this.state === "stopping") this.finishStop?.({ outcome: "stopped", checkpoint: message.checkpoint });
        return;
      case "settings":
        this.emit({ type: "settings", settings: message.settings });
        return;
      case "capture-window":
        return this.captureWindow(message.view === "chart" ? { view: "chart", feed: message.feed } : { view: "feeds" }, message.requestId);
      case "status":
        this.status_.serverStatus = message.status;
        this.emit({ type: "server-status", status: message.status });
        return;
      case "error":
        // Only an error naming a token request settles it; others are about other messages (e.g. a failed settings save).
        if (message.during === "message" && message.requestId !== undefined) this.settleTokenRequest(message.requestId)?.reject(Error(message.error.message));
        if (message.during !== "start" || this.state !== "starting") return;
        if (message.error.code === "port-in-use") this.portInUse(message.error);
        else this.fail(message.error, { kill: true });
        return;
    }
  }

  /** Answers the server that asked, if it is still the current one. */
  private captureWindow(target: ScreenshotTarget, requestId: number) {
    const current = this.current;
    const answer = (message: HostMessage) => {
      if (this.current === current) current?.process.transport.send(message);
    };
    const fail = (error: CaptureError) => answer({ type: "window-capture-failed", requestId, error });
    if (!this.options.captureWindow) return fail({ code: "window-unavailable", message: "The app window is still starting." });
    this.options.captureWindow(target).then(
      (capture) => answer({ type: "window-captured", requestId, capture }),
      (e: { code?: unknown; message?: unknown }) =>
        fail(
          typeof e?.code === "string" && (CAPTURE_ERROR_CODES as readonly string[]).includes(e.code)
            ? { code: e.code as CaptureErrorCode, message: String(e.message) }
            : { code: "window-unavailable", message: `The app window could not be captured: ${String(e?.message ?? e)}` },
        ),
    );
  }

  private settleTokenRequest(requestId: number) {
    const request = this.tokenRequests.get(requestId);
    this.tokenRequests.delete(requestId);
    return request;
  }

  private onExit(code: number | null) {
    if (this.state === "stopping") return this.finishStop?.({ outcome: "exited", checkpoint: false });
    this.fail({ code: "internal", message: `The QuoteBridge server stopped unexpectedly (exit code ${code ?? "none"}).` });
  }

  /** Stops watching the current process; returns it so the caller can end it. */
  private detach() {
    const current = this.current;
    if (!current) return null;
    this.current = null;
    const pending = [...this.tokenRequests.values()];
    this.tokenRequests.clear();
    for (const request of pending) request.reject(Error("The QuoteBridge server stopped before the window token was issued."));
    current.unsubscribe();
    current.process.transport.close();
    return current.process;
  }

  /**
   * Another program holds a port. Not a crash: the server left nothing bound, so end it, warn,
   * and try again at a slow fixed interval (the port may be freed, or the ports changed in settings).
   */
  private portInUse(error: ServerError) {
    this.detach()?.kill();
    this.clearTimer();
    this.startToken = null;
    this.status_.lastError = error;
    this.status_.warning = { reason: "port-in-use", message: error.message };
    this.scheduleLaunch("port-in-use", this.limits.portInUseRetryMs);
  }

  /** Not a crash: no server was launched. Warn with the reason and read the configuration again slowly (or on retry). */
  private invalidConfig(e: unknown) {
    this.clearTimer();
    this.startToken = null;
    const message = `The QuoteBridge server cannot start with its settings: ${(e as Error)?.message ?? String(e)}`;
    this.status_.lastError = { code: "internal", message };
    this.status_.warning = { reason: "invalid-config", message };
    this.scheduleLaunch("invalid-config", this.limits.portInUseRetryMs);
  }

  /** A crash, a failed or hung start: count it, maybe warn, and restart after the backoff. */
  private fail(error: ServerError, { kill = false } = {}) {
    const process = this.detach();
    if (kill) process?.kill();
    this.clearTimer();
    this.startToken = null;
    this.status_.server = null;
    this.status_.lastError = error;
    const failures = ++this.status_.failures;
    if (failures >= this.limits.warnAfterFailures) {
      this.status_.warning = {
        reason: "repeated-failures",
        failures,
        message: `The QuoteBridge server keeps stopping unexpectedly (${failures} times in a row). It is being restarted.`,
      };
    }
    const delay = Math.min(this.limits.initialBackoffMs * 2 ** (failures - 1), this.limits.maxBackoffMs);
    this.scheduleLaunch("restarting", delay);
  }

  private scheduleLaunch(state: "restarting" | "port-in-use" | "invalid-config", delayMs: number) {
    this.status_.nextLaunchAt = this.clock.now() + delayMs;
    this.setTimer(delayMs, () => this.launch());
    this.setState(state);
  }

  private setTimer(ms: number, fn: () => void) {
    this.clearTimer();
    const handle = this.clock.setTimeout(() => {
      if (this.timer !== handle) return;
      this.timer = null;
      fn();
    }, ms);
    this.timer = handle;
  }

  private clearTimer() {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private setState(state: SupervisorState) {
    this.state = state;
    this.emit({ type: "state", status: this.status() });
  }

  private emit(event: SupervisorEvent) {
    for (const l of [...this.listeners]) l(event);
  }
}
