// Indicators on the chart (pure): which package each is, its parameters and its outputs' colours, as the view
// remembers them; the label, digits and settings form drawn from the package's manifest. The values themselves come
// from the server (ADR 12): the browser only draws them.
import type { Candle } from "../../server/candles/index.js";
import type { ChartScheme } from "./chart-scheme.js";
import type { IndicatorLine } from "./chart-model.js";
import type { IndicatorValuesAnswer, ValuePoint } from "../../server/indicators/index.js";
import { ManifestError, parameterValues, valuesFromText, type Manifest, type ParameterValues } from "../../shared/indicator-manifest.js";

export type { IndicatorValuesAnswer, ValuePoint };

/**
 * An indicator on the chart: a package with its parameters, and its outputs' colours. `colours` gives each line's or
 * single-colour histogram's series palette index by output id; a two-colour histogram's rising and falling bars are
 * Uptick and Downtick unless swapped, kept as `<output>.rising` and `<output>.falling`.
 */
export type IndicatorSpec = { id: string; package: string; parameters: ParameterValues; colours: Record<string, ColourChoice> };

/** A series palette index, or the Uptick or Downtick colour. */
export type ColourChoice = number | "up" | "down";

/** A package as /api/indicators/packages lists it; `charts`: how many windows' charts use it, as they report. */
export type PackageInfo = { manifest: Manifest; bundled: boolean; enabled: boolean; charts?: number };

/** A chart has at most this many indicators. */
export const MAX_INDICATORS = 8;

/** The palette has four colours. */
export const PALETTE_SIZE = 4;

/** "Moving average 20 Simple", "RSI 14", "MACD 12 26 9": the package's name, then each parameter's value. */
export function indicatorLabel(manifest: Manifest, parameters: ParameterValues): string {
  const values = manifest.parameters.map((p) => {
    const value = parameters[p.id] ?? p.default;
    return p.type === "choice" ? (p.choices.find((c) => c.value === value)?.label ?? String(value)) : String(value);
  });
  return [manifest.name, ...values].join(" ");
}

/**
 * A new indicator's palette colours: each output takes the colour least used by the outputs already drawn and the
 * ones before it, first in palette order.
 */
export function newColours(manifest: Manifest, indicators: readonly { colours: Record<string, ColourChoice> }[]): Record<string, number> {
  const uses = Array<number>(PALETTE_SIZE).fill(0);
  for (const i of indicators) for (const c of Object.values(i.colours)) if (typeof c === "number") uses[c % PALETTE_SIZE]++;
  const colours: Record<string, number> = {};
  for (const o of manifest.outputs) {
    // Uptick and Downtick colour it.
    if (twoTone(o)) continue;
    const colour = uses.indexOf(Math.min(...uses));
    colours[o.id] = colour;
    uses[colour]++;
  }
  return colours;
}

/** A histogram whose palette has rising and falling bars: they are drawn in Uptick and Downtick. */
export function twoTone(output: Manifest["outputs"][number]): boolean {
  return output.render === "histogram" && output.palette !== undefined && "rising" in output.palette && "falling" in output.palette;
}

/** The indicator with a two-colour histogram's rising and falling colours swapped (from the legend), or swapped back. */
export function swapTones(spec: IndicatorSpec, output: string): IndicatorSpec {
  const { [`${output}.rising`]: rising, [`${output}.falling`]: _, ...others } = spec.colours;
  return { ...spec, colours: rising === "down" ? others : { ...others, [`${output}.rising`]: "down", [`${output}.falling`]: "up" } };
}

/** The indicator with one output's colour changed (from the legend). */
export function withColour(spec: IndicatorSpec, output: string, colour: number): IndicatorSpec {
  return { ...spec, colours: { ...spec.colours, [output]: colour } };
}

/** A fixed-range pane (RSI's 0–100) reads in 2 decimals; anything else in the market's digits. */
export function indicatorDigits(manifest: Manifest, marketDigits: number): number {
  return manifest.range ? 2 : marketDigits;
}

/** The value at each candle, by time; undefined where the server has none. */
export function valuesByCandle(candles: readonly Candle[], points: readonly ValuePoint[] | undefined): (number | undefined)[] {
  const at = new Map((points ?? []).map((p) => [p.time, p.value]));
  return candles.map((c) => at.get(c.time) ?? undefined);
}

/** The settings form's text for each parameter, checked against the manifest: its values, or the first problem. */
export function checkSettings(manifest: Manifest, texts: Record<string, string>): { ok: true; values: ParameterValues } | { ok: false; error: string } {
  const given = valuesFromText(manifest, Object.fromEntries(manifest.parameters.map((p) => [p.id, texts[p.id] ?? ""])));
  try {
    return { ok: true, values: parameterValues(manifest, given) };
  } catch (e) {
    if (e instanceof ManifestError) return { ok: false, error: e.message };
    throw e;
  }
}

/** Milestone 2 kept { kind, period, type?, colour }: read as the package it became. */
export function fromMilestone2(value: Record<string, unknown>): IndicatorSpec | undefined {
  const { id, kind, period, type, colour } = value;
  // Milestone 2's periods were 1 to 500, as the packages' are.
  if (typeof id !== "string" || !(typeof period === "number" && Number.isInteger(period) && period >= 1 && period <= 500)) return undefined;
  if (!(typeof colour === "number" && Number.isInteger(colour) && colour >= 0 && colour < PALETTE_SIZE)) return undefined;
  if (kind === "rsi") return { id, package: "quotebridge.rsi", parameters: { period }, colours: { rsi: colour } };
  if (kind === "ma" && (type === "simple" || type === "exponential")) return { id, package: "quotebridge.ma", parameters: { period, type }, colours: { ma: colour } };
  return undefined;
}

/** An indicator as the view keeps it; its parameters are checked against the manifest when drawn. */
export function isIndicatorSpec(value: unknown): value is IndicatorSpec {
  if (typeof value !== "object" || value === null) return false;
  const i = value as Record<string, unknown>;
  if (typeof i.id !== "string" || typeof i.package !== "string") return false;
  const record = (v: unknown, ok: (x: unknown) => boolean) => typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every(ok);
  return (
    record(i.parameters, (v) => (typeof v === "number" && Number.isFinite(v)) || typeof v === "string") &&
    record(i.colours, (v) => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < PALETTE_SIZE) || v === "up" || v === "down")
  );
}

/**
 * An indicator to draw, from its package's manifest: on the price pane or its own, with dashed levels and a fixed
 * range there; each output with its colour and one value per candle. `key` names the settings its values were
 * computed with: other settings draw every point again.
 */
export type IndicatorDraw = {
  id: string;
  key: string;
  pane: boolean;
  levels: readonly number[];
  range?: { min: number; max: number };
  digits: number;
  /** A pane with a histogram has a line at zero. */
  zeroLine: boolean;
  /** `colours`: a histogram's colour per candle, where its bars differ. */
  outputs: readonly { id: string; render: "line" | "histogram"; colour: string; colours?: readonly (string | undefined)[]; values: readonly (number | undefined)[] }[];
};

/**
 * Each indicator's draw for the canvas and line for the legend: its outputs' values at the candles (UTC, as fetched),
 * lines and single-colour histograms in their palette colours, a two-colour histogram's bars in Uptick and Downtick
 * (or swapped), all greyed while the values are stale. An indicator whose package is disabled or gone is Not
 * available: in the legend, drawing nothing. Indicators whose values are not here yet are left out.
 */
export function drawnIndicators(
  specs: readonly IndicatorSpec[],
  packages: ReadonlyMap<string, PackageInfo>,
  values: ReadonlyMap<string, IndicatorValuesAnswer>,
  candles: readonly Candle[],
  digits: number,
  scheme: ChartScheme,
): { draws: IndicatorDraw[]; lines: IndicatorLine[] } {
  const draws: IndicatorDraw[] = [];
  const lines: IndicatorLine[] = [];
  for (const spec of specs) {
    const info = packages.get(spec.package);
    const manifest = info?.manifest;
    if (!info?.enabled) {
      // Before the list is in, nothing is known to be missing.
      if (packages.size) lines.push({ id: spec.id, label: manifest ? indicatorLabel(manifest, spec.parameters) : spec.package, digits, outputs: [], notAvailable: true });
      continue;
    }
    const answer = values.get(spec.id);
    if (!manifest || !answer) continue;
    const places = indicatorDigits(manifest, digits);
    const choice = (c: ColourChoice | undefined, fallback: ColourChoice): string => {
      const chosen = c ?? fallback;
      return answer.stale ? scheme.level : chosen === "up" ? scheme.rising : chosen === "down" ? scheme.falling : scheme.series[chosen % scheme.series.length];
    };
    const outputs = manifest.outputs.map((o) => {
      const colour = choice(spec.colours[o.id], 0);
      const values = valuesByCandle(candles, answer.outputs[o.id]);
      if (!twoTone(o)) return { id: o.id, render: o.render, colour, values };
      const tones = { rising: choice(spec.colours[`${o.id}.rising`], "up"), falling: choice(spec.colours[`${o.id}.falling`], "down") };
      const styles = new Map((answer.outputs[o.id] ?? []).map((p) => [p.time, p.styleKey]));
      const colours = candles.map((c) => {
        const key = styles.get(c.time);
        return key === "rising" || key === "falling" ? tones[key] : undefined;
      });
      return { id: o.id, render: o.render, colour, colours, values, tones };
    });
    draws.push({
      id: spec.id,
      key: JSON.stringify([spec.package, answer.version, spec.parameters]),
      pane: manifest.outputs[0].placement === "pane",
      levels: manifest.levels ?? [],
      range: manifest.range,
      digits: places,
      zeroLine: manifest.outputs.some((o) => o.render === "histogram"),
      outputs: outputs.map(({ tones, ...o }) => o),
    });
    // One output is read by the indicator's name; several by their own labels.
    const labelled = manifest.outputs.length > 1;
    lines.push({
      id: spec.id,
      label: indicatorLabel(manifest, spec.parameters),
      digits: places,
      outputs: outputs.map(({ render, ...o }, n) => ({ ...o, ...(labelled ? { label: manifest.outputs[n].label } : {}) })),
      ...(answer.failed === null ? {} : { failed: answer.failed }),
    });
  }
  return { draws, lines };
}
