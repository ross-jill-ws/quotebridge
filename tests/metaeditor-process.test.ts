import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { metaEditorsFromProcessList, windowsMetaEditorProcesses } from "../src/shared/metaeditor/index.js";

const onWindows = { skip: process.platform !== "win32" && "Windows command-line quoting" };

async function scriptFolder(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "quotebridge-process-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

test("MetaEditor receives /compile:\"…\" arguments with spaces intact, and its exit code is reported", onWindows, async (t) => {
  const folder = await scriptFolder(t);
  const script = join(folder, "fake metaeditor.mjs");
  const argsFile = join(folder, "args.json");
  await writeFile(script, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(1);\n`);

  const started = windowsMetaEditorProcesses.start(process.execPath, [`"${script}"`, String.raw`/compile:"C:\Stage Folder\MQL4\Experts\QuoteBridge.mq4"`]);

  assert.equal(await started.exited, 1);
  assert.deepEqual(JSON.parse(await readFile(argsFile, "utf8")), [String.raw`/compile:C:\Stage Folder\MQL4\Experts\QuoteBridge.mq4`]);
});

test("a killed MetaEditor process ends", onWindows, async (t) => {
  const folder = await scriptFolder(t);
  const script = join(folder, "hang.mjs");
  await writeFile(script, "setInterval(() => {}, 1000);\n");

  const started = windowsMetaEditorProcesses.start(process.execPath, [`"${script}"`]);
  started.kill();

  assert.notEqual(await started.exited, 0);
});

test("running MetaEditors are read from the PowerShell process list (one, several or none)", () => {
  // As PowerShell's ConvertTo-Json prints them: backslashes escaped.
  const one = String.raw`{"ExecutablePath":"C:\\Program Files (x86)\\CMC Markets MetaTrader 4\\metaeditor.exe"}`;
  assert.deepEqual(metaEditorsFromProcessList(one), [String.raw`C:\Program Files (x86)\CMC Markets MetaTrader 4\metaeditor.exe`]);
  const several = String.raw`[{"ExecutablePath":"C:\\A\\metaeditor.exe"},{"ExecutablePath":null},{"ExecutablePath":"C:\\B\\metaeditor64.exe"}]`;
  assert.deepEqual(metaEditorsFromProcessList(several), [String.raw`C:\A\metaeditor.exe`, String.raw`C:\B\metaeditor64.exe`]);
  assert.deepEqual(metaEditorsFromProcessList(""), []);
});
