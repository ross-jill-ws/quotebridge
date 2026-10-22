// Chart history: the bars a chart shows, newest first in pages. Closed bars come from the terminal's HST file for the
// period (rolled up from its M1 file when the period has none); the live candles join on after the file's last bar,
// and the bar at its last time takes HST's open with the live high, low and close, as it is still forming. Older than
// HST's first bar, saved history continues (it holds every closed bar when there is no HST). With neither there are
// live candles only. Times are handed out in UTC from the broker server's clock rule (ADR 11).
import { brokerToUtc, UNKNOWN_RULE, utcToBroker, type ClockRule } from "../../shared/clock.js";
import { bucketStart, type Period } from "../../shared/periods.js";
import type { FeedSnapshot, Market } from "../bridge/index.js";
import type { Candle } from "../candles/index.js";
import { HstFile, hstPath, type HstBar } from "./hst-file.js";

/** MetaTrader's period lengths in minutes, as in HST file names. */
export const PERIOD_MINUTES: Record<Period, number> = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440, W1: 10080, MN1: 43200 };

/** M1 bars read at a time while rolling a period up. */
const ROLLUP_PAGE = 5000;

/** A page of candles, oldest first, with UTC times. `source`: "hst" when it holds HST bars, else "saved" when it holds saved ones, else "live". */
export type HistoryPage = { candles: Candle[]; source: "hst" | "saved" | "live"; complete: boolean };

/** A page in broker seconds; its last `live` candles are the live ones, the last of them still forming. */
export type BrokerHistoryPage = HistoryPage & { live: number };

export type ChartHistoryOptions = {
  /** A terminal's data folder, where its HST files are; undefined when unknown. */
  dataFolder: (terminalId: string) => string | undefined;
  /** A feed's live candles of a period in broker seconds, oldest first. */
  liveCandles: (feed: string, period: Period) => Candle[];
  /** A broker server's clock rule, or null while unknown. */
  clockRule: (brokerServer: string) => ClockRule | null;
  /** Up to `limit` saved bars of a market's period older than `before` (broker seconds), oldest first; omitted without a database. */
  savedBars?: (market: Market, period: Period, before: number | undefined, limit: number) => Promise<{ bars: Candle[]; complete: boolean }>;
};

/** Closed bars, oldest first, in broker seconds. */
interface BarSource {
  last(): Promise<Candle | null>;
  /** Up to `limit` bars older than `before` (all when undefined); `complete` when none older remain. */
  before(before: number | undefined, limit: number): Promise<{ bars: Candle[]; complete: boolean; source: "hst" | "saved" }>;
}

/** An HST file's bars, or bars rolled up from one. */
interface HstSource extends BarSource {
  /** The oldest bar's start, or null when there is none. */
  first(): Promise<number | null>;
}

export class ChartHistory {
  constructor(private readonly options: ChartHistoryOptions) {}

  /** Up to `limit` candles older than `before` (UTC seconds; the latest when undefined). */
  async page(feed: FeedSnapshot, period: Period, limit: number, before?: number): Promise<HistoryPage> {
    const rule = this.options.clockRule(feed.market.brokerServer) ?? UNKNOWN_RULE;
    const toUtc = (c: Candle): Candle => ({ ...c, time: brokerToUtc(rule, c.time * 1000) / 1000 });
    const { candles, source, complete } = await this.brokerPage(feed, period, limit, before === undefined ? undefined : utcToBroker(rule, before * 1000) / 1000);
    return { candles: candles.map(toUtc), source, complete };
  }

  /** Up to `limit` candles older than `before` (broker seconds; the latest when undefined), in broker seconds. */
  async brokerPage(feed: FeedSnapshot, period: Period, limit: number, before?: number): Promise<BrokerHistoryPage> {
    const brokerBefore = before ?? Infinity;
    const source = await this.source(feed, period);
    const hstLast = (await source?.last()) ?? null;

    // The live part: candles after HST's last bar, and the bar at its last time still forming.
    const live: Candle[] = [];
    for (const c of this.options.liveCandles(feed.feed, period)) {
      if (!hstLast || c.time > hstLast.time) live.push(c);
      else if (c.time === hstLast.time) live.push(combine(hstLast, c));
    }
    const liveBefore = live.filter((c) => c.time < brokerBefore);
    if (liveBefore.length >= limit || !hstLast) {
      const candles = liveBefore.slice(-limit);
      return { candles, source: "live", complete: liveBefore.length <= limit && !hstLast, live: candles.length };
    }
    // HST's closed bars, older than the live part and than `before`.
    const cut = Math.min(brokerBefore, live[0]?.time ?? Infinity);
    const closed = await source!.before(cut === Infinity ? undefined : cut, limit - liveBefore.length);
    return { candles: [...closed.bars, ...liveBefore], source: closed.bars.length ? closed.source : "live", complete: closed.complete, live: liveBefore.length };
  }

  /** HST, continued by saved history; else saved history alone, when it holds any; else none. */
  private async source(feed: FeedSnapshot, period: Period): Promise<BarSource | null> {
    const read = this.options.savedBars;
    const saved = read ? savedSource((before, limit) => read(feed.market, period, before, limit)) : null;
    const hst = await this.hstSource(feed, period);
    if (hst) return saved ? chain(hst, saved) : hst;
    return saved && (await saved.last()) ? saved : null;
  }

  /** The period's HST file, else its M1 file rolled up, else none. */
  private async hstSource(feed: FeedSnapshot, period: Period): Promise<HstSource | null> {
    const folder = this.options.dataFolder(feed.terminal);
    if (!folder) return null;
    const file = (minutes: number) => HstFile.open(hstPath(folder, feed.market.brokerServer, feed.market.symbol, minutes));
    const own = await file(PERIOD_MINUTES[period]);
    if (own) return fileSource(own);
    const m1 = period === "M1" ? null : await file(1);
    return m1 ? rollupSource(m1, period) : null;
  }
}

const candle = ({ time, open, high, low, close }: HstBar): Candle => ({ time, open, high, low, close });

function fileSource(file: HstFile): HstSource {
  return {
    first: async () => (await file.span())?.first ?? null,
    last: async () => {
      const bar = await file.last();
      return bar && candle(bar);
    },
    before: async (before, limit) => {
      const page = await file.before(before, limit);
      return { bars: page.bars.map(candle), complete: page.complete, source: "hst" };
    },
  };
}

/** A period built from M1 bars: each bucket of the broker clock, as the live candles are. */
function rollupSource(m1: HstFile, period: Period): HstSource {
  const before: BarSource["before"] = async (until, limit) => {
    // Buckets read so far, oldest first; the oldest may still be missing earlier M1 bars until one older is seen.
    let buckets: Candle[] = [];
    let cursor = until;
    for (;;) {
      const page = await m1.before(cursor, ROLLUP_PAGE);
      const rolled = rollUp(page.bars, period);
      const joined = rolled.at(-1);
      if (joined && buckets[0]?.time === joined.time) {
        buckets[0] = combine(joined, buckets[0]);
        rolled.pop();
      }
      buckets = [...rolled, ...buckets];
      if (buckets.length > limit) return { bars: buckets.slice(-limit), complete: false, source: "hst" };
      if (page.complete || page.next === undefined) return { bars: buckets, complete: true, source: "hst" };
      cursor = page.next;
    }
  };
  const first = async () => {
    const oldest = (await m1.span())?.first;
    return oldest === undefined ? null : bucketStart(oldest, period);
  };
  return { first, last: async () => (await before(undefined, 1)).bars[0] ?? null, before };
}

/** Saved history alone. */
function savedSource(read: (before: number | undefined, limit: number) => Promise<{ bars: Candle[]; complete: boolean }>): BarSource {
  return {
    last: async () => (await read(undefined, 1)).bars[0] ?? null,
    before: async (before, limit) => ({ ...(await read(before, limit)), source: "saved" }),
  };
}

/** HST's bars, then the saved ones older than HST's first bar. */
function chain(hst: HstSource, saved: BarSource): BarSource {
  return {
    last: async () => (await hst.last()) ?? (await saved.last()),
    before: async (before, limit) => {
      const page = await hst.before(before, limit);
      if (!page.complete) return page;
      const first = await hst.first();
      const cut = Math.min(before ?? Infinity, first ?? Infinity);
      const rest = await saved.before(cut === Infinity ? undefined : cut, limit - page.bars.length);
      return { bars: [...rest.bars, ...page.bars], complete: rest.complete, source: page.bars.length || !rest.bars.length ? "hst" : "saved" };
    },
  };
}

/** M1 bars, oldest first, into the period's buckets. */
function rollUp(bars: readonly HstBar[], period: Period): Candle[] {
  const out: Candle[] = [];
  for (const bar of bars) {
    const time = bucketStart(bar.time, period);
    const last = out.at(-1);
    if (last?.time === time) out[out.length - 1] = combine(last, bar);
    else out.push({ time, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
  }
  return out;
}

/** One bar from an earlier part of a bucket and a later one: the earlier open, the later close. */
function combine(earlier: Candle, later: Candle): Candle {
  return { time: earlier.time, open: earlier.open, high: Math.max(earlier.high, later.high), low: Math.min(earlier.low, later.low), close: later.close };
}
