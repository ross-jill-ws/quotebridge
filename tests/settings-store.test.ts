import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, SettingsStore } from "../src/shared/settings-store.js";

async function appData(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "quotebridge-settings-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

const CMC = { terminalId: "mt4-0123456789ab", name: "CMC Markets MetaTrader 4", dataFolder: String.raw`C:\Users\me\AppData\Roaming\MetaQuotes\Terminal\ABC`, installationFolder: String.raw`C:\Program Files (x86)\CMC Markets MetaTrader 4` };

test("first run: no settings file yet, defaults with the legacy EA port 5555 and Start with Windows on", async (t) => {
  const store = new SettingsStore(await appData(t));

  assert.equal(await store.isFirstRun(), true);
  const settings = await store.read();
  assert.deepEqual(settings, DEFAULT_SETTINGS);
  assert.equal(settings.ports.ea, 5555);
  assert.equal(settings.startWithWindows, true);
  assert.equal(settings.firstCloseNotificationShown, false);
  assert.deepEqual(settings.managedTerminals, []);
});

test("settings are saved as JSON in the app data folder and read back by a new store", async (t) => {
  const folder = await appData(t);
  await new SettingsStore(folder).update((settings) => {
    settings.managedTerminals.push(CMC);
    settings.declinedTerminals.push({ terminalId: "mt4-ba9876543210", name: "Demo terminal", dataFolder: String.raw`C:\data\DEF` });
    settings.startWithWindows = false;
    settings.firstCloseNotificationShown = true;
    settings.ports = { ea: 5600, http: 8080 };
    settings.setupCompleted = true;
  });

  const reopened = new SettingsStore(folder);
  assert.equal(await reopened.isFirstRun(), false);
  const settings = await reopened.read();
  assert.deepEqual(settings.managedTerminals, [CMC]);
  assert.equal(settings.declinedTerminals[0].name, "Demo terminal");
  assert.deepEqual(settings.ports, { ea: 5600, http: 8080 });
  assert.equal(settings.startWithWindows, false);
  assert.equal(settings.firstCloseNotificationShown, true);
  assert.equal(JSON.parse(await readFile(join(folder, "settings.json"), "utf8")).ports.ea, 5600);
  assert.deepEqual(await readdir(folder), ["settings.json"]);
});

test("concurrent updates are applied one after another and none is lost", async (t) => {
  const store = new SettingsStore(await appData(t));

  await Promise.all([
    store.update((settings) => void settings.managedTerminals.push(CMC)),
    store.update((settings) => void (settings.firstCloseNotificationShown = true)),
    store.update((settings) => void (settings.ports.http = 4000)),
  ]);

  const settings = await new SettingsStore(store.folder).read();
  assert.equal(settings.managedTerminals.length, 1);
  assert.equal(settings.firstCloseNotificationShown, true);
  assert.equal(settings.ports.http, 4000);
});

test("an invalid port is refused and nothing is written", async (t) => {
  const store = new SettingsStore(await appData(t));

  await assert.rejects(store.update((settings) => void (settings.ports.ea = 70000)), /port/i);
  await assert.rejects(store.update((settings) => void (settings.ports.http = settings.ports.ea)), /port/i);

  assert.equal(await store.isFirstRun(), true);
});

test("a corrupt settings file is kept aside and the app starts from defaults", async (t) => {
  const folder = await appData(t);
  await writeFile(join(folder, "settings.json"), '{"ports": {"ea": 55');
  const store = new SettingsStore(folder);

  const settings = await store.read();

  assert.deepEqual(settings, DEFAULT_SETTINGS);
  const files = await readdir(folder);
  const aside = files.find((file) => file.startsWith("settings.json.corrupt-"));
  assert.ok(aside, files.join(", "));
  assert.equal(await readFile(join(folder, aside), "utf8"), '{"ports": {"ea": 55');
});

test("settings written by an older version get defaults for the fields it did not know", async (t) => {
  const folder = await appData(t);
  await writeFile(join(folder, "settings.json"), JSON.stringify({ format: 1, managedTerminals: [CMC], ports: { ea: 5600 } }));

  const settings = await new SettingsStore(folder).read();

  assert.deepEqual(settings.managedTerminals, [CMC]);
  assert.deepEqual(settings.ports, { ea: 5600, http: DEFAULT_SETTINGS.ports.http });
  assert.equal(settings.startWithWindows, true);
  assert.deepEqual(settings.declinedTerminals, []);
});

test("first run lasts until setup is completed, even when other settings were saved before", async (t) => {
  const store = new SettingsStore(await appData(t));

  // The first-close notification is saved while the setup screen is still open.
  await store.update((settings) => void (settings.firstCloseNotificationShown = true));
  assert.equal(await store.isFirstRun(), true);
  assert.equal((await store.read()).setupCompleted, false);

  await store.update((settings) => void (settings.setupCompleted = true));
  assert.equal(await new SettingsStore(store.folder).isFirstRun(), false);
});

test("hand-edited ports that cannot work are read as defaults (a bad port as its default, equal ports as both defaults); the rest is kept and can still be saved", async (t) => {
  const cases: [unknown, { ea: number; http: number }][] = [
    [{ ea: 6000, http: 6000 }, { ea: 5555, http: 5580 }],
    [{ ea: 70000, http: 8080 }, { ea: 5555, http: 8080 }],
    [{ ea: "6000", http: 8080 }, { ea: 5555, http: 8080 }],
    [{ ea: 5580 }, { ea: 5555, http: 5580 }],
  ];
  for (const [ports, expected] of cases) {
    const folder = await appData(t);
    await writeFile(join(folder, "settings.json"), JSON.stringify({ format: 1, managedTerminals: [CMC], ports, setupCompleted: true }));
    const store = new SettingsStore(folder);

    const settings = await store.read();

    assert.deepEqual(settings.ports, expected, JSON.stringify(ports));
    assert.deepEqual(settings.managedTerminals, [CMC]);
    const saved = await store.update((s) => {
      s.startWithWindows = false;
    });
    assert.equal(saved.startWithWindows, false);
  }
});
