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
function bucketStart(time: number, period: Period) {
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

/** `time` is the bucket's start in seconds of broker server time. */
export type Candle = { time: number; open: number; high: number; low: number; close: number };

type M1Candle = Candle & { samples: number };

/** `lastQuoteTime`: the newest quote time folded in; older quotes (replays, late arrivals) are left out. */
type FeedCandles = { m1: M1Candle[]; ask?: number; lastQuoteTime: number };

export type CandleBuilderOptions = {
  /** Clock in epoch milliseconds; injectable for tests. */
  now?: () => number;
};

/** Takes a later part of the same bucket into `candle`. */
function extend(candle: Candle, high: number, low: number, close: number) {
  candle.high = Math.max(candle.high, high);
  candle.low = Math.min(candle.low, low);
  candle.close = close;
}

export class CandleBuilder {
  private readonly feeds = new Map<string, FeedCandles>();
  private readonly unsubscribe: () => void;
  /** When this server began building candles, in epoch milliseconds. */
  readonly since: number;

  constructor(bridge: BridgeServer, options: CandleBuilderOptions = {}) {
    this.since = (options.now ?? Date.now)();
    this.unsubscribe = bridge.onSamples((event) => this.handle(event));
  }

  private handle(event: SampleEvent) {
    if (event.type === "removed") {
      this.feeds.delete(event.feed);
      return;
    }
    let feed = this.feeds.get(event.feed);
    if (!feed) this.feeds.set(event.feed, (feed = { m1: [], lastQuoteTime: 0 }));
    for (const sample of event.samples) {
      // A chart's replayed buffer (under a new session, or from another chart of the feed) or a late quote.
      if (sample.quoteTime < feed.lastQuoteTime) continue;
      feed.lastQuoteTime = sample.quoteTime;
      feed.ask = sample.ask;
      const time = bucketStart(sample.quoteTime, "M1");
      const last = feed.m1.at(-1);
      if (last?.time === time) {
        extend(last, sample.bid, sample.bid, sample.bid);
        last.samples++;
        continue;
      }
      feed.m1.push({ time, open: sample.bid, high: sample.bid, low: sample.bid, close: sample.bid, samples: 1 });
      if (feed.m1.length > MAX_M1_CANDLES) feed.m1.shift();
    }
  }

  /** A feed's candles of one period, oldest first; the latest `limit` when given. */
  candles(feed: string, period: Period, limit?: number): Candle[] {
    const out: Candle[] = [];
    for (const m1 of this.feeds.get(feed)?.m1 ?? []) {
      const time = bucketStart(m1.time, period);
      const last = out.at(-1);
      if (last?.time === time) extend(last, m1.high, m1.low, m1.close);
      else out.push({ time, open: m1.open, high: m1.high, low: m1.low, close: m1.close });
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
