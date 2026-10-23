// Indicator packages: a manifest, calculate.js, README.md and LICENSE, identified by id, version and a SHA-256 over
// the four files. The bundled ones ship with the app in bundled/<name>/ (scripts/indicators-build.ts copies them beside
// the built module).
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest, type Manifest } from "../../shared/indicator-manifest.js";

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

/** The packages the app has: the bundled ones, then any in an extra folder (tests). */
export class IndicatorPackages {
  private constructor(private readonly packages: readonly IndicatorPackage[]) {}

  static async open(extraFolder?: string): Promise<IndicatorPackages> {
    const bundled = await bundledPackages();
    const extra = extraFolder ? await packagesIn(extraFolder, false) : [];
    return new IndicatorPackages([...bundled, ...extra.filter((p) => !bundled.some((b) => b.manifest.id === p.manifest.id))]);
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
