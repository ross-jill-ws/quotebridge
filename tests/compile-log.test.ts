import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCompileLog } from "../src/shared/metaeditor/index.js";
import { compileLogBytes, FAILED_LOG, REAL_SUCCESS_LOG, WARNINGS_LOG } from "./metaeditor-fixtures.js";

test("a real UTF-16LE MetaEditor log with 0 errors and 0 warnings parses as a clean result", () => {
  const log = parseCompileLog(compileLogBytes(REAL_SUCCESS_LOG, "utf16le"));
  assert.deepEqual(log.result, { errors: 0, warnings: 0 });
  assert.deepEqual(log.messages, []);
  assert.match(log.text, /compiling 'QuoteBridge.mq4'/);
});

test("errors and warnings in a UTF-8 log are counted and listed with file, line and column", () => {
  const log = parseCompileLog(compileLogBytes(FAILED_LOG, "utf8"));
  assert.deepEqual(log.result, { errors: 2, warnings: 1 });
  assert.deepEqual(log.messages, [
    { severity: "error", file: String.raw`C:\stage\MQL4\Experts\QuoteBridge.mq4`, line: 120, column: 7, code: 256, text: "'Sampler' - undeclared identifier" },
    { severity: "error", file: String.raw`C:\stage\MQL4\Include\QuoteBridgeZmq.mqh`, line: 44, column: 3, code: 149, text: "'return' - unexpected token" },
    { severity: "warning", file: String.raw`C:\stage\MQL4\Experts\QuoteBridge.mq4`, line: 200, column: 15, code: 43, text: "possible loss of data due to type conversion" },
  ]);
});

for (const encoding of ["utf16le", "utf16le-no-bom", "utf8", "utf8-bom"] as const) {
  test(`a warnings-only log reads the same in ${encoding}`, () => {
    const log = parseCompileLog(compileLogBytes(WARNINGS_LOG, encoding));
    assert.deepEqual(log.result, { errors: 0, warnings: 2 });
    assert.deepEqual(log.messages.map((message) => [message.severity, message.code]), [["warning", 43], ["warning", 31]]);
    assert.ok(log.text.startsWith(String.raw`C:\stage`), "no byte-order mark left in the text");
  });
}

test("a log without a Result line has no result", () => {
  const log = parseCompileLog(compileLogBytes(String.raw`C:\stage\QuoteBridge.mq4 : information: compiling 'QuoteBridge.mq4'` + "\r\n", "utf16le"));
  assert.equal(log.result, undefined);
  assert.equal(parseCompileLog(new Uint8Array()).result, undefined);
});
