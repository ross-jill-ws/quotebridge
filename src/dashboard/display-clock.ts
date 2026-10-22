// The display clock (pure): the server hands out UTC, and the dashboard shows it in the clock the Time shown setting
// chooses (ADR 11). Lightweight Charts has no time zones, so the chart is given times shifted to that clock: seconds
// read as if they were UTC.
import { utcToBroker, type ClockRule } from "../shared/clock.js";
import type { TimeShown } from "../shared/settings-store.js";

export type DisplayClock = {
  shown: TimeShown;
  /** The broker server's clock rule; null while unknown, when the server's UTC times are its broker times. */
  rule: ClockRule | null;
  /** This computer's local time minus UTC at an instant, in minutes. */
  localOffsetMinutes: (utcMs: number) => number;
};

/** This computer's offset, from the browser's time zone. */
export const browserOffsetMinutes = (utcMs: number) => -new Date(utcMs).getTimezoneOffset();

/** A UTC instant in seconds, as seconds of the display clock. */
export function displaySeconds(clock: DisplayClock, utcSeconds: number): number {
  const ms = utcSeconds * 1000;
  if (clock.shown === "utc") return utcSeconds;
  if (clock.shown === "local") return utcSeconds + clock.localOffsetMinutes(ms) * 60;
  return clock.rule ? utcToBroker(clock.rule, ms) / 1000 : utcSeconds;
}

/**
 * Candles with their times on the display clock. A chart needs ascending times: in the hour a local clock repeats
 * when it falls back, a bar that would not come after the one before is placed a second after it.
 */
export function displayCandles<C extends { time: number }>(candles: readonly C[], clock: DisplayClock): C[] {
  let previous = -Infinity;
  return candles.map((c) => {
    const time = Math.max(displaySeconds(clock, c.time), previous + 1);
    previous = time;
    return { ...c, time };
  });
}

const LABELS: Record<TimeShown, string> = { broker: "Broker time", local: "Local time", utc: "UTC" };

export function clockLabel(shown: TimeShown): string {
  return LABELS[shown];
}
