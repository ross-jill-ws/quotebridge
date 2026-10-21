// Bridge server core: ZeroMQ ROUTER for QuoteBridge EAs, feed registry and terminal presence.
// Ported from the legacy Bridge without trading or recording (milestone 1).
import { Router } from "zeromq";
import { feedKey, MAX_MESSAGE_BYTES, parseMessage, type Hello, type Sample } from "./protocol.js";

/** A feed is online while its last message is younger than this. EAs re-send hello every 2 s. */
export const ONLINE_WINDOW_MS = 7000;

/** An online feed whose quote time has not changed for this long is stale. */
export const STALE_QUOTE_MS = 10000;

const MAX_PEERS = 1000;
/** A peer silent this long may be evicted to make room when the peer limit is reached. */
const STALE_PEER_MS = 60000;

export type BridgeServerOptions = {
  /** Clock in epoch milliseconds; injectable for tests. */
  now?: () => number;
};

type Peer = Hello & {
  feed: string;
  route: Buffer;
  lastSeen: number;
  latest?: Sample;
  quoteUnchangedSince?: number;
};

export type FeedSnapshot = {
  feed: string;
  terminal: string;
  broker: string;
  symbol: string;
  /** Chart period of the owner chart, in minutes; null for EAs that do not report it. */
  timeframe: number | null;
  /** Periods of every online chart sending this feed. */
  chartTimeframes: (number | null)[];
  online: boolean;
  /** Online charts sending this feed; more than one means duplicate charts. */
  instances: number;
  digits: number;
  interval: number;
  /** "no-quote": the EA cannot read a valid quote for this symbol. */
  quoteStatus: "ok" | "no-quote";
  /** When the quote time last changed. */
  quoteUnchangedSince?: number;
  /** Online, with a quote whose time has not changed for STALE_QUOTE_MS. */
  stale: boolean;
  latest?: Sample;
  lastSeen: number;
  /** Samples the feed's EAs dropped from full buffers, summed over its charts. */
  dropped: number;
};

/** Per Terminal ID: when a QuoteBridge EA in that terminal last said hello, and the EA version it reported. */
export type TerminalPresence = {
  terminalId: string;
  lastHello: number;
  /** null: the EA predates 1.08 and does not report its version. */
  eaVersion: string | null;
};

export type BridgeSnapshot = {
  time: number;
  /** Messages rejected by the wire protocol (malformed, invalid quote, wrong routing identity). */
  invalidMessages: number;
  feeds: FeedSnapshot[];
  /** Sorted by Terminal ID. */
  terminals: TerminalPresence[];
};

export class BridgeServer {
  private readonly now: () => number;
  private readonly socket = new Router({
    linger: 0,
    sendTimeout: 0,
    receiveHighWaterMark: 1000,
    sendHighWaterMark: 1000,
    maxMessageSize: MAX_MESSAGE_BYTES,
    mandatory: true,
    // A reconnecting EA keeps its session and replay buffer. Replace stale routes.
    handover: true,
  });
  private readonly peers = new Map<string, Peer>();
  private readonly owners = new Map<string, string>();
  private readonly terminals = new Map<string, TerminalPresence>();
  private running?: Promise<void>;
  private stopped = false;
  private invalidMessages = 0;
  private operations: Promise<unknown> = Promise.resolve();

  constructor(options: BridgeServerOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  async start(endpoint: string) {
    if (!/^tcp:\/\/127\.0\.0\.1:\d+$/.test(endpoint)) throw Error("ZeroMQ must bind to 127.0.0.1");
    await this.socket.bind(endpoint);
    this.running = this.loop();
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.operations.then(fn);
    this.operations = next.catch(() => {});
    return next;
  }

  private async loop() {
    try {
      for await (const frames of this.socket) await this.serial(() => this.handle(frames));
    } catch (e) {
      if (!this.stopped) console.error("Bridge stopped unexpectedly", e);
    }
  }

  private async send(route: Buffer, message: string) {
    try {
      await this.socket.send([route, message]);
    } catch {
      /* Heartbeats reconcile unreachable peers. */
    }
  }

  private isOnline(p: Peer, now = this.now()) {
    return now - p.lastSeen < ONLINE_WINDOW_MS;
  }

  /** The chart that owns a feed's subscription: the current owner while online, else the first online chart. */
  private owner(feed: string) {
    const current = this.peers.get(this.owners.get(feed) ?? "");
    if (current && this.isOnline(current)) return current;
    const next = [...this.peers.values()].find((p) => p.feed === feed && this.isOnline(p));
    if (next) this.owners.set(feed, next.session);
    else this.owners.delete(feed);
    return next;
  }

  /** Milestone 1 subscribes every feed; only its owner chart streams, so duplicate charts stay quiet. */
  private async control(p: Peer) {
    await this.send(p.route, `C|1|${p.session}|${this.owner(p.feed)?.session === p.session ? 1 : 0}`);
  }

  private async handle(frames: Buffer[]) {
    if (frames.length !== 2) {
      this.invalidMessages++;
      return;
    }
    try {
      await this.accept(frames[0], frames[1]);
    } catch {
      this.invalidMessages++;
    }
  }

  private async accept(route: Buffer, body: Buffer) {
    const m = parseMessage(body);
    if (route.toString() !== m.session) throw Error("Routing identity mismatch");
    if (m.type === "hello") {
      const old = this.peers.get(m.session);
      if (old && old.feed !== feedKey(m)) throw Error("Session identity changed");
      if (!old && this.peers.size >= MAX_PEERS) {
        const stale = [...this.peers.values()].find((p) => this.now() - p.lastSeen > STALE_PEER_MS);
        if (!stale) throw Error("Peer limit reached");
        this.peers.delete(stale.session);
      }
      const p: Peer = { ...old, ...m, feed: feedKey(m), route, lastSeen: this.now() };
      this.peers.set(m.session, p);
      this.terminals.set(m.terminal, { terminalId: m.terminal, lastHello: p.lastSeen, eaVersion: m.eaVersion ?? null });
      // The hello reply is the subscription state; duplicates may hand ownership over, so refresh every chart of the feed.
      for (const peer of this.peers.values()) if (peer.feed === p.feed) await this.control(peer);
    } else if (m.type === "samples") {
      const p = this.peers.get(m.session);
      if (!p) {
        await this.send(route, `R|1|${m.session}`);
        return;
      }
      p.lastSeen = this.now();
      const latest = m.samples.at(-1)!;
      if (!p.latest || latest.seq > p.latest.seq) {
        if (!p.latest || latest.quoteTime !== p.latest.quoteTime) p.quoteUnchangedSince = this.now();
        p.latest = latest;
      }
      // Milestone 1 records nothing: a batch is ACKed once it is held in memory for display.
      await this.send(p.route, `A|1|${p.session}|${latest.seq}`);
    }
  }

  snapshot(): BridgeSnapshot {
    const now = this.now();
    const feeds = [...new Set([...this.peers.values()].map((p) => p.feed))].map((feed): FeedSnapshot => {
      const instances = [...this.peers.values()].filter((p) => p.feed === feed);
      const online = instances.filter((p) => this.isOnline(p, now));
      const p = this.owner(feed) ?? instances.sort((a, b) => b.lastSeen - a.lastSeen)[0];
      return {
        feed,
        terminal: p.terminal,
        broker: p.broker,
        symbol: p.symbol,
        timeframe: p.timeframe ?? null,
        chartTimeframes: [...new Set(online.map((i) => i.timeframe ?? null))],
        online: this.isOnline(p, now),
        instances: online.length,
        digits: p.digits,
        interval: p.interval,
        quoteStatus: p.quoteStatus,
        quoteUnchangedSince: p.quoteUnchangedSince,
        stale: this.isOnline(p, now) && p.quoteUnchangedSince !== undefined && now - p.quoteUnchangedSince >= STALE_QUOTE_MS,
        latest: p.latest,
        lastSeen: p.lastSeen,
        dropped: instances.reduce((n, i) => n + i.dropped, 0),
      };
    });
    const terminals = [...this.terminals.values()].sort((a, b) => (a.terminalId < b.terminalId ? -1 : 1)).map((t) => ({ ...t }));
    return { time: now, invalidMessages: this.invalidMessages, feeds, terminals };
  }

  /** Forgets an offline feed and its charts. An EA that says hello again brings the feed back. */
  remove(feed: string) {
    return this.serial(async () => {
      const known = this.snapshot().feeds.find((f) => f.feed === feed);
      if (!known) throw Error("Unknown feed");
      if (known.online) throw Error("Feed is online; detach its EAs before removing it");
      this.owners.delete(feed);
      for (const [session, p] of this.peers) if (p.feed === feed) this.peers.delete(session);
    });
  }

  async close() {
    this.stopped = true;
    this.socket.close();
    await this.running;
    await this.operations;
  }
}
