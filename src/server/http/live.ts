// Live WebSocket: a bridge snapshot on connect, then a new one whenever it changes, at most every 500 ms per socket.
// A window also sends the indicator keys its charts show ({"type":"show","keys":[…]}), and hears when their values
// change ({"type":"indicators","changed":[…]}); it then fetches them again. It reports the packages its chart's view
// memory uses ({"type":"charts","packages":[…]}), which the Indicators page counts, and hears when the packages or
// whether they are enabled change ({"type":"packages"}).
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { BridgeServer, BridgeSnapshot } from "../bridge/index.js";
import type { IndicatorPackages, IndicatorValues } from "../indicators/index.js";

export const LIVE_INTERVAL_MS = 500;
const MAX_CLIENTS = 100;
/** A window shows at most this many indicator keys (8 per chart, several charts). */
const MAX_SHOWN_KEYS = 64;
/** A socket this far behind is not reading; drop it rather than buffer without bound. */
const MAX_BUFFERED_BYTES = 1024 * 1024;

/** `uses`: the packages the window's chart uses, as it last reported them. */
type Client = { ws: WebSocket; lastSentAt: number; lastKey?: string; timer?: NodeJS.Timeout; shows: Set<string>; uses: Set<string> };

/** Snapshots that differ only in their `time` are the same state. */
const stateKey = (snapshot: BridgeSnapshot) => JSON.stringify({ ...snapshot, time: 0 });

export class LiveSnapshots {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private readonly clients = new Set<Client>();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeIndicators?: () => void;
  private readonly unsubscribePackages?: () => void;
  /** Time-based changes (online to offline, stale) raise no change signal; look for them on a timer. */
  private readonly sweep: NodeJS.Timeout;

  constructor(
    private readonly bridge: BridgeServer,
    private readonly indicators?: IndicatorValues,
    packages?: IndicatorPackages,
  ) {
    this.unsubscribe = bridge.onChange(() => this.scheduleAll());
    this.unsubscribeIndicators = indicators?.onChange((key) => this.indicatorChanged(key));
    this.unsubscribePackages = packages?.onChange(() => this.broadcast({ type: "packages" }));
    this.sweep = setInterval(() => this.scheduleAll(), LIVE_INTERVAL_MS);
  }

  get full() {
    return this.clients.size >= MAX_CLIENTS;
  }

  /** Completes an authenticated upgrade to /live. */
  accept(req: IncomingMessage, socket: Duplex, head: Buffer) {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const client: Client = { ws, lastSentAt: -Infinity, shows: new Set(), uses: new Set() };
      this.clients.add(client);
      ws.on("error", () => ws.terminate());
      ws.on("message", (data) => this.received(client, data));
      ws.on("close", () => {
        clearTimeout(client.timer);
        this.indicators?.show(client, []);
        this.clients.delete(client);
      });
      this.send(client);
    });
  }

  /** How many windows' charts use the package, as they last reported. */
  chartsUsing(id: string): number {
    let n = 0;
    for (const client of this.clients) if (client.uses.has(id)) n++;
    return n;
  }

  /** A window's message: the indicator keys it shows, or the packages its chart uses. Anything else is ignored. */
  private received(client: Client, data: unknown) {
    let message: unknown;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    const { type, keys, packages } = (message ?? {}) as { type?: unknown; keys?: unknown; packages?: unknown };
    if (type === "charts" && Array.isArray(packages)) {
      client.uses = new Set(packages.filter((p): p is string => typeof p === "string" && p.length <= 200).slice(0, MAX_SHOWN_KEYS));
      return;
    }
    if (type !== "show" || !Array.isArray(keys)) return;
    const shown = keys.filter((k): k is string => typeof k === "string" && k.length <= 2000).slice(0, MAX_SHOWN_KEYS);
    client.shows = new Set(shown);
    this.indicators?.show(client, shown);
  }

  private indicatorChanged(key: string) {
    for (const client of this.clients) {
      if (!client.shows.has(key) || client.ws.readyState !== WebSocket.OPEN) continue;
      if (client.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        client.ws.terminate();
        continue;
      }
      client.ws.send(JSON.stringify({ type: "indicators", changed: [key] }));
    }
  }

  private broadcast(message: unknown) {
    const text = JSON.stringify(message);
    for (const client of this.clients) if (client.ws.readyState === WebSocket.OPEN) client.ws.send(text);
  }

  private scheduleAll() {
    for (const client of this.clients) this.schedule(client);
  }

  private schedule(client: Client) {
    if (client.timer) return;
    const wait = Math.max(0, client.lastSentAt + LIVE_INTERVAL_MS - performance.now());
    client.timer = setTimeout(() => this.send(client), wait);
  }

  private send(client: Client) {
    client.timer = undefined;
    if (client.ws.readyState !== WebSocket.OPEN) return;
    const snapshot = this.bridge.snapshot();
    const key = stateKey(snapshot);
    if (key === client.lastKey) return;
    if (client.ws.bufferedAmount > MAX_BUFFERED_BYTES) return void client.ws.terminate();
    client.ws.send(JSON.stringify(snapshot));
    client.lastSentAt = performance.now();
    client.lastKey = key;
  }

  close() {
    this.unsubscribe();
    this.unsubscribeIndicators?.();
    this.unsubscribePackages?.();
    clearInterval(this.sweep);
    for (const client of this.clients) {
      clearTimeout(client.timer);
      client.ws.terminate();
    }
    this.wss.close();
  }
}
