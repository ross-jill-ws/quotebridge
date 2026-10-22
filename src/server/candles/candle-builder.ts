// In-memory candles: every feed's samples folded into M1 bid candles, bucketed by quote time. Quote time is the
// broker clock as the EA reports it: candles break on it, as MetaTrader's do, and each carries its UTC start from the
// broker server's clock rule (ADR 11). A feed's candles restart when its market changes. Nothing is written to disk.
import { brokerToUtc, type ClockRule } from "../../shared/clock.js";
import { bucketStart, PERIODS, type Period } from "../../shared/periods.js";
import { marketKey, type BridgeServer, type Market, type SampleEvent } from "../bridge/index.js";

/** At most 7 days of M1 candles per feed; the oldest are dropped first. */
export const MAX_M1_CANDLES = 10080;

/** `time` is the bucket's start in seconds of the broker clock. */
export type Candle = { time: number; open: number; high: number; low: number; close: number };

/** A candle as answered: `utc` is its start in UTC seconds, null while the broker server's clock rule is unknown. */
export type DatedCandle = Candle & { utc: number | null };

type M1Candle = Candle & { samples: number };

/** `lastQuoteTime`: the newest quote time folded in; older quotes (replays, late arrivals) are left out. */
type FeedCandles = { market: Market; m1: M1Candle[]; ask?: number; lastQuoteTime: number };

export type CandleBuilderOptions = {
  /** Clock in epoch milliseconds; injectable for tests. */
  now?: () => number;
  /** A broker server's clock rule, or null while unknown. */
  clockRule?: (brokerServer: string) => ClockRule | null;
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
  private readonly clockRule: (brokerServer: string) => ClockRule | null;

  constructor(bridge: BridgeServer, options: CandleBuilderOptions = {}) {
    this.since = (options.now ?? Date.now)();
    this.clockRule = options.clockRule ?? (() => null);
    this.unsubscribe = bridge.onSamples((event) => this.handle(event));
  }

  private handle(event: SampleEvent) {
    if (event.type === "removed") {
      this.feeds.delete(event.feed);
      return;
    }
    let feed = this.feeds.get(event.feed);
    // A new feed, or its terminal logged into another broker server: prices from two servers never share a candle.
    if (!feed || marketKey(feed.market) !== marketKey(event.market)) this.feeds.set(event.feed, (feed = { market: event.market, m1: [], lastQuoteTime: 0 }));
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
  candles(feed: string, period: Period, limit?: number): DatedCandle[] {
    const candles = this.feeds.get(feed);
    const out: Candle[] = [];
    for (const m1 of candles?.m1 ?? []) {
      const time = bucketStart(m1.time, period);
      const last = out.at(-1);
      if (last?.time === time) extend(last, m1.high, m1.low, m1.close);
      else out.push({ time, open: m1.open, high: m1.high, low: m1.low, close: m1.close });
    }
    const rule = candles && this.clockRule(candles.market.brokerServer);
    return (limit === undefined ? out : out.slice(-limit)).map((c) => ({ ...c, utc: rule ? brokerToUtc(rule, c.time * 1000) / 1000 : null }));
  }

  /** A feed's latest ask, for the Ask line; null before its first sample. */
  ask(feed: string): number | null {
    return this.feeds.get(feed)?.ask ?? null;
  }

  close() {
    this.unsubscribe();
  }
}
