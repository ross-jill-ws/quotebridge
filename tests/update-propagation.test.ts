// Update propagation after an app update (ADR 9), through the server's start: managed terminals
// whose install record differs from the bundled bridge files are reinstalled through the normal
// install path, one at a time. Fake terminals in temp folders and a fake MetaEditor; nothing here
// touches a real terminal, MetaEditor or %APPDATA%.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { startServer } from "../src/server/index.js";
import { BridgeInstaller } from "../src/server/installer/index.js";
import type { TerminalsState } from "../src/server/terminals/index.js";
import { SettingsStore } from "../src/shared/settings-store.js";
import { terminalIdFor } from "../src/shared/terminal-catalog/index.js";
import { freePort } from "./fake-ea.js";
import { InstallerFixture, SUCCESSFUL_COMPILE } from "./installer-fixtures.js";
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
  const startNewer = async (options: { bundle: { sourceFolder: string; dllFolder: string }; eaPort: number; compile?: FakeCompile }) => {
    const metaEditor = new FakeMetaEditor(options.compile ?? SUCCESSFUL_COMPILE);
    const server = await startServer({
      eaPort: options.eaPort,
      httpPort: await freePort(),
      windowToken: "window-token-0123456789",
      terminals: {
        appDataFolder: fixture.appData,
        settings,
        bundle: options.bundle,
        sources: async (userAddedFolders) => ({ dataRoot: machine.dataRoot, installationRoots: [machine.programFiles], userAddedFolders }),
        metaEditor,
      },
    });
    t.after(() => server.close());
    let state: TerminalsState | undefined;
    for (let i = 0; i < 200; i++) {
      state = await server.terminals!.state();
      if (!state.busy) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(state?.busy, false, "start-up updates never finished");
    const view = (x: typeof cmc) => state!.terminals.find((v) => v.terminalId === x.terminalId)!;
    return { server, metaEditor, state: state!, view };
  };

  return { fixture, machine, spike, settings, oldBundle, cmc, easyForex, installWith, manage, decline, startNewer };
}

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
  assert.equal(cmc.installedEaVersion, "1.08", "the record still names the EA that stays installed");
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
