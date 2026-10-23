// The dashboard's live connection to the server's /live WebSocket: a snapshot on connect and on every change. The
// window also says which indicator keys its charts show, and hears when their values change.

/** The part of the browser WebSocket the client uses. */
export type LiveSocket = {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
};

/**
 * "connecting": first attempt; "live": receiving snapshots; "reconnecting": lost, retrying;
 * "session-ended": the server no longer accepts this page's window session (no more retries).
 */
export type LiveStatus = "connecting" | "live" | "reconnecting" | "session-ended";

export type Timers = {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
};

export type LiveClientOptions<Snapshot> = {
  open: () => LiveSocket;
  onSnapshot: (snapshot: Snapshot) => void;
  /** The indicator keys whose values changed, of those shown. */
  onIndicators?: (changed: string[]) => void;
  onStatus: (status: LiveStatus) => void;
  /** Whether the window session still works; false stops reconnecting. */
  sessionValid: () => Promise<boolean>;
  timers?: Timers;
};

const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 10_000;

export class LiveClient<Snapshot = unknown> {
  private socket?: LiveSocket;
  private status?: LiveStatus;
  private retryMs = FIRST_RETRY_MS;
  private readonly timers: Timers;
  private retry: unknown;
  private stopped = false;
  private open = false;
  private shown: string[] = [];

  constructor(private readonly options: LiveClientOptions<Snapshot>) {
    this.timers = options.timers ?? { setTimeout: (run, ms) => setTimeout(run, ms), clearTimeout: (id) => clearTimeout(id as number) };
  }

  start() {
    this.setStatus("connecting");
    this.connect();
  }

  private connect() {
    const socket = this.options.open();
    this.socket = socket;
    socket.onopen = () => {
      this.retryMs = FIRST_RETRY_MS;
      this.open = true;
      // A new connection knows nothing of what this window shows.
      if (this.shown.length) this.sendShown();
      this.setStatus("live");
    };
    socket.onmessage = (event) => {
      let message: unknown;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return; // not a snapshot; the next one replaces it anyway
      }
      const notice = message as { type?: unknown; changed?: unknown };
      if (notice.type === "indicators") {
        if (Array.isArray(notice.changed)) this.options.onIndicators?.(notice.changed.filter((k): k is string => typeof k === "string"));
        return;
      }
      this.options.onSnapshot(message as Snapshot);
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.open = false;
      if (this.stopped) return;
      this.setStatus("reconnecting");
      void this.retryUnlessSessionEnded();
    };
  }

  /** The indicator keys this window shows now; the server tells it when their values change. */
  show(keys: readonly string[]) {
    this.shown = [...keys];
    if (this.open) this.sendShown();
  }

  private sendShown() {
    this.socket?.send(JSON.stringify({ type: "show", keys: this.shown }));
  }

  /** Closes the connection; no more snapshots or retries. */
  stop() {
    this.stopped = true;
    this.timers.clearTimeout(this.retry);
    this.socket?.close();
  }

  private async retryUnlessSessionEnded() {
    // A browser WebSocket does not say why an upgrade failed: ask the server whether the session still works.
    // A server that cannot be reached (restarting, stopped) is retried.
    const valid = await this.options.sessionValid().catch(() => true);
    if (this.stopped) return;
    if (!valid) {
      this.stopped = true;
      this.setStatus("session-ended");
      return;
    }
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
    this.retry = this.timers.setTimeout(() => this.connect(), delay);
  }

  private setStatus(status: LiveStatus) {
    if (status === this.status) return;
    this.status = status;
    this.options.onStatus(status);
  }
}
