// Seam 1 for the Terminals view and the setup screen: the real bridge server with the bridge
// installer on fake terminals (temp folders) and a fake MetaEditor, driven over HTTP, with a fake EA
// over ZeroMQ. Nothing here touches a real terminal, MetaEditor or %APPDATA%.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { startServer, type ServerConfig } from "../src/server/index.js";
import { DEFAULT_THRESHOLDS } from "../src/main/supervisor/index.js";
import type { TerminalsState, TerminalView } from "../src/server/terminals/index.js";
import { nodeInstallerFileSystem, type InstallerFileSystem } from "../src/server/installer/index.js";
import type { MetaEditorProcesses } from "../src/shared/metaeditor/index.js";
import { SettingsStore, type Settings } from "../src/shared/settings-store.js";
import type { TerminalSources } from "../src/shared/terminal-catalog/index.js";
import { FakeClock, FakeEA } from "./fake-ea.js";
import { freePort } from "./free-port.js";
import { InstallerFixture, SUCCESSFUL_COMPILE, EX4, readIfExists } from "./installer-fixtures.js";
import { FAILED_LOG, FakeMetaEditor, type FakeCompile } from "./metaeditor-fixtures.js";
import { MachineFixture, spikeMachine } from "./terminal-fixtures.js";

const TOKEN = "window-token-0123456789";

/** A fake MetaEditor whose behaviour a test can change between installs. */
class SwitchableMetaEditor implements MetaEditorProcesses {
  current: FakeMetaEditor;
  constructor(behaviour: FakeCompile) {
    this.current = new FakeMetaEditor(behaviour);
  }
  set(behaviour: FakeCompile) {
    this.current = new FakeMetaEditor(behaviour);
  }
  start(executable: string, args: string[]) {
    return this.current.start(executable, args);
  }
  runningMetaEditors() {
    return this.current.runningMetaEditors();
  }
}

async function start(t: TestContext, options: { now?: () => number; hintAfterMs?: number; compileTimeoutMs?: number; installerFs?: InstallerFileSystem } = {}) {
  const machine = await MachineFixture.create();
  t.after(() => machine.dispose());
  const spike = await spikeMachine(machine);
  const appFixture = await InstallerFixture.create();
  t.after(() => appFixture.cleanup());
  const appData = appFixture.appData;
  const settings = new SettingsStore(appData);
  const metaEditor = new SwitchableMetaEditor(SUCCESSFUL_COMPILE);
  const saved: Settings[] = [];
  const sources = async (userAddedFolders: string[]): Promise<TerminalSources> => ({
    dataRoot: machine.dataRoot,
    installationRoots: [machine.programFiles],
    userAddedFolders,
  });
  const cfg: ServerConfig = {
    eaPort: await freePort(),
    httpPort: await freePort(),
    windowToken: TOKEN,
    now: options.now,
    terminals: {
      appDataFolder: appData,
      settings,
      bundle: await appFixture.bundle(),
      sources,
      metaEditor,
      onSettingsSaved: (s) => saved.push(s),
      ...(options.hintAfterMs !== undefined ? { hintAfterMs: options.hintAfterMs } : {}),
      ...(options.compileTimeoutMs !== undefined ? { compileTimeoutMs: options.compileTimeoutMs } : {}),
      ...(options.installerFs ? { installerFs: options.installerFs } : {}),
    },
  };
  const server = await startServer(cfg);
  t.after(() => server.close());
  const origin = server.httpOrigin;
  const res = await fetch(`${origin}/session?token=${TOKEN}`, { redirect: "manual" });
  const cookie = res.headers.get("set-cookie")!.split(";")[0];

  const get = async <T = TerminalsState>(path = "/api/terminals"): Promise<{ status: number; body: T }> => {
    const r = await fetch(origin + path, { headers: { cookie } });
    return { status: r.status, body: (await r.json()) as T };
  };
  const post = async <T = unknown>(path: string, body: unknown): Promise<{ status: number; body: T }> => {
    const r = await fetch(origin + path, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: (text ? JSON.parse(text) : undefined) as T };
  };
  const state = async () => (await get()).body;
  const terminal = async (name: string) => {
    const found = (await state()).terminals.find((x) => x.name === name);
    assert.ok(found, `no terminal ${name}`);
    return found;
  };
  /** Polls until `match` holds for the named terminal. */
  const until = async (name: string, match: (x: TerminalView) => boolean) => {
    for (let i = 0; i < 200; i++) {
      const x = await terminal(name);
      if (match(x)) return x;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.fail(`${name} never matched; last ${JSON.stringify(await terminal(name))}`);
  };
  const ea = (terminalId: string) => {
    const fake = new FakeEA({ terminal: terminalId }).connect(`tcp://127.0.0.1:${cfg.eaPort}`);
    t.after(() => fake.close());
    return fake;
  };
  return { origin, cookie, get, post, state, terminal, until, ea, machine, spike, appData, settings, saved, metaEditor, server };
}

const CMC = "CMC Markets MetaTrader 4";
const EASY_FOREX = "MT4 at easy-forex";
const EASY_MARKETS = "easyMarkets MetaTrader 5";

test("the terminals endpoint needs the window session", { timeout: 15000 }, async (t) => {
  const { origin } = await start(t);
  assert.equal((await fetch(origin + "/api/terminals")).status, 401);
  const post = await fetch(origin + "/api/terminals/install", { method: "POST", headers: { "content-type": "application/json", origin }, body: "{}" });
  assert.equal(post.status, 401);
});

test("first run lists every detected terminal: MT4 offered for install, MT5 shown as not yet supported", { timeout: 15000 }, async (t) => {
  const { state } = await start(t);

  const s = await state();
  assert.equal(s.setupCompleted, false);
  assert.equal(s.startWithWindows, true);
  assert.equal(s.bundledEaVersion, "1.10");
  assert.deepEqual(
    s.terminals.map((x) => [x.name, x.kind, x.supported, x.managed, x.offered]),
    [
      [CMC, "mt4", true, false, true],
      [EASY_MARKETS, "mt5", false, false, false],
      [EASY_FOREX, "mt4", true, false, true],
    ],
  );
  const cmc = s.terminals[0];
  assert.equal(cmc.state, "not-installed");
  assert.match(cmc.terminalId ?? "", /^mt4-[0-9a-f]{12}$/);
  assert.match(s.terminals[1].unsupportedReason ?? "", /MetaTrader 5/);
});

test("setup installs into the ticked terminals, declines the others and saves Start with Windows", { timeout: 15000 }, async (t) => {
  const { state, post, until, settings, saved, spike } = await start(t);
  const before = await state();
  const cmcId = before.terminals.find((x) => x.name === CMC)!.terminalId!;
  const easyForexId = before.terminals.find((x) => x.name === EASY_FOREX)!.terminalId!;

  const res = await post("/api/setup", { install: [cmcId], startWithWindows: false });
  assert.equal(res.status, 202);

  const cmc = await until(CMC, (x) => x.state === "installed");
  assert.equal(cmc.managed, true);
  assert.equal(cmc.installedEaVersion, "1.10");
  assert.deepEqual(await readFile(join(spike.cmcData, "MQL4", "Experts", "QuoteBridge.ex4")), EX4);
  const easyForex = (await state()).terminals.find((x) => x.name === EASY_FOREX)!;
  assert.equal(easyForex.managed, false);
  assert.equal(easyForex.offered, false);
  assert.equal(await readIfExists(join(spike.easyForexData, "MQL4", "Experts", "QuoteBridge.ex4")), undefined);

  const s = await settings.read();
  assert.equal(s.setupCompleted, true);
  assert.equal(s.startWithWindows, false);
  assert.deepEqual(s.managedTerminals.map((m) => m.terminalId), [cmcId]);
  assert.deepEqual(s.declinedTerminals.map((d) => d.terminalId), [easyForexId]);
  assert.equal(saved.at(-1)?.setupCompleted, true, "main is told about the saved settings");
  assert.equal((await state()).setupCompleted, true);
});

test("the checklist ticks itself when a fake EA says hello with that terminal's Terminal ID", { timeout: 15000 }, async (t) => {
  const { state, post, until, ea } = await start(t);
  const cmcId = (await state()).terminals.find((x) => x.name === CMC)!.terminalId!;
  await post("/api/setup", { install: [cmcId], startWithWindows: true });
  const installed = await until(CMC, (x) => x.state === "installed");
  assert.deepEqual(installed.checklist, { refreshNavigator: false, applyTemplate: false, allowDllImports: false, eaConnected: false });
  assert.equal(installed.presence, null);

  // An EA in another terminal changes nothing here.
  const other = ea("mt4-ffffffffffff");
  await other.request(other.helloWire());
  const mine = ea(cmcId);
  await mine.request(mine.helloWire());

  const connected = await until(CMC, (x) => x.checklist.eaConnected);
  assert.deepEqual(connected.checklist, { refreshNavigator: true, applyTemplate: true, allowDllImports: true, eaConnected: true });
  assert.equal(connected.presence?.eaVersion, "1.08");
  assert.equal(connected.presence?.online, true);
  assert.equal(typeof connected.presence?.lastHello, "number");
  const easyForex = (await state()).terminals.find((x) => x.name === EASY_FOREX)!;
  assert.equal(easyForex.checklist.eaConnected, false);
});

/** Completes setup with only the CMC terminal ticked and waits for its first install to end. */
async function setUpCmc(app: Awaited<ReturnType<typeof start>>) {
  const cmcId = (await app.state()).terminals.find((x) => x.name === CMC)!.terminalId!;
  await app.post("/api/setup", { install: [cmcId], startWithWindows: true });
  await app.until(CMC, (x) => x.operation === null && x.state !== "not-installed");
  return cmcId;
}

test("a failed compile shows compile failed with the errors, needs attention and keeps its MetaEditor log", { timeout: 15000 }, async (t) => {
  const app = await start(t);
  app.metaEditor.set({ log: { text: FAILED_LOG, encoding: "utf16le" }, exitCode: 1 });
  const cmcId = await setUpCmc(app);

  const cmc = await app.terminal(CMC);
  assert.equal(cmc.state, "compile-failed");
  assert.equal(cmc.lastFailure?.reason, "compile-errors");
  assert.equal(cmc.lastFailure?.errors?.length, 2);
  assert.match(cmc.attention ?? "", /errors/);
  assert.deepEqual(app.server.terminals!.attention().map((a) => [a.terminalId, a.name]), [[cmcId, CMC]]);

  const log = await app.get<{ text: string; result: { errors: number; warnings: number } }>(`/api/terminals/compile-log?terminalId=${cmcId}`);
  assert.equal(log.status, 200);
  assert.deepEqual(log.body.result, { errors: 2, warnings: 1 });
  assert.match(log.body.text, /undeclared identifier/);

  // Recompile after the problem is fixed.
  app.metaEditor.set(SUCCESSFUL_COMPILE);
  assert.equal((await app.post("/api/terminals/install", { terminalIds: [cmcId] })).status, 202);
  const fixed = await app.until(CMC, (x) => x.state === "installed");
  assert.equal(fixed.attention, null);
  assert.equal(fixed.lastFailure, null);
  assert.deepEqual(app.server.terminals!.attention(), []);
});

test("an open MetaEditor of that terminal stops the install and asks the user to close it", { timeout: 15000 }, async (t) => {
  const app = await start(t);
  app.metaEditor.current.running = [join(app.spike.cmc, "metaeditor.exe")];
  await setUpCmc(app);

  const cmc = await app.terminal(CMC);
  assert.equal(cmc.lastFailure?.reason, "metaeditor-running");
  assert.match(cmc.lastFailure?.message ?? "", /Close it/);
  assert.equal(await readIfExists(join(app.spike.cmcData, "MQL4", "Experts", "QuoteBridge.ex4")), undefined);
});

test("an install that throws (e.g. the MetaEditor process query timed out) shows its failure and needs attention; a retry clears it", { timeout: 15000 }, async (t) => {
  const app = await start(t);
  app.metaEditor.current.runningMetaEditors = async () => {
    throw new Error("Listing processes with PowerShell timed out");
  };
  const cmcId = (await app.state()).terminals.find((x) => x.name === CMC)!.terminalId!;
  await app.post("/api/setup", { install: [cmcId], startWithWindows: true });

  const failed = await app.until(CMC, (x) => x.operation === null && x.lastFailure !== null);
  assert.match(failed.lastFailure?.message ?? "", /PowerShell timed out/);
  assert.match(failed.attention ?? "", /PowerShell timed out/);
  assert.deepEqual(app.server.terminals!.attention().map((a) => a.terminalId), [cmcId]);

  app.metaEditor.set(SUCCESSFUL_COMPILE);
  assert.equal((await app.post("/api/terminals/install", { terminalIds: [cmcId] })).status, 202);
  const fixed = await app.until(CMC, (x) => x.state === "installed" && x.operation === null);
  assert.equal(fixed.lastFailure, null);
  assert.equal(fixed.attention, null);
});

test("stopping the server mid-install ends MetaEditor and finishes well inside the supervisor's stop deadline, leaving the terminal untouched", { timeout: 15000 }, async (t) => {
  const app = await start(t);
  app.metaEditor.set({ ...SUCCESSFUL_COMPILE, hang: true });
  const s = await app.state();
  const ids = [CMC, EASY_FOREX].map((name) => s.terminals.find((x) => x.name === name)!.terminalId!);
  await app.post("/api/setup", { install: ids, startWithWindows: true });
  await app.until(CMC, (x) => x.operation === "installing");
  const compiling = app.metaEditor.current;
  // Stop while MetaEditor is compiling (a stop before it starts is cancelled before launching it).
  for (let i = 0; i < 200 && compiling.starts.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(compiling.starts.length, 1, "MetaEditor started");

  const began = Date.now();
  await app.server.close();
  const took = Date.now() - began;

  assert.ok(took < DEFAULT_THRESHOLDS.stopDeadlineMs / 2, `close took ${took} ms`);
  assert.equal(compiling.killed, 1);
  assert.equal(compiling.starts.length, 1, "the queued easy-forex install never started");
  assert.equal(await readIfExists(join(app.spike.cmcData, "MQL4", "Experts", "QuoteBridge.ex4")), undefined);
  assert.equal(await readIfExists(join(app.spike.cmcData, "templates", "QuoteBridge.tpl")), undefined);
  const record = await readIfExists(join(app.appData, "installs", ids[0], "record.json"));
  assert.ok(!record || JSON.parse(record.toString()).installed === null, "no install was recorded");
});

test("two Install requests for one terminal at once (a double click) run one install and refuse the other", { timeout: 15000 }, async (t) => {
  const app = await start(t);
  const cmcId = await setUpCmc(app);
  app.metaEditor.set(SUCCESSFUL_COMPILE);

  const statuses = (await Promise.all([1, 2].map(() => app.post("/api/terminals/install", { terminalIds: [cmcId] })))).map((r) => r.status);

  assert.deepEqual(statuses.sort(), [202, 409]);
  await app.until(CMC, (x) => x.operation === null);
  assert.equal(app.metaEditor.current.starts.length, 1);
});

test("two setup requests at once complete setup once", { timeout: 15000 }, async (t) => {
  const app = await start(t);
  const cmcId = (await app.state()).terminals.find((x) => x.name === CMC)!.terminalId!;

  const statuses = (await Promise.all([1, 2].map(() => app.post("/api/setup", { install: [cmcId], startWithWindows: true })))).map((r) => r.status);

  assert.deepEqual(statuses.sort(), [202, 409]);
  await app.until(CMC, (x) => x.operation === null && x.state === "installed");
  assert.equal(app.metaEditor.current.starts.length, 1);
});

test("Remove takes the bridge files out and stops managing the terminal", { timeout: 15000 }, async (t) => {
  const app = await start(t);
  const cmcId = await setUpCmc(app);

  const res = await app.post<{ removed: string[] }>("/api/terminals/remove", { terminalId: cmcId });
  assert.equal(res.status, 200);
  assert.ok(res.body.removed.includes("MQL4/Experts/QuoteBridge.ex4"));
  assert.equal(await readIfExists(join(app.spike.cmcData, "MQL4", "Experts", "QuoteBridge.ex4")), undefined);
  const cmc = await app.terminal(CMC);
  assert.equal(cmc.state, "not-installed");
  assert.equal(cmc.managed, false);
  assert.equal(cmc.declined, true);
  assert.equal(cmc.offered, false);
  assert.deepEqual((await app.settings.read()).managedTerminals, []);
});

test("rescan offers a terminal installed after setup without installing into it", { timeout: 15000 }, async (t) => {
  const app = await start(t);
  await setUpCmc(app);
  const fresh = await app.machine.installationFolder("New Broker MetaTrader 4", "mt4");
  const freshData = await app.machine.dataFolder(fresh, { mql: "MQL4" });

  const res = await app.post<TerminalsState>("/api/terminals/rescan", {});
  assert.equal(res.status, 200);
  const found = res.body.terminals.find((x) => x.name === "New Broker MetaTrader 4");
  assert.ok(found);
  assert.equal(found.offered, true);
  assert.equal(found.managed, false);
  assert.equal(await readIfExists(join(freshData, "MQL4", "Experts", "QuoteBridge.mq4")), undefined);

  // Declined, it is no longer offered.
  assert.equal((await app.post("/api/terminals/decline", { terminalId: found.terminalId })).status, 200);
  assert.equal((await app.terminal("New Broker MetaTrader 4")).offered, false);
});

test("add folder: a portable terminal is added by its folder; a folder without terminal.exe is refused", { timeout: 15000 }, async (t) => {
  const app = await start(t, { compileTimeoutMs: 1500 });
  const portable = join(app.machine.root, "Portable", "My Portable MT4");
  await app.machine.file(join(portable, "terminal.exe"), (await import("./terminal-fixtures.js")).fakeExecutable(0x014c));
  await app.machine.file(join(portable, "metaeditor.exe"), "MZ");
  await app.machine.folder(join(portable, "MQL4", "Experts"));

  const added = await app.post<{ terminal: TerminalView }>("/api/terminals/add-folder", { folder: portable });
  assert.equal(added.status, 200);
  assert.equal(added.body.terminal.portable, true);
  assert.equal(added.body.terminal.dataFolder, portable);
  assert.equal(added.body.terminal.offered, true);

  const empty = await app.post<{ error: string }>("/api/terminals/add-folder", { folder: join(app.machine.root, "Portable") });
  assert.equal(empty.status, 422);
  assert.match(empty.body.error, /terminal\.exe/);
  assert.equal((await app.post("/api/terminals/add-folder", { folder: "relative\path" })).status, 422);
});

test("unsupported and unknown terminals cannot be installed; a second install while one runs is refused", { timeout: 15000 }, async (t) => {
  const app = await start(t);
  const s = await app.state();
  const mt5 = s.terminals.find((x) => x.name === EASY_MARKETS)!;
  const res = await app.post<{ error: string }>("/api/setup", { install: [mt5.terminalId], startWithWindows: true });
  assert.equal(res.status, 422);
  assert.match(res.body.error, /MetaTrader 5/);
  assert.equal((await app.post("/api/terminals/install", { terminalIds: ["mt4-000000000000"] })).status, 404);
  assert.equal((await app.post("/api/terminals/install", { terminalIds: "nope" })).status, 400);

  app.metaEditor.set({ ...SUCCESSFUL_COMPILE, hang: true });
  const cmcId = s.terminals.find((x) => x.name === CMC)!.terminalId!;
  assert.equal((await app.post("/api/setup", { install: [cmcId], startWithWindows: true })).status, 202);
  await app.until(CMC, (x) => x.operation === "installing");
  assert.equal((await app.post("/api/terminals/install", { terminalIds: [cmcId] })).status, 409);
  assert.equal((await app.post("/api/terminals/remove", { terminalId: cmcId })).status, 409);
  assert.equal((await app.post("/api/setup", { install: [], startWithWindows: true })).status, 409, "setup runs once");
});

test("a hint appears when no EA has connected a while after install, and goes when one does", { timeout: 15000 }, async (t) => {
  const clock = new FakeClock(Date.now());
  const app = await start(t, { now: clock.now, hintAfterMs: 60_000 });
  const cmcId = await setUpCmc(app);
  assert.equal((await app.terminal(CMC)).hint, null);

  clock.advance(60_000);
  assert.match((await app.terminal(CMC)).hint ?? "", /checklist/);

  const chart = app.ea(cmcId);
  await chart.request(chart.helloWire());
  const connected = await app.until(CMC, (x) => x.checklist.eaConnected);
  assert.equal(connected.hint, null);
});

test("the terminals state is one consistent snapshot: an install that ends while it is read never shows as installing with busy false", { timeout: 15000 }, async (t) => {
  // The installer's file reads for one terminal can run a hook: here, the moment the state reads
  // the easy-forex status (after it has read CMC's), the held CMC install is let go and runs to its end.
  let onRead: ((path: string) => Promise<void>) | undefined;
  const hooked = (path: string) => onRead?.(path);
  const installerFs: InstallerFileSystem = {
    ...nodeInstallerFileSystem,
    readFile: async (path) => (await hooked(path), nodeInstallerFileSystem.readFile(path)),
    listFolder: async (path) => (await hooked(path), nodeInstallerFileSystem.listFolder(path)),
  };
  const app = await start(t, { installerFs });
  let release!: () => void;
  app.metaEditor.set({ ...SUCCESSFUL_COMPILE, waitFor: new Promise<void>((resolve) => (release = resolve)) });
  const before = await app.state();
  const cmcId = before.terminals.find((x) => x.name === CMC)!.terminalId!;
  const easyForexId = before.terminals.find((x) => x.name === EASY_FOREX)!.terminalId!;
  await app.post("/api/setup", { install: [cmcId], startWithWindows: true });
  await app.until(CMC, (x) => x.state === "installing");

  let installEnded = false;
  onRead = async (path) => {
    if (!path.includes(easyForexId)) return;
    onRead = undefined;
    const ended = new Promise<void>((resolve) => app.server.terminals!.onChange(() => resolve()));
    release();
    await ended;
    installEnded = true;
  };
  const s = await app.state();
  assert.equal(installEnded, true, "the install ended while the state was being read");

  const working = s.terminals.filter((x) => x.state === "installing" || x.operation !== null).map((x) => x.name);
  assert.equal(s.busy, working.length > 0, `busy is ${s.busy} while ${JSON.stringify(working)} show an install or operation`);
});
