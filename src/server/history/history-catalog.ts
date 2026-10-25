// The History page's catalog: every market the app knows (its feeds, recorded markets, and the symbols in the HST
// folders of the terminals logged into a broker server), with each period's HST file and saved bars. A period's HST
// comes from whichever terminal on that broker server holds the newest bar; a download continues into the saved bars
// older than that file's first bar, and into those newer than its last bar (the EA's bars, which replace its last bar
// when they hold it, as it may have been written while forming). Times are handed out in UTC (ADR 11).
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { brokerToUtc, UNKNOWN_RULE, type ClockRule } from "../../shared/clock.js";
import { PERIODS, type Period } from "../../shared/periods.js";
import { marketKey, type BridgeSnapshot, type Market } from "../bridge/index.js";
import { PERIOD_MINUTES, PERIOD_OF } from "./chart-history.js";
import type { SaveProgress } from "./history-saver.js";
import { HstFile, hstPath, type HstBar } from "./hst-file.js";
import type { SavedBarStore } from "./saved-store.js";

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
  /** A queued or running save of its history, or null. */
  saving: SaveProgress | null;
  clockRule: ClockRule | null;
  /** Periods with an HST file or saved bars, in MetaTrader's order. */
  periods: HistoryPeriod[];
};

/**
 * Everything available for a market's period, as the REST API reads it: the HST file holding the newest bar, joined
 * with the saved bars older than its first and newer than its last. `bars`, `first` and `last` describe the whole;
 * times are broker seconds.
 */
export type HistorySeries = HistorySpan & {
  digits: number;
  clockRule: ClockRule | null;
  /** The newest `limit` bars older than `before` (broker seconds; all when not given), oldest first. */
  latest(limit: number, before?: number): Promise<HstBar[]>;
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
  /** Saved history, when the server has a database. */
  saved?: SavedBarStore;
  /** A queued or running save of a market's history, or null. */
  saving?: (market: Market) => SaveProgress | null;
};

type KnownMarket = Market & { digits: number | null };

/** A period's HST file, with what it holds in broker seconds. */
type PeriodFile = { file: HstFile; span: HistorySpan };

/** The saved bars newer than a file's last bar: from `first` on; the file's own bars end before `fileEnd`. */
type NewerSaved = { bars: number; first: number; last: number; fileEnd: number };

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
    const saved = new Map<string, Map<Period, HistorySpan>>();
    for (const s of (await this.options.saved?.spans()) ?? []) {
      add(s, null);
      const periods = saved.get(marketKey(s)) ?? new Map<Period, HistorySpan>();
      saved.set(marketKey(s), periods.set(s.period, { bars: s.bars, first: s.first, last: s.last }));
    }
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
        const savedPeriods = saved.get(marketKey(m));
        return {
          market: marketKey(m),
          brokerServer: m.brokerServer,
          symbol: m.symbol,
          digits: m.digits,
          terminals: (servers.get(m.brokerServer) ?? []).map((terminalId) => ({ terminalId, name: this.options.terminalName(terminalId) ?? terminalId })),
          recording: this.options.isRecording(m),
          saving: this.options.saving?.(m) ?? null,
          clockRule: rule,
          periods: PERIODS.flatMap((period) => {
            const span = found?.get(period)?.span;
            const hst = span ? { bars: span.bars, first: toUtc(span.first), last: toUtc(span.last) } : null;
            const savedSpan = savedPeriods?.get(period) ?? null;
            return hst || savedSpan ? [{ period, hst, saved: savedSpan }] : [];
          }),
        };
      });
  }

  /** Everything available for a market's period, or null when nothing is. */
  async series(market: Market, period: Period): Promise<HistorySeries | null> {
    const best = await this.bestFile(market, period);
    const saved = this.options.saved;
    const older = (await saved?.count(market, period, best?.span.first)) ?? null;
    if (!best && !older) return null;
    const file = best?.file;
    const hstFirst = best?.span.first ?? Infinity;
    const newer = await this.newerSaved(market, period, best);
    const fileBars = best ? best.span.bars - (newer && newer.fileEnd === best.span.last ? 1 : 0) : 0;
    return {
      bars: fileBars + (older?.bars ?? 0) + (newer?.bars ?? 0),
      first: older?.first ?? best!.span.first,
      last: newer?.last ?? best?.span.last ?? older!.last,
      digits: this.digits(market, best),
      clockRule: this.options.clockRule(market.brokerServer),
      latest: async (limit, before = Infinity) => {
        const cut = (end: number | undefined) => (Math.min(end ?? Infinity, before) === Infinity ? undefined : Math.min(end ?? Infinity, before));
        const newest = newer && before > newer.first ? (await saved!.before(market, period, cut(undefined), limit)).bars.filter((b) => b.time >= newer.first) : [];
        const recent = file && newest.length < limit && before > hstFirst ? (await file.before(cut(newer?.fileEnd), limit - newest.length)).bars : [];
        const taken = newest.length + recent.length;
        const rest = older && taken < limit ? (await saved!.before(market, period, cut(best?.span.first), limit - taken)).bars : [];
        return [...rest, ...recent, ...newest];
      },
    };
  }

  /** Everything available for a market's period, or null when nothing is. */
  async download(market: Market, period: Period): Promise<HistoryDownload | null> {
    const best = await this.bestFile(market, period);
    const saved = this.options.saved;
    const savedOlder = saved ? (await saved.before(market, period, best?.span.first, 1)).bars.length > 0 : false;
    if (!best && !savedOlder) return null;
    const digits = this.digits(market, best);
    const file = best?.file;
    const newer = await this.newerSaved(market, period, best);
    async function* pages() {
      if (savedOlder) yield* saved!.pages(market, period, best?.span.first);
      if (file && !newer) yield* file.pages();
      else if (file) {
        for await (const page of file.pages()) {
          const kept = page.filter((b) => b.time < newer!.fileEnd);
          if (kept.length) yield kept;
          if (kept.length < page.length) break;
        }
      }
      if (newer) yield* saved!.pages(market, period, undefined, newer.first);
    }
    return { digits, clockRule: this.options.clockRule(market.brokerServer), pages: pages() };
  }

  /**
   * The saved bars from a file's last bar on, when saved history reaches later than the file; they replace its last
   * bar when they hold it. Null without a file, or when saved history reaches no later.
   */
  private async newerSaved(market: Market, period: Period, best: PeriodFile | null): Promise<NewerSaved | null> {
    const last = best?.span.last;
    const newer = last === undefined ? null : await this.options.saved?.count(market, period, undefined, last);
    if (!newer || last === undefined || newer.last <= last) return null;
    return { ...newer, fileEnd: newer.first === last ? last : last + 1 };
  }

  /** The HST file of a market's period holding the newest bar, among the terminals logged into its broker server. */
  private async bestFile(market: Market, period: Period): Promise<PeriodFile | null> {
    const minutes = PERIOD_MINUTES[period];
    let best: PeriodFile | null = null;
    for (const terminalId of terminalsByServer(this.options.snapshot()).get(market.brokerServer) ?? []) {
      const folder = this.options.dataFolder(terminalId);
      const file = folder ? await HstFile.open(hstPath(folder, market.brokerServer, market.symbol, minutes)) : null;
      const span = file?.header.minutes === minutes ? await file.span() : null;
      if (file && span && newer(span, best)) best = { file, span };
    }
    return best;
  }

  /** The digits of a market's prices: its HST file's, else as stored, else 5. */
  private digits(market: Market, best: PeriodFile | null): number {
    return best?.file.header.digits ?? this.options.storedMarkets().find((m) => marketKey(m) === marketKey(market))?.digits ?? 5;
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
        const period = file && PERIOD_OF.get(file.header.minutes);
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
