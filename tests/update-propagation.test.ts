// Update propagation after an app update (ADR 9), through the server's start: managed terminals
// whose install record differs from the bundled bridge files are reinstalled through the normal
// install path, one at a time. Fake terminals in temp folders and a fake MetaEditor; nothing here
// touches a real terminal, MetaEditor or %APPDATA%.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startServer } from "../src/server/index.js";
import { openDatabase, type AppDatabase } from "../src/server/database.js";
import type { TradingPreview } from "../src/server/trading/types.js";
import { BridgeInstaller, nodeInstallerFileSystem } from "../src/server/installer/index.js";
import type { TerminalsState } from "../src/server/terminals/index.js";
import { SettingsStore } from "../src/shared/settings-store.js";
import { terminalIdFor } from "../src/shared/terminal-catalog/index.js";
import { freePort } from "./free-port.js";
import { deliver, heartbeat } from "./account-fixtures.js";
import { FakeEA } from "./fake-ea.js";
import { DLL_4_3_5, InstallerFixture, SUCCESSFUL_COMPILE, readIfExists } from "./installer-fixtures.js";
import { FAILED_LOG, FakeMetaEditor, type FakeCompile } from "./metaeditor-fixtures.js";
import { MachineFixture, spikeMachine } from "./terminal-fixtures.js";

const NEW_EA_MARKER = "fix in the newer app version";

/** A machine with the spike's terminals, an app data folder and the bundle the previous app version installed. */
async function previousAppVersion(t: TestContext) {
  const machine = await MachineFixture.create();
  t.after(() => machine.dispose());
  const spike = await spikeMachine(machine);
  const fixture = await InstallerFixture.create();
  t.after(() => fixture.cleanup());
  const oldBundle = await fixture.bundle("bundle-old");
  const settings = new SettingsStore(fixture.appData);
  const terminal = (installationFolder: string, dataFolder: string) => ({ installationFolder, dataFolder, terminalId: terminalIdFor(dataFolder) });
  const cmc = terminal(spike.cmc, spike.cmcData);
  const easyForex = terminal(spike.easyForex, spike.easyForexData);

  /** Installs with a given bundle and EA port, as an earlier app run did. */
  const installWith = async (bundle: { sourceFolder: string; dllFolder: string }, target: { installationFolder: string; dataFolder: string }, eaPort: number) => {
    const installer = new BridgeInstaller({ appDataFolder: fixture.appData, bundle, metaEditor: new FakeMetaEditor(SUCCESSFUL_COMPILE) });
    const result = await installer.install(target, { eaPort });
    assert.equal(result.ok, true);
  };
  const manage = (...terminals: (typeof cmc)[]) =>
    settings.update((s) => {
      s.setupCompleted = true;
      s.managedTerminals = terminals.map((x) => ({ terminalId: x.terminalId, name: x.installationFolder, dataFolder: x.dataFolder, installationFolder: x.installationFolder }));
      return s;
    });
  const decline = (...terminals: (typeof cmc)[]) =>
    settings.update((s) => {
      s.declinedTerminals = terminals.map((x) => ({ terminalId: x.terminalId, name: x.installationFolder, dataFolder: x.dataFolder }));
      return s;
    });

  /** Starts the server of the newer app version and waits until the start-up work is done. */
  const startNewer = async (options: { bundle: { sourceFolder: string; dllFolder: string }; eaPort: number; compile?: FakeCompile; database?: AppDatabase; now?: () => number }) => {
    const metaEditor = new FakeMetaEditor(options.compile ?? SUCCESSFUL_COMPILE);
    const server = await startServer({
      eaPort: options.eaPort,
      httpPort: await freePort(),
      windowToken: "window-token-0123456789",
      database: options.database,
      now: options.now,
      settings: { store: settings },
      terminals: {
        appDataFolder: fixture.appData,
        settings,
        bundle: options.bundle,
        sources: async (userAddedFolders) => ({ dataRoot: machine.dataRoot, installationRoots: [machine.programFiles], userAddedFolders }),
        metaEditor,
      },
    });
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await server.close();
    };
    t.after(close);
    let state: TerminalsState | undefined;
    for (let i = 0; i < 200; i++) {
      state = await server.terminals!.state();
      if (!state.busy) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(state?.busy, false, "start-up updates never finished");
    const view = (x: typeof cmc) => state!.terminals.find((v) => v.terminalId === x.terminalId)!;
    return { server, close, metaEditor, state: state!, view };
  };

  return { fixture, machine, spike, settings, oldBundle, cmc, easyForex, installWith, manage, decline, startNewer };
}

/** Synthetic durable admission from the previous run; no order is sent by this fixture. */
function unfinishedPreview(terminalId: string): TradingPreview {
  return {
    id: "a".repeat(32), createdAt: 100, expiresAt: 30_100,
    intent: { action: "new", accountId: "fixture-account", symbol: "EURUSD", kind: 0, ticket: "0", lots: "0.1", price: "1.10", stopLoss: "0", takeProfit: "0", expiry: null, brokerExpiry: 0, slippage: 20 },
    source: { accountId: "fixture-account", session: "fixture-original-session", terminalId, brokerServer: "Fixture-Demo", login: "12345678" },
    marketId: "fixture-market", target: null,
    settings: { enabled: true, maxLots: "1.0", slippage: 20 },
    limits: { broker: "100", ea: "1", app: "1", maxLots: "1" },
    estimates: { loss: null, reward: null, currency: "USD" }, warnings: [],
  };
}

for (const settlement of ["review", "result"] as const) test(`restart defers only the unresolved terminal through timeout/login changes; ${settlement} resumes its update`, { timeout: 30000 }, async (t) => {
  const app = await previousAppVersion(t);
  const eaPort = await freePort();
  await app.installWith(app.oldBundle, app.cmc, eaPort);
  await app.installWith(app.oldBundle, app.easyForex, eaPort);
  await app.manage(app.cmc, app.easyForex);
  const preview = unfinishedPreview(app.cmc.terminalId);
  let database = await openDatabase(app.fixture.appData);
  await database.journal.admit(preview, "app-window", 200);
  await database.checkpointAndClose();
  database = await openDatabase(app.fixture.appData);
  t.after(() => database.checkpointAndClose());
  const newer = await app.fixture.bundle("bundle-new", { changeEa: NEW_EA_MARKER });
  const run = await app.startNewer({ bundle: newer, eaPort, database, now: () => 60_000 });
  const web = await dashboard(run.server);
  const ea = new FakeEA({ session: preview.source.session, terminal: app.cmc.terminalId, broker: preview.source.brokerServer,
    identity: { installationFolder: app.cmc.installationFolder, dataFolder: app.cmc.dataFolder } }).connect(`tcp://127.0.0.1:${eaPort}`);
  t.after(() => ea.close());
  await heartbeat(run.server.bridge, ea);
  await deliver(run.server.bridge, ea, `I|1|${ea.session}|87654321|USD|1|1|1|1.0`);
  await web.post("/api/terminals/rescan", {});

  assert.doesNotMatch(await mq4(app.cmc.dataFolder), new RegExp(NEW_EA_MARKER), "restart/timeout must not free the original terminal");
  assert.match(await mq4(app.easyForex.dataFolder), new RegExp(NEW_EA_MARKER), "another terminal updates independently");
  assert.equal(run.server.trading!.unresolvedCount(), 1);
  assert.equal((await run.server.trading!.get(web.credential, preview.id)).outcome, "unknown");
  assert.equal((await web.post("/api/terminals/install", { terminalIds: [app.cmc.terminalId] })).status, 409, "explicit recompile cannot bypass the request lock");
  assert.equal((await web.post("/api/terminals/remove", { terminalId: app.cmc.terminalId })).status, 409, "explicit removal cannot interrupt unresolved execution");
  if (settlement === "review") await run.server.trading!.review(web.credential, preview.id, "Checked open orders and account history in MetaTrader", true);
  else await deliver(run.server.bridge, ea, `X|1|${ea.session}|${preview.id}|${preview.source.login}|succeeded|42|0|Confirmed operation`);
  for (let n = 0; n < 200 && !(await mq4(app.cmc.dataFolder)).includes(NEW_EA_MARKER); n++) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.match(await mq4(app.cmc.dataFolder), new RegExp(NEW_EA_MARKER), "definitive result or review automatically resumes the deferred update");
  await run.close();
});

test("startup recovery does not remove a formerly locked EA while its original request is unresolved", { timeout: 30000 }, async (t) => {
  const app = await previousAppVersion(t);
  const eaPort = await freePort();
  await app.installWith(app.oldBundle, app.cmc, eaPort);
  const ex4 = join(app.cmc.dataFolder, "MQL4", "Experts", "QuoteBridge.ex4");
  const installer = new BridgeInstaller({ appDataFolder: app.fixture.appData, bundle: app.oldBundle,
    fs: { ...nodeInstallerFileSystem, removeFile: async (path) => {
      if (path === ex4) throw Object.assign(Error("fixture EA locked"), { code: "EBUSY" });
      await nodeInstallerFileSystem.removeFile(path);
    } },
  });
  assert.deepEqual((await installer.remove(app.cmc)).pending, ["MQL4/Experts/QuoteBridge.ex4"]);
  const database = await openDatabase(app.fixture.appData);
  t.after(() => database.checkpointAndClose());
  const preview = unfinishedPreview(app.cmc.terminalId);
  await database.journal.admit(preview, "app-window", 200);
  const run = await app.startNewer({ bundle: app.oldBundle, eaPort, database });
  assert.ok(await readIfExists(ex4), "startup recovery must defer terminal file removal too");
  const web = await dashboard(run.server);
  await run.server.trading!.review(web.credential, preview.id, "Checked open orders and account history in MetaTrader", true);
  for (let n = 0; n < 200 && await readIfExists(ex4); n++) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(await readIfExists(ex4), undefined, "review resumes pending removal recovery");
  await run.close();
});

const mq4 = (dataFolder: string) => readFile(join(dataFolder, "MQL4", "Experts", "QuoteBridge.mq4"), "utf8");
const template = (dataFolder: string) => readFile(join(dataFolder, "templates", "QuoteBridge.tpl"), "utf8");

test("on start, managed terminals with an outdated install are updated; up-to-date and unmanaged ones are left alone", { timeout: 20000 }, async (t) => {
  const app = await previousAppVersion(t);
  const eaPort = await freePort();
  const newBundle = await app.fixture.bundle("bundle-new", { changeEa: NEW_EA_MARKER });
  // CMC has the previous app version's install; easy-forex too, but the user unticked it.
  await app.installWith(app.oldBundle, app.cmc, eaPort);
  await app.installWith(app.oldBundle, app.easyForex, eaPort);
  // A third managed terminal already has the newer bundle.
  const upToDateFolder = await app.machine.installationFolder("New Broker MetaTrader 4", "mt4");
  const upToDate = { installationFolder: upToDateFolder, dataFolder: await app.machine.dataFolder(upToDateFolder, { mql: "MQL4" }), terminalId: "" };
  upToDate.terminalId = terminalIdFor(upToDate.dataFolder);
  await app.installWith(newBundle, upToDate, eaPort);
  const upToDateEx4 = join(upToDate.dataFolder, "MQL4", "Experts", "QuoteBridge.ex4");
  const upToDateWritten = (await stat(upToDateEx4)).mtimeMs;
  await app.manage(app.cmc, upToDate);
  await app.decline(app.easyForex);

  const { metaEditor, view } = await app.startNewer({ bundle: newBundle, eaPort });

  assert.match(await mq4(app.cmc.dataFolder), new RegExp(NEW_EA_MARKER));
  assert.equal(view(app.cmc).state, "installed");
  assert.doesNotMatch(await mq4(app.easyForex.dataFolder), new RegExp(NEW_EA_MARKER), "an unticked terminal is not updated");
  assert.equal(view(app.easyForex).state, "outdated");
  assert.equal(view(upToDate).state, "installed");
  assert.equal((await stat(upToDateEx4)).mtimeMs, upToDateWritten, "an up-to-date terminal is untouched");
  assert.deepEqual(
    metaEditor.starts.map((s) => s.executable),
    [join(app.cmc.installationFolder, "metaeditor.exe")],
    "only the outdated managed terminal was compiled",
  );
});

test("a template-only change in the newer app version reaches every managed terminal on start", { timeout: 20000 }, async (t) => {
  const app = await previousAppVersion(t);
  const eaPort = await freePort();
  await app.installWith(app.oldBundle, app.cmc, eaPort);
  await app.installWith(app.oldBundle, app.easyForex, eaPort);
  await app.manage(app.cmc, app.easyForex);
  const newBundle = await app.fixture.bundle("bundle-new", { changeTemplate: "scale 4" });

  const { metaEditor, view } = await app.startNewer({ bundle: newBundle, eaPort });

  for (const x of [app.cmc, app.easyForex]) {
    assert.match(await template(x.dataFolder), /^scale=4\r?$/m);
    assert.equal(view(x).state, "installed");
  }
  assert.equal(metaEditor.starts.length, 2, "one install per terminal, one after another");
});

test("an update that fails to compile keeps the old EA, records the error and needs attention", { timeout: 20000 }, async (t) => {
  const app = await previousAppVersion(t);
  const eaPort = await freePort();
  await app.installWith(app.oldBundle, app.cmc, eaPort);
  const oldEa = await readFile(join(app.cmc.dataFolder, "MQL4", "Experts", "QuoteBridge.ex4"));
  const oldSource = await mq4(app.cmc.dataFolder);
  await app.manage(app.cmc);
  const newBundle = await app.fixture.bundle("bundle-new", { changeEa: NEW_EA_MARKER });

  const { server, view } = await app.startNewer({ bundle: newBundle, eaPort, compile: { log: { text: FAILED_LOG, encoding: "utf16le" }, exitCode: 1 } });

  assert.deepEqual(await readFile(join(app.cmc.dataFolder, "MQL4", "Experts", "QuoteBridge.ex4")), oldEa);
  assert.equal(await mq4(app.cmc.dataFolder), oldSource);
  const cmc = view(app.cmc);
  assert.equal(cmc.state, "compile-failed");
  assert.equal(cmc.lastFailure?.reason, "compile-errors");
  assert.equal(cmc.installedEaVersion, "1.12", "the record still names the EA that stays installed");
  assert.deepEqual(server.terminals!.attention().map((a) => a.terminalId), [app.cmc.terminalId], "drives the tray warning");
});

test("a changed EA port rewrites the template in every managed terminal on start", { timeout: 20000 }, async (t) => {
  const app = await previousAppVersion(t);
  const oldPort = await freePort();
  const newPort = await freePort();
  await app.installWith(app.oldBundle, app.cmc, oldPort);
  await app.installWith(app.oldBundle, app.easyForex, oldPort);
  await app.manage(app.cmc, app.easyForex);

  const { view } = await app.startNewer({ bundle: app.oldBundle, eaPort: newPort });

  for (const x of [app.cmc, app.easyForex]) {
    assert.match(await template(x.dataFolder), new RegExp(`^ServerEndpoint=tcp://127\\.0\\.0\\.1:${newPort}\\r?$`, "m"));
    assert.equal(view(x).state, "installed");
  }
});

test("a newer app version whose DLL differs only in bytes, under the same name, reinstalls nothing, however the DLL got there", { timeout: 30000 }, async (t) => {
  const app = await previousAppVersion(t);
  const eaPort = await freePort();
  // CMC: the previous app version installed its DLL. Easy-forex: a different DLL of the same name
  // was already there (the legacy build), so the installer kept it and did not record it.
  await app.installWith(app.oldBundle, app.cmc, eaPort);
  const foreignDll = Buffer.from("MZ legacy build of libzmq 4.3.5");
  await mkdir(join(app.easyForex.dataFolder, "MQL4", "Libraries"), { recursive: true });
  await writeFile(join(app.easyForex.dataFolder, "MQL4", "Libraries", "libzmq-mt-4_3_5.dll"), foreignDll);
  await app.installWith(app.oldBundle, app.easyForex, eaPort);
  await app.manage(app.cmc, app.easyForex);
  const rebuilt = await app.fixture.bundle("bundle-rebuilt-dll", { dll: { file: "libzmq-mt-4_3_5.dll", bytes: Buffer.from("MZ dummy libzmq 4.3.5 x86, another CI build") } });

  for (const run of ["first start", "second start"]) {
    const { close, metaEditor, view } = await app.startNewer({ bundle: rebuilt, eaPort });
    assert.equal(metaEditor.starts.length, 0, `${run}: nothing to reinstall`);
    for (const x of [app.cmc, app.easyForex]) assert.equal(view(x).state, "installed", `${run}: ${x.terminalId}`);
    await close();
  }
  assert.deepEqual(await readFile(join(app.cmc.dataFolder, "MQL4", "Libraries", "libzmq-mt-4_3_5.dll")), DLL_4_3_5);
  assert.deepEqual(await readFile(join(app.easyForex.dataFolder, "MQL4", "Libraries", "libzmq-mt-4_3_5.dll")), foreignDll);
});

/** The window's HTTP session on a started server, as the dashboard uses it. */
async function dashboard(server: { httpOrigin: string }) {
  const origin = server.httpOrigin;
  const res = await fetch(`${origin}/session?token=window-token-0123456789`, { redirect: "manual" });
  const cookie = res.headers.get("set-cookie")!.split(";")[0];
  const post = async (path: string, body: unknown) => {
    const r = await fetch(origin + path, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: (text ? JSON.parse(text) : undefined) as TerminalsState };
  };
  const state = async () => (await (await fetch(origin + "/api/terminals", { headers: { cookie } })).json()) as TerminalsState;
  const idle = async () => {
    for (let i = 0; i < 200; i++) {
      const s = await state();
      if (!s.busy) return s;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail("the install never finished");
  };
  return { post, state, idle, credential: { headers: { cookie, origin } } };
}

test("a terminal unticked on the setup screen is never installed: not by setup, not by a rescan, not by updates on later starts", { timeout: 30000 }, async (t) => {
  const app = await previousAppVersion(t);
  const eaPort = await freePort();
  const ea = (dataFolder: string) => readIfExists(join(dataFolder, "MQL4", "Experts", "QuoteBridge.mq4"));

  // First run: the user leaves easy-forex ticked and unticks CMC.
  const first = await app.startNewer({ bundle: app.oldBundle, eaPort });
  assert.equal(first.state.setupCompleted, false);
  const web = await dashboard(first.server);
  assert.equal((await web.post("/api/setup", { install: [app.easyForex.terminalId], startWithWindows: true })).status, 202);
  let state = await web.idle();
  const cmcView = () => state.terminals.find((v) => v.terminalId === app.cmc.terminalId)!;
  assert.equal(await ea(app.cmc.dataFolder), undefined, "setup did not install into the unticked terminal");
  assert.ok(await ea(app.easyForex.dataFolder), "setup installed into the ticked terminal");
  assert.deepEqual([cmcView().managed, cmcView().declined, cmcView().offered, cmcView().state], [false, true, false, "not-installed"]);
  const saved = await app.settings.read();
  assert.deepEqual(saved.managedTerminals.map((m) => m.terminalId), [app.easyForex.terminalId]);
  assert.deepEqual(saved.declinedTerminals.map((d) => d.terminalId), [app.cmc.terminalId]);

  // A rescan finds it again but neither offers nor installs it.
  const rescanned = await web.post("/api/terminals/rescan", {});
  assert.equal(rescanned.status, 200);
  state = await web.idle();
  assert.deepEqual([cmcView().managed, cmcView().declined, cmcView().offered], [false, true, false]);
  assert.equal(await ea(app.cmc.dataFolder), undefined, "a rescan did not install into the unticked terminal");
  assert.deepEqual(first.metaEditor.starts.map((s) => s.executable), [join(app.easyForex.installationFolder, "metaeditor.exe")]);
  await first.close();

  // The next app version updates the managed terminal on start and leaves the unticked one alone.
  const newBundle = await app.fixture.bundle("bundle-new", { changeEa: NEW_EA_MARKER });
  const next = await app.startNewer({ bundle: newBundle, eaPort });
  assert.match((await ea(app.easyForex.dataFolder))!.toString("utf8"), new RegExp(NEW_EA_MARKER));
  assert.equal(await ea(app.cmc.dataFolder), undefined, "an update did not install into the unticked terminal");
  assert.equal(next.view(app.cmc).declined, true);
  assert.deepEqual(next.metaEditor.starts.map((s) => s.executable), [join(app.easyForex.installationFolder, "metaeditor.exe")]);
});
