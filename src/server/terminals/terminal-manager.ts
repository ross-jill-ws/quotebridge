// Terminal manager: what the Terminals view and the setup screen show and do. It joins the terminal
// catalog (detection, read-only), the settings (managed and declined terminals), the bridge
// installer (install state, Install / Recompile / Remove) and the bridge server's terminal presence
// (EA connected, EA version, the self-ticking checklist). Runs in the server process.
// On start it also propagates updates (ADR 9): every managed terminal whose install is out of date
// (newer bundled bridge files, or another EA port) is reinstalled through the normal install path.
import { isAbsolute, join } from "node:path";
import { type BridgeServer, ONLINE_WINDOW_MS } from "../bridge/index.js";
import {
  BridgeInstaller,
  InstallCancelledError,
  InstallInProgressError,
  type BridgeBundleFolders,
  type InstallerFileSystem,
  type InstallFailure,
  type RemoveResult,
  type TerminalInstallState,
} from "../installer/index.js";
import { parseCompileLog, type CompileLog, type MetaEditorProcesses } from "../../shared/metaeditor/index.js";
import type { Settings, SettingsStore } from "../../shared/settings-store.js";
import {
  detectTerminals,
  nodeTerminalFileSystem,
  windowsTerminalSources,
  type DetectedTerminal,
  type TerminalFileSystem,
  type TerminalKind,
  type TerminalSources,
} from "../../shared/terminal-catalog/index.js";

/**
 * How long `close()` waits for a running install after cancelling it. Well inside the supervisor's stop
 * deadline (5 s), so the stop path still reaches CHECKPOINT; an install cut short is rolled back on the next start.
 */
export const CLOSE_WAIT_MS = 1_500;

/** How long after an install (or app start) without any EA hello before the view hints at the checklist. */
export const DEFAULT_HINT_AFTER_MS = 2 * 60_000;

export interface TerminalManagerOptions {
  /** `%APPDATA%\QuoteBridge`: install records, staging, backups. */
  appDataFolder: string;
  /** The server process's settings store (the single writer of settings.json). */
  settings: SettingsStore;
  /** The bundled EA sources and the DLL folder. */
  bundle: BridgeBundleFolders;
  /** Where the catalog looks; default: this Windows machine (read-only). */
  sources?: (userAddedFolders: string[]) => Promise<TerminalSources>;
  catalogFs?: TerminalFileSystem;
  /** MetaEditor process port; default: the Windows adapter. */
  metaEditor?: MetaEditorProcesses;
  installerFs?: InstallerFileSystem;
  /** Called with the saved settings whenever the manager changed them (the host forwards them to main). */
  onSettingsSaved?: (settings: Settings) => void;
  hintAfterMs?: number;
  /** MetaEditor timeout (default: the runner's 120 s). */
  compileTimeoutMs?: number;
}

export interface TerminalManagerRuntime {
  bridge: BridgeServer;
  /** The EA port the server listens on; written into installed templates. */
  eaPort: number;
  now: () => number;
  /**
   * True while the terminal has an in-flight order request; its update then waits (ADR 9).
   * Milestone 1 sends no order requests, so nothing is ever in flight. Milestone 4 supplies this
   * and runs the held-back updates once the requests settle.
   */
  hasInFlightOrderRequests?: (terminalId: string) => boolean;
}

export type TerminalOperation = "queued" | "installing" | "removing";

export interface TerminalChecklist {
  refreshNavigator: boolean;
  applyTemplate: boolean;
  allowDllImports: boolean;
  /** The app has heard a hello from a QuoteBridge EA with this terminal's Terminal ID. */
  eaConnected: boolean;
}

export interface TerminalView {
  /** Stable key for the view: the Terminal ID, or the installation folder while the data folder is unknown. */
  key: string;
  terminalId: string | null;
  name: string;
  kind: TerminalKind;
  installationFolder: string | null;
  dataFolder: string | null;
  portable: boolean;
  /** The data folder could not be paired; the user should confirm the folder (portable mode). */
  needsConfirmation: boolean;
  /** Found by the last scan (a managed terminal that is gone is still listed). */
  detected: boolean;
  /** A terminal process was running from the installation folder at the last scan. */
  terminalRunning: boolean;
  /** The app can manage it (MetaTrader 4 with a known data folder). */
  supported: boolean;
  unsupportedReason: string | null;
  managed: boolean;
  declined: boolean;
  /** Detected, supported, neither managed nor declined: offered to the user, never installed silently. */
  offered: boolean;
  /** Install state from the bridge installer; null for unsupported terminals. */
  state: TerminalInstallState | null;
  operation: TerminalOperation | null;
  /** EA version this app installed (install record). */
  installedEaVersion: string | null;
  legacyTerminalId: string | null;
  lastFailure: InstallFailure | null;
  pendingRemoval: string[];
  /** Runtime presence: the last hello from this Terminal ID and the EA version it reported. */
  presence: { lastHello: number; eaVersion: string | null; online: boolean } | null;
  checklist: TerminalChecklist;
  /** Shown when installed but no EA has connected for a while. */
  hint: string | null;
  /** Why a managed terminal needs the user's attention (also drives the tray warning). */
  attention: string | null;
}

export interface TerminalsState {
  setupCompleted: boolean;
  startWithWindows: boolean;
  /** The EA version this app installs; null when the bundle cannot be read. */
  bundledEaVersion: string | null;
  bundleProblem: string | null;
  /** A scan or install is in progress. */
  busy: boolean;
  terminals: TerminalView[];
}

export interface TerminalAttention {
  terminalId: string;
  name: string;
  message: string;
}

/** A request the user can fix; `status` is the HTTP status to answer with. */
export class TerminalRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Entry {
  name: string;
  kind: TerminalKind;
  installationFolder: string | undefined;
  dataFolder: string | undefined;
  terminalId: string | undefined;
  portable: boolean;
  needsConfirmation: boolean;
  detected: boolean;
  running: boolean;
}

export class TerminalManager {
  private readonly installer: BridgeInstaller;
  private readonly catalogFs: TerminalFileSystem;
  private readonly sources: (userAddedFolders: string[]) => Promise<TerminalSources>;
  private readonly startedAt: number;
  private readonly userAdded = new Set<string>();
  private readonly operations = new Map<string, TerminalOperation>();
  /** Bumped on every change to `operations`, so a state read can tell it saw one consistent moment. */
  private operationsVersion = 0;
  private readonly installedAt = new Map<string, number>();
  /** Installs that threw instead of returning a result; shown as the terminal's last failure until the next attempt. */
  private readonly installErrors = new Map<string, InstallFailure>();
  private readonly listeners = new Set<() => void>();
  private entries: Entry[] = [];
  private scanning: Promise<void>;
  private queue: Promise<void> = Promise.resolve();
  private lastAttention: TerminalAttention[] = [];
  private closed = false;
  /** Aborted by `close()`: cancels a compile under way. */
  private readonly stopping = new AbortController();

  constructor(
    private readonly options: TerminalManagerOptions,
    private readonly runtime: TerminalManagerRuntime,
  ) {
    this.installer = new BridgeInstaller({
      appDataFolder: options.appDataFolder,
      bundle: options.bundle,
      ...(options.metaEditor ? { metaEditor: options.metaEditor } : {}),
      ...(options.installerFs ? { fs: options.installerFs } : {}),
      ...(options.compileTimeoutMs ? { compileTimeoutMs: options.compileTimeoutMs } : {}),
    });
    this.catalogFs = options.catalogFs ?? nodeTerminalFileSystem;
    this.sources = options.sources ?? ((folders) => windowsTerminalSources(folders));
    this.startedAt = runtime.now();
    // Interrupted installs are rolled back and locked removals retried before the first scan; then
    // out-of-date managed terminals are queued for their update.
    this.scanning = this.installer
      .recover()
      .catch((e) => console.error(`[QuoteBridge] install recovery failed: ${(e as Error).message}`))
      .then(() => this.scan())
      .then(() => this.queueUpdates());
    void this.scanning.then(() => this.emit());
  }

  /** Listeners run after anything the views show changed (scan, operation, settings). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Managed terminals that need attention, as of the latest state. */
  attention(): TerminalAttention[] {
    return this.lastAttention;
  }

  async state(): Promise<TerminalsState> {
    await this.scanning;
    const settings = await this.options.settings.read();
    let bundledEaVersion: string | null = null;
    let bundleProblem: string | null = null;
    try {
      bundledEaVersion = (await this.installer.loadBundle()).eaVersion;
    } catch (e) {
      bundleProblem = `The bundled bridge files cannot be read: ${(e as Error).message}`;
    }
    const presence = new Map(this.runtime.bridge.snapshot().terminals.map((p) => [p.terminalId, p]));
    // The views are read one after another; an install or removal that starts or ends meanwhile
    // would leave them disagreeing with each other and with `busy`. Read again until none did.
    let terminals: TerminalView[];
    let operations: Map<string, TerminalOperation>;
    let version: number;
    do {
      version = this.operationsVersion;
      operations = new Map(this.operations);
      terminals = [];
      for (const entry of this.withManaged(settings)) terminals.push(await this.view(entry, settings, presence, bundleProblem, operations));
    } while (version !== this.operationsVersion);
    this.lastAttention = terminals
      .filter((t) => t.attention && t.terminalId)
      .map((t) => ({ terminalId: t.terminalId!, name: t.name, message: t.attention! }));
    return {
      setupCompleted: settings.setupCompleted,
      startWithWindows: settings.startWithWindows,
      bundledEaVersion,
      bundleProblem,
      busy: operations.size > 0,
      terminals,
    };
  }

  /** Detects terminals again (newly found ones are offered, never installed). */
  async rescan(): Promise<TerminalsState> {
    await this.scanning;
    this.scanning = this.scan();
    await this.scanning;
    this.emit();
    return this.state();
  }

  /** Adds a terminal the catalog did not find, by its installation folder. Confirms portable mode for an unpaired folder. */
  async addFolder(folder: unknown): Promise<TerminalView> {
    if (typeof folder !== "string" || !folder.trim() || folder.length > 1000) throw new TerminalRequestError(400, "Expected a folder path.");
    const path = folder.trim().replace(/[\\/]+$/, "");
    if (!isAbsolute(path)) throw new TerminalRequestError(422, "Enter the full path of the terminal's installation folder, e.g. C:\\Program Files (x86)\\My Broker MetaTrader 4.");
    const hasTerminal = (await this.catalogFs.isFile(join(path, "terminal.exe"))) || (await this.catalogFs.isFile(join(path, "terminal64.exe")));
    if (!hasTerminal) throw new TerminalRequestError(422, "That folder has no terminal.exe. Choose the MetaTrader folder that holds terminal.exe.");
    this.userAdded.add(path);
    await this.rescan();
    const state = await this.state();
    const added = state.terminals.find((t) => t.installationFolder && sameFolder(t.installationFolder, path));
    if (!added) throw new TerminalRequestError(422, "No terminal was found in that folder.");
    return added;
  }

  /** The setup screen's Install: manages the ticked terminals, declines the others, saves Start with Windows. */
  async completeSetup(request: unknown): Promise<void> {
    const body = request as { install?: unknown; startWithWindows?: unknown } | null;
    if (!body || !isStringArray(body.install) || typeof body.startWithWindows !== "boolean") {
      throw new TerminalRequestError(400, "Expected { install: Terminal IDs, startWithWindows: true or false }.");
    }
    await this.scanning;
    const entries = this.supportedEntries(body.install);
    const startWithWindows = body.startWithWindows;
    const ticked = new Set(body.install);
    const declined = this.entries.filter((e) => isSupported(e) && !ticked.has(e.terminalId!));
    await this.saveSettings((s) => {
      // Checked inside the update, so two setup requests at once cannot both complete it.
      if (s.setupCompleted) throw new TerminalRequestError(409, "Setup is already complete. Use the Terminals view.");
      for (const entry of entries) manage(s, entry);
      for (const entry of declined) decline(s, entry);
      s.startWithWindows = startWithWindows;
      s.setupCompleted = true;
    });
    this.enqueueInstalls(entries);
  }

  /** Install or Recompile: makes the terminals managed and installs into them one after another. */
  async install(request: unknown): Promise<void> {
    const ids = (request as { terminalIds?: unknown } | null)?.terminalIds;
    if (!isStringArray(ids) || ids.length === 0) throw new TerminalRequestError(400, "Expected { terminalIds: [...] }.");
    await this.scanning;
    const settings = await this.options.settings.read();
    const entries = this.supportedEntries(ids, settings);
    for (const entry of entries) {
      if (this.operations.has(entry.terminalId!)) throw new TerminalRequestError(409, `${entry.name} is already being installed or removed.`);
    }
    // Claimed before the first await, so a second request (a double click) finds them taken.
    for (const entry of entries) this.setOperation(entry.terminalId!, "queued");
    try {
      await this.saveSettings((s) => entries.forEach((entry) => manage(s, entry)));
    } catch (e) {
      for (const entry of entries) this.setOperation(entry.terminalId!, null);
      this.emit();
      throw e;
    }
    this.enqueueInstalls(entries);
  }

  /** Remove: takes the bridge files out and stops managing the terminal. */
  async remove(request: unknown): Promise<RemoveResult> {
    const id = (request as { terminalId?: unknown } | null)?.terminalId;
    if (typeof id !== "string") throw new TerminalRequestError(400, "Expected { terminalId }.");
    await this.scanning;
    const settings = await this.options.settings.read();
    const [entry] = this.supportedEntries([id], settings);
    if (this.operations.has(id)) throw new TerminalRequestError(409, `${entry.name} is already being installed or removed.`);
    this.setOperation(id, "removing");
    this.installErrors.delete(id);
    this.emit();
    try {
      const result = await this.installer.remove(target(entry));
      await this.saveSettings((s) => decline(s, entry));
      return result;
    } catch (e) {
      if (e instanceof InstallInProgressError) throw new TerminalRequestError(409, `${entry.name} is being installed.`);
      throw e;
    } finally {
      this.setOperation(id, null);
      this.emit();
    }
  }

  /** A newly found terminal the user does not want managed; not offered again. */
  async decline(request: unknown): Promise<void> {
    const id = (request as { terminalId?: unknown } | null)?.terminalId;
    if (typeof id !== "string") throw new TerminalRequestError(400, "Expected { terminalId }.");
    await this.scanning;
    const settings = await this.options.settings.read();
    const [entry] = this.supportedEntries([id], settings);
    if (settings.managedTerminals.some((m) => m.terminalId === id)) throw new TerminalRequestError(409, `${entry.name} is managed. Use Remove to take the bridge files out.`);
    await this.saveSettings((s) => decline(s, entry));
  }

  /** The latest MetaEditor log of a terminal, decoded and parsed. */
  async compileLog(terminalId: unknown): Promise<CompileLog> {
    if (typeof terminalId !== "string") throw new TerminalRequestError(400, "Expected a terminalId.");
    await this.scanning;
    const settings = await this.options.settings.read();
    const [entry] = this.supportedEntries([terminalId], settings);
    const bytes = await this.installer.lastCompileLog(target(entry));
    if (!bytes) throw new TerminalRequestError(404, `There is no compile log for ${entry.name} yet.`);
    return parseCompileLog(bytes);
  }

  /**
   * Stops taking new work and cancels a running install: a compile is ended at once (nothing copied, nothing
   * recorded); a copy under way gets up to {@link CLOSE_WAIT_MS} to finish. One cut short when the process
   * ends is rolled back from its restoration manifest on the next start.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
    this.stopping.abort();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.queue, new Promise((resolve) => (timer = setTimeout(resolve, CLOSE_WAIT_MS)))]);
    clearTimeout(timer);
  }

  private enqueueInstalls(entries: Entry[], options: { onlyIfManaged?: boolean } = {}) {
    if (entries.length === 0) return;
    for (const entry of entries) this.setOperation(entry.terminalId!, "queued");
    this.emit();
    for (const entry of entries) {
      this.queue = this.queue.then(() => this.runInstall(entry, options));
    }
  }

  /**
   * ADR 9: reinstalls every managed terminal whose install differs from the bundled bridge files or
   * whose template points at another EA port. Not-installed, legacy, unticked and removed terminals
   * are left alone. One at a time, through the same queue as Install.
   */
  private async queueUpdates() {
    try {
      const settings = await this.options.settings.read();
      const outdated: Entry[] = [];
      for (const entry of this.withManaged(settings)) {
        if (!isSupported(entry) || !settings.managedTerminals.some((m) => m.terminalId === entry.terminalId)) continue;
        if (this.runtime.hasInFlightOrderRequests?.(entry.terminalId!)) continue;
        try {
          if (await this.installer.updateReason(target(entry), { eaPort: this.runtime.eaPort })) outdated.push(entry);
        } catch (e) {
          console.error(`[QuoteBridge] checking ${entry.name} for an EA update failed: ${(e as Error).message}`);
        }
      }
      this.enqueueInstalls(outdated, { onlyIfManaged: true });
    } catch (e) {
      console.error(`[QuoteBridge] checking for EA updates failed: ${(e as Error).message}`);
    }
  }

  private async runInstall(entry: Entry, options: { onlyIfManaged?: boolean } = {}) {
    const id = entry.terminalId!;
    if (this.closed) return void this.setOperation(id, null);
    // An update waiting in the queue is dropped when the user stopped managing the terminal meanwhile.
    if (options.onlyIfManaged && !(await this.options.settings.read()).managedTerminals.some((m) => m.terminalId === id)) {
      this.setOperation(id, null);
      return this.emit();
    }
    this.setOperation(id, "installing");
    this.installErrors.delete(id);
    this.emit();
    try {
      const result = await this.installer.install(target(entry), { eaPort: this.runtime.eaPort }, { signal: this.stopping.signal });
      if (result.ok) this.installedAt.set(id, this.runtime.now());
    } catch (e) {
      if (e instanceof InstallCancelledError) return;
      const message = (e as Error).message ?? String(e);
      console.error(`[QuoteBridge] install into ${entry.name} failed: ${message}`);
      this.installErrors.set(id, {
        stage: "prepare",
        reason: "install-error",
        message: `The install stopped before changing the terminal: ${message}`,
        at: new Date(this.runtime.now()).toISOString(),
        sourceHash: "",
      });
    } finally {
      this.setOperation(id, null);
      this.emit();
    }
  }

  private async scan() {
    try {
      const settings = await this.options.settings.read();
      const folders = new Set(this.userAdded);
      // Portable terminals are found only through their folder: keep finding the managed ones.
      for (const m of settings.managedTerminals) {
        if (m.installationFolder && sameFolder(m.installationFolder, m.dataFolder)) folders.add(m.installationFolder);
      }
      const detected = await detectTerminals(await this.sources([...folders]), this.catalogFs);
      this.entries = detected.map(fromDetected);
    } catch (e) {
      console.error(`[QuoteBridge] terminal detection failed: ${(e as Error).message}`);
    }
  }

  /** The detected terminals plus managed ones the scan no longer finds. */
  private withManaged(settings: Settings): Entry[] {
    const entries = [...this.entries];
    for (const m of settings.managedTerminals) {
      if (entries.some((e) => e.terminalId === m.terminalId)) continue;
      entries.push({
        name: m.name,
        kind: "mt4",
        installationFolder: m.installationFolder,
        dataFolder: m.dataFolder,
        terminalId: m.terminalId,
        portable: !!m.installationFolder && sameFolder(m.installationFolder, m.dataFolder),
        needsConfirmation: false,
        detected: false,
        running: false,
      });
    }
    return entries;
  }

  private supportedEntries(ids: string[], settings?: Settings): Entry[] {
    const all = settings ? this.withManaged(settings) : this.entries;
    return ids.map((id) => {
      const entry = all.find((e) => e.terminalId === id);
      if (!entry) throw new TerminalRequestError(404, `No terminal with Terminal ID ${id}. Rescan and try again.`);
      if (!isSupported(entry)) throw new TerminalRequestError(422, `${entry.name}: ${unsupportedReason(entry)}`);
      return entry;
    });
  }

  private async view(
    entry: Entry,
    settings: Settings,
    presence: Map<string, { lastHello: number; eaVersion: string | null }>,
    bundleProblem: string | null,
    operations: ReadonlyMap<string, TerminalOperation>,
  ): Promise<TerminalView> {
    const id = entry.terminalId ?? null;
    const supported = isSupported(entry);
    const managed = !!id && settings.managedTerminals.some((m) => m.terminalId === id);
    const declined = !!id && !managed && settings.declinedTerminals.some((d) => d.terminalId === id);
    const status = supported && !bundleProblem ? await this.installer.status(target(entry)).catch(() => undefined) : undefined;
    const seen = id ? presence.get(id) : undefined;
    const now = this.runtime.now();
    const eaConnected = !!seen;
    const state = status?.state ?? null;
    const lastFailure = (id && this.installErrors.get(id)) || status?.lastFailure || null;

    let hint: string | null = null;
    const since = Math.max(this.startedAt, (id && this.installedAt.get(id)) || 0);
    if (managed && state === "installed" && !seen && now - since >= (this.options.hintAfterMs ?? DEFAULT_HINT_AFTER_MS)) {
      hint = entry.running
        ? "MetaTrader is running, but no QuoteBridge EA has connected from this terminal. Work through the checklist: refresh the Navigator, apply the QuoteBridge template to a chart and allow DLL imports."
        : "No QuoteBridge EA has connected from this terminal yet. Open MetaTrader, then work through the checklist.";
    }

    let attention: string | null = null;
    if (managed && status) {
      if (status.state === "no-metaeditor") attention = "This terminal has no MetaEditor, so the app cannot compile the QuoteBridge EA for it.";
      else if (lastFailure) attention = lastFailure.message;
    } else if (managed && lastFailure) attention = lastFailure.message;

    return {
      key: id ?? `folder:${entry.installationFolder}`,
      terminalId: id,
      name: entry.name,
      kind: entry.kind,
      installationFolder: entry.installationFolder ?? null,
      dataFolder: entry.dataFolder ?? null,
      portable: entry.portable,
      needsConfirmation: entry.needsConfirmation,
      detected: entry.detected,
      terminalRunning: entry.running,
      supported,
      unsupportedReason: supported ? null : unsupportedReason(entry),
      managed,
      declined,
      offered: supported && entry.detected && !managed && !declined,
      state,
      operation: (id && operations.get(id)) || null,
      installedEaVersion: status?.eaVersion ?? null,
      legacyTerminalId: status?.legacyTerminalId ?? null,
      lastFailure,
      pendingRemoval: status?.pendingRemoval ?? [],
      presence: seen ? { lastHello: seen.lastHello, eaVersion: seen.eaVersion, online: now - seen.lastHello < ONLINE_WINDOW_MS } : null,
      checklist: { refreshNavigator: eaConnected, applyTemplate: eaConnected, allowDllImports: eaConnected, eaConnected },
      hint,
      attention,
    };
  }

  private setOperation(id: string, operation: TerminalOperation | null) {
    if (operation) this.operations.set(id, operation);
    else this.operations.delete(id);
    this.operationsVersion++;
  }

  private async saveSettings(change: (settings: Settings) => void) {
    const saved = await this.options.settings.update((s) => {
      change(s);
      return s;
    });
    this.options.onSettingsSaved?.(saved);
    this.emit();
  }

  /** Refreshes the attention list, then tells the listeners. */
  private emit() {
    if (this.closed) return;
    const notify = () => this.listeners.forEach((listener) => listener());
    void this.state().then(notify, notify);
  }
}

function fromDetected(t: DetectedTerminal): Entry {
  return {
    name: t.name,
    kind: t.kind,
    installationFolder: t.installationFolder,
    dataFolder: t.dataFolder,
    terminalId: t.terminalId,
    portable: t.portable,
    needsConfirmation: t.needsConfirmation,
    detected: true,
    running: t.evidence.includes("running-process"),
  };
}

function isSupported(entry: Entry): boolean {
  return entry.kind === "mt4" && !!entry.dataFolder && !!entry.terminalId;
}

function unsupportedReason(entry: Entry): string {
  if (entry.kind === "mt5") return "MetaTrader 5 is not supported yet.";
  if (!entry.dataFolder) return "Its data folder was not found. If this terminal runs in portable mode, confirm its folder.";
  return "This does not look like a MetaTrader 4 terminal (its terminal.exe is not the 32-bit MetaTrader 4 program).";
}

function target(entry: Entry) {
  return { dataFolder: entry.dataFolder!, installationFolder: entry.installationFolder };
}

function manage(settings: Settings, entry: Entry) {
  const id = entry.terminalId!;
  settings.declinedTerminals = settings.declinedTerminals.filter((d) => d.terminalId !== id);
  if (settings.managedTerminals.some((m) => m.terminalId === id)) return;
  settings.managedTerminals.push({ terminalId: id, name: entry.name, dataFolder: entry.dataFolder!, installationFolder: entry.installationFolder });
}

function decline(settings: Settings, entry: Entry) {
  const id = entry.terminalId!;
  settings.managedTerminals = settings.managedTerminals.filter((m) => m.terminalId !== id);
  if (!settings.declinedTerminals.some((d) => d.terminalId === id)) settings.declinedTerminals.push({ terminalId: id, name: entry.name, dataFolder: entry.dataFolder! });
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 200 && value.every((v) => typeof v === "string" && v.length <= 100);
}

function sameFolder(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, "").replace(/\//g, "\\").toUpperCase();
  return norm(a) === norm(b);
}
