// QuoteBridge EA wire protocol (EA → app), ported from the legacy server.
// Unchanged except for the optional 14th hello field carrying the EA version (EA 1.08+).

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

/** Messages this milestone does not handle (candles, trading, account info, read errors); dropped unread. */
export type Ignored = { type: "ignored"; session: string };

export type EAMessage = Hello | TickBatch | Ignored;

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

/** Feed key: one symbol from one terminal and broker. */
export const feedKey = (h: Pick<Hello, "terminal" | "broker" | "symbol">) => JSON.stringify([h.terminal, h.broker, h.symbol]);
