// `npm run dev -- --real`: a dev run against real terminals installs nothing until the developer asks.
// Its fresh dev settings skip the setup screen with no managed terminals, start-up update propagation
// finds nothing to update, and the Terminals view warns that it acts on real terminals. "Real"
// terminals here are fake ones in temp folders with a fake MetaEditor; nothing touches %APPDATA%.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realTerminalOptions, REAL_TERMINALS_WARNING, seedRealRunSettings } from "../scripts/dev/real-run.js";
import { startServer } from "../src/server/index.js";
import { BridgeInstaller } from "../src/server/installer/index.js";
import type { TerminalsState } from "../src/server/terminals/index.js";
import { SETTINGS_FILE, SettingsStore } from "../src/shared/settings-store.js";
import { terminalIdFor } from "../src/shared/terminal-catalog/index.js";
import { freePort } from "./free-port.js";
import { InstallerFixture, SUCCESSFUL_COMPILE } from "./installer-fixtures.js";
import { FakeMetaEditor } from "./metaeditor-fixtures.js";
import { MachineFixture, spikeMachine } from "./terminal-fixtures.js";

async function scratchFolder(t: TestContext) {
  const folder = await mkdtemp(join(tmpdir(), "qb-dev-real-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

test("a fresh --real dev data folder starts with setup completed and no managed terminals", async (t) => {
  const dataFolder = join(await scratchFolder(t), "QuoteBridge-dev");

  assert.equal(await seedRealRunSettings(dataFolder), true);

  const settings = await new SettingsStore(dataFolder).read();
  assert.equal(settings.setupCompleted, true);
  assert.deepEqual(settings.managedTerminals, []);
  assert.deepEqual(settings.declinedTerminals, []);
  assert.deepEqual(settings.ports, { ea: 5555, http: 5580 });
});

test("existing --real dev settings are kept exactly as they are", async (t) => {
  const dataFolder = await scratchFolder(t);
  const file = join(dataFolder, SETTINGS_FILE);
  const existing = JSON.stringify({ format: 1, setupCompleted: false, managedTerminals: [{ terminalId: "ABC", name: "CMC", dataFolder: "D", installationFolder: "I" }] });
  await writeFile(file, existing);

  assert.equal(await seedRealRunSettings(dataFolder), false);

  assert.equal(await readFile(file, "utf8"), existing);
});

test("at the start of a fresh --real run nothing is installed or updated, and the view warns about real terminals", { timeout: 20000 }, async (t) => {
  const machine = await MachineFixture.create();
  t.after(() => machine.dispose());
  const spike = await spikeMachine(machine);
  const fixture = await InstallerFixture.create();
  t.after(() => fixture.cleanup());
  // The installed app manages CMC with an older bundle; its records live in its own data folder.
  const installedApp = await scratchFolder(t);
  const cmc = { installationFolder: spike.cmc, dataFolder: spike.cmcData };
  const old = new BridgeInstaller({ appDataFolder: installedApp, bundle: await fixture.bundle("bundle-old"), metaEditor: new FakeMetaEditor(SUCCESSFUL_COMPILE) });
  assert.equal((await old.install(cmc, { eaPort: 5555 })).ok, true);
  const mq4 = join(spike.cmcData, "MQL4", "Experts", "QuoteBridge.mq4");
  const mq4Written = (await stat(mq4)).mtimeMs;

  const devFolder = join(await scratchFolder(t), "QuoteBridge-dev");
  await seedRealRunSettings(devFolder);
  const metaEditor = new FakeMetaEditor(SUCCESSFUL_COMPILE);
  const server = await startServer({
    eaPort: await freePort(),
    httpPort: await freePort(),
    windowToken: "window-token-0123456789",
    terminals: realTerminalOptions({
      appDataFolder: devFolder,
      settings: new SettingsStore(devFolder),
      bundle: await fixture.bundle("bundle-new", { changeEa: "newer EA" }),
      sources: async (userAddedFolders) => ({ dataRoot: machine.dataRoot, installationRoots: [machine.programFiles], userAddedFolders }),
      metaEditor,
    }),
  });
  t.after(() => server.close());
  let state: TerminalsState | undefined;
  for (let i = 0; i < 40; i++) {
    state = await server.terminals!.state();
    if (state.busy) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.equal(state!.busy, false, "nothing was queued at start");
  assert.equal(state!.setupCompleted, true, "no setup screen");
  assert.equal(state!.warning, REAL_TERMINALS_WARNING);
  assert.deepEqual(state!.terminals.filter((v) => v.managed), []);
  assert.ok(state!.terminals.some((v) => v.terminalId === terminalIdFor(spike.cmcData) && v.offered), "CMC is offered, not installed");
  assert.deepEqual(metaEditor.starts, [], "no MetaEditor ran");
  assert.equal((await stat(mq4)).mtimeMs, mq4Written, "the installed app's EA is untouched");
});
