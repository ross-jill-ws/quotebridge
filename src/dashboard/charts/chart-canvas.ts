// The chart itself, on TradingView Lightweight Charts (bundled; its attribution is on About › Licences).
// Thin imperative wiring: what is drawn is decided by the pure models (chart-model, chart-scheme, indicators).
import {
  BarSeries,
  CandlestickSeries,
  createChart,
  CrosshairMode,
  LineSeries,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type IPrimitivePaneRenderer,
  type IPrimitivePaneView,
  type ISeriesApi,
  type ISeriesPrimitive,
  type SeriesAttachedParameter,
  type SeriesType,
  type Time,
  type UTCTimestamp,
  type WhitespaceData,
} from "lightweight-charts";
import type { Candle } from "../../server/candles/index.js";
import { latestView, RIGHT_OFFSET, viewAfterSet, type ChartType, type LogicalRange } from "./chart-model.js";
import { COLOUR_TOKENS } from "../colour-tokens.js";
import type { ChartScheme } from "./chart-scheme.js";
import type { IndicatorSpec } from "./indicators.js";

const FONT = "Archivo, Segoe UI, sans-serif";
/** The price pane's share against each indicator pane's 1. */
const PRICE_PANE_STRETCH = 3;
const RSI_LEVELS = [30, 70];
/** RSI values and their scale show two decimal places. */
export const RSI_DIGITS = 2;

/** An indicator to draw: its spec, colour and one value per candle. */
export type IndicatorDraw = { spec: IndicatorSpec; colour: string; values: readonly (number | undefined)[] };

/** `key`: the settings its values were computed with. */
type IndicatorSeries = { kind: IndicatorSpec["kind"]; key: string; series: ISeriesApi<"Line">; levels: IPriceLine[] };

const time = (seconds: number) => seconds as UTCTimestamp;

/** A price scale with `precision` decimal places. */
const priceFormat = (precision: number) => ({ type: "price" as const, precision, minMove: 10 ** -precision });

export class ChartCanvas {
  private readonly chart: IChartApi;
  private scheme: ChartScheme;
  private type: ChartType = "candles";
  private digits = 5;
  private main!: ISeriesApi<SeriesType>;
  private bid?: IPriceLine;
  private ask?: IPriceLine;
  private readonly separators = new DaySeparators();
  private candles: readonly Candle[] = [];
  /** After a live update of the candles, the first index that changed; undefined after a full set. */
  private changedFrom?: number;
  private readonly indicators = new Map<string, IndicatorSeries>();

  /** `onVisibleFrom` gets the logical index of the leftmost visible bar whenever the view moves (negative past the first bar). */
  constructor(container: HTMLElement, scheme: ChartScheme, onCrosshair: (time: number | undefined) => void, onVisibleFrom: (index: number) => void) {
    this.scheme = scheme;
    this.chart = createChart(container, {
      autoSize: true,
      layout: { fontFamily: FONT, fontSize: 12, attributionLogo: false, panes: { enableResize: true } },
      grid: { vertLines: { visible: false } },
      rightPriceScale: { scaleMargins: { top: 0.14, bottom: 0.08 } },
      // The oldest loaded bar stays at the left edge: older ones load before it is reached.
      timeScale: { timeVisible: true, secondsVisible: false, rightOffset: RIGHT_OFFSET, barSpacing: 8, fixLeftEdge: true },
      crosshair: { mode: CrosshairMode.Normal },
    });
    this.chart.subscribeCrosshairMove((param) => onCrosshair(param.time === undefined ? undefined : (param.time as number)));
    this.chart.timeScale().subscribeVisibleLogicalRangeChange((range) => range && onVisibleFrom(range.from));
    // Archivo may still be loading; draw the scales again once it is there.
    void document.fonts?.ready.then(() => this.chart.applyOptions({ layout: { fontFamily: FONT } }));
    this.createMain();
    this.applyScheme();
  }

  setScheme(scheme: ChartScheme) {
    this.scheme = scheme;
    this.applyScheme();
  }

  setType(type: ChartType) {
    if (type === this.type) return;
    this.type = type;
    this.chart.removeSeries(this.main);
    this.createMain();
    this.applyScheme();
    this.main.setData(this.candles.map((c) => this.point(c)));
  }

  setDigits(digits: number) {
    this.digits = digits;
    this.main.applyOptions({ priceFormat: priceFormat(digits) });
    for (const { kind, series } of this.indicators.values()) if (kind === "ma") series.applyOptions({ priceFormat: priceFormat(digits) });
  }

  /**
   * New candles: a list that only moved its forming candle (same bucket, earlier candles untouched) or opened one
   * after it is updated in place; anything else (another period, a fetch) is set again. Older bars put before the
   * loaded ones leave the view where it was, unless it showed all the loaded ones.
   */
  setCandles(candles: readonly Candle[], separators: readonly number[]) {
    const old = this.candles;
    this.candles = candles;
    const n = old.length;
    const live =
      n > 0 && (candles.length === n || candles.length === n + 1) && candles[n - 1].time === old[n - 1].time && (n < 2 || sameCandle(candles[n - 2], old[n - 2]));
    this.changedFrom = live ? n - 1 : undefined;
    if (live) {
      for (let i = n - 1; i < candles.length; i++) this.main.update(this.point(candles[i]));
    } else {
      const view = viewAfterSet(old, candles, this.chart.timeScale().getVisibleLogicalRange());
      this.main.setData(candles.map((c) => this.point(c)));
      if (view) this.setView(view);
    }
    this.separators.set(separators);
    const last = candles.at(-1);
    if (last) this.bid!.applyOptions({ price: last.close });
    this.bid!.applyOptions({ lineVisible: last !== undefined, axisLabelVisible: last !== undefined });
  }

  /** The dashed Ask line; hidden when `ask` is null. */
  setAsk(ask: number | null) {
    if (ask === null) this.ask!.applyOptions({ lineVisible: false });
    else this.ask!.applyOptions({ price: ask, lineVisible: true });
  }

  /**
   * The indicators to draw, with their values for the current candles. A new RSI opens a pane below the others.
   * After a live candle update only the changed points are drawn again.
   */
  setIndicators(draws: readonly IndicatorDraw[]) {
    const wanted = new Set(draws.map((d) => d.spec.id));
    for (const [id, drawn] of this.indicators) {
      if (wanted.has(id)) continue;
      this.chart.removeSeries(drawn.series);
      this.indicators.delete(id);
    }
    for (const { spec, colour, values } of draws) {
      const key = JSON.stringify([spec.kind, spec.period, spec.kind === "ma" ? spec.type : ""]);
      let drawn = this.indicators.get(spec.id);
      const same = drawn?.key === key;
      if (!drawn) {
        drawn = this.createIndicator(spec, key);
        this.indicators.set(spec.id, drawn);
      }
      drawn.key = key;
      drawn.series.applyOptions({ color: colour });
      const points = this.candles.map((c, i): WhitespaceData<Time> | { time: Time; value: number } =>
        values[i] === undefined ? { time: time(c.time) } : { time: time(c.time), value: values[i]! },
      );
      if (same && this.changedFrom !== undefined) for (const point of points.slice(this.changedFrom)) drawn.series.update(point);
      else drawn.series.setData(points);
    }
  }

  /** The top of each indicator's pane (for its legend), by indicator ID; price-pane indicators are left out. */
  paneTops(): Map<string, number> {
    const heights = this.chart.panes().map((p) => p.getHeight());
    const tops = new Map<string, number>();
    for (const [id, { kind, series }] of this.indicators) {
      if (kind !== "rsi") continue;
      const index = series.getPane().paneIndex();
      // Each separator between panes is 1 px.
      tops.set(id, heights.slice(0, index).reduce((sum, h) => sum + h + 1, 0));
    }
    return tops;
  }

  /** The view at the latest bars, as wide as it is, with the usual room after the newest (a view of a few bars has more). */
  scrollToLatest() {
    this.setView(latestView(this.candles.length, this.chart.timeScale().getVisibleLogicalRange()));
  }

  private setView(view: LogicalRange | "latest") {
    if (view === "latest") this.chart.timeScale().scrollToRealTime();
    else this.chart.timeScale().setVisibleLogicalRange(view);
  }

  remove() {
    this.chart.remove();
  }

  private createIndicator(spec: IndicatorSpec, key: string): IndicatorSeries {
    const pane = spec.kind === "rsi" ? this.chart.panes().length : 0;
    const series = this.chart.addSeries(
      LineSeries,
      {
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: spec.kind === "rsi",
        crosshairMarkerVisible: false,
        priceFormat: priceFormat(spec.kind === "rsi" ? RSI_DIGITS : this.digits),
        ...(spec.kind === "rsi" ? { autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) } : {}),
      },
      pane,
    );
    const levels =
      spec.kind === "rsi"
        ? RSI_LEVELS.map((price) => series.createPriceLine({ price, color: this.scheme.level, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: "" }))
        : [];
    if (spec.kind === "rsi") {
      const panes = this.chart.panes();
      panes[0].setStretchFactor(PRICE_PANE_STRETCH);
      panes[pane]?.setStretchFactor(1);
    }
    return { kind: spec.kind, key, series, levels };
  }

  private createMain() {
    const common = { priceLineVisible: false, lastValueVisible: false, priceFormat: priceFormat(this.digits) };
    this.main =
      this.type === "candles"
        ? this.chart.addSeries(CandlestickSeries, common, 0)
        : this.type === "bars"
          ? this.chart.addSeries(BarSeries, { ...common, thinBars: false }, 0)
          : this.chart.addSeries(LineSeries, { ...common, lineWidth: 2, crosshairMarkerVisible: false }, 0);
    this.main.attachPrimitive(this.separators);
    // The current Bid, labelled in ink; the Ask line is optional.
    this.bid = this.main.createPriceLine({ price: 0, lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: "", lineVisible: false });
    this.ask = this.main.createPriceLine({ price: 0, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "Ask", lineVisible: false });
    const last = this.candles.at(-1);
    if (last) this.bid.applyOptions({ price: last.close, lineVisible: true });
  }

  private point(c: Candle) {
    const t = time(c.time);
    return this.type === "line" ? { time: t, value: c.close } : { time: t, open: c.open, high: c.high, low: c.low, close: c.close };
  }

  private applyScheme() {
    const s = this.scheme;
    this.chart.applyOptions({
      layout: { background: { color: s.canvas }, textColor: s.text, panes: { separatorColor: s.line, separatorHoverColor: s.line } },
      grid: { horzLines: { color: s.grid, visible: s.grid !== s.canvas } },
      rightPriceScale: { borderColor: s.line },
      timeScale: { borderColor: s.line },
      crosshair: {
        vertLine: { color: s.crosshair, style: LineStyle.Dashed, width: 1, labelBackgroundColor: s.crosshairLabel },
        horzLine: { color: s.crosshair, style: LineStyle.Dashed, width: 1, labelBackgroundColor: s.crosshairLabel },
      },
    });
    if (this.type === "candles") {
      this.main.applyOptions({
        upColor: s.up.body,
        downColor: s.down.body,
        wickUpColor: s.up.wick,
        wickDownColor: s.down.wick,
        borderUpColor: s.up.border,
        borderDownColor: s.down.border,
        borderVisible: true,
      });
    } else if (this.type === "bars") {
      this.main.applyOptions({ upColor: s.up.border, downColor: s.down.border });
    } else {
      this.main.applyOptions({ color: s.price });
    }
    this.bid?.applyOptions({ color: s.bidLabel, axisLabelColor: s.bidLabel, axisLabelTextColor: s.canvas });
    this.ask?.applyOptions({ color: s.ask });
    for (const { levels } of this.indicators.values()) for (const level of levels) level.applyOptions({ color: s.level });
    this.separators.colour = s.line;
  }
}

/** The same bar, though perhaps another object (display times are recomputed). */
function sameCandle(a: Candle, b: Candle) {
  return a === b || (a.time === b.time && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close);
}

/** MetaTrader's period separators, as fine dashed lines at the first bar of each day (intraday periods only). */
class DaySeparators implements ISeriesPrimitive<Time> {
  colour: string = COLOUR_TOKENS.line[0];
  private times: readonly number[] = [];
  private attachedTo?: SeriesAttachedParameter<Time>;
  private readonly views: readonly IPrimitivePaneView[] = [
    {
      zOrder: () => "bottom",
      renderer: (): IPrimitivePaneRenderer => ({ draw: (target) => this.draw(target) }),
    },
  ];

  attached(param: SeriesAttachedParameter<Time>) {
    this.attachedTo = param;
  }

  detached() {
    this.attachedTo = undefined;
  }

  set(times: readonly number[]) {
    if (times.length === this.times.length && times.every((t, i) => t === this.times[i])) return;
    this.times = times;
    this.attachedTo?.requestUpdate();
  }

  paneViews() {
    return this.views;
  }

  private draw(target: Parameters<IPrimitivePaneRenderer["draw"]>[0]) {
    const timeScale = this.attachedTo?.chart.timeScale();
    if (!timeScale || this.times.length === 0) return;
    target.useBitmapCoordinateSpace(({ context, bitmapSize, horizontalPixelRatio, verticalPixelRatio }) => {
      context.save();
      context.strokeStyle = this.colour;
      context.lineWidth = Math.max(1, Math.floor(horizontalPixelRatio));
      context.setLineDash([3 * verticalPixelRatio, 3 * verticalPixelRatio]);
      context.beginPath();
      for (const t of this.times) {
        const x = timeScale.timeToCoordinate(time(t));
        if (x === null) continue;
        const px = Math.round(x * horizontalPixelRatio) + 0.5;
        context.moveTo(px, 0);
        context.lineTo(px, bitmapSize.height);
      }
      context.stroke();
      context.restore();
    });
  }
}
