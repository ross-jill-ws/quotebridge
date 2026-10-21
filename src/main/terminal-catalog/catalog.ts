import { join } from "node:path";
import { nodeTerminalFileSystem, type TerminalFileSystem } from "./file-system.js";
import { decodeOriginText } from "./origin-text.js";
import { dataFolderNameFor, normaliseFolderPath } from "./paths.js";
import { PE_HEADER_PROBE_BYTES, PE_MACHINE_X64, PE_MACHINE_X86, peMachineType } from "./pe-machine.js";
import { terminalIdFor } from "./terminal-id.js";

export type TerminalKind = "mt4" | "mt5" | "unknown";

/** Why the catalog believes in a terminal, its folders and its mode. */
export type TerminalEvidence =
  /** The data folder's `origin.txt` names the installation folder. */
  | "origin.txt"
  /** The data folder's name is the hash of the installation folder's path. */
  | "folder-name-hash"
  /** The installation folder sits in a well-known install location. */
  | "well-known-location"
  /** A running terminal process was started from the installation folder. */
  | "running-process"
  /** That process was started with `/portable`: the installation folder is the data folder. */
  | "portable-switch"
  /** The user chose the folder; unpaired, that confirms portable mode. */
  | "user-added";

export interface DetectedTerminal {
  /** What the user recognises: the installation folder's name, else the data folder's. */
  name: string;
  installationFolder: string | undefined;
  dataFolder: string | undefined;
  /** Derived from the data folder; undefined until the data folder is known. */
  terminalId: string | undefined;
  kind: TerminalKind;
  portable: boolean;
  /** True when the pairing could not be proven and the user should confirm the folder. */
  needsConfirmation: boolean;
  evidence: TerminalEvidence[];
}

export interface TerminalSources {
  /** `%APPDATA%\MetaQuotes\Terminal`. */
  dataRoot: string;
  /** Folders whose direct sub-folders may be installation folders (Program Files and the like). */
  installationRoots?: string[];
  /** Terminal processes running now. */
  runningTerminals?: RunningTerminal[];
  /** Installation folders the user chose by hand. */
  userAddedFolders?: string[];
}

export interface RunningTerminal {
  /** Full path of the running `terminal.exe` / `terminal64.exe`. */
  executablePath: string;
  /** Started with the `/portable` switch. */
  portable: boolean;
}

/** Folders in the data root shared by all terminals, never terminals themselves. */
const SHARED_FOLDERS = new Set(["COMMON", "COMMUNITY", "HELP"]);

const TERMINAL_EXECUTABLES = ["terminal.exe", "terminal64.exe"];

interface InstallationCandidate {
  folder: string;
  evidence: TerminalEvidence[];
}

export async function detectTerminals(
  sources: TerminalSources,
  fs: TerminalFileSystem = nodeTerminalFileSystem,
): Promise<DetectedTerminal[]> {
  const candidates = await findInstallationCandidates(sources, fs);
  const terminals: DetectedTerminal[] = [];

  for (const name of await fs.listFolders(sources.dataRoot)) {
    if (SHARED_FOLDERS.has(name.toUpperCase())) continue;
    const dataFolder = join(sources.dataRoot, name);
    const mql = await mqlFolderIn(dataFolder, fs);
    const originBytes = await fs.readFile(join(dataFolder, "origin.txt"));
    const origin = originBytes ? decodeOriginText(originBytes) || undefined : undefined;
    if (!origin && !mql) continue; // a leftover: neither origin.txt nor MQL4\/MQL5\

    const evidence: TerminalEvidence[] = [];
    let installationFolder = origin;
    let candidate: InstallationCandidate | undefined;
    if (origin) {
      evidence.push("origin.txt");
      candidate = candidates.get(normaliseFolderPath(origin));
    } else {
      candidate = [...candidates.values()].find((c) => dataFolderNameFor(c.folder) === name.toUpperCase());
      if (candidate) {
        evidence.push("folder-name-hash");
        installationFolder = candidate.folder;
      }
    }
    if (candidate?.evidence.includes("portable-switch")) continue; // not in use: the terminal keeps its data beside terminal.exe
    if (candidate) {
      candidates.delete(normaliseFolderPath(candidate.folder));
      evidence.push(...candidate.evidence);
    }

    terminals.push({
      name: installationFolder ? folderName(installationFolder) : name,
      installationFolder,
      dataFolder,
      terminalId: terminalIdFor(dataFolder),
      kind: classify(mql, installationFolder ? await executableKind(installationFolder, fs) : undefined),
      portable: false,
      needsConfirmation: false,
      evidence,
    });
  }

  for (const candidate of candidates.values()) {
    const executable = await executableKind(candidate.folder, fs);
    if (candidate.evidence.includes("portable-switch") || candidate.evidence.includes("user-added")) {
      terminals.push({
        name: folderName(candidate.folder),
        installationFolder: candidate.folder,
        dataFolder: candidate.folder,
        terminalId: terminalIdFor(candidate.folder),
        kind: classify(await mqlFolderIn(candidate.folder, fs), executable),
        portable: true,
        needsConfirmation: false,
        evidence: candidate.evidence,
      });
    } else {
      // No data folder pairs and nothing proves portable mode (an MQL4\ beside terminal.exe
      // does not): the user is asked.
      terminals.push({
        name: folderName(candidate.folder),
        installationFolder: candidate.folder,
        dataFolder: undefined,
        terminalId: undefined,
        kind: executable ?? "unknown",
        portable: false,
        needsConfirmation: true,
        evidence: candidate.evidence,
      });
    }
  }

  return terminals.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
}

/** Installation folders from every source, keyed by normalised path, evidence merged. */
async function findInstallationCandidates(
  sources: TerminalSources,
  fs: TerminalFileSystem,
): Promise<Map<string, InstallationCandidate>> {
  const candidates = new Map<string, InstallationCandidate>();
  const add = (folder: string, evidence: TerminalEvidence) => {
    const key = normaliseFolderPath(folder);
    const existing = candidates.get(key);
    if (!existing) candidates.set(key, { folder, evidence: [evidence] });
    else if (!existing.evidence.includes(evidence)) existing.evidence.push(evidence);
  };

  for (const running of sources.runningTerminals ?? []) {
    const folder = parentFolder(running.executablePath);
    add(folder, "running-process");
    if (running.portable) add(folder, "portable-switch");
  }
  for (const folder of sources.userAddedFolders ?? []) add(folder, "user-added");
  for (const root of sources.installationRoots ?? []) {
    for (const name of await fs.listFolders(root)) {
      const folder = join(root, name);
      if (await hasTerminalExecutable(folder, fs)) add(folder, "well-known-location");
    }
  }
  return candidates;
}

async function hasTerminalExecutable(folder: string, fs: TerminalFileSystem): Promise<boolean> {
  for (const exe of TERMINAL_EXECUTABLES) {
    if (await fs.isFile(join(folder, exe))) return true;
  }
  return false;
}

/**
 * The kind the data folder's `MQL4\`/`MQL5\` says, checked against the installation folder's
 * executable when there is one: an MQL4 data folder whose terminal is not x86 is not MT4.
 */
function classify(mql: "MQL4" | "MQL5" | undefined, executable: TerminalKind | undefined): TerminalKind {
  const fromData: TerminalKind = mql === "MQL4" ? "mt4" : mql === "MQL5" ? "mt5" : "unknown";
  if (executable === undefined) return fromData;
  if (fromData === "unknown") return executable;
  return fromData === executable ? fromData : "unknown";
}

/**
 * MT4 runs `terminal.exe` built for x86; MT5 runs a 64-bit terminal. Undefined when the folder
 * has no terminal executable.
 */
async function executableKind(installationFolder: string, fs: TerminalFileSystem): Promise<TerminalKind | undefined> {
  for (const exe of TERMINAL_EXECUTABLES) {
    const start = await fs.readStart(join(installationFolder, exe), PE_HEADER_PROBE_BYTES);
    if (!start) continue;
    const machine = peMachineType(start);
    if (machine === PE_MACHINE_X64) return "mt5";
    if (machine === PE_MACHINE_X86 && exe === "terminal.exe") return "mt4";
    return "unknown";
  }
  return undefined;
}

async function mqlFolderIn(folder: string, fs: TerminalFileSystem): Promise<"MQL4" | "MQL5" | undefined> {
  const mql4 = await fs.isFolder(join(folder, "MQL4"));
  const mql5 = await fs.isFolder(join(folder, "MQL5"));
  if (mql4 === mql5) return undefined;
  return mql4 ? "MQL4" : "MQL5";
}

function parentFolder(file: string): string {
  return file.replace(/[\\/]+[^\\/]*$/, "");
}

/** Last segment of a path written with either separator (origin.txt holds Windows paths). */
function folderName(folder: string): string {
  const segments = folder.split(/[\\/]+/).filter(Boolean);
  return segments.at(-1) ?? folder;
}
