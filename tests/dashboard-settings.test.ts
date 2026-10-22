// The Settings view's model: reading a typed port, what a port change will do, and the note when a
// development run's port overrides win over the saved ports; the theme the page takes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePort, portChange, portsNote } from "../src/dashboard/settings/settings-model.js";
import { themeAttribute } from "../src/dashboard/theme.js";
import type { SettingsView } from "../src/server/settings/index.js";

const VIEW: SettingsView = { startWithWindows: true, openWindowAtStartup: false, theme: "system", flashPrices: true, ports: { ea: 5555, http: 5580 }, portsInUse: { ea: 5555, http: 5580 } };

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
