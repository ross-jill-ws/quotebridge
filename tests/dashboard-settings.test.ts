// The Settings view's model: reading a typed port, what a port change will do, and the note when a
// development run's port overrides win over the saved ports; the theme the page takes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { apiKeyRows, deleteRecording, parsePort, portChange, portsNote, recordingRows, revokeApiKey } from "../src/dashboard/settings/settings-model.js";
import { themeAttribute } from "../src/dashboard/theme.js";
import type { SettingsView } from "../src/server/settings/index.js";

const VIEW: SettingsView = { startWithWindows: true, openWindowAtStartup: false, theme: "system", flashPrices: true, chartColours: "default", timeShown: "broker", ports: { ea: 5555, http: 5580 }, portsInUse: { ea: 5555, http: 5580 } };

test("a typed port is a whole number from 1024 to 65535, different from the other port and from the current one", () => {
  assert.deepEqual(parsePort(" 5556 ", "ea", VIEW), { port: 5556 });
  assert.deepEqual(parsePort("", "ea", VIEW), { error: "Type a port number." });
  for (const text of ["80", "70000", "55.5", "abc"]) assert.deepEqual(parsePort(text, "ea", VIEW), { error: "Use a whole number from 1024 to 65535." }, text);
  assert.deepEqual(parsePort("5580", "ea", VIEW), { error: "The dashboard port already uses 5580." });
  assert.deepEqual(parsePort("5555", "ea", VIEW), { error: "The EA port is already 5555." });
});

test("a new EA port says the terminals' template is updated and running charts need it applied again", () => {
  const change = portChange("ea", 5556, 2);
  assert.equal(change.title, "Change the EA port to 5556?");
  assert.match(change.body, /restarts on the new port/);
  assert.match(change.body, /template in your 2 managed terminals is updated/);
  assert.match(change.body, /apply the QuoteBridge template to each chart again/);
  assert.equal(change.confirm, "Restart on port 5556");
});

test("a new dashboard port says the window reconnects by itself and nothing changes in MetaTrader", () => {
  const change = portChange("http", 5590, 2);
  assert.equal(change.title, "Change the dashboard port to 5590?");
  assert.match(change.body, /window reconnects by itself/);
  assert.match(change.body, /Nothing changes in MetaTrader/);
});

test("with one managed terminal, or none, the wording follows", () => {
  assert.match(portChange("ea", 5556, 1).body, /template in your managed terminal is updated/);
  assert.doesNotMatch(portChange("ea", 5556, 0).body, /managed terminal/);
});

test("no note while the server runs on the saved ports; a note naming the ports in use when overrides win", () => {
  assert.equal(portsNote(VIEW), null);
  assert.equal(
    portsNote({ ...VIEW, portsInUse: { ea: 6655, http: 6680 } }),
    "This run listens on EA port 6655 and dashboard port 6680: a development run's port overrides win over the saved ports.",
  );
});

test("the page's data-theme follows the Theme setting; System leaves it to the colour-scheme media query", () => {
  assert.equal(themeAttribute("light"), "light");
  assert.equal(themeAttribute("dark"), "dark");
  assert.equal(themeAttribute("system"), undefined);
});

const RECORDED = {
  brokerServer: "EasyForex-Demo",
  symbol: "EURUSD",
  digits: 5,
  recording: true,
  recordingSince: Date.UTC(2027, 0, 15, 8),
  samples: 1234567,
  first: Date.UTC(2027, 0, 15, 8),
  last: Date.UTC(2027, 0, 16, 21, 59, 30),
  aboutBytes: 39_506_144,
  clockRule: { winterOffsetMinutes: 120, dst: "us" as const },
};

test("Settings › Recording lists each market with its state, sample count, range on the chosen clock and about-size", () => {
  const [row] = recordingRows([RECORDED], "broker", () => 0);
  assert.equal(row.symbol, "EURUSD");
  assert.equal(row.brokerServer, "EasyForex-Demo");
  assert.equal(row.state, "Recording since 2027-01-15 10:00");
  assert.equal(row.samples, "1,234,567 samples");
  assert.equal(row.range, "2027-01-15 10:00 to 2027-01-16 23:59");
  assert.equal(row.size, "about 39.5 MB");
  assert.equal(row.canStop, true);
  assert.equal(row.canDelete, true);

  assert.equal(recordingRows([RECORDED], "utc", () => 0)[0].range, "2027-01-15 08:00 to 2027-01-16 21:59");
  assert.equal(recordingRows([RECORDED], "local", () => 660)[0].range, "2027-01-15 19:00 to 2027-01-17 08:59");
});

test("a stopped market keeps its data and offers Delete only; one sample, and none yet, read plainly", () => {
  const [stopped] = recordingRows([{ ...RECORDED, recording: false, recordingSince: null, samples: 1, last: RECORDED.first, aboutBytes: 32 }], "broker", () => 0);
  assert.deepEqual([stopped.state, stopped.samples, stopped.size, stopped.canStop, stopped.canDelete], ["Stopped", "1 sample", "about 32 bytes", false, true]);
  const [fresh] = recordingRows([{ ...RECORDED, samples: 0, first: null, last: null, aboutBytes: 0 }], "broker", () => 0);
  assert.deepEqual([fresh.samples, fresh.range, fresh.canDelete], ["No samples yet", "", false]);
});

test("Delete data… asks first, naming the market and how many samples go", () => {
  const confirm = deleteRecording(RECORDED);
  assert.equal(confirm.title, "Delete the recorded data of EURUSD on EasyForex-Demo?");
  assert.match(confirm.body, /1,234,567 samples are deleted/);
  assert.match(confirm.body, /cannot be undone/);
  assert.match(confirm.body, /Recording goes on/);
  assert.doesNotMatch(deleteRecording({ ...RECORDED, recording: false }).body, /Recording goes on/);
  assert.equal(confirm.confirm, "Delete 1,234,567 samples");
});

test("Settings › API keys lists each key with its scope, when it was made and last used, on this computer's clock", () => {
  // 15 January 2027 08:00 UTC; this computer is on UTC+1.
  const made = Date.UTC(2027, 0, 15, 8);
  const keys = [
    { id: "a1", name: "Laptop CLI", scope: "read" as const, prefix: "qbk_1a2b3c4d", createdAt: made, lastUsedAt: made + 90 * 60_000 },
    { id: "b2", name: "Bot", scope: "trade" as const, prefix: "qbk_9f8e7d6c", createdAt: made, lastUsedAt: null },
  ];
  const [laptop, bot] = apiKeyRows(keys, "broker", () => 60);
  assert.deepEqual(laptop, { id: "a1", name: "Laptop CLI", prefix: "qbk_1a2b3c4d…", scope: "Read", created: "Created 2027-01-15 09:00", lastUsed: "Last used 2027-01-15 10:30" });
  assert.deepEqual(bot, { id: "b2", name: "Bot", prefix: "qbk_9f8e7d6c…", scope: "Read and trade", created: "Created 2027-01-15 09:00", lastUsed: "Never used" });
  assert.equal(apiKeyRows(keys, "utc", () => 60)[0].created, "Created 2027-01-15 08:00", "UTC when times are shown in UTC; else this computer's time");
});

test("Revoke asks first: the key stops working at once", () => {
  assert.deepEqual(revokeApiKey({ name: "Laptop CLI" }), {
    title: "Revoke the API key “Laptop CLI”?",
    body: "Anything using it is refused from now on. This cannot be undone: make a new key to give access again.",
    confirm: "Revoke key",
  });
});
