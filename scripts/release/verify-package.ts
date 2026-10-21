// Release check on the unpacked app (electron-builder's `win-unpacked` folder), run by the release
// workflow before the installer is published:
// - the bundled EA sources and template in `resources\bridge\mt4` are exactly the commit's `mt4/`
//   files (ADR 3: CI cannot compile the EA, so it proves the shipped sources are the tagged ones);
// - no `.ex4` ships anywhere (ADR 3: compiled EAs contain MetaQuotes code);
// - `resources\bridge\native` holds the x86 DLL the EA imports, with its license notices (ADR 8);
// - the native Node modules (ZeroMQ, DuckDB) are unpacked from the asar archive.
//
// Usage: tsx scripts/release/verify-package.ts <win-unpacked folder> [git ref, default HEAD]
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PE_MACHINE_X86, peMachineType } from "../../src/shared/terminal-catalog/pe-machine.js";

const run = promisify(execFile);

/** License notices and source pointer that must sit beside the DLL (and are copied with it into terminals). */
export const NATIVE_NOTICES = ["libzmq-LICENSE-MPL-2.0.txt", "libzmq-wepoll-LICENSE.txt", "libzmq-SOURCE.txt"];

/** Native Node modules that must load from `app.asar.unpacked`: a folder and the addon it must hold. */
const UNPACKED_ADDONS = [
  { folder: "zeromq", label: "zeromq" },
  { folder: "@duckdb/node-bindings-win32-x64", label: "@duckdb/node-bindings-win32-x64" },
];

export interface VerifyOptions {
  /** The unpacked app: holds `resources\`. */
  appFolder: string;
  /** The git repository the package was built from. */
  repoFolder: string;
  /** The commit (or tag) whose `mt4/` the bundled sources must equal. */
  ref: string;
}

/** Problems found in plain words; empty when the package is fine. */
export async function verifyPackage(options: VerifyOptions): Promise<string[]> {
  const problems: string[] = [];
  const resources = join(options.appFolder, "resources");
  const bridgeMt4 = join(resources, "bridge", "mt4");

  // The commit's mt4/ files, as git blob ids.
  const expected = new Map<string, string>();
  const tree = await git(options.repoFolder, "ls-tree", "-r", options.ref, "--", "mt4");
  for (const line of tree.split("\n").filter(Boolean)) {
    const match = line.match(/^\d+ blob ([0-9a-f]+)\t(.+)$/);
    if (match) expected.set(match[2]!.slice("mt4/".length), match[1]!);
  }
  if (expected.size === 0) problems.push(`The commit ${options.ref} has no mt4/ files.`);

  const bundled = new Set((await filesUnder(bridgeMt4)).map((file) => toPosix(relative(bridgeMt4, file))));
  for (const [path, blob] of expected) {
    if (!bundled.has(path)) {
      problems.push(`Bundled EA file missing: bridge/mt4/${path}`);
      continue;
    }
    // hash-object --path applies the repository's line-ending rules, so a CRLF checkout of an LF blob matches.
    const actual = (await git(options.repoFolder, "hash-object", `--path=mt4/${path}`, join(bridgeMt4, path))).trim();
    if (actual !== blob) problems.push(`Bundled EA file differs from ${options.ref}: bridge/mt4/${path}`);
  }
  for (const path of bundled) if (!expected.has(path)) problems.push(`Bundled EA file not in ${options.ref}: bridge/mt4/${path}`);

  // The DLL the bundled EA imports, as an x86 PE, with its notices beside it.
  const native = join(resources, "bridge", "native");
  let sourceText = "";
  for (const path of bundled) if (/\.(mq4|mqh)$/i.test(path)) sourceText += `${await readFile(join(bridgeMt4, path), "utf8")}\n`;
  const dllName = sourceText.match(/^#import\s+"([^"]+\.dll)"/im)?.[1];
  if (!dllName) {
    problems.push("The bundled EA sources import no DLL.");
  } else {
    const machine = await peMachine(join(native, dllName));
    if (machine === undefined) problems.push(`The DLL the EA imports is not bundled: bridge/native/${dllName}`);
    else if (machine !== PE_MACHINE_X86) problems.push(`bridge/native/${dllName} is not an x86 DLL (MetaTrader 4 is 32-bit).`);
  }
  const nativeFiles = new Set((await filesUnder(native)).map((file) => toPosix(relative(native, file))));
  for (const notice of NATIVE_NOTICES) if (!nativeFiles.has(notice)) problems.push(`Notice missing beside the DLL: bridge/native/${notice}`);

  // Native Node modules: their addons must be real files, not inside app.asar.
  const unpacked = join(resources, "app.asar.unpacked", "node_modules");
  for (const addon of UNPACKED_ADDONS) {
    const folder = join(unpacked, ...addon.folder.split("/"));
    if (!(await filesUnder(folder)).some((file) => file.toLowerCase().endsWith(".node"))) {
      problems.push(`Native module not unpacked from the asar archive: ${addon.label} (no .node file in ${toPosix(relative(options.appFolder, folder))})`);
    }
  }

  // ADR 3: no compiled EA anywhere in the package.
  const ex4 = (await filesUnder(options.appFolder))
    .filter((file) => file.toLowerCase().endsWith(".ex4"))
    .map((file) => toPosix(relative(options.appFolder, file)))
    .sort();
  for (const file of ex4) problems.push(`A compiled EA must not ship: ${file}`);

  return problems;
}

/** The PE machine type of a file: undefined when it is missing, -1 when it is not a PE file. */
async function peMachine(file: string): Promise<number | undefined> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    return undefined;
  }
  return peMachineType(bytes) ?? -1;
}

async function git(repo: string, ...args: string[]): Promise<string> {
  return (await run("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })).stdout;
}

async function filesUnder(folder: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [appFolder, ref = "HEAD"] = process.argv.slice(2);
  if (!appFolder) {
    console.error("Usage: tsx scripts/release/verify-package.ts <win-unpacked folder> [git ref]");
    process.exit(2);
  }
  const problems = await verifyPackage({ appFolder: resolve(appFolder), repoFolder: process.cwd(), ref });
  if (problems.length > 0) {
    for (const problem of problems) console.error(`✖ ${problem}`);
    process.exit(1);
  }
  console.log(`✔ ${appFolder}: bridge files match ${ref}, DLL and notices present, no .ex4, native modules unpacked.`);
}
