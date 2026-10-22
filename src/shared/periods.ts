// Chart periods and their buckets, shared by the server's candle builder and the Charts view's forming candle.
// Times are seconds of broker server time, read as if they were UTC (no time-zone conversion).

/** Chart periods in MetaTrader's order. */
export const PERIODS = ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN1"] as const;
export type Period = (typeof PERIODS)[number];

const DAY = 86400;
const PERIOD_SECONDS: Record<Exclude<Period, "W1" | "MN1">, number> = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: DAY };

/** Periods shorter than a day, which get day separators. */
export function isIntraday(period: Period): boolean {
  return period !== "D1" && period !== "W1" && period !== "MN1";
}

/** The start of the period bucket holding `time`: W1 starts on Monday 00:00, MN1 on the 1st of the calendar month. */
export function bucketStart(time: number, period: Period): number {
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
