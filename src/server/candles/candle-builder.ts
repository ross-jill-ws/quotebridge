// In-memory candles (milestone 2): every feed's samples folded into M1 bid candles, bucketed by quote time.
// Quote time is the broker's server time as the EA reports it, kept without conversion. Nothing is written to disk.
import type { BridgeServer, SampleEvent } from "../bridge/index.js";

/** At most 7 days of M1 candles per feed; the oldest are dropped first. */
export const MAX_M1_CANDLES = 10080;

/** Chart periods in MetaTrader's order; all but M1 are aggregated from M1 on request. */
export const PERIODS = ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN1"] as const;
export type Period = (typeof PERIODS)[number];

const DAY = 86400;
const PERIOD_SECONDS: Record<Exclude<Period, "W1" | "MN1">, number> = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: DAY };

/**
 * The start of the period bucket holding `time` (seconds of broker server time, read as if it were UTC):
 * W1 starts on Monday 00:00, MN1 on the 1st of the calendar month.
 */
function bucket(time: number, period: Period) {
  if (period === "W1") {
    const day = time - (time % DAY);
    // 1 January 1970 was a Thursday: three days after a Monday.
    return day - ((day / DAY + 3) % 7) * DAY;
  }
  if (period === "MN1") {
    const date = new Date(time * 1000);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000;
  }
  return time - (time % PERIOD_SECONDS[period]);
}

export type Candle = { time: number; open: number; high: number; low: number; close: number };

type M1Candle = Candle & { samples: number };

type FeedCandles = { m1: M1Candle[]; ask?: number };

export class CandleBuilder {
  private readonly feeds = new Map<string, FeedCandles>();
  private readonly unsubscribe: () => void;
  /** When this server began building candles, in epoch milliseconds. */
  readonly since: number;

  constructor(bridge: BridgeServer, now: () => number = Date.now) {
    this.since = now();
    this.unsubscribe = bridge.onSamples((event) => this.handle(event));
  }

  private handle(event: SampleEvent) {
    if (event.type === "removed") {
      this.feeds.delete(event.feed);
      return;
    }
    let feed = this.feeds.get(event.feed);
    if (!feed) this.feeds.set(event.feed, (feed = { m1: [] }));
    for (const s of event.samples) {
      const time = s.quoteTime - (s.quoteTime % 60);
      const last = feed.m1.at(-1);
      feed.ask = s.ask;
      // A quote older than the forming minute (rare clock steps) cannot reopen a closed candle.
      if (last && time < last.time) continue;
      if (last?.time === time) {
        last.high = Math.max(last.high, s.bid);
        last.low = Math.min(last.low, s.bid);
        last.close = s.bid;
        last.samples++;
        continue;
      }
      feed.m1.push({ time, open: s.bid, high: s.bid, low: s.bid, close: s.bid, samples: 1 });
      if (feed.m1.length > MAX_M1_CANDLES) feed.m1.shift();
    }
  }

  /** A feed's candles of one period, oldest first; the latest `limit` when given. */
  candles(feed: string, period: Period, limit?: number): Candle[] {
    const out: Candle[] = [];
    for (const k of this.feeds.get(feed)?.m1 ?? []) {
      const time = bucket(k.time, period);
      const last = out.at(-1);
      if (last?.time === time) {
        last.high = Math.max(last.high, k.high);
        last.low = Math.min(last.low, k.low);
        last.close = k.close;
      } else out.push({ time, open: k.open, high: k.high, low: k.low, close: k.close });
    }
    return limit === undefined ? out : out.slice(-limit);
  }

  /** A feed's latest ask, for the Ask line; null before its first sample. */
  ask(feed: string): number | null {
    return this.feeds.get(feed)?.ask ?? null;
  }

  close() {
    this.unsubscribe();
  }
}
