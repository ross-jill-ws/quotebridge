// The page's side of a REST screenshot: where a target sends the window, and when its chart counts as drawn.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chartDrawn, chartHash } from "../src/dashboard/charts/chart-model.js";
import { chartShown, screenshotHash } from "../src/dashboard/screenshot.js";

test("Feeds goes to #/feeds, a chart to the Charts view on that feed", () => {
  assert.equal(screenshotHash({ view: "feeds" }), "#/feeds");
  assert.equal(screenshotHash({ view: "chart", feed: "mt4-aaaa/EURUSD#1" }), "#/charts?feed=mt4-aaaa%2FEURUSD%231");
});

test("the chart is drawn once the asked feed's candles are on it, or the view shows it has none", () => {
  assert.equal(chartShown({ state: "drawn", feed: "f1" }, "f1", "live"), true);
  assert.equal(chartShown({ state: "empty", feed: undefined }, "f1", "live"), true, "no feeds: the empty state is what is shown");
  assert.equal(chartShown({ state: "loading", feed: "f1" }, "f1", "live"), false, "its candles are on their way");
  assert.equal(chartShown({ state: "drawn", feed: "f0" }, "f1", "live"), false, "the feed shown before");
  assert.equal(chartShown(null, "f1", "live"), false, "the Charts view not rendered yet");
});

test("without a live link the chart's loading state is what the window shows", () => {
  assert.equal(chartShown({ state: "loading", feed: "f1" }, "f1", "reconnecting"), true);
  assert.equal(chartShown({ state: "loading", feed: "f1" }, "f1", "connecting"), true);
  assert.equal(chartShown(null, "f1", "reconnecting"), false, "still the view to render");
  assert.equal(chartShown({ state: "drawn", feed: "f0" }, "f1", "reconnecting"), false, "the chart shown before, not switched yet");
});

test("a chart counts as drawn once its candles, every enabled indicator's values and its trades are in", () => {
  const packages = new Map([["ma", { enabled: true }], ["off", { enabled: false }]]);
  const indicators = [{ id: "i1", package: "ma" }, { id: "i2", package: "off" }];
  const values = new Map([["i1", {}]]);
  assert.equal(chartDrawn({ candles: true, indicators, packages, values, trades: true }), true, "a disabled package draws nothing to wait for");
  assert.equal(chartDrawn({ candles: false, indicators, packages, values, trades: true }), false, "candles on their way");
  assert.equal(chartDrawn({ candles: true, indicators, packages, values: new Map(), trades: true }), false, "an indicator's values on their way");
  assert.equal(chartDrawn({ candles: true, indicators, packages: undefined, values, trades: true }), false, "the package list not in yet");
  assert.equal(chartDrawn({ candles: true, indicators: [], packages: undefined, values: new Map(), trades: true }), true, "no indicators: no list to wait for");
  assert.equal(chartDrawn({ candles: true, indicators, packages, values, trades: false }), false, "trade lines on, trades not read yet");
});

test("a Feeds row and a screenshot link the same chart address", () => {
  assert.equal(chartHash("mt4-aaaa/EURUSD#1"), "#/charts?feed=mt4-aaaa%2FEURUSD%231");
});
