// The Settings view's model: reading a typed port, what a port change will do, and the note when a
// development run's port overrides win over the saved ports; the theme the page takes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { apiKeyRows, deleteRecording, factsAccount, orderDefaultsChange, orderDefaultsFacts, parsePort, portChange, portsNote, recordingRows, removeOrderDefaults, revokeApiKey, tradingChange } from "../src/dashboard/settings/settings-model.js";
import { themeAttribute } from "../src/dashboard/theme.js";
import type { SettingsView } from "../src/server/settings/index.js";

const VIEW: SettingsView = { trading: { enabled: false, maxLots: "1.0", slippage: 20 }, startWithWindows: true, openWindowAtStartup: false, theme: "system", flashPrices: true, chartColours: "default", timeShown: "broker", orderDefaults: [], ports: { ea: 5555, http: 5580 }, portsInUse: { ea: 5555, http: 5580 } };

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
    { id: "a1", name: "Laptop CLI", scope: "readonly" as const, prefix: "qbk_1a2b3c4d", createdAt: made, lastUsedAt: made + 90 * 60_000 },
    { id: "b2", name: "Bot", scope: "trader" as const, prefix: "qbk_9f8e7d6c", createdAt: made, lastUsedAt: null },
  ];
  const [laptop, bot] = apiKeyRows(keys, "broker", () => 60);
  assert.deepEqual(laptop, { id: "a1", name: "Laptop CLI", prefix: "qbk_1a2b3c4d…", scope: "Readonly", created: "Created 2027-01-15 09:00", lastUsed: "Last used 2027-01-15 10:30" });
  assert.deepEqual(bot, { id: "b2", name: "Bot", prefix: "qbk_9f8e7d6c…", scope: "Trader", created: "Created 2027-01-15 09:00", lastUsed: "Never used" });
  assert.equal(apiKeyRows(keys, "utc", () => 60)[0].created, "Created 2027-01-15 08:00", "UTC when times are shown in UTC; else this computer's time");
});

test("Revoke asks first: the key stops working at once", () => {
  assert.deepEqual(revokeApiKey({ name: "Laptop CLI" }), {
    title: "Revoke the API key “Laptop CLI”?",
    body: "Anything using it is refused from now on. This cannot be undone: make a new key to give access again.",
    confirm: "Revoke key",
  });
});

test("the app's lot cap is a positive decimal and slippage whole points; either change keeps the rest", () => {
  const trading = { enabled: true, maxLots: "1.0", slippage: 20 };
  assert.deepEqual(tradingChange(trading, "maxLots", " 0.5 "), { trading: { enabled: true, maxLots: "0.5", slippage: 20 } });
  for (const text of ["0", "-1", "1e2", "abc", ""]) assert.match((tradingChange(trading, "maxLots", text) as { error: string }).error, /positive/, text);
  assert.deepEqual(tradingChange(trading, "slippage", "0"), { trading: { enabled: true, maxLots: "1.0", slippage: 0 } });
  for (const text of ["1.5", "-2", "x", "1000001"]) assert.match((tradingChange(trading, "slippage", text) as { error: string }).error, /whole/, text);
});

const BTC = { brokerServer: "EasyForex-Demo", symbol: "BTCUSD" };

test("a market's order defaults are saved as typed: each optional, at least one set, positive numbers only", () => {
  assert.deepEqual(orderDefaultsChange([], BTC, { lots: " 0.05 ", stopLossPoints: "50000", takeProfitPoints: "" }), {
    orderDefaults: [{ ...BTC, lots: "0.05", stopLossPoints: "50000", takeProfitPoints: null }],
  });
  assert.deepEqual(orderDefaultsChange([], BTC, { lots: "", stopLossPoints: "", takeProfitPoints: "" }), { error: "Set at least one of lots, stop loss or take profit, or remove the market." });
  for (const bad of ["0", "-1", "1e3", "abc"]) {
    assert.ok("error" in orderDefaultsChange([], BTC, { lots: bad, stopLossPoints: "", takeProfitPoints: "" }), bad);
    assert.ok("error" in orderDefaultsChange([], BTC, { lots: "", stopLossPoints: bad, takeProfitPoints: "" }), bad);
  }
});

test("saving a market again replaces its row in place; removing it keeps the others", () => {
  const eurusd = { brokerServer: "EasyForex-Demo", symbol: "EURUSD", lots: "0.1", stopLossPoints: null, takeProfitPoints: null };
  const both = [eurusd, { ...BTC, lots: "0.05", stopLossPoints: null, takeProfitPoints: null }];
  const changed = orderDefaultsChange(both, eurusd, { lots: "0.2", stopLossPoints: "", takeProfitPoints: "300" });
  assert.deepEqual("orderDefaults" in changed && changed.orderDefaults.map((d) => [d.symbol, d.lots, d.takeProfitPoints]), [["EURUSD", "0.2", "300"], ["BTCUSD", "0.05", null]]);
  assert.deepEqual(removeOrderDefaults(both, BTC), [eurusd]);
});

const EURUSD_CONDITIONS = { bid: "1.1", ask: "1.10002", digits: 5, point: "0.00001", tickSize: "0.00001", tickValue: "1", minLots: "0.01", maxLots: "100", lotStep: "0.01", stopLevel: 10 };
const BTC_CONDITIONS = { bid: "67000", ask: "67015", digits: 2, point: "0.01", tickSize: "0.01", tickValue: "0.01", minLots: "0.01", maxLots: "10", lotStep: "0.01", stopLevel: 0 };

test("the order defaults form shows what the market defines: a point's price and money, the lot limits, the stop level and the spread", () => {
  assert.deepEqual(orderDefaultsFacts(EURUSD_CONDITIONS, "USD", "1.0", { lots: "", stopLossPoints: "", takeProfitPoints: "" }).facts, [
    "1 point is 0.00001 in price, about 1 USD a lot.",
    "Lots: 0.01 to 100, in steps of 0.01. The app's lot cap is 1.0.",
    "Stops: at least 10 points from the closing price (Bid for a buy, Ask for a sell), no maximum.",
    "Spread now: 2 points. A market order's stop loss also spans it.",
  ]);
  assert.deepEqual(orderDefaultsFacts(BTC_CONDITIONS, null, "1.0", { lots: "", stopLossPoints: "", takeProfitPoints: "" }).facts, [
    "1 point is 0.01 in price.",
    "Lots: 0.01 to 10, in steps of 0.01. The app's lot cap is 1.0.",
    "Stops: the broker sets no minimum distance, and there is no maximum.",
    "Spread now: 1,500 points. A market order's stop loss also spans it.",
  ]);
});

test("a market whose terminal reports no tick value (0) shows no money, not about 0 a lot", () => {
  // Seen on a real CMC terminal: CORN's tick value read 0 until the terminal had the rate to convert it.
  const noTickValue = { ...BTC_CONDITIONS, tickValue: "0" };
  const { facts, notes } = orderDefaultsFacts(noTickValue, "AUD", "1.0", { lots: "0.05", stopLossPoints: "200", takeProfitPoints: "" });
  assert.equal(facts[0], "1 point is 0.01 in price.");
  assert.equal(notes.stopLossPoints?.meaning, "2 in price.");
});

test("each typed stop distance reads as a price move and about its money at the default lots, or one lot", () => {
  const notes = orderDefaultsFacts(EURUSD_CONDITIONS, "USD", "1.0", { lots: "0.05", stopLossPoints: "200", takeProfitPoints: "400" }).notes;
  assert.deepEqual(notes, {
    stopLossPoints: { meaning: "0.002 in price, about 10 USD at 0.05 lots." },
    takeProfitPoints: { meaning: "0.004 in price, about 20 USD at 0.05 lots." },
  });
  assert.deepEqual(orderDefaultsFacts(BTC_CONDITIONS, "USD", "1.0", { lots: "", stopLossPoints: "2000", takeProfitPoints: "" }).notes, { stopLossPoints: { meaning: "20 in price, about 20 USD a lot." } });
});

test("a typed value Preview would refuse is noted: lots off the market's limits, step or the lot cap, a stop inside the stop level", () => {
  const lots = (text: string) => orderDefaultsFacts(BTC_CONDITIONS, "USD", "1.0", { lots: text, stopLossPoints: "", takeProfitPoints: "" }).notes.lots?.refused;
  assert.equal(lots("0.005"), "Below the market's minimum of 0.01 lots: Preview refuses it.");
  assert.equal(lots("20"), "Above the market's maximum of 10 lots: Preview refuses it.");
  assert.equal(lots("2"), "Above the app's lot cap of 1.0: Preview refuses it.");
  assert.equal(lots("0.015"), "Not a whole number of lot steps of 0.01: Preview refuses it.");
  assert.equal(lots("0.5"), undefined);
});

test("a stop too close says why, after what it means: a market order's stop loss needs the stop level plus the spread", () => {
  const stops = (c: typeof EURUSD_CONDITIONS, stopLossPoints: string, takeProfitPoints: string) => orderDefaultsFacts(c, "USD", "1.0", { lots: "", stopLossPoints, takeProfitPoints }).notes;
  assert.deepEqual(stops(EURUSD_CONDITIONS, "11", "9"), {
    stopLossPoints: { meaning: "0.00011 in price, about 11 USD a lot.", refused: "Too close: a market order's stop loss needs at least 12 points now (the broker's minimum of 10 plus the spread of 2), so Preview refuses it." },
    takeProfitPoints: { meaning: "0.00009 in price, about 9 USD a lot.", refused: "Under the broker's minimum of 10 points, so Preview refuses it for a pending order." },
  });
  assert.equal(stops(EURUSD_CONDITIONS, "", "7").takeProfitPoints?.refused, "Too close: the broker's minimum is 10 points and the spread now 2, so Preview refuses it.");
  assert.equal(stops(EURUSD_CONDITIONS, "12", "10").stopLossPoints?.refused, undefined);
  assert.equal(stops(EURUSD_CONDITIONS, "12", "10").takeProfitPoints?.refused, undefined);
  assert.deepEqual(stops(BTC_CONDITIONS, "1500", "").stopLossPoints, {
    meaning: "15 in price, about 15 USD a lot.",
    refused: "Too close: a market order's stop loss needs more than the spread of 1,500 points now, so Preview refuses it.",
  });
});

test("the market's figures are read through a connected account on its broker server, a demo account first", () => {
  const account = (id: string, brokerServer: string, connected: boolean, demo: boolean | null) => ({ id, brokerServer, connected, demo });
  const accounts = [account("a", "Other", true, true), account("b", "EasyForex-Demo", false, true), account("c", "EasyForex-Demo", true, false), account("d", "EasyForex-Demo", true, true)];
  assert.equal(factsAccount(accounts, BTC)?.id, "d");
  assert.equal(factsAccount(accounts.slice(0, 3), BTC)?.id, "c");
  assert.equal(factsAccount(accounts.slice(0, 2), BTC), undefined);
});
