// The server side of the server host protocol (ADR 10): runs the bridge server and the database
// on the host's `start`, and takes them down through the one stop path on `stop`.
import type { HostTransport } from "../shared/host-transport.js";
import { HOST_SETTINGS_KEYS, type HostMessage, type HostSettingsChange, type ServerError, type ServerMessage, type ServerStartConfig, type ServerStatus, type TerminalAttentionStatus } from "../shared/server-host-protocol.js";
import { SettingsStore } from "../shared/settings-store.js";
import type { BridgeSnapshot } from "./bridge/index.js";
import { openDatabase, type AppDatabase } from "./database.js";
import { startServer, type RunningServer } from "./server.js";
import type { TerminalManagerOptions } from "./terminals/index.js";

export type ServerHostOptions = {
  /** Clock in epoch milliseconds; injectable for tests. */
  now?: () => number;
  /** Pushed status messages are at most this often (default 1000 ms); time-based changes are swept at this interval too. */
  statusIntervalMs?: number;
  /** Called after `stopped` has been sent; the entry point exits the process here. */
  onStopped?: () => void;
  /** Adjusts the terminal manager's options (`npm run dev` swaps in fake terminals and a fake MetaEditor). */
  terminals?: (options: TerminalManagerOptions) => TerminalManagerOptions | Promise<TerminalManagerOptions>;
  /** `npm run dev` in a browser tab: the dashboard needs no sign-in (ServerConfig.openDashboard). */
  openDashboard?: boolean;
  /** Called once the server runs; the returned function is called when it stops (`npm run dev`'s fake EAs). */
  onRunning?: (server: RunningServer, config: ServerStartConfig) => (() => void) | void;
};

type Running = { server: RunningServer; database: AppDatabase; settings: SettingsStore; stopStatus: () => void; stopHook: () => void };

export function runServerHost(transport: HostTransport<HostMessage, ServerMessage>, options: ServerHostOptions = {}) {
  let phase: "idle" | "starting" | "running" | "stopping" | "stopped" = "idle";
  let running: Running | undefined;
  /** Serialises start and stop so a stop that arrives mid-start waits for it. */
  let work: Promise<void> = Promise.resolve();
  const send = (message: ServerMessage) => transport.send(message);

  /** Leaves the phase alone when a stop arrived meanwhile; that stop runs next. */
  const settle = (next: "idle" | "running") => {
    if (phase === "starting") phase = next;
  };

  async function start(config: ServerStartConfig) {
    let database: AppDatabase | undefined;
    let server: RunningServer | undefined;
    try {
      database = await openDatabase(config.dataFolder);
      const settings = new SettingsStore(config.dataFolder);
      let terminals: TerminalManagerOptions | undefined;
      if (config.bridgeBundle) {
        terminals = {
          appDataFolder: config.dataFolder,
          settings,
          bundle: config.bridgeBundle,
          // Setup and Remove change settings; main applies Start with Windows from them.
          onSettingsSaved: (saved) => send({ type: "settings", settings: saved }),
        };
        if (options.terminals) terminals = await options.terminals(terminals);
      }
      server = await startServer({
        eaPort: config.eaPort,
        httpPort: config.httpPort,
        windowToken: config.windowToken,
        openDashboard: options.openDashboard,
        dashboardFolder: config.dashboardFolder,
        now: options.now,
        database,
        ...(terminals ? { terminals } : {}),
        // The Settings view saves here too; main applies what was saved (Start with Windows, theme, new ports).
        settings: { store: settings, onSaved: (saved) => send({ type: "settings", settings: saved }) },
      });
      running = { server, database, settings, stopStatus: () => {}, stopHook: options.onRunning?.(server, config) ?? (() => {}) };
      settle("running");
      send({ type: "ready", eaPort: config.eaPort, httpPort: config.httpPort, httpOrigin: server.httpOrigin, databaseFile: database.file, schemaVersion: database.schemaVersion });
      // The first status follows ready at once: main may still show what a previous server reported.
      running.stopStatus = pushStatusOnChange(server);
    } catch (e) {
      running?.stopStatus();
      running?.stopHook();
      running = undefined;
      // A post-start hook may throw after both ports are bound. Flush/close the server
      // before closing its database, just as on the normal stop path.
      await server?.close().catch(() => {});
      await database?.checkpointAndClose().catch(() => {});
      settle("idle");
      send({ type: "error", during: "start", error: toServerError(e) });
    }
  }

  /** The one stop path: stop accepting EA messages, flush, CHECKPOINT, close, `stopped`. */
  async function stop() {
    phase = "stopping";
    let checkpoint = false;
    if (running) {
      const { server, database, stopStatus, stopHook } = running;
      running = undefined;
      stopStatus();
      stopHook();
      await server.close().catch((e) => send({ type: "error", during: "stop", error: toServerError(e) }));
      // Closing the server writes the buffered recorded samples and waits for its clock-rule writes.
      try {
        await database.checkpointAndClose();
        checkpoint = true;
      } catch (e) {
        send({ type: "error", during: "stop", error: toServerError(e) });
      }
    }
    phase = "stopped";
    send({ type: "stopped", checkpoint });
    transport.close();
    options.onStopped?.();
  }

  /** Sends a status now, then whenever the summary changes (ignoring lastHello heartbeats), throttled. */
  function pushStatusOnChange(server: RunningServer) {
    const interval = options.statusIntervalMs ?? 1000;
    const current = () => summarise(server.bridge.snapshot(), server.terminals?.attention() ?? [], server.trading?.unresolvedCount() ?? 0);
    let lastKey: string | undefined;
    let lastSent = 0;
    let trailing: NodeJS.Timeout | undefined;
    const check = () => {
      const status = current();
      const key = statusKey(status);
      if (key === lastKey) return;
      const wait = lastSent + interval - Date.now();
      if (wait > 0) {
        trailing ??= setTimeout(() => {
          trailing = undefined;
          check();
        }, wait);
        return;
      }
      lastKey = key;
      lastSent = Date.now();
      send({ type: "status", status });
    };
    const unsubscribe = server.bridge.onChange(check);
    const unsubscribeTerminals = server.terminals?.onChange(check);
    const unsubscribeTrading = server.trading?.onChange(check);
    const sweep = setInterval(check, interval);
    check();
    return () => {
      unsubscribe();
      unsubscribeTerminals?.();
      unsubscribeTrading?.();
      clearInterval(sweep);
      clearTimeout(trailing);
    };
  }

  const enqueue = (job: () => Promise<void>) => {
    work = work.then(job);
  };

  transport.onMessage((message) => {
    switch (message?.type) {
      case "start":
        if (phase !== "idle") return rejectMessage(`"start" is not allowed while the server is ${phase}.`);
        phase = "starting";
        return enqueue(() => start(message.config));
      case "get-status":
        if (!running) return rejectMessage(`"get-status" needs a running server (it is ${phase}).`);
        return send({ type: "status", status: summarise(running.server.bridge.snapshot(), running.server.terminals?.attention() ?? [], running.server.trading?.unresolvedCount() ?? 0) });
      case "issue-window-token": {
        const requestId = typeof message.requestId === "number" ? message.requestId : undefined;
        if (!running) return rejectMessage(`"issue-window-token" needs a running server (it is ${phase}); pass the token with "start" instead.`, requestId);
        if (requestId === undefined) return rejectMessage('"issue-window-token" needs a numeric requestId.');
        if (typeof message.token !== "string" || message.token.length < 16) return rejectMessage("A window token must be a string of at least 16 characters.", requestId);
        running.server.addWindowToken(message.token);
        return send({ type: "window-token-issued", requestId });
      }
      case "update-settings": {
        if (!running) return rejectMessage(`"update-settings" needs a running server (it is ${phase}).`);
        const problem = invalidSettingsChange(message.change);
        if (problem) return rejectMessage(problem);
        const { settings } = running;
        // Queued behind start/stop, so a stop still finds every accepted change saved.
        return enqueue(() =>
          settings
            .update((current) => ({ ...current, ...message.change }))
            .then(
              (saved) => send({ type: "settings", settings: saved }),
              (e) => send({ type: "error", during: "message", error: { code: "internal", message: `The settings could not be saved: ${(e as Error).message}` } }),
            ),
        );
      }
      case "stop":
        if (phase === "stopping" || phase === "stopped") return;
        phase = "stopping";
        return enqueue(stop);
      default:
        return rejectMessage(`Unknown host message ${JSON.stringify((message as { type?: unknown } | null)?.type)}.`);
    }
  });

  function rejectMessage(text: string, requestId?: number) {
    send({ type: "error", during: "message", error: { code: "bad-message", message: text }, ...(requestId !== undefined ? { requestId } : {}) });
  }
}

/** Why a change main sent is not one main may make, or null when it is fine. */
function invalidSettingsChange(change: unknown): string | null {
  if (typeof change !== "object" || change === null || Array.isArray(change)) return "A settings change must be an object.";
  for (const [key, value] of Object.entries(change as HostSettingsChange)) {
    if (!(HOST_SETTINGS_KEYS as readonly string[]).includes(key)) return `The setting "${key}" is not one main may change.`;
    if (typeof value !== "boolean") return `The setting "${key}" must be true or false.`;
  }
  return null;
}

function toServerError(e: unknown): ServerError {
  const error = e as { code?: unknown; message?: unknown; which?: "ea" | "http"; port?: number } | null;
  if (error?.code === "port-in-use") return { code: "port-in-use", message: String(error.message), which: error.which, port: error.port };
  if (error?.code === "database") return { code: "database", message: String(error.message) };
  return { code: "internal", message: String(error?.message ?? e) };
}

export function summarise(snapshot: BridgeSnapshot, terminalsNeedingAttention: TerminalAttentionStatus[] = [], unresolvedRequests = 0): ServerStatus {
  const feeds = snapshot.feeds;
  const online = feeds.filter((f) => f.online).length;
  return {
    feeds: {
      total: feeds.length,
      online,
      offline: feeds.length - online,
      stale: feeds.filter((f) => f.stale).length,
      noQuote: feeds.filter((f) => f.quoteStatus === "no-quote").length,
      duplicateCharts: feeds.filter((f) => f.instances > 1).length,
      dropped: feeds.reduce((sum, f) => sum + f.dropped, 0),
    },
    terminals: snapshot.terminals.map((t) => ({ terminalId: t.terminalId, lastHello: t.lastHello, eaVersion: t.eaVersion })),
    terminalsNeedingAttention: terminalsNeedingAttention.map(({ terminalId, name, message }) => ({ terminalId, name, message })),
    invalidMessages: snapshot.invalidMessages,
    unresolvedRequests,
  };
}

const statusKey = (status: ServerStatus) =>
  JSON.stringify({ ...status, terminals: status.terminals.map((t) => ({ terminalId: t.terminalId, eaVersion: t.eaVersion })) });
