// MetaEditor runner: compiles the staged QuoteBridge EA with a terminal's own metaeditor.exe.
// The process side is a port so tests can use a fake MetaEditor.
import { readFile, rm, stat } from "node:fs/promises";
import { win32 } from "node:path";
import { parseCompileLog } from "./compile-log.js";
import type { CompileLog } from "./compile-log.js";
import { windowsMetaEditorProcesses } from "./windows-processes.js";

/** A started MetaEditor process. */
export interface StartedProcess {
  /** Resolves with the exit code (null when killed). */
  exited: Promise<number | null>;
  kill(): void;
}

/** The process port: starting MetaEditor and seeing which MetaEditors are running. */
export interface MetaEditorProcesses {
  start(executable: string, args: string[]): StartedProcess;
  /** Executable paths of every running MetaEditor. */
  runningMetaEditors(): Promise<string[]>;
}

export interface CompileRequest {
  /** `metaeditor.exe` in the terminal's installation folder. */
  metaEditor: string;
  /** The staged `QuoteBridge.mq4` (`<stage>\MQL4\Experts\QuoteBridge.mq4`). */
  source: string;
  /** The staged `MQL4` folder, passed as `/inc:`. */
  includeFolder: string;
  /** Where MetaEditor writes its log (`/log:`). */
  logFile: string;
  /** Defaults to {@link METAEDITOR_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Aborting ends MetaEditor and the compile fails with `cancelled` (the app is stopping). */
  signal?: AbortSignal;
}

/** How long MetaEditor may take before it is killed and the compile fails. */
export const METAEDITOR_TIMEOUT_MS = 120_000;

export type CompileOutcome =
  | { ok: true; ex4: string; log: CompileLog; exitCode: number | null }
  | { ok: false; reason: CompileFailure; log?: CompileLog; exitCode?: number | null };

/** Why a compile failed. */
export type CompileFailure =
  /** The installation folder has no `metaeditor.exe`: this terminal cannot be managed. */
  | "no-metaeditor"
  /** A MetaEditor from the same installation folder is running; the user must close it first. */
  | "metaeditor-running"
  /** The log's Result line reports errors. */
  | "compile-errors"
  /** No log, or a log without a Result line. */
  | "no-result"
  /** No fresh, non-empty `.ex4` next to the staged source. */
  | "no-ex4"
  /** MetaEditor did not exit within the timeout and was killed. */
  | "timeout"
  /** The compile was cancelled through its signal (the app is stopping); MetaEditor was ended. */
  | "cancelled";

/**
 * Compiles the staged EA. Success = the log's Result line reports 0 errors and a fresh, non-empty
 * `.ex4` exists. MetaEditor's exit code is reported but ignored (it can be 1 on success).
 */
export async function compileWithMetaEditor(
  request: CompileRequest,
  processes: MetaEditorProcesses = windowsMetaEditorProcesses,
): Promise<CompileOutcome> {
  const ex4 = request.source.replace(/\.mq4$/i, ".ex4");
  const args = [`/compile:"${request.source}"`, `/inc:"${request.includeFolder}"`, `/log:"${request.logFile}"`];
  if (!(await isNonEmptyFile(request.metaEditor))) return { ok: false, reason: "no-metaeditor" };

  // A running MetaEditor would receive the command line instead and compile in the user's editor.
  const installationFolder = folderKey(win32.dirname(request.metaEditor));
  const running = await processes.runningMetaEditors();
  if (running.some((executable) => folderKey(win32.dirname(executable)) === installationFolder)) {
    return { ok: false, reason: "metaeditor-running" };
  }

  // Anything left from an earlier compile must not count as this run's output.
  await rm(ex4, { force: true });
  await rm(request.logFile, { force: true });

  if (request.signal?.aborted) return { ok: false, reason: "cancelled" };
  const compiler = processes.start(request.metaEditor, args);
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), request.timeoutMs ?? METAEDITOR_TIMEOUT_MS);
  });
  const cancelled = new Promise<"cancelled">((resolve) => {
    onAbort = () => resolve("cancelled");
    request.signal?.addEventListener("abort", onAbort, { once: true });
  });
  const exit = await Promise.race([compiler.exited, timedOut, cancelled]).finally(() => {
    clearTimeout(timer);
    if (onAbort) request.signal?.removeEventListener("abort", onAbort);
  });
  if (exit === "timeout" || exit === "cancelled") {
    compiler.kill();
    return { ok: false, reason: exit };
  }
  const exitCode = exit;

  const logBytes = await readIfPresent(request.logFile);
  const log = logBytes && parseCompileLog(logBytes);
  if (!log?.result) return { ok: false, reason: "no-result", log, exitCode };
  if (log.result.errors > 0) return { ok: false, reason: "compile-errors", log, exitCode };
  if (!(await isNonEmptyFile(ex4))) return { ok: false, reason: "no-ex4", log, exitCode };
  return { ok: true, ex4, log, exitCode };
}

async function readIfPresent(file: string): Promise<Uint8Array | undefined> {
  try {
    return await readFile(file);
  } catch {
    return undefined;
  }
}

async function isNonEmptyFile(file: string): Promise<boolean> {
  try {
    const info = await stat(file);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

/** Windows paths compare without case, slash style or a trailing separator. */
function folderKey(folder: string): string {
  return folder.replace(/\//g, "\\").replace(/\\+$/, "").toUpperCase();
}
