// The package author's tool (scripts/indicator-package.ts): a folder with a package's four files becomes the ZIP the
// Indicators page installs, after the same checks and trial run as Install; a package that would be refused is refused
// here, with the same reason.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPackage, loadPackage } from "../scripts/indicator-package.js";
import { readPackageZip } from "../src/server/indicators/package-zip.js";
import { scaledPackage } from "./package-zip.js";

const folder = await mkdtemp(join(tmpdir(), "quotebridge-package-tool-"));
test.after(() => rm(folder, { recursive: true, force: true }));

let n = 0;
/** A package folder with these files, and a test file beside them that the ZIP leaves out. */
async function packageFolder(files: Record<string, string>): Promise<string> {
  const dir = join(folder, `package-${++n}`);
  await mkdir(dir);
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  await writeFile(join(dir, "scaled.test.ts"), "// the author's tests");
  return dir;
}

test("a package folder becomes a ZIP of its four files that the app reads back unchanged", async () => {
  const files = scaledPackage("1.2.0");
  const out = join(folder, "scaled.zip");
  const built = await buildPackage(await packageFolder(files), { out });
  assert.equal(built.path, out);
  assert.equal(built.package.manifest.id, "acme.scaled");
  assert.equal(built.package.manifest.version, "1.2.0");
  assert.deepEqual(readPackageZip(await readFile(out)), files);
});

test("the ZIP is named after the package's id and version unless told otherwise", async () => {
  const dir = await packageFolder(scaledPackage("2.0.1"));
  const built = await buildPackage(dir, { buildFolder: folder });
  assert.equal(built.path, join(folder, "acme.scaled-2.0.1.zip"));
  assert.deepEqual(readPackageZip(await readFile(built.path)), scaledPackage("2.0.1"));
});

test("a manifest Install would refuse is refused with Install's reason, and no ZIP is written", async () => {
  const files = scaledPackage();
  const manifest = JSON.parse(files["manifest.json"]);
  manifest.outputs[0].render = "area";
  const out = join(folder, "refused.zip");
  await assert.rejects(buildPackage(await packageFolder({ ...files, "manifest.json": JSON.stringify(manifest) }), { out }), /manifest\.json: Output scaled must be a line or a histogram\./);
  await assert.rejects(readFile(out), { code: "ENOENT" });
});

test("a calculation that fails its trial run is refused with the reason", async () => {
  const files = { ...scaledPackage(), "calculate.js": "exports.calculate = function () { throw new Error('not yet'); };" };
  await assert.rejects(buildPackage(await packageFolder(files), { out: join(folder, "throws.zip") }), /The trial run failed\. The calculation threw: not yet/);
});

test("a folder that lacks one of the four files is refused, naming it", async () => {
  const { LICENSE: _, ...files } = scaledPackage();
  await assert.rejects(buildPackage(await packageFolder(files), { out: join(folder, "no-licence.zip") }), /LICENSE/);
});

test("an author's tests load the package from its folder, as the ZIP will install it", async () => {
  const dir = await packageFolder(scaledPackage("1.0.3"));
  const loaded = await loadPackage(dir);
  const built = await buildPackage(dir, { out: join(folder, "loaded.zip") });
  assert.equal(loaded.manifest.version, "1.0.3");
  assert.equal(loaded.code, scaledPackage("1.0.3")["calculate.js"]);
  assert.equal(loaded.hash, built.package.hash);
});
