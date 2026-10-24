// Indicator packages: a manifest, calculate.js, README.md and LICENSE, identified by id, version and a SHA-256 over
// the four files. The bundled ones ship with the app in bundled/<name>/ (scripts/indicators-build.ts copies them beside
// the built module); the installed ones come as a ZIP from the Indicators page and are kept in the database.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultValues, ManifestError, parseManifest, warmUpBars, type Manifest, type ParameterValues } from "../../shared/indicator-manifest.js";
import type { SettingsStore } from "../../shared/settings-store.js";
import type { RunResult } from "./engine.js";
import { memoryPackageStore, type InstalledPackageStore } from "./package-store.js";
import { PackageZipError, readPackageZip } from "./package-zip.js";
import type { IndicatorBar } from "./sandbox.js";

/** A package's files (`code` is calculate.js), its SHA-256 over them, and whether it ships with the app. */
export type IndicatorPackage = { manifest: Manifest; code: string; readme: string; licence: string; hash: string; bundled: boolean };

export const PACKAGE_FILES = ["manifest.json", "calculate.js", "README.md", "LICENSE"] as const;

export type PackageFiles = Record<(typeof PACKAGE_FILES)[number], string>;

export const BUNDLED_FOLDER = fileURLToPath(new URL("./bundled/", import.meta.url));

/** A package from its four files' text; throws ManifestError for a manifest that cannot be used. */
export function packageFromFiles(files: PackageFiles, bundled: boolean): IndicatorPackage {
  const manifest = parseManifest(JSON.parse(files["manifest.json"]));
  const hash = createHash("sha256");
  for (const name of PACKAGE_FILES) hash.update(`${name}\0${files[name].length}\0${files[name]}`);
  return { manifest, code: files["calculate.js"], readme: files["README.md"], licence: files.LICENSE, hash: hash.digest("hex"), bundled };
}

/** Every package in `folder` (one subfolder each), by name. */
export async function packagesIn(folder: string, bundled: boolean): Promise<IndicatorPackage[]> {
  const entries = (await readdir(folder, { withFileTypes: true })).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  return Promise.all(
    entries.map(async (e) => {
      const read = (name: string) => readFile(join(folder, e.name, name), "utf8");
      const [manifest, code, readme, license] = await Promise.all(PACKAGE_FILES.map(read));
      return packageFromFiles({ "manifest.json": manifest, "calculate.js": code, "README.md": readme, LICENSE: license }, bundled);
    }),
  );
}

/** The bundled packages in the order menus list them: the Milestone 2 two first, then as the legacy app had them. */
const BUNDLED_ORDER = ["quotebridge.ma", "quotebridge.rsi", "quotebridge.bollinger", "quotebridge.macd", "quotebridge.ao", "quotebridge.ac", "quotebridge.alligator", "quotebridge.eo"];

/** The packages that ship with the app, in BUNDLED_ORDER. */
export async function bundledPackages(): Promise<IndicatorPackage[]> {
  const rank = (p: IndicatorPackage) => BUNDLED_ORDER.indexOf(p.manifest.id) >>> 0;
  return (await packagesIn(BUNDLED_FOLDER, true)).sort((a, b) => rank(a) - rank(b));
}

/** A package ZIP refused, or a change the Indicators page asked for that cannot be made; `status` is the HTTP status. */
export class PackageRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** More for the answer: `downgrade: true` when only the second confirmation is missing. */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** A package ZIP, checked and given its trial run; `replaces`: the installed package of its id; `downgrade`: that one is newer. */
export type PackagePreview = { package: IndicatorPackage; replaces: IndicatorPackage | null; downgrade: boolean };

export type IndicatorPackagesOptions = {
  /** A folder of packages (one subfolder each) beside the bundled ones, never stored; for tests. */
  extraFolder?: string;
  /** Where the bundled (and extra) packages switched off are kept; without one, in memory only. */
  settings?: SettingsStore;
  /** Where installed packages are kept; without one, in memory only. */
  store?: InstalledPackageStore;
  /** A package's run in the sandbox, for the trial run before it is installed; without one, there is none. */
  run?: (pkg: IndicatorPackage, bars: readonly IndicatorBar[], parameters: ParameterValues) => Promise<RunResult>;
  now?: () => number;
};

/** Bars the trial run has after a package's warm-up. */
const TRIAL_BARS = 300;

/**
 * The packages the app has: the bundled ones, then the installed ones (and any in an extra folder, for tests) by name;
 * each enabled unless switched off on the Indicators page. Installs, deletes and switches go one at a time.
 */
export class IndicatorPackages {
  private readonly listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly store: InstalledPackageStore;
  private readonly now: () => number;

  private constructor(
    private packages: readonly IndicatorPackage[],
    private disabled: ReadonlySet<string>,
    /** The ids kept in the store, with their switches; the others' switches are kept in settings. */
    private readonly stored: Set<string>,
    private readonly options: IndicatorPackagesOptions,
  ) {
    this.store = options.store ?? memoryPackageStore();
    this.now = options.now ?? Date.now;
  }

  static async open(options: IndicatorPackagesOptions = {}): Promise<IndicatorPackages> {
    const bundled = await bundledPackages();
    const taken = (id: string) => bundled.some((b) => b.manifest.id === id);
    const extra = (options.extraFolder ? await packagesIn(options.extraFolder, false) : []).filter((p) => !taken(p.manifest.id));
    const disabled = new Set((await options.settings?.read())?.disabledIndicators ?? []);
    const stored = new Set<string>();
    const installed: IndicatorPackage[] = [];
    for (const row of (await options.store?.list()) ?? []) {
      let pkg: IndicatorPackage;
      try {
        pkg = packageFromFiles(row.files, false);
      } catch (e) {
        // A package this version of the app cannot read: left in the store as it is.
        console.error(`The installed indicator package ${row.id} could not be read`, e);
        continue;
      }
      if (taken(pkg.manifest.id)) continue;
      stored.add(pkg.manifest.id);
      if (row.enabled) disabled.delete(pkg.manifest.id);
      else disabled.add(pkg.manifest.id);
      installed.push(pkg);
    }
    const others = [...extra.filter((p) => !stored.has(p.manifest.id)), ...installed];
    return new IndicatorPackages([...bundled, ...byName(others)], disabled, stored, options);
  }

  /** Whether the package is switched on: charts and REST may use it. */
  enabled(id: string): boolean {
    return !this.disabled.has(id);
  }

  /** Switches a package on or off and keeps it; false when the app has no such package. */
  setEnabled(id: string, enabled: boolean): Promise<boolean> {
    return this.serial(async () => {
      if (!this.get(id)) return false;
      if (this.enabled(id) === enabled) return true;
      const disabled = new Set(this.disabled);
      if (enabled) disabled.delete(id);
      else disabled.add(id);
      if (this.stored.has(id)) await this.store.setEnabled(id, enabled);
      else await this.saveSwitches(disabled);
      this.disabled = disabled;
      this.changed();
      return true;
    });
  }

  /**
   * The package in a ZIP, checked (its files, its manifest, a trial run on fixture bars) and compared with the one
   * installed; nothing is installed. Throws PackageRequestError with the reason otherwise. Not queued: install checks
   * again, after the changes before it.
   */
  async preview(zip: Buffer): Promise<PackagePreview> {
    return (await this.check(zip)).preview;
  }

  /**
   * Installs the package in a ZIP, replacing the installed one of its id; an older version than the one installed only
   * with `downgrade` (the second confirmation). Throws PackageRequestError with the reason otherwise.
   */
  install(zip: Buffer, options: { downgrade?: boolean } = {}): Promise<IndicatorPackage> {
    return this.serial(async () => {
      const { preview, files } = await this.check(zip);
      const { package: pkg, replaces, downgrade } = preview;
      if (downgrade && !options.downgrade) {
        const newer = replaces!.manifest;
        throw new PackageRequestError(409, `${newer.name} ${newer.version} is installed, newer than ${pkg.manifest.version}. Confirm to install the older version.`, { downgrade: true });
      }
      const id = pkg.manifest.id;
      // An upgrade keeps the switch as it was; a new package is enabled.
      const enabled = replaces ? this.enabled(id) : true;
      // An extra folder's package had its switch in settings; the store keeps it from now on.
      if (!this.stored.has(id) && this.disabled.has(id)) await this.saveSwitches(without(this.disabled, id));
      await this.store.put({ id, version: pkg.manifest.version, hash: pkg.hash, files, enabled, installedAt: this.now() });
      this.stored.add(id);
      this.disabled = enabled ? without(this.disabled, id) : new Set([...this.disabled, id]);
      this.packages = [...this.packages.filter((p) => p.bundled), ...byName([...this.packages.filter((p) => !p.bundled && p.manifest.id !== id), pkg])];
      this.changed();
      return pkg;
    });
  }

  /** Deletes an installed package; charts using it read Not available. Throws PackageRequestError for a bundled or unknown one. */
  delete(id: string): Promise<void> {
    return this.serial(async () => {
      const pkg = this.get(id);
      if (!pkg) throw new PackageRequestError(404, "Unknown indicator package");
      if (pkg.bundled) throw new PackageRequestError(409, `${pkg.manifest.name} ships with the app and cannot be deleted. Disable it instead.`);
      if (this.stored.has(id)) await this.store.delete(id);
      else if (this.disabled.has(id)) await this.saveSwitches(without(this.disabled, id));
      this.stored.delete(id);
      this.disabled = without(this.disabled, id);
      this.packages = this.packages.filter((p) => p.manifest.id !== id);
      this.changed();
    });
  }

  /** `listener` hears each change to the packages or whether they are enabled; returns a function that stops it. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Bundled first, then the others by name. */
  list(): readonly IndicatorPackage[] {
    return this.packages;
  }

  /** The package with this id, if the app has it. */
  get(id: string): IndicatorPackage | undefined {
    return this.packages.find((p) => p.manifest.id === id);
  }

  /** The ZIP's package previewed, with its files as given (the hash is over them). */
  private async check(zip: Buffer): Promise<{ preview: PackagePreview; files: PackageFiles }> {
    let files: PackageFiles;
    try {
      files = readPackageZip(zip);
    } catch (e) {
      if (e instanceof PackageZipError) throw new PackageRequestError(422, e.message);
      throw e;
    }
    let pkg: IndicatorPackage;
    try {
      pkg = packageFromFiles(files, false);
    } catch (e) {
      if (e instanceof SyntaxError) throw new PackageRequestError(422, "manifest.json is not valid JSON.");
      if (e instanceof ManifestError) throw new PackageRequestError(422, `manifest.json: ${e.message}`);
      throw e;
    }
    const { id, version } = pkg.manifest;
    const current = this.get(id);
    if (current?.bundled) throw new PackageRequestError(409, `${id} is a bundled package's id, and only the app updates those. Give the package an id of its own.`);
    if (current && current.manifest.version === version && current.hash !== pkg.hash) {
      throw new PackageRequestError(409, `${current.manifest.name} ${version} is installed with other content. A version always means the same files: give the package a new version.`);
    }
    await this.trial(pkg);
    return { preview: { package: pkg, replaces: current ?? null, downgrade: current !== undefined && compareVersions(version, current.manifest.version) < 0 }, files };
  }

  /** The package's run with its defaults over fixture bars; throws PackageRequestError when it fails. */
  private async trial(pkg: IndicatorPackage) {
    if (!this.options.run) return;
    const parameters = defaultValues(pkg.manifest);
    const result = await this.options.run(pkg, trialBars(warmUpBars(pkg.manifest, parameters) + TRIAL_BARS), parameters);
    if (!result.ok) throw new PackageRequestError(422, `The trial run failed. ${result.reason}`);
  }

  /** The switched-off packages kept in settings: the bundled and extra ones (the store keeps its own). */
  private async saveSwitches(disabled: ReadonlySet<string>) {
    await this.options.settings?.update((s) => ({ ...s, disabledIndicators: [...disabled].filter((id) => !this.stored.has(id)).sort() }));
  }

  private changed() {
    for (const listener of this.listeners) listener();
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

const without = (ids: ReadonlySet<string>, id: string): ReadonlySet<string> => new Set([...ids].filter((d) => d !== id));

const byName = (packages: readonly IndicatorPackage[]) => [...packages].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name) || a.manifest.id.localeCompare(b.manifest.id));

/** Negative when `a` is the older of two major.minor.patch versions. */
export function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** Hourly bars for a trial run: a slow wave with a faster one on it, ending at a fixed time. */
function trialBars(count: number): IndicatorBar[] {
  const end = Date.UTC(2026, 0, 2) / 1000;
  return Array.from({ length: count }, (_, i) => {
    const close = 1.1 + 0.01 * Math.sin(i / 20) + 0.002 * Math.sin(i / 3);
    return { time: end - (count - i) * 3600, high: close + 0.0006, low: close - 0.0006, close };
  });
}
