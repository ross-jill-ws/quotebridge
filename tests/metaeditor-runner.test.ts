import { test } from "node:test";
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { compileWithMetaEditor, METAEDITOR_TIMEOUT_MS } from "../src/main/metaeditor/index.js";
import { compileLogBytes, FAILED_LOG, FakeMetaEditor, REAL_SUCCESS_LOG, stagingFolder, WARNINGS_LOG } from "./metaeditor-fixtures.js";

const EX4 = new Uint8Array([0x45, 0x58, 0x34, 0x00, 1, 2, 3]);

test("a fresh .ex4 and a 0-error log is a successful compile even when MetaEditor exits with code 1", async (t) => {
  const stage = await stagingFolder();
  t.after(stage.cleanup);
  const metaEditor = new FakeMetaEditor({ ex4: EX4, log: { text: REAL_SUCCESS_LOG, encoding: "utf16le" }, exitCode: 1 });

  const outcome = await compileWithMetaEditor(stage, metaEditor);

  assert.equal(outcome.ok, true);
  assert.equal(outcome.exitCode, 1);
  assert.ok(outcome.ok && outcome.ex4 === stage.source.replace(/\.mq4$/, ".ex4"));
  assert.deepEqual(outcome.log?.result, { errors: 0, warnings: 0 });
  assert.deepEqual(metaEditor.starts, [
    {
      executable: stage.metaEditor,
      args: [`/compile:"${stage.source}"`, `/inc:"${stage.includeFolder}"`, `/log:"${stage.logFile}"`],
    },
  ]);
});

test("a log reporting errors fails the compile with the errors listed, even if an .ex4 was written", async (t) => {
  const stage = await stagingFolder();
  t.after(stage.cleanup);
  const metaEditor = new FakeMetaEditor({ ex4: EX4, log: { text: FAILED_LOG, encoding: "utf16le" }, exitCode: 1 });

  const outcome = await compileWithMetaEditor(stage, metaEditor);

  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.reason, "compile-errors");
  assert.deepEqual(outcome.log?.result, { errors: 2, warnings: 1 });
  assert.equal(outcome.log?.messages.filter((message) => message.severity === "error").length, 2);
});

test("warnings are recorded but do not fail a compile on the user's computer", async (t) => {
  const stage = await stagingFolder();
  t.after(stage.cleanup);
  const metaEditor = new FakeMetaEditor({ ex4: EX4, log: { text: WARNINGS_LOG, encoding: "utf8" } });

  const outcome = await compileWithMetaEditor(stage, metaEditor);

  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.log?.result, { errors: 0, warnings: 2 });
  assert.equal(outcome.log?.messages.length, 2);
});

test("no .ex4 from this run fails the compile, even with a 0-error log and an old .ex4 in the staging folder", async (t) => {
  const stage = await stagingFolder();
  t.after(stage.cleanup);
  await writeFile(stage.source.replace(/\.mq4$/, ".ex4"), EX4); // left over from an earlier compile
  const metaEditor = new FakeMetaEditor({ log: { text: REAL_SUCCESS_LOG, encoding: "utf16le" } });

  const outcome = await compileWithMetaEditor(stage, metaEditor);

  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.reason, "no-ex4");
  assert.deepEqual(outcome.log?.result, { errors: 0, warnings: 0 });
});

test("an empty .ex4 fails the compile", async (t) => {
  const stage = await stagingFolder();
  t.after(stage.cleanup);
  const metaEditor = new FakeMetaEditor({ ex4: new Uint8Array(), log: { text: REAL_SUCCESS_LOG, encoding: "utf16le" } });

  const outcome = await compileWithMetaEditor(stage, metaEditor);

  assert.equal(!outcome.ok && outcome.reason, "no-ex4");
});

test("a missing log, or one without a Result line, fails the compile even with an .ex4", async (t) => {
  const stage = await stagingFolder();
  t.after(stage.cleanup);
  await writeFile(stage.logFile, compileLogBytes(REAL_SUCCESS_LOG, "utf16le")); // stale log from an earlier compile

  const noLog = await compileWithMetaEditor(stage, new FakeMetaEditor({ ex4: EX4 }));
  assert.equal(!noLog.ok && noLog.reason, "no-result");
  assert.equal(noLog.log, undefined);

  const truncated = await compileWithMetaEditor(stage, new FakeMetaEditor({ ex4: EX4, log: { text: "compiling 'QuoteBridge.mq4'\r\n", encoding: "utf8" } }));
  assert.equal(!truncated.ok && truncated.reason, "no-result");
  assert.match(truncated.log?.text ?? "", /compiling/);
});

test("a MetaEditor that hangs is killed after the timeout and the compile fails", async (t) => {
  const stage = await stagingFolder();
  t.after(stage.cleanup);
  const metaEditor = new FakeMetaEditor({ hang: true, ex4: EX4, log: { text: REAL_SUCCESS_LOG, encoding: "utf16le" } });

  const outcome = await compileWithMetaEditor({ ...stage, timeoutMs: 50 }, metaEditor);

  assert.equal(!outcome.ok && outcome.reason, "timeout");
  assert.equal(metaEditor.killed, 1);
});

test("the default timeout is 120 seconds", () => {
  assert.equal(METAEDITOR_TIMEOUT_MS, 120_000);
});

test("a MetaEditor already running from the same installation folder is a refusal; nothing is started", async (t) => {
  const stage = await stagingFolder();
  t.after(stage.cleanup);
  const metaEditor = new FakeMetaEditor({ ex4: EX4, log: { text: REAL_SUCCESS_LOG, encoding: "utf16le" } });
  metaEditor.running = [stage.metaEditor.toUpperCase()];

  const outcome = await compileWithMetaEditor(stage, metaEditor);

  assert.equal(!outcome.ok && outcome.reason, "metaeditor-running");
  assert.deepEqual(metaEditor.starts, []);
});

test("a MetaEditor running from another terminal's installation folder does not block the compile", async (t) => {
  const stage = await stagingFolder();
  t.after(stage.cleanup);
  const metaEditor = new FakeMetaEditor({ ex4: EX4, log: { text: REAL_SUCCESS_LOG, encoding: "utf16le" } });
  metaEditor.running = [String.raw`C:\Program Files (x86)\MT4 at easy-forex\metaeditor.exe`];

  const outcome = await compileWithMetaEditor(stage, metaEditor);

  assert.equal(outcome.ok, true);
});

test("a terminal without metaeditor.exe fails with no-metaeditor; nothing is started", async (t) => {
  const stage = await stagingFolder();
  t.after(stage.cleanup);
  await rm(stage.metaEditor);
  const metaEditor = new FakeMetaEditor({ ex4: EX4, log: { text: REAL_SUCCESS_LOG, encoding: "utf16le" } });

  const outcome = await compileWithMetaEditor(stage, metaEditor);

  assert.equal(!outcome.ok && outcome.reason, "no-metaeditor");
  assert.deepEqual(metaEditor.starts, []);
});
