// Chart history: the bars a chart shows, newest first in pages. Closed bars come from the terminal's HST file for the
// period (rolled up from its M1 file when the period has none); the live candles join on after the file's last bar,
// and the bar at its last time takes HST's open with the live high, low and close, as it is still forming. With no
// HST there are live candles only. Times are handed out in UTC from the broker server's clock rule (ADR 11).
import { brokerToUtc, UNKNOWN_RULE, utcToBroker, type ClockRule } from "../../shared/clock.js";
import { bucketStart, type Period } from "../../shared/periods.js";
import type { FeedSnapshot } from "../bridge/index.js";
import type { Candle } from "../candles/index.js";
import { HstFile, hstPath, type HstBar } from "./hst-file.js";

/** MetaTrader's period lengths in minutes, as in HST file names. */
export const PERIOD_MINUTES: Record<Period, number> = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440, W1: 10080, MN1: 43200 };

/** M1 bars read at a time while rolling a period up. */
const ROLLUP_PAGE = 5000;

/** A page of candles, oldest first, with UTC times. `source`: "hst" when it holds HST bars, else "live". */
export type HistoryPage = { candles: Candle[]; source: "hst" | "live"; complete: boolean };

export type ChartHistoryOptions = {
  /** A terminal's data folder, where its HST files are; undefined when unknown. */
  dataFolder: (terminalId: string) => string | undefined;
  /** A feed's live candles of a period in broker seconds, oldest first. */
  liveCandles: (feed: string, period: Period) => Candle[];
  /** A broker server's clock rule, or null while unknown. */
  clockRule: (brokerServer: string) => ClockRule | null;
};

/** Closed bars, oldest first, in broker seconds. */
interface BarSource {
  last(): Promise<Candle | null>;
  /** Up to `limit` bars older than `before` (all when undefined); `complete` when none older remain. */
  before(before: number | undefined, limit: number): Promise<{ bars: Candle[]; complete: boolean }>;
}

export class ChartHistory {
  constructor(private readonly options: ChartHistoryOptions) {}

  /** Up to `limit` candles older than `before` (UTC seconds; the latest when undefined). */
  async page(feed: FeedSnapshot, period: Period, limit: number, before?: number): Promise<HistoryPage> {
    const rule = this.options.clockRule(feed.market.brokerServer) ?? UNKNOWN_RULE;
    const toUtc = (c: Candle): Candle => ({ ...c, time: brokerToUtc(rule, c.time * 1000) / 1000 });
    const brokerBefore = before === undefined ? Infinity : utcToBroker(rule, before * 1000) / 1000;
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
      return { candles: liveBefore.slice(-limit).map(toUtc), source: "live", complete: liveBefore.length <= limit && !hstLast };
    }
    // HST's closed bars, older than the live part and than `before`.
    const cut = Math.min(brokerBefore, live[0]?.time ?? Infinity);
    const closed = await source!.before(cut === Infinity ? undefined : cut, limit - liveBefore.length);
    return { candles: [...closed.bars, ...liveBefore].map(toUtc), source: closed.bars.length ? "hst" : "live", complete: closed.complete };
  }

  /** The period's HST file, else its M1 file rolled up, else none. */
  private async source(feed: FeedSnapshot, period: Period): Promise<BarSource | null> {
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

function fileSource(file: HstFile): BarSource {
  return {
    last: async () => {
      const bar = await file.last();
      return bar && candle(bar);
    },
    before: async (before, limit) => {
      const page = await file.before(before, limit);
      return { bars: page.bars.map(candle), complete: page.complete };
    },
  };
}

/** A period built from M1 bars: each bucket of the broker clock, as the live candles are. */
function rollupSource(m1: HstFile, period: Period): BarSource {
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
      if (buckets.length > limit) return { bars: buckets.slice(-limit), complete: false };
      if (page.complete || page.next === undefined) return { bars: buckets, complete: true };
      cursor = page.next;
    }
  };
  return { last: async () => (await before(undefined, 1)).bars[0] ?? null, before };
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
