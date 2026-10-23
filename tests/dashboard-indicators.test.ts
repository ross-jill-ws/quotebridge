// The Indicators page's pure model: a row per package with its version, whether it is bundled, enabled and how many
// charts use it; a package's details (parameters with their ranges and defaults, outputs); and its README as blocks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { packageDetails, packageRows, readmeBlocks } from "../src/dashboard/indicators/indicators-model.js";
import type { Manifest } from "../src/shared/indicator-manifest.js";

const manifest = (name: string): Manifest => JSON.parse(readFileSync(new URL(`../src/server/indicators/bundled/${name}/manifest.json`, import.meta.url), "utf8"));
const MA = manifest("ma");
const MACD = manifest("macd");
const BOLLINGER = manifest("bollinger");
const AO = manifest("ao");

test("each package is a row: name, version, Bundled or Installed, enabled, and the charts using it", () => {
  const installed = { ...MA, id: "acme.ma", name: "Acme average", version: "2.1.0" };
  const rows = packageRows([
    { manifest: MA, bundled: true, enabled: true, charts: 2 },
    { manifest: MACD, bundled: true, enabled: false, charts: 1 },
    { manifest: installed, bundled: false, enabled: true, charts: 0 },
  ]);
  assert.deepEqual(rows, [
    { id: "quotebridge.ma", name: "Moving average", version: "1.0.0", origin: "Bundled", enabled: true, charts: "2 charts" },
    { id: "quotebridge.macd", name: "MACD", version: "1.0.0", origin: "Bundled", enabled: false, charts: "1 chart" },
    { id: "acme.ma", name: "Acme average", version: "2.1.0", origin: "Installed", enabled: true, charts: "None" },
  ]);
});

test("a package's details give each parameter's label, range and default, and each output's kind and pane", () => {
  assert.deepEqual(packageDetails(MA).parameters, [
    { label: "Period", range: "1–500", default: "20" },
    { label: "Type", range: "Simple, Exponential", default: "Simple" },
  ]);
  assert.deepEqual(packageDetails(BOLLINGER).parameters[1], { label: "Deviations", range: "0.1–10", default: "2" });
  assert.deepEqual(packageDetails(MACD).parameters[0], { label: "Fast EMA", range: "1–500, below Slow EMA", default: "12" });
  assert.deepEqual(packageDetails(MACD).outputs, [
    { label: "MACD", kind: "Histogram", placement: "Own pane" },
    { label: "Signal", kind: "Line", placement: "Own pane" },
  ]);
  assert.deepEqual(packageDetails(AO).outputs, [{ label: "AO", kind: "Histogram, rising and falling", placement: "Own pane" }]);
  assert.deepEqual(packageDetails(BOLLINGER).outputs[0], { label: "Middle", kind: "Line", placement: "Price pane" });
});

test("a README reads as headings, paragraphs, lists, tables and code, its inline code and bold marked", () => {
  const blocks = readmeBlocks(
    [
      "# EO",
      "",
      "Converted from `EO.mq4` by **Yuexin Zhu**,",
      "who allows it.",
      "",
      "## Parameters",
      "",
      "| Parameter | Range |",
      "| --------- | ----- |",
      "| Fast EMA  | 1–500 |",
      "",
      "- **Rising** bars",
      "- falling ones",
      "",
      "```text",
      "eo = (temp + temp before) / 2",
      "```",
    ].join("\n"),
  );
  assert.deepEqual(blocks, [
    { type: "heading", level: 1, text: [{ text: "EO" }] },
    { type: "paragraph", text: [{ text: "Converted from " }, { text: "EO.mq4", code: true }, { text: " by " }, { text: "Yuexin Zhu", bold: true }, { text: ", who allows it." }] },
    { type: "heading", level: 2, text: [{ text: "Parameters" }] },
    { type: "table", head: [[{ text: "Parameter" }], [{ text: "Range" }]], rows: [[[{ text: "Fast EMA" }], [{ text: "1–500" }]]] },
    { type: "list", items: [[{ text: "Rising", bold: true }, { text: " bars" }], [{ text: "falling ones" }]] },
    { type: "code", text: "eo = (temp + temp before) / 2" },
  ]);
});
