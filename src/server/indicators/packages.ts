// Indicator packages: a manifest, calculate.js, README.md and LICENSE, identified by id, version and a SHA-256 over
// the four files. The bundled ones ship with the app in bundled/<name>/ (scripts/indicators-build.ts copies them beside
// the built module).
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest, type Manifest } from "../../shared/indicator-manifest.js";
import type { SettingsStore } from "../../shared/settings-store.js";

/** A package's files (`code` is calculate.js), its SHA-256 over them, and whether it ships with the app. */
export type IndicatorPackage = { manifest: Manifest; code: string; readme: string; licence: string; hash: string; bundled: boolean };

export const PACKAGE_FILES = ["manifest.json", "calculate.js", "README.md", "LICENSE"] as const;

export const BUNDLED_FOLDER = fileURLToPath(new URL("./bundled/", import.meta.url));

/** A package from its four files' text; throws ManifestError for a manifest that cannot be used. */
export function packageFromFiles(files: Record<(typeof PACKAGE_FILES)[number], string>, bundled: boolean): IndicatorPackage {
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

export type IndicatorPackagesOptions = {
  /** A folder of packages (one subfolder each) beside the bundled ones; for tests. */
  extraFolder?: string;
  /** Where the packages switched off are kept; without one, in memory only. */
  settings?: SettingsStore;
};

/**
 * The packages the app has: the bundled ones, then any in an extra folder (tests); each enabled unless switched off
 * on the Indicators page (kept in settings).
 */
export class IndicatorPackages {
  private readonly listeners = new Set<() => void>();
  /** Changes to what is enabled, one at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly packages: readonly IndicatorPackage[],
    private disabled: ReadonlySet<string>,
    private readonly settings?: SettingsStore,
  ) {}

  static async open(options: IndicatorPackagesOptions = {}): Promise<IndicatorPackages> {
    const bundled = await bundledPackages();
    const extra = options.extraFolder ? await packagesIn(options.extraFolder, false) : [];
    const disabled = new Set((await options.settings?.read())?.disabledIndicators ?? []);
    return new IndicatorPackages([...bundled, ...extra.filter((p) => !bundled.some((b) => b.manifest.id === p.manifest.id))], disabled, options.settings);
  }

  /** Whether the package is switched on: charts and REST may use it. */
  enabled(id: string): boolean {
    return !this.disabled.has(id);
  }

  /** Switches a package on or off and keeps it in settings; false when the app has no such package. */
  setEnabled(id: string, enabled: boolean): Promise<boolean> {
    const run = this.queue.then(async () => {
      if (!this.get(id)) return false;
      if (this.enabled(id) === enabled) return true;
      const disabled = new Set(this.disabled);
      if (enabled) disabled.delete(id);
      else disabled.add(id);
      await this.settings?.update((s) => ({ ...s, disabledIndicators: [...disabled].sort() }));
      this.disabled = disabled;
      for (const listener of this.listeners) listener();
      return true;
    });
    this.queue = run.catch(() => undefined);
    return run;
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
}
