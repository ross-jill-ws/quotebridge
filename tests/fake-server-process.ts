// Test doubles for seam 3: a fake server process speaking the server host protocol, and a manual clock.
import type { HostTransport } from "../src/shared/host-transport.js";
import type { HostMessage, ServerError, ServerMessage } from "../src/shared/server-host-protocol.js";
import type { ServerProcess, SupervisorClock } from "../src/main/supervisor/index.js";
import { DEFAULT_SETTINGS, type Settings } from "../src/shared/settings-store.js";

/** Timers that fire only when the test advances time. */
export class ManualClock implements SupervisorClock {
  time = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private nextId = 1;

  now = () => this.time;
  setTimeout = (fn: () => void, ms: number) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, fn });
    return id;
  };
  clearTimeout = (id: unknown) => {
    this.timers.delete(id as number);
  };

  /** Moves time forward, firing due timers in order (including ones they schedule). */
  advance(ms: number) {
    const end = this.time + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.timers) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      this.timers.delete(next[0]);
      this.time = next[1].at;
      next[1].fn();
    }
    this.time = end;
  }

  pendingTimers() {
    return this.timers.size;
  }
}

/** How a fake server answers `start` and `stop`. */
export type FakeBehaviour = {
  onStart?: "ready" | "hang" | "crash" | { error: ServerError };
  onStop?: "stopped" | "hang" | "crash";
};

export const PORT_IN_USE: ServerError = { code: "port-in-use", which: "ea", port: 6555, message: "Port 6555 is in use." };

/** One server process. Replies synchronously, so tests need no awaits between steps. */
export class FakeServerProcess implements ServerProcess {
  readonly received: HostMessage[] = [];
  killed = false;
  /** What this fake has saved from `update-settings`. */
  settings: Settings = structuredClone(DEFAULT_SETTINGS) as Settings;
  exited = false;
  private listeners = new Set<(m: ServerMessage) => void>();
  private exitListeners = new Set<(code: number | null) => void>();

  constructor(private readonly behaviour: FakeBehaviour = {}) {}

  readonly transport: HostTransport<ServerMessage, HostMessage> = {
    send: (message) => {
      if (this.exited) return;
      this.received.push(structuredClone(message));
      this.react(message);
    },
    onMessage: (listener) => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },
    close: () => this.listeners.clear(),
  };

  onExit(listener: (code: number | null) => void) {
    this.exitListeners.add(listener);
  }

  kill() {
    this.killed = true;
    this.exit(null);
  }

  reply(message: ServerMessage) {
    if (this.exited) return;
    for (const l of [...this.listeners]) l(structuredClone(message));
  }

  exit(code: number | null) {
    if (this.exited) return;
    this.exited = true;
    for (const l of [...this.exitListeners]) l(code);
  }

  sentTypes() {
    return this.received.map((m) => m.type);
  }

  private react(message: HostMessage) {
    if (message.type === "start") {
      const onStart = this.behaviour.onStart ?? "ready";
      if (onStart === "ready") {
        const { eaPort, httpPort } = message.config;
        this.reply({ type: "ready", eaPort, httpPort, httpOrigin: `http://127.0.0.1:${httpPort}`, databaseFile: "db", schemaVersion: 1 });
      } else if (onStart === "crash") this.exit(3);
      else if (onStart !== "hang") this.reply({ type: "error", during: "start", error: onStart.error });
    } else if (message.type === "stop") {
      const onStop = this.behaviour.onStop ?? "stopped";
      if (onStop === "stopped") {
        this.reply({ type: "stopped", checkpoint: true });
        this.exit(0);
      } else if (onStop === "crash") this.exit(3);
    } else if (message.type === "update-settings") {
      this.settings = { ...this.settings, ...message.change };
      this.reply({ type: "settings", settings: this.settings });
    } else if (message.type === "issue-window-token") {
      this.reply({ type: "window-token-issued", requestId: message.requestId });
    }
  }
}

/** Launches fake processes; each launch takes the next queued behaviour (default: ready, then stopped). */
export class FakeLauncher {
  readonly processes: FakeServerProcess[] = [];
  private queue: FakeBehaviour[] = [];

  then(...behaviours: FakeBehaviour[]) {
    this.queue.push(...behaviours);
    return this;
  }

  launch = () => {
    const process = new FakeServerProcess(this.queue.shift());
    this.processes.push(process);
    return process;
  };

  get last() {
    const last = this.processes.at(-1);
    if (!last) throw Error("No server process was launched");
    return last;
  }
}
