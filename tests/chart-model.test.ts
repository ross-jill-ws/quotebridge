// The Charts view's pure models: colour schemes, the legend, the forming candle, day separators, where the view goes
// when bars come in, and view memory.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { candlesSince, chartLegend, daySeparators, followQuote, mergeLatest, prependOlder, latestView, PAGE_BARS, readChartMemory, showsCandlesSince, viewAfterSet, wantsOlder } from "../src/dashboard/charts/chart-model.js";
import { chartScheme } from "../src/dashboard/charts/chart-scheme.js";
import { COLOUR_TOKENS } from "../src/dashboard/colour-tokens.js";
import {
  checkSettings,
  currentParameters,
  drawnIndicators,
  indicatorDigits,
  indicatorLabel,
  newColours,
  swapTones,
  valuesByCandle,
  withColour,
  type IndicatorValuesAnswer,
  type PackageInfo,
} from "../src/dashboard/charts/indicators.js";
import type { Manifest } from "../src/shared/indicator-manifest.js";

test("Default candles are filled Uptick vivid and Downtick vivid on the surface colour, following the theme", () => {
  const light = chartScheme("default", "light");
  assert.equal(light.canvas, "#ffffff");
  assert.deepEqual(light.up, { body: "#00a86b", wick: "#00a86b", border: "#00a86b" });
  assert.deepEqual(light.down, { body: "#e5384f", wick: "#e5384f", border: "#e5384f" });
  assert.equal(light.bidLabel, "#131a38");
  assert.equal(light.ask, "#d42a3f", "the Ask line is Downtick, the text colour");

  const dark = chartScheme("default", "dark");
  assert.equal(dark.canvas, "#111a2e");
  assert.deepEqual(dark.up, { body: "#2ee6a0", wick: "#2ee6a0", border: "#2ee6a0" });
  assert.deepEqual(dark.down, { body: "#ff5e6e", wick: "#ff5e6e", border: "#ff5e6e" });
  assert.equal(dark.bidLabel, "#e3e8f4");
  assert.equal(dark.crosshair, "#78839e");
});

test("the chart's colours are app.css's tokens: every light-dark() pair there matches the colour module", () => {
  const css = readFileSync(new URL("../src/dashboard/app.css", import.meta.url), "utf8");
  for (const [name, [light, dark]] of Object.entries(COLOUR_TOKENS)) {
    const match = new RegExp(`--${name}:\\s*light-dark\\(\\s*(#[0-9a-f]{6}),\\s*(#[0-9a-f]{6})\\s*\\);`, "i").exec(css);
    assert.ok(match, `app.css defines --${name} as light-dark(#rrggbb, #rrggbb)`);
    assert.deepEqual([match[1].toLowerCase(), match[2].toLowerCase()], [light, dark], `--${name}`);
  }
});

test("Green on black draws hollow bull bars and filled bear bars in green on a black canvas, whatever the theme", () => {
  const scheme = chartScheme("green-on-black", "light");
  assert.equal(scheme.canvas, "#000000");
  assert.deepEqual(scheme.up, { body: "#000000", wick: "#00ff00", border: "#00ff00" });
  assert.deepEqual(scheme.down, { body: "#ffffff", wick: "#00ff00", border: "#00ff00" });
  assert.equal(scheme.price, "#00ff00");
  assert.deepEqual(chartScheme("green-on-black", "dark"), scheme);
});

test("indicator lines take gold, azure, violet and slate in order, and never a price colour", () => {
  assert.deepEqual(chartScheme("default", "light").series, ["#b7791f", "#2f6fb3", "#7a4cc2", "#4a5568"]);
  assert.deepEqual(chartScheme("default", "dark").series, ["#e8b44a", "#6aa8ea", "#b08cf0", "#a3afc2"]);
  for (const colours of ["default", "green-on-black"] as const) {
    for (const mode of ["light", "dark"] as const) {
      const scheme = chartScheme(colours, mode);
      const price = [scheme.up.body, scheme.up.border, scheme.down.body, scheme.down.border, scheme.price];
      for (const colour of scheme.series) assert.ok(!price.includes(colour), `${colours} ${mode}: ${colour}`);
    }
  }
});

const BARS = [
  { time: 3600, open: 0.6512, high: 0.65151, low: 0.651, close: 0.65143 },
  { time: 7200, open: 0.65143, high: 0.652, low: 0.6514, close: 0.65188 },
  { time: 10800, open: 0.65188, high: 0.6519, low: 0.65102, close: 0.6511 },
];
const MA = { id: "a", label: "Moving average 2 Simple", digits: 5, outputs: [{ id: "ma", colour: "#b7791f", values: [undefined, 0.651657, 0.65149] }] };
const RSI = { id: "b", label: "RSI 14", digits: 2, outputs: [{ id: "rsi", colour: "#2f6fb3", values: [undefined, undefined, 41.456] }] };

test("the legend shows the symbol, period and the latest bar's OHLC with the feed's digits", () => {
  const legend = chartLegend({ symbol: "AUDUSD.a", period: "H1", digits: 5, candles: BARS, indicators: [MA, RSI] });
  assert.equal(legend.title, "AUDUSD.a, H1");
  assert.deepEqual(legend.ohlc, [
    { label: "O", value: "0.65188" },
    { label: "H", value: "0.65190" },
    { label: "L", value: "0.65102" },
    { label: "C", value: "0.65110" },
  ]);
  assert.deepEqual(legend.indicators, [
    { id: "a", label: "Moving average 2 Simple", outputs: [{ id: "ma", colour: "#b7791f", value: "0.65149" }] },
    { id: "b", label: "RSI 14", outputs: [{ id: "rsi", colour: "#2f6fb3", value: "41.46" }] },
  ]);
});

test("an indicator that failed says so with the reason, its last good values greyed", () => {
  const failed = { ...RSI, failed: "The calculation took longer than 500 ms." };
  const legend = chartLegend({ symbol: "AUDUSD.a", period: "H1", digits: 5, candles: BARS, indicators: [MA, failed] });
  assert.deepEqual(legend.indicators[1], { id: "b", label: "RSI 14", outputs: [{ id: "rsi", colour: "#2f6fb3", value: "41.46" }], failed: "The calculation took longer than 500 ms." });
  assert.equal(legend.indicators[0].failed, undefined);
});

test("at the crosshair the legend follows the bar under it, and shows a dash where an indicator has no value yet", () => {
  const legend = chartLegend({ symbol: "AUDUSD.a", period: "H1", digits: 5, candles: BARS, indicators: [MA, RSI], time: 7200 });
  assert.deepEqual(legend.ohlc.map((p) => p.value), ["0.65143", "0.65200", "0.65140", "0.65188"]);
  assert.deepEqual(legend.indicators.map((i) => i.outputs[0].value), ["0.65166", "—"]);
});

test("a crosshair time without a bar, or no bars at all, falls back to the latest bar or dashes", () => {
  const between = chartLegend({ symbol: "GOLD", period: "M1", digits: 2, candles: BARS, indicators: [], time: 5000 });
  assert.equal(between.ohlc[3].value, "0.65");
  const empty = chartLegend({ symbol: "GOLD", period: "M1", digits: 2, candles: [], indicators: [MA] });
  assert.equal(empty.title, "GOLD, M1");
  assert.deepEqual(empty.ohlc.map((p) => p.value), ["—", "—", "—", "—"]);
  assert.equal(empty.indicators[0].outputs[0].value, "—");
});

const manifest = (folder: string): Manifest => JSON.parse(readFileSync(new URL(folder, import.meta.url), "utf8"));
const MA_MANIFEST = manifest("../src/server/indicators/bundled/ma/manifest.json");
const RSI_MANIFEST = manifest("../src/server/indicators/bundled/rsi/manifest.json");
const MACD_MANIFEST = manifest("./fixtures/legacy-macd-manifest.json");

test("an indicator is named by its package and parameters, a choice by its label", () => {
  assert.equal(indicatorLabel(MA_MANIFEST, { period: 20, type: "simple" }), "Moving average 20 Simple");
  assert.equal(indicatorLabel(MA_MANIFEST, { period: 50, type: "exponential" }), "Moving average 50 Exponential");
  assert.equal(indicatorLabel(RSI_MANIFEST, { period: 14 }), "RSI 14");
  assert.equal(indicatorLabel(MACD_MANIFEST, { fast: 12, slow: 26, signal: 9 }), "MACD 12 26 9");
});

const BOLLINGER_MANIFEST = manifest("../src/server/indicators/bundled/bollinger/manifest.json");
const ALLIGATOR_MANIFEST = manifest("../src/server/indicators/bundled/alligator/manifest.json");

test("each line of a new indicator takes the least-used palette colour, first in palette order", () => {
  const using = (...colours: number[]) => colours.map((c, i) => ({ colours: { [`o${i}`]: c } }));
  assert.deepEqual(newColours(MA_MANIFEST, []), { ma: 0 });
  assert.deepEqual(newColours(MA_MANIFEST, using(0, 1)), { ma: 2 });
  assert.deepEqual(newColours(MA_MANIFEST, using(1)), { ma: 0 });
  assert.deepEqual(newColours(MA_MANIFEST, using(0, 1, 2, 3, 0)), { ma: 1 });
  // Each line counts the ones before it.
  assert.deepEqual(newColours(BOLLINGER_MANIFEST, []), { middle: 0, upper: 1, lower: 2 });
  assert.deepEqual(newColours(BOLLINGER_MANIFEST, [{ colours: { ma: 0 } }]), { middle: 1, upper: 2, lower: 3 });
  assert.deepEqual(newColours(ALLIGATOR_MANIFEST, [{ colours: { ma: 0 } }, { colours: { middle: 1, upper: 2, lower: 3 } }]), { jaw: 0, teeth: 1, lips: 2 });
});

const LIGHT = chartScheme("default", "light");
const info = (m: Manifest): PackageInfo => ({ manifest: m, bundled: true, enabled: true });
const PACKAGES = new Map([MA_MANIFEST, RSI_MANIFEST, BOLLINGER_MANIFEST, ALLIGATOR_MANIFEST].map((m) => [m.id, info(m)]));
/** The server's answer with these outputs' values at BARS' times. */
const answer = (outputs: Record<string, (number | null)[]>, change: Partial<IndicatorValuesAnswer> = {}): IndicatorValuesAnswer => ({
  key: "k",
  package: "",
  version: "1.0.0",
  outputs: Object.fromEntries(Object.entries(outputs).map(([id, values]) => [id, values.map((value, i) => ({ time: BARS[i].time, value }))])),
  complete: false,
  failed: null,
  stale: false,
  ...change,
});
const BANDS = { id: "bb", package: "quotebridge.bollinger", parameters: { period: 20, deviations: 2 }, colours: { middle: 0, upper: 1, lower: 2 } };
const BAND_VALUES = answer({ middle: [null, 0.6515, 0.65151], upper: [null, 0.6523, 0.652349], lower: [null, 0.6507, 0.650671] });
const legendOf = (drawn: ReturnType<typeof drawnIndicators>, time?: number) => chartLegend({ symbol: "EURUSD", period: "H1", digits: 5, candles: BARS, indicators: drawn.lines, time }).indicators;

test("an indicator with several outputs reads each output's label and value in its colour, in the market's digits", () => {
  const drawn = drawnIndicators([BANDS], PACKAGES, new Map([["bb", BAND_VALUES]]), BARS, 5, LIGHT);
  assert.deepEqual(legendOf(drawn), [
    {
      id: "bb",
      label: "Bollinger Bands 20 2",
      outputs: [
        { id: "middle", label: "Middle", colour: LIGHT.series[0], value: "0.65151" },
        { id: "upper", label: "Upper", colour: LIGHT.series[1], value: "0.65235" },
        { id: "lower", label: "Lower", colour: LIGHT.series[2], value: "0.65067" },
      ],
    },
  ]);
  assert.deepEqual(legendOf(drawn, 3600)[0].outputs.map((o) => o.value), ["—", "—", "—"]);
  // The canvas gets every line on the price pane, in the same colours.
  assert.deepEqual(drawn.draws[0].outputs.map((o) => [o.id, o.render, o.colour]), [
    ["middle", "line", LIGHT.series[0]],
    ["upper", "line", LIGHT.series[1]],
    ["lower", "line", LIGHT.series[2]],
  ]);
  assert.equal(drawn.draws[0].pane, false);
  assert.equal(drawn.draws[0].digits, 5);
});

test("an indicator with one output is read by its name alone, its value after it", () => {
  const sma = { id: "a", package: "quotebridge.ma", parameters: { period: 2, type: "simple" }, colours: { ma: 3 } };
  const drawn = drawnIndicators([sma], PACKAGES, new Map([["a", answer({ ma: [null, 0.651657, 0.65149] })]]), BARS, 5, LIGHT);
  assert.deepEqual(legendOf(drawn), [{ id: "a", label: "Moving average 2 Simple", outputs: [{ id: "ma", colour: LIGHT.series[3], value: "0.65149" }] }]);
});

test("a colour chosen from the legend is kept in the view memory and drawn in its place", () => {
  const chosen = withColour(BANDS, "upper", 3);
  assert.deepEqual(chosen.colours, { middle: 0, upper: 3, lower: 2 });
  assert.deepEqual(readChartMemory(JSON.stringify({ indicators: [chosen] })).indicators, [chosen]);
  const drawn = drawnIndicators([chosen], PACKAGES, new Map([["bb", BAND_VALUES]]), BARS, 5, chartScheme("default", "dark"));
  assert.deepEqual(legendOf(drawn)[0].outputs.map((o) => o.colour), ["#e8b44a", "#a3afc2", "#b08cf0"]);
});

const AO_MANIFEST = manifest("../src/server/indicators/bundled/ao/manifest.json");
const MACD_BUNDLED = manifest("../src/server/indicators/bundled/macd/manifest.json");
const EO_MANIFEST = manifest("../src/server/indicators/bundled/eo/manifest.json");
const HISTOGRAMS = new Map([AO_MANIFEST, MACD_BUNDLED, EO_MANIFEST].map((m) => [m.id, info(m)]));
const AO = { id: "ao", package: "quotebridge.ao", parameters: { fast: 5, slow: 34 }, colours: {} };
/** AO's answer: no value at the first bar, then a rising and a falling bar. */
const AO_VALUES: IndicatorValuesAnswer = {
  ...answer({}),
  outputs: { ao: [{ time: 3600, value: null }, { time: 7200, value: 0.0012, styleKey: "rising" }, { time: 10800, value: -0.0003, styleKey: "falling" }] },
};

test("a histogram's rising and falling bars are Uptick and Downtick, following the theme and Green on black, and its legend value takes its bar's colour", () => {
  assert.deepEqual(newColours(AO_MANIFEST, []), {}, "no palette colour for a two-colour histogram");
  for (const [scheme, up, down] of [
    [LIGHT, "#00a86b", "#e5384f"],
    [chartScheme("default", "dark"), "#2ee6a0", "#ff5e6e"],
    [chartScheme("green-on-black", "light"), "#00ff00", "#ff0000"],
  ] as const) {
    const drawn = drawnIndicators([AO], HISTOGRAMS, new Map([["ao", AO_VALUES]]), BARS, 5, scheme);
    assert.deepEqual(drawn.draws[0].outputs[0].colours, [undefined, up, down]);
    assert.deepEqual(legendOf(drawn)[0].outputs[0].colour, down, "the latest bar fell");
    assert.deepEqual(legendOf(drawn, 7200)[0].outputs[0].colour, up, "the crosshair's bar rose");
    assert.deepEqual(legendOf(drawn)[0].outputs[0].tones, { rising: up, falling: down });
  }
});

test("a single-colour histogram takes a palette colour, as a line does", () => {
  assert.deepEqual(newColours(MACD_BUNDLED, [{ colours: { ma: 0 } }]), { macd: 1, signal: 2 });
  assert.deepEqual(newColours(EO_MANIFEST, []), { eo: 0 }, "EO's line only");
  const macd = { id: "m", package: "quotebridge.macd", parameters: { fast: 12, slow: 26, signal: 9 }, colours: { macd: 1, signal: 2 } };
  const drawn = drawnIndicators([macd], HISTOGRAMS, new Map([["m", answer({ macd: [null, 0.0004, 0.0002], signal: [null, null, 0.0003] })]]), BARS, 5, LIGHT);
  assert.deepEqual(drawn.draws[0].outputs.map((o) => [o.colour, o.colours]), [
    [LIGHT.series[1], undefined],
    [LIGHT.series[2], undefined],
  ]);
  assert.deepEqual(legendOf(drawn)[0], {
    id: "m",
    label: "MACD 12 26 9",
    outputs: [
      { id: "macd", label: "MACD", colour: LIGHT.series[1], value: "0.00020" },
      { id: "signal", label: "Signal", colour: LIGHT.series[2], value: "0.00030" },
    ],
  });
});

test("a histogram's two colours swap from the legend, kept in view memory, and swap back", () => {
  const swapped = swapTones(AO, "ao");
  assert.deepEqual(readChartMemory(JSON.stringify({ indicators: [swapped] })).indicators, [swapped]);
  const drawn = drawnIndicators([swapped], HISTOGRAMS, new Map([["ao", AO_VALUES]]), BARS, 5, LIGHT);
  assert.deepEqual(drawn.draws[0].outputs[0].colours, [undefined, LIGHT.falling, LIGHT.rising]);
  assert.deepEqual(swapTones(swapped, "ao").colours, {});
});

test("an indicator pane with a histogram gets a zero line; one with lines only does not", () => {
  const drawn = drawnIndicators([AO], HISTOGRAMS, new Map([["ao", AO_VALUES]]), BARS, 5, LIGHT);
  assert.equal(drawn.draws[0].zeroLine, true);
  assert.equal(drawn.draws[0].pane, true);
  const bands = drawnIndicators([BANDS], PACKAGES, new Map([["bb", BAND_VALUES]]), BARS, 5, LIGHT);
  assert.equal(bands.draws[0].zeroLine, false);
});

test("an indicator whose package is disabled or gone stays in the legend, Not available, and draws nothing", () => {
  const rsi = { id: "r", package: "quotebridge.rsi", parameters: { period: 9 }, colours: { rsi: 1 } };
  const gone = { id: "g", package: "acme.thing", parameters: { length: 3 }, colours: { out: 0 } };
  const disabled = new Map([...PACKAGES, ["quotebridge.rsi", { ...info(RSI_MANIFEST), enabled: false }]]);
  const values = new Map([["r", answer({ rsi: [null, 40, 50] })]]);
  const drawn = drawnIndicators([rsi, gone, BANDS], disabled, new Map([...values, ["bb", BAND_VALUES]]), BARS, 5, LIGHT);
  assert.deepEqual(drawn.draws.map((d) => d.id), ["bb"]);
  assert.deepEqual(legendOf(drawn).slice(0, 2), [
    { id: "r", label: "RSI 9", outputs: [], notAvailable: true },
    { id: "g", label: "acme.thing", outputs: [], notAvailable: true },
  ]);
  // The chart endpoint said so before the package list did.
  const refused = drawnIndicators([rsi], PACKAGES, new Map([["r", { ...answer({}), notAvailable: true as const }]]), BARS, 5, LIGHT);
  assert.deepEqual(legendOf(refused), [{ id: "r", label: "RSI 9", outputs: [], notAvailable: true }]);
  // Enabled again: drawn as before.
  const back = drawnIndicators([rsi], PACKAGES, values, BARS, 5, LIGHT);
  assert.deepEqual(legendOf(back), [{ id: "r", label: "RSI 9", outputs: [{ id: "rsi", colour: LIGHT.series[1], value: "50.00" }] }]);
});

test("a failed indicator's last good values are greyed, every output alike", () => {
  const drawn = drawnIndicators([BANDS], PACKAGES, new Map([["bb", { ...BAND_VALUES, failed: "The calculation threw: no", stale: true }]]), BARS, 5, LIGHT);
  const [row] = legendOf(drawn);
  assert.equal(row.failed, "The calculation threw: no");
  assert.deepEqual(row.outputs.map((o) => o.colour), [LIGHT.level, LIGHT.level, LIGHT.level]);
});

test("values on a fixed range read in 2 decimals, others in the market's digits", () => {
  assert.equal(indicatorDigits(RSI_MANIFEST, 5), 2);
  assert.equal(indicatorDigits(MA_MANIFEST, 5), 5);
  assert.equal(indicatorDigits(MA_MANIFEST, 3), 3);
});

test("the server's values are put at their candles; a candle without one has none", () => {
  const points = [
    { time: 7200, value: 0.6516 },
    { time: 10800, value: null },
    { time: 99999, value: 1 },
  ];
  assert.deepEqual(valuesByCandle(BARS, points), [undefined, 0.6516, undefined]);
  assert.deepEqual(valuesByCandle(BARS, undefined), [undefined, undefined, undefined]);
});

test("the settings form takes values within each parameter's range, a choice among its values, and fast below slow", () => {
  assert.deepEqual(checkSettings(MA_MANIFEST, { period: "50", type: "exponential" }), { ok: true, values: { period: 50, type: "exponential" } });
  assert.deepEqual(checkSettings(MA_MANIFEST, { period: " 7 ", type: "simple" }), { ok: true, values: { period: 7, type: "simple" } });
  assert.deepEqual(checkSettings(MA_MANIFEST, { period: "0", type: "simple" }), { ok: false, error: "Period must be a whole number from 1 to 500." });
  assert.deepEqual(checkSettings(MA_MANIFEST, { period: "501", type: "simple" }), { ok: false, error: "Period must be a whole number from 1 to 500." });
  assert.deepEqual(checkSettings(MA_MANIFEST, { period: "2.5", type: "simple" }), { ok: false, error: "Period must be a whole number from 1 to 500." });
  assert.deepEqual(checkSettings(MA_MANIFEST, { period: "", type: "simple" }), { ok: false, error: "Period must be a whole number from 1 to 500." });
  assert.deepEqual(checkSettings(MA_MANIFEST, { period: "20", type: "weighted" }), { ok: false, error: "Type must be one of simple, exponential." });
  assert.deepEqual(checkSettings(MACD_MANIFEST, { fast: "26", slow: "12", signal: "9" }), { ok: false, error: "fast must be less than slow." });
});

const H = 3600;
const DAY = 86400;

test("a quote in the forming candle's bucket moves its high, low and close", () => {
  const candles = [{ time: 10 * H, open: 1.1, high: 1.2, low: 1.05, close: 1.15 }];
  const up = followQuote(candles, "H1", { bid: 1.25, quoteTime: 10 * H + 3599 });
  assert.equal(up.newBucket, false);
  assert.deepEqual(up.candles, [{ time: 10 * H, open: 1.1, high: 1.25, low: 1.05, close: 1.25 }]);
  const down = followQuote(up.candles, "H1", { bid: 1.0, quoteTime: 10 * H + 3599 });
  assert.deepEqual(down.candles.at(-1), { time: 10 * H, open: 1.1, high: 1.25, low: 1.0, close: 1.0 });
  assert.deepEqual(candles[0].close, 1.15, "the old list is not changed");
});

test("a quote in a later bucket opens a new candle and asks for the list again; an older quote changes nothing", () => {
  const candles = [{ time: 10 * H, open: 1.1, high: 1.2, low: 1.05, close: 1.15 }];
  const next = followQuote(candles, "H1", { bid: 1.3, quoteTime: 11 * H + 5 });
  assert.equal(next.newBucket, true);
  assert.deepEqual(next.candles.at(-1), { time: 11 * H, open: 1.3, high: 1.3, low: 1.3, close: 1.3 });
  const old = followQuote(candles, "H1", { bid: 9, quoteTime: 9 * H });
  assert.equal(old.newBucket, false);
  assert.equal(old.candles, candles);
  assert.equal(followQuote([], "M1", { bid: 1, quoteTime: 120 }).newBucket, true);
});

test("with H4 buckets from 01:00 (offset 3600), a quote at 12:59 moves the 09:00 candle and one at 13:00 opens the next", () => {
  const candles = [{ time: 9 * H, open: 1.1, high: 1.2, low: 1.05, close: 1.15 }];
  const same = followQuote(candles, "H4", { bid: 1.25, quoteTime: 13 * H - 1 }, null, 3600);
  assert.equal(same.newBucket, false);
  assert.deepEqual(same.candles, [{ time: 9 * H, open: 1.1, high: 1.25, low: 1.05, close: 1.25 }]);
  const next = followQuote(candles, "H4", { bid: 1.3, quoteTime: 13 * H }, null, 3600);
  assert.equal(next.newBucket, true);
  assert.equal(next.candles.at(-1)!.time, 13 * H);
});

test("intraday periods get a separator at the first bar of each new day; daily and longer periods none", () => {
  const candles = [22 * H, 23 * H, DAY + 1 * H, DAY + 2 * H, 3 * DAY].map((time) => ({ time, open: 1, high: 1, low: 1, close: 1 }));
  assert.deepEqual(daySeparators(candles, "H1"), [DAY + H, 3 * DAY]);
  assert.deepEqual(daySeparators(candles, "D1"), []);
  assert.deepEqual(daySeparators([], "M5"), []);
});

test("the view remembers its symbol, period, type, Ask line and indicators, and reads anything else as the defaults", () => {
  const stored = { feed: "t1|CMC|AUDUSD.a", period: "H4", type: "bars", askLine: true, indicators: [{ id: "x", package: "quotebridge.rsi", parameters: { period: 9 }, colours: { rsi: 1 } }] };
  assert.deepEqual(readChartMemory(JSON.stringify(stored)), stored);
  const defaults = { period: "M1", type: "candles", askLine: false, indicators: [] };
  assert.deepEqual(readChartMemory(null), defaults);
  assert.deepEqual(readChartMemory("not json"), defaults);
  assert.deepEqual(readChartMemory(JSON.stringify({ period: "H2", type: "area", askLine: "yes", indicators: "none" })), defaults);
  const mixed = [
    { id: "a", package: "quotebridge.ma", parameters: { period: 20, type: "exponential" }, colours: { ma: 0 } },
    { id: "b", package: "quotebridge.ma", parameters: { period: {} }, colours: { ma: 0 } },
    { id: "c", package: "quotebridge.rsi", parameters: { period: 14 }, colours: { rsi: 9 } },
    { id: "d", package: 7, parameters: {}, colours: {} },
    { package: "quotebridge.rsi", parameters: {}, colours: {} },
  ];
  assert.deepEqual(readChartMemory(JSON.stringify({ indicators: mixed })).indicators, [mixed[0]]);
});

test("Milestone 2's indicators are read as their packages: ma with its period and type, rsi with its period", () => {
  const m2 = [
    { id: "a", colour: 0, kind: "ma", period: 20, type: "exponential" },
    { id: "b", colour: 2, kind: "rsi", period: 9 },
    { id: "c", colour: 0, kind: "ma", period: 0, type: "simple" },
    { id: "d", colour: 2, kind: "macd", period: 12 },
  ];
  assert.deepEqual(readChartMemory(JSON.stringify({ indicators: m2 })).indicators, [
    { id: "a", package: "quotebridge.ma", parameters: { period: 20, type: "exponential" }, colours: { ma: 0 } },
    { id: "b", package: "quotebridge.rsi", parameters: { period: 9 }, colours: { rsi: 2 } },
  ]);
});

test("a chart keeps at most 8 indicators, the same package several times", () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ id: `i${i}`, package: "quotebridge.ma", parameters: { period: 10 + i, type: "simple" }, colours: { ma: i % 4 } }));
  assert.deepEqual(readChartMemory(JSON.stringify({ indicators: many })).indicators, many.slice(0, 8));
});

test("the chart says since when it has candles, with the date once that is not today", () => {
  const start = new Date(2026, 9, 22, 9, 26, 40).getTime();
  assert.equal(candlesSince(start, new Date(2026, 9, 22, 15, 0).getTime()), "Candles since 09:26 (this computer's clock), when QuoteBridge started.");
  assert.equal(candlesSince(start, new Date(2026, 9, 23, 8, 0).getTime()), "Candles since 22 Oct 09:26 (this computer's clock), when QuoteBridge started.");
});

test("candles are UTC but break on the broker clock: a D1 quote at 10:00 on a GMT+2 broker falls in the bar that opened at 22:00 UTC the day before", () => {
  const rule = { winterOffsetMinutes: 120, dst: "us" as const };
  const day = Date.UTC(2027, 0, 14, 22) / 1000;
  const candles = [{ time: day, open: 1.1, high: 1.2, low: 1.05, close: 1.15 }];
  const brokerTen = Date.UTC(2027, 0, 15, 10) / 1000;
  const same = followQuote(candles, "D1", { bid: 1.25, quoteTime: brokerTen }, rule);
  assert.equal(same.newBucket, false);
  assert.deepEqual(same.candles, [{ time: day, open: 1.1, high: 1.25, low: 1.05, close: 1.25 }]);
  // Broker midnight opens the next bar, at 22:00 UTC.
  const next = followQuote(candles, "D1", { bid: 1.3, quoteTime: Date.UTC(2027, 0, 16) / 1000 }, rule);
  assert.equal(next.newBucket, true);
  assert.equal(next.candles.at(-1)!.time, Date.UTC(2027, 0, 15, 22) / 1000);
});

test("the legend gives the bar's time as the chart shows it: date and minutes intraday, the date alone for D1 and longer", () => {
  assert.equal(chartLegend({ symbol: "AUDUSD.a", period: "H1", digits: 5, candles: BARS, indicators: [] }).time, "1970-01-01 03:00");
  assert.equal(chartLegend({ symbol: "AUDUSD.a", period: "H1", digits: 5, candles: BARS, indicators: [], time: 7200 }).time, "1970-01-01 02:00");
  assert.equal(chartLegend({ symbol: "AUDUSD.a", period: "D1", digits: 5, candles: BARS, indicators: [] }).time, "1970-01-01");
  assert.equal(chartLegend({ symbol: "GOLD", period: "M1", digits: 2, candles: [], indicators: [] }).time, "");
});

const bar = (time: number, close = 1) => ({ time, open: close, high: close, low: close, close });

test("older bars are put before the loaded ones, leaving out any the chart already has", () => {
  assert.deepEqual(prependOlder([bar(300), bar(400)], [bar(100), bar(200), bar(300, 9)]).map((c) => [c.time, c.close]), [
    [100, 1],
    [200, 1],
    [300, 1],
    [400, 1],
  ]);
  assert.deepEqual(prependOlder([], [bar(100)]), [bar(100)]);
});

test("a fresh latest page replaces the loaded bars from its first bar on and keeps the older ones scrolled back to, with whether older still exist", () => {
  const loaded = { candles: [bar(100), bar(200), bar(300), bar(400, 1)], complete: true };
  const merged = mergeLatest(loaded, { candles: [bar(300, 2), bar(400, 3), bar(500, 4)], complete: false });
  assert.equal(merged.complete, true);
  assert.deepEqual(merged.candles.map((c) => [c.time, c.close]), [
    [100, 1],
    [200, 1],
    [300, 2],
    [400, 3],
    [500, 4],
  ]);
  assert.deepEqual(mergeLatest(loaded, { candles: [], complete: true }).candles, [], "a feed with no bars any more");
  const notScrolled = mergeLatest({ candles: [bar(300)], complete: true }, { candles: [bar(300), bar(400)], complete: false });
  assert.equal(notScrolled.complete, false, "nothing older was loaded: the page says");
});

const bars = (first: number, count: number) => Array.from({ length: count }, (_, i) => bar(first + i * 100));

test("a view that showed every bar it had moves to the latest bars once older ones fill it, as wide as it was", () => {
  // Two live candles, then the EA's 900 bars before them: the view showed both (and room around them).
  const live = bars(100_000, 2);
  const filled = [...bars(10_000, 900), ...live];
  assert.deepEqual(viewAfterSet(live, filled, { from: -1, to: 7 }), { from: 899, to: 907 }, "the newest bar 6 from the right edge");
  // A new bucket opened while the bars were on their way: still filled, not scrolled back.
  assert.deepEqual(viewAfterSet(live, [...filled, bar(100_200)], { from: -1, to: 7 }), { from: 900, to: 908 });
  assert.equal(viewAfterSet(live, filled, null), "latest", "a chart not laid out yet scrolls to real time");
});

test("older bars put before a view scrolled back move the view with the bars it showed", () => {
  const loaded = bars(100_000, 500);
  const paged = [...bars(50_000, 500), ...loaded];
  assert.deepEqual(viewAfterSet(loaded, paged, { from: 10, to: 60 }), { from: 510, to: 560 });
  // The newest bar changed too (a fresh page): the indices no longer line up, so the view stays.
  assert.equal(viewAfterSet(loaded, [...paged, bar(150_000)], { from: 10, to: 60 }), null);
});

test("candles set again without older bars before them leave the view alone", () => {
  assert.equal(viewAfterSet([], bars(100, 5), { from: 0, to: 10 }), null, "the first set");
  assert.equal(viewAfterSet(bars(100, 5), bars(100, 7), { from: 0, to: 10 }), null, "a fetch from the same first bar");
  assert.equal(viewAfterSet(bars(100, 5), bars(5_000, 3), { from: 0, to: 10 }), null, "another period");
});

test("Latest keeps the view's width and puts the newest bar 6 from the right edge", () => {
  assert.deepEqual(latestView(500, { from: 100, to: 180 }), { from: 425, to: 505 });
  assert.equal(latestView(500, null), "latest");
});

test("older bars are asked for, 900 at a time, when fewer than 100 remain left of the view, until there are none", () => {
  assert.equal(PAGE_BARS, 900, "MetaTrader's default, and what the EA sends");
  assert.equal(wantsOlder(99, false), true);
  assert.equal(wantsOlder(100, false), false);
  assert.equal(wantsOlder(-20, false), true, "scrolled past the first bar");
  assert.equal(wantsOlder(10, true), false, "complete");
});

test("the Candles since note goes once the chart reaches back before QuoteBridge started", () => {
  const since = Date.UTC(2027, 0, 15, 9, 26);
  assert.equal(showsCandlesSince([], since), true);
  assert.equal(showsCandlesSince([bar(Date.UTC(2027, 0, 15, 9, 26) / 1000)], since), true);
  assert.equal(showsCandlesSince([bar(Date.UTC(2027, 0, 15, 9, 25) / 1000)], since), false);
});

test("panes keep the chart's order while values arrive: an indicator still waiting is drawn empty, not left out", () => {
  const macd = { id: "m", package: "quotebridge.macd", parameters: { fast: 12, slow: 26, signal: 9 }, colours: { macd: 1, signal: 2 } };
  // AO's values came in first.
  const drawn = drawnIndicators([macd, AO], HISTOGRAMS, new Map([["ao", AO_VALUES]]), BARS, 5, LIGHT);
  assert.deepEqual(drawn.draws.map((d) => d.id), ["m", "ao"]);
  assert.ok(drawn.draws[0].outputs.every((o) => o.values.every((v) => v === undefined)));
  // Its legend row waits for its values.
  assert.deepEqual(drawn.lines.map((l) => l.id), ["ao"]);
});

test("after an upgrade an indicator keeps the parameters that still exist; new ones take their defaults, removed ones go", () => {
  const before = { period: 34, smooth: 3 };
  const upgraded: Manifest = {
    ...MA_MANIFEST,
    parameters: [
      { id: "period", label: "Period", type: "integer", default: 14, min: 1, max: 500 },
      { id: "type", label: "Type", type: "choice", default: "simple", choices: [{ value: "simple", label: "Simple" }, { value: "exponential", label: "Exponential" }] },
    ],
  };
  assert.deepEqual(currentParameters(upgraded, before), { period: 34, type: "simple" });
});

test("a kept value the new version no longer allows takes its default; two that break a rule between them, both", () => {
  const narrowed: Manifest = { ...MA_MANIFEST, parameters: [{ id: "period", label: "Period", type: "integer", default: 14, min: 1, max: 100 }] };
  assert.deepEqual(currentParameters(narrowed, { period: 300 }), { period: 14 });
  const ruled: Manifest = {
    ...MA_MANIFEST,
    parameters: [
      { id: "fast", label: "Fast", type: "integer", default: 12, min: 1, max: 500, lessThan: "slow" },
      { id: "slow", label: "Slow", type: "integer", default: 26, min: 1, max: 500 },
    ],
  };
  assert.deepEqual(currentParameters(ruled, { fast: 40 }), { fast: 12, slow: 26 });
  const withSignal: Manifest = { ...ruled, parameters: [...ruled.parameters, { id: "signal", label: "Signal", type: "integer", default: 9, min: 1, max: 500 }] };
  assert.deepEqual(currentParameters(withSignal, { fast: 40, slow: 30, signal: 5 }), { fast: 12, slow: 26, signal: 5 }, "the others are kept");
  assert.deepEqual(currentParameters(ruled, { fast: 5, slow: 9 }), { fast: 5, slow: 9 });
});
