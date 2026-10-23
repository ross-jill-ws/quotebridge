import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { terminalIdFor } from "../src/shared/terminal-catalog/index.js";
import { BridgeInstaller, nodeInstallerFileSystem, type InstallerFileSystem } from "../src/server/installer/index.js";
import { FAILED_LOG, FakeMetaEditor } from "./metaeditor-fixtures.js";
import { DEFAULT_TPL, DLL_4_3_5, EX4, faultyFileSystem, InstallerFixture, NATIVE_NOTICES, OTHER_TPL, readIfExists, REPO_MT4_FOLDER, SUCCESSFUL_COMPILE } from "./installer-fixtures.js";

const repoFile = (relative: string) => readFile(join(REPO_MT4_FOLDER, relative));

test("install places every bridge file in the data folder: sources, compiled EA, DLL with notices, template", async (t) => {
  const fixture = await InstallerFixture.create();
  t.after(() => fixture.cleanup());
  const terminal = await fixture.terminal();
  const metaEditor = new FakeMetaEditor(SUCCESSFUL_COMPILE);
  const installer = new BridgeInstaller({ appDataFolder: fixture.appData, bundle: await fixture.bundle(), metaEditor });

  const result = await installer.install(terminal, { eaPort: 5555 });

  assert.equal(result.ok, true);
  const data = (relative: string) => readFile(join(terminal.dataFolder, relative));
  assert.deepEqual(await data("MQL4/Experts/QuoteBridge.mq4"), await repoFile("Experts/QuoteBridge.mq4"));
  assert.deepEqual(await data("MQL4/Experts/QuoteBridge.ex4"), EX4);
  assert.deepEqual(await data("MQL4/Include/QuoteBridgeZmq.mqh"), await repoFile("Include/QuoteBridgeZmq.mqh"));
  assert.deepEqual(await data("MQL4/Include/QuoteBridgeTrading.mqh"), await repoFile("Include/QuoteBridgeTrading.mqh"));
  assert.deepEqual(await data("MQL4/Libraries/libzmq-mt-4_3_5.dll"), DLL_4_3_5);
  for (const [file, text] of Object.entries(NATIVE_NOTICES)) assert.equal((await data(`MQL4/Libraries/${file}`)).toString(), text);

  // MetaEditor of this terminal compiled a staged copy under the app data folder, never in the terminal.
  assert.equal(metaEditor.starts.length, 1);
  assert.equal(metaEditor.starts[0].executable, join(terminal.installationFolder, "metaeditor.exe"));
  const compileArg = metaEditor.starts[0].args[0];
  assert.ok(compileArg.startsWith(`/compile:"${fixture.appData}`), compileArg);
});

test("the installed template carries the derived Terminal ID and the app's endpoint; nothing else changes and other templates are untouched", async (t) => {
  const fixture = await InstallerFixture.create();
  t.after(() => fixture.cleanup());
  const terminal = await fixture.terminal();
  const installer = new BridgeInstaller({ appDataFolder: fixture.appData, bundle: await fixture.bundle(), metaEditor: new FakeMetaEditor(SUCCESSFUL_COMPILE) });

  await installer.install(terminal, { eaPort: 15555 });

  const installed = await readFile(join(terminal.dataFolder, "templates", "QuoteBridge.tpl"), "utf8");
  const bundled = await readFile(join(REPO_MT4_FOLDER, "Templates", "QuoteBridge.tpl"), "utf8");
  const expected = bundled
    .replace(/^TerminalId=mt4-main$/m, `TerminalId=${terminalIdFor(terminal.dataFolder)}`)
    .replace(/^ServerEndpoint=tcp:\/\/127\.0\.0\.1:5555$/m, "ServerEndpoint=tcp://127.0.0.1:15555");
  assert.notEqual(expected, bundled);
  assert.equal(installed, expected);
  assert.match(installed, /^TerminalId=mt4-[0-9a-f]{12}\r?$/m);
  assert.match(installed, /^EnableDemoTrading=false\r?$/m);
  assert.match(installed, /^flags=343\r?$/m);
  assert.equal(await readFile(join(terminal.dataFolder, "templates", "default.tpl"), "utf8"), DEFAULT_TPL);
  assert.equal(await readFile(join(terminal.dataFolder, "templates", "my-scalping.tpl"), "utf8"), OTHER_TPL);
});

async function installedTerminal(t: { after(fn: () => Promise<void>): void }, options: { bundle?: { changeEa?: string } } = {}) {
  const fixture = await InstallerFixture.create();
  t.after(() => fixture.cleanup());
  const terminal = await fixture.terminal();
  const bundle = await fixture.bundle("bundle", options.bundle);
  const metaEditor = new FakeMetaEditor(SUCCESSFUL_COMPILE);
  const installer = new BridgeInstaller({ appDataFolder: fixture.appData, bundle, metaEditor });
  const first = await installer.install(terminal, { eaPort: 5555 });
  assert.equal(first.ok, true);
  return { fixture, terminal, installer, metaEditor };
}

test("a terminal is not installed before the first install and installed with the bundled EA version after it", async (t) => {
  const fixture = await InstallerFixture.create();
  t.after(() => fixture.cleanup());
  const terminal = await fixture.terminal();
  const installer = new BridgeInstaller({ appDataFolder: fixture.appData, bundle: await fixture.bundle(), metaEditor: new FakeMetaEditor(SUCCESSFUL_COMPILE) });

  assert.equal((await installer.status(terminal)).state, "not-installed");
  await installer.install(terminal, { eaPort: 5555 });

  const status = await installer.status(terminal);
  assert.equal(status.state, "installed");
  assert.equal(status.eaVersion, "1.09");
  assert.equal(status.terminalId, terminalIdFor(terminal.dataFolder));
});

test("a second install skips every identical file and backs nothing up", async (t) => {
  const { terminal, installer } = await installedTerminal(t);

  const second = await installer.install(terminal, { eaPort: 5555 });

  assert.equal(second.ok, true);
  assert.ok(second.ok && second.files.length === 10);
  assert.deepEqual(second.ok && [...new Set(second.files.map((file) => file.action))], ["unchanged"]);
  assert.equal(second.ok && second.backupFolder, undefined);
});

test("installing again with another EA port replaces only the template", async (t) => {
  const { terminal, installer } = await installedTerminal(t);

  const second = await installer.install(terminal, { eaPort: 6000 });

  assert.ok(second.ok);
  assert.deepEqual(second.files.filter((file) => file.action !== "unchanged"), [{ target: "templates/QuoteBridge.tpl", action: "replaced" }]);
  assert.match(await readFile(join(terminal.dataFolder, "templates", "QuoteBridge.tpl"), "utf8"), /^ServerEndpoint=tcp:\/\/127\.0\.0\.1:6000\r?$/m);
  // The template replaced was the app's own, so no backup is kept.
  assert.equal(second.backupFolder, undefined);
});

test("a terminal becomes outdated when the app's bundled EA sources change, and installed again after an update", async (t) => {
  const { fixture, terminal } = await installedTerminal(t);
  const newer = new BridgeInstaller({ appDataFolder: fixture.appData, bundle: await fixture.bundle("bundle-v2", { changeEa: "fix in a newer app version" }), metaEditor: new FakeMetaEditor(SUCCESSFUL_COMPILE) });

  assert.equal((await newer.status(terminal)).state, "outdated");
  const update = await newer.install(terminal, { eaPort: 5555 });

  assert.ok(update.ok);
  assert.deepEqual(update.files.find((file) => file.target === "MQL4/Experts/QuoteBridge.mq4")?.action, "replaced");
  assert.equal((await newer.status(terminal)).state, "installed");
});

test("a changed bundled template, notice or DLL version (a new DLL name) also makes an installed terminal outdated; the update brings the new file", async (t) => {
  for (const [name, change, target] of [
    ["template", { changeTemplate: "scale 4" }, "templates/QuoteBridge.tpl"],
    ["notice", { changeNotice: "Notice amended" }, "MQL4/Libraries/QuoteBridgeNative-LICENSE.txt"],
    ["dll", { dll: { file: "libzmq-mt-4_3_6.dll", bytes: Buffer.from("MZ dummy libzmq 4.3.6 x86") } }, "MQL4/Libraries/libzmq-mt-4_3_6.dll"],
  ] as const) {
    const { fixture, terminal } = await installedTerminal(t);
    const newer = new BridgeInstaller({ appDataFolder: fixture.appData, bundle: await fixture.bundle(`bundle-${name}`, change), metaEditor: new FakeMetaEditor(SUCCESSFUL_COMPILE) });

    assert.equal((await newer.status(terminal)).state, "outdated", name);
    const update = await newer.install(terminal, { eaPort: 5555 });

    assert.ok(update.ok, name);
    assert.notEqual(update.files.find((file) => file.target === target)?.action, "unchanged", name);
    assert.equal((await newer.status(terminal)).state, "installed", name);
  }
});

test("a new DLL version lands beside the old one, which is never overwritten", async (t) => {
  const { fixture, terminal } = await installedTerminal(t);
  const DLL_4_3_6 = Buffer.from("MZ dummy libzmq 4.3.6 x86");
  const newer = new BridgeInstaller({
    appDataFolder: fixture.appData,
    bundle: await fixture.bundle("bundle-v2", { dll: { file: "libzmq-mt-4_3_6.dll", bytes: DLL_4_3_6 } }),
    metaEditor: new FakeMetaEditor(SUCCESSFUL_COMPILE),
  });

  const update = await newer.install(terminal, { eaPort: 5555 });

  assert.ok(update.ok);
  assert.deepEqual(await readFile(join(terminal.dataFolder, "MQL4", "Libraries", "libzmq-mt-4_3_5.dll")), DLL_4_3_5);
  assert.deepEqual(await readFile(join(terminal.dataFolder, "MQL4", "Libraries", "libzmq-mt-4_3_6.dll")), DLL_4_3_6);
  assert.match(await readFile(join(terminal.dataFolder, "MQL4", "Include", "QuoteBridgeZmq.mqh"), "utf8"), /#import "libzmq-mt-4_3_6\.dll"/);
});

test("a different DLL under the same versioned name is kept, not overwritten", async (t) => {
  const fixture = await InstallerFixture.create();
  t.after(() => fixture.cleanup());
  const terminal = await fixture.terminal();
  const other = Buffer.from("MZ another build of libzmq 4.3.5");
  await mkdir(join(terminal.dataFolder, "MQL4", "Libraries"), { recursive: true });
  await writeFile(join(terminal.dataFolder, "MQL4", "Libraries", "libzmq-mt-4_3_5.dll"), other);
  const installer = new BridgeInstaller({ appDataFolder: fixture.appData, bundle: await fixture.bundle(), metaEditor: new FakeMetaEditor(SUCCESSFUL_COMPILE) });

  const result = await installer.install(terminal, { eaPort: 5555 });

  assert.ok(result.ok);
  assert.equal(result.files.find((file) => file.target === "MQL4/Libraries/libzmq-mt-4_3_5.dll")?.action, "kept-existing-dll");
  assert.deepEqual(await readFile(join(terminal.dataFolder, "MQL4", "Libraries", "libzmq-mt-4_3_5.dll")), other);
});

test("a failure mid-install restores replaced files from backups and deletes only the files this run created", async (t) => {
  const fixture = await InstallerFixture.create();
  t.after(() => fixture.cleanup());
  const terminal = await fixture.terminal();
  const experts = join(terminal.dataFolder, "MQL4", "Experts");
  await writeFile(join(experts, "QuoteBridge.mq4"), "// an older QuoteBridge source\r\n");
  await writeFile(join(experts, "MyOwnEA.mq4"), "// the user's EA\r\n");
  const fs = faultyFileSystem((path) => path.startsWith(terminal.dataFolder) && path.endsWith("QuoteBridge.tpl"));
  const installer = new BridgeInstaller({ appDataFolder: fixture.appData, bundle: await fixture.bundle(), metaEditor: new FakeMetaEditor(SUCCESSFUL_COMPILE), fs });

  const result = await installer.install(terminal, { eaPort: 5555 });

  assert.equal(result.ok, false);
  assert.equal(fs.faults.length, 1);
  assert.ok(!result.ok && result.rollback?.ok);
  assert.equal(!result.ok && result.failure.stage, "copy");
  assert.equal(await readFile(join(experts, "QuoteBridge.mq4"), "utf8"), "// an older QuoteBridge source\r\n");
  assert.equal(await readFile(join(experts, "MyOwnEA.mq4"), "utf8"), "// the user's EA\r\n");
  for (const created of ["MQL4/Experts/QuoteBridge.ex4", "MQL4/Include/QuoteBridgeZmq.mqh", "MQL4/Libraries/libzmq-mt-4_3_5.dll", "MQL4/Libraries/QuoteBridgeNative-LICENSE.txt", "templates/QuoteBridge.tpl"]) {
    assert.equal(await readIfExists(join(terminal.dataFolder, created)), undefined, created);
  }
  assert.equal(await readFile(join(terminal.dataFolder, "templates", "default.tpl"), "utf8"), DEFAULT_TPL);
  const status = await installer.status(terminal);
  assert.equal(status.state, "installed-legacy");
  assert.equal(status.lastFailure?.stage, "copy");
});

test("a failed update rolls back to the app's previous install, which stays installed", async (t) => {
  const { fixture, terminal } = await installedTerminal(t);
  const before = await readFile(join(terminal.dataFolder, "MQL4", "Experts", "QuoteBridge.mq4"));
  const fs = faultyFileSystem((path) => path.startsWith(terminal.dataFolder) && path.endsWith("QuoteBridge.ex4"));
  const newer = new BridgeInstaller({
    appDataFolder: fixture.appData,
    bundle: await fixture.bundle("bundle-v2", { changeEa: "newer" }),
    metaEditor: new FakeMetaEditor({ ...SUCCESSFUL_COMPILE, ex4: Buffer.from("EX4 build 2") }),
    fs,
  });

  const update = await newer.install(terminal, { eaPort: 5555 });

  assert.equal(update.ok, false);
  assert.deepEqual(await readFile(join(terminal.dataFolder, "MQL4", "Experts", "QuoteBridge.mq4")), before);
  assert.deepEqual(await readFile(join(terminal.dataFolder, "MQL4", "Experts", "QuoteBridge.ex4")), EX4);
  assert.equal((await newer.status(terminal)).state, "outdated");
});

test("a compile with errors copies nothing, keeps the old EA and shows compile failed with the errors and log", async (t) => {
  const { fixture, terminal } = await installedTerminal(t);
  const newer = new BridgeInstaller({
    appDataFolder: fixture.appData,
    bundle: await fixture.bundle("bundle-v2", { changeEa: "broken" }),
    metaEditor: new FakeMetaEditor({ ex4: Buffer.from("EX4 partial"), log: { text: FAILED_LOG, encoding: "utf16le" }, exitCode: 1 }),
  });

  const update = await newer.install(terminal, { eaPort: 5555 });

  assert.equal(update.ok, false);
  assert.deepEqual(await readFile(join(terminal.dataFolder, "MQL4", "Experts", "QuoteBridge.ex4")), EX4);
  const status = await newer.status(terminal);
  assert.equal(status.state, "compile-failed");
  assert.equal(status.eaVersion, "1.09");
  assert.equal(status.lastFailure?.reason, "compile-errors");
  assert.equal(status.lastFailure?.errors?.length, 2);
  assert.ok(status.lastFailure?.compileLog?.startsWith(fixture.appData));
  assert.match((await readFile(status.lastFailure!.compileLog!)).toString("utf16le"), /Result: 2 errors/);
});

test("an open MetaEditor of the terminal stops the install and asks the user to close it", async (t) => {
  const fixture = await InstallerFixture.create();
  t.after(() => fixture.cleanup());
  const terminal = await fixture.terminal();
  const metaEditor = new FakeMetaEditor(SUCCESSFUL_COMPILE);
  metaEditor.running = [join(terminal.installationFolder, "metaeditor.exe")];
  const installer = new BridgeInstaller({ appDataFolder: fixture.appData, bundle: await fixture.bundle(), metaEditor });

  const result = await installer.install(terminal, { eaPort: 5555 });

  assert.equal(!result.ok && result.failure.reason, "metaeditor-running");
  assert.match(!result.ok ? result.failure.message : "", /Close it/);
  assert.equal(metaEditor.starts.length, 0);
});

test("a terminal without MetaEditor is reported as no MetaEditor and nothing is written into it", async (t) => {
  const fixture = await InstallerFixture.create();
  t.after(() => fixture.cleanup());
  const terminal = await fixture.terminal("Broker Without Editor", { metaEditor: false });
  const metaEditor = new FakeMetaEditor(SUCCESSFUL_COMPILE);
  const installer = new BridgeInstaller({ appDataFolder: fixture.appData, bundle: await fixture.bundle(), metaEditor });

  assert.equal((await installer.status(terminal)).state, "no-metaeditor");
  const result = await installer.install(terminal, { eaPort: 5555 });

  assert.equal(!result.ok && result.failure.reason, "no-metaeditor");
  assert.equal(metaEditor.starts.length, 0);
  assert.equal(await readIfExists(join(terminal.dataFolder, "templates", "QuoteBridge.tpl")), undefined);
  assert.equal(await readIfExists(join(terminal.dataFolder, "MQL4", "Experts", "QuoteBridge.mq4")), undefined);
  assert.equal((await installer.status(terminal)).state, "no-metaeditor");
});

test("a legacy install (mt4-main, legacy files) is detected and replaced through backups", async (t) => {
  const fixture = await InstallerFixture.create();
  t.after(() => fixture.cleanup());
  const terminal = await fixture.terminal();
  const legacy: Record<string, string> = {
    "MQL4/Experts/QuoteBridge.mq4": '#property version "1.07"\r\n',
    "MQL4/Experts/QuoteBridge.ex4": "EX4 legacy 1.07",
    "MQL4/Include/QuoteBridgeZmq.mqh": "// legacy zmq include\r\n",
    "MQL4/Include/QuoteBridgeTrading.mqh": "// legacy trading include\r\n",
    "MQL4/Libraries/QuoteBridgeNative-LICENSE.txt": "legacy licence copy\r\n",
    "templates/QuoteBridge.tpl": "<chart>\r\n<expert>\r\nname=QuoteBridge\r\n<inputs>\r\nServerEndpoint=tcp://127.0.0.1:5555\r\nTerminalId=mt4-main\r\n</inputs>\r\n</expert>\r\n</chart>\r\n",
  };
  for (const [target, text] of Object.entries(legacy)) {
    await mkdir(join(terminal.dataFolder, target, ".."), { recursive: true });
    await writeFile(join(terminal.dataFolder, target), text);
  }
  const legacyDll = Buffer.from("MZ legacy build of libzmq 4.3.5");
  await writeFile(join(terminal.dataFolder, "MQL4", "Libraries", "libzmq-mt-4_3_5.dll"), legacyDll);
  const installer = new BridgeInstaller({ appDataFolder: fixture.appData, bundle: await fixture.bundle(), metaEditor: new FakeMetaEditor(SUCCESSFUL_COMPILE) });

  const before = await installer.status(terminal);
  assert.equal(before.state, "installed-legacy");
  assert.equal(before.legacyTerminalId, "mt4-main");

  const result = await installer.install(terminal, { eaPort: 5555 });

  assert.ok(result.ok);
  assert.ok(result.backupFolder?.startsWith(fixture.appData), result.backupFolder);
  for (const [target, text] of Object.entries(legacy)) {
    assert.equal(result.files.find((file) => file.target === target)?.action, "replaced", target);
    assert.equal(await readFile(join(result.backupFolder!, target), "utf8"), text, target);
  }
  assert.deepEqual(await readFile(join(terminal.dataFolder, "MQL4", "Experts", "QuoteBridge.ex4")), EX4);
  assert.match(await readFile(join(terminal.dataFolder, "templates", "QuoteBridge.tpl"), "utf8"), new RegExp(`^TerminalId=${terminalIdFor(terminal.dataFolder)}\\r?$`, "m"));
  // The legacy DLL has the same versioned name: it is kept, never overwritten (it may be loaded).
  assert.deepEqual(await readFile(join(terminal.dataFolder, "MQL4", "Libraries", "libzmq-mt-4_3_5.dll")), legacyDll);
  assert.equal((await installer.status(terminal)).state, "installed");
});

test("Remove deletes only the files in the install record, leaving user files and changed files", async (t) => {
  const { terminal, installer } = await installedTerminal(t);
  await writeFile(join(terminal.dataFolder, "MQL4", "Experts", "MyOwnEA.ex4"), "user EA");
  await writeFile(join(terminal.dataFolder, "templates", "QuoteBridge.tpl"), "edited by the user");

  const result = await installer.remove(terminal);

  assert.equal(result.removed.length, 9);
  assert.deepEqual(result.keptModified, ["templates/QuoteBridge.tpl"]);
  assert.deepEqual(result.pending, []);
  assert.equal(await readIfExists(join(terminal.dataFolder, "MQL4", "Experts", "QuoteBridge.ex4")), undefined);
  assert.equal(await readIfExists(join(terminal.dataFolder, "MQL4", "Libraries", "libzmq-mt-4_3_5.dll")), undefined);
  assert.equal(await readFile(join(terminal.dataFolder, "MQL4", "Experts", "MyOwnEA.ex4"), "utf8"), "user EA");
  assert.equal(await readFile(join(terminal.dataFolder, "templates", "default.tpl"), "utf8"), DEFAULT_TPL);
  assert.equal((await installer.status(terminal)).state, "not-installed");
});

test("Remove leaves a DLL MetaTrader holds locked and deletes it on the next start", async (t) => {
  const { fixture, terminal } = await installedTerminal(t);
  const dll = join(terminal.dataFolder, "MQL4", "Libraries", "libzmq-mt-4_3_5.dll");
  const bundle = await fixture.bundle("bundle-again");
  const locked = new BridgeInstaller({ appDataFolder: fixture.appData, bundle, fs: faultyFileSystem((path, operation) => path === dll && operation === "remove", "EBUSY") });

  const result = await locked.remove(terminal);

  assert.deepEqual(result.pending, ["MQL4/Libraries/libzmq-mt-4_3_5.dll"]);
  assert.deepEqual(await readFile(dll), DLL_4_3_5);
  assert.deepEqual((await locked.status(terminal)).pendingRemoval, ["MQL4/Libraries/libzmq-mt-4_3_5.dll"]);

  const nextStart = new BridgeInstaller({ appDataFolder: fixture.appData, bundle });
  const recovered = await nextStart.recover();

  assert.deepEqual(recovered.removed, [dll]);
  assert.equal(await readIfExists(dll), undefined);
  assert.deepEqual((await nextStart.status(terminal)).pendingRemoval, []);
});

test("Remove also deletes older DLL versions this app installed", async (t) => {
  const { fixture, terminal } = await installedTerminal(t);
  const newer = new BridgeInstaller({
    appDataFolder: fixture.appData,
    bundle: await fixture.bundle("bundle-v2", { dll: { file: "libzmq-mt-4_3_6.dll", bytes: Buffer.from("MZ 4.3.6") } }),
    metaEditor: new FakeMetaEditor(SUCCESSFUL_COMPILE),
  });
  assert.ok((await newer.install(terminal, { eaPort: 5555 })).ok);

  await newer.remove(terminal);

  assert.equal(await readIfExists(join(terminal.dataFolder, "MQL4", "Libraries", "libzmq-mt-4_3_5.dll")), undefined);
  assert.equal(await readIfExists(join(terminal.dataFolder, "MQL4", "Libraries", "libzmq-mt-4_3_6.dll")), undefined);
});

test("an install interrupted by a crash is rolled back from its restoration manifest on the next start", async (t) => {
  const fixture = await InstallerFixture.create();
  t.after(() => fixture.cleanup());
  const terminal = await fixture.terminal();
  await writeFile(join(terminal.dataFolder, "MQL4", "Experts", "QuoteBridge.mq4"), "// legacy source\r\n");
  const bundle = await fixture.bundle();
  // The app dies while copying the template: that write never finishes.
  let reachedTemplate!: () => void;
  const crashed = new Promise<void>((resolve) => (reachedTemplate = resolve));
  const dying: InstallerFileSystem = {
    ...nodeInstallerFileSystem,
    writeFile(path, data, options) {
      if (path.startsWith(terminal.dataFolder) && path.endsWith("QuoteBridge.tpl")) {
        reachedTemplate();
        return new Promise(() => {});
      }
      return nodeInstallerFileSystem.writeFile(path, data, options);
    },
  };
  void new BridgeInstaller({ appDataFolder: fixture.appData, bundle, metaEditor: new FakeMetaEditor(SUCCESSFUL_COMPILE), fs: dying }).install(terminal, { eaPort: 5555 });
  await crashed;
  assert.deepEqual(await readFile(join(terminal.dataFolder, "MQL4", "Experts", "QuoteBridge.ex4")), EX4);

  const nextStart = new BridgeInstaller({ appDataFolder: fixture.appData, bundle });
  const recovered = await nextStart.recover();

  assert.equal(recovered.rolledBack.length, 1);
  assert.equal(await readFile(join(terminal.dataFolder, "MQL4", "Experts", "QuoteBridge.mq4"), "utf8"), "// legacy source\r\n");
  assert.equal(await readIfExists(join(terminal.dataFolder, "MQL4", "Experts", "QuoteBridge.ex4")), undefined);
  assert.equal(await readIfExists(join(terminal.dataFolder, "MQL4", "Libraries", "libzmq-mt-4_3_5.dll")), undefined);
  assert.equal((await nextStart.status(terminal)).state, "installed-legacy");
  assert.deepEqual((await nextStart.recover()).rolledBack, []);
});

test("an install that dies after recording itself is kept on the next start, not rolled back under a record that says installed", async (t) => {
  const fixture = await InstallerFixture.create();
  t.after(() => fixture.cleanup());
  const terminal = await fixture.terminal();
  const bundle = await fixture.bundle();
  // The app dies while cleaning up after the install was recorded.
  let recorded!: () => void;
  const died = new Promise<void>((resolve) => (recorded = resolve));
  const dying: InstallerFileSystem = {
    ...nodeInstallerFileSystem,
    removeFolder(path) {
      if (path.includes(`${join("installs", terminalIdFor(terminal.dataFolder), "runs")}`)) {
        recorded();
        return new Promise(() => {});
      }
      return nodeInstallerFileSystem.removeFolder(path);
    },
  };
  void new BridgeInstaller({ appDataFolder: fixture.appData, bundle, metaEditor: new FakeMetaEditor(SUCCESSFUL_COMPILE), fs: dying }).install(terminal, { eaPort: 5555 });
  await died;

  const nextStart = new BridgeInstaller({ appDataFolder: fixture.appData, bundle });
  const recovered = await nextStart.recover();

  assert.deepEqual(recovered.rolledBack, []);
  assert.deepEqual(await readFile(join(terminal.dataFolder, "MQL4", "Experts", "QuoteBridge.ex4")), EX4);
  assert.deepEqual(await readFile(join(terminal.dataFolder, "MQL4", "Libraries", "libzmq-mt-4_3_5.dll")), DLL_4_3_5);
  assert.equal((await nextStart.status(terminal)).state, "installed");
});

test("an install whose run folder cannot be cleaned up (EBUSY) still succeeds and is not rolled back on the next start", async (t) => {
  const fixture = await InstallerFixture.create();
  t.after(() => fixture.cleanup());
  const terminal = await fixture.terminal();
  const bundle = await fixture.bundle();
  const busy: InstallerFileSystem = {
    ...nodeInstallerFileSystem,
    async removeFolder(path) {
      if (path.includes(join("installs", terminalIdFor(terminal.dataFolder), "runs"))) throw Object.assign(new Error(`EBUSY: injected, '${path}'`), { code: "EBUSY" });
      return nodeInstallerFileSystem.removeFolder(path);
    },
  };
  const installer = new BridgeInstaller({ appDataFolder: fixture.appData, bundle, metaEditor: new FakeMetaEditor(SUCCESSFUL_COMPILE), fs: busy });

  const result = await installer.install(terminal, { eaPort: 5555 });

  assert.equal(result.ok, true);
  const nextStart = new BridgeInstaller({ appDataFolder: fixture.appData, bundle });
  assert.deepEqual((await nextStart.recover()).rolledBack, []);
  assert.deepEqual(await readFile(join(terminal.dataFolder, "MQL4", "Experts", "QuoteBridge.ex4")), EX4);
  assert.equal((await nextStart.status(terminal)).state, "installed");
});

test("a bundle that could not be read once is read again on the next install, not given up on until restart", async (t) => {
  const fixture = await InstallerFixture.create();
  t.after(() => fixture.cleanup());
  const terminal = await fixture.terminal();
  const bundle = await fixture.bundle();
  let failNextBundleRead = true;
  const flaky: InstallerFileSystem = {
    ...nodeInstallerFileSystem,
    async readFile(path) {
      if (failNextBundleRead && path.startsWith(bundle.sourceFolder)) {
        failNextBundleRead = false;
        throw Object.assign(new Error(`EIO: injected, '${path}'`), { code: "EIO" });
      }
      return nodeInstallerFileSystem.readFile(path);
    },
  };
  const installer = new BridgeInstaller({ appDataFolder: fixture.appData, bundle, metaEditor: new FakeMetaEditor(SUCCESSFUL_COMPILE), fs: flaky });

  await assert.rejects(installer.install(terminal, { eaPort: 5555 }), /EIO/);
  const retry = await installer.install(terminal, { eaPort: 5555 });

  assert.equal(retry.ok, true);
  assert.equal((await installer.status(terminal)).state, "installed");
});

test("the install state checks that metaeditor.exe exists without reading the whole program", async (t) => {
  const fixture = await InstallerFixture.create();
  t.after(() => fixture.cleanup());
  const withEditor = await fixture.terminal();
  const withoutEditor = await fixture.terminal("Broker Without Editor", { metaEditor: false });
  const emptyEditor = await fixture.terminal("Broker With Empty Editor");
  await writeFile(join(emptyEditor.installationFolder, "metaeditor.exe"), "");
  const reads: string[] = [];
  const counting: InstallerFileSystem = {
    ...nodeInstallerFileSystem,
    readFile(path) {
      reads.push(path);
      return nodeInstallerFileSystem.readFile(path);
    },
  };
  const installer = new BridgeInstaller({ appDataFolder: fixture.appData, bundle: await fixture.bundle(), metaEditor: new FakeMetaEditor(SUCCESSFUL_COMPILE), fs: counting });

  assert.equal((await installer.status(withEditor)).state, "not-installed");
  assert.equal((await installer.status(withoutEditor)).state, "no-metaeditor");
  assert.equal((await installer.status(emptyEditor)).state, "no-metaeditor");
  assert.deepEqual(reads.filter((path) => /metaeditor\.exe$/i.test(path)), []);
});

test("once MetaEditor is back in the installation folder the terminal is no longer reported as no MetaEditor, and an install succeeds", async (t) => {
  const fixture = await InstallerFixture.create();
  t.after(() => fixture.cleanup());
  const terminal = await fixture.terminal("Broker Without Editor", { metaEditor: false });
  const installer = new BridgeInstaller({ appDataFolder: fixture.appData, bundle: await fixture.bundle(), metaEditor: new FakeMetaEditor(SUCCESSFUL_COMPILE) });
  const failed = await installer.install(terminal, { eaPort: 5555 });
  assert.equal(!failed.ok && failed.failure.reason, "no-metaeditor");

  await writeFile(join(terminal.installationFolder, "metaeditor.exe"), "MZ metaeditor");

  const status = await installer.status(terminal);
  assert.equal(status.state, "not-installed");
  assert.equal(status.lastFailure, undefined);
  assert.ok((await installer.install(terminal, { eaPort: 5555 })).ok);
  assert.equal((await installer.status(terminal)).state, "installed");
});
