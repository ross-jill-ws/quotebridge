// The user manual's example package (docs/indicator-packages.md, "Example"): its four files, as the page prints them,
// pass Install's checks and trial run, and compute the values the page works out by hand in the real sandbox.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPackage } from "../scripts/indicator-package.js";
import { IndicatorEngine } from "../src/server/indicators/index.js";
import { PACKAGE_FILES } from "../src/server/indicators/packages.js";

const page = await readFile(new URL("../docs/indicator-packages.md", import.meta.url), "utf8");

/** Each file of the Example section: the fenced block after its `### <file>` heading. */
function exampleFiles(): Record<string, string> {
  const section = page.split(/^## /m).find((s) => s.startsWith("Example"));
  assert.ok(section, "the page has an Example section");
  const files: Record<string, string> = {};
  for (const name of PACKAGE_FILES) {
    const block = section.match(new RegExp(`^### ${name.replace(".", "\\.")}\\n[^]*?^\`\`\`[a-z]*\\n([^]*?)^\`\`\`$`, "m"));
    assert.ok(block, `the Example section prints ${name}`);
    files[name] = block[1];
  }
  return files;
}

const folder = await mkdtemp(join(tmpdir(), "quotebridge-doc-example-"));
const engine = new IndicatorEngine();
test.after(async () => {
  await engine.close();
  await rm(folder, { recursive: true, force: true });
});

/** The example's ZIP, built as the manual says; throws with Install's reason when Install would refuse it. */
const built = (async () => {
  for (const [name, text] of Object.entries(exampleFiles())) await writeFile(join(folder, name), text);
  return buildPackage(folder, { out: join(folder, "example.zip") });
})();
// Reported by the first test rather than failing the file.
built.catch(() => undefined);

test("the manual's example package passes Install's checks and its trial run", async () => {
  assert.equal((await built).package.manifest.id, "example.change");
});

test("the manual's example package computes the values the manual works out by hand", async () => {
  const { package: pkg } = await built;
  const closes = [1, 2, 4, 3, 3, 6];
  const result = await engine.run(pkg, closes.map((close, i) => ({ time: 60 * (i + 1), high: close, low: close, close })), { period: 2 });
  assert.ok(result.ok, result.ok ? "" : result.reason);
  assert.deepEqual(result.outputs.change, [
    { time: 60, value: null },
    { time: 120, value: null },
    { time: 180, value: 3, styleKey: "rising" },
    { time: 240, value: 1, styleKey: "falling" },
    { time: 300, value: -1, styleKey: "falling" },
    { time: 360, value: 3, styleKey: "rising" },
  ]);
});
