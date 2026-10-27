// REST v1 indicators over HTTP (approved seam): enabled packages by exact ID, and a package's values over a market's
// candles, read from the cache the charts use (M4 parity), paged as candles are. Real server and database in temp
// folders, a fake EA, HST fixtures, fixture packages and a fake clock.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { marketId } from "../src/server/identity/index.js";
import { bars, writeHst, type FixtureBar } from "./hst-fixtures.js";
import { brokerIso, DEMO, HOUR, startRest, tempFolder, TERMINAL, utcIso, type Json } from "./rest-fixtures.js";

/** Broker seconds of 15 January 2027 10:00. */
const TEN = Date.UTC(2027, 0, 15, 10) / 1000;
/** 6,000 H1 bars ending at 09:00 today (broker time), before the app's own live candle at 10:00. */
const HST: FixtureBar[] = bars(TEN - 6000 * HOUR, HOUR, 6000);
const EURUSD = marketId(DEMO, "EURUSD");

/** A package that echoes the close, and throws while the close is above 2. */
const FUSSY = {
  "manifest.json": JSON.stringify({
    apiVersion: 1,
    id: "test.fussy",
    version: "1.0.0",
    name: "Fussy",
    description: "Echoes the close; throws above 2.",
    license: "MIT",
    entry: "calculate.js",
    inputs: [{ id: "source", label: "Close", kind: "numeric", alignment: "exact", field: "close", history: { bars: 1 } }],
    parameters: [],
    outputs: [{ id: "close", label: "Close", kind: "numeric", render: "line", placement: "pane", color: "#ffffff", unit: { input: "source" } }],
  }),
  "calculate.js": `exports.calculate = function ({ inputs, timeline }) {
    const points = inputs.source.points;
    if (points.length && points[points.length - 1].value > 2) throw new Error("too high");
    return { outputs: { close: timeline.map((time, i) => ({ time, value: points[i].value })) } };
  };`,
  "README.md": "Fussy",
  LICENSE: "MIT",
};

/** A server with the H1 file `HST`, and an M1 file of `m1` bars beside it when given. */
async function start(t: TestContext, m1?: FixtureBar[]) {
  const folder = await tempFolder(t, "rest-ind");
  const packages = join(folder, "packages");
  await mkdir(join(packages, "fussy"), { recursive: true });
  for (const [name, text] of Object.entries(FUSSY)) await writeFile(join(packages, "fussy", name), text);
  const dataFolder = join(folder, "data");
  await writeHst(dataFolder, DEMO, { version: 401, symbol: "EURUSD", minutes: 60, digits: 5, bars: HST });
  if (m1) await writeHst(dataFolder, DEMO, { version: 400, symbol: "EURUSD", minutes: 1, digits: 5, bars: m1 });
  const app = await startRest(t, join(folder, "db"), { dataFolders: { [TERMINAL]: dataFolder }, overrides: { extraIndicatorPackages: packages } });
  const connect = async (options: { symbol?: string } = {}) => {
    const ea = await app.connect(options);
    let seq = 0;
    /** A live quote at broker seconds `quoteTime`. */
    const send = (quoteTime: number, bid: number) => ea.request(ea.tickWire([{ seq: ++seq, bid, ask: bid + 0.0002, quoteTime, sampledTime: quoteTime }]));
    return { ea, send };
  };
  /** The chart endpoint's answer, as the app window asks for it. */
  const chart = async (query: Record<string, string | number>) => {
    const search = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
    const res = await fetch(`${app.origin}/api/indicators/values?${search}`, { headers: { cookie: app.cookie } });
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json()) as Json;
  };
  return { ...app, connect, chart };
}

test("indicators lists the enabled packages by exact ID with their parameters and outputs; a disabled one leaves it", { timeout: 20000 }, async (t) => {
  const app = await start(t);
  const { data, meta } = await app.read("/api/v1/indicators");
  assert.deepEqual(data.map((i: Json) => i.id), ["quotebridge.ac", "quotebridge.alligator", "quotebridge.ao", "quotebridge.bollinger", "quotebridge.eo", "quotebridge.ma", "quotebridge.macd", "quotebridge.rsi", "test.fussy"]);
  assert.deepEqual(meta, { count: 9, limit: 100, nextCursor: null });
  const macd = data.find((i: Json) => i.id === "quotebridge.macd");
  assert.deepEqual(macd, {
    id: "quotebridge.macd",
    version: "1.0.0",
    name: "MACD",
    description: macd.description,
    placement: "pane",
    closedBarsOnly: false,
    parameters: [
      { id: "fast", label: "Fast EMA", type: "integer", default: 12, min: 1, max: 500, lessThan: "slow" },
      { id: "slow", label: "Slow EMA", type: "integer", default: 26, min: 1, max: 500 },
      { id: "signal", label: "Signal SMA", type: "integer", default: 9, min: 1, max: 500 },
    ],
    outputs: [
      { id: "macd", label: "MACD", render: "histogram", styles: null },
      { id: "signal", label: "Signal", render: "line", styles: null },
    ],
    hash: macd.hash,
  });
  assert.match(macd.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(data.find((i: Json) => i.id === "quotebridge.ao").outputs, [{ id: "ao", label: "AO", render: "histogram", styles: ["rising", "falling"] }]);
  assert.deepEqual((await app.read("/api/v1/indicators/quotebridge.macd")).data, macd);
  for (const id of ["macd", "QUOTEBRIDGE.MACD"]) assert.equal((await app.read(`/api/v1/indicators/${id}`, {}, 404)).error.code, "unknown-indicator", `${id}: exact IDs only`);

  await app.connect();
  await app.post("/api/indicators/packages/enabled", { id: "quotebridge.macd", enabled: false });
  assert.ok(!(await app.read("/api/v1/indicators")).data.some((i: Json) => i.id === "quotebridge.macd"));
  assert.equal((await app.read("/api/v1/indicators/quotebridge.macd", {}, 404)).error.code, "unknown-indicator");
  assert.equal((await app.read(`/api/v1/markets/${EURUSD}/indicators/quotebridge.macd`, { timeframe: "H1" }, 404)).error.code, "unknown-indicator");
});

/** The mean of the 20 closes ending at `closes[i]`. */
const mean20 = (closes: readonly number[], i: number) => closes.slice(i - 19, i + 1).reduce((a, b) => a + b, 0) / 20;

test("values are the chart cache's over the market's candles, warmed up before them, the forming bar incomplete", { timeout: 20000 }, async (t) => {
  const app = await start(t);
  const { ea, send } = await app.connect();
  await send(TEN + 60, 1.2);

  const answer = await app.read(`/api/v1/markets/${EURUSD}/indicators/quotebridge.ma`, { timeframe: "H1", limit: 30, "p.period": 20 });
  assert.deepEqual(answer.meta, {
    marketId: EURUSD,
    indicatorId: "quotebridge.ma",
    version: "1.0.0",
    parameters: { period: 20, type: "simple" },
    outputs: [{ id: "ma", label: "MA" }],
    timeframe: "H1",
    source: { terminalId: TERMINAL, feedId: ea.feedKey() },
    count: 30,
    limit: 30,
    // The 30 bars and the 519 of warm-up (the period plus 499) before them.
    barsUsed: 549,
    next: { to: utcIso(HST.at(-29)!.time - 1) },
  });
  const closes = [...HST.map((b) => b.close), 1.2];
  const times = [...HST.slice(-29).map((b) => b.time), TEN];
  assert.deepEqual(answer.data.map((row: Json) => ({ ...row, values: { ma: Number(row.values.ma).toFixed(10) } })), times.map((time, i) => ({
    time: utcIso(time),
    brokerTime: brokerIso(time),
    complete: i < 29,
    values: { ma: mean20(closes, closes.length - 30 + i).toFixed(10) },
  })));
  for (const row of answer.data) assert.match(row.values.ma, /^-?\d+(\.\d+)?$/, "a plain decimal string");

  // The chart's values for the same key: the very same numbers.
  const chart = await app.chart({ feed: ea.feedKey(), period: "H1", package: "quotebridge.ma", "p.period": 20, "p.type": "simple", limit: 30 });
  assert.deepEqual(answer.data.map((row: Json) => Number(row.values.ma)), chart.outputs.ma.map((p: Json) => p.value));
});

test("values up to `to` are the same as the page without it, where the M1 file continues the H1 file", { timeout: 20000 }, async (t) => {
  // M1 from 05:01 to the 10:00 bar: its rolled-up 09:00 and 10:00 buckets continue the H1 file.
  const app = await start(t, bars(TEN - 5 * HOUR + 60, 60, 300, 1.2));
  const { send } = await app.connect();
  await send(TEN + 60, 1.25);
  const path = `/api/v1/markets/${EURUSD}/indicators/quotebridge.ma`;

  // Up to each bar first, while the cache holds no newer page to take its bars from.
  const cut = [];
  for (let h = 5; h >= 0; h--) cut.push(...(await app.read(path, { timeframe: "H1", to: utcIso(TEN - h * HOUR), limit: 1, "p.period": 2 })).data);
  const latest = (await app.read(path, { timeframe: "H1", limit: 6, "p.period": 2 })).data;
  assert.equal(latest.at(-1).brokerTime, brokerIso(TEN));
  assert.deepEqual(cut, latest);
});

test("values: 900 by default and 5000 at most with warm-up on top; parameters and timeframes are checked", { timeout: 30000 }, async (t) => {
  const app = await start(t);
  await app.connect();
  const path = `/api/v1/markets/${EURUSD}/indicators/quotebridge.ma`;
  const standard = await app.read(path, { timeframe: "H1" });
  assert.deepEqual([standard.data.length, standard.meta.limit], [900, 900]);
  assert.equal((await app.read(path, { timeframe: "H1", limit: 5000 })).data.length, 5000);
  for (const limit of [0, 5001]) assert.equal((await app.read(path, { timeframe: "H1", limit }, 400)).error.code, "invalid-parameter");
  assert.match((await app.read(path, { timeframe: "H1", "p.period": 0 }, 400)).error.message, /Period must be a whole number from 1 to 500/);
  assert.equal((await app.read(path, { timeframe: "H1", "p.nothing": 1 }, 400)).error.code, "invalid-indicator-parameter");
  assert.equal((await app.read(path, { timeframe: "1H" }, 400)).error.code, "invalid-timeframe");
  assert.equal((await app.read(path, { timeframe: "H1", count: 5 }, 400)).error.code, "unknown-parameter");
});

test("a closed-bars-only package has no row for the forming bar; a palette output has its style; failures answer 422", { timeout: 20000 }, async (t) => {
  const app = await start(t);
  const { send } = await app.connect();
  await send(TEN + 60, 1.2);
  const eo = await app.read(`/api/v1/markets/${EURUSD}/indicators/quotebridge.eo`, { timeframe: "H1", limit: 10 });
  assert.equal(eo.data.length, 9);
  assert.ok(eo.data.every((row: Json) => row.complete));
  const ao = await app.read(`/api/v1/markets/${EURUSD}/indicators/quotebridge.ao`, { timeframe: "H1", limit: 10 });
  assert.ok(ao.data.every((row: Json) => ["rising", "falling"].includes(row.styles.ao)));

  await send(TEN + 120, 2.5);
  const failed = await app.read(`/api/v1/markets/${EURUSD}/indicators/test.fussy`, { timeframe: "H1", limit: 5 }, 422);
  assert.deepEqual([failed.error.code, failed.error.details], ["indicator-failed", { reason: "The calculation threw: too high" }]);
});

test("values need a feed of the market: a market known only from history answers 503", { timeout: 20000 }, async (t) => {
  const app = await start(t);
  await app.connect({ symbol: "GBPUSD" });
  assert.equal((await app.read(`/api/v1/markets/${EURUSD}/indicators/quotebridge.ma`, { timeframe: "H1" }, 503)).error.code, "feed-required");
});
