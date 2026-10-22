// Release check on the unpacked app (electron-builder's win-unpacked folder): the bundled bridge
// files are the tagged commit's EA sources, the DLL with its notices is there, no .ex4 ships, and
// the native modules are outside the asar archive, and the dashboard in the archive carries its font
// and loads nothing from the network. Seam: files on disk plus a real git repository.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { verifyPackage } from "../scripts/release/verify-package.js";
import { LICENCE_TEXTS } from "../src/shared/licences.js";

const EA_FILES: Record<string, string> = {
  "mt4/Experts/QuoteBridge.mq4": '#property version "1.08"\n#include <QuoteBridgeZmq.mqh>\n',
  "mt4/Include/QuoteBridgeZmq.mqh": '#import "libzmq-mt-4_3_5.dll"\nint zmq_errno();\n#import\n',
  "mt4/Include/QuoteBridgeTrading.mqh": "// trading\n",
  "mt4/Templates/QuoteBridge.tpl": "<chart>\n</chart>\n",
};

/** A minimal 32-bit PE header: "MZ", e_lfanew at 0x3C, "PE\0\0", then the machine type. */
function peFile(machine: number): Buffer {
  const bytes = Buffer.alloc(0x100);
  bytes.write("MZ", 0, "latin1");
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80, "latin1");
  bytes.writeUInt16LE(machine, 0x84);
  return bytes;
}
const X86 = 0x14c;
const X64 = 0x8664;

function write(file: string, content: string | Buffer) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function git(repo: string, ...args: string[]) {
  return execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
}

/** An asar archive as electron-builder writes it: a pickled JSON header of offsets, then the file bytes. */
function writeAsar(file: string, files: Record<string, string | Buffer>) {
  const root: { files: Record<string, unknown> } = { files: {} };
  const bodies: Buffer[] = [];
  let offset = 0;
  for (const [path, content] of Object.entries(files)) {
    const body = Buffer.from(content);
    const parts = path.split("/");
    let folder = root;
    for (const part of parts.slice(0, -1)) folder = (folder.files[part] ??= { files: {} }) as typeof root;
    folder.files[parts.at(-1)!] = { size: body.length, offset: String(offset) };
    bodies.push(body);
    offset += body.length;
  }
  const json = Buffer.from(JSON.stringify(root));
  const padded = Math.ceil(json.length / 4) * 4;
  const head = Buffer.alloc(16 + padded);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(8 + padded, 4);
  head.writeUInt32LE(4 + padded, 8);
  head.writeUInt32LE(json.length, 12);
  json.copy(head, 16);
  write(file, Buffer.concat([head, ...bodies]));
}

const WOFF2 = Buffer.concat([Buffer.from("wOF2"), Buffer.alloc(60)]);
const DASHBOARD: Record<string, string | Buffer> = {
  "package.json": "{}",
  "dist/dashboard/index.html": '<link rel="stylesheet" href="/app.css" /><script type="module" src="/app.js"></script>',
  "dist/dashboard/app.css": '@font-face { font-family: "Archivo"; src: url(fonts/archivo-latin.woff2) format("woff2"); }\nbody { font-family: "Archivo", sans-serif; }\n',
  "dist/dashboard/app.js": 'const source = "https://github.com/example/quotebridge";',
  "dist/dashboard/fonts/archivo-latin.woff2": WOFF2,
  ...Object.fromEntries(LICENCE_TEXTS.map((path) => [`dist/dashboard/${path}`, "Licence text"])),
};

/** A repository whose HEAD holds the EA sources, and a clean unpacked app built from it. */
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "qb-verify-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  for (const [path, text] of Object.entries(EA_FILES)) write(join(repo, path), text);
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "EA");

  const app = join(root, "win-unpacked");
  const resources = join(app, "resources");
  write(join(app, "QuoteBridge.exe"), "exe");
  writeAsar(join(resources, "app.asar"), DASHBOARD);
  for (const [path, text] of Object.entries(EA_FILES)) write(join(resources, "bridge", path), text);
  const native = join(resources, "bridge", "native");
  write(join(native, "libzmq-mt-4_3_5.dll"), peFile(X86));
  write(join(native, "libzmq-LICENSE-MPL-2.0.txt"), "Mozilla Public License Version 2.0\n");
  write(join(native, "libzmq-wepoll-LICENSE.txt"), "wepoll BSD\n");
  write(join(native, "libzmq-SOURCE.txt"), "source pointer\n");
  const unpacked = join(resources, "app.asar.unpacked", "node_modules");
  write(join(unpacked, "zeromq", "build", "win32", "x64", "node", "115", "addon.node"), peFile(X64));
  write(join(unpacked, "@duckdb", "node-bindings-win32-x64", "duckdb.node"), peFile(X64));
  return { repo, app, resources, native, unpacked, ref: "HEAD", asar: join(resources, "app.asar") };
}

test("a package built from the commit passes", async (t) => {
  const f = fixture(t);
  assert.deepEqual(await verifyPackage({ appFolder: f.app, repoFolder: f.repo, ref: f.ref }), []);
});

test("a bundled EA source that differs from the commit fails the release, naming the file", async (t) => {
  const f = fixture(t);
  write(join(f.resources, "bridge", "mt4", "Include", "QuoteBridgeZmq.mqh"), '#import "libzmq-mt-4_3_5.dll"\nint zmq_errno();\nint extra();\n#import\n');
  assert.deepEqual(await verifyPackage({ appFolder: f.app, repoFolder: f.repo, ref: f.ref }), [
    "Bundled EA file differs from HEAD: bridge/mt4/Include/QuoteBridgeZmq.mqh",
  ]);
});

test("a missing or an extra bundled file fails the release", async (t) => {
  const f = fixture(t);
  rmSync(join(f.resources, "bridge", "mt4", "Templates", "QuoteBridge.tpl"));
  write(join(f.resources, "bridge", "mt4", "Include", "Leftover.mqh"), "// not committed\n");
  assert.deepEqual(await verifyPackage({ appFolder: f.app, repoFolder: f.repo, ref: f.ref }), [
    "Bundled EA file missing: bridge/mt4/Templates/QuoteBridge.tpl",
    "Bundled EA file not in HEAD: bridge/mt4/Include/Leftover.mqh",
  ]);
});

test("a CRLF checkout of the committed sources still matches", async (t) => {
  const f = fixture(t);
  git(f.repo, "config", "core.autocrlf", "true");
  for (const [path, text] of Object.entries(EA_FILES)) write(join(f.resources, "bridge", path), text.replace(/\n/g, "\r\n"));
  assert.deepEqual(await verifyPackage({ appFolder: f.app, repoFolder: f.repo, ref: f.ref }), []);
});

test("the sources are checked against the given ref, not the working tree", async (t) => {
  const f = fixture(t);
  write(join(f.repo, "mt4", "Experts", "QuoteBridge.mq4"), '#property version "1.09"\n');
  git(f.repo, "commit", "-q", "-am", "1.09");
  assert.deepEqual(await verifyPackage({ appFolder: f.app, repoFolder: f.repo, ref: "HEAD~1" }), []);
  assert.deepEqual(await verifyPackage({ appFolder: f.app, repoFolder: f.repo, ref: "HEAD" }), [
    "Bundled EA file differs from HEAD: bridge/mt4/Experts/QuoteBridge.mq4",
  ]);
});

test("an .ex4 anywhere in the package fails the release (ADR 3)", async (t) => {
  const f = fixture(t);
  write(join(f.resources, "bridge", "native", "QuoteBridge.ex4"), "compiled");
  write(join(f.unpacked, "zeromq", "stray.EX4"), "compiled");
  assert.deepEqual(await verifyPackage({ appFolder: f.app, repoFolder: f.repo, ref: f.ref }), [
    "A compiled EA must not ship: resources/app.asar.unpacked/node_modules/zeromq/stray.EX4",
    "A compiled EA must not ship: resources/bridge/native/QuoteBridge.ex4",
  ]);
});

test("the DLL the EA imports must be bundled as an x86 DLL, with its notices", async (t) => {
  const f = fixture(t);
  rmSync(join(f.native, "libzmq-wepoll-LICENSE.txt"));
  rmSync(join(f.native, "libzmq-SOURCE.txt"));
  write(join(f.native, "libzmq-mt-4_3_5.dll"), peFile(X64));
  assert.deepEqual(await verifyPackage({ appFolder: f.app, repoFolder: f.repo, ref: f.ref }), [
    "bridge/native/libzmq-mt-4_3_5.dll is not an x86 DLL (MetaTrader 4 is 32-bit).",
    "Notice missing beside the DLL: bridge/native/libzmq-wepoll-LICENSE.txt",
    "Notice missing beside the DLL: bridge/native/libzmq-SOURCE.txt",
  ]);

  rmSync(join(f.native, "libzmq-mt-4_3_5.dll"));
  assert.ok((await verifyPackage({ appFolder: f.app, repoFolder: f.repo, ref: f.ref })).includes("The DLL the EA imports is not bundled: bridge/native/libzmq-mt-4_3_5.dll"));
});

test("ZeroMQ and DuckDB must be unpacked from the asar archive", async (t) => {
  const f = fixture(t);
  rmSync(join(f.unpacked, "@duckdb"), { recursive: true });
  assert.deepEqual(await verifyPackage({ appFolder: f.app, repoFolder: f.repo, ref: f.ref }), [
    "Native module not unpacked from the asar archive: @duckdb/node-bindings-win32-x64 (no .node file in resources/app.asar.unpacked/node_modules/@duckdb/node-bindings-win32-x64)",
  ]);
});

test("the dashboard must carry the Archivo font its stylesheet uses", async (t) => {
  const f = fixture(t);
  const { "dist/dashboard/fonts/archivo-latin.woff2": _, ...withoutFont } = DASHBOARD;
  writeAsar(f.asar, withoutFont);
  assert.deepEqual(await verifyPackage({ appFolder: f.app, repoFolder: f.repo, ref: f.ref }), [
    "The dashboard stylesheet uses a file the package does not hold: dist/dashboard/fonts/archivo-latin.woff2",
    "No woff2 font is bundled with the dashboard (the Archivo font, never loaded from the network).",
  ]);

  writeAsar(f.asar, { ...DASHBOARD, "dist/dashboard/fonts/archivo-latin.woff2": "not a font" });
  assert.deepEqual(await verifyPackage({ appFolder: f.app, repoFolder: f.repo, ref: f.ref }), [
    "No woff2 font is bundled with the dashboard (the Archivo font, never loaded from the network).",
  ]);
});

test("the dashboard page and stylesheet must load nothing from the network", async (t) => {
  const f = fixture(t);
  writeAsar(f.asar, {
    ...DASHBOARD,
    "dist/dashboard/index.html": '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo" />',
    "dist/dashboard/app.css": `@import url("//cdn.example.com/reset.css");\n${DASHBOARD["dist/dashboard/app.css"]}`,
  });
  assert.deepEqual(await verifyPackage({ appFolder: f.app, repoFolder: f.repo, ref: f.ref }), [
    "The dashboard loads from the network: dist/dashboard/index.html (https://fonts.googleapis.com/css2?family=Archivo)",
    "The dashboard loads from the network: dist/dashboard/app.css (//cdn.example.com/reset.css)",
  ]);
});

test("the dashboard must carry the licence texts of the works it bundles", async (t) => {
  const f = fixture(t);
  const { "dist/dashboard/licences/lightweight-charts-NOTICE.txt": _, ...withoutNotice } = DASHBOARD;
  writeAsar(f.asar, { ...withoutNotice, "dist/dashboard/licences/Archivo-OFL.txt": "" });
  assert.deepEqual(await verifyPackage({ appFolder: f.app, repoFolder: f.repo, ref: f.ref }), [
    "The dashboard does not carry a licence text: dist/dashboard/licences/Archivo-OFL.txt",
    "The dashboard does not carry a licence text: dist/dashboard/licences/lightweight-charts-NOTICE.txt",
  ]);
});
