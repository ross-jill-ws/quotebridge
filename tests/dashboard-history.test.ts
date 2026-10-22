// The History page's view model (pure): a group per market with its terminals and recording state, a row per period
// with what HST holds and what the app has saved on the chosen clock, download links, and the search.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { HistoryMarket } from "../src/server/history/index.js";
import { historyGroups } from "../src/dashboard/history/history-model.js";

const HOUR = 3600;
const RULE = { winterOffsetMinutes: 120, dst: "us" as const };
/** 15 January 2027 08:00 UTC: 10:00 on the GMT+2 broker. */
const EIGHT = Date.UTC(2027, 0, 15, 8) / 1000;

const EURUSD: HistoryMarket = {
  market: '["EasyForex-Demo","EURUSD"]',
  brokerServer: "EasyForex-Demo",
  symbol: "EURUSD",
  digits: 5,
  terminals: [
    { terminalId: "mt4-a", name: "EasyForex MT4" },
    { terminalId: "mt4-b", name: "EasyForex MT4 (2)" },
  ],
  recording: true,
  clockRule: RULE,
  periods: [
    { period: "H1", hst: { bars: 1250, first: EIGHT - 1249 * HOUR, last: EIGHT }, saved: null },
    { period: "D1", hst: { bars: 1, first: EIGHT - 10 * HOUR, last: EIGHT - 10 * HOUR }, saved: null },
  ],
};

const GBPUSD: HistoryMarket = {
  market: '["ICMarkets-Live07","GBPUSD"]',
  brokerServer: "ICMarkets-Live07",
  symbol: "GBPUSD",
  digits: 5,
  terminals: [],
  recording: false,
  clockRule: null,
  periods: [],
};

test("a group per market: symbol, broker server and terminals, recording state", () => {
  const [eurusd, gbpusd] = historyGroups([EURUSD, GBPUSD], { shown: "broker", query: "", localOffsetMinutes: () => 0 });
  assert.equal(eurusd.symbol, "EURUSD");
  assert.equal(eurusd.where, "EasyForex-Demo · EasyForex MT4, EasyForex MT4 (2)");
  assert.equal(eurusd.state, "Recording");
  assert.equal(gbpusd.where, "ICMarkets-Live07 · no terminal on this server");
  assert.equal(gbpusd.state, "Not recorded");
  assert.equal(gbpusd.empty, "No history on this computer yet.");
  assert.equal(eurusd.empty, null);
  assert.equal(eurusd.id, "history-EasyForex-Demo-EURUSD");
});

test("a row per period: bar counts and ranges on the chosen clock, dates only from D1 up, download links", () => {
  const [eurusd] = historyGroups([EURUSD], { shown: "broker", query: "", localOffsetMinutes: () => 0 });
  const [h1, d1] = eurusd.rows;
  assert.equal(h1.period, "H1");
  assert.deepEqual(h1.hst, { bars: "1,250 bars", range: "2026-11-24 09:00 to 2027-01-15 10:00" });
  assert.equal(h1.saved, null);
  assert.deepEqual(d1.hst, { bars: "1 bar", range: "2027-01-15" });
  assert.equal(h1.csvUrl, `/api/history/csv?market=${encodeURIComponent(EURUSD.market)}&period=H1`);
  assert.equal(h1.hstUrl, `/api/history/hst?market=${encodeURIComponent(EURUSD.market)}&period=H1`);

  const utc = historyGroups([EURUSD], { shown: "utc", query: "", localOffsetMinutes: () => 0 })[0].rows[0];
  assert.equal(utc.hst?.range, "2026-11-24 07:00 to 2027-01-15 08:00");
  const local = historyGroups([EURUSD], { shown: "local", query: "", localOffsetMinutes: () => 660 })[0].rows[0];
  assert.equal(local.hst?.range, "2026-11-24 18:00 to 2027-01-15 19:00");
});

test("a row with saved bars only has them, and no HST", () => {
  const saved: HistoryMarket = { ...GBPUSD, periods: [{ period: "M1", hst: null, saved: { bars: 2, first: EIGHT - 60, last: EIGHT } }] };
  const [row] = historyGroups([saved], { shown: "utc", query: "", localOffsetMinutes: () => 0 })[0].rows;
  assert.equal(row.hst, null);
  assert.deepEqual(row.saved, { bars: "2 bars", range: "2027-01-15 07:59 to 2027-01-15 08:00" });
});

test("the search keeps markets whose symbol or broker server contains it, ignoring case", () => {
  const symbols = (query: string) => historyGroups([EURUSD, GBPUSD], { shown: "broker", query, localOffsetMinutes: () => 0 }).map((g) => g.symbol);
  assert.deepEqual(symbols("usd"), ["EURUSD", "GBPUSD"]);
  assert.deepEqual(symbols(" gbp "), ["GBPUSD"]);
  assert.deepEqual(symbols("icmarkets"), ["GBPUSD"]);
  assert.deepEqual(symbols("xau"), []);
});
