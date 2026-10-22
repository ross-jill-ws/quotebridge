// The History page's view model (pure): a group per market (its terminals and recording state) with a row per period:
// what the terminal's HST file holds and what the app has saved, on the clock the Time shown setting chooses, and the
// period's CSV and HST downloads. The search keeps markets whose symbol or broker server contains it.
import type { HistoryMarket, HistorySpan } from "../../server/history/index.js";
import { isIntraday, type Period } from "../../shared/periods.js";
import type { TimeShown } from "../../shared/settings-store.js";
import { displaySeconds, type DisplayClock } from "../display-clock.js";
import { count, minuteStamp } from "../format.js";

/** What a period holds, as shown: "1,250 bars" and "2026-11-24 09:00 to 2027-01-15 10:00" (or one time for one bar). */
export type SpanText = { bars: string; range: string };

export type HistoryRow = {
  period: Period;
  /** Null when there is none. */
  hst: SpanText | null;
  saved: SpanText | null;
  csvUrl: string;
  hstUrl: string;
};

export type HistoryGroup = {
  key: string;
  /** For the group's heading: the market key with only letters and digits. */
  id: string;
  symbol: string;
  /** "EasyForex-Demo · EasyForex MT4", or "… · no terminal on this server". */
  where: string;
  /** "Recording" or "Not recorded". */
  state: string;
  rows: HistoryRow[];
  /** Shown instead of rows when the market has no history; null when it has. */
  empty: string | null;
};

export type HistoryOptions = { shown: TimeShown; query: string; localOffsetMinutes: DisplayClock["localOffsetMinutes"] };

export function historyGroups(markets: readonly HistoryMarket[], { shown, query, localOffsetMinutes }: HistoryOptions): HistoryGroup[] {
  const needle = query.trim().toLowerCase();
  return markets
    .filter((m) => !needle || m.symbol.toLowerCase().includes(needle) || m.brokerServer.toLowerCase().includes(needle))
    .map((m) => {
      const clock: DisplayClock = { shown, rule: m.clockRule, localOffsetMinutes };
      const download = (format: "csv" | "hst", period: Period) => `/api/history/${format}?market=${encodeURIComponent(m.market)}&period=${period}`;
      const terminals = m.terminals.map((t) => t.name).join(", ") || "no terminal on this server";
      return {
        key: m.market,
        id: `history-${m.market.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
        symbol: m.symbol,
        where: `${m.brokerServer} · ${terminals}`,
        state: m.recording ? "Recording" : "Not recorded",
        rows: m.periods.map((p) => ({
          period: p.period,
          hst: spanText(p.hst, p.period, clock),
          saved: spanText(p.saved, p.period, clock),
          csvUrl: download("csv", p.period),
          hstUrl: download("hst", p.period),
        })),
        empty: m.periods.length ? null : "No history on this computer yet.",
      };
    });
}

/** Daily and longer bars start at broker midnight: their dates are enough. */
function spanText(s: HistorySpan | null, period: Period, clock: DisplayClock): SpanText | null {
  if (!s) return null;
  const when = (utcSeconds: number) => minuteStamp(displaySeconds(clock, utcSeconds)).slice(0, isIntraday(period) ? 16 : 10);
  return { bars: `${count(s.bars)} ${s.bars === 1 ? "bar" : "bars"}`, range: s.first === s.last ? when(s.first) : `${when(s.first)} to ${when(s.last)}` };
}
