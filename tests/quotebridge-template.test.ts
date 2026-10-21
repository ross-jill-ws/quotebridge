import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// A Windows checkout may turn LF into CRLF; the checks are about content, not line endings.
const eol = (text: string) => text.replace(/\r\n/g, "\n");

// Static checks on the bundled QuoteBridge.tpl, one of the bridge files.
// Applying it in MetaTrader is a manual acceptance step.
const template = await readFile(new URL("../mt4/Templates/QuoteBridge.tpl", import.meta.url), "utf8").then(eol);

test("template has one chart, one candle pane and a root-level QuoteBridge EA with flags=343", () => {
  const stack: string[] = [];
  const experts: string[] = [];
  for (const line of template.trim().split(/\r?\n/)) {
    const open = line.match(/^<(\w+)>$/);
    const close = line.match(/^<\/(\w+)>$/);
    if (open) {
      if (open[1] === "expert") experts.push(stack.join("/"));
      stack.push(open[1]);
    } else if (close) assert.equal(stack.pop(), close[1]);
    else if (line) assert.match(line, /^[A-Za-z_]+=[^<>]+$/);
  }
  assert.deepEqual(stack, []);
  assert.deepEqual(experts, ["chart"]);
  assert.equal((template.match(/<window>/g) ?? []).length, 1);
  assert.equal((template.match(/<indicator>/g) ?? []).length, 1);
  assert.match(template, /<expert>\s+name=QuoteBridge\s+flags=343\s+window_num=0/);
  assert.match(template, /<indicator>\s+name=main\s+<\/indicator>/);
  assert.match(template, /^graph=1$/m);
});

test("template inputs match the QuoteBridge EA defaults and keep demo trading off", async () => {
  const sources = await Promise.all(
    ["Experts/QuoteBridge.mq4", "Include/QuoteBridgeTrading.mqh"].map((file) =>
      readFile(new URL(`../mt4/${file}`, import.meta.url), "utf8").then(eol),
    ),
  );
  const defaults = Object.fromEntries(
    [...sources.join("\n").matchAll(/input\s+(?:string|int|bool|double)\s+(\w+)\s*=\s*([^;]+);/g)].map((m) => [
      m[1],
      m[2].trim().replace(/^"|"$/g, ""),
    ]),
  );
  const block = template.match(/<inputs>\s*([\s\S]*?)<\/inputs>/)![1];
  const values = Object.fromEntries(
    block
      .trim()
      .split(/\r?\n/)
      .map((line) => line.split("=")),
  );
  assert.deepEqual(values, defaults);
  assert.equal(values.EnableDemoTrading, "false");
  assert.match(template, /^one_click=0$/m);
  assert.match(template, /^one_click_btn=0$/m);
});

test("template's substitution points are TerminalId and ServerEndpoint, each appearing once", () => {
  assert.equal((template.match(/^TerminalId=/gm) ?? []).length, 1);
  assert.equal((template.match(/^ServerEndpoint=tcp:\/\/127\.0\.0\.1:\d+$/gm) ?? []).length, 1);
});

test("template contains no saved symbol, period, account or machine path", () => {
  assert.doesNotMatch(template, /^(?:symbol|period|digits|id|leftpos|account|login|password)=/im);
  assert.doesNotMatch(template, /[A-Z]:\|AppData|EasyForex|USDJPY|EURUSD/);
  assert.equal((template.match(/^name=/gm) ?? []).length, 2);
});
