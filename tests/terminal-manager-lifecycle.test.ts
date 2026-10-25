// Approved lifecycle seam: real TerminalManager/installer/settings on temp terminals.
// Only filesystem and MetaEditor process boundaries are deferred; no real EA/orders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { BridgeServer } from "../src/server/bridge/index.js";
import { BridgeInstaller, nodeInstallerFileSystem } from "../src/server/installer/index.js";
import { TerminalManager } from "../src/server/terminals/terminal-manager.js";
import { SettingsStore } from "../src/shared/settings-store.js";
import { terminalIdFor } from "../src/shared/terminal-catalog/index.js";
import { InstallerFixture, SUCCESSFUL_COMPILE } from "./installer-fixtures.js";
import { FakeMetaEditor } from "./metaeditor-fixtures.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("automatic updates preserve a removal claimed while another terminal's update check waits", { timeout: 15000 }, async (t) => {
  const fixture = await InstallerFixture.create();
  const releaseCheck = deferred();
  const checkWaiting = deferred();
  const releaseRemoval = deferred();
  const removalWaiting = deferred();
  const releaseCompile = deferred();
  const compileStarted = deferred();
  let manager: TerminalManager | undefined;
  let removal: Promise<unknown> | undefined;
  t.after(async () => {
    releaseCheck.resolve();
    releaseRemoval.resolve();
    releaseCompile.resolve();
    await removal;
    await manager?.close();
    await fixture.cleanup();
  });
  const first = await fixture.terminal("First");
  const second = await fixture.terminal("Second");
  const firstId = terminalIdFor(first.dataFolder);
  const secondId = terminalIdFor(second.dataFolder);
  const bundle = await fixture.bundle();
  const installer = new BridgeInstaller({ appDataFolder: fixture.appData, bundle, metaEditor: new FakeMetaEditor(SUCCESSFUL_COMPILE) });
  assert.equal((await installer.install(first, { eaPort: 5555 })).ok, true);
  assert.equal((await installer.install(second, { eaPort: 5555 })).ok, true);
  const settings = new SettingsStore(fixture.appData);
  await settings.update((s) => {
    s.setupCompleted = true;
    s.managedTerminals = [
      { ...first, terminalId: firstId, name: "First" },
      { ...second, terminalId: secondId, name: "Second" },
    ];
    return s;
  });

  const runtime = { bridge: new BridgeServer(), eaPort: 5555, now: Date.now };
  let pauseCheck = false;
  let pauseRemoval = true;
  const fakeCompiler = new FakeMetaEditor({ ...SUCCESSFUL_COMPILE, waitFor: releaseCompile.promise });
  manager = new TerminalManager({
    appDataFolder: fixture.appData, settings, bundle,
    sources: async () => ({ dataRoot: join(fixture.root, "empty-catalog") }),
    installerFs: {
      ...nodeInstallerFileSystem,
      async readFile(path) {
        if (pauseCheck && path === join(fixture.appData, "installs", secondId, "record.json")) {
          pauseCheck = false;
          checkWaiting.resolve();
          await releaseCheck.promise;
        }
        return nodeInstallerFileSystem.readFile(path);
      },
      async removeFile(path) {
        if (pauseRemoval && path.startsWith(first.dataFolder)) {
          pauseRemoval = false;
          removalWaiting.resolve();
          await releaseRemoval.promise;
        }
        return nodeInstallerFileSystem.removeFile(path);
      },
    },
    metaEditor: {
      runningMetaEditors: () => fakeCompiler.runningMetaEditors(),
      start(executable, args) {
        const process = fakeCompiler.start(executable, args);
        compileStarted.resolve();
        return process;
      },
    },
  }, runtime);
  await manager.state();
  // Drain startup notification reads before arming the external read boundary.
  await new Promise<void>((resolve) => setImmediate(resolve));
  runtime.eaPort = 5556;
  pauseCheck = true;
  manager.requestsChanged();
  await checkWaiting.promise;
  removal = manager.remove({ terminalId: firstId });
  await removalWaiting.promise;
  assert.equal(manager.availableForTrading(firstId), false);
  releaseCheck.resolve();
  await compileStarted.promise;

  assert.deepEqual(fakeCompiler.starts.map((start) => start.executable), [join(second.installationFolder, "metaeditor.exe")],
    "only the second terminal may compile while the first terminal's removal is held");
  const state = await manager.state();
  assert.equal(state.terminals.find((terminal) => terminal.terminalId === firstId)?.operation, "removing",
    "an automatic candidate must not overwrite or release the removal's lifecycle claim");
  assert.equal(manager.availableForTrading(firstId), false);
  assert.equal(state.terminals.find((terminal) => terminal.terminalId === secondId)?.operation, "installing");
});
