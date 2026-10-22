// The Charts view's pure models: colour schemes, the legend, the forming candle, day separators and view memory.
import assert from "node:assert/strict";
import { test } from "node:test";
import { candlesSince, chartLegend, daySeparators, followQuote, mergeLatest, prependOlder, readChartMemory, showsCandlesSince, wantsOlder } from "../src/dashboard/charts/chart-model.js";
import { chartScheme } from "../src/dashboard/charts/chart-scheme.js";
import { indicatorLabel, nextColour } from "../src/dashboard/charts/indicators.js";

test("Default candles are filled Uptick and Downtick on the surface colour, following the theme", () => {
  const light = chartScheme("default", "light");
  assert.equal(light.canvas, "#ffffff");
  assert.deepEqual(light.up, { body: "#0f7b53", wick: "#0f7b53", border: "#0f7b53" });
  assert.deepEqual(light.down, { body: "#c2412d", wick: "#c2412d", border: "#c2412d" });
  assert.equal(light.bidLabel, "#172033");
  assert.equal(light.ask, "#c2412d");

  const dark = chartScheme("default", "dark");
  assert.equal(dark.canvas, "#131e31");
  assert.deepEqual(dark.up, { body: "#3cc98e", wick: "#3cc98e", border: "#3cc98e" });
  assert.deepEqual(dark.down, { body: "#ff7d69", wick: "#ff7d69", border: "#ff7d69" });
  assert.equal(dark.bidLabel, "#dce3ee");
  assert.equal(dark.crosshair, "#74829a");
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
const MA = { id: "a", label: "SMA 2", colour: "#b7791f", digits: 5, values: [undefined, 0.651657, 0.65149] };
const RSI = { id: "b", label: "RSI 14", colour: "#2f6fb3", digits: 2, values: [undefined, undefined, 41.456] };

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
    { id: "a", label: "SMA 2", colour: "#b7791f", value: "0.65149" },
    { id: "b", label: "RSI 14", colour: "#2f6fb3", value: "41.46" },
  ]);
});

test("at the crosshair the legend follows the bar under it, and shows a dash where an indicator has no value yet", () => {
  const legend = chartLegend({ symbol: "AUDUSD.a", period: "H1", digits: 5, candles: BARS, indicators: [MA, RSI], time: 7200 });
  assert.deepEqual(legend.ohlc.map((p) => p.value), ["0.65143", "0.65200", "0.65140", "0.65188"]);
  assert.deepEqual(legend.indicators.map((i) => i.value), ["0.65166", "—"]);
});

test("a crosshair time without a bar, or no bars at all, falls back to the latest bar or dashes", () => {
  const between = chartLegend({ symbol: "GOLD", period: "M1", digits: 2, candles: BARS, indicators: [], time: 5000 });
  assert.equal(between.ohlc[3].value, "0.65");
  const empty = chartLegend({ symbol: "GOLD", period: "M1", digits: 2, candles: [], indicators: [MA] });
  assert.equal(empty.title, "GOLD, M1");
  assert.deepEqual(empty.ohlc.map((p) => p.value), ["—", "—", "—", "—"]);
  assert.equal(empty.indicators[0].value, "—");
});

test("indicators are named by kind and period, and take the first palette colour no other indicator uses", () => {
  assert.equal(indicatorLabel({ kind: "ma", period: 20, type: "simple" }), "SMA 20");
  assert.equal(indicatorLabel({ kind: "ma", period: 50, type: "exponential" }), "EMA 50");
  assert.equal(indicatorLabel({ kind: "rsi", period: 14 }), "RSI 14");
  assert.equal(nextColour([]), 0);
  assert.equal(nextColour([{ colour: 0 }, { colour: 1 }]), 2);
  assert.equal(nextColour([{ colour: 1 }]), 0);
  assert.equal(nextColour([{ colour: 0 }, { colour: 1 }, { colour: 2 }, { colour: 3 }]), 0);
  assert.equal(nextColour([{ colour: 0 }, { colour: 1 }, { colour: 2 }, { colour: 3 }, { colour: 0 }]), 1);
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

test("intraday periods get a separator at the first bar of each new day; daily and longer periods none", () => {
  const candles = [22 * H, 23 * H, DAY + 1 * H, DAY + 2 * H, 3 * DAY].map((time) => ({ time, open: 1, high: 1, low: 1, close: 1 }));
  assert.deepEqual(daySeparators(candles, "H1"), [DAY + H, 3 * DAY]);
  assert.deepEqual(daySeparators(candles, "D1"), []);
  assert.deepEqual(daySeparators([], "M5"), []);
});

test("the view remembers its symbol, period, type, Ask line and indicators, and reads anything else as the defaults", () => {
  const stored = { feed: "t1|CMC|AUDUSD.a", period: "H4", type: "bars", askLine: true, indicators: [{ id: "x", colour: 1, kind: "rsi", period: 9 }] };
  assert.deepEqual(readChartMemory(JSON.stringify(stored)), stored);
  const defaults = { period: "M1", type: "candles", askLine: false, indicators: [] };
  assert.deepEqual(readChartMemory(null), defaults);
  assert.deepEqual(readChartMemory("not json"), defaults);
  assert.deepEqual(readChartMemory(JSON.stringify({ period: "H2", type: "area", askLine: "yes", indicators: "none" })), defaults);
  const mixed = [
    { id: "a", colour: 0, kind: "ma", period: 20, type: "exponential" },
    { id: "b", colour: 0, kind: "ma", period: 0, type: "simple" },
    { id: "c", colour: 9, kind: "rsi", period: 14 },
    { id: "d", colour: 2, kind: "macd", period: 12 },
  ];
  assert.deepEqual(readChartMemory(JSON.stringify({ indicators: mixed })).indicators, [mixed[0]]);
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

test("older bars are asked for when fewer than 100 remain left of the view, until there are none", () => {
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
