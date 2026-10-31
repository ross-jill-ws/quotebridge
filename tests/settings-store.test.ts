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

test("trading defaults are safe and explicit changes survive reopening", async (t) => {
  const store = new SettingsStore(await appData(t));
  assert.deepEqual((await store.read()).trading, { enabled: false, maxLots: "1.0", slippage: 20 });
  await store.update((s) => void (s.trading = { enabled: true, maxLots: "0.25", slippage: 0 }));
  assert.deepEqual((await new SettingsStore(store.folder).read()).trading, { enabled: true, maxLots: "0.25", slippage: 0 });
  // Real-account trading (ADR 14) is off unless saved on; settings saved before it keep the rest of their trading values.
  await store.update((s) => void (s.trading = { enabled: false, maxLots: "0.25", slippage: 0, realAccounts: true }));
  assert.deepEqual((await new SettingsStore(store.folder).read()).trading, { enabled: false, maxLots: "0.25", slippage: 0, realAccounts: true });
});

test("invalid trading settings are rejected on update and persisted corruption fails closed without losing other settings", async (t) => {
  const store = new SettingsStore(await appData(t));
  const invalid: unknown[] = [null, [], {}, { enabled: true },
    ...["yes", 1, null].map((enabled) => ({ enabled, maxLots: "1.0", slippage: 20 })),
    ...[1, "0", "-1", "1e2", " 1", "NaN", "Infinity", ".5", "1.", "01", "0.000", "9".repeat(16), "0.00000000001", "9".repeat(400)].map((maxLots) => ({ enabled: true, maxLots, slippage: 20 })),
    ...[-1, 0.5, "20", null, Infinity, 10001, Number.MAX_SAFE_INTEGER + 1].map((slippage) => ({ enabled: true, maxLots: "1.0", slippage })),
    { enabled: true, maxLots: "1.0", slippage: 20, extra: true },
    ...["yes", 1, null].map((realAccounts) => ({ enabled: true, maxLots: "1.0", slippage: 20, realAccounts }))];
  for (const trading of invalid) {
    await assert.rejects(store.update((s) => { Object.assign(s, { trading }); }), /trading/i);
    await writeFile(store.file, JSON.stringify({ format: 1, theme: "dark", trading }));
    const loaded = await store.read();
    assert.deepEqual(loaded.trading, { enabled: false, maxLots: "1.0", slippage: 20 }, JSON.stringify(trading));
    assert.equal(loaded.theme, "dark");
  }
});

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

test("the Settings view's own settings default to: keep the window in the tray at a sign-in start, theme follows Windows", async (t) => {
  const store = new SettingsStore(await appData(t));
  const settings = await store.read();
  assert.equal(settings.openWindowAtStartup, false);
  assert.equal(settings.theme, "system");

  await store.update((s) => {
    s.openWindowAtStartup = true;
    s.theme = "dark";
  });
  const reopened = await new SettingsStore(store.folder).read();
  assert.equal(reopened.openWindowAtStartup, true);
  assert.equal(reopened.theme, "dark");
});

test("a hand-edited theme or window-at-startup value that cannot work is read as its default", async (t) => {
  const folder = await appData(t);
  await writeFile(join(folder, "settings.json"), JSON.stringify({ format: 1, theme: "purple", openWindowAtStartup: "yes", startWithWindows: false }));

  const settings = await new SettingsStore(folder).read();

  assert.equal(settings.theme, "system");
  assert.equal(settings.openWindowAtStartup, false);
  assert.equal(settings.startWithWindows, false);
});

test("prices flash by default; turning it off is saved", async (t) => {
  const store = new SettingsStore(await appData(t));
  assert.equal((await store.read()).flashPrices, true);

  await store.update((s) => void (s.flashPrices = false));

  assert.equal((await new SettingsStore(store.folder).read()).flashPrices, false);
});

test("a hand-edited Flash prices value that cannot work is read as its default", async (t) => {
  const folder = await appData(t);
  await writeFile(join(folder, "settings.json"), JSON.stringify({ format: 1, flashPrices: "off" }));
  assert.equal((await new SettingsStore(folder).read()).flashPrices, true);
});

test("a hand-edited Chart colours value that cannot work is read as its default", async (t) => {
  const folder = await appData(t);
  await writeFile(join(folder, "settings.json"), JSON.stringify({ format: 1, chartColours: "purple" }));
  assert.equal((await new SettingsStore(folder).read()).chartColours, "default");
  await writeFile(join(folder, "settings.json"), JSON.stringify({ format: 1, chartColours: "green-on-black" }));
  assert.equal((await new SettingsStore(folder).read()).chartColours, "green-on-black");
});

test("times are shown in broker time by default; local and UTC are kept; a hand-edited value that cannot work is read as broker time", async (t) => {
  const store = new SettingsStore(await appData(t));
  assert.equal((await store.read()).timeShown, "broker");

  for (const timeShown of ["local", "utc", "broker"] as const) {
    await store.update((s) => void (s.timeShown = timeShown));
    assert.equal((await new SettingsStore(store.folder).read()).timeShown, timeShown);
  }

  await writeFile(join(store.folder, "settings.json"), JSON.stringify({ format: 1, timeShown: "Europe/London" }));
  assert.equal((await new SettingsStore(store.folder).read()).timeShown, "broker");
});

test("order defaults: none at first; each market's optional lots and stop distances are saved and read back", async (t) => {
  const store = new SettingsStore(await appData(t));
  assert.deepEqual((await store.read()).orderDefaults, []);
  const defaults = [
    { brokerServer: "EasyForex-Demo", symbol: "BTCUSD", lots: "0.05", stopLossPoints: "50000", takeProfitPoints: null },
    { brokerServer: "EasyForex-Demo", symbol: "EURUSD", lots: null, stopLossPoints: "200", takeProfitPoints: "400" },
  ];
  await store.update((s) => void (s.orderDefaults = defaults));
  assert.deepEqual((await new SettingsStore(store.folder).read()).orderDefaults, defaults);
});

test("invalid order defaults are refused on update, and a hand-edited bad entry is dropped without losing the rest", async (t) => {
  const store = new SettingsStore(await appData(t));
  const good = { brokerServer: "Demo-Broker", symbol: "EURUSD", lots: "0.1", stopLossPoints: null, takeProfitPoints: null };
  const bad: unknown[] = [
    { ...good, lots: "0" }, { ...good, lots: 0.1 }, { ...good, stopLossPoints: "-5" }, { ...good, takeProfitPoints: "1e3" },
    { ...good, symbol: "" }, { ...good, brokerServer: 5 }, { ...good, extra: true }, { ...good, lots: null },
  ];
  for (const entry of bad) await assert.rejects(store.update((s) => void Object.assign(s, { orderDefaults: [entry] })), /order defaults/i, JSON.stringify(entry));
  await assert.rejects(store.update((s) => void (s.orderDefaults = [good, { ...good, lots: "0.2" }])), /order defaults/i, "one entry per market");
  await writeFile(store.file, JSON.stringify({ format: 1, theme: "dark", orderDefaults: [good, ...bad] }));
  const loaded = await store.read();
  assert.deepEqual(loaded.orderDefaults, [good]);
  assert.equal(loaded.theme, "dark");
});
