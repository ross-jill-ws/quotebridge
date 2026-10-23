// Indicator packages running in the real sandbox (the engine's one call): the bundled Moving average (simple,
// exponential) and RSI with Wilder smoothing, one value per bar and none until there are enough bars; the sandbox's
// limits; and manifest validation, apiVersion 1 with the optional fields.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { bundledPackages, IndicatorEngine, type IndicatorPackage, type RunResult } from "../src/server/indicators/index.js";
import { ManifestError, parameterValues, parseManifest, warmUpBars } from "../src/shared/indicator-manifest.js";

const engine = new IndicatorEngine();
test.after(() => engine.close());

const packages = await bundledPackages();
const pkg = (id: string) => packages.find((p) => p.manifest.id === id)!;

/** Bars one minute apart with these closes. */
const barsOf = (closes: readonly number[]) => closes.map((close, i) => ({ time: 60 * (i + 1), high: close, low: close, close }));

/** One output's values, rounded for comparison with published values; null stays null. */
function values(result: RunResult, output: string, places = 10): (number | null)[] {
  assert.ok(result.ok, result.ok ? "" : result.reason);
  return result.outputs[output].map((p) => (p.value === null ? null : Number(p.value.toFixed(places))));
}

const ma = (closes: number[], period: number, type: "simple" | "exponential") => engine.run(pkg("quotebridge.ma"), barsOf(closes), { period, type });
const rsi = (closes: number[], period: number) => engine.run(pkg("quotebridge.rsi"), barsOf(closes), { period });

test("a simple moving average is the mean of the last n closes, with no value for the first n-1 bars", async () => {
  assert.deepEqual(values(await ma([1, 2, 3, 4, 5], 3, "simple"), "ma"), [null, null, 2, 3, 4]);
  assert.deepEqual(values(await ma([1.1, 1.3, 1.2, 1.6], 2, "simple"), "ma", 6), [null, 1.2, 1.25, 1.4]);
});

test("each value is at its bar's time", async () => {
  const result = await ma([1, 2, 3], 2, "simple");
  assert.ok(result.ok);
  assert.deepEqual(result.outputs.ma.map((p) => p.time), [60, 120, 180]);
});

test("an exponential moving average starts from the simple average of its first n closes, then weights each close by 2/(n+1)", async () => {
  // n = 3: k = 0.5. Seed (2+4+6)/3 = 4; then 8·0.5 + 4·0.5 = 6; then 4·0.5 + 6·0.5 = 5.
  assert.deepEqual(values(await ma([2, 4, 6, 8, 4], 3, "exponential"), "ma"), [null, null, 4, 6, 5]);
});

test("a moving average longer than the bars has no value at all", async () => {
  assert.deepEqual(values(await ma([1, 2], 3, "simple"), "ma"), [null, null]);
  assert.deepEqual(values(await ma([1, 2], 3, "exponential"), "ma"), [null, null]);
  assert.deepEqual(values(await ma([], 3, "simple"), "ma"), []);
});

// The 14-period RSI worked example of StockCharts ChartSchool ("Relative Strength Index (RSI)"), whose
// Wilder smoothing is MetaTrader's (closes at its spreadsheet's 4 places): the first average is the mean of 14 changes, then (prev·13 + current)/14.
const CLOSES = [
  44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826, 45.8931, 46.0328, 45.614, 46.282, 46.282, 46.0028, 46.0328, 46.4116, 46.2222,
  45.6439, 46.2122, 46.2521, 45.7137, 46.4515, 45.7835, 45.3548, 44.0288, 44.1783, 44.2181, 44.5672, 43.4205, 42.6628, 43.1314,
];
const PUBLISHED_RSI = [
  70.53, 66.32, 66.55, 69.41, 66.36, 57.97, 62.93, 63.26, 56.06, 62.38, 54.71, 50.42, 39.99, 41.46, 41.87, 45.46, 37.3, 33.08, 37.77,
];

test("RSI matches the published 14-period series, with no value until 14 changes exist", async () => {
  const result = values(await rsi(CLOSES, 14), "rsi", 2);
  assert.equal(result.length, CLOSES.length);
  assert.deepEqual(result.slice(0, 14), Array(14).fill(null));
  assert.deepEqual(result.slice(14), PUBLISHED_RSI);
});

test("RSI is 100 when prices only rose and 50 when they never moved, as MetaTrader draws it", async () => {
  assert.deepEqual(values(await rsi([1, 2, 3, 4], 3), "rsi"), [null, null, null, 100]);
  assert.deepEqual(values(await rsi([1, 1, 1, 1], 3), "rsi"), [null, null, null, 50]);
  assert.deepEqual(values(await rsi([3, 2, 1, 0.5], 3), "rsi"), [null, null, null, 0]);
});

const bollinger = (closes: number[], period: number, deviations: number) => engine.run(pkg("quotebridge.bollinger"), barsOf(closes), { period, deviations });

test("Bollinger bands are the simple average of n closes, plus and minus k population standard deviations", async () => {
  // 2, 4, 4, 4, 5, 5, 7, 9: mean 5, population standard deviation 2 (the sample one would be 2.14).
  const result = await bollinger([2, 4, 4, 4, 5, 5, 7, 9], 8, 2);
  assert.deepEqual(values(result, "middle"), [...Array(7).fill(null), 5]);
  assert.deepEqual(values(result, "upper"), [...Array(7).fill(null), 9]);
  assert.deepEqual(values(result, "lower"), [...Array(7).fill(null), 1]);
  // Period 2 over 1, 3, 5: means 2 and 4, each with a deviation of 1; k = 1.5.
  const short = await bollinger([1, 3, 5], 2, 1.5);
  assert.deepEqual(values(short, "middle"), [null, 2, 4]);
  assert.deepEqual(values(short, "upper"), [null, 3.5, 5.5]);
  assert.deepEqual(values(short, "lower"), [null, 0.5, 2.5]);
});

/** Bars one minute apart around these median prices: high one above, low one below, the close elsewhere. */
const barsAround = (medians: readonly number[]) => medians.map((m, i) => ({ time: 60 * (i + 1), high: m + 1, low: m - 1, close: m + 0.5 }));

test("the Alligator's lines are smoothed averages of the median price, each shifted forward onto later bars", async () => {
  const p = { jaw: 3, jawShift: 2, teeth: 2, teethShift: 1, lips: 1, lipsShift: 0 };
  const result = await engine.run(pkg("quotebridge.alligator"), barsAround([2, 4, 6, 8, 10, 12]), p);
  // Jaw, period 3: the first value is the mean of 2, 4, 6 = 4, then (previous·2 + median)/3: (4·2 + 8)/3 = 16/3;
  // shifted 2 bars on, the first lands on the fifth bar.
  assert.deepEqual(values(result, "jaw"), [null, null, null, null, 4, Number((16 / 3).toFixed(10))]);
  // Teeth, period 2: 3, then (3 + 6)/2 = 4.5, (4.5 + 8)/2 = 6.25, (6.25 + 10)/2 = 8.125; shifted 1.
  assert.deepEqual(values(result, "teeth"), [null, null, 3, 4.5, 6.25, 8.125]);
  // Lips, period 1, no shift: the median itself, not the close.
  assert.deepEqual(values(result, "lips"), [2, 4, 6, 8, 10, 12]);
  // Nothing is put past the last bar.
  assert.ok(result.ok && Object.values(result.outputs).every((points) => points.length === 6 && points.at(-1)!.time === 360));
});

test("the Alligator defaults to MT4's 13/8, 8/5 and 5/3, with labelled parameters", () => {
  const { manifest } = pkg("quotebridge.alligator");
  assert.deepEqual(
    manifest.parameters.map((p) => [p.id, p.label, p.default]),
    [
      ["jaw", "Jaw period", 13],
      ["jawShift", "Jaw shift", 8],
      ["teeth", "Teeth period", 8],
      ["teethShift", "Teeth shift", 5],
      ["lips", "Lips period", 5],
      ["lipsShift", "Lips shift", 3],
    ],
  );
  assert.equal(manifest.inputs[0].field, "median");
  assert.equal(pkg("quotebridge.bollinger").manifest.outputs.every((o) => o.placement === "overlay"), true);
});

test("RSI declares its 0–100 range and dashed 30 and 70 levels; the Moving average draws on the price pane", () => {
  const { manifest } = pkg("quotebridge.rsi");
  assert.deepEqual(manifest.range, { min: 0, max: 100 });
  assert.deepEqual(manifest.levels, [30, 70]);
  assert.equal(manifest.outputs[0].placement, "pane");
  assert.equal(pkg("quotebridge.ma").manifest.outputs[0].placement, "overlay");
});

test("the bundled packages are MIT-licensed and carry their four files", () => {
  for (const id of ["quotebridge.ma", "quotebridge.rsi", "quotebridge.bollinger", "quotebridge.alligator"]) {
    const p = pkg(id);
    assert.equal(p.manifest.license, "MIT");
    assert.match(p.licence, /MIT License/);
    assert.ok(p.readme.length > 0);
    assert.match(p.hash, /^[0-9a-f]{64}$/);
    assert.equal(p.bundled, true);
  }
});

/** A package around `calculate`'s body, with one line output and no parameters. */
function fixture(body: string, manifest: Record<string, unknown> = {}): IndicatorPackage {
  return {
    manifest: {
      apiVersion: 1,
      id: "test.fixture",
      version: "1.0.0",
      name: "Fixture",
      description: "A test package.",
      license: "MIT",
      entry: "calculate.js",
      inputs: [{ id: "source", label: "Close", kind: "numeric", alignment: "exact", field: "close", history: { bars: 1 } }],
      parameters: [],
      outputs: [{ id: "out", label: "Out", kind: "numeric", render: "line", placement: "pane", color: "#ffffff", unit: { input: "source" } }],
      ...manifest,
    } as IndicatorPackage["manifest"],
    code: `exports.calculate = function ({ inputs, parameters, timeline }) { ${body} };`,
    readme: "Fixture",
    licence: "MIT",
    hash: "0".repeat(64),
    bundled: false,
  };
}

const echo = "return { outputs: { out: timeline.map((time, i) => ({ time, value: inputs.source.points[i].value })) } };";

test("a package that loops is stopped after 500 ms, and the engine still runs the next one", { timeout: 15000 }, async () => {
  const started = performance.now();
  const result = await engine.run(fixture("for (;;) {}"), barsOf([1, 2]), {});
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.reason : "", /500 ms/);
  assert.ok(performance.now() - started < 5000);
  assert.deepEqual(values(await engine.run(fixture(echo), barsOf([1, 2]), {}), "out"), [1, 2]);
});

test("a package that throws fails with its message", async () => {
  const result = await engine.run(fixture('throw new Error("no luck");'), barsOf([1]), {});
  assert.deepEqual(result, { ok: false, reason: "The calculation threw: no luck" });
});

test("output that does not match the manifest or the bars is refused", async () => {
  const refused = async (body: string) => {
    const result = await engine.run(fixture(body), barsOf([1, 2]), {});
    assert.equal(result.ok, false, body);
    return !result.ok && result.reason;
  };
  assert.match(await refused("return { outputs: {} };") || "", /outputs/);
  assert.match(await refused("return { outputs: { out: [], other: [] } };") || "", /outputs/);
  assert.match(await refused("return { outputs: { out: [{ time: 61, value: 1 }] } };") || "", /time/);
  assert.match(await refused("return { outputs: { out: [{ time: 60, value: Infinity }] } };") || "", /finite/);
  assert.match(await refused('return { outputs: { out: [{ time: 60, value: "1" }] } };') || "", /value/);
  assert.match(await refused('return { outputs: { out: [{ time: 60, value: 1, styleKey: "rising" }] } };') || "", /styleKey/);
  assert.match(await refused("return 42;") || "", /outputs/);
});

test("a package has no clock, randomness, network or files", async () => {
  const kinds = "return { outputs: { out: timeline.map((time) => ({ time, value: [typeof Date, typeof Math.random, typeof fetch, typeof require, typeof process, typeof XMLHttpRequest].every((t) => t === 'undefined') ? 1 : 0 })) } };";
  assert.deepEqual(values(await engine.run(fixture(kinds), barsOf([1]), {}), "out"), [1]);
});

test("a package that asks for more than 32 MiB fails", { timeout: 15000 }, async () => {
  const result = await engine.run(fixture("const a = []; for (;;) a.push(new Array(100000).fill(1));"), barsOf([1]), {});
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.reason : "", /memory/i);
});

test("a median package gets (high + low) / 2 as its source", async () => {
  const median = fixture(echo, {
    inputs: [{ id: "source", label: "Median", kind: "numeric", alignment: "exact", field: "median", history: { bars: 1 } }],
  });
  assert.deepEqual(values(await engine.run(median, [{ time: 60, high: 3, low: 1, close: 1 }], {}), "out"), [2]);
});

test("tens of thousands of bars run in one call", { timeout: 15000 }, async () => {
  const closes = Array.from({ length: 30_000 }, (_, i) => 1 + (i % 10) / 100);
  const result = values(await ma(closes, 10, "simple"), "ma", 6);
  assert.equal(result.length, 30_000);
  assert.equal(result.at(-1), 1.045);
});

// Manifest validation: the legacy apiVersion 1 as it was, and the optional fields added since.
const LEGACY_MACD = JSON.parse(await readFile(new URL("./fixtures/legacy-macd-manifest.json", import.meta.url), "utf8"));
/** The legacy MACD manifest with some fields changed (undefined removes one). */
const macdWith = (change: Record<string, unknown>) => Object.fromEntries(Object.entries({ ...LEGACY_MACD, ...change }).filter(([, v]) => v !== undefined));
const rsiWith = (change: Record<string, unknown>) => ({ ...pkg("quotebridge.rsi").manifest, ...change });
const refusal = (value: unknown) => assert.throws(() => parseManifest(value), ManifestError);

test("a legacy manifest loads unchanged", () => {
  assert.deepEqual(parseManifest(LEGACY_MACD), LEGACY_MACD);
});

test("closedBarsOnly, levels and range are optional fields of a pane package", () => {
  const manifest = parseManifest(macdWith({ closedBarsOnly: true, levels: [-0.001, 0, 0.001], range: { min: -1, max: 1 } }));
  assert.equal(manifest.closedBarsOnly, true);
  assert.deepEqual(manifest.levels, [-0.001, 0, 0.001]);
  assert.deepEqual(manifest.range, { min: -1, max: 1 });
  refusal(macdWith({ closedBarsOnly: "yes" }));
  refusal(macdWith({ levels: [30, "70"] }));
  refusal(macdWith({ levels: Array(9).fill(1) }));
  refusal(macdWith({ range: { min: 100, max: 0 } }));
  refusal(macdWith({ range: { min: 0, max: 100, step: 1 } }));
  const overlay = pkg("quotebridge.ma").manifest;
  refusal({ ...overlay, levels: [1] });
  refusal({ ...overlay, range: { min: 0, max: 2 } });
});

test("a choice parameter lists labelled values, and its default is one of them", () => {
  assert.deepEqual(pkg("quotebridge.ma").manifest.parameters[1], {
    id: "type",
    label: "Type",
    type: "choice",
    default: "simple",
    choices: [
      { value: "simple", label: "Simple" },
      { value: "exponential", label: "Exponential" },
    ],
  });
  const choice = (p: Record<string, unknown>) => rsiWith({ parameters: [...pkg("quotebridge.rsi").manifest.parameters, { id: "kind", label: "Kind", type: "choice", ...p }] });
  assert.doesNotThrow(() => parseManifest(choice({ default: "a", choices: [{ value: "a", label: "A" }] })));
  refusal(choice({ default: "b", choices: [{ value: "a", label: "A" }] }));
  refusal(choice({ default: "a", choices: [] }));
  refusal(choice({ default: "a", choices: [{ value: "a", label: "A" }, { value: "a", label: "Again" }] }));
  refusal(choice({ default: "a", choices: [{ value: "a" }] }));
});

test("history is a number of bars or a parameter plus extra bars, and sets the warm-up", () => {
  const ma = pkg("quotebridge.ma").manifest;
  assert.equal(warmUpBars(ma, { period: 20, type: "simple" }), 519);
  assert.equal(warmUpBars(parseManifest(rsiWith({ inputs: [{ ...ma.inputs[0], history: { bars: 2000 } }] })), { period: 14 }), 2000);
  refusal(rsiWith({ inputs: [{ ...ma.inputs[0], history: { bars: 0 } }] }));
  refusal(rsiWith({ inputs: [{ ...ma.inputs[0], history: { parameter: "missing", extra: 1 } }] }));
});

test("anything else outside apiVersion 1 is refused", () => {
  refusal(macdWith({ apiVersion: 2 }));
  refusal(macdWith({ colourful: true }));
  refusal(macdWith({ version: "1.0" }));
  refusal(macdWith({ entry: "main.js" }));
  refusal(macdWith({ outputs: [] }));
  refusal(macdWith({ outputs: [LEGACY_MACD.outputs[0], { ...LEGACY_MACD.outputs[1], placement: "overlay" }] }));
  refusal(macdWith({ inputs: [{ ...LEGACY_MACD.inputs[0], field: "open" }] }));
  refusal(macdWith({ parameters: [{ ...LEGACY_MACD.parameters[0], default: 30 }, ...LEGACY_MACD.parameters.slice(1)] }));
  refusal(macdWith({ description: undefined }));
});

test("parameters are checked against the manifest: ranges, whole numbers, choices and lessThan", () => {
  const macd = parseManifest(LEGACY_MACD);
  assert.deepEqual(parameterValues(macd, { fast: 12, slow: 26, signal: 9 }), { fast: 12, slow: 26, signal: 9 });
  assert.throws(() => parameterValues(macd, { fast: 12, slow: 26, signal: 0 }), /signal must be a whole number from 1 to 500/);
  assert.throws(() => parameterValues(macd, { fast: 12.5, slow: 26, signal: 9 }), /whole number/);
  assert.throws(() => parameterValues(macd, { fast: 30, slow: 26, signal: 9 }), /fast must be less than slow/);
  assert.throws(() => parameterValues(macd, { fast: 12, slow: 26, signal: 9, extra: 1 }), /no parameter extra/);
  const ma = pkg("quotebridge.ma").manifest;
  assert.throws(() => parameterValues(ma, { period: 20, type: "weighted" }), /Type must be one of simple, exponential/);
});
