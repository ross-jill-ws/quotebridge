// An indicator package author's tool: the four files in a folder (manifest.json, calculate.js, README.md, LICENSE)
// become the ZIP the Indicators page installs, after the checks Install makes (the files, the manifest, a trial run in
// the real sandbox); a package Install would refuse is refused here with the same reason. Other files in the folder,
// such as the author's tests, stay out of the ZIP. The same bytes always make the same ZIP.
//
//   npm run indicator-package -- <folder> [<out.zip>]
//
// Without <out.zip>, the ZIP goes to build/<id>-<version>.zip.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { IndicatorEngine, IndicatorPackages, PackageRequestError, type IndicatorPackage } from "../src/server/indicators/index.js";
import { writePackageZip } from "../src/server/indicators/package-zip.js";
import { PACKAGE_FILES, packageFromFiles, type PackageFiles } from "../src/server/indicators/packages.js";

const BUILD_FOLDER = fileURLToPath(new URL("../build/", import.meta.url));

/** The package in `folder`, for the author's tests to run with IndicatorEngine; throws for a manifest that cannot be used. */
export async function loadPackage(folder: string): Promise<IndicatorPackage> {
  return packageFromFiles(await readFolder(folder), false);
}

/** The package in `folder`, checked as Install checks it, written as a ZIP to `out` (else `<id>-<version>.zip` in `buildFolder`, build/ by default). */
export async function buildPackage(folder: string, { out, buildFolder = BUILD_FOLDER }: { out?: string; buildFolder?: string } = {}): Promise<{ package: IndicatorPackage; path: string }> {
  const files = await readFolder(folder);
  const zip = writePackageZip(files);
  const engine = new IndicatorEngine();
  let pkg: IndicatorPackage;
  try {
    const packages = await IndicatorPackages.open({ run: (p, bars, parameters) => engine.run(p, bars, parameters) });
    pkg = (await packages.preview(zip)).package;
  } catch (e) {
    throw e instanceof PackageRequestError ? new Error(e.message) : e;
  } finally {
    await engine.close();
  }
  const path = resolve(out ?? join(buildFolder, `${pkg.manifest.id}-${pkg.manifest.version}.zip`));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, zip);
  return { package: pkg, path };
}

async function readFolder(folder: string): Promise<PackageFiles> {
  const files = {} as PackageFiles;
  for (const name of PACKAGE_FILES) {
    try {
      files[name] = await readFile(join(folder, name), "utf8");
    } catch {
      throw new Error(`${folder} has no ${name}. A package is manifest.json, calculate.js, README.md and LICENSE.`);
    }
  }
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [folder, out] = process.argv.slice(2);
  if (!folder) {
    console.error("Usage: npm run indicator-package -- <folder> [<out.zip>]");
    process.exit(2);
  }
  try {
    const { package: pkg, path } = await buildPackage(resolve(folder), { out });
    console.log(`${pkg.manifest.name} ${pkg.manifest.version} (${pkg.manifest.id}) passed Install's checks and its trial run.`);
    console.log(`ZIP: ${path}`);
    console.log(`SHA-256 over the four files: ${pkg.hash}`);
  } catch (e) {
    console.error(`Refused: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
