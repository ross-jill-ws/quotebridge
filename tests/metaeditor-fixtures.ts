// Compile logs and a fake MetaEditor for the MetaEditor runner tests. Nothing here touches a real
// MetaEditor or a terminal folder.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MetaEditorProcesses, StartedProcess } from "../src/main/metaeditor/index.js";

/**
 * A real MetaEditor log of a clean QuoteBridge compile (legacy repo, `log/mt4-compile-*.log`),
 * with the staging path shortened. MetaEditor wrote it as UTF-16LE with a byte-order mark.
 */
export const REAL_SUCCESS_LOG = [
  "",
  "",
  String.raw`C:\stage\MQL4\Experts\QuoteBridge.mq4 : information: compiling 'QuoteBridge.mq4'`,
  String.raw`C:\stage\MQL4\Include\QuoteBridgeZmq.mqh : information: including 'QuoteBridgeZmq.mqh'`,
  String.raw`C:\stage\MQL4\Include\QuoteBridgeTrading.mqh : information: including 'QuoteBridgeTrading.mqh'`,
  "Result: 0 errors, 0 warnings, 79 msec elapsed",
  "",
].join("\r\n");

/** A log in MetaEditor's line format with two errors and one warning. */
export const FAILED_LOG = [
  "",
  "",
  String.raw`C:\stage\MQL4\Experts\QuoteBridge.mq4 : information: compiling 'QuoteBridge.mq4'`,
  String.raw`C:\stage\MQL4\Experts\QuoteBridge.mq4(120,7) : error 256: 'Sampler' - undeclared identifier`,
  String.raw`C:\stage\MQL4\Include\QuoteBridgeZmq.mqh(44,3) : error 149: 'return' - unexpected token`,
  String.raw`C:\stage\MQL4\Experts\QuoteBridge.mq4(200,15) : warning 43: possible loss of data due to type conversion`,
  "Result: 2 errors, 1 warnings, 81 msec elapsed",
  "",
].join("\r\n");

/** A log with warnings only: the compile succeeds on a user's machine. */
export const WARNINGS_LOG = [
  String.raw`C:\stage\MQL4\Experts\QuoteBridge.mq4 : information: compiling 'QuoteBridge.mq4'`,
  String.raw`C:\stage\MQL4\Experts\QuoteBridge.mq4(200,15) : warning 43: possible loss of data due to type conversion`,
  String.raw`C:\stage\MQL4\Experts\QuoteBridge.mq4(210,9) : warning 31: implicit conversion from 'number' to 'string'`,
  "Result: 0 errors, 2 warnings, 80 msec elapsed",
  "",
].join("\r\n");

export type LogEncoding = "utf16le" | "utf16le-no-bom" | "utf8" | "utf8-bom";

/** The bytes MetaEditor would write for `text` in the given encoding. */
export function compileLogBytes(text: string, encoding: LogEncoding): Buffer {
  switch (encoding) {
    case "utf16le":
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    case "utf16le-no-bom":
      return Buffer.from(text, "utf16le");
    case "utf8":
      return Buffer.from(text, "utf8");
    case "utf8-bom":
      return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]);
  }
}

/** What the fake MetaEditor does when started. */
export interface FakeCompile {
  /** Bytes of the `.ex4` to write next to the source; omitted = no `.ex4`. */
  ex4?: Uint8Array;
  /** Log text and encoding to write to the `/log:` file; omitted = no log. */
  log?: { text: string; encoding: LogEncoding };
  exitCode?: number;
  /** Never exits on its own (only `kill()` ends it). */
  hang?: boolean;
}

/**
 * A fake MetaEditor behind the runner's process port. It reads the `/compile:` and `/log:`
 * arguments like MetaEditor does and writes the chosen `.ex4` and log.
 */
export class FakeMetaEditor implements MetaEditorProcesses {
  readonly starts: { executable: string; args: string[] }[] = [];
  killed = 0;
  running: string[] = [];

  constructor(private readonly behaviour: FakeCompile) {}

  async runningMetaEditors(): Promise<string[]> {
    return this.running;
  }

  start(executable: string, args: string[]): StartedProcess {
    this.starts.push({ executable, args });
    const source = argumentValue(args, "compile");
    const logFile = argumentValue(args, "log");
    const work = (async () => {
      if (this.behaviour.ex4) await writeFile(source.replace(/\.mq4$/i, ".ex4"), this.behaviour.ex4);
      if (this.behaviour.log) await writeFile(logFile, compileLogBytes(this.behaviour.log.text, this.behaviour.log.encoding));
    })();
    let kill!: () => void;
    const killed = new Promise<null>((resolve) => (kill = () => resolve(null)));
    const exited = this.behaviour.hang
      ? killed
      : work.then(() => this.behaviour.exitCode ?? 0);
    return {
      exited,
      kill: () => {
        this.killed++;
        kill();
      },
    };
  }
}

/** `/name:"value"` → value. */
function argumentValue(args: string[], name: string): string {
  const arg = args.find((candidate) => candidate.toLowerCase().startsWith(`/${name}:`));
  if (!arg) throw new Error(`fake MetaEditor: no /${name}: argument in ${JSON.stringify(args)}`);
  return arg.slice(name.length + 2).replace(/^"(.*)"$/, "$1");
}

/** A staging folder laid out as the runner expects: `<stage>\MQL4\Experts\QuoteBridge.mq4`. */
export async function stagingFolder(): Promise<{ root: string; source: string; includeFolder: string; logFile: string; metaEditor: string; cleanup(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "quotebridge-compile-"));
  const includeFolder = join(root, "MQL4");
  await mkdir(join(includeFolder, "Experts"), { recursive: true });
  const source = join(includeFolder, "Experts", "QuoteBridge.mq4");
  await writeFile(source, "// QuoteBridge EA source\r\n");
  const installation = join(root, "CMC Markets MetaTrader 4");
  await mkdir(installation);
  const metaEditor = join(installation, "metaeditor.exe");
  await writeFile(metaEditor, "fake");
  return { root, source, includeFolder, logFile: join(root, "compile.log"), metaEditor, cleanup: () => rm(root, { recursive: true, force: true }) };
}
