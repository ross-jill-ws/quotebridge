// The shell's launch environment: dev overrides for the data folder and ports, and a hidden start at login.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appDataFolder, devRunControls, effectivePorts, readDevOverrides } from "../src/main/shell/index.js";

const SETTINGS_PORTS = { ea: 5555, http: 5580 };

test("without overrides the app uses QuoteBridge in the per-user app data folder and the ports from settings", () => {
  const overrides = readDevOverrides({});
  assert.equal(appDataFolder(String.raw`C:\Users\me\AppData\Roaming`, overrides), String.raw`C:\Users\me\AppData\Roaming\QuoteBridge`);
  assert.deepEqual(effectivePorts(SETTINGS_PORTS, overrides), { ea: 5555, http: 5580 });
});

test("a dev run can point the data folder and ports elsewhere, without changing settings", () => {
  const overrides = readDevOverrides({ QUOTEBRIDGE_DATA_FOLDER: String.raw`D:\dev\qb`, QUOTEBRIDGE_EA_PORT: "6555", QUOTEBRIDGE_HTTP_PORT: "6580" });
  assert.equal(appDataFolder(String.raw`C:\Users\me\AppData\Roaming`, overrides), String.raw`D:\dev\qb`);
  assert.deepEqual(effectivePorts(SETTINGS_PORTS, overrides), { ea: 6555, http: 6580 });
  assert.deepEqual(effectivePorts(SETTINGS_PORTS, readDevOverrides({ QUOTEBRIDGE_HTTP_PORT: "6580" })), { ea: 5555, http: 6580 });
});

test("an invalid override stops the launch with a clear message instead of falling back to the real ports", () => {
  assert.throws(() => readDevOverrides({ QUOTEBRIDGE_EA_PORT: "abc" }), /QUOTEBRIDGE_EA_PORT/);
  assert.throws(() => readDevOverrides({ QUOTEBRIDGE_HTTP_PORT: "70000" }), /QUOTEBRIDGE_HTTP_PORT/);
  assert.throws(() => readDevOverrides({ QUOTEBRIDGE_DATA_FOLDER: "relative\folder" }), /QUOTEBRIDGE_DATA_FOLDER/);
  assert.throws(() => effectivePorts(SETTINGS_PORTS, readDevOverrides({ QUOTEBRIDGE_EA_PORT: "5580" })), /differ/);
});

test("npm run dev can swap the server entry point and drive the app from a local control stream, but never in a packaged app", () => {
  const env = { QUOTEBRIDGE_DEV_SERVER_ENTRY: String.raw`E:\repo\.dev-build\server-entry.mjs`, QUOTEBRIDGE_DEV_CONTROL: "http://127.0.0.1:6681/control" };
  assert.deepEqual(devRunControls(false, env), { serverEntry: String.raw`E:\repo\.dev-build\server-entry.mjs`, controlUrl: "http://127.0.0.1:6681/control" });
  assert.deepEqual(devRunControls(true, env), { serverEntry: undefined, controlUrl: undefined });
  assert.deepEqual(devRunControls(false, {}), { serverEntry: undefined, controlUrl: undefined });
  assert.equal(devRunControls(false, { QUOTEBRIDGE_DEV_CONTROL: "http://example.com/control" }).controlUrl, undefined, "only this machine");
});
