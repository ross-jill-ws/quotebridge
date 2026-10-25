// The Charts view's model (pure): the legend at the crosshair or the latest bar, the forming candle that
// follows the live quote, day separators, paging back through the chart history, where the view goes when bars come
// in, what the view remembers (Milestone 2's indicators read as their packages), and since when it has candles.
import type { Candle } from "../../server/candles/index.js";
import { brokerToUtc, UNKNOWN_RULE, type ClockRule } from "../../shared/clock.js";
import { bucketStart, isIntraday, PAGE_BARS, PERIODS, type Period } from "../../shared/periods.js";
import { minuteStamp } from "../format.js";
import { fromMilestone2, isIndicatorSpec, MAX_INDICATORS, type IndicatorSpec } from "./indicators.js";

const NONE = "—";

/**
 * One indicator's legend row: each output with its colour and a value per candle (a label when there are several),
 * a histogram's colour per candle where its bars differ, and a two-colour histogram's two `tones`; `failed`: why
 * its last computation failed (the values are the last good ones); `notAvailable`: its package is disabled or gone.
 */
export type IndicatorLine = {
  id: string;
  label: string;
  digits: number;
  outputs: readonly IndicatorLineOutput[];
  failed?: string;
  notAvailable?: true;
};

export type IndicatorLineOutput = {
  id: string;
  label?: string;
  colour: string;
  colours?: readonly (string | undefined)[];
  values: readonly (number | undefined)[];
  tones?: Tones;
};

/** A two-colour histogram's rising and falling colours. */
export type Tones = { rising: string; falling: string };

export type LegendInput = {
  symbol: string;
  period: Period;
  digits: number;
  candles: readonly Candle[];
  indicators: readonly IndicatorLine[];
  /** The crosshair's bar time; without it (or without a bar there), the latest bar. */
  time?: number;
};

export type Legend = {
  /** "AUDUSD.a, H1", as MetaTrader titles a chart. */
  title: string;
  /** The bar's time on the chart's clock: "2027-01-15 10:00", or the date alone for D1 and longer; empty without a bar. */
  time: string;
  ohlc: { label: "O" | "H" | "L" | "C"; value: string }[];
  /** Each value in its output's colour, a histogram's in its bar's. */
  indicators: { id: string; label: string; outputs: { id: string; label?: string; colour: string; value: string; tones?: Tones }[]; failed?: string; notAvailable?: true }[];
};

export function chartLegend({ symbol, period, digits, candles, indicators, time }: LegendInput): Legend {
  let index = time === undefined ? -1 : candles.findIndex((c) => c.time === time);
  if (index < 0) index = candles.length - 1;
  const bar = candles[index];
  const price = (value: number | undefined, places: number) => (value === undefined ? NONE : value.toFixed(places));
  const stamp = bar ? minuteStamp(bar.time) : "";
  return {
    title: `${symbol}, ${period}`,
    time: isIntraday(period) ? stamp : stamp.slice(0, 10),
    ohlc: (["open", "high", "low", "close"] as const).map((key) => ({ label: key[0].toUpperCase() as "O", value: price(bar?.[key], digits) })),
    indicators: indicators.map(({ id, label, digits: places, outputs, failed, notAvailable }) => ({
      id,
      label,
      outputs: outputs.map((o) => ({
        id: o.id,
        ...(o.label === undefined ? {} : { label: o.label }),
        colour: o.colours?.[index] ?? o.colour,
        value: price(o.values[index], places),
        ...(o.tones ? { tones: o.tones } : {}),
      })),
      ...(failed === undefined ? {} : { failed }),
      ...(notAvailable ? { notAvailable } : {}),
    })),
  };
}

/**
 * The candles (UTC times) after a live quote (broker time): it moves the forming candle, or opens a new one when it
 * falls in a later bucket of the broker clock (`newBucket`: the view fetches the list again, which also settles the
 * candle just closed). An older quote leaves the same list. `rule` is the broker server's, null while unknown;
 * `offset` is the page's, as bucketStart's (CMC's GOLD H4 buckets start at 01:00).
 */
export function followQuote(
  candles: readonly Candle[],
  period: Period,
  quote: { bid: number; quoteTime: number },
  rule: ClockRule | null = null,
  offset = 0,
): { candles: readonly Candle[]; newBucket: boolean } {
  const time = brokerToUtc(rule ?? UNKNOWN_RULE, bucketStart(quote.quoteTime, period, offset) * 1000) / 1000;
  const last = candles.at(-1);
  const { bid } = quote;
  if (last && time < last.time) return { candles, newBucket: false };
  if (last?.time === time) {
    return { candles: [...candles.slice(0, -1), { ...last, high: Math.max(last.high, bid), low: Math.min(last.low, bid), close: bid }], newBucket: false };
  }
  return { candles: [...candles, { time, open: bid, high: bid, low: bid, close: bid }], newBucket: true };
}

const DAY = 86400;

/** On intraday periods, the time of each bar that opens a new day (after the first bar). */
export function daySeparators(candles: readonly Candle[], period: Period): number[] {
  if (!isIntraday(period)) return [];
  const out: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    if (Math.floor(candles[i].time / DAY) !== Math.floor(candles[i - 1].time / DAY)) out.push(candles[i].time);
  }
  return out;
}

export const CHART_TYPES = ["bars", "candles", "line"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

/** What the Charts view keeps in localStorage. `feed` is absent until a symbol is chosen. */
export type ChartMemory = { feed?: string; period: Period; type: ChartType; askLine: boolean; indicators: IndicatorSpec[] };

/** The stored view, with anything that cannot work read as its default. */
export function readChartMemory(text: string | null): ChartMemory {
  let stored: Record<string, unknown> = {};
  try {
    const parsed: unknown = text === null ? {} : JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) stored = parsed as Record<string, unknown>;
  } catch {
    // Read as the defaults.
  }
  return {
    ...(typeof stored.feed === "string" ? { feed: stored.feed } : {}),
    period: (PERIODS as readonly unknown[]).includes(stored.period) ? (stored.period as Period) : "M1",
    type: (CHART_TYPES as readonly unknown[]).includes(stored.type) ? (stored.type as ChartType) : "candles",
    askLine: typeof stored.askLine === "boolean" ? stored.askLine : false,
    indicators: Array.isArray(stored.indicators) ? stored.indicators.flatMap(readIndicator).slice(0, MAX_INDICATORS) : [],
  };
}

/** The packages the chart's indicators use, once each, sorted. */
export function chartPackages(memory: Pick<ChartMemory, "indicators">): string[] {
  return [...new Set(memory.indicators.map((i) => i.package))].sort();
}

/** A remembered indicator: a package's, or Milestone 2's read as its package; none when it cannot work. */
function readIndicator(value: unknown): IndicatorSpec[] {
  if (isIndicatorSpec(value)) return [value];
  const converted = typeof value === "object" && value !== null && "kind" in value ? fromMilestone2(value as Record<string, unknown>) : undefined;
  return converted ? [converted] : [];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Live candles are built in memory from the app's start (`since`, epoch ms), given in this computer's clock. */
export function candlesSince(since: number, now: number): string {
  const start = new Date(since);
  const pad = (n: number) => String(n).padStart(2, "0");
  const clock = `${pad(start.getHours())}:${pad(start.getMinutes())}`;
  const sameDay = start.toDateString() === new Date(now).toDateString();
  const when = sameDay ? clock : `${start.getDate()} ${MONTHS[start.getMonth()]} ${clock}`;
  return `Candles since ${when} (this computer's clock), when QuoteBridge started.`;
}

/** Older bars are fetched when fewer than this many remain left of the visible range. */
export const OLDER_WHEN_FEWER_THAN = 100;
export { PAGE_BARS };

/** `fromIndex`: the logical index of the leftmost visible bar (negative past the first bar). */
export function wantsOlder(fromIndex: number, complete: boolean): boolean {
  return !complete && fromIndex < OLDER_WHEN_FEWER_THAN;
}

/** Older bars before the loaded ones; any the chart already has are left out. */
export function prependOlder(candles: readonly Candle[], older: readonly Candle[]): Candle[] {
  const first = candles[0]?.time ?? Infinity;
  return [...older.filter((c) => c.time < first), ...candles];
}

/**
 * A fresh latest page: it replaces the loaded bars from its first bar on; the older ones scrolled back to stay, and
 * with them whether older still exist.
 */
export function mergeLatest<P extends { candles: Candle[]; complete: boolean }>(loaded: { candles: readonly Candle[]; complete: boolean }, page: P): P {
  const first = page.candles[0]?.time;
  const older = first === undefined ? [] : loaded.candles.filter((c) => c.time < first);
  return older.length ? { ...page, candles: [...older, ...page.candles], complete: loaded.complete } : page;
}

/** Empty bars kept right of the newest one. */
export const RIGHT_OFFSET = 6;

/** A visible range of logical (bar index) positions. */
export type LogicalRange = { from: number; to: number };

/**
 * The view at the latest bars, as wide as `range`, with the usual room after the newest (a view of a few bars has
 * more); "latest" when the chart has no range yet (it scrolls to real time).
 */
export function latestView(count: number, range: LogicalRange | null): LogicalRange | "latest" {
  if (!range) return "latest";
  const end = count - 1 + RIGHT_OFFSET;
  return { from: end - (range.to - range.from), to: end };
}

/**
 * Where the view goes when the candles are set again (not updated in place), or null to leave it. Older bars put
 * before the loaded ones fill a view that showed every bar it had (the EA's bars joining a few live candles; a new
 * bucket may have opened meanwhile): it moves to the latest bars. Bars prepended to a view scrolled back (the newest
 * bar unchanged) move every loaded bar's logical index on by as many: the view moves with them.
 */
export function viewAfterSet(old: readonly Candle[], candles: readonly Candle[], range: LogicalRange | null): LogicalRange | "latest" | null {
  const n = old.length;
  if (!(n > 0 && candles.length > n && candles[0].time < old[0].time)) return null;  if (range === null || (range.from <= 0 && range.to >= n - 1)) return latestView(candles.length, range);
  if (candles.at(-1)!.time !== old[n - 1].time) return null;
  const prepended = candles.length - n;
  return { from: range.from + prepended, to: range.to + prepended };
}

/** The note shows while the chart does not reach back before QuoteBridge started (`since`, epoch ms). */
export function showsCandlesSince(candles: readonly Candle[], since: number): boolean {
  return !candles.length || candles[0].time * 1000 >= since;
}
