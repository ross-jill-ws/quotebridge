// The saver: copies a market's HST bars into saved history, from every period file of every terminal on its broker
// server, so the history outlives MetaTrader trimming its files or the terminal being removed. Each run adds the bars
// from the newest saved one on (that one may have been saved while forming) and the bars older than the first saved
// one, reading each file from its end backwards; bars between are saved already. Recorded markets are saved at start
// (once a terminal on their broker server is known) and hourly; any market once on request. One run at a time.
import { brokerToUtc, UNKNOWN_RULE, type ClockRule } from "../../shared/clock.js";
import { PERIODS, type Period } from "../../shared/periods.js";
import { marketKey, type BridgeSnapshot, type Market } from "../bridge/index.js";
import { PERIOD_MINUTES } from "./chart-history.js";
import { HstFile, hstPath, type HstBar } from "./hst-file.js";
import type { SavedBarStore } from "./saved-store.js";

/** Recorded markets are saved again this often. */
export const SAVE_EVERY_MS = 3600_000;
/** How often the saver looks for recorded markets that are due. */
export const SAVE_CHECK_MS = 1000;
/** Bars read and inserted at a time. */
const SAVE_PAGE = 4096;

/** A run's progress in bars read; queued runs have read none. */
export type SaveProgress = { done: number; total: number };

export type HistorySaverOptions = {
  store: SavedBarStore;
  snapshot: () => BridgeSnapshot;
  /** A terminal's data folder, where its HST files are; undefined when unknown. */
  dataFolder: (terminalId: string) => string | undefined;
  clockRule: (brokerServer: string) => ClockRule | null;
  /** The market's ID, adding the market when new. */
  marketId: (market: Market, digits: number | null) => Promise<number>;
  /** The markets saved automatically: the recorded ones. */
  recorded: () => Market[];
  /** Clock in epoch milliseconds; injectable for tests. */
  now?: () => number;
};

type PeriodFile = { period: Period; file: HstFile; bars: number; last: number };

export class HistorySaver {
  /** Per market key: queued or running. */
  private readonly saving = new Map<string, SaveProgress>();
  private readonly queue: Market[] = [];
  /** Per recorded market key: when it is next saved. */
  private readonly due = new Map<string, number>();
  private readonly now: () => number;
  private readonly timer: NodeJS.Timeout;
  private running: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly options: HistorySaverOptions) {
    this.now = options.now ?? Date.now;
    this.timer = setInterval(() => this.check(), SAVE_CHECK_MS);
  }

  /** A queued or running save's progress, or null. */
  progress(market: Market): SaveProgress | null {
    const p = this.saving.get(marketKey(market));
    return p ? { ...p } : null;
  }

  /** Saves a market's history once; false when no HST file of it is on this computer. */
  async request(market: Market): Promise<boolean> {
    if (!(await this.files(market)).length) return false;
    this.enqueue(market);
    return true;
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.running;
  }

  /** Queues the recorded markets that are due and have a terminal on their broker server. */
  private check() {
    const servers = new Set(this.options.snapshot().terminals.map((t) => t.brokerServer));
    const now = this.now();
    for (const market of this.options.recorded()) {
      const key = marketKey(market);
      if ((this.due.get(key) ?? 0) > now || !servers.has(market.brokerServer)) continue;
      this.due.set(key, now + SAVE_EVERY_MS);
      this.enqueue(market);
    }
  }

  private enqueue(market: Market) {
    const key = marketKey(market);
    if (this.closed || this.saving.has(key)) return;
    this.saving.set(key, { done: 0, total: 0 });
    this.queue.push(market);
    this.running ??= this.drain().finally(() => (this.running = undefined));
  }

  private async drain() {
    for (let market = this.queue.shift(); market && !this.closed; market = this.queue.shift()) {
      try {
        await this.save(market);
      } catch (e) {
        console.error(`The history of ${market.symbol} on ${market.brokerServer} could not be saved`, e);
      } finally {
        this.saving.delete(marketKey(market));
      }
    }
    for (const market of this.queue.splice(0)) this.saving.delete(marketKey(market));
  }

  private async save(market: Market) {
    const files = await this.files(market);
    const progress = this.saving.get(marketKey(market))!;
    progress.total = files.reduce((sum, f) => sum + f.bars, 0);
    if (!files.length) return;
    const id = await this.options.marketId(market, files[0].file.header.digits);
    const insert = (period: Period, bars: HstBar[]) => {
      // The rule as of this page: a rule change recomputes the bars saved before it, not those inserted after.
      const rule = this.options.clockRule(market.brokerServer) ?? UNKNOWN_RULE;
      // One bar per time: a file holding a time twice keeps its later record.
      const unique = [...new Map(bars.map((b) => [b.time, b])).values()];
      return this.options.store.insert(id, period, unique.map((b) => ({ ...b, utc: brokerToUtc(rule, b.time * 1000) / 1000 })));
    };
    let read = 0;
    for (const { period, file, bars } of files) {
      if (this.closed) return;
      const saved = await this.options.store.span(id, period);
      // From the end back to the newest saved bar, then on from before the first saved one.
      for (let cursor: number | undefined; ; ) {
        const page = await file.before(cursor, SAVE_PAGE);
        await insert(period, saved ? page.bars.filter((b) => b.time >= saved.last) : page.bars);
        progress.done = Math.min(read + bars, progress.done + page.bars.length);
        if (this.closed || page.complete || page.next === undefined || (saved && page.next <= saved.last)) break;
        cursor = page.next;
      }
      for (let cursor = saved?.first; saved && !this.closed; ) {
        const page = await file.before(cursor, SAVE_PAGE);
        await insert(period, page.bars);
        progress.done = Math.min(read + bars, progress.done + page.bars.length);
        if (page.complete || page.next === undefined) break;
        cursor = page.next;
      }
      progress.done = read += bars;
    }
  }

  /** The market's period files on every terminal logged into its broker server. */
  private async files(market: Market): Promise<PeriodFile[]> {
    const out: PeriodFile[] = [];
    for (const t of this.options.snapshot().terminals) {
      const folder = t.brokerServer === market.brokerServer ? this.options.dataFolder(t.terminalId) : undefined;
      if (!folder) continue;
      for (const period of PERIODS) {
        const minutes = PERIOD_MINUTES[period];
        const file = await HstFile.open(hstPath(folder, market.brokerServer, market.symbol, minutes));
        if (!file || file.header.minutes !== minutes || file.header.symbol.toLowerCase() !== market.symbol.toLowerCase()) continue;
        const span = await file.span();
        if (span) out.push({ period, file, bars: span.bars, last: span.last });
      }
    }
    // Per period, the file with the newest bar last: its version of the newest saved bar is the one kept.
    return out.sort((a, b) => PERIODS.indexOf(a.period) - PERIODS.indexOf(b.period) || a.last - b.last || a.bars - b.bars);
  }
}
