// Chart periods and their buckets, shared by the server's candle builder and the Charts view's forming candle.
// Times are seconds of the broker clock, read as if they were UTC: candles break on the broker clock, as MetaTrader's do.

/** Chart periods in MetaTrader's order. */
export const PERIODS = ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN1"] as const;
export type Period = (typeof PERIODS)[number];

const DAY = 86400;
const PERIOD_SECONDS: Record<Exclude<Period, "W1" | "MN1">, number> = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: DAY };

/** Periods shorter than a day, which get day separators. */
export function isIntraday(period: Period): boolean {
  return period !== "D1" && period !== "W1" && period !== "MN1";
}

/**
 * The start of the period bucket holding `time`: MN1 starts on the 1st of the calendar month. A W1 bar is dated Sunday
 * 00:00 and holds Monday to the next Sunday, as MetaTrader's HST files do: a broker's Sunday session counts in the week
 * that is closing.
 */
export function bucketStart(time: number, period: Period): number {
  if (period === "W1") {
    const day = time - (time % DAY) - DAY;
    // 1 January 1970 was a Thursday: four days after a Sunday.
    return day - ((day / DAY + 4) % 7) * DAY;
  }
  if (period === "MN1") {
    const date = new Date(time * 1000);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000;
  }
  return time - (time % PERIOD_SECONDS[period]);
}

/** Bars per page of chart history and REST's default count: MetaTrader's default, and what the EA sends. */
export const PAGE_BARS = 900;
