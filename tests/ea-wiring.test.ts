import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// A Windows checkout may turn LF into CRLF; the checks are about content, not line endings.
const eol = (text: string) => text.replace(/\r\n/g, "\n");

// Static checks on the bundled QuoteBridge EA source. The real compile check
// (0 errors, 0 warnings in MetaEditor) is the maintainer's manual release step.
const source = await readFile(new URL("../mt4/Experts/QuoteBridge.mq4", import.meta.url), "utf8").then(eol);
const trading = await readFile(new URL("../mt4/Include/QuoteBridgeTrading.mqh", import.meta.url), "utf8").then(eol);

// The hello fields of EA 1.07, which older servers and the app already parse.
const LEGACY_HELLO_FIELDS = [
  `"H`,
  `1`,
  `"+session+"`,
  `"+Clean(TerminalId)+"`,
  `"+Clean(AccountServer())+"`,
  `"+Clean(Symbol())+"`,
  `"+IntegerToString(Digits)+"`,
  `"+IntegerToString(SamplingMilliseconds)+"`,
  `"+IntegerToString(dropped)+"`,
  `"+quoteStatus+"`,
  `"+IntegerToString(Period())+"`,
  `2000`,
  `1`,
];

function helloFields(): string[] {
  const body = source.match(/void Hello\(\)\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(body, "EA must have a Hello() function");
  const sends = [...body.matchAll(/Send\((".*?)\);/g)];
  assert.equal(sends.length, 1, "Hello() sends exactly one H message");
  return sends[0][1].split("|");
}

test("QuoteBridge EA version is 1.08", () => {
  assert.match(source, /^#property version "1\.08"$/m);
});

test("hello keeps the 1.07 fields and carries the EA version as its last field", () => {
  const fields = helloFields();
  assert.equal(fields.length, LEGACY_HELLO_FIELDS.length + 1);
  assert.deepEqual(fields.slice(0, -1), LEGACY_HELLO_FIELDS);
  const version = fields.at(-1)!.match(/^"\+(\w+)$/)?.[1];
  assert.ok(version, `last hello field must be a version constant, got ${fields.at(-1)}`);
  const defined = source.match(new RegExp(`^#define ${version} "([^"]*)"$`, "m"))?.[1];
  assert.equal(defined, "1.08", "the hello reports the same version as #property version");
});

test("EA timer updates trade freshness before receiving commands, independent of recording", () => {
  const timer = source.match(/void OnTimer\(\)\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(timer, "EA must have a timer handler");
  const code = timer.replace(/\/\/[^\n]*/g, "").trim();
  assert.ok(code.startsWith("ObserveTradingClock();"), "Freshness update must run unconditionally before Receive or Capture");
  assert.ok(code.indexOf("ObserveTradingClock();") < code.indexOf("Receive();"));
  assert.match(trading, /bool clockObserved=false;/);
  assert.match(trading, /if\(lastServerClock!=0\)clockObserved=true/);
  assert.match(trading, /clockObserved && GetTickCount\(\)-lastServerClockTick<=30000/);
});
