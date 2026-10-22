// The History page's catalog: every market the app knows (its feeds, recorded markets, and the symbols in the HST
// folders of the terminals logged into a broker server), with each period's HST file and saved bars. A period's HST
// comes from whichever terminal on that broker server holds the newest bar. Times are handed out in UTC (ADR 11).
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { brokerToUtc, UNKNOWN_RULE, type ClockRule } from "../../shared/clock.js";
import { PERIODS, type Period } from "../../shared/periods.js";
import { marketKey, type BridgeSnapshot, type Market } from "../bridge/index.js";
import { PERIOD_MINUTES } from "./chart-history.js";
import { HstFile, hstPath, type HstBar } from "./hst-file.js";

/** What a period holds: a bar count and the first and last bar's start (UTC seconds; broker seconds while read). */
export type HistorySpan = { bars: number; first: number; last: number };

export type HistoryPeriod = { period: Period; hst: HistorySpan | null; saved: HistorySpan | null };

export type HistoryMarket = {
  /** The market's key, as the downloads take it: `["<broker server>","<symbol>"]`. */
  market: string;
  brokerServer: string;
  symbol: string;
  digits: number | null;
  /** The terminals logged into the broker server. */
  terminals: { terminalId: string; name: string }[];
  recording: boolean;
  clockRule: ClockRule | null;
  /** Periods with an HST file or saved bars, in MetaTrader's order. */
  periods: HistoryPeriod[];
};

/** A download: everything available for a market's period, oldest first, in broker seconds, a page at a time. */
export type HistoryDownload = { digits: number; clockRule: ClockRule | null; pages: AsyncIterable<HstBar[]> };

export type HistoryCatalogOptions = {
  snapshot: () => BridgeSnapshot;
  /** A terminal's data folder, where its HST files are; undefined when unknown. */
  dataFolder: (terminalId: string) => string | undefined;
  /** A terminal's name as the Terminals view shows it; undefined when unknown. */
  terminalName: (terminalId: string) => string | undefined;
  clockRule: (brokerServer: string) => ClockRule | null;
  /** Markets the app has stored (recorded or once recorded). */
  storedMarkets: () => KnownMarket[];
  isRecording: (market: Market) => boolean;
};

type KnownMarket = Market & { digits: number | null };

/** A period's HST file, with what it holds in broker seconds. */
type PeriodFile = { file: HstFile; span: HistorySpan };

const PERIOD_BY_MINUTES = new Map(PERIODS.map((p) => [PERIOD_MINUTES[p], p]));

export class HistoryCatalog {
  constructor(private readonly options: HistoryCatalogOptions) {}

  async list(): Promise<HistoryMarket[]> {
    const snapshot = this.options.snapshot();
    const servers = terminalsByServer(snapshot);
    const markets = new Map<string, KnownMarket>();
    const add = (m: Market, digits: number | null) => {
      const known = markets.get(marketKey(m));
      if (!known) markets.set(marketKey(m), { brokerServer: m.brokerServer, symbol: m.symbol, digits });
      else if (known.digits === null) known.digits = digits;
    };
    for (const feed of snapshot.feeds) add(feed.market, feed.digits);
    for (const m of this.options.storedMarkets()) add(m, m.digits);
    const files = new Map<string, Map<Period, PeriodFile>>();
    for (const [brokerServer, terminals] of servers) {
      for (const [symbol, periods] of await this.scan(brokerServer, terminals)) {
        add({ brokerServer, symbol }, [...periods.values()][0]?.file.header.digits ?? null);
        files.set(marketKey({ brokerServer, symbol }), periods);
      }
    }
    return [...markets.values()]
      .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.brokerServer.localeCompare(b.brokerServer))
      .map((m) => {
        const rule = this.options.clockRule(m.brokerServer);
        const toUtc = (seconds: number) => brokerToUtc(rule ?? UNKNOWN_RULE, seconds * 1000) / 1000;
        const found = files.get(marketKey(m));
        return {
          market: marketKey(m),
          brokerServer: m.brokerServer,
          symbol: m.symbol,
          digits: m.digits,
          terminals: (servers.get(m.brokerServer) ?? []).map((terminalId) => ({ terminalId, name: this.options.terminalName(terminalId) ?? terminalId })),
          recording: this.options.isRecording(m),
          clockRule: rule,
          periods: PERIODS.flatMap((period) => {
            const span = found?.get(period)?.span;
            return span ? [{ period, hst: { bars: span.bars, first: toUtc(span.first), last: toUtc(span.last) }, saved: null }] : [];
          }),
        };
      });
  }

  /** Everything available for a market's period, or null when nothing is. */
  async download(market: Market, period: Period): Promise<HistoryDownload | null> {
    const minutes = PERIOD_MINUTES[period];
    let best: PeriodFile | null = null;
    for (const terminalId of terminalsByServer(this.options.snapshot()).get(market.brokerServer) ?? []) {
      const folder = this.options.dataFolder(terminalId);
      const file = folder ? await HstFile.open(hstPath(folder, market.brokerServer, market.symbol, minutes)) : null;
      const span = file?.header.minutes === minutes ? await file.span() : null;
      if (file && span && newer(span, best)) best = { file, span };
    }
    return best && { digits: best.file.header.digits, clockRule: this.options.clockRule(market.brokerServer), pages: best.file.pages() };
  }

  /** Per symbol, per period: the terminals' HST file holding the newest bar. */
  private async scan(brokerServer: string, terminals: readonly string[]): Promise<Map<string, Map<Period, PeriodFile>>> {
    const out = new Map<string, Map<Period, PeriodFile>>();
    for (const terminalId of terminals) {
      const dataFolder = this.options.dataFolder(terminalId);
      if (!dataFolder) continue;
      const folder = join(dataFolder, "history", brokerServer);
      const names = await readdir(folder).catch(() => [] as string[]);
      for (const name of names.filter((n) => /\.hst$/i.test(n))) {
        const file = await HstFile.open(join(folder, name));
        // The header names the symbol and period: a file name alone is ambiguous ("GER3060": GER30 H1).
        const period = file && PERIOD_BY_MINUTES.get(file.header.minutes);
        if (!file || !period || name.toLowerCase() !== `${file.header.symbol}${file.header.minutes}.hst`.toLowerCase()) continue;
        const span = await file.span();
        if (!span) continue;
        const periods = out.get(file.header.symbol) ?? new Map<Period, PeriodFile>();
        out.set(file.header.symbol, periods);
        if (newer(span, periods.get(period) ?? null)) periods.set(period, { file, span });
      }
    }
    return out;
  }
}

/** The terminals logged into each broker server, as of their latest hello. */
function terminalsByServer(snapshot: BridgeSnapshot): Map<string, string[]> {
  const servers = new Map<string, string[]>();
  for (const t of snapshot.terminals) servers.set(t.brokerServer, [...(servers.get(t.brokerServer) ?? []), t.terminalId]);
  return servers;
}

/** Whether a file holding `span` beats the best so far: a newer last bar, or more bars among equals. */
function newer(span: HistorySpan, best: PeriodFile | null): boolean {
  return !best || span.last > best.span.last || (span.last === best.span.last && span.bars > best.span.bars);
}

export const CSV_HEADER = "time,open,high,low,close,tick_volume,spread,real_volume,time_utc\n";

/**
 * The legacy CSV's rows with a UTC column: `time` is the bar's start on the broker clock ("2027-01-15 10:00:00", as
 * the legacy app wrote it), `time_utc` the same instant in ISO 8601 UTC ("2027-01-15T08:00:00Z"). Prices have the
 * symbol's digits.
 */
export function csvRows(bars: readonly HstBar[], digits: number, clockRule: ClockRule | null): string {
  const rule = clockRule ?? UNKNOWN_RULE;
  return bars
    .map(
      (b) =>
        [
          new Date(b.time * 1000).toISOString().slice(0, 19).replace("T", " "),
          b.open.toFixed(digits),
          b.high.toFixed(digits),
          b.low.toFixed(digits),
          b.close.toFixed(digits),
          b.tickVolume,
          b.spread,
          b.realVolume,
          `${new Date(brokerToUtc(rule, b.time * 1000)).toISOString().slice(0, 19)}Z`,
        ].join(",") + "\n",
    )
    .join("");
}
