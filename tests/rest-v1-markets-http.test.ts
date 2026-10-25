// REST v1 market resources over HTTP (approved seam): exact market IDs, `{ data, meta }` envelopes, structured errors,
// decimal strings and UTC ISO times beside broker time, cursor and time paging, and no legacy routes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { marketId } from "../src/server/identity/index.js";
import { bars, writeHst } from "./hst-fixtures.js";
import { brokerIso, DAY, DEMO, HOUR, MIDNIGHT, NOW, OTHER_TERMINAL, REAL, startRest, tempFolder, TERMINAL, utcIso, type Json } from "./rest-fixtures.js";

const EURUSD = marketId(DEMO, "EURUSD");

test("markets lists every known market with its exact ID, identity fields, label and sources", { timeout: 20000 }, async (t) => {
  const data = await tempFolder(t, "rest-data");
  await writeHst(data, DEMO, { version: 401, symbol: "GBPUSD", minutes: 60, digits: 5, bars: bars(MIDNIGHT - 10 * HOUR, HOUR, 10) });
  const app = await startRest(t, await tempFolder(t, "rest-db"), { dataFolders: { [TERMINAL]: data } });
  const ea = await app.connect();
  await app.quote(ea, [{ seq: 1, bid: 1.1, ask: 1.1002, quoteTime: MIDNIGHT + 10 * HOUR }]);
  await app.connect({ terminal: OTHER_TERMINAL, broker: REAL, symbol: "EURUSD" });

  const { data: markets, meta } = await app.read("/api/v1/markets");
  assert.deepEqual(markets.map((m: Json) => [m.brokerServer, m.symbol]), [[DEMO, "EURUSD"], [REAL, "EURUSD"], [DEMO, "GBPUSD"]]);
  const eurusd = markets[0];
  assert.deepEqual(eurusd, {
    id: EURUSD,
    brokerServer: DEMO,
    symbol: "EURUSD",
    label: `EURUSD · ${DEMO}`,
    digits: 5,
    connected: true,
    recording: false,
    sources: [{ terminalId: TERMINAL, feedId: ea.feedKey(), connected: true }],
  });
  assert.equal(markets[2].connected, false, "known from its HST file only");
  assert.deepEqual(markets[2].sources, []);
  assert.deepEqual(meta, { count: 3, limit: 100, nextCursor: null });

  assert.deepEqual(await app.read(`/api/v1/markets/${EURUSD}`), { data: eurusd, meta: {} });
  const unknown = await app.read(`/api/v1/markets/${marketId(DEMO, "eurusd")}`, {}, 404);
  assert.equal(unknown.error.code, "unknown-market");
  assert.equal(typeof unknown.error.message, "string");
});

test("quote picks the exact market's best connected source with provenance; it never crosses markets", { timeout: 20000 }, async (t) => {
  const app = await startRest(t, await tempFolder(t, "rest-db"));
  const a = await app.connect();
  const b = await app.connect({ terminal: OTHER_TERMINAL });
  const real = await app.connect({ terminal: "mt4-cccccccccccc", broker: REAL });
  await app.quote(a, [{ seq: 1, bid: 1.1, ask: 1.10015, quoteTime: MIDNIGHT + 10 * HOUR - 1 }]);
  await app.quote(b, [{ seq: 1, bid: 1.1001, ask: 1.1003, quoteTime: MIDNIGHT + 10 * HOUR }]);
  await app.quote(real, [{ seq: 1, bid: 1.3, ask: 1.3002, quoteTime: MIDNIGHT + 10 * HOUR + 1 }]);

  assert.deepEqual(await app.read(`/api/v1/markets/${EURUSD}/quote`), {
    data: {
      marketId: EURUSD,
      brokerServer: DEMO,
      symbol: "EURUSD",
      digits: 5,
      bid: "1.10010",
      ask: "1.10030",
      spread: "20.0",
      time: utcIso(MIDNIGHT + 10 * HOUR),
      brokerTime: brokerIso(MIDNIGHT + 10 * HOUR),
      state: "connected",
      stale: false,
      quoteAgeMs: 0,
      sourceSilenceMs: 0,
      sourceSilent: false,
      provenance: { terminalId: OTHER_TERMINAL, feedId: b.feedKey(), receivedAt: new Date(NOW).toISOString() },
    },
    meta: {},
  });
  // The terminal goes quiet: its quote is last-known, never presented as live.
  app.clock.advance(8000);
  const quiet = (await app.read(`/api/v1/markets/${EURUSD}/quote`)).data;
  assert.deepEqual([quiet.state, quiet.stale, quiet.sourceSilent, quiet.sourceSilenceMs], ["last-known", true, true, 8000]);
});

test("candles join HST and the live candles oldest first, with UTC and broker times and the forming bar incomplete", { timeout: 20000 }, async (t) => {
  const data = await tempFolder(t, "rest-data");
  const h1 = bars(MIDNIGHT - 10 * HOUR, HOUR, 10);
  await writeHst(data, DEMO, { version: 401, symbol: "EURUSD", minutes: 60, digits: 5, bars: h1 });
  const app = await startRest(t, await tempFolder(t, "rest-db"), { dataFolders: { [TERMINAL]: data } });
  const ea = await app.connect();
  await app.quote(ea, [
    { seq: 1, bid: 1.2, ask: 1.2002, quoteTime: MIDNIGHT + 10 * HOUR },
    { seq: 2, bid: 1.21, ask: 1.2102, quoteTime: MIDNIGHT + 10 * HOUR + 60 },
  ]);
  const bar = (b: { time: number; open: number; high: number; low: number; close: number }, complete = true) => ({
    time: utcIso(b.time), brokerTime: brokerIso(b.time), open: b.open.toFixed(5), high: b.high.toFixed(5), low: b.low.toFixed(5), close: b.close.toFixed(5), complete,
  });

  const page = await app.read(`/api/v1/markets/${EURUSD}/candles`, { timeframe: "H1", limit: 3 });
  assert.deepEqual(page, {
    data: [bar(h1[8]), bar(h1[9]), bar({ time: MIDNIGHT + 10 * HOUR, open: 1.2, high: 1.21, low: 1.2, close: 1.21 }, false)],
    meta: { marketId: EURUSD, timeframe: "H1", digits: 5, source: { terminalId: TERMINAL, feedId: ea.feedKey() }, count: 3, limit: 3, next: { to: utcIso(h1[8].time - 1) } },
  });
  const all = await app.read(`/api/v1/markets/${EURUSD}/candles`, { timeframe: "H1" });
  assert.deepEqual([all.data.length, all.meta.next], [11, null], "all there are");
  for (const timeframe of ["1H", "60", "h1", ""]) {
    assert.equal((await app.read(`/api/v1/markets/${EURUSD}/candles`, { timeframe }, 400)).error.code, "invalid-timeframe", timeframe);
  }
  assert.equal((await app.cli(`/api/v1/markets/${EURUSD}/candles`)).status, 400, "timeframe is required");
  assert.equal((await app.read(`/api/v1/markets/${EURUSD}/candles`, { timeframe: "H1", source: "history" }, 400)).error.code, "unknown-parameter", "no data-source selector");

  // A feed with neither history nor a quote yet has no candles to give.
  await app.connect({ symbol: "GBPUSD" });
  assert.equal((await app.read(`/api/v1/markets/${marketId(DEMO, "GBPUSD")}/candles`, { timeframe: "H1" }, 404)).error.code, "no-candles");
});

test("candles: 900 by default and 5000 at most; from/to bound the newest bars and next pages back without gaps", { timeout: 20000 }, async (t) => {
  const data = await tempFolder(t, "rest-data");
  const m1 = bars(MIDNIGHT - 6000 * 60, 60, 6000);
  await writeHst(data, DEMO, { version: 401, symbol: "EURUSD", minutes: 1, digits: 5, bars: m1 });
  const app = await startRest(t, await tempFolder(t, "rest-db"), { dataFolders: { [TERMINAL]: data } });
  // Its terminal charts another symbol: EURUSD is known from its HST file alone, with no feed.
  await app.connect({ symbol: "GBPUSD" });
  const path = `/api/v1/markets/${EURUSD}/candles`;

  const byDefault = await app.read(path, { timeframe: "M1" });
  assert.deepEqual(byDefault.data.map((b: Json) => b.time), m1.slice(-900).map((b) => utcIso(b.time)));
  assert.equal(byDefault.meta.source, null, "no feed: HST and saved history answer");
  assert.equal((await app.read(path, { timeframe: "M1", limit: 5000 })).data.length, 5000);
  for (const limit of [0, 5001]) assert.equal((await app.read(path, { timeframe: "M1", limit }, 400)).error.code, "invalid-parameter");

  const from = utcIso(m1[100].time), to = utcIso(m1[349].time);
  const seen: string[] = [];
  let query: Record<string, string | number> = { timeframe: "M1", from, to, limit: 100 };
  for (let n = 0; n < 5; n++) {
    const pageOf = await app.read(path, query);
    seen.unshift(...pageOf.data.map((b: Json) => b.time));
    if (!pageOf.meta.next) break;
    query = { ...query, to: pageOf.meta.next.to };
  }
  assert.deepEqual(seen, m1.slice(100, 350).map((b) => utcIso(b.time)), "three pages, newest first, oldest-first within each");
  for (const bad of ["2027-01-15", "1700000000", "2027-01-15T10:00:00+02:00", "2027-02-30T00:00:00Z"]) {
    assert.equal((await app.read(path, { timeframe: "M1", to: bad }, 400)).error.code, "invalid-time", bad);
  }
  assert.equal((await app.read(path, { timeframe: "M1", from: to, to: from }, 400)).error.code, "invalid-time", "from after to");
});

test("candle pages back across the broker clock's spring-forward gap without repeating or skipping a bar", { timeout: 20000 }, async (t) => {
  const data = await tempFolder(t, "rest-data");
  // 14 March 2027: the GMT+2 broker moves to GMT+3 at 07:00 UTC, so broker 09:00–09:59 does not exist.
  const start = Date.UTC(2027, 2, 14, 5) / 1000;
  const h1 = bars(start, HOUR, 10).filter((b) => b.time !== start + 4 * HOUR);
  await writeHst(data, DEMO, { version: 401, symbol: "EURUSD", minutes: 60, digits: 5, bars: h1 });
  const app = await startRest(t, await tempFolder(t, "rest-db"), { dataFolders: { [TERMINAL]: data } });
  await app.connect({ symbol: "GBPUSD" });
  const seen: string[] = [];
  let query: Record<string, string | number> = { timeframe: "H1", limit: 1, to: "2027-03-14T12:00:00Z" };
  for (let n = 0; n < 20; n++) {
    const pageOf = await app.read(`/api/v1/markets/${EURUSD}/candles`, query);
    seen.unshift(...pageOf.data.map((b: Json) => b.brokerTime));
    if (!pageOf.meta.next) break;
    query = { ...query, to: pageOf.meta.next.to };
  }
  assert.deepEqual(seen, h1.map((b) => brokerIso(b.time)));
});

test("samples page by cursor through duplicate timestamps without loss or repeats, also with no terminal running", { timeout: 20000 }, async (t) => {
  const db = await tempFolder(t, "rest-db");
  const app = await startRest(t, db);
  const ea = await app.connect();
  await app.post("/api/markets/recording", { brokerServer: DEMO, symbol: "EURUSD", on: true });
  const t0 = MIDNIGHT + 10 * HOUR - 10;
  // Samples are timed to the second and a batch shares its receipt time: five share one UTC instant.
  const quotes = [0, 1, 1, 1, 1, 1, 2].map((offset, i) => ({ seq: i + 1, bid: 1.1 + i / 10000, ask: 1.1002 + i / 10000, quoteTime: t0 + offset }));
  await app.quote(ea, quotes);
  const sample = (q: (typeof quotes)[number]) => ({ time: utcIso(q.quoteTime), brokerTime: brokerIso(q.quoteTime), bid: q.bid.toFixed(5), ask: q.ask.toFixed(5), receivedAt: new Date(NOW).toISOString() });
  const path = `/api/v1/markets/${EURUSD}/samples`;

  const all = await app.read(path);
  assert.deepEqual(all, { data: quotes.map(sample), meta: { marketId: EURUSD, digits: 5, count: 7, limit: 1000, nextCursor: null } });
  for (const limit of [1, 2, 3]) {
    const seen: Json[] = [];
    let query: Record<string, string | number> = { limit };
    for (let n = 0; n < 10; n++) {
      const page = await app.read(path, query);
      seen.push(...page.data);
      if (!page.meta.nextCursor) break;
      query = { limit, cursor: page.meta.nextCursor };
    }
    assert.deepEqual(seen, quotes.map(sample), `limit ${limit}`);
  }
  const bounded = await app.read(path, { from: utcIso(t0 + 1), to: utcIso(t0 + 1) });
  assert.equal(bounded.data.length, 5, "from and to are inclusive UTC times");
  assert.equal((await app.read(path, { limit: 10000 })).meta.limit, 10000);
  for (const limit of [0, 10001]) assert.equal((await app.read(path, { limit }, 400)).error.code, "invalid-parameter");
  assert.equal((await app.read(path, { cursor: "bm90LWEtY3Vyc29y" }, 400)).error.code, "invalid-cursor");
  // A cursor continues only the query that gave it: other bounds or another market would skip samples silently.
  const { nextCursor } = (await app.read(path, { limit: 2 })).meta;
  assert.equal((await app.read(path, { limit: 2, cursor: nextCursor, from: utcIso(t0 + 1) }, 400)).error.code, "invalid-cursor");
  await app.post("/api/markets/recording", { brokerServer: DEMO, symbol: "EURUSD", on: false });
  await app.connect({ symbol: "GBPUSD" });
  await app.post("/api/markets/recording", { brokerServer: DEMO, symbol: "GBPUSD", on: true });
  assert.equal((await app.read(`/api/v1/markets/${marketId(DEMO, "GBPUSD")}/samples`, { cursor: nextCursor }, 400)).error.code, "invalid-cursor");

  await app.stop();
  const again = await startRest(t, db, { clock: app.clock });
  assert.deepEqual((await again.read(path)).data, quotes.map(sample));
});

test("history covers HST joined with saved history per timeframe, also with no terminal running", { timeout: 30000 }, async (t) => {
  const data = await tempFolder(t, "rest-data");
  const db = await tempFolder(t, "rest-db");
  const h1 = bars(MIDNIGHT - 100 * HOUR, HOUR, 100);
  await writeHst(data, DEMO, { version: 401, symbol: "EURUSD", minutes: 60, digits: 5, bars: h1 });
  const app = await startRest(t, db, { dataFolders: { [TERMINAL]: data } });
  await app.connect();
  await app.post("/api/history/save", { market: JSON.stringify([DEMO, "EURUSD"]) });
  await saved(app);
  // MetaTrader trims its file to the newest 40 bars: the older 60 are only in the saved history now.
  await writeHst(data, DEMO, { version: 401, symbol: "EURUSD", minutes: 60, digits: 5, bars: h1.slice(60) });
  const expected = {
    data: {
      marketId: EURUSD,
      digits: 5,
      timeframes: [{ timeframe: "H1", bars: 100, from: utcIso(h1[0].time), fromBrokerTime: brokerIso(h1[0].time), to: utcIso(h1[99].time), toBrokerTime: brokerIso(h1[99].time) }],
    },
    meta: {},
  };
  assert.deepEqual(await app.read(`/api/v1/markets/${EURUSD}/history`), expected);
  await app.stop();
  const again = await startRest(t, db, { clock: app.clock });
  assert.deepEqual(await again.read(`/api/v1/markets/${EURUSD}/history`), expected);
  const candles = await again.read(`/api/v1/markets/${EURUSD}/candles`, { timeframe: "H1", limit: 2 });
  assert.deepEqual(candles.data.map((b: Json) => b.time), [utcIso(h1[98].time), utcIso(h1[99].time)], "candles read saved history with no terminal running");
});

test("export answers the M3 History pipeline's CSV and HST files byte for byte; from/to narrow them; errors stay structured", { timeout: 30000 }, async (t) => {
  const data = await tempFolder(t, "rest-data");
  const h1 = bars(MIDNIGHT - 10 * HOUR, HOUR, 10);
  await writeHst(data, DEMO, { version: 401, symbol: "EURUSD", minutes: 60, digits: 5, bars: h1 });
  const app = await startRest(t, await tempFolder(t, "rest-db"), { dataFolders: { [TERMINAL]: data } });
  const ea = await app.connect();
  // A live candle forming after the file's bars is not exported.
  await app.quote(ea, [{ seq: 1, bid: 1.2, ask: 1.2002, quoteTime: MIDNIGHT + 10 * HOUR }]);
  const path = `/api/v1/markets/${EURUSD}/export`;
  const market = encodeURIComponent(JSON.stringify([DEMO, "EURUSD"]));
  for (const format of ["csv", "hst"]) {
    const exported = await app.cli(path, { timeframe: "H1", format });
    const m3 = await fetch(`${app.origin}/api/history/${format}?market=${market}&period=H1`, { headers: { cookie: app.cookie } });
    assert.equal(exported.status, 200);
    for (const header of ["content-type", "content-disposition"]) assert.equal(exported.headers.get(header), m3.headers.get(header), header);
    assert.deepEqual(Buffer.from(await exported.arrayBuffer()), Buffer.from(await m3.arrayBuffer()), format);
  }
  const narrowed = await app.cli(path, { timeframe: "H1", format: "csv", from: utcIso(h1[2].time), to: utcIso(h1[4].time) });
  assert.deepEqual((await narrowed.text()).trim().split("\n"), [
    "time,open,high,low,close,tick_volume,spread,real_volume,time_utc",
    "2027-01-14 16:00:00,1.10020,1.10070,1.10000,1.10050,12,0,0,2027-01-14T14:00:00Z",
    "2027-01-14 17:00:00,1.10030,1.10080,1.10010,1.10060,13,0,0,2027-01-14T15:00:00Z",
    "2027-01-14 18:00:00,1.10040,1.10060,1.09980,1.10000,14,0,0,2027-01-14T16:00:00Z",
  ]);
  const hst = Buffer.from(await (await app.cli(path, { timeframe: "H1", format: "hst", from: utcIso(h1[2].time), to: utcIso(h1[4].time) })).arrayBuffer());
  assert.equal(hst.length, 148 + 3 * 60, "an HST v401 header and three records");

  const missing = await app.read(path, { timeframe: "D1", format: "csv" }, 404);
  assert.equal(missing.error.code, "no-history");
  assert.equal((await app.read(path, { timeframe: "H1", format: "json" }, 400)).error.code, "invalid-format");
  assert.equal((await app.read(path, { timeframe: "H1" }, 400)).error.code, "invalid-format", "format is required");
});

/** Waits until no save of history is running. */
async function saved(app: { windowGet: (path: string) => Promise<Json> }) {
  for (let i = 0; ; i++) {
    const { markets } = await app.windowGet("/api/history");
    if (markets.every((m: Json) => !m.saving)) return;
    if (i > 100) assert.fail("the save did not finish");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("with no terminal running, quote answers the last recorded sample with null terminal provenance; none answers 503", { timeout: 20000 }, async (t) => {
  const db = await tempFolder(t, "rest-db");
  const app = await startRest(t, db);
  const ea = await app.connect();
  await app.post("/api/markets/recording", { brokerServer: DEMO, symbol: "EURUSD", on: true });
  await app.quote(ea, [{ seq: 1, bid: 1.1001, ask: 1.1003, quoteTime: MIDNIGHT + 10 * HOUR }]);
  await app.connect({ symbol: "GBPUSD" });
  const gbpusd = await app.read(`/api/v1/markets/${marketId(DEMO, "GBPUSD")}/quote`, {}, 503);
  assert.equal(gbpusd.error.code, "quote-unavailable", "a connected chart without a quote yet");
  app.clock.advance(8000);
  await app.stop();

  const again = await startRest(t, db, { clock: app.clock });
  const quote = (await again.read(`/api/v1/markets/${EURUSD}/quote`)).data;
  assert.deepEqual(quote, {
    marketId: EURUSD,
    brokerServer: DEMO,
    symbol: "EURUSD",
    digits: 5,
    bid: "1.10010",
    ask: "1.10030",
    spread: "20.0",
    time: utcIso(MIDNIGHT + 10 * HOUR),
    brokerTime: brokerIso(MIDNIGHT + 10 * HOUR),
    state: "recorded",
    stale: true,
    quoteAgeMs: 8000,
    sourceSilenceMs: 8000,
    sourceSilent: true,
    provenance: { terminalId: null, feedId: null, receivedAt: new Date(NOW).toISOString() },
  });
});
