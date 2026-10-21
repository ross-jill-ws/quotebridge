// Live WebSocket: a bridge snapshot on connect, then a new one whenever it changes, at most every 500 ms per socket.
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { BridgeServer, BridgeSnapshot } from "../bridge/index.js";

export const LIVE_INTERVAL_MS = 500;
const MAX_CLIENTS = 100;
/** A socket this far behind is not reading; drop it rather than buffer without bound. */
const MAX_BUFFERED_BYTES = 1024 * 1024;

type Client = { ws: WebSocket; lastSentAt: number; lastKey?: string; timer?: NodeJS.Timeout };

/** Snapshots that differ only in their `time` are the same state. */
const stateKey = (snapshot: BridgeSnapshot) => JSON.stringify({ ...snapshot, time: 0 });

export class LiveSnapshots {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  private readonly clients = new Set<Client>();
  private readonly unsubscribe: () => void;
  /** Time-based changes (online to offline, stale) raise no change signal; look for them on a timer. */
  private readonly sweep: NodeJS.Timeout;

  constructor(private readonly bridge: BridgeServer) {
    this.unsubscribe = bridge.onChange(() => this.scheduleAll());
    this.sweep = setInterval(() => this.scheduleAll(), LIVE_INTERVAL_MS);
  }

  get full() {
    return this.clients.size >= MAX_CLIENTS;
  }

  /** Completes an authenticated upgrade to /live. */
  accept(req: IncomingMessage, socket: Duplex, head: Buffer) {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const client: Client = { ws, lastSentAt: -Infinity };
      this.clients.add(client);
      ws.on("error", () => ws.terminate());
      ws.on("close", () => {
        clearTimeout(client.timer);
        this.clients.delete(client);
      });
      this.send(client);
    });
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
    clearInterval(this.sweep);
    for (const client of this.clients) {
      clearTimeout(client.timer);
      client.ws.terminate();
    }
    this.wss.close();
  }
}
