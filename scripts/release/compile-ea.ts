// npm run compile:ea [-- --metaeditor <path>]: the release's EA check (ADR 3). Compiles the repo's mt4/ sources with a
// local MT4 MetaEditor from the command line, as the app does when it installs the EA, and fails on any error or
// warning. It compiles a staged copy in a temp folder: nothing in a terminal or in mt4/ changes.
import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileWithMetaEditor } from "../../src/shared/metaeditor/index.js";

const REPO_MT4 = new URL("../../mt4/", import.meta.url);
/** Where MT4 installations usually are; each is a folder with terminal.exe and metaeditor.exe (MT5's is metaeditor64.exe). */
const PROGRAM_FOLDERS = ["C:\\Program Files (x86)", "C:\\Program Files"];

async function exists(path: string) {
  return stat(path).then((s) => s.isFile(), () => false);
}

/** `--metaeditor <path>`, else QB_METAEDITOR, else the first MT4 installation in Program Files that has one. */
async function findMetaEditor(): Promise<string | undefined> {
  const flag = process.argv.indexOf("--metaeditor");
  if (flag > 0 && process.argv[flag + 1]) return process.argv[flag + 1];
  if (process.env.QB_METAEDITOR) return process.env.QB_METAEDITOR;
  for (const programs of PROGRAM_FOLDERS) {
    const folders = await readdir(programs).catch(() => [] as string[]);
    for (const folder of folders.sort()) {
      const editor = join(programs, folder, "metaeditor.exe");
      if ((await exists(editor)) && (await exists(join(programs, folder, "terminal.exe")))) return editor;
    }
  }
  return undefined;
}

const metaEditor = await findMetaEditor();
if (!metaEditor) {
  console.error("No MT4 MetaEditor found. Pass --metaeditor <path to metaeditor.exe> or set QB_METAEDITOR.");
  process.exit(2);
}

// The staged layout MetaEditor expects: MQL4\Experts\QuoteBridge.mq4 including ..\Include\*.mqh.
const stage = await mkdtemp(join(tmpdir(), "quotebridge-ea-compile-"));
let failed = true;
try {
  const experts = join(stage, "MQL4", "Experts"), include = join(stage, "MQL4", "Include");
  await mkdir(experts, { recursive: true });
  await mkdir(include, { recursive: true });
  await copyFile(new URL("Experts/QuoteBridge.mq4", REPO_MT4), join(experts, "QuoteBridge.mq4"));
  for (const file of await readdir(new URL("Include/", REPO_MT4))) {
    if (file.endsWith(".mqh")) await copyFile(new URL(`Include/${file}`, REPO_MT4), join(include, file));
  }

  console.log(`Compiling mt4/Experts/QuoteBridge.mq4 with ${metaEditor}`);
  const outcome = await compileWithMetaEditor({ metaEditor, source: join(experts, "QuoteBridge.mq4"), includeFolder: join(stage, "MQL4"), logFile: join(stage, "compile.log") });
  for (const m of outcome.log?.messages ?? []) console.log(`  ${m.severity} ${m.code} ${m.file}(${m.line},${m.column}): ${m.text}`);
  const result = outcome.log?.result;
  if (result) console.log(`Result: ${result.errors} errors, ${result.warnings} warnings`);
  if (!outcome.ok) {
    console.error(outcome.reason === "metaeditor-running" ? "That MetaEditor is open: close it and try again." : `The compile failed: ${outcome.reason}.`);
  } else if (result && result.warnings > 0) {
    console.error("A release needs 0 warnings.");
  } else {
    console.log("OK: 0 errors, 0 warnings. The EA is ready for a release.");
    failed = false;
  }
} finally {
  await rm(stage, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
