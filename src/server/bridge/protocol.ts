// QuoteBridge EA wire protocol (EA → app), ported from the legacy server.
// Unchanged except for the optional 14th hello field carrying the EA version (EA 1.08+) and the chart bars a 1.10+ EA
// sends on request (G).

export const MAX_MESSAGE_BYTES = 16384;

export type Hello = {
  type: "hello";
  session: string;
  terminal: string;
  broker: string;
  symbol: string;
  digits: number;
  interval: number;
  dropped: number;
  quoteStatus: "ok" | "no-quote";
  timeframe?: number;
  candleCapacity?: number;
  higherTimeframes?: boolean;
  /** Absent for EAs older than 1.08: version unknown. */
  eaVersion?: string;
};

export type Sample = { seq: number; bid: number; ask: number; quoteTime: number; sampledTime: number };

export type TickBatch = { type: "samples"; session: string; samples: Sample[] };

/** A closed bar of the EA's chart symbol; `time` is its start in broker seconds. */
export type EaBar = { time: number; open: number; high: number; low: number; close: number; tickVolume: number };

/**
 * Bars at most per answer page. An answer is `total` closed bars, oldest first, in pages of this many from `offset`;
 * "loading" (no bars) while MetaTrader is still loading the period's history.
 */
export const BARS_PER_PAGE = 100;
/** Bars at most per request. */
export const MAX_REQUEST_BARS = 900;
/** MetaTrader's period lengths in minutes: the timeframes a bar request names. */
export const TIMEFRAMES = [1, 5, 15, 30, 60, 240, 1440, 10080, 43200];

export type BarPage = { type: "bars"; session: string; request: number; timeframe: number; status: "ok" | "loading"; total: number; offset: number; bars: EaBar[] };

/**
 * A bar request to the EA: `count` closed bars of `timeframe`, the newest `shift` closed bars skipped (0: up to the
 * newest closed bar). `shift` leaves room for asking further back.
 */
export const barRequestWire = (session: string, request: number, timeframe: number, count: number, shift: number) =>
  `G|1|${session}|${request}|${timeframe}|${count}|${shift}`;

/** Messages this milestone does not handle (candles, trading, account info, read errors); dropped unread. */
export type Ignored = { type: "ignored"; session: string };

export type EAMessage = Hello | TickBatch | BarPage | Ignored;

const IGNORED_TYPES = new Set(["B", "I", "V", "P", "X", "E"]);

const integer = (value: string, min: number, max: number) => {
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < min || n > max) throw Error("Invalid integer");
  return n;
};

export function parseMessage(buffer: Buffer): EAMessage {
  if (buffer.length > MAX_MESSAGE_BYTES) throw Error("Message too large");
  const p = buffer.toString("utf8").split("|");
  if (p[1] !== "1" || !/^[\w.-]{1,120}$/.test(p[2] ?? "")) throw Error("Invalid protocol/session");
  if (p[0] === "H" && p.length >= 10 && p.length <= 14) return parseHello(p);
  if (p[0] === "T" && p.length === 4) return parseTicks(p);
  if (p[0] === "G" && p.length === 9) return parseBars(p);
  if (IGNORED_TYPES.has(p[0])) return { type: "ignored", session: p[2] };
  throw Error("Unknown message");
}

function parseHello(p: string[]): Hello {
  if (p.slice(3, 6).some((s) => !s.length || s.length > 120 || /[\x00-\x1f]/.test(s))) throw Error("Invalid identity");
  if (p[9] !== "ok" && p[9] !== "no-quote") throw Error("Invalid status");
  if (p.length === 14 && !/^[0-9A-Za-z.-]{1,32}$/.test(p[13])) throw Error("Invalid EA version");
  return {
    type: "hello",
    session: p[2],
    terminal: p[3],
    broker: p[4],
    symbol: p[5],
    digits: integer(p[6], 0, 10),
    interval: integer(p[7], 500, 1000),
    dropped: integer(p[8], 0, Number.MAX_SAFE_INTEGER),
    quoteStatus: p[9],
    timeframe: p.length >= 11 ? integer(p[10], 1, 43200) : undefined,
    candleCapacity: p.length >= 12 ? integer(p[11], 2000, 2000) : undefined,
    higherTimeframes: p.length >= 13 ? integer(p[12], 1, 1) === 1 : undefined,
    eaVersion: p.length === 14 ? p[13] : undefined,
  };
}

function parseTicks(p: string[]): TickBatch {
  const rows = p[3].split(";");
  if (!rows.length || rows.length > 32) throw Error("Invalid batch size");
  let previous = 0;
  const samples = rows.map((row) => {
    const f = row.split(",");
    if (f.length !== 5) throw Error("Invalid sample");
    const seq = integer(f[0], 1, Number.MAX_SAFE_INTEGER);
    const bid = Number(f[1]);
    const ask = Number(f[2]);
    if (seq <= previous || !Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask < bid) throw Error("Invalid quote");
    previous = seq;
    return { seq, bid, ask, quoteTime: integer(f[3], 1, 9999999999), sampledTime: integer(f[4], 1, 9999999999) };
  });
  return { type: "samples", session: p[2], samples };
}

function parseBars(p: string[]): BarPage {
  const request = integer(p[3], 1, Number.MAX_SAFE_INTEGER);
  const timeframe = integer(p[4], 1, 43200);
  if (!TIMEFRAMES.includes(timeframe)) throw Error("Invalid period");
  if (p[5] !== "ok" && p[5] !== "loading") throw Error("Invalid status");
  const total = integer(p[6], 0, Number.MAX_SAFE_INTEGER);
  const offset = integer(p[7], 0, Number.MAX_SAFE_INTEGER);
  const rows = p[8] ? p[8].split(";") : [];
  const sizeValid = p[5] === "loading" ? total === 0 && offset === 0 && !rows.length : total <= MAX_REQUEST_BARS && offset < total && rows.length === Math.min(BARS_PER_PAGE, total - offset);
  if (!sizeValid) throw Error("Invalid bar page size");
  let previous = 0;
  const bars = rows.map((row) => {
    const f = row.split(",");
    if (f.length !== 6 || f.some((v) => v.trim() === "")) throw Error("Invalid bar");
    const [open, high, low, close] = f.slice(1, 5).map(Number);
    const time = integer(f[0], 1, 9999999999);
    if (time <= previous || ![open, high, low, close].every((n) => Number.isFinite(n) && n > 0) || low > Math.min(open, close) || high < Math.max(open, close)) {
      throw Error("Invalid bar");
    }
    previous = time;
    return { time, open, high, low, close, tickVolume: integer(f[5], 0, Number.MAX_SAFE_INTEGER) };
  });
  return { type: "bars", session: p[2], request, timeframe, status: p[5], total, offset, bars };
}

/**
 * Feed key: one symbol from one terminal. The broker server is not part of it: a feed's market follows its terminal's
 * current login (ADR 11).
 */
export const feedKey = (h: Pick<Hello, "terminal" | "symbol">) => JSON.stringify([h.terminal, h.symbol]);

/** A market: one symbol on one broker server. */
export type Market = { brokerServer: string; symbol: string };

export const marketKey = (m: Market) => JSON.stringify([m.brokerServer, m.symbol]);
