// The Charts view: one feed's candles, built in memory by the server since the app started, with the forming
// candle following the live quote; MetaTrader's conventions (symbol, period and OHLC top-left, M1–MN1, candles,
// bars or line, Bid label, Ask line, indicator panes), drawn in the app's own design.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { BridgeSnapshot, FeedSnapshot } from "../../server/bridge/index.js";
import type { Candle } from "../../server/candles/index.js";
import { PERIODS, type Period } from "../../shared/periods.js";
import type { ClockRule } from "../../shared/clock.js";
import type { ChartColours, TimeShown } from "../../shared/settings-store.js";
import { get } from "../api.js";
import { browserOffsetMinutes, displayCandles } from "../display-clock.js";
import { groupFeeds, type FeedGroup } from "../feeds/feed-row.js";
import { duration } from "../format.js";
import { Price } from "../price.js";
import type { Live } from "../use-live.js";
import { useTicker } from "../use-live.js";
import { ChartCanvas, RSI_DIGITS } from "./chart-canvas.js";
import {
  candlesSince,
  chartLegend,
  CHART_TYPES,
  daySeparators,
  followQuote,
  isIndicatorPeriod,
  MAX_INDICATOR_PERIOD,
  readChartMemory,
  type ChartMemory,
  type ChartType,
  type IndicatorLine,
  type Legend,
} from "./chart-model.js";
import { chartScheme, type ChartScheme, type ColourMode } from "./chart-scheme.js";
import { DEFAULT_INDICATORS, indicatorLabel, indicatorValues, nextColour, type IndicatorSettings, type IndicatorSpec } from "./indicators.js";

/** Per window (localStorage): the last symbol, period, chart type, Ask line and indicators. */
const MEMORY_KEY = "quotebridge.chart";

/** Candle times are UTC seconds; `clockRule` is the broker server's, null while unknown. */
type CandlesAnswer = { feed: string; period: Period; digits: number; since: number; ask: number | null; clockRule: ClockRule | null; candles: Candle[] };

type Props = {
  live: Live;
  /** Terminal IDs to the names the Terminals view shows, for the symbol picker's groups. */
  terminalNames: ReadonlyMap<string, string>;
  chartColours: ChartColours;
  /** The clock the time axis, day separators and legend follow; candles still break on the broker clock. */
  timeShown: TimeShown;
};

export function ChartsView({ live, terminalNames, chartColours, timeShown }: Props) {
  const [memory, setMemory] = useChartMemory();
  const snapshot = live.snapshot;
  // The "Candles since" note shows the date once the day has changed.
  useTicker(60_000);
  const groups = useMemo(() => (snapshot ? groupFeeds(snapshot, terminalNames, snapshot.time).groups : []), [snapshot, terminalNames]);
  const feed = chosenFeed(snapshot, memory.feed, groups);
  const group = groups.find((g) => g.terminal === feed?.terminal);

  const fetched = useCandles(feed, memory.period, live);
  // Lightweight Charts has no time zones: it is given times shifted to the display clock (ADR 11).
  const rule = fetched?.clockRule ?? feed?.clockRule ?? null;
  const ruleKey = JSON.stringify(rule);
  const data = useMemo(
    () => fetched && { ...fetched, candles: displayCandles(fetched.candles, { shown: timeShown, rule, localOffsetMinutes: browserOffsetMinutes }) },
    [fetched, timeShown, ruleKey],
  );
  const mode = useColourMode();
  const scheme = chartScheme(chartColours, mode);
  const indicators = useMemo(() => drawnIndicators(memory.indicators, data?.candles ?? [], data?.digits ?? 5, scheme.series), [memory.indicators, data?.candles, data?.digits, scheme]);
  const [crosshair, setCrosshair] = useState<number>();
  // Asks the chart to scroll back to the latest bar.
  const [toLatest, setToLatest] = useState(0);

  // Keys 1–9 pick M1…MN1, as the segmented control shows them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey || e.repeat) return;
      if ((e.target as HTMLElement).closest?.("input, select, textarea")) return;
      const period = PERIODS[Number(e.key) - 1];
      if (period) setMemory({ period });
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  if (!snapshot || groups.length === 0) {
    return (
      <section class="view charts">
        <h1>Charts</h1>
        <p class="lead">Candles drawn from the quotes the app receives.</p>
        <div class="empty">
          <p>{snapshot ? "No feeds yet. A chart appears here once a QuoteBridge EA sends quotes." : "Connecting…"}</p>
        </div>
      </section>
    );
  }

  const legend = data && feed ? chartLegend({ symbol: feed.symbol, period: memory.period, digits: data.digits, candles: data.candles, indicators, time: crosshair }) : undefined;
  const latest = feed?.latest;
  const spread = latest && feed ? Math.round((latest.ask - latest.bid) * 10 ** feed.digits) : undefined;
  const lastHeard = feed && !feed.online ? duration(snapshot.time - feed.lastSeen) : undefined;
  const changeIndicator = (id: string, settings: IndicatorSettings | null) =>
    setMemory({ indicators: memory.indicators.flatMap((i) => (i.id !== id ? [i] : settings ? [{ ...settings, id, colour: i.colour }] : [])) });

  return (
    <section class="view charts" aria-label="Charts">
      <div class="chart-head">
        <SymbolPicker groups={groups} feed={feed} groupName={group?.name} onPick={(f) => setMemory({ feed: f })} />
        {feed && (
          <div class="chart-quote">
            <div class="side">
              <small>Bid</small>
              <Price value={latest?.bid} digits={feed.digits} />
            </div>
            <div class="side">
              <small>Ask</small>
              <Price value={latest?.ask} digits={feed.digits} />
            </div>
            {spread !== undefined && <div class="spread">Spread {spread}</div>}
          </div>
        )}
        <div class="chart-toolbar">
          <div class="seg" role="group" aria-label="Period">
            {PERIODS.map((p, i) => (
              <button key={p} aria-pressed={memory.period === p} title={`${p} (key ${i + 1})`} onClick={() => setMemory({ period: p })}>
                {p}
              </button>
            ))}
          </div>
          <div class="seg" role="group" aria-label="Chart type">
            {CHART_TYPES.map((t) => (
              <button key={t} aria-pressed={memory.type === t} title={TYPE_LABELS[t]} aria-label={TYPE_LABELS[t]} onClick={() => setMemory({ type: t })}>
                {TYPE_ICONS[t]}
              </button>
            ))}
          </div>
          <div class="seg" role="group" aria-label="Lines">
            <button aria-pressed={memory.askLine} title="Show the Ask line" onClick={() => setMemory({ askLine: !memory.askLine })}>
              Ask
            </button>
          </div>
          <button class="button" title="Scroll back to the latest bar" onClick={() => setToLatest((n) => n + 1)}>
            Latest
          </button>
          <IndicatorMenu onAdd={(settings) => setMemory({ indicators: [...memory.indicators, { ...settings, id: newId(), colour: nextColour(memory.indicators) }] })} />
        </div>
      </div>

      {lastHeard && (
        <div class="notice warn chart-notice" role="status">
          <span class="dot" aria-hidden="true" />
          <span>
            <strong>{feed!.symbol} is offline.</strong> Last heard {lastHeard} ago. The chart stops at its last quote.
          </span>
        </div>
      )}

      <ChartFrame
        key={feed?.feed}
        data={data}
        type={memory.type}
        askLine={memory.askLine}
        scheme={scheme}
        greenOnBlack={chartColours === "green-on-black"}
        indicators={indicators}
        specs={memory.indicators}
        legend={legend}
        toLatest={toLatest}
        onCrosshair={setCrosshair}
        onChangeIndicator={changeIndicator}
      />

      <div class="chart-foot">
        <span>
          <kbd>1</kbd>–<kbd>9</kbd> switch period
        </span>
        <span>Scroll to zoom, drag to pan</span>
        {data && <span class="since">{candlesSince(data.since, Date.now())}</span>}
      </div>
    </section>
  );
}

const TYPE_LABELS: Record<ChartType, string> = { bars: "Bars", candles: "Candles", line: "Line" };

const TYPE_ICONS: Record<ChartType, preact.JSX.Element> = {
  bars: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
      <path d="M5 2v12M3 5h2M5 10h2M11 4v10M9 6h2M11 12h2" />
    </svg>
  ),
  candles: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
      <rect x="3.5" y="5" width="3" height="6" />
      <path d="M5 2v3M5 11v3" />
      <rect x="9.5" y="3.5" width="3" height="5" fill="currentColor" />
      <path d="M11 1.5v2M11 8.5v4" />
    </svg>
  ),
  line: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
      <path d="M1.5 12l4-5 3 3 6-7" />
    </svg>
  ),
};

/** The symbol in large type over a native picker of the feeds, grouped by terminal. */
function SymbolPicker({ groups, feed, groupName, onPick }: { groups: FeedGroup[]; feed?: FeedSnapshot; groupName?: string; onPick: (feed: string) => void }) {
  return (
    <label class="symbol-pick" title="Choose a feed">
      <span class="sym">{feed?.symbol ?? "Choose a feed"}</span>
      <span class="src">{groupName && feed ? (groupName === feed.broker ? groupName : `${groupName} · ${feed.broker}`) : ""}</span>
      <select aria-label="Feed" value={feed?.feed} onChange={(e) => onPick((e.target as HTMLSelectElement).value)}>
        {groups.map((g) => (
          <optgroup key={g.terminal} label={g.name}>
            {g.feeds.map((f) => (
              <option key={f.feed} value={f.feed}>
                {f.symbol}
                {f.online ? "" : " (offline)"}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

function IndicatorMenu({ onAdd }: { onAdd: (settings: IndicatorSettings) => void }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const add = (settings: IndicatorSettings) => {
    onAdd(settings);
    menu.current?.removeAttribute("open");
  };
  return (
    <details class="indicator-menu" ref={menu}>
      <summary class="button">Indicators</summary>
      <div class="menu" role="menu">
        <button role="menuitem" onClick={() => add(DEFAULT_INDICATORS.ma)}>
          Moving average
        </button>
        <button role="menuitem" onClick={() => add(DEFAULT_INDICATORS.rsi)}>
          RSI
        </button>
      </div>
    </details>
  );
}

type FrameProps = {
  data?: CandlesAnswer;
  type: ChartType;
  askLine: boolean;
  scheme: ChartScheme;
  greenOnBlack: boolean;
  indicators: IndicatorLine[];
  specs: IndicatorSpec[];
  legend?: Legend;
  /** Changes each time the user asks for the latest bar. */
  toLatest: number;
  onCrosshair: (time: number | undefined) => void;
  onChangeIndicator: (id: string, settings: IndicatorSettings | null) => void;
};

/** The chart canvas with its legends: the price pane's top-left, and one at the top of each indicator pane. */
function ChartFrame({ data, type, askLine, scheme, greenOnBlack, indicators, specs, legend, toLatest, onCrosshair, onChangeIndicator }: FrameProps) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<ChartCanvas>();
  const [paneTops, setPaneTops] = useState<Map<string, number>>(new Map());
  /** Places the indicator panes' legends where the panes now are. */
  const layout = () => {
    const tops = canvas.current?.paneTops();
    if (tops) setPaneTops((old) => (sameTops(old, tops) ? old : tops));
  };
  /** The feed and period on the canvas: new ones scroll to the latest bar. */
  const shown = useRef("");

  useEffect(() => {
    canvas.current = new ChartCanvas(host.current!, scheme, onCrosshair);
    // Pane sizes change on a resize and when a separator is dragged.
    const observer = new ResizeObserver(layout);
    observer.observe(host.current!);
    host.current!.addEventListener("pointerup", layout);
    return () => {
      observer.disconnect();
      canvas.current?.remove();
      canvas.current = undefined;
    };
  }, []);

  useEffect(() => canvas.current?.setScheme(scheme), [scheme]);
  useEffect(() => canvas.current?.setType(type), [type]);
  useEffect(() => {
    if (data) canvas.current?.setDigits(data.digits);
  }, [data?.digits]);
  useEffect(() => {
    if (!data) return;
    canvas.current?.setCandles(data.candles, daySeparators(data.candles, data.period));
    const key = `${data.feed} ${data.period}`;
    if (key !== shown.current) canvas.current?.scrollToLatest();
    shown.current = key;
  }, [data?.candles]);
  useEffect(() => canvas.current?.setAsk(askLine && data?.ask != null ? data.ask : null), [askLine, data?.ask]);
  useEffect(() => {
    const draws = indicators.map((line) => ({ spec: specs.find((s) => s.id === line.id)!, colour: line.colour, values: line.values }));
    canvas.current?.setIndicators(draws);
    layout();
  }, [indicators]);
  useEffect(() => {
    if (toLatest) canvas.current?.scrollToLatest();
  }, [toLatest]);

  const legendRows = legend?.indicators ?? [];
  const pricePane = legendRows.filter((row) => !paneTops.has(row.id));
  return (
    <div class={`chart-frame${greenOnBlack ? " green-on-black" : ""}`} style={{ "--chart-text": scheme.text, "--chart-strong": scheme.strong }}>
      {legend && (
        <div class="chart-legend">
          <div>
            <span class="title">{legend.title}</span>
            {legend.time && <span class="time">{legend.time}</span>}
            {legend.ohlc.map((p) => (
              <span key={p.label} class="ohlc">
                <b>{p.label}</b>
                {p.value}
              </span>
            ))}
          </div>
          {pricePane.map((row) => (
            <IndicatorRow key={row.id} row={row} spec={specs.find((s) => s.id === row.id)} onChange={onChangeIndicator} />
          ))}
        </div>
      )}
      {legendRows
        .filter((row) => paneTops.has(row.id))
        .map((row) => (
          <div key={row.id} class="chart-legend sub" style={{ top: `${paneTops.get(row.id)! + 6}px` }}>
            <IndicatorRow row={row} spec={specs.find((s) => s.id === row.id)} onChange={onChangeIndicator} />
          </div>
        ))}
      {data && data.candles.length === 0 && <p class="chart-empty">No quotes for this feed yet. The first candle opens with its next quote.</p>}
      <div class="chart-host" ref={host} />
    </div>
  );
}

function sameTops(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>) {
  return a.size === b.size && [...a].every(([id, top]) => b.get(id) === top);
}

/** An indicator's legend row: its colour, name and value, with edit and remove. */
function IndicatorRow({ row, spec, onChange }: { row: Legend["indicators"][number]; spec?: IndicatorSpec; onChange: (id: string, settings: IndicatorSettings | null) => void }) {
  const [editing, setEditing] = useState(false);
  return (
    <div class="ind">
      <i style={{ background: row.colour }} aria-hidden="true" />
      <span>
        {row.label} {row.value}
      </span>
      <button class="icon-button" title={`Change ${row.label}`} aria-label={`Change ${row.label}`} onClick={() => setEditing(!editing)}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="M10.5 2.5l3 3L6 13H3v-3z" />
        </svg>
      </button>
      <button class="icon-button" title={`Remove ${row.label}`} aria-label={`Remove ${row.label}`} onClick={() => onChange(row.id, null)}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
      {editing && spec && (
        <IndicatorForm
          spec={spec}
          onDone={(settings) => {
            setEditing(false);
            if (settings) onChange(row.id, settings);
          }}
        />
      )}
    </div>
  );
}

function IndicatorForm({ spec, onDone }: { spec: IndicatorSpec; onDone: (settings: IndicatorSettings | null) => void }) {
  const [period, setPeriod] = useState(String(spec.period));
  const [type, setType] = useState(spec.kind === "ma" ? spec.type : "simple");
  const valid = isIndicatorPeriod(Number(period)) && /^\d+$/.test(period.trim());
  const submit = (e: Event) => {
    e.preventDefault();
    if (!valid) return;
    onDone(spec.kind === "ma" ? { kind: "ma", period: Number(period), type } : { kind: "rsi", period: Number(period) });
  };
  return (
    <form class="indicator-form" onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && onDone(null)}>
      <label>
        Period
        <input class="input" inputMode="numeric" value={period} onInput={(e) => setPeriod((e.target as HTMLInputElement).value)} autoFocus />
      </label>
      {spec.kind === "ma" && (
        <label>
          Type
          <select class="input" value={type} onChange={(e) => setType((e.target as HTMLSelectElement).value as "simple" | "exponential")}>
            <option value="simple">Simple</option>
            <option value="exponential">Exponential</option>
          </select>
        </label>
      )}
      <button class="button primary" type="submit" disabled={!valid}>
        Apply
      </button>
      <button class="button quiet" type="button" onClick={() => onDone(null)}>
        Cancel
      </button>
      {!valid && <span class="bad-text">Use a whole number from 1 to {MAX_INDICATOR_PERIOD}.</span>}
    </form>
  );
}

/** Each indicator's line for the candles: Moving averages in the feed's digits, RSI in its own. */
function drawnIndicators(specs: readonly IndicatorSpec[], candles: readonly Candle[], digits: number, palette: readonly string[]): IndicatorLine[] {
  const closes = candles.map((c) => c.close);
  return specs.map((spec) => ({
    id: spec.id,
    label: indicatorLabel(spec),
    colour: palette[spec.colour % palette.length],
    digits: spec.kind === "rsi" ? RSI_DIGITS : digits,
    values: indicatorValues(spec, closes),
  }));
}

/** The remembered feed (or the one a `#/charts?feed=` link chose) while the bridge knows it, else the first feed listed. */
function chosenFeed(snapshot: BridgeSnapshot | undefined, remembered: string | undefined, groups: FeedGroup[]): FeedSnapshot | undefined {
  return snapshot?.feeds.find((f) => f.feed === remembered) ?? groups[0]?.feeds[0];
}

/** The view memory in localStorage, with a feed from the URL (a Feeds row's link) taking over. */
function useChartMemory(): [ChartMemory, (change: Partial<ChartMemory>) => void] {
  const [memory, setMemory] = useState<ChartMemory>(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(MEMORY_KEY);
    } catch {
      // Storage may be unavailable: start from the defaults.
    }
    const read = readChartMemory(stored);
    const linked = feedFromHash();
    return linked ? { ...read, feed: linked } : read;
  });
  useEffect(() => {
    const onHash = () => {
      const linked = feedFromHash();
      if (linked) setMemory((m) => ({ ...m, feed: linked }));
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(MEMORY_KEY, JSON.stringify(memory));
    } catch {
      // As above: the view still works, it only forgets.
    }
  }, [memory]);
  const change = (part: Partial<ChartMemory>) => {
    setMemory((m) => ({ ...m, ...part }));
    // A reload stays on the chosen feed.
    if (part.feed) history.replaceState(null, "", `#/charts?feed=${encodeURIComponent(part.feed)}`);
  };
  return [memory, change];
}

function feedFromHash(): string | undefined {
  const query = location.hash.split("?")[1];
  return new URLSearchParams(query ?? "").get("feed") ?? undefined;
}

/**
 * The feed's candles from /api/candles, fetched again when the feed or period changes, when a new bucket opens
 * and after a reconnect; between fetches the forming candle follows the live quote.
 */
function useCandles(feed: FeedSnapshot | undefined, period: Period, live: Live): CandlesAnswer | undefined {
  const [data, setData] = useState<CandlesAnswer>();
  const [reload, setReload] = useState(0);
  const id = feed?.feed;

  useEffect(() => {
    if (!id || live.status !== "live") return;
    let current = true;
    get<CandlesAnswer>(`/api/candles?feed=${encodeURIComponent(id)}&period=${period}`).then(
      (answer) => current && setData(answer),
      () => current && setData(undefined),
    );
    return () => {
      current = false;
    };
  }, [id, period, reload, live.status]);

  const latest = feed?.latest;
  // Every snapshot is a new object: follow the quote only when it moved.
  useEffect(() => {
    if (!latest || !data || data.feed !== id || data.period !== period) return;
    const next = followQuote(data.candles, period, latest, feed?.clockRule ?? data.clockRule);
    if (next.candles !== data.candles || data.ask !== latest.ask) setData({ ...data, candles: next.candles as Candle[], ask: latest.ask });
    if (next.newBucket) setReload((n) => n + 1);
  }, [latest?.bid, latest?.ask, latest?.quoteTime]);

  return data && data.feed === id && data.period === period ? data : undefined;
}

/** Light or dark as the page shows it now: the Theme setting's data-theme, else the Windows colour scheme. */
function useColourMode(): ColourMode {
  const read = (): ColourMode => {
    const forced = document.documentElement.dataset.theme;
    if (forced === "light" || forced === "dark") return forced;
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  };
  const [mode, setMode] = useState(read);
  useEffect(() => {
    const update = () => setMode(read());
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", update);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      media.removeEventListener("change", update);
      observer.disconnect();
    };
  }, []);
  return mode;
}

let idCounter = 0;
function newId(): string {
  return `${Date.now().toString(36)}${(idCounter++).toString(36)}`;
}
