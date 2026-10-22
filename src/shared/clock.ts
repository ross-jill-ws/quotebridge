// Broker clocks (ADR 11): a broker server's clock rule gives its offset from UTC at any moment, past or present.
// Pure; shared by the server (stored UTC times, candle starts) and the dashboard (the Terminals panel, display).

/** The daylight-saving convention: none, US dates (New York) or EU dates. */
export type DaylightSaving = "none" | "us" | "eu";

/** A winter offset from UTC plus a daylight-saving convention; summer adds an hour. */
export type ClockRule = { winterOffsetMinutes: number; dst: DaylightSaving };

/** The rule assumed while a broker server's rule is unknown: its broker clock is read as UTC. */
export const UNKNOWN_RULE: ClockRule = Object.freeze({ winterOffsetMinutes: 0, dst: "none" });

export const DAYLIGHT_SAVINGS: readonly DaylightSaving[] = ["none", "us", "eu"];

/** The offsets a rule may have, in minutes: −12:00 to +14:00 in 15-minute steps. */
export const MIN_OFFSET_MINUTES = -12 * 60;
export const MAX_OFFSET_MINUTES = 14 * 60;
export const OFFSET_STEP_MINUTES = 15;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The UTC instant of the nth Sunday (or the last, n = -1) of a month at `hour` UTC. */
function sunday(year: number, month: number, n: number, hour: number): number {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
    return Date.UTC(year, month, 1 + ((7 - first) % 7) + (n - 1) * 7, hour);
  }
  const lastDay = new Date(Date.UTC(year, month + 1, 0));
  return Date.UTC(year, month, lastDay.getUTCDate() - lastDay.getUTCDay(), hour);
}

/** When summer time starts and ends in a year, as UTC instants. */
function summer(dst: Exclude<DaylightSaving, "none">, year: number): [number, number] {
  // US: 02:00 New York time, which is 07:00 UTC in March (EST) and 06:00 UTC in November (EDT).
  if (dst === "us") return [sunday(year, 2, 2, 7), sunday(year, 10, 1, 6)];
  return [sunday(year, 2, -1, 1), sunday(year, 9, -1, 1)];
}

/** The rule's offset from UTC at a UTC instant, in minutes. */
export function offsetAtUtc(rule: ClockRule, utcMs: number): number {
  if (rule.dst === "none") return rule.winterOffsetMinutes;
  const [start, end] = summer(rule.dst, new Date(utcMs).getUTCFullYear());
  return rule.winterOffsetMinutes + (utcMs >= start && utcMs < end ? 60 : 0);
}

/**
 * The rule's offset at a broker-clock instant (broker milliseconds read as if UTC), in minutes. Broker times in the hour
 * a switch skips or repeats resolve to the earlier offset: winter in spring, summer in autumn.
 */
export function offsetAtBroker(rule: ClockRule, brokerMs: number): number {
  const winter = rule.winterOffsetMinutes;
  if (rule.dst === "none") return winter;
  const summerOffset = winter + 60;
  const winterFits = offsetAtUtc(rule, brokerMs - winter * MINUTE) === winter;
  const summerFits = offsetAtUtc(rule, brokerMs - summerOffset * MINUTE) === summerOffset;
  if (winterFits !== summerFits) return winterFits ? winter : summerOffset;
  // Both fit: the repeated hour in autumn, after summer. Neither: the skipped hour in spring, after winter.
  // Which season came before is the season an hour earlier.
  return offsetAtUtc(rule, brokerMs - winter * MINUTE - HOUR);
}

/**
 * The rule's summers from `fromYear` to `toYear` as broker-clock intervals [from, to) in milliseconds: a broker time
 * inside one has the summer offset, any other the winter offset (the skipped hour counts as winter, the repeated hour
 * as summer, as in offsetAtBroker). Lets stored rows be converted in bulk, e.g. in SQL.
 */
export function brokerSummers(rule: ClockRule, fromYear: number, toYear: number): [number, number][] {
  if (rule.dst === "none") return [];
  const shift = (rule.winterOffsetMinutes + 60) * MINUTE;
  const out: [number, number][] = [];
  for (let year = fromYear; year <= toYear; year++) {
    const [start, end] = summer(rule.dst, year);
    out.push([start + shift, end + shift]);
  }
  return out;
}

export function utcToBroker(rule: ClockRule, utcMs: number): number {
  return utcMs + offsetAtUtc(rule, utcMs) * MINUTE;
}

export function brokerToUtc(rule: ClockRule, brokerMs: number): number {
  return brokerMs - offsetAtBroker(rule, brokerMs) * MINUTE;
}

/** The rule a first observed offset implies: +2 or +3 is GMT+2 on US dates (the New York close), anything else fixed. */
export function inferRule(offsetMinutes: number): ClockRule {
  if (offsetMinutes === 120 || offsetMinutes === 180) return { winterOffsetMinutes: 120, dst: "us" };
  return { winterOffsetMinutes: offsetMinutes, dst: "none" };
}

/** Whether a value is a clock rule the trader may set. */
export function isClockRule(value: unknown): value is ClockRule {
  const rule = value as Partial<ClockRule> | null;
  const offset = rule?.winterOffsetMinutes;
  return (
    typeof offset === "number" &&
    Number.isInteger(offset) &&
    offset >= MIN_OFFSET_MINUTES &&
    offset <= MAX_OFFSET_MINUTES &&
    offset % OFFSET_STEP_MINUTES === 0 &&
    DAYLIGHT_SAVINGS.includes(rule!.dst as DaylightSaving)
  );
}

/** "GMT+2", "GMT+5:30", "GMT−3:30", "GMT+0". */
export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "−" : "+";
  const abs = Math.abs(minutes);
  const m = abs % 60;
  return `GMT${sign}${Math.floor(abs / 60)}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

/** "GMT+2, GMT+3 in US summer time", "GMT+5:30, no daylight saving". */
export function describeRule(rule: ClockRule): string {
  const winter = formatOffset(rule.winterOffsetMinutes);
  if (rule.dst === "none") return `${winter}, no daylight saving`;
  return `${winter}, ${formatOffset(rule.winterOffsetMinutes + 60)} in ${rule.dst.toUpperCase()} summer time`;
}
