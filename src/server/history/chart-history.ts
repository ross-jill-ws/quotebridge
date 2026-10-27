// Chart history: the bars a chart shows, newest first in pages. Closed bars come from the terminal's HST file for the
// period, continued by its fill file (D1 for W1 and MN1, else M1) rolled up where the period's file is stale, or by the
// fill file alone when the period has no file (MetaTrader writes a period's file only when its chart closes). The live
// candles join on after the last bar, and the bar at its last time takes HST's open with the live high, low and close,
// as it is still forming. Older than the period file's first bar, saved history continues (it holds every closed bar
// when there is no HST); newer than its last bar, saved bars continue it too: the EA's bars (ea-bars.ts), which also
// replace the file's last bar, as it may have been written while forming. With neither there are live candles only.
// When the latest page has no bars, or a gap before the live candles (before the bucket now, without them), the EA is
// asked for its bars, and the page says it is filling until they are in; so it is when the period has none of
// MetaTrader's own bars (a file of its own, or saved bars), only the fill file's. Buckets start where MetaTrader's own
// bars of the period do (CMC's GOLD H4 bars start at 01:00), at the usual times without them: the live candles and the
// fill file's roll-up take that offset. Times are handed out in UTC from the broker server's clock rule (ADR 11).
import { brokerToUtc, UNKNOWN_RULE, utcToBroker, type ClockRule } from "../../shared/clock.js";
import { barOffset, bucketsEnd, bucketStart, isIntraday, PERIODS, type Period } from "../../shared/periods.js";
import type { FeedSnapshot, Market } from "../bridge/index.js";
import type { Candle } from "../candles/index.js";
import { HstFile, hstPath, type HstBar } from "./hst-file.js";

/** MetaTrader's period lengths in minutes, as in HST file names. */
export const PERIOD_MINUTES: Record<Period, number> = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440, W1: 10080, MN1: 43200 };
/** Periods by their length in minutes. */
export const PERIOD_OF = new Map(PERIODS.map((p) => [PERIOD_MINUTES[p], p]));

/** Fill file bars read at a time while rolling a period up. */
const ROLLUP_PAGE = 5000;
/** MetaTrader's own recent bars whose most common offset is the period's. */
const OFFSET_BARS = 48;

/**
 * A page of candles, oldest first, with UTC times. `source`: "hst" when it holds HST bars, else "saved" when it holds
 * saved ones, else "live". `filling`: the EA is being asked for the period's bars; the latest page grows once they
 * are in. `offset`: how far after the usual bucket start the period's buckets start, in seconds (bucketStart's).
 */
export type HistoryPage = { candles: Candle[]; source: "hst" | "saved" | "live"; complete: boolean; filling: boolean; offset: number };

/**
 * A page in broker seconds; its last `live` candles are the live ones. `forming`: the start of the newest live candle,
 * still forming (in this page or not), if any.
 */
export type BrokerHistoryPage = HistoryPage & { live: number; forming: number | undefined };

export type ChartHistoryOptions = {
  /** A terminal's data folder, where its HST files are; undefined when unknown. */
  dataFolder: (terminalId: string) => string | undefined;
  /** A feed's live candles of a period in broker seconds, oldest first, in buckets `offset` seconds late. */
  liveCandles: (feed: string, period: Period, offset: number) => Candle[];
  /** A broker server's clock rule, or null while unknown. */
  clockRule: (brokerServer: string) => ClockRule | null;
  /** Up to `limit` saved bars of a market's period older than `before` (broker seconds), oldest first; omitted without a database. */
  savedBars?: (market: Market, period: Period, before: number | undefined, limit: number) => Promise<{ bars: Candle[]; complete: boolean }>;
  /** Asks a feed's EA for a period's bars; omitted without a database. */
  eaBars?: { want(feed: FeedSnapshot, period: Period): Promise<boolean>; filling(market: Market, period: Period): boolean };
  /** Clock in epoch milliseconds; injectable for tests. */
  now?: () => number;
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

/** Bars rolled up from a finer file; `since` stops the read at the buckets that start from then on. */
interface RollupSource extends HstSource {
  before(before: number | undefined, limit: number, since?: number): ReturnType<BarSource["before"]>;
}

export class ChartHistory {
  constructor(private readonly options: ChartHistoryOptions) {}

  /** Up to `limit` candles older than `before` (UTC seconds; the latest when undefined). */
  async page(feed: FeedSnapshot, period: Period, limit: number, before?: number): Promise<HistoryPage> {
    const rule = this.options.clockRule(feed.market.brokerServer) ?? UNKNOWN_RULE;
    const toUtc = (c: Candle): Candle => ({ ...c, time: brokerToUtc(rule, c.time * 1000) / 1000 });
    const { candles, source, complete, filling, offset } = await this.brokerPage(feed, period, limit, before === undefined ? undefined : utcToBroker(rule, before * 1000) / 1000);
    return { candles: candles.map(toUtc), source, complete, filling, offset };
  }

  /** Up to `limit` candles older than `before` (broker seconds; the latest when undefined), in broker seconds. */
  async brokerPage(feed: FeedSnapshot, period: Period, limit: number, before?: number): Promise<BrokerHistoryPage> {
    const brokerBefore = before ?? Infinity;
    const { source, offset, hasOwnBars } = await this.source(feed, period);
    const hstLast = (await source?.last()) ?? null;

    // The live part: candles after HST's last bar, and the bar at its last time still forming.
    const live: Candle[] = [];
    const liveCandles = this.options.liveCandles(feed.feed, period, offset);
    const forming = liveCandles.at(-1)?.time;
    for (const c of liveCandles) {
      if (!hstLast || c.time > hstLast.time) live.push(c);
      else if (c.time === hstLast.time) live.push(combine(hstLast, c));
    }
    // A page that asked the EA says it is filling even when the bars are in already: it was read before they came.
    const asked = before === undefined && (await this.fillGap(feed, period, { hstLast, live, offset, hasOwnBars }));
    const filling = asked || (this.options.eaBars?.filling(feed.market, period) ?? false);
    const liveBefore = live.filter((c) => c.time < brokerBefore);
    if (liveBefore.length >= limit || !hstLast) {
      const candles = liveBefore.slice(-limit);
      return { candles, source: "live", complete: liveBefore.length <= limit && !hstLast, filling, offset, live: candles.length, forming };
    }
    // HST's closed bars, older than the live part and than `before`.
    const cut = Math.min(brokerBefore, live[0]?.time ?? Infinity);
    const closed = await source!.before(cut === Infinity ? undefined : cut, limit - liveBefore.length);
    return { candles: [...closed.bars, ...liveBefore], source: closed.bars.length ? closed.source : "live", complete: closed.complete, filling, offset, live: liveBefore.length, forming };
  }

  /** Asks the feed's EA for the period's bars when they have a gap: as a feed connects, for its chart period. */
  async fill(feed: FeedSnapshot, period: Period) {
    if (!this.options.eaBars) return;
    const { source, offset, hasOwnBars } = await this.source(feed, period);
    const hstLast = (await source?.last()) ?? null;
    await this.fillGap(feed, period, { hstLast, live: this.options.liveCandles(feed.feed, period, offset), offset, hasOwnBars });
  }

  /**
   * Asks for the bars when there are none, or a bucket is missing between the last one and the live candles (or now);
   * true when they were asked for. An intraday period with none of MetaTrader's own bars, only the fill file's rolled
   * up, has none: its buckets' start is learned from the EA's.
   */
  private async fillGap(feed: FeedSnapshot, period: Period, { hstLast, live, offset, hasOwnBars }: { hstLast: Candle | null; live: Candle[]; offset: number; hasOwnBars: boolean }): Promise<boolean> {
    const ea = this.options.eaBars;
    if (!ea) return false;
    const last = hasOwnBars || !isIntraday(period) ? hstLast : null;
    const rule = this.options.clockRule(feed.market.brokerServer) ?? UNKNOWN_RULE;
    const end = live[0]?.time ?? bucketStart(Math.floor(utcToBroker(rule, (this.options.now ?? Date.now)()) / 1000), period, offset);
    return (!last || bucketStart(end - 1, period, offset) > last.time) && (await ea.want(feed, period));
  }

  /**
   * HST, continued by saved history either side; else saved history alone, when it holds any; else none. `offset`:
   * how far after the usual bucket start MetaTrader's own recent bars of the period (its file's, or the saved ones,
   * whichever reach later) start, 0 without them; it holds for all the period's history (a broker moving its bars, as
   * across a clock change its session does not follow, is not seen). `hasOwnBars`: there are such bars.
   */
  private async source(feed: FeedSnapshot, period: Period): Promise<{ source: BarSource | null; offset: number; hasOwnBars: boolean }> {
    const read = this.options.savedBars;
    const saved = read ? savedSource((before, limit) => read(feed.market, period, before, limit)) : null;
    const folder = this.options.dataFolder(feed.terminal);
    const file = async (minutes: number) => (folder ? HstFile.open(hstPath(folder, feed.market.brokerServer, feed.market.symbol, minutes)) : null);
    const ownFile = await file(PERIOD_MINUTES[period]);
    const ownSource = ownFile && fileSource(ownFile);
    const [ownLast, savedLast] = await Promise.all([ownSource?.last() ?? null, saved?.last() ?? null]);
    const newest = Math.max(ownLast?.time ?? -Infinity, savedLast?.time ?? -Infinity);
    const hasOwnBars = newest !== -Infinity;
    const recent = !hasOwnBars || !isIntraday(period) ? null : ownLast?.time === newest ? ownSource : saved;
    const offset = recent ? commonOffset((await recent.before(undefined, OFFSET_BARS)).bars, period) : 0;
    const hst = await this.hstSource(period, file, ownSource, ownLast, offset);
    if (hst) return { source: saved ? continuedBySaved(chain(hst, saved), saved) : hst, offset, hasOwnBars };
    return { source: savedLast ? saved : null, offset, hasOwnBars };
  }

  /** The period's HST file, continued by its fill file where that reaches later; else the fill file rolled up; else none. */
  private async hstSource(
    period: Period,
    file: (minutes: number) => Promise<HstFile | null>,
    ownSource: HstSource | null,
    ownLast: Candle | null,
    offset: number,
  ): Promise<HstSource | null> {
    const daily = period === "W1" || period === "MN1" ? await file(PERIOD_MINUTES.D1) : null;
    const fillFile = daily ?? (period === "M1" ? null : await file(PERIOD_MINUTES.M1));
    const fill = fillFile && rollupSource(fillFile, period, offset);
    if (!ownSource || !ownLast) return fill ?? ownSource;
    if (!fill) return ownSource;
    const [fillLast, fillSpan] = await Promise.all([fill.last(), fillFile.span()]);
    if (!fillLast || !fillSpan || fillLast.time <= ownLast.time) return ownSource;
    // The own file's last bar may have been written while forming: the fill file's replaces it when the fill file
    // holds that whole bucket (the moment before its first bar is in an earlier bucket).
    const whole = bucketStart(fillSpan.first - 1, period, offset) < ownLast.time;
    return filled(ownSource, fill, whole ? ownLast.time : ownLast.time + 1);
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

/**
 * A period built from a finer file's bars (M1 or D1): each bucket of the broker clock, as the live candles are. A
 * bucket is rolled up from all its fill bars wherever a page is cut: those of every bucket that starts before `until`
 * (exclusive), up to where those buckets end.
 */
function rollupSource(fillFile: HstFile, period: Period, offset: number): RollupSource {
  const before: RollupSource["before"] = async (until, limit, since) => {
    // Buckets read so far, oldest first; the oldest may still be missing earlier fill bars until one older is seen.
    let buckets: Candle[] = [];
    let cursor = until === undefined ? undefined : bucketsEnd(until, period, offset);
    for (;;) {
      const page = await fillFile.before(cursor, ROLLUP_PAGE);
      const rolled = rollUp(page.bars, period, offset);
      const joined = rolled.at(-1);
      if (joined && buckets[0]?.time === joined.time) {
        buckets[0] = combine(joined, buckets[0]);
        rolled.pop();
      }
      buckets = [...rolled, ...buckets];
      // None older than `since` are wanted; once a bar older than it is read, the buckets from there on are whole.
      const reached = since !== undefined && page.bars.length > 0 && page.bars[0].time < since;
      if (since !== undefined) buckets = buckets.filter((b) => b.time >= since);
      if (buckets.length > limit) return { bars: buckets.slice(-limit), complete: false, source: "hst" };
      if (reached || page.complete || page.next === undefined) return { bars: buckets, complete: true, source: "hst" };
      cursor = page.next;
    }
  };
  const first = async () => {
    const oldest = (await fillFile.span())?.first;
    return oldest === undefined ? null : bucketStart(oldest, period, offset);
  };
  return { first, last: async () => (await before(undefined, 1)).bars[0] ?? null, before };
}

/** The own file's bars older than `from`, then the fill file's from there on. */
function filled(own: HstSource, fill: RollupSource, from: number): HstSource {
  return {
    first: own.first,
    last: fill.last,
    before: async (before, limit) => {
      if (before !== undefined && before <= from) return own.before(before, limit);
      const recent = await fill.before(before, limit, from);
      if (!recent.complete) return recent;
      const rest = await own.before(from, limit - recent.bars.length);
      return { bars: [...rest.bars, ...recent.bars], complete: rest.complete, source: "hst" };
    },
  };
}

/** Saved history alone. */
function savedSource(read: (before: number | undefined, limit: number) => Promise<{ bars: Candle[]; complete: boolean }>): BarSource {
  return {
    last: async () => (await read(undefined, 1)).bars[0] ?? null,
    before: async (before, limit) => {
      const page = await read(before, limit);
      return { bars: page.bars.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })), complete: page.complete, source: "saved" };
    },
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

/** The base's bars, continued by the saved ones newer than its last bar; those replace its last bar when they hold it. */
function continuedBySaved(base: BarSource, saved: BarSource): BarSource {
  /** The base's last bar's start when saved bars reach later, else null. */
  const from = async () => {
    const [last, savedLast] = await Promise.all([base.last(), saved.last()]);
    return last && savedLast && savedLast.time > last.time ? last.time : null;
  };
  return {
    last: async () => ((await from()) === null ? base.last() : saved.last()),
    before: async (before, limit) => {
      const start = await from();
      if (start === null || (before !== undefined && before <= start)) return base.before(before, limit);
      const page = await saved.before(before, limit);
      const recent = page.bars.filter((b) => b.time >= start);
      if (recent.length >= limit || (recent.length === page.bars.length && !page.complete)) return { bars: recent.slice(-limit), complete: false, source: "saved" };
      const rest = await base.before(recent[0]?.time === start ? start : start + 1, limit - recent.length);
      return { bars: [...rest.bars, ...recent], complete: rest.complete, source: rest.bars.length ? rest.source : "saved" };
    },
  };
}

/** Fill file bars, oldest first, into the period's buckets, `offset` seconds late. */
function rollUp(bars: readonly HstBar[], period: Period, offset: number): Candle[] {
  const out: Candle[] = [];
  for (const bar of bars) {
    const time = bucketStart(bar.time, period, offset);
    const last = out.at(-1);
    if (last?.time === time) out[out.length - 1] = combine(last, bar);
    else out.push({ time, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
  }
  return out;
}

/**
 * The offset most of the bars start at, the newest's among equals: a broker labels a few odd ones (EasyForex's
 * Sunday-evening H4 bar starts at 21:10).
 */
function commonOffset(bars: readonly Candle[], period: Period): number {
  const counts = new Map<number, number>();
  let best = 0;
  for (const bar of bars) {
    const offset = barOffset(bar.time, period);
    const count = (counts.get(offset) ?? 0) + 1;
    counts.set(offset, count);
    if (count >= (counts.get(best) ?? 0)) best = offset;
  }
  return best;
}

/** One bar from an earlier part of a bucket and a later one: the earlier open, the later close. */
function combine(earlier: Candle, later: Candle): Candle {
  return { time: earlier.time, open: earlier.open, high: Math.max(earlier.high, later.high), low: Math.min(earlier.low, later.low), close: later.close };
}
