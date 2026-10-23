// Indicator values, cached in memory per market, period, package id and version, and parameters (ADR 12), shared by
// every window and REST. A key is computed over the chart history from the oldest bar asked for to the latest, with the
// package's warm-up before it. The forming bar is computed again at most once a second, when asked for or while a
// window shows the key; an older page computes the whole key again (an average depends on where it starts). A failure
// keeps the last good values, marked stale. Nothing is stored.
import { marketKey, type FeedSnapshot, type Market } from "../bridge/index.js";
import type { Candle } from "../candles/index.js";
import type { HistoryPage } from "../history/index.js";
import type { Period } from "../../shared/periods.js";
import { warmUpBars, type ParameterValues } from "../../shared/indicator-manifest.js";
import type { IndicatorEngine } from "./engine.js";
import type { IndicatorPackage } from "./packages.js";
import type { OutputPoint } from "./sandbox.js";

/** The forming bar is computed again at most this often. */
export const FORMING_EVERY_MS = 1000;
/** A key no window shows and nobody asked for in this long is forgotten. */
export const FORGET_AFTER_MS = 10 * 60_000;
/** Bars read per history page while loading a key. */
const LOAD_PAGE = 5000;
/** The latest bars read to bring a key up to date. */
const TAIL_BARS = 50;

/** A value at a bar; the forming bar's is `complete: false`. */
export type ValuePoint = OutputPoint & { complete?: false };

export type IndicatorValuesAnswer = {
  /** Names the cached values; a window shows it on the live stream to hear when they change. */
  key: string;
  package: string;
  version: string;
  /** Each output's values at the page's bars. */
  outputs: Record<string, ValuePoint[]>;
  /** No bars exist older than the page. */
  complete: boolean;
  /** Why the last computation failed; the values are then the last good ones. */
  failed: string | null;
  /** The values are the last good ones of a failed key. */
  stale: boolean;
};

export type IndicatorValuesOptions = {
  /** A page of the chart history, as /api/candles reads it (UTC seconds). */
  page: (feed: FeedSnapshot, period: Period, limit: number, before?: number) => Promise<HistoryPage>;
  engine: IndicatorEngine;
  /** The feed as the bridge knows it now, else another feed of its market; undefined when the market has none. */
  feed: (feedId: string, market: Market) => FeedSnapshot | undefined;
  now?: () => number;
};

type Entry = {
  key: string;
  /** The feed that asked first: its bars are read, or another feed's of the market once it is gone. */
  feedId: string;
  market: Market;
  period: Period;
  pkg: IndicatorPackage;
  parameters: ParameterValues;
  /** The bars computed over, oldest first: the warm-up, then from `from` to the latest, the last still forming. */
  bars: Candle[];
  /** The oldest bar asked for. */
  from: number;
  /** No bars exist older than `from` beyond the warm-up read. */
  complete: boolean;
  /** The last good values, by output. */
  outputs: Record<string, OutputPoint[]> | null;
  failed: string | null;
  /** When the bars were last brought up to date (epoch ms). */
  checkedAt: number;
  usedAt: number;
  /** Work on the entry, one at a time. */
  busy: Promise<unknown>;
};

export class IndicatorValues {
  private readonly entries = new Map<string, Entry>();
  /** The keys each window shows. */
  private readonly shown = new Map<object, Set<string>>();
  private readonly listeners = new Set<(key: string) => void>();
  private readonly now: () => number;
  private readonly timer: NodeJS.Timeout;
  private refreshing = false;

  constructor(private readonly options: IndicatorValuesOptions) {
    this.now = options.now ?? Date.now;
    // Shown keys follow the forming bar without being asked.
    this.timer = setInterval(() => {
      this.forget();
      void this.refreshShown();
    }, FORMING_EVERY_MS / 4);
    this.timer.unref();
  }

  /** The package's values for `feed` and `period` over the candles page `limit` older than `before` (UTC seconds). */
  async values(feed: FeedSnapshot, period: Period, pkg: IndicatorPackage, parameters: ParameterValues, limit: number, before?: number): Promise<IndicatorValuesAnswer> {
    const page = await this.options.page(feed, period, limit, before);
    const key = JSON.stringify([marketKey(feed.market), period, pkg.manifest.id, pkg.manifest.version, pkg.hash, parameters]);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { key, feedId: feed.feed, market: feed.market, period, pkg, parameters, bars: [], from: Infinity, complete: false, outputs: null, failed: null, checkedAt: -Infinity, usedAt: 0, busy: Promise.resolve() };
      this.entries.set(key, entry);
    }
    entry.usedAt = this.now();
    const first = page.candles[0]?.time;
    const current = entry;
    let changed = false;
    await this.work(current, async () => {
      if (first !== undefined && first < current.from) changed = await this.load(current, feed, first);
      else if (this.now() - current.checkedAt >= FORMING_EVERY_MS) changed = await this.update(current, feed);
    });
    // Other windows showing the key hear of it, as when the timer finds the change.
    if (changed) this.changed(key);
    return this.answer(entry, page);
  }

  /** The keys a window shows now (none to stop); `window` is anything that stands for it. */
  show(window: object, keys: readonly string[]) {
    if (keys.length) this.shown.set(window, new Set(keys));
    else this.shown.delete(window);
  }

  /** `listener` hears each key whose values changed while a window showed it; returns a function that stops it. */
  onChange(listener: (key: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    clearInterval(this.timer);
    this.listeners.clear();
  }

  private work(entry: Entry, job: () => Promise<void>): Promise<void> {
    const run = entry.busy.then(job);
    entry.busy = run.catch(() => undefined);
    return run;
  }

  private changed(key: string) {
    for (const listener of this.listeners) listener(key);
  }

  private shownKeys(): Set<string> {
    return new Set([...this.shown.values()].flatMap((s) => [...s]));
  }

  /** Brings each shown key up to date, once a second at most, and says which changed; one pass at a time. */
  private async refreshShown() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      await Promise.all([...this.shownKeys()].map((key) => this.refresh(key)));
    } finally {
      this.refreshing = false;
    }
  }

  private async refresh(key: string) {
    const entry = this.entries.get(key);
    const feed = entry && this.options.feed(entry.feedId, entry.market);
    if (!entry || !feed || this.now() - entry.checkedAt < FORMING_EVERY_MS) return;
    entry.usedAt = this.now();
    let changed = false;
    await this.work(entry, async () => {
      if (this.now() - entry.checkedAt < FORMING_EVERY_MS) return;
      changed = await this.update(entry, feed);
    }).catch((e) => console.error("Indicator values could not be brought up to date", e));
    if (changed) this.changed(key);
  }

  /** Reads the bars from `from` to the latest, with the warm-up before them, and computes the key over them; true when the values changed. */
  private async load(entry: Entry, feed: FeedSnapshot, from: number): Promise<boolean> {
    let loaded: Candle[] = [];
    let complete = false;
    let before: number | undefined;
    for (;;) {
      const page = await this.options.page(feed, entry.period, LOAD_PAGE, before);
      loaded = [...page.candles, ...loaded];
      complete = page.complete;
      if (!page.candles.length || page.candles[0].time <= from || page.complete) break;
      before = page.candles[0].time;
    }
    const start = loaded.findIndex((c) => c.time >= from);
    const warmUp = warmUpBars(entry.pkg.manifest, entry.parameters);
    const had = start < 0 ? loaded.length : start;
    if (had < warmUp && !complete && loaded.length) {
      const older = await this.options.page(feed, entry.period, warmUp - had, loaded[0].time);
      loaded = [...older.candles, ...loaded];
      complete = older.complete;
    }
    entry.bars = loaded.slice(Math.max(0, had - warmUp));
    entry.from = from;
    entry.complete = complete;
    entry.checkedAt = this.now();
    return this.compute(entry);
  }

  /** Joins the latest bars on and computes again when they changed; true when the values did. */
  private async update(entry: Entry, feed: FeedSnapshot): Promise<boolean> {
    if (entry.from === Infinity) return false;
    const tail = (await this.options.page(feed, entry.period, TAIL_BARS)).candles;
    entry.checkedAt = this.now();
    if (!tail.length) return false;
    const at = entry.bars.findIndex((c) => c.time === tail[0].time);
    // Too far behind to join on (or rewritten before it): read the whole key again.
    if (at < 0) return this.load(entry, feed, entry.from);
    const bars = [...entry.bars.slice(0, at), ...tail];
    // A closed-bars-only package never sees the forming bar: only a bar closing changes its values.
    const seen = (list: readonly Candle[]) => (entry.pkg.manifest.closedBarsOnly ? list.slice(at, -1) : list.slice(at));
    const same = sameBars(seen(bars), seen(entry.bars));
    entry.bars = bars;
    return same ? false : this.compute(entry);
  }

  /** Runs the package over the entry's bars; true when its values or failure changed. */
  private async compute(entry: Entry): Promise<boolean> {
    const { manifest } = entry.pkg;
    const before = JSON.stringify([entry.outputs, entry.failed]);
    const bars = manifest.closedBarsOnly ? entry.bars.slice(0, -1) : entry.bars;
    const result = await this.options.engine.run(entry.pkg, bars, entry.parameters);
    if (result.ok) {
      entry.outputs = result.outputs;
      entry.failed = null;
    } else {
      entry.failed = result.reason;
    }
    return JSON.stringify([entry.outputs, entry.failed]) !== before;
  }

  private answer(entry: Entry, page: HistoryPage): IndicatorValuesAnswer {
    const { manifest } = entry.pkg;
    const times = new Set(page.candles.map((c) => c.time));
    const forming = entry.bars.at(-1)?.time;
    const outputs: Record<string, ValuePoint[]> = {};
    for (const o of manifest.outputs) {
      outputs[o.id] = (entry.outputs?.[o.id] ?? []).filter((p) => times.has(p.time)).map((p) => (p.time === forming ? { ...p, complete: false } : p));
    }
    return { key: entry.key, package: manifest.id, version: manifest.version, outputs, complete: page.complete, failed: entry.failed, stale: entry.failed !== null && entry.outputs !== null };
  }

  /** Drops the keys nobody uses. */
  private forget() {
    const shown = this.shownKeys();
    for (const [key, entry] of this.entries) if (!shown.has(key) && this.now() - entry.usedAt > FORGET_AFTER_MS) this.entries.delete(key);
  }
}

function sameBars(a: readonly Candle[], b: readonly Candle[]) {
  return a.length === b.length && a.every((c, i) => c.time === b[i].time && c.open === b[i].open && c.high === b[i].high && c.low === b[i].low && c.close === b[i].close);
}
