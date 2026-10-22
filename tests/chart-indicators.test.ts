// Indicator maths for the Charts view: Moving average (simple, exponential) and RSI with Wilder smoothing,
// one value per bar and none until there are enough bars.
import assert from "node:assert/strict";
import { test } from "node:test";
import { movingAverage, rsi } from "../src/dashboard/charts/indicators.js";

/** Rounded for comparison with published values; undefined stays undefined. */
const round = (values: (number | undefined)[], places: number) => values.map((v) => (v === undefined ? undefined : Number(v.toFixed(places))));

test("a simple moving average is the mean of the last n closes, with no value for the first n-1 bars", () => {
  assert.deepEqual(movingAverage([1, 2, 3, 4, 5], 3, "simple"), [undefined, undefined, 2, 3, 4]);
  assert.deepEqual(round(movingAverage([1.1, 1.3, 1.2, 1.6], 2, "simple"), 6), [undefined, 1.2, 1.25, 1.4]);
});

test("an exponential moving average starts from the simple average of its first n closes, then weights each close by 2/(n+1)", () => {
  // n = 3: k = 0.5. Seed (2+4+6)/3 = 4; then 8·0.5 + 4·0.5 = 6; then 4·0.5 + 6·0.5 = 5.
  assert.deepEqual(movingAverage([2, 4, 6, 8, 4], 3, "exponential"), [undefined, undefined, 4, 6, 5]);
});

test("a moving average longer than the bars has no value at all", () => {
  assert.deepEqual(movingAverage([1, 2], 3, "simple"), [undefined, undefined]);
  assert.deepEqual(movingAverage([1, 2], 3, "exponential"), [undefined, undefined]);
  assert.deepEqual(movingAverage([], 3, "simple"), []);
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

test("RSI matches the published 14-period series, with no value until 14 changes exist", () => {
  const values = rsi(CLOSES, 14);
  assert.equal(values.length, CLOSES.length);
  assert.deepEqual(values.slice(0, 14), Array(14).fill(undefined));
  assert.deepEqual(round(values.slice(14), 2), PUBLISHED_RSI);
});

test("RSI is 100 when prices only rose and 50 when they never moved, as MetaTrader draws it", () => {
  assert.deepEqual(rsi([1, 2, 3, 4], 3), [undefined, undefined, undefined, 100]);
  assert.deepEqual(rsi([1, 1, 1, 1], 3), [undefined, undefined, undefined, 50]);
  assert.deepEqual(rsi([3, 2, 1, 0.5], 3), [undefined, undefined, undefined, 0]);
});
