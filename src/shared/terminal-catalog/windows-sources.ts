// Windows adapter: where terminals live on a real machine. Everything here is read-only.
import { execFile } from "node:child_process";
import { join } from "node:path";
import type { RunningTerminal, TerminalSources } from "./catalog.js";

const PROCESS_QUERY =
  "Get-CimInstance Win32_Process -Filter \"Name='terminal.exe' OR Name='terminal64.exe'\" | " +
  "Select-Object ExecutablePath, CommandLine | ConvertTo-Json -Compress";

/**
 * The catalog's sources on this Windows machine: the MetaQuotes data root, the usual install
 * locations, running terminal processes and the folders the user added by hand.
 */
export async function windowsTerminalSources(
  userAddedFolders: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
  listProcesses: () => Promise<string> = queryTerminalProcesses,
): Promise<TerminalSources> {
  const installationRoots = [env["ProgramFiles(x86)"], env["ProgramFiles"], env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs")]
    .filter((root): root is string => Boolean(root));
  let runningTerminals: RunningTerminal[] = [];
  try {
    runningTerminals = runningTerminalsFromProcessList(await listProcesses());
  } catch {
    // Process listing is a best-effort source; the data root and install locations still count.
  }
  return {
    dataRoot: join(env.APPDATA ?? "", "MetaQuotes", "Terminal"),
    installationRoots: [...new Set(installationRoots)],
    runningTerminals,
    userAddedFolders,
  };
}

/** Parses the JSON PowerShell prints for terminal processes (one object, an array, or nothing). */
export function runningTerminalsFromProcessList(json: string): RunningTerminal[] {
  if (!json.trim()) return [];
  const parsed: unknown = JSON.parse(json);
  const rows = (Array.isArray(parsed) ? parsed : [parsed]) as { ExecutablePath?: string | null; CommandLine?: string | null }[];
  return rows
    .filter((row) => typeof row.ExecutablePath === "string" && row.ExecutablePath.length > 0)
    .map((row) => ({
      executablePath: row.ExecutablePath as string,
      portable: commandLineArguments(row.CommandLine ?? "").some((arg) => /^[/-]portable$/i.test(arg)),
    }));
}

/** The arguments after the (possibly quoted) executable path. */
function commandLineArguments(commandLine: string): string[] {
  const rest = commandLine.trim().replace(/^("[^"]*"|\S+)/, "");
  return rest.trim().split(/\s+/).filter(Boolean);
}

function queryTerminalProcesses(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", PROCESS_QUERY],
      { windowsHide: true, timeout: 15_000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}
