// Bridge server core: ZeroMQ ROUTER for QuoteBridge EAs, feed registry and terminal presence.
// Ported from the legacy Bridge without trading or recording (milestone 1).
import { Router } from "zeromq";
import { brokerToUtc, UNKNOWN_RULE, type ClockRule } from "../../shared/clock.js";
import { asPortInUse } from "../port-in-use.js";
import { feedKey, MAX_MESSAGE_BYTES, parseMessage, type Hello, type Market, type Sample } from "./protocol.js";

/** A feed is online while its last message is younger than this. EAs re-send hello every 2 s. */
export const ONLINE_WINDOW_MS = 7000;

/** An online feed whose quote time has not changed for this long is stale. */
export const STALE_QUOTE_MS = 10000;

/** An online feed with no batch of samples accepted for this long (never, or not lately) is missing samples. */
export const SAMPLES_MISSING_MS = 30000;

const MAX_PEERS = 1000;
/** Rejections the snapshot lists, newest first; older ones drop out. */
export const MAX_REJECTIONS = 20;
/** Characters of a rejected message's body kept in the record; routes are kept whole up to a session's 120. */
const EXCERPT_CHARS = 60;
const ROUTE_CHARS = 120;
/** Account info and trading messages: a rejected one keeps only its type and session in the excerpt. */
const PRIVATE_TYPES = /^[IPX]\|/;
/** A peer silent this long may be evicted to make room when the peer limit is reached. */
const STALE_PEER_MS = 60000;

/**
 * New samples of a feed, with its market (from its terminal's latest hello), or the feed forgotten (removed by the user,
 * or its last chart evicted).
 */
export type SampleEvent = { type: "samples"; feed: string; market: Market; samples: Sample[] } | { type: "removed"; feed: string };
export type SampleListener = (event: SampleEvent) => void;

/**
 * An EA message the bridge rejected, and why. The excerpt is short, and account info and trading messages keep only their
 * type and session in it: what is left are quotes, symbols and session ids.
 */
export type Rejection = {
  time: number;
  /** The wire protocol check that failed, e.g. "Routing identity mismatch", "Invalid quote", "Unknown message". */
  reason: string;
  /** The ZeroMQ routing identity the message came from, as text. */
  route: string;
  /** The start of the message body. */
  excerpt: string;
  /** The feed of the chart the route belongs to; null for a route the bridge does not know. */
  feed: string | null;
};
export type RejectionListener = (rejection: Rejection) => void;

/** What the server knows about a market beyond the bridge: its broker server's clock rule (ADR 11) and whether it is recorded. */
export type MarketInfo = { clockRule: ClockRule | null; recording: boolean };

export type BridgeServerOptions = {
  /** Clock in epoch milliseconds; injectable for tests. */
  now?: () => number;
  /** Adds each feed's market info to snapshots; without it, rules are unknown and nothing is recorded. */
  marketInfo?: (market: Market) => MarketInfo;
};

type Peer = Hello & {
  feed: string;
  route: Buffer;
  lastSeen: number;
  /** When the chart's current online spell began. */
  onlineSince: number;
  /** When a batch of its samples was last accepted. */
  samplesAcceptedAt?: number;
  latest?: Sample;
  quoteUnchangedSince?: number;
};

export type FeedSnapshot = {
  feed: string;
  terminal: string;
  /** The broker server of the feed's market. */
  broker: string;
  symbol: string;
  /** The feed's market: its symbol on the broker server of its terminal's latest hello (ADR 11). */
  market: Market;
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
  /** The latest quote time in UTC milliseconds (its broker time as it is while the clock rule is unknown). */
  quoteTimeUtc: number | null;
  /** The clock rule of the market's broker server; null while unknown. */
  clockRule: ClockRule | null;
  /** Whether the feed's market is recorded; every feed of the market shows the same. */
  recording: boolean;
  lastSeen: number;
  /** Samples the feed's EAs dropped from full buffers, summed over its charts. */
  dropped: number;
  /** When a batch of the feed's samples was last accepted (from any of its charts); null if none has been. */
  samplesAcceptedAt: number | null;
  /** Online, with no batch accepted for SAMPLES_MISSING_MS since it came online: never, or not lately. */
  samplesMissing: boolean;
  /** The latest message rejected on one of the feed's chart routes; absent when there was none. */
  lastRejection?: Rejection;
};

/** Per Terminal ID: when a QuoteBridge EA in that terminal last said hello, and the EA version it reported. */
export type TerminalPresence = {
  terminalId: string;
  lastHello: number;
  /** null: the EA predates 1.08 and does not report its version. */
  eaVersion: string | null;
  /** The broker server the terminal is logged into, as of its latest hello. */
  brokerServer: string;
};

export type BridgeSnapshot = {
  time: number;
  /** Messages rejected by the wire protocol (malformed, invalid quote, wrong routing identity). */
  invalidMessages: number;
  /** The latest rejected messages, newest first, at most MAX_REJECTIONS. */
  rejections: Rejection[];
  feeds: FeedSnapshot[];
  /** Sorted by Terminal ID. */
  terminals: TerminalPresence[];
};

export class BridgeServer {
  private readonly now: () => number;
  private readonly marketInfo: (market: Market) => MarketInfo;
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
  private rejections: Rejection[] = [];
  private readonly lastRejectionByFeed = new Map<string, Rejection>();
  private readonly rejectionListeners = new Set<RejectionListener>();
  private operations: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private readonly sampleListeners = new Set<SampleListener>();

  constructor(options: BridgeServerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.marketInfo = options.marketInfo ?? (() => ({ clockRule: null, recording: false }));
  }

  async start(endpoint: string) {
    const port = /^tcp:\/\/127\.0\.0\.1:(\d+)$/.exec(endpoint)?.[1];
    if (!port) throw Error("ZeroMQ must bind to 127.0.0.1");
    try {
      await this.socket.bind(endpoint);
    } catch (e) {
      throw asPortInUse(e, "ea", Number(port));
    }
    this.running = this.loop();
  }

  /**
   * Calls `listener` after every EA message is handled and after a feed is removed; returns an unsubscribe function.
   * Time-based changes (online to offline, stale) raise no signal: read the snapshot to see them.
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Calls `listener` with each feed's new samples as they arrive (replayed samples are not repeated),
   * and with `removed` when a feed is forgotten. Returns an unsubscribe function.
   */
  onSamples(listener: SampleListener): () => void {
    this.sampleListeners.add(listener);
    return () => this.sampleListeners.delete(listener);
  }

  /** Calls `listener` with each rejected EA message; returns an unsubscribe function. */
  onRejection(listener: RejectionListener): () => void {
    this.rejectionListeners.add(listener);
    return () => this.rejectionListeners.delete(listener);
  }

  private emit(event: SampleEvent) {
    for (const listener of this.sampleListeners) {
      try {
        listener(event);
      } catch (e) {
        console.error("Bridge sample listener failed", e);
      }
    }
  }

  private changed() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (e) {
        console.error("Bridge change listener failed", e);
      }
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.operations.then(fn);
    this.operations = next.catch(() => {});
    return next;
  }

  private async loop() {
    try {
      for await (const frames of this.socket) {
        await this.serial(() => this.handle(frames));
        this.changed();
      }
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

  private isOnline(p: Pick<Peer, "lastSeen">, now = this.now()) {
    return now - p.lastSeen < ONLINE_WINDOW_MS;
  }

  /** A chart's times on any message from it: heard now, and a new online spell if it was offline. */
  private heard(p: Pick<Peer, "lastSeen" | "onlineSince"> | undefined) {
    const now = this.now();
    return { lastSeen: now, onlineSince: p && this.isOnline(p, now) ? p.onlineSince : now };
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
    if (frames.length !== 2) return this.reject(frames, "Wrong frame count");
    try {
      await this.accept(frames[0], frames[1]);
    } catch (e) {
      this.reject(frames, e instanceof Error ? e.message : String(e));
    }
  }

  private reject(frames: Buffer[], reason: string) {
    this.invalidMessages++;
    const route = frames[0]?.toString() ?? "";
    const body = frames[1]?.subarray(0, EXCERPT_CHARS * 4).toString() ?? "";
    const rejection: Rejection = {
      time: this.now(),
      reason,
      route: printable(route, ROUTE_CHARS),
      excerpt: printable(PRIVATE_TYPES.test(body) ? body.split("|").slice(0, 3).join("|") + "|…" : body, EXCERPT_CHARS),
      feed: this.peers.get(route)?.feed ?? null,
    };
    this.rejections = [rejection, ...this.rejections.slice(0, MAX_REJECTIONS - 1)];
    if (rejection.feed) this.lastRejectionByFeed.set(rejection.feed, rejection);
    for (const listener of this.rejectionListeners) {
      try {
        listener(rejection);
      } catch (e) {
        console.error("Bridge rejection listener failed", e);
      }
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
        if (stale.feed !== feedKey(m) && ![...this.peers.values()].some((p) => p.feed === stale.feed)) {
          this.lastRejectionByFeed.delete(stale.feed);
          this.emit({ type: "removed", feed: stale.feed });
        }
      }
      const p: Peer = { ...old, ...m, feed: feedKey(m), route, ...this.heard(old) };
      this.peers.set(m.session, p);
      this.terminals.set(m.terminal, { terminalId: m.terminal, lastHello: p.lastSeen, eaVersion: m.eaVersion ?? null, brokerServer: m.broker });
      // The hello reply is the subscription state; duplicates may hand ownership over, so refresh every chart of the feed.
      for (const peer of this.peers.values()) if (peer.feed === p.feed) await this.control(peer);
    } else if (m.type === "samples") {
      const p = this.peers.get(m.session);
      if (!p) {
        await this.send(route, `R|1|${m.session}`);
        return;
      }
      Object.assign(p, this.heard(p));
      const latest = m.samples.at(-1)!;
      const fresh = m.samples.filter((s) => !p.latest || s.seq > p.latest.seq);
      // A replayed batch is ACKed again, but brings no new samples.
      if (fresh.length) p.samplesAcceptedAt = this.now();
      // The market of the terminal's latest hello, as in the snapshot: one feed's charts never disagree about it.
      const brokerServer = this.terminals.get(p.terminal)?.brokerServer ?? p.broker;
      if (fresh.length) this.emit({ type: "samples", feed: p.feed, market: { brokerServer, symbol: p.symbol }, samples: fresh });
      if (!p.latest || latest.seq > p.latest.seq) {
        if (!p.latest || latest.quoteTime !== p.latest.quoteTime) p.quoteUnchangedSince = this.now();
        p.latest = latest;
      }
      // A batch is ACKed once it is held in memory; the recorder writes it within a second.
      await this.send(p.route, `A|1|${p.session}|${latest.seq}`);
    }
  }

  snapshot(): BridgeSnapshot {
    const now = this.now();
    const feeds = [...new Set([...this.peers.values()].map((p) => p.feed))].map((feed): FeedSnapshot => {
      const instances = [...this.peers.values()].filter((p) => p.feed === feed);
      const online = instances.filter((p) => this.isOnline(p, now));
      const p = this.owner(feed) ?? instances.sort((a, b) => b.lastSeen - a.lastSeen)[0];
      const brokerServer = this.terminals.get(p.terminal)?.brokerServer ?? p.broker;
      const market = { brokerServer, symbol: p.symbol };
      const { clockRule, recording } = this.marketInfo(market);
      // Samples from any chart count, even one offline now (the owner before a handover); the silence runs from the
      // later of those and the feed's online spell, which began with its first chart online.
      const acceptedTimes = instances.flatMap((i) => (i.samplesAcceptedAt === undefined ? [] : [i.samplesAcceptedAt]));
      const accepted = acceptedTimes.length ? Math.max(...acceptedTimes) : null;
      const silentSince = Math.max(accepted ?? 0, Math.min(...online.map((i) => i.onlineSince)));
      return {
        feed,
        terminal: p.terminal,
        broker: brokerServer,
        symbol: p.symbol,
        market,
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
        quoteTimeUtc: p.latest ? brokerToUtc(clockRule ?? UNKNOWN_RULE, p.latest.quoteTime * 1000) : null,
        clockRule,
        recording,
        lastSeen: p.lastSeen,
        dropped: instances.reduce((n, i) => n + i.dropped, 0),
        samplesAcceptedAt: accepted,
        samplesMissing: this.isOnline(p, now) && now - silentSince >= SAMPLES_MISSING_MS,
        ...(this.lastRejectionByFeed.has(feed) && { lastRejection: { ...this.lastRejectionByFeed.get(feed)! } }),
      };
    });
    const terminals = [...this.terminals.values()].sort((a, b) => (a.terminalId < b.terminalId ? -1 : 1)).map((t) => ({ ...t }));
    return { time: now, invalidMessages: this.invalidMessages, rejections: this.rejections.map((r) => ({ ...r })), feeds, terminals };
  }

  /** Forgets an offline feed and its charts. An EA that says hello again brings the feed back. */
  remove(feed: string) {
    return this.serial(async () => {
      const known = this.snapshot().feeds.find((f) => f.feed === feed);
      if (!known) throw Error("Unknown feed");
      if (known.online) throw Error("Feed is online; detach its EAs before removing it");
      this.owners.delete(feed);
      this.lastRejectionByFeed.delete(feed);
      for (const [session, p] of this.peers) if (p.feed === feed) this.peers.delete(session);
      this.emit({ type: "removed", feed });
      this.changed();
    });
  }

  async close() {
    this.stopped = true;
    this.socket.close();
    await this.running;
    await this.operations;
  }
}

/** Text cut to `max` characters (whole code points), with control characters and invalid UTF-8 shown as "?". */
const printable = (text: string, max: number) => {
  const chars = [...text.replace(/[\x00-\x1f\x7f\ufffd]/g, "?")];
  return chars.length > max ? chars.slice(0, max).join("") + "…" : chars.join("");
};
