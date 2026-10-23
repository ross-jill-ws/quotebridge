// Indicator package manifests: apiVersion 1 as the legacy server defined it, so its packages load unchanged, plus the
// optional fields added since (ADR 12): `closedBarsOnly`, `levels`, `range` and the choice parameter type. `history`
// (the warm-up bars) and parameter labels are now used. Manifest colours are checked but never drawn.

export type NumberParameter = { id: string; label: string; type: "integer" | "number"; default: number; min: number; max: number; lessThan?: string };
/** A list of labelled values; the value is what `calculate` gets. */
export type ChoiceParameter = { id: string; label: string; type: "choice"; default: string; choices: { value: string; label: string }[] };
export type Parameter = NumberParameter | ChoiceParameter;
export type ParameterValues = Record<string, number | string>;

export type Output = {
  id: string;
  label: string;
  kind: "numeric";
  render: "line" | "histogram";
  placement: "overlay" | "pane";
  color: string;
  palette?: Record<string, string>;
  unit: { input: "source" };
  lineWidth?: 1 | 2 | 3 | 4;
  lineStyle?: "solid" | "dashed" | "dotted";
};

/** The warm-up bars before the first one shown: a number, or a parameter's value plus some. */
export type History = { bars: number } | { parameter: string; extra: number };

export type Manifest = {
  apiVersion: 1;
  id: string;
  version: string;
  name: string;
  description: string;
  license: string;
  entry: "calculate.js";
  inputs: [{ id: "source"; label: string; kind: "numeric"; alignment: "exact"; field?: "close" | "median"; history: History }];
  parameters: Parameter[];
  outputs: Output[];
  /** The package gets no forming bar. */
  closedBarsOnly?: boolean;
  /** Dashed horizontal levels on the package's pane. */
  levels?: number[];
  /** A fixed scale for the package's pane. */
  range?: { min: number; max: number };
};

/** A manifest, or a package's parameters, that cannot be used; the message says why. */
export class ManifestError extends Error {}

/** The most warm-up bars a package may declare. */
export const MAX_HISTORY_BARS = 5000;
const MAX_LEVELS = 8;
const RESERVED = ["constructor", "prototype", "__proto__"];

const fail = (message: string): never => {
  throw new ManifestError(message);
};
const object = (v: unknown, what: string): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : fail(`Expected ${what} as an object.`);
const text = (v: unknown, max: number) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e9;
/** Output, palette and choice ids. */
const isId = (v: unknown): v is string => typeof v === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(v) && !RESERVED.includes(v);
/** Parameter ids also keep the legacy packages' capitals after the first letter (`jawShift`). */
const isParameterId = (v: unknown): v is string => typeof v === "string" && /^[a-z][a-zA-Z0-9_]{0,39}$/.test(v) && !RESERVED.includes(v);
const colour = (v: unknown) => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);

function only(v: Record<string, unknown>, allowed: readonly string[], what: string) {
  const extra = Object.keys(v).find((k) => !allowed.includes(k));
  if (extra !== undefined) fail(`Unsupported ${what} field: ${extra}.`);
}

/** The manifest, checked; throws ManifestError with the reason otherwise. */
export function parseManifest(value: unknown): Manifest {
  const v = object(value, "the manifest");
  only(v, ["apiVersion", "id", "version", "name", "description", "license", "entry", "inputs", "parameters", "outputs", "closedBarsOnly", "levels", "range"], "manifest");
  if (v.apiVersion !== 1) fail("Only apiVersion 1 is supported.");
  if (typeof v.version !== "string" || v.version.length > 30 || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(v.version)) fail("Expected version as major.minor.patch.");
  if (typeof v.id !== "string" || !/^[a-z][a-z0-9.-]{0,99}$/.test(v.id)) fail("Expected id as lowercase letters, digits, dots or hyphens, starting with a letter.");
  if (v.entry !== "calculate.js") fail("Expected entry calculate.js.");
  if (!text(v.name, 80) || !text(v.description, 2000) || !text(v.license, 100)) fail("Expected the name, description and license fields.");

  const parameters = Array.isArray(v.parameters) && v.parameters.length <= 12 ? v.parameters.map(parameter) : fail("Expected up to 12 parameters.");
  if (new Set(parameters.map((p) => p.id)).size !== parameters.length) fail("Parameter ids must be unique.");
  for (const p of parameters) {
    if (p.type === "choice" || p.lessThan === undefined) continue;
    const other = parameters.find((o) => o.id === p.lessThan);
    if (!other || other.id === p.id || other.type === "choice" || p.default >= other.default) fail(`Parameter ${p.id} must be less than a number parameter, by default too.`);
  }

  if (!Array.isArray(v.inputs) || v.inputs.length !== 1) fail("Expected exactly one input, the source.");
  const input = object((v.inputs as unknown[])[0], "the input");
  only(input, ["id", "label", "kind", "alignment", "history", "field"], "input");
  if (input.id !== "source" || input.kind !== "numeric" || input.alignment !== "exact" || !text(input.label, 80)) fail("Expected the input as a numeric source with exact alignment.");
  if (input.field !== undefined && input.field !== "close" && input.field !== "median") fail("The source field must be close or median.");
  history(object(input.history, "the input's history"), parameters);

  const outputs = Array.isArray(v.outputs) && v.outputs.length >= 1 && v.outputs.length <= 8 ? v.outputs.map(output) : fail("Expected 1 to 8 outputs.");
  if (new Set(outputs.map((o) => o.id)).size !== outputs.length) fail("Output ids must be unique.");
  if (new Set(outputs.map((o) => o.placement)).size !== 1) fail("Every output must have the same placement.");

  if (v.closedBarsOnly !== undefined && typeof v.closedBarsOnly !== "boolean") fail("closedBarsOnly must be true or false.");
  const pane = outputs[0].placement === "pane";
  if (v.levels !== undefined) {
    if (!pane) fail("Only a pane package can have levels.");
    if (!Array.isArray(v.levels) || v.levels.length > MAX_LEVELS || !v.levels.every(finite)) fail(`Expected levels as up to ${MAX_LEVELS} numbers.`);
  }
  if (v.range !== undefined) {
    if (!pane) fail("Only a pane package can have a range.");
    const range = object(v.range, "the range");
    only(range, ["min", "max"], "range");
    if (!finite(range.min) || !finite(range.max) || range.min >= range.max) fail("Expected range as min below max.");
  }
  // A copy: nothing else holds on to the manifest given.
  return JSON.parse(JSON.stringify(v)) as Manifest;
}

function parameter(item: unknown): Parameter {
  const p = object(item, "a parameter");
  if (!isParameterId(p.id) || !text(p.label, 80)) fail("Expected each parameter with an id and a label.");
  if (p.type === "choice") {
    only(p, ["id", "label", "type", "default", "choices"], "parameter");
    const choices = Array.isArray(p.choices) && p.choices.length >= 1 && p.choices.length <= 16 ? p.choices : fail(`Expected parameter ${p.id} with 1 to 16 choices.`);
    for (const c of choices) {
      const choice = object(c, "a choice");
      only(choice, ["value", "label"], "choice");
      if (!isId(choice.value) || !text(choice.label, 80)) fail(`Expected each choice of ${p.id} with a value and a label.`);
    }
    if (new Set(choices.map((c) => (c as { value: string }).value)).size !== choices.length) fail(`The choices of ${p.id} must be unique.`);
    if (!choices.some((c) => (c as { value: string }).value === p.default)) fail(`The default of ${p.id} must be one of its choices.`);
    return p as ChoiceParameter;
  }
  only(p, ["id", "label", "type", "default", "min", "max", "lessThan"], "parameter");
  if (p.type !== "integer" && p.type !== "number") fail(`Parameter ${p.id} must be an integer, a number or a choice.`);
  for (const k of ["min", "max", "default"]) {
    if (!finite(p[k]) || (p.type === "integer" && !Number.isInteger(p[k]))) fail(`Expected ${k} of ${p.id} as ${p.type === "integer" ? "a whole number" : "a number"}.`);
  }
  const { min, max, default: d } = p as { min: number; max: number; default: number };
  if (min > max || d < min || d > max) fail(`The default of ${p.id} must be within its min and max.`);
  if (p.lessThan !== undefined && !isParameterId(p.lessThan)) fail(`Expected lessThan of ${p.id} as a parameter id.`);
  return p as NumberParameter;
}

function history(h: Record<string, unknown>, parameters: readonly Parameter[]) {
  if ("bars" in h) {
    only(h, ["bars"], "history");
    if (!Number.isInteger(h.bars) || (h.bars as number) < 1 || (h.bars as number) > MAX_HISTORY_BARS) fail(`Expected history bars from 1 to ${MAX_HISTORY_BARS}.`);
    return;
  }
  only(h, ["parameter", "extra"], "history");
  const p = parameters.find((p) => p.id === h.parameter);
  if (!p || p.type !== "integer" || p.min < 1 || !Number.isInteger(h.extra) || (h.extra as number) < 0 || p.max + (h.extra as number) > MAX_HISTORY_BARS) {
    fail(`Expected history as an integer parameter plus extra bars, ${MAX_HISTORY_BARS} at most.`);
  }
}

function output(item: unknown): Output {
  const o = object(item, "an output");
  only(o, ["id", "label", "kind", "render", "placement", "color", "palette", "unit", "lineWidth", "lineStyle"], "output");
  if (!isId(o.id) || !text(o.label, 80) || o.kind !== "numeric") fail("Expected each output with an id, a label and kind numeric.");
  if (o.render !== "line" && o.render !== "histogram") fail(`Output ${o.id} must be a line or a histogram.`);
  if (o.placement !== "overlay" && o.placement !== "pane") fail(`Output ${o.id} must be placed on the overlay or a pane.`);
  if (!colour(o.color)) fail(`Expected color of ${o.id} as #rrggbb.`);
  if (o.palette !== undefined) {
    const palette = object(o.palette, "a palette");
    const entries = Object.entries(palette);
    if (o.render !== "histogram" || entries.length < 1 || entries.length > 16 || entries.some(([key, c]) => !isId(key) || !colour(c))) fail(`Output ${o.id} has an invalid palette.`);
  }
  const unit = object(o.unit, "the unit");
  only(unit, ["input"], "unit");
  if (unit.input !== "source") fail("An output's unit must be the source's.");
  if (o.lineWidth !== undefined && ![1, 2, 3, 4].includes(o.lineWidth as number)) fail(`Output ${o.id} has an invalid line width.`);
  if (o.lineStyle !== undefined && !["solid", "dashed", "dotted"].includes(o.lineStyle as string)) fail(`Output ${o.id} has an invalid line style.`);
  if (o.render !== "line" && (o.lineWidth !== undefined || o.lineStyle !== undefined)) fail(`Only a line output can have a line width or style.`);
  return o as Output;
}

/** The package's parameters with the values given, checked; throws ManifestError with the reason otherwise. */
export function parameterValues(manifest: Manifest, values: Record<string, unknown>): ParameterValues {
  const unknown = Object.keys(values).find((k) => !manifest.parameters.some((p) => p.id === k));
  if (unknown !== undefined) fail(`${manifest.name} has no parameter ${unknown}.`);
  const out: ParameterValues = {};
  for (const p of manifest.parameters) {
    const v = values[p.id];
    if (p.type === "choice") {
      if (!p.choices.some((c) => c.value === v)) fail(`${p.label} must be one of ${p.choices.map((c) => c.value).join(", ")}.`);
      out[p.id] = v as string;
    } else {
      if (typeof v !== "number" || !Number.isFinite(v) || v < p.min || v > p.max || (p.type === "integer" && !Number.isInteger(v))) {
        fail(`${p.label} must be ${p.type === "integer" ? "a whole number" : "a number"} from ${p.min} to ${p.max}.`);
      }
      out[p.id] = v as number;
    }
  }
  for (const p of manifest.parameters) {
    if (p.type !== "choice" && p.lessThan && (out[p.id] as number) >= (out[p.lessThan] as number)) {
      const other = manifest.parameters.find((o) => o.id === p.lessThan)!;
      fail(`${p.label} must be less than ${other.label}.`);
    }
  }
  return out;
}

/**
 * Parameter values as typed (a form, a query string), before parameterValues checks them: a number parameter's text
 * as a number (NaN when it is not one), a choice's as given, and an unknown parameter's as given, to be refused.
 */
export function valuesFromText(manifest: Manifest, texts: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, raw] of Object.entries(texts)) {
    const p = manifest.parameters.find((p) => p.id === id);
    const text = raw.trim();
    out[id] = !p || p.type === "choice" ? text : /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : NaN;
  }
  return out;
}

/** Every parameter at its default. */
export function defaultValues(manifest: Manifest): ParameterValues {
  return Object.fromEntries(manifest.parameters.map((p) => [p.id, p.default]));
}

/** The warm-up bars the package needs before the first value shown, with these parameters. */
export function warmUpBars(manifest: Manifest, values: ParameterValues): number {
  const h = manifest.inputs[0].history;
  return "bars" in h ? h.bars : (values[h.parameter] as number) + h.extra;
}
