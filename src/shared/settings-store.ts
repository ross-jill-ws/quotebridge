// Settings store: the app's settings as JSON in its data folder (`%APPDATA%\QuoteBridge\settings.json`),
// written atomically (temp file + rename). Updates are applied one at a time.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const SETTINGS_FORMAT = 1;
export const SETTINGS_FILE = "settings.json";

/** A terminal the app installs into and keeps updated. */
export interface ManagedTerminal {
  terminalId: string;
  /** The name the user recognises (installation folder name). */
  name: string;
  dataFolder: string;
  installationFolder: string | undefined;
}

/** A detected terminal the user unticked; remembered so a rescan does not offer it as new. */
export interface DeclinedTerminal {
  terminalId: string;
  name: string;
  dataFolder: string;
}

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export const CHART_COLOURS = ["default", "green-on-black"] as const;
export type ChartColours = (typeof CHART_COLOURS)[number];

/** The clock times are shown in: the broker server's (as MetaTrader shows them), this computer's, or UTC (ADR 11). */
export const TIMES_SHOWN = ["broker", "local", "utc"] as const;
export type TimeShown = (typeof TIMES_SHOWN)[number];

export interface Settings {
  format: typeof SETTINGS_FORMAT;
  managedTerminals: ManagedTerminal[];
  declinedTerminals: DeclinedTerminal[];
  ports: {
    /** ZeroMQ port QuoteBridge EAs connect to; changing it means reinstalling every template. */
    ea: number;
    /** Dashboard HTTP port on 127.0.0.1. */
    http: number;
  };
  startWithWindows: boolean;
  /** A sign-in start (`--hidden`) shows the window instead of staying in the tray. */
  openWindowAtStartup: boolean;
  /** The window's colours: follow Windows, or always light or dark. */
  theme: Theme;
  /** The pips flash Uptick or Downtick on a tick (never with reduced motion). */
  flashPrices: boolean;
  /** The Charts view's colour scheme: the app's own colours, or MetaTrader's classic Green on black. */
  chartColours: ChartColours;
  /** The clock the dashboard shows times in; candles still break on the broker clock. */
  timeShown: TimeShown;
  firstCloseNotificationShown: boolean;
  /** Set when the user finishes the first-run setup screen; until then every start is a first run. */
  setupCompleted: boolean;
  /** Indicator packages switched off on the Indicators page, by package id. */
  disabledIndicators: string[];
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  format: SETTINGS_FORMAT,
  managedTerminals: [],
  declinedTerminals: [],
  // 5555 is the legacy default, so existing templates keep working.
  ports: { ea: 5555, http: 5580 },
  startWithWindows: true,
  openWindowAtStartup: false,
  theme: "system",
  flashPrices: true,
  chartColours: "default",
  timeShown: "broker",
  firstCloseNotificationShown: false,
  setupCompleted: false,
  disabledIndicators: [],
});

export class SettingsStore {
  readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly folder: string) {
    this.file = join(folder, SETTINGS_FILE);
  }

  /**
   * True until the user completes the setup screen (the app shows it and ignores a hidden start).
   * Not "no file yet": the first-close notification may be saved while setup is still open.
   */
  async isFirstRun(): Promise<boolean> {
    return !(await this.read()).setupCompleted;
  }

  /** The current settings; defaults when there is no file. A corrupt file is kept aside. */
  read(): Promise<Settings> {
    return this.serialised(() => this.load());
  }

  /** Applies `change` to the current settings and saves them atomically. */
  update(change: (settings: Settings) => Settings | void): Promise<Settings> {
    return this.serialised(async () => {
      const current = await this.load();
      const next = change(current) ?? current;
      validate(next);
      await mkdir(this.folder, { recursive: true });
      const temporary = `${this.file}.tmp`;
      await writeFile(temporary, JSON.stringify(next, null, 2) + "\n");
      await renameWithRetry(temporary, this.file);
      return structuredClone(next);
    });
  }

  private serialised<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<Settings> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      return structuredClone(DEFAULT_SETTINGS) as Settings;
    }
    try {
      return withDefaults(JSON.parse(text));
    } catch {
      await rename(this.file, `${this.file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`);
      return structuredClone(DEFAULT_SETTINGS) as Settings;
    }
  }
}

function withDefaults(stored: unknown): Settings {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) throw new Error("settings are not an object");
  const partial = stored as Partial<Settings>;
  if (partial.format !== undefined && partial.format !== SETTINGS_FORMAT) throw new Error(`unknown settings format ${partial.format}`);
  const defaults = structuredClone(DEFAULT_SETTINGS) as Settings;
  return {
    format: SETTINGS_FORMAT,
    managedTerminals: Array.isArray(partial.managedTerminals) ? partial.managedTerminals : defaults.managedTerminals,
    declinedTerminals: Array.isArray(partial.declinedTerminals) ? partial.declinedTerminals : defaults.declinedTerminals,
    ports: readPorts(partial.ports, defaults.ports),
    startWithWindows: typeof partial.startWithWindows === "boolean" ? partial.startWithWindows : defaults.startWithWindows,
    openWindowAtStartup: typeof partial.openWindowAtStartup === "boolean" ? partial.openWindowAtStartup : defaults.openWindowAtStartup,
    theme: (THEMES as readonly unknown[]).includes(partial.theme) ? partial.theme! : defaults.theme,
    flashPrices: typeof partial.flashPrices === "boolean" ? partial.flashPrices : defaults.flashPrices,
    chartColours: (CHART_COLOURS as readonly unknown[]).includes(partial.chartColours) ? partial.chartColours! : defaults.chartColours,
    timeShown: (TIMES_SHOWN as readonly unknown[]).includes(partial.timeShown) ? partial.timeShown! : defaults.timeShown,
    firstCloseNotificationShown: typeof partial.firstCloseNotificationShown === "boolean" ? partial.firstCloseNotificationShown : defaults.firstCloseNotificationShown,
    setupCompleted: typeof partial.setupCompleted === "boolean" ? partial.setupCompleted : defaults.setupCompleted,
    disabledIndicators: Array.isArray(partial.disabledIndicators) ? partial.disabledIndicators.filter((id): id is string => typeof id === "string") : defaults.disabledIndicators,
  };
}

/**
 * Stored ports as the app can use them: a port that is not a whole number from 1 to 65535 (e.g. a hand
 * edit) is read as its default, and equal EA and HTTP ports as both defaults, so the server can start and
 * settings can still be saved.
 */
function readPorts(stored: unknown, defaults: Settings["ports"]): Settings["ports"] {
  const given = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
  const ports = { ea: isPort(given.ea) ? given.ea : defaults.ea, http: isPort(given.http) ? given.http : defaults.http };
  return ports.ea === ports.http ? { ...defaults } : ports;
}

function isPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535;
}

function validate(settings: Settings): void {
  for (const [name, port] of Object.entries(settings.ports)) {
    if (!isPort(port)) throw new Error(`The ${name} port must be a whole number from 1 to 65535, not ${port}`);
  }
  if (settings.ports.ea === settings.ports.http) throw new Error("The EA port and the HTTP port must differ");
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  // Windows can refuse a rename for a moment while an indexer or antivirus has the target open.
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(from, to);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (attempt >= 4 || !["EPERM", "EACCES", "EBUSY"].includes(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}
