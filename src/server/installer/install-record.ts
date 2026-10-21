// Install record: per managed terminal, what the app installed (bridge-file hashes, EA version,
// source hash) and the last failed attempt. JSON under `<app data>\installs\<Terminal ID>\`.
import { join } from "node:path";
import { readIfPresent, writeFileAtomic, type InstallerFileSystem } from "./file-system.js";

export const INSTALL_RECORD_FORMAT = 1;

/** One bridge file in a terminal's data folder, by its path relative to the data folder. */
export interface RecordedFile {
  target: string;
  sha256: string;
}

export interface InstalledBridge {
  eaVersion: string;
  sourceHash: string;
  /** Hash of the installable bundle at install time (the bundle's `bundleHash`); absent in records written before it existed. */
  bundleHash?: string;
  serverEndpoint: string;
  /** The Terminal ID written into the installed template. */
  terminalId: string;
  dllName: string;
  installedAt: string;
  /**
   * The install run that wrote these files. Writing the record is the run's commit point: a run whose
   * id is recorded here finished copying and verifying, so recovery keeps it instead of rolling it back.
   */
  runId?: string;
  /** Every file this app owns in the data folder, older DLL versions included. */
  files: RecordedFile[];
}

/** Why the last install attempt failed. Cleared by the next successful install. */
export interface InstallFailure {
  /** `compile`: MetaEditor did not produce an EA (nothing was copied). `copy`: rolled back. */
  stage: "compile" | "copy";
  /** For `compile`: the runner's reason (`compile-errors`, `no-metaeditor`, `metaeditor-running`, …). For `copy`: `copy-failed`. */
  reason: string;
  /** Plain words for the user. */
  message: string;
  at: string;
  /** Bundled source hash the attempt used; a newer bundle makes the failure out of date. */
  sourceHash: string;
  /** The MetaEditor log of the attempt, kept under the app data folder. */
  compileLog?: string;
  errors?: { file: string; line: number; column: number; code: number; text: string }[];
  warnings?: number;
}

export interface InstallRecord {
  format: typeof INSTALL_RECORD_FORMAT;
  terminalId: string;
  dataFolder: string;
  installed: InstalledBridge | null;
  lastFailure: InstallFailure | null;
  /** Files Remove could not delete (a DLL MetaTrader holds locked); retried on the next start. */
  pendingRemoval: RecordedFile[];
}

export class InstallRecords {
  constructor(
    private readonly appDataFolder: string,
    private readonly fs: InstallerFileSystem,
  ) {}

  folderFor(terminalId: string): string {
    return join(this.appDataFolder, "installs", terminalId);
  }

  async read(terminalId: string): Promise<InstallRecord | undefined> {
    const bytes = await readIfPresent(this.fs, join(this.folderFor(terminalId), "record.json"));
    if (!bytes) return undefined;
    const record = JSON.parse(bytes.toString("utf8")) as InstallRecord;
    if (record.format !== INSTALL_RECORD_FORMAT) throw new Error(`Install record of ${terminalId} has unknown format ${record.format}`);
    return record;
  }

  async write(record: InstallRecord): Promise<void> {
    await writeFileAtomic(this.fs, join(this.folderFor(record.terminalId), "record.json"), Buffer.from(JSON.stringify(record, null, 2) + "\n"));
  }

  async delete(terminalId: string): Promise<void> {
    await this.fs.removeFile(join(this.folderFor(terminalId), "record.json"));
  }

  /** Terminal IDs that have an install-record folder. */
  async terminalIds(): Promise<string[]> {
    return (await this.fs.listFolder(join(this.appDataFolder, "installs"))).filter((entry) => !entry.isFile).map((entry) => entry.name);
  }
}

export function emptyRecord(terminalId: string, dataFolder: string): InstallRecord {
  return { format: INSTALL_RECORD_FORMAT, terminalId, dataFolder, installed: null, lastFailure: null, pendingRemoval: [] };
}
