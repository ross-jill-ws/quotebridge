// Indicator maths for the Charts view (pure): one value per bar, undefined until there are enough bars,
// so nothing wrong is ever drawn. RSI uses Wilder's smoothing, as MetaTrader's RSI does.

export type AverageType = "simple" | "exponential";

/** The `period`-bar moving average of `closes`. An exponential average starts from the simple average of its first `period` closes. */
export function movingAverage(closes: readonly number[], period: number, type: AverageType): (number | undefined)[] {
  const out: (number | undefined)[] = Array(closes.length).fill(undefined);
  if (period < 1 || closes.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  out[period - 1] = sum / period;
  const k = 2 / (period + 1);
  for (let i = period; i < closes.length; i++) {
    if (type === "simple") {
      sum += closes[i] - closes[i - period];
      out[i] = sum / period;
    } else {
      out[i] = closes[i] * k + out[i - 1]! * (1 - k);
    }
  }
  return out;
}

/**
 * The `period`-bar RSI (0–100): the first average gain and loss are the means of the first `period` changes,
 * then each is smoothed as (previous·(period−1) + current)/period. 100 when there were no losses, 50 when
 * the price never moved.
 */
export function rsi(closes: readonly number[], period: number): (number | undefined)[] {
  const out: (number | undefined)[] = Array(closes.length).fill(undefined);
  if (period < 1 || closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const up = Math.max(change, 0);
    const down = Math.max(-change, 0);
    if (i <= period) {
      gain += up / period;
      loss += down / period;
      if (i < period) continue;
    } else {
      gain = (gain * (period - 1) + up) / period;
      loss = (loss * (period - 1) + down) / period;
    }
    out[i] = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/** An indicator on the chart: Moving average on the price pane, RSI in its own pane. `colour` indexes the series palette. */
export type IndicatorSpec = { id: string; colour: number } & IndicatorSettings;
export type IndicatorSettings = { kind: "ma"; period: number; type: AverageType } | { kind: "rsi"; period: number };

export const DEFAULT_INDICATORS: Record<IndicatorSettings["kind"], IndicatorSettings> = {
  ma: { kind: "ma", period: 20, type: "simple" },
  rsi: { kind: "rsi", period: 14 },
};

/** "SMA 20", "EMA 50", "RSI 14". */
export function indicatorLabel(settings: IndicatorSettings): string {
  if (settings.kind === "rsi") return `RSI ${settings.period}`;
  return `${settings.type === "simple" ? "SMA" : "EMA"} ${settings.period}`;
}

/** The indicator's value at each bar of `closes`. */
export function indicatorValues(settings: IndicatorSettings, closes: readonly number[]): (number | undefined)[] {
  return settings.kind === "rsi" ? rsi(closes, settings.period) : movingAverage(closes, settings.period, settings.type);
}

/** The palette has four colours. */
export const PALETTE_SIZE = 4;

/** The palette colour for a new indicator: the least used, first in palette order. */
export function nextColour(indicators: readonly { colour: number }[]): number {
  const uses = Array<number>(PALETTE_SIZE).fill(0);
  for (const i of indicators) uses[i.colour % PALETTE_SIZE]++;
  return uses.indexOf(Math.min(...uses));
}
