// Bridge installer: installs, updates and removes the bridge files of a managed terminal.
// Per install: stage sources → compile with the terminal's MetaEditor → write a restoration
// manifest → back up files it will replace → copy → verify hashes → record the install.
// Transport-free: the server's HTTP endpoints call it.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { compileWithMetaEditor, type CompileOutcome, type MetaEditorProcesses } from "../../main/metaeditor/index.js";
import { terminalIdFor } from "../../main/terminal-catalog/index.js";
import { EA_SOURCE_TARGET, EA_TARGET, isDll, loadBridgeBundle, sha256, TEMPLATE_TARGET, type BridgeBundle, type BridgeBundleFolders, type BundledFile } from "./bundle.js";
import { errorCode, nodeInstallerFileSystem, readIfPresent, writeFileAtomic, type InstallerFileSystem } from "./file-system.js";
import { emptyRecord, InstallRecords, type InstallFailure, type InstallRecord, type RecordedFile } from "./install-record.js";
import { serverEndpointFor, substituteTemplate, templateTerminalId } from "./template.js";

/** A terminal to install into (a detected terminal fits). */
export interface InstallTarget {
  dataFolder: string;
  /** Holds `metaeditor.exe`; without it the terminal cannot be managed. */
  installationFolder: string | undefined;
}

export interface BridgeInstallerOptions {
  /** `%APPDATA%\QuoteBridge`: staging, install records, manifests and backups live here. */
  appDataFolder: string;
  bundle: BridgeBundleFolders;
  /** MetaEditor process port (default: the Windows adapter). */
  metaEditor?: MetaEditorProcesses;
  fs?: InstallerFileSystem;
  now?: () => Date;
  compileTimeoutMs?: number;
}

/**
 * - `not-installed`: no bridge files from this app or the legacy setup.
 * - `installing`: an install is running now.
 * - `installed`: the bundled EA version is installed (`eaVersion`).
 * - `outdated`: installed, but the app's bundled EA sources changed since.
 * - `compile-failed`: the last install of the current sources failed to compile (`lastFailure`).
 * - `no-metaeditor`: the installation folder has no `metaeditor.exe`; the terminal can't be managed.
 * - `installed-legacy`: bridge files from the legacy manual setup, no install by this app.
 */
export type TerminalInstallState = "not-installed" | "installing" | "installed" | "outdated" | "compile-failed" | "no-metaeditor" | "installed-legacy";

export interface TerminalInstallStatus {
  terminalId: string;
  state: TerminalInstallState;
  /** EA version this app installed (from the install record). */
  eaVersion?: string;
  /** For `installed-legacy`: the TerminalId the legacy template carries (e.g. `mt4-main`). */
  legacyTerminalId?: string;
  /** The last failed attempt, if it is newer than the last successful install. */
  lastFailure?: InstallFailure;
  /** Files Remove left behind because MetaTrader holds them locked. */
  pendingRemoval: string[];
}

/** What happened to one bridge file. */
export type FileAction =
  /** The file did not exist and was created. */
  | "created"
  /** A different file was backed up and replaced. */
  | "replaced"
  /** The file was already identical. */
  | "unchanged"
  /** A different DLL with the same versioned name exists; DLLs are never overwritten. */
  | "kept-existing-dll";

export type InstallResult =
  | { ok: true; terminalId: string; eaVersion: string; files: { target: string; action: FileAction }[]; backupFolder?: string; compileWarnings: number }
  | { ok: false; terminalId: string; failure: InstallFailure; rollback?: RollbackReport };

export interface RollbackReport {
  ok: boolean;
  /** Paths that could not be restored or removed, with the backup folder to recover from. */
  problems: string[];
  backupFolder: string;
}

export interface RemoveResult {
  terminalId: string;
  removed: string[];
  /** Files changed since install (by the user or MetaTrader); left in place. */
  keptModified: string[];
  /** Locked files (a DLL MetaTrader has loaded); retried by {@link BridgeInstaller.recover}. */
  pending: string[];
}

export class InstallInProgressError extends Error {
  constructor(readonly terminalId: string) {
    super(`An install is already running for terminal ${terminalId}`);
  }
}

interface PlannedFile {
  target: string;
  action: "create" | "replace" | "skip" | "keep-existing-dll";
  sha256: string;
  previousSha256?: string;
  /** Backup of the replaced file, under the run folder. */
  backup?: string;
  /** The replaced file was this app's own (its hash matched the install record). */
  appOwned?: boolean;
}

interface RestorationManifest {
  format: 1;
  runId: string;
  terminalId: string;
  dataFolder: string;
  startedAt: string;
  state: "in-progress" | "done" | "rolled-back" | "rollback-failed";
  files: PlannedFile[];
}

const LEGACY_MARKERS = [EA_TARGET, EA_SOURCE_TARGET];

export class BridgeInstaller {
  private readonly fs: InstallerFileSystem;
  private readonly records: InstallRecords;
  private readonly now: () => Date;
  private readonly installing = new Set<string>();
  private bundle?: Promise<BridgeBundle>;

  constructor(private readonly options: BridgeInstallerOptions) {
    this.fs = options.fs ?? nodeInstallerFileSystem;
    this.records = new InstallRecords(options.appDataFolder, this.fs);
    this.now = options.now ?? (() => new Date());
  }

  /** The bundled EA version and source hash this app installs. */
  loadBundle(): Promise<BridgeBundle> {
    this.bundle ??= loadBridgeBundle(this.options.bundle, this.fs);
    return this.bundle;
  }

  async status(target: InstallTarget): Promise<TerminalInstallStatus> {
    const terminalId = terminalIdFor(target.dataFolder);
    const bundle = await this.loadBundle();
    const record = await this.records.read(terminalId);
    const status: TerminalInstallStatus = { terminalId, state: "not-installed", pendingRemoval: record?.pendingRemoval.map((file) => file.target) ?? [] };
    if (record?.installed) status.eaVersion = record.installed.eaVersion;
    const failure = record?.lastFailure;
    if (failure && failure.sourceHash === bundle.sourceHash) status.lastFailure = failure;

    if (this.installing.has(terminalId)) status.state = "installing";
    else if (status.lastFailure?.reason === "no-metaeditor") status.state = "no-metaeditor";
    else if (status.lastFailure?.stage === "compile") status.state = "compile-failed";
    else if (record?.installed && record.installed.sourceHash === bundle.sourceHash) status.state = "installed";
    else if (!(await this.hasMetaEditor(target))) status.state = "no-metaeditor";
    else if (record?.installed) status.state = "outdated";
    else if (await this.hasLegacyFiles(target.dataFolder)) {
      status.state = "installed-legacy";
      const template = await readIfPresent(this.fs, join(target.dataFolder, TEMPLATE_TARGET));
      const legacyId = template && templateTerminalId(template.toString("utf8"));
      if (legacyId) status.legacyTerminalId = legacyId;
    }
    return status;
  }

  /**
   * Installs or updates the bridge files (also the Recompile action). A failed compile copies
   * nothing; a failed copy is rolled back. Either way the old bridge files keep working.
   */
  async install(target: InstallTarget, settings: { eaPort: number }): Promise<InstallResult> {
    const terminalId = terminalIdFor(target.dataFolder);
    if (this.installing.has(terminalId)) throw new InstallInProgressError(terminalId);
    this.installing.add(terminalId);
    try {
      return await this.runInstall(terminalId, target, settings);
    } finally {
      this.installing.delete(terminalId);
    }
  }

  private async runInstall(terminalId: string, target: InstallTarget, settings: { eaPort: number }): Promise<InstallResult> {
    const bundle = await this.loadBundle();
    const record = (await this.records.read(terminalId)) ?? emptyRecord(terminalId, target.dataFolder);
    const runId = this.newRunId();
    const runFolder = join(this.records.folderFor(terminalId), "runs", runId);
    const stage = join(this.options.appDataFolder, "staging", `${terminalId}-${runId}`);

    try {
      // 1. Stage and compile.
      const compiled = await this.compile(target, bundle, stage);
      const keptLog = await this.keepCompileLog(terminalId, join(stage, "compile.log"));
      if (!compiled.ok) {
        const failure = compileFailure(compiled, bundle.sourceHash, this.now(), keptLog);
        await this.records.write({ ...record, lastFailure: failure });
        return { ok: false, terminalId, failure };
      }
      const ex4 = await this.fs.readFile(compiled.ex4);

      // 2. Plan and write the restoration manifest before touching the data folder.
      const serverEndpoint = serverEndpointFor(settings.eaPort);
      const files: BundledFile[] = [
        ...bundle.sources,
        { target: EA_TARGET, bytes: ex4 },
        ...bundle.nativeFiles,
        { target: TEMPLATE_TARGET, bytes: Buffer.from(substituteTemplate(bundle.template, { terminalId, serverEndpoint }), "utf8") },
      ];
      const owned = new Map((record.installed?.files ?? []).map((file) => [file.target, file.sha256]));
      const manifest: RestorationManifest = {
        format: 1,
        runId,
        terminalId,
        dataFolder: target.dataFolder,
        startedAt: this.now().toISOString(),
        state: "in-progress",
        files: [],
      };
      const current = new Map<string, Buffer>();
      for (const file of files) {
        const existing = await readIfPresent(this.fs, join(target.dataFolder, file.target));
        const planned: PlannedFile = { target: file.target, action: "create", sha256: sha256(file.bytes) };
        if (existing) {
          planned.previousSha256 = sha256(existing);
          if (planned.previousSha256 === planned.sha256) planned.action = "skip";
          else if (isDll(file.target)) planned.action = "keep-existing-dll";
          else {
            planned.action = "replace";
            planned.backup = join(runFolder, "backup", file.target);
            planned.appOwned = owned.get(file.target) === planned.previousSha256;
            current.set(file.target, existing);
          }
        }
        manifest.files.push(planned);
      }
      await this.writeManifest(runFolder, manifest);

      // 3. Back up, copy, verify; roll back on any failure.
      try {
        for (const planned of manifest.files) {
          if (planned.action !== "replace") continue;
          const original = current.get(planned.target)!;
          await this.fs.writeFile(planned.backup!, original);
          if (sha256(await this.fs.readFile(planned.backup!)) !== planned.previousSha256) throw new Error(`Backup of ${planned.target} does not match the original`);
        }
        for (const [index, planned] of manifest.files.entries()) {
          if (planned.action !== "create" && planned.action !== "replace") continue;
          await this.fs.writeFile(join(target.dataFolder, planned.target), files[index].bytes, { exclusive: planned.action === "create" });
        }
        for (const planned of manifest.files) {
          if (planned.action === "keep-existing-dll") continue;
          const written = await this.fs.readFile(join(target.dataFolder, planned.target));
          if (sha256(written) !== planned.sha256) throw new Error(`${planned.target} does not match the bundled file after copying`);
        }
      } catch (error) {
        const rollback = await this.rollback(runFolder, manifest);
        const failure: InstallFailure = {
          stage: "copy",
          reason: "copy-failed",
          message: `Copying the bridge files failed and the terminal was restored: ${errorMessage(error)}`,
          at: this.now().toISOString(),
          sourceHash: bundle.sourceHash,
          ...(keptLog ? { compileLog: keptLog } : {}),
        };
        if (!rollback.ok) failure.message = `Copying the bridge files failed and restoring the terminal failed too; backups are in ${rollback.backupFolder}`;
        await this.records.write({ ...record, lastFailure: failure });
        return { ok: false, terminalId, failure, rollback };
      }

      // 4. Record the install.
      const installedTargets = new Set(manifest.files.filter((file) => file.action !== "keep-existing-dll").map((file) => file.target));
      const recorded: RecordedFile[] = manifest.files.filter((file) => installedTargets.has(file.target)).map((file) => ({ target: file.target, sha256: file.sha256 }));
      // Older DLL versions stay (MetaTrader may still have them loaded) and stay ours to remove.
      for (const old of record.installed?.files ?? []) {
        if (installedTargets.has(old.target) || !isDll(old.target)) continue;
        const bytes = await readIfPresent(this.fs, join(target.dataFolder, old.target));
        if (bytes && sha256(bytes) === old.sha256) recorded.push(old);
      }
      await this.records.write({
        ...record,
        dataFolder: target.dataFolder,
        installed: {
          eaVersion: bundle.eaVersion,
          sourceHash: bundle.sourceHash,
          serverEndpoint,
          terminalId,
          dllName: bundle.dllName,
          installedAt: this.now().toISOString(),
          files: recorded,
        },
        lastFailure: null,
      });
      manifest.state = "done";
      // Backups of the app's own earlier files are not needed once the install succeeded; backups
      // of anything else (legacy or user files) are kept with their manifest.
      const keepRun = manifest.files.some((file) => file.action === "replace" && !file.appOwned);
      if (keepRun) await this.writeManifest(runFolder, manifest);
      else await this.fs.removeFolder(runFolder);

      return {
        ok: true,
        terminalId,
        eaVersion: bundle.eaVersion,
        files: manifest.files.map((file) => ({ target: file.target, action: fileAction(file) })),
        ...(keepRun ? { backupFolder: join(runFolder, "backup") } : {}),
        compileWarnings: compiled.log.result?.warnings ?? 0,
      };
    } finally {
      await this.fs.removeFolder(stage);
    }
  }

  /** Deletes only the files in the install record, and only while they are unchanged. */
  async remove(target: InstallTarget): Promise<RemoveResult> {
    const terminalId = terminalIdFor(target.dataFolder);
    if (this.installing.has(terminalId)) throw new InstallInProgressError(terminalId);
    const record = await this.records.read(terminalId);
    const result: RemoveResult = { terminalId, removed: [], keptModified: [], pending: [] };
    if (!record) return result;
    const pending: RecordedFile[] = [];
    for (const file of [...(record.installed?.files ?? []), ...record.pendingRemoval]) {
      const outcome = await this.removeOwnedFile(record.dataFolder, file);
      if (outcome === "pending") pending.push(file);
      if (outcome === "removed") result.removed.push(file.target);
      if (outcome === "modified") result.keptModified.push(file.target);
    }
    result.pending = pending.map((file) => file.target);
    await this.records.write({ ...record, installed: null, lastFailure: null, pendingRemoval: pending });
    return result;
  }

  /**
   * Run on server start: rolls back installs interrupted by a crash or power loss (from their
   * restoration manifests) and retries removals of files that were locked.
   */
  async recover(): Promise<{ rolledBack: string[]; removed: string[]; pending: string[] }> {
    const report = { rolledBack: [] as string[], removed: [] as string[], pending: [] as string[] };
    // Staging left behind by an interrupted install holds nothing worth keeping.
    await this.fs.removeFolder(join(this.options.appDataFolder, "staging"));
    for (const terminalId of await this.records.terminalIds()) {
      const runs = join(this.records.folderFor(terminalId), "runs");
      for (const run of await this.fs.listFolder(runs)) {
        if (run.isFile) continue;
        const bytes = await readIfPresent(this.fs, join(runs, run.name, "manifest.json"));
        if (!bytes) continue;
        const manifest = JSON.parse(bytes.toString("utf8")) as RestorationManifest;
        if (manifest.state !== "in-progress") continue;
        await this.rollback(join(runs, run.name), manifest);
        report.rolledBack.push(`${terminalId}/${run.name}`);
      }
      const record = await this.records.read(terminalId);
      if (!record?.pendingRemoval.length) continue;
      const pending: RecordedFile[] = [];
      for (const file of record.pendingRemoval) {
        const outcome = await this.removeOwnedFile(record.dataFolder, file);
        if (outcome === "pending") pending.push(file);
        else if (outcome === "removed") report.removed.push(join(record.dataFolder, file.target));
      }
      report.pending.push(...pending.map((file) => join(record.dataFolder, file.target)));
      await this.records.write({ ...record, pendingRemoval: pending });
    }
    return report;
  }

  private async removeOwnedFile(dataFolder: string, file: RecordedFile): Promise<"removed" | "missing" | "modified" | "pending"> {
    const path = join(dataFolder, file.target);
    const bytes = await readIfPresent(this.fs, path);
    if (!bytes) return "missing";
    if (sha256(bytes) !== file.sha256) return "modified";
    try {
      await this.fs.removeFile(path);
      return "removed";
    } catch (error) {
      if (["EBUSY", "EPERM", "EACCES"].includes(errorCode(error) ?? "")) return "pending";
      throw error;
    }
  }

  private async compile(target: InstallTarget, bundle: BridgeBundle, stage: string): Promise<CompileOutcome> {
    if (!target.installationFolder) return { ok: false, reason: "no-metaeditor" };
    for (const source of bundle.sources) await this.fs.writeFile(join(stage, source.target), source.bytes);
    return compileWithMetaEditor(
      {
        metaEditor: join(target.installationFolder, "metaeditor.exe"),
        source: join(stage, EA_SOURCE_TARGET),
        includeFolder: join(stage, "MQL4"),
        logFile: join(stage, "compile.log"),
        ...(this.options.compileTimeoutMs ? { timeoutMs: this.options.compileTimeoutMs } : {}),
      },
      this.options.metaEditor,
    );
  }

  /** Keeps the latest MetaEditor log of a terminal under the app data folder. */
  private async keepCompileLog(terminalId: string, logFile: string): Promise<string | undefined> {
    const bytes = await readIfPresent(this.fs, logFile);
    if (!bytes) return undefined;
    const kept = join(this.records.folderFor(terminalId), "last-compile.log");
    await this.fs.writeFile(kept, bytes);
    return kept;
  }

  /** Restores replaced files from their backups and deletes only files this run created. */
  private async rollback(runFolder: string, manifest: RestorationManifest): Promise<RollbackReport> {
    const problems: string[] = [];
    for (const planned of manifest.files) {
      const path = join(manifest.dataFolder, planned.target);
      try {
        const now = await readIfPresent(this.fs, path);
        if (planned.action === "create") {
          // Only a file with this run's content is ours; anything else appeared from elsewhere.
          if (now && sha256(now) === planned.sha256) await this.fs.removeFile(path);
        } else if (planned.action === "replace") {
          if (now && sha256(now) === planned.previousSha256) continue;
          const backup = await this.fs.readFile(planned.backup!);
          if (sha256(backup) !== planned.previousSha256) throw new Error("backup does not match the original");
          await this.fs.writeFile(path, backup);
        }
      } catch (error) {
        problems.push(`${path}: ${errorMessage(error)}`);
      }
    }
    manifest.state = problems.length ? "rollback-failed" : "rolled-back";
    await this.writeManifest(runFolder, manifest);
    return { ok: problems.length === 0, problems, backupFolder: join(runFolder, "backup") };
  }

  private writeManifest(runFolder: string, manifest: RestorationManifest): Promise<void> {
    return writeFileAtomic(this.fs, join(runFolder, "manifest.json"), Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
  }

  private async hasMetaEditor(target: InstallTarget): Promise<boolean> {
    if (!target.installationFolder) return false;
    const bytes = await readIfPresent(this.fs, join(target.installationFolder, "metaeditor.exe")).catch(() => undefined);
    return !!bytes && bytes.length > 0;
  }

  private async hasLegacyFiles(dataFolder: string): Promise<boolean> {
    for (const marker of LEGACY_MARKERS) if (await readIfPresent(this.fs, join(dataFolder, marker))) return true;
    return false;
  }

  private newRunId(): string {
    return `${this.now().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  }
}

function fileAction(file: PlannedFile): FileAction {
  switch (file.action) {
    case "create":
      return "created";
    case "replace":
      return "replaced";
    case "skip":
      return "unchanged";
    case "keep-existing-dll":
      return "kept-existing-dll";
  }
}

const COMPILE_MESSAGES: Record<string, string> = {
  "no-metaeditor": "This terminal has no MetaEditor (metaeditor.exe) in its installation folder, so the app cannot compile the QuoteBridge EA for it.",
  "metaeditor-running": "MetaEditor of this terminal is open. Close it, then install again.",
  "compile-errors": "MetaEditor reported errors compiling the QuoteBridge EA. The EA already installed was left in place.",
  "no-result": "MetaEditor finished without reporting a result. The EA already installed was left in place.",
  "no-ex4": "MetaEditor reported no errors but wrote no QuoteBridge.ex4. The EA already installed was left in place.",
  timeout: "MetaEditor did not finish compiling within 2 minutes and was stopped. The EA already installed was left in place.",
};

function compileFailure(outcome: Extract<CompileOutcome, { ok: false }>, sourceHash: string, at: Date, compileLog: string | undefined): InstallFailure {
  const failure: InstallFailure = { stage: "compile", reason: outcome.reason, message: COMPILE_MESSAGES[outcome.reason] ?? outcome.reason, at: at.toISOString(), sourceHash };
  if (compileLog) failure.compileLog = compileLog;
  if (outcome.log) {
    failure.errors = outcome.log.messages
      .filter((message) => message.severity === "error")
      .map(({ file, line, column, code, text }) => ({ file, line, column, code, text }));
    failure.warnings = outcome.log.result?.warnings ?? 0;
  }
  return failure;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
