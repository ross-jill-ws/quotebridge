// The Charts view: one feed's chart history (the terminal's HST bars, then the live candles the server builds),
// loaded further back as the trader scrolls, with the forming candle following the live quote; MetaTrader's
// conventions (symbol, period and OHLC top-left, M1–MN1, candles, bars or line, Bid label, Ask line, indicator panes),
// drawn in the app's own design. Indicator values come from the server (ADR 12), fetched again when it says they changed.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { BridgeSnapshot, FeedSnapshot } from "../../server/bridge/index.js";
import type { Candle } from "../../server/candles/index.js";
import { PERIODS, type Period } from "../../shared/periods.js";
import type { ClockRule } from "../../shared/clock.js";
import type { ChartColours, TimeShown } from "../../shared/settings-store.js";
import { ApiError, get } from "../api.js";
import { browserOffsetMinutes, displayCandles } from "../display-clock.js";
import { groupFeeds, type FeedGroup } from "../feeds/feed-row.js";
import { duration } from "../format.js";
import { Price } from "../price.js";
import type { Live } from "../use-live.js";
import { useTicker } from "../use-live.js";
import { ChartCanvas } from "./chart-canvas.js";
import {
  candlesSince,
  chartLegend,
  CHART_TYPES,
  daySeparators,
  followQuote,
  mergeLatest,
  PAGE_BARS,
  prependOlder,
  showsCandlesSince,
  wantsOlder,
  readChartMemory,
  chartPackages,
  type ChartMemory,
  type ChartType,
  type Legend,
} from "./chart-model.js";
import { chartScheme, type ChartScheme, type ColourMode } from "./chart-scheme.js";
import {
  checkSettings,
  drawnIndicators,
  MAX_INDICATORS,
  newColours,
  swapTones,
  withColour,
  type IndicatorDraw,
  type IndicatorSpec,
  type IndicatorValuesAnswer,
  type PackageInfo,
} from "./indicators.js";
import { defaultValues, type Manifest, type ParameterValues } from "../../shared/indicator-manifest.js";
import { usePackages } from "../indicators/use-packages.js";

/** Per window (localStorage): the last symbol, period, chart type, Ask line and indicators. */
const MEMORY_KEY = "quotebridge.chart";

/**
 * Candle times are UTC seconds; `clockRule` is the broker server's, null while unknown; `complete`: no older bars exist;
 * `filling`: the server is getting the period's bars from the EA, and the latest page grows once they are in.
 */
type CandlesAnswer = {
  feed: string;
  period: Period;
  digits: number;
  since: number;
  ask: number | null;
  clockRule: ClockRule | null;
  candles: Candle[];
  complete: boolean;
  filling: boolean;
};

/** While the server is getting the EA's bars, the latest page is fetched again this often. */
const FILLING_RELOAD_MS = 1000;

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

  const { data: fetched, loadOlder } = useCandles(feed, memory.period, live);
  // Lightweight Charts has no time zones: it is given times shifted to the display clock (ADR 11).
  const rule = fetched?.clockRule ?? feed?.clockRule ?? null;
  const ruleKey = JSON.stringify(rule);
  const data = useMemo(
    () => fetched && { ...fetched, candles: displayCandles(fetched.candles, { shown: timeShown, rule, localOffsetMinutes: browserOffsetMinutes }) },
    [fetched, timeShown, ruleKey],
  );
  const mode = useColourMode();
  const scheme = chartScheme(chartColours, mode);
  const packages = usePackages(live).byId;
  // The Indicators page counts the charts using each package.
  const used = chartPackages(memory).join("\n");
  useEffect(() => live.reportCharts(used ? used.split("\n") : []), [used]);
  const values = useIndicatorValues(feed, memory.period, memory.indicators, packages, fetched, live);
  const drawn = useMemo(
    () => drawnIndicators(memory.indicators, packages, values, fetched?.candles ?? [], data?.digits ?? 5, scheme),
    [memory.indicators, packages, values, fetched?.candles, data?.digits, scheme],
  );
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

  const legend = data && feed ? chartLegend({ symbol: feed.symbol, period: memory.period, digits: data.digits, candles: data.candles, indicators: drawn.lines, time: crosshair }) : undefined;
  const latest = feed?.latest;
  const spread = latest && feed ? Math.round((latest.ask - latest.bid) * 10 ** feed.digits) : undefined;
  const lastHeard = feed && !feed.online ? duration(snapshot.time - feed.lastSeen) : undefined;
  const changeIndicator = (id: string, change: IndicatorSpec | null) =>
    setMemory({ indicators: memory.indicators.flatMap((i) => (i.id !== id ? [i] : change ? [change] : [])) });
  const addIndicator = (manifest: Manifest) => {
    const colours = newColours(manifest, memory.indicators);
    setMemory({ indicators: [...memory.indicators, { id: newId(), package: manifest.id, parameters: defaultValues(manifest), colours }] });
  };

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
          <IndicatorMenu packages={packages} full={memory.indicators.length >= MAX_INDICATORS} onAdd={addIndicator} />
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
        draws={drawn.draws}
        specs={memory.indicators}
        packages={packages}
        legend={legend}
        toLatest={toLatest}
        onCrosshair={setCrosshair}
        onVisibleFrom={(index) => wantsOlder(index, fetched?.complete ?? true) && loadOlder()}
        onChangeIndicator={changeIndicator}
      />

      <div class="chart-foot">
        <span>
          <kbd>1</kbd>–<kbd>9</kbd> switch period
        </span>
        <span>Scroll to zoom, drag to pan</span>
        {fetched && showsCandlesSince(fetched.candles, fetched.since) && <span class="since">{candlesSince(fetched.since, Date.now())}</span>}
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

/** The enabled packages, bundled ones first, then the others by name. */
function IndicatorMenu({ packages, full, onAdd }: { packages: ReadonlyMap<string, PackageInfo>; full: boolean; onAdd: (manifest: Manifest) => void }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const add = (manifest: Manifest) => {
    onAdd(manifest);
    menu.current?.removeAttribute("open");
  };
  const listed = [...packages.values()]
    .filter((p) => p.enabled)
    .sort((a, b) => Number(b.bundled) - Number(a.bundled) || (a.bundled ? 0 : a.manifest.name.localeCompare(b.manifest.name)));
  return (
    <details class="indicator-menu" ref={menu}>
      <summary class="button">Indicators</summary>
      <div class="menu" role="menu">
        {full && <p class="menu-note">A chart has at most {MAX_INDICATORS} indicators.</p>}
        {listed.map((p) => (
          <button key={p.manifest.id} role="menuitem" disabled={full} title={p.manifest.description} onClick={() => add(p.manifest)}>
            {p.manifest.name}
          </button>
        ))}
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
  draws: IndicatorDraw[];
  specs: IndicatorSpec[];
  packages: ReadonlyMap<string, PackageInfo>;
  legend?: Legend;
  /** Changes each time the user asks for the latest bar. */
  toLatest: number;
  onCrosshair: (time: number | undefined) => void;
  /** The logical index of the leftmost visible bar, whenever the view moves. */
  onVisibleFrom: (index: number) => void;
  /** The indicator changed (its parameters or colours), or null to remove it. */
  onChangeIndicator: (id: string, change: IndicatorSpec | null) => void;
};

/** The chart canvas with its legends: the price pane's top-left, and one at the top of each indicator pane. */
function ChartFrame({ data, type, askLine, scheme, greenOnBlack, draws, specs, packages, legend, toLatest, onCrosshair, onVisibleFrom, onChangeIndicator }: FrameProps) {
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
  // The canvas is made once; it calls the latest handler.
  const visibleFrom = useRef(onVisibleFrom);
  visibleFrom.current = onVisibleFrom;

  useEffect(() => {
    canvas.current = new ChartCanvas(host.current!, scheme, onCrosshair, (index) => visibleFrom.current(index));
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
    canvas.current?.setIndicators(draws);
    layout();
  }, [draws]);
  useEffect(() => {
    if (toLatest) canvas.current?.scrollToLatest();
  }, [toLatest]);

  const legendRows = legend?.indicators ?? [];
  const manifestOf = (id: string) => packages.get(specs.find((s) => s.id === id)?.package ?? "")?.manifest;
  const pricePane = legendRows.filter((row) => !paneTops.has(row.id));
  return (
    <div class={`chart-frame${greenOnBlack ? " green-on-black" : ""}`} style={{ "--chart-text": scheme.text, "--chart-strong": scheme.strong, "--chart-canvas": scheme.canvas }}>
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
            <IndicatorRow key={row.id} row={row} spec={specs.find((s) => s.id === row.id)} manifest={manifestOf(row.id)} series={scheme.series} onChange={onChangeIndicator} />
          ))}
        </div>
      )}
      {legendRows
        .filter((row) => paneTops.has(row.id))
        .map((row) => (
          <div key={row.id} class="chart-legend sub" style={{ top: `${paneTops.get(row.id)! + 6}px` }}>
            <IndicatorRow row={row} spec={specs.find((s) => s.id === row.id)} manifest={manifestOf(row.id)} series={scheme.series} onChange={onChangeIndicator} />
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

/**
 * An indicator's legend row: its name and parameters, each output's value in its colour (a click on the swatch picks
 * another), Failed with the reason, edit and remove.
 */
function IndicatorRow({
  row,
  spec,
  manifest,
  series,
  onChange,
}: {
  row: Legend["indicators"][number];
  spec?: IndicatorSpec;
  manifest?: Manifest;
  series: ChartScheme["series"];
  onChange: (id: string, change: IndicatorSpec | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState<string>();
  return (
    <div class={`ind${row.failed ? " failed" : ""}${row.notAvailable ? " unavailable" : ""}`}>
      <span class="ind-label">{row.label}</span>
      {row.notAvailable && (
        <span class="ind-unavailable" role="status" title="Its package is disabled or no longer installed. Enable it on the Indicators page and the indicator comes back.">
          Not available
        </span>
      )}
      {row.outputs.map((o) => (
        <span key={o.id} class="ind-output">
          {o.tones ? (
            // Rising and falling bars: the click swaps their two colours.
            <button
              class="swatch"
              style={{ background: `linear-gradient(90deg, ${o.tones.rising} 50%, ${o.tones.falling} 50%)` }}
              title={`Swap the rising and falling colours of ${o.label ?? row.label}`}
              aria-label={`Swap the rising and falling colours of ${o.label ?? row.label}`}
              onClick={() => spec && onChange(row.id, swapTones(spec, o.id))}
            />
          ) : (
            <button
              class="swatch"
              style={{ background: o.colour }}
              title={`Colour of ${o.label ?? row.label}`}
              aria-label={`Colour of ${o.label ?? row.label}`}
              aria-expanded={picking === o.id}
              onClick={() => setPicking(picking === o.id ? undefined : o.id)}
            />
          )}
          {o.label && <span class="ind-name">{o.label}</span>}
          <span class="value" style={{ color: o.colour }}>
            {o.value}
          </span>
          {picking === o.id && spec && (
            <span class="swatch-menu" role="menu" aria-label={`Colours for ${o.label ?? row.label}`}>
              {series.map((colour, n) => (
                <button
                  key={n}
                  role="menuitemradio"
                  aria-checked={spec.colours[o.id] === n}
                  class="swatch"
                  style={{ background: colour }}
                  title={SERIES_NAMES[n]}
                  aria-label={SERIES_NAMES[n]}
                  onClick={() => {
                    setPicking(undefined);
                    onChange(row.id, withColour(spec, o.id, n));
                  }}
                />
              ))}
            </span>
          )}
        </span>
      ))}
      {row.failed && (
        <span class="ind-failed" role="status" title={row.failed}>
          Failed: {row.failed}
        </span>
      )}
      {manifest && (
        <button class="icon-button" title={`Change ${row.label}`} aria-label={`Change ${row.label}`} onClick={() => setEditing(!editing)}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M10.5 2.5l3 3L6 13H3v-3z" />
          </svg>
        </button>
      )}
      <button class="icon-button" title={`Remove ${row.label}`} aria-label={`Remove ${row.label}`} onClick={() => onChange(row.id, null)}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
      {editing && spec && manifest && (
        <IndicatorForm
          manifest={manifest}
          parameters={spec.parameters}
          onDone={(parameters) => {
            setEditing(false);
            if (parameters) onChange(row.id, { ...spec, parameters });
          }}
        />
      )}
    </div>
  );
}

/** The series palette's colours, in its order. */
const SERIES_NAMES = ["Gold", "Azure", "Violet", "Slate"];

/** The settings form, generated from the package's manifest: each parameter by its label, with its range or choices. */
function IndicatorForm({ manifest, parameters, onDone }: { manifest: Manifest; parameters: ParameterValues; onDone: (parameters: ParameterValues | null) => void }) {
  const [texts, setTexts] = useState<Record<string, string>>(() => Object.fromEntries(manifest.parameters.map((p) => [p.id, String(parameters[p.id] ?? p.default)])));
  const checked = checkSettings(manifest, texts);
  const set = (id: string, text: string) => setTexts((t) => ({ ...t, [id]: text }));
  const submit = (e: Event) => {
    e.preventDefault();
    if (checked.ok) onDone(checked.values);
  };
  return (
    <form class="indicator-form" onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && onDone(null)}>
      {manifest.parameters.map((p, i) => (
        <label key={p.id}>
          {p.label}
          {p.type === "choice" ? (
            <select class="input" value={texts[p.id]} onChange={(e) => set(p.id, (e.target as HTMLSelectElement).value)}>
              {p.choices.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              class="input"
              inputMode={p.type === "integer" ? "numeric" : "decimal"}
              title={`${p.min} to ${p.max}, ${p.default} by default`}
              value={texts[p.id]}
              onInput={(e) => set(p.id, (e.target as HTMLInputElement).value)}
              autoFocus={i === 0}
            />
          )}
        </label>
      ))}
      <button class="button primary" type="submit" disabled={!checked.ok}>
        Apply
      </button>
      <button class="button quiet" type="button" onClick={() => onDone(null)}>
        Cancel
      </button>
      {!checked.ok && <span class="bad-text">{checked.error}</span>}
    </form>
  );
}

/** The latest values fetched again when the server says an indicator's values changed: enough for the forming bar. */
const TAIL_VALUES = 10;

/**
 * Each indicator's values (by its id) for the loaded candles, from /api/indicators/values: all of them when the
 * settings, feed, period or number of candles change, and the latest few when the live stream says a shown key changed.
 */
function useIndicatorValues(
  feed: FeedSnapshot | undefined,
  period: Period,
  specs: readonly IndicatorSpec[],
  packages: ReadonlyMap<string, PackageInfo>,
  data: CandlesAnswer | undefined,
  live: Live,
): ReadonlyMap<string, IndicatorValuesAnswer> {
  const [fetched, setFetched] = useState<ReadonlyMap<string, { query: string; answer: IndicatorValuesAnswer }>>(new Map());
  const count = data && data.feed === feed?.feed && data.period === period ? data.candles.length : 0;
  const queries = specs
    .filter((s) => packages.get(s.package)?.enabled && feed)
    .map((s) => {
      const query = new URLSearchParams({ feed: feed!.feed, period, package: s.package });
      for (const [id, value] of Object.entries(s.parameters)) query.set(`p.${id}`, String(value));
      return { id: s.id, query: query.toString() };
    });
  const queriesKey = JSON.stringify(queries);
  /** Keeps what `change` makes of the values fetched with the same query (undefined leaves them). */
  const store = (id: string, query: string, change: (old: IndicatorValuesAnswer | undefined) => IndicatorValuesAnswer | undefined) =>
    setFetched((m) => {
      const old = m.get(id);
      const answer = change(old?.query === query ? old.answer : undefined);
      return answer ? new Map(m).set(id, { query, answer }) : m;
    });

  useEffect(() => {
    if (!count || live.status !== "live") return;
    let current = true;
    for (const { id, query } of queries) {
      get<IndicatorValuesAnswer>(`/api/indicators/values?${query}&limit=${count}`).then(
        (answer) => current && store(id, query, () => answer),
        // Refused (a parameter the package no longer has, say): the legend row says why. A package disabled or gone
        // meanwhile reads as Not available, until the package list says so too.
        (e: Error) => current && store(id, query, () => refused(e)),
      );
    }
    return () => {
      current = false;
    };
  }, [queriesKey, count, live.status]);

  // Only values fetched with the settings shown now.
  const shown = new Map<string, IndicatorValuesAnswer>();
  for (const { id, query } of queries) {
    const entry = fetched.get(id);
    if (entry?.query === query) shown.set(id, entry.answer);
  }
  const keys = [...new Set([...shown.values()].map((v) => v.key).filter(Boolean))].sort();
  const keysKey = keys.join("\n");
  useEffect(() => live.showIndicators(keys), [keysKey]);
  useEffect(() => () => live.showIndicators([]), []);

  // The listener is made once; it reads the latest queries and values.
  const latest = useRef({ queries, shown });
  latest.current = { queries, shown };
  useEffect(
    () =>
      live.onIndicators((changed) => {
        for (const { id, query } of latest.current.queries) {
          const answer = latest.current.shown.get(id);
          if (!answer || !changed.includes(answer.key)) continue;
          // Joined only onto values of the same query: settings changed meanwhile fetch their own.
          get<IndicatorValuesAnswer>(`/api/indicators/values?${query}&limit=${TAIL_VALUES}`).then(
            (tail) => store(id, query, (old) => old && withTail(old, tail)),
            () => {},
          );
        }
      }),
    [],
  );
  return shown;
}

/** No values, and why: shown as Failed in the legend, or Not available. */
function refused(e: Error): IndicatorValuesAnswer {
  const notAvailable = e instanceof ApiError && e.notAvailable;
  return { key: "", package: "", version: "", outputs: {}, complete: true, failed: e.message, stale: false, ...(notAvailable ? { notAvailable } : {}) };
}

/** The values with the latest few fetched again put on in place of their times. */
function withTail(old: IndicatorValuesAnswer, tail: IndicatorValuesAnswer): IndicatorValuesAnswer {
  const outputs: IndicatorValuesAnswer["outputs"] = {};
  for (const [id, points] of Object.entries(tail.outputs)) {
    const from = points[0]?.time ?? Infinity;
    outputs[id] = [...(old.outputs[id] ?? []).filter((p) => p.time < from).map(({ complete, ...p }) => p), ...points];
  }
  return { ...tail, outputs, complete: old.complete };
}

/** The remembered feed (or the one a `#/charts?feed=` link chose) while the bridge knows it, else the first feed listed. */
function chosenFeed(snapshot: BridgeSnapshot | undefined, remembered: string | undefined, groups: FeedGroup[]): FeedSnapshot | undefined {
  return snapshot?.feeds.find((f) => f.feed === remembered) ?? groups[0]?.feeds[0];
}

/** The packages this window's chart uses, as its view memory has them (for the Indicators page's count). */
export function rememberedChartPackages(): string[] {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(MEMORY_KEY);
  } catch {
    // None known.
  }
  return chartPackages(readChartMemory(stored));
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
 * The feed's candles from /api/candles, fetched again when the feed or period changes, when a new bucket opens,
 * after a reconnect and while the server is getting the EA's bars; between fetches the forming candle follows the live
 * quote.
 */
function useCandles(feed: FeedSnapshot | undefined, period: Period, live: Live): { data?: CandlesAnswer; loadOlder: () => void } {
  const [data, setData] = useState<CandlesAnswer>();
  const [reload, setReload] = useState(0);
  const id = feed?.feed;
  const url = (before?: number) => `/api/candles?feed=${encodeURIComponent(id!)}&period=${period}&limit=${PAGE_BARS}${before === undefined ? "" : `&before=${before}`}`;
  const same = (a: CandlesAnswer | undefined, b: CandlesAnswer) => a?.feed === b.feed && a.period === b.period;

  useEffect(() => {
    if (!id || live.status !== "live") return;
    let current = true;
    get<CandlesAnswer>(url()).then(
      // The latest page again (a new bucket, a reconnect): the older bars scrolled back to stay.
      (answer) =>
        current &&
        setData((old) => (same(old, answer) ? mergeLatest(old!, answer) : answer)),
      () => current && setData(undefined),
    );
    return () => {
      current = false;
    };
  }, [id, period, reload, live.status]);

  const filling = data?.feed === id && data?.period === period && data?.filling;
  useEffect(() => {
    if (!filling) return;
    // Not a timeout per answer: the forming candle replaces the answer on every quote.
    const timer = setInterval(() => setReload((n) => n + 1), FILLING_RELOAD_MS);
    return () => clearInterval(timer);
  }, [filling]);

  // The chart asks as it scrolls; one page at a time, for what is shown now.
  const shown = useRef(data);
  shown.current = data && data.feed === id && data.period === period ? data : undefined;
  const loading = useRef(false);
  // The view may move again before the page it asked for is drawn: never ask twice for the same one.
  const asked = useRef("");
  const loadOlder = () => {
    const now = shown.current;
    if (!now || now.complete || !now.candles.length || loading.current) return;
    const page = url(now.candles[0].time);
    if (page === asked.current) return;
    asked.current = page;
    loading.current = true;
    get<CandlesAnswer>(page)
      .then(
        (page) => setData((d) => (d && same(d, page) ? { ...d, candles: prependOlder(d.candles, page.candles), complete: page.complete } : d)),
        // It may be asked for again.
        () => (asked.current = ""),
      )
      .finally(() => (loading.current = false));
  };

  const latest = feed?.latest;
  // Every snapshot is a new object: follow the quote only when it moved.
  useEffect(() => {
    if (!latest || !data || data.feed !== id || data.period !== period) return;
    const next = followQuote(data.candles, period, latest, feed?.clockRule ?? data.clockRule);
    // From the candles as they are now: an answer may have come in since this render (the EA's bars filling the chart),
    // and effects run after the next paint.
    if (next.candles !== data.candles || data.ask !== latest.ask) {
      setData((d) => {
        if (!d || d.feed !== id || d.period !== period) return d;
        const now = d === data ? next : followQuote(d.candles, period, latest, feed?.clockRule ?? d.clockRule);
        return { ...d, candles: now.candles as Candle[], ask: latest.ask };
      });
    }
    if (next.newBucket) setReload((n) => n + 1);
  }, [latest?.bid, latest?.ask, latest?.quoteTime]);

  return { data: shown.current, loadOlder };
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
