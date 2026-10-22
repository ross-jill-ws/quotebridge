// The Charts view's model (pure): the legend at the crosshair or the latest bar, the forming candle that
// follows the live quote, day separators, what the view remembers, and since when it has candles.
import type { Candle } from "../../server/candles/index.js";
import { bucketStart, isIntraday, PERIODS, type Period } from "../../shared/periods.js";
import { PALETTE_SIZE, type IndicatorSpec } from "./indicators.js";

const NONE = "—";

/** One indicator's line, with a value per candle. */
export type IndicatorLine = { id: string; label: string; colour: string; digits: number; values: readonly (number | undefined)[] };

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
  ohlc: { label: "O" | "H" | "L" | "C"; value: string }[];
  indicators: { id: string; label: string; colour: string; value: string }[];
};

export function chartLegend({ symbol, period, digits, candles, indicators, time }: LegendInput): Legend {
  let index = time === undefined ? -1 : candles.findIndex((c) => c.time === time);
  if (index < 0) index = candles.length - 1;
  const bar = candles[index];
  const price = (value: number | undefined, places: number) => (value === undefined ? NONE : value.toFixed(places));
  return {
    title: `${symbol}, ${period}`,
    ohlc: (["open", "high", "low", "close"] as const).map((key) => ({ label: key[0].toUpperCase() as "O", value: price(bar?.[key], digits) })),
    indicators: indicators.map(({ id, label, colour, digits: places, values }) => ({ id, label, colour, value: price(values[index], places) })),
  };
}

/**
 * The candles after a live quote: it moves the forming candle, or opens a new one when it falls in a later
 * bucket (`newBucket`: the view fetches the list again, which also settles the candle just closed).
 * An older quote leaves the same list.
 */
export function followQuote(candles: readonly Candle[], period: Period, quote: { bid: number; quoteTime: number }): { candles: readonly Candle[]; newBucket: boolean } {
  const time = bucketStart(quote.quoteTime, period);
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

export const MAX_INDICATOR_PERIOD = 500;

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
    indicators: Array.isArray(stored.indicators) ? stored.indicators.filter(isIndicator) : [],
  };
}

export function isIndicatorPeriod(period: unknown): period is number {
  return typeof period === "number" && Number.isInteger(period) && period >= 1 && period <= MAX_INDICATOR_PERIOD;
}

function isIndicator(value: unknown): value is IndicatorSpec {
  if (typeof value !== "object" || value === null) return false;
  const i = value as Record<string, unknown>;
  if (typeof i.id !== "string" || !(typeof i.colour === "number" && Number.isInteger(i.colour) && i.colour >= 0 && i.colour < PALETTE_SIZE)) return false;
  if (!isIndicatorPeriod(i.period)) return false;
  return i.kind === "rsi" || (i.kind === "ma" && (i.type === "simple" || i.type === "exponential"));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Candles are built in memory from the app's start (`since`, epoch ms), in this computer's clock: the chart's own times are broker time. */
export function candlesSince(since: number, now: number): string {
  const start = new Date(since);
  const pad = (n: number) => String(n).padStart(2, "0");
  const clock = `${pad(start.getHours())}:${pad(start.getMinutes())}`;
  const sameDay = start.toDateString() === new Date(now).toDateString();
  const when = sameDay ? clock : `${start.getDate()} ${MONTHS[start.getMonth()]} ${clock}`;
  return `Candles since ${when} (this computer's clock), when QuoteBridge started. Recording arrives in a later version.`;
}
