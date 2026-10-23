import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { BARS_PER_PAGE, MAX_REQUEST_BARS } from "../src/server/bridge/index.js";

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

test("QuoteBridge EA version is 1.10", () => {
  assert.match(source, /^#property version "1\.10"$/m);
});

test("hello keeps the 1.07 fields and carries the EA version as its last field", () => {
  const fields = helloFields();
  assert.equal(fields.length, LEGACY_HELLO_FIELDS.length + 1);
  assert.deepEqual(fields.slice(0, -1), LEGACY_HELLO_FIELDS);
  const version = fields.at(-1)!.match(/^"\+(\w+)$/)?.[1];
  assert.ok(version, `last hello field must be a version constant, got ${fields.at(-1)}`);
  const defined = source.match(new RegExp(`^#define ${version} "([^"]*)"$`, "m"))?.[1];
  assert.equal(defined, "1.10", "the hello reports the same version as #property version");
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

// A chart or parameter change re-inits the EA but keeps its globals (MQL4). The batch in flight carries the old session
// in its text, which the app refuses from the new session's route, so resending it would stall the feed for good.
test("a re-init starts its new session with no batch in flight, and empties the buffer when its size changed", () => {
  const init = source.match(/int OnInit\(\)\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(init, "EA must have OnInit");
  const code = init.replace(/\/\/[^\n]*/g, "");
  const cleared = code.search(/inflight="";inflightLast=0;/);
  assert.ok(cleared >= 0, "OnInit clears the batch in flight");
  assert.ok(cleared < code.search(/ConnectSocket\(\)/), "before connecting, so nothing goes out with the old session");
  const reset = code.search(/if\(ArraySize\(rows\)!=BufferCapacity\)\{head=0;count=0;\}/);
  assert.ok(reset >= 0 && reset < code.search(/ArrayResize\(rows,BufferCapacity\)/), "a changed buffer size starts the buffer empty");
});

test("the EA's stop line says whether queued samples are kept for the restart or lost", () => {
  const deinit = source.match(/void OnDeinit\(const int reason\)\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(deinit, "EA must have OnDeinit");
  assert.match(deinit, /REASON_CHARTCHANGE/);
  assert.match(deinit, /REASON_PARAMETERS/);
  assert.doesNotMatch(deinit, /unacknowledged samples lost/);
});

// The bar exchange (G) the server parses in src/server/bridge/protocol.ts; the fake EA in tests/fake-ea.ts speaks it too.
test("the EA answers a bar request in pages the server accepts, with the same limits, after flushing quotes", () => {
  const receive = source.match(/void Receive\(\)\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(receive, "EA must have Receive()");
  assert.ok(receive.includes(`fields[0]!="G"`), "G messages get past the type filter");
  assert.ok(receive.includes(`if(fields[0]=="G" && parts==7){RequestBars(`), "a request has seven fields: G|1|session|request|timeframe|count|shift");
  assert.equal(source.match(/^#define QB_BARS_PER_PAGE (\d+)$/m)?.[1], String(BARS_PER_PAGE));
  assert.equal(source.match(/^#define QB_MAX_REQUEST_BARS (\d+)$/m)?.[1], String(MAX_REQUEST_BARS));
  assert.ok(source.includes(`"|loading|0|0|"`), "a loading answer has no bars");
  assert.ok(source.includes(`"|ok|"+IntegerToString(barTotal)+"|"+IntegerToString(barOffset)+"|"+rows`));
  assert.ok(source.includes("CopyRates(Symbol(),timeframe,1+shift,count,barRates)"), "closed bars only: the forming bar 0 is skipped");
  const timer = source.match(/void OnTimer\(\)\s*\{([\s\S]*?)\n\}/)![1];
  assert.ok(timer.indexOf("Flush();") < timer.indexOf("FlushBars();"), "quotes go out first");
});
