// Windows adapter for the MetaEditor runner's process port.
import { execFile, spawn } from "node:child_process";
import type { MetaEditorProcesses, StartedProcess } from "./runner.js";

const PROCESS_QUERY =
  "Get-CimInstance Win32_Process -Filter \"Name='metaeditor.exe' OR Name='metaeditor64.exe'\" | " +
  "Select-Object ExecutablePath | ConvertTo-Json -Compress";

export const windowsMetaEditorProcesses: MetaEditorProcesses = {
  start(executable: string, args: string[]): StartedProcess {
    // Arguments go through verbatim: MetaEditor expects `/compile:"<path>"`, quotes after the colon.
    // Verbatim also leaves the executable unquoted, so quote it: installation folders have spaces.
    const child = spawn(executable, args, {
      argv0: `"${executable}"`,
      windowsVerbatimArguments: true,
      windowsHide: true,
      stdio: "ignore",
    });
    const exited = new Promise<number | null>((resolve) => {
      child.once("error", () => resolve(null));
      child.once("exit", (code) => resolve(code));
    });
    return { exited, kill: () => void child.kill() };
  },
  runningMetaEditors: async () => metaEditorsFromProcessList(await queryMetaEditorProcesses()),
};

/** Parses the JSON PowerShell prints for MetaEditor processes (one object, an array, or nothing). */
export function metaEditorsFromProcessList(json: string): string[] {
  if (!json.trim()) return [];
  const parsed: unknown = JSON.parse(json);
  const rows = (Array.isArray(parsed) ? parsed : [parsed]) as { ExecutablePath?: string | null }[];
  return rows.map((row) => row.ExecutablePath).filter((path): path is string => typeof path === "string" && path.length > 0);
}

function queryMetaEditorProcesses(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", PROCESS_QUERY],
      { windowsHide: true, timeout: 15_000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}
