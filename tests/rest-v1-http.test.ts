// REST v1 reads over HTTP, as the CLI sends them with a Bearer key: the legacy contract field by field, with a `…Utc`
// sibling (UTC milliseconds) beside every broker-time field; an ambiguous symbol answers 409 with the candidates;
// recorded and saved data answer with no terminal running; what later milestones bring answers 501.
// Real server and database in temp folders, fake EAs, HST fixtures, a fake clock.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, startServer, type ServerConfig } from "../src/server/index.js";
import { FakeClock, FakeEA } from "./fake-ea.js";
import { freePort } from "./free-port.js";
import { bars, writeHst } from "./hst-fixtures.js";

const TOKEN = "window-token-0123456789";
const HOUR = 3600;
const DAY = 86400;
const DEMO = "EasyForex-Demo";
const REAL = "EasyForex-Real";
const TERMINAL = "mt4-aaaaaaaaaaaa";
const OTHER_TERMINAL = "mt4-bbbbbbbbbbbb";
/** The server's clock: 15 January 2027 08:00 UTC, 10:00 on the GMT+2 brokers (winter). */
const NOW = Date.UTC(2027, 0, 15, 8);
/** Broker seconds of 15 January 2027 00:00. */
const MIDNIGHT = Date.UTC(2027, 0, 15) / 1000;
/** UTC milliseconds of a broker time in seconds, on the GMT+2 brokers in winter. */
const utcMs = (broker: number) => (broker - 2 * HOUR) * 1000;

type Json = Record<string, any>;

async function tempFolder(t: TestContext, name: string) {
  const folder = await mkdtemp(join(tmpdir(), `quotebridge-${name}-`));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

/** A server with its database in `dbFolder`; each terminal's data folder is `dataFolders[terminalId]`. */
async function start(t: TestContext, dbFolder: string, dataFolders: Record<string, string> = {}, clock = new FakeClock(NOW), overrides: Partial<ServerConfig> = {}) {
  const database = await openDatabase(dbFolder);
  const cfg: ServerConfig = {
    eaPort: await freePort(),
    httpPort: await freePort(),
    windowToken: TOKEN,
    now: clock.now,
    localOffsetMinutes: () => 0,
    terminalDataFolder: (terminalId) => dataFolders[terminalId],
    database,
    ...overrides,
  };
  const server = await startServer(cfg);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await server.close();
    await database.checkpointAndClose();
  };
  t.after(stop);
  const origin = server.httpOrigin;
  const signIn = await fetch(`${origin}/session?token=${TOKEN}`, { redirect: "manual" });
  const cookie = signIn.headers.get("set-cookie")!.split(";")[0];
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${origin}${path}`, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.ok(res.ok, `${path}: ${res.status} ${await res.clone().text()}`);
    return (await res.json()) as Json;
  };
  for (const brokerServer of [DEMO, REAL]) await post("/api/clock-rules", { brokerServer, winterOffsetMinutes: 120, dst: "us" });
  const { key } = await post("/api/api-keys", { name: "CLI", scope: "read" });
  /** As the CLI: a Bearer key, no cookie. */
  const cli = (path: string, query: Record<string, string | number> = {}, init: RequestInit = {}) => {
    const search = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
    return fetch(`${origin}${path}${search.size ? `?${search}` : ""}`, { ...init, headers: { authorization: `Bearer ${key}` } });
  };
  /** The JSON of a CLI GET, asserting its status. */
  const read = async (path: string, query: Record<string, string | number> = {}, status = 200) => {
    const res = await cli(path, query);
    assert.equal(res.status, status, `${path}: ${await res.clone().text()}`);
    return (await res.json()) as Json;
  };
  const connect = async (options: { symbol?: string; terminal?: string; broker?: string } = {}) => {
    const ea = new FakeEA({ terminal: options.terminal ?? TERMINAL, broker: options.broker ?? DEMO, symbol: options.symbol ?? "EURUSD", digits: 5 }).connect(`tcp://127.0.0.1:${cfg.eaPort}`);
    t.after(() => ea.close());
    await ea.request(ea.helloWire());
    return ea;
  };
  /** Sends quotes and waits until the feed shows the last one. */
  const quote = async (ea: FakeEA, quotes: { seq: number; bid: number; ask: number; quoteTime: number }[]) => {
    await ea.ticks(quotes);
    const last = quotes.at(-1)!;
    for (let i = 0; ; i++) {
      const state = (await (await fetch(`${origin}/api/state`, { headers: { cookie } })).json()) as { feeds: Json[] };
      if (state.feeds.some((f) => f.terminal === ea.terminal && f.symbol === ea.symbol && f.latest?.seq === last.seq)) return;
      if (i > 100) assert.fail("the quotes did not arrive");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  /** Waits until no save of history is running. */
  const saved = async () => {
    for (let i = 0; ; i++) {
      const { markets } = (await (await fetch(`${origin}/api/history`, { headers: { cookie } })).json()) as { markets: Json[] };
      if (markets.every((m) => !m.saving)) return;
      if (i > 100) assert.fail("the save did not finish");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  return { origin, cli, read, post, connect, quote, saved, stop };
}

test("/api/v1/info is public and names the service and API version", { timeout: 15000 }, async (t) => {
  const app = await start(t, await tempFolder(t, "rest-db"));
  const res = await fetch(`${app.origin}/api/v1/info`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { service: "mt4-quote-bridge", apiVersion: 1 });
});

test("symbols lists each feed as the legacy contract does, with quoteTimeUtc, recording and its live and history periods", { timeout: 20000 }, async (t) => {
  const data = await tempFolder(t, "rest-data");
  await writeHst(data, DEMO, { version: 401, symbol: "EURUSD", minutes: 60, digits: 5, bars: bars(MIDNIGHT - 10 * HOUR, HOUR, 10) });
  await writeHst(data, DEMO, { version: 400, symbol: "EURUSD", minutes: 1440, digits: 5, bars: bars(MIDNIGHT - 10 * DAY, DAY, 10) });
  const app = await start(t, await tempFolder(t, "rest-db"), { [TERMINAL]: data });
  const ea = await app.connect();
  await app.connect({ symbol: "GBPUSD" });
  await app.post("/api/markets/recording", { brokerServer: DEMO, symbol: "EURUSD", on: true });
  await app.quote(ea, [{ seq: 1, bid: 1.1, ask: 1.1002, quoteTime: MIDNIGHT + 10 * HOUR }]);

  const { symbols } = await app.read("/api/v1/symbols");
  const eurusd = symbols.find((s: Json) => s.symbol === "EURUSD");
  assert.deepEqual(eurusd, {
    symbol: "EURUSD",
    broker: DEMO,
    terminal: TERMINAL,
    feed: eurusd.feed,
    online: true,
    recording: true,
    digits: 5,
    bid: 1.1,
    ask: 1.1002,
    quoteTime: MIDNIGHT + 10 * HOUR,
    quoteTimeUtc: NOW,
    livePeriods: ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN1"],
    historyPeriods: ["H1", "D1"],
  });
  const gbpusd = symbols.find((s: Json) => s.symbol === "GBPUSD");
  assert.deepEqual([gbpusd.recording, gbpusd.quoteTime, gbpusd.quoteTimeUtc, gbpusd.livePeriods, gbpusd.historyPeriods], [false, null, null, [], []]);
});

test("what later milestones bring answers 501 naming the milestone; unknown paths 404", { timeout: 15000 }, async (t) => {
  const app = await start(t, await tempFolder(t, "rest-db"));
  for (const [path, milestone] of [
    ["/api/v1/symbols/EURUSD/info", 5],
    ["/api/v1/indicators", 4],
    ["/api/v1/indicators/macd", 4],
    ["/api/v1/indicators/macd/EURUSD", 4],
    ["/api/v1/accounts", 5],
    ["/api/v1/accounts/12345", 5],
    ["/api/v1/positions", 5],
    ["/api/v1/positions/42", 5],
    ["/api/v1/budget", 5],
    ["/api/v1/orders/requests/abc", 5],
  ] as const) {
    const body = await app.read(path, {}, 501);
    assert.match(body.error, new RegExp(`milestone ${milestone}`), path);
  }
  assert.equal((await app.cli("/api/v1/nothing-here")).status, 404);
});

test("quote answers the feed's latest sample live; an ambiguous symbol answers 409 with candidates, narrowed by broker or terminal", { timeout: 20000 }, async (t) => {
  const app = await start(t, await tempFolder(t, "rest-db"));
  const demo = await app.connect();
  const real = await app.connect({ broker: REAL, terminal: OTHER_TERMINAL });
  await app.quote(demo, [{ seq: 1, bid: 1.1, ask: 1.10015, quoteTime: MIDNIGHT + 10 * HOUR }]);
  await app.quote(real, [{ seq: 1, bid: 1.2, ask: 1.2002, quoteTime: MIDNIGHT + 10 * HOUR - 5 }]);

  const ambiguous = await app.read("/api/v1/symbols/eurusd/quote", {}, 409);
  assert.match(ambiguous.error, /ambiguous/);
  assert.deepEqual(
    ambiguous.details.map((c: Json) => [c.symbol, c.broker, c.terminal]),
    [["EURUSD", DEMO, TERMINAL], ["EURUSD", REAL, OTHER_TERMINAL]],
  );
  const quote = await app.read("/api/v1/symbols/eurusd/quote", { broker: "demo" });
  assert.deepEqual({ ...quote, feed: "" }, {
    symbol: "EURUSD",
    broker: DEMO,
    terminal: TERMINAL,
    feed: "",
    source: "live",
    online: true,
    bid: 1.1,
    ask: 1.10015,
    spread: 15,
    digits: 5,
    time: MIDNIGHT + 10 * HOUR,
    timeUtc: NOW,
  });
  assert.equal((await app.read("/api/v1/symbols/EURUSD/quote", { terminal: "bbbb" })).bid, 1.2);
  assert.equal((await app.read("/api/v1/symbols/EURUSD/quote", { feed: quote.feed })).bid, 1.1, "the exact feed key");
  assert.match((await app.read("/api/v1/symbols/USDJPY/quote", {}, 404)).error, /Unknown symbol USDJPY/);
});

test("with no terminal running, quote answers the market's last recorded sample", { timeout: 20000 }, async (t) => {
  const db = await tempFolder(t, "rest-db");
  const clock = new FakeClock(NOW);
  const app = await start(t, db, {}, clock);
  const ea = await app.connect();
  await app.post("/api/markets/recording", { brokerServer: DEMO, symbol: "EURUSD", on: true });
  await app.quote(ea, [
    { seq: 1, bid: 1.1, ask: 1.1002, quoteTime: MIDNIGHT + 10 * HOUR - 1 },
    { seq: 2, bid: 1.1001, ask: 1.1003, quoteTime: MIDNIGHT + 10 * HOUR },
  ]);
  // The terminal goes quiet: its feed is offline, and its last quote is no longer live.
  clock.advance(8000);
  const offline = await app.read("/api/v1/symbols/EURUSD/quote");
  assert.deepEqual([offline.source, offline.online, offline.terminal, offline.bid], ["recorded", false, TERMINAL, 1.1001]);
  await app.stop();

  const again = await start(t, db, {}, clock);
  const quote = await again.read("/api/v1/symbols/EURUSD/quote");
  assert.deepEqual(quote, {
    symbol: "EURUSD",
    broker: DEMO,
    terminal: null,
    feed: null,
    source: "recorded",
    online: false,
    bid: 1.1001,
    ask: 1.1003,
    spread: 20,
    digits: 5,
    time: MIDNIGHT + 10 * HOUR,
    timeUtc: NOW,
    received: NOW,
  });
});

test("candles: auto joins HST and the live candles, live has the live ones only, history HST with volume; the last live bar is not complete", { timeout: 20000 }, async (t) => {
  const data = await tempFolder(t, "rest-data");
  const h1 = bars(MIDNIGHT - 10 * HOUR, HOUR, 10);
  await writeHst(data, DEMO, { version: 401, symbol: "EURUSD", minutes: 60, digits: 5, bars: h1 });
  const app = await start(t, await tempFolder(t, "rest-db"), { [TERMINAL]: data });
  const ea = await app.connect();
  await app.quote(ea, [
    { seq: 1, bid: 1.2, ask: 1.2002, quoteTime: MIDNIGHT + 10 * HOUR },
    { seq: 2, bid: 1.21, ask: 1.2102, quoteTime: MIDNIGHT + 10 * HOUR + 60 },
  ]);
  const ohlc = (b: { time: number; open: number; high: number; low: number; close: number }) => ({ time: b.time, timeUtc: utcMs(b.time), open: b.open, high: b.high, low: b.low, close: b.close });
  const forming = { ...ohlc({ time: MIDNIGHT + 10 * HOUR, open: 1.2, high: 1.21, low: 1.2, close: 1.21 }), complete: false };

  const auto = await app.read("/api/v1/symbols/EURUSD/candles", { period: "1H", count: 3 });
  assert.deepEqual({ ...auto, feed: "", status: "", message: "" }, {
    period: "H1",
    timeframe: 60,
    symbol: "EURUSD",
    broker: DEMO,
    terminal: TERMINAL,
    feed: "",
    digits: 5,
    source: "live",
    status: "",
    message: "",
    bars: [ohlc(h1[8]), ohlc(h1[9]), forming],
  });

  const live = await app.read("/api/v1/symbols/EURUSD/candles", { period: "H1", count: 30, source: "live" });
  assert.deepEqual([live.source, live.bars], ["live", [forming]]);
  const m1 = await app.read("/api/v1/symbols/EURUSD/candles", { period: "M1", source: "live" });
  assert.deepEqual(m1.bars.map((b: Json) => [b.close, b.complete]), [[1.2, true], [1.21, false]], "every live bar says whether it is complete");

  const history = await app.read("/api/v1/symbols/EURUSD/candles", { period: "60", count: 2, source: "history" });
  assert.equal(history.source, "history");
  assert.deepEqual(history.bars, [h1[8], h1[9]].map((b) => ({ ...ohlc(b), volume: b.volume, spread: 0 })));

  assert.equal((await app.read("/api/v1/symbols/EURUSD/candles", { period: "H1" })).bars.length, 11, "all there are");
  await app.read("/api/v1/symbols/EURUSD/candles", { period: "H2" }, 400);
  await app.read("/api/v1/symbols/EURUSD/candles", { period: "H1", source: "tape" }, 400);

  // A feed with neither history nor a quote yet has no candles to give.
  await app.connect({ symbol: "GBPUSD" });
  assert.match((await app.read("/api/v1/symbols/GBPUSD/candles", { period: "H1" }, 404)).error, /No H1 candles of GBPUSD/);
});

test("candles: 900 by default, as MetaTrader's charts show, and up to 5000", { timeout: 20000 }, async (t) => {
  const data = await tempFolder(t, "rest-data");
  const m1 = bars(MIDNIGHT - 6000 * 60, 60, 6000);
  await writeHst(data, DEMO, { version: 401, symbol: "EURUSD", minutes: 1, digits: 5, bars: m1 });
  const app = await start(t, await tempFolder(t, "rest-data-db"), { [TERMINAL]: data });
  await app.connect();

  const byDefault = await app.read("/api/v1/symbols/EURUSD/candles", { period: "M1" });
  assert.deepEqual(byDefault.bars.map((b: Json) => b.time), m1.slice(-900).map((b) => b.time));
  assert.equal((await app.read("/api/v1/symbols/EURUSD/candles", { period: "M1", count: 5000, source: "history" })).bars.length, 5000);
  for (const count of [0, 5001]) await app.read("/api/v1/symbols/EURUSD/candles", { period: "M1", count }, 400);
});

test("history lists each market's periods and reads bars from HST joined with saved history, also with no terminal running", { timeout: 30000 }, async (t) => {
  const data = await tempFolder(t, "rest-data");
  const db = await tempFolder(t, "rest-db");
  const clock = new FakeClock(NOW);
  const h1 = bars(MIDNIGHT - 100 * HOUR, HOUR, 100);
  await writeHst(data, DEMO, { version: 401, symbol: "EURUSD", minutes: 60, digits: 5, bars: h1 });
  const app = await start(t, db, { [TERMINAL]: data }, clock);
  await app.connect();
  await app.post("/api/history/save", { market: JSON.stringify([DEMO, "EURUSD"]) });
  await app.saved();
  // MetaTrader trims its file to the newest 40 bars: the older 60 are only in the saved history now.
  await writeHst(data, DEMO, { version: 401, symbol: "EURUSD", minutes: 60, digits: 5, bars: h1.slice(60) });
  const row = (b: (typeof h1)[number]) => ({ time: b.time, timeUtc: utcMs(b.time), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, spread: 0 });
  const listed = {
    source: DEMO,
    symbol: "EURUSD",
    broker: DEMO,
    period: "H1",
    timeframe: 60,
    bars: 100,
    from: h1[0].time,
    to: h1[99].time,
    fromUtc: utcMs(h1[0].time),
    toUtc: utcMs(h1[99].time),
  };

  const restarted = async () => {
    await app.stop();
    return start(t, db, {}, clock);
  };
  for (const next of [async () => app, restarted]) {
    const reader = await next();
    assert.deepEqual((await reader.read("/api/v1/history")).series, [listed]);
    const page = await reader.read("/api/v1/history/eurusd", { period: "H1", from: h1[50].time, to: h1[69].time, limit: 15 });
    assert.deepEqual(page, {
      symbol: "EURUSD",
      broker: DEMO,
      period: "H1",
      timeframe: 60,
      source: DEMO,
      from: h1[50].time,
      to: h1[69].time,
      truncated: true,
      bars: h1.slice(50, 65).map(row),
    });
    const rest = await reader.read("/api/v1/history/EURUSD", { period: "H1", from: h1[64].time + 1, to: h1[69].time, source: DEMO });
    assert.deepEqual([rest.truncated, rest.bars], [false, h1.slice(65, 70).map(row)]);
    const candles = await reader.read("/api/v1/symbols/EURUSD/candles", { period: "H1", count: 2, source: "history" });
    assert.deepEqual(candles.bars, h1.slice(98).map(row));
  }
});

test("history answers 404 for a period without bars and 409 for a symbol on several broker servers", { timeout: 20000 }, async (t) => {
  const data = await tempFolder(t, "rest-data");
  await writeHst(data, DEMO, { version: 401, symbol: "EURUSD", minutes: 60, digits: 5, bars: bars(MIDNIGHT - 10 * HOUR, HOUR, 10) });
  await writeHst(data, REAL, { version: 401, symbol: "EURUSD", minutes: 60, digits: 5, bars: bars(MIDNIGHT - 10 * HOUR, HOUR, 10, 1.2) });
  const app = await start(t, await tempFolder(t, "rest-db"), { [TERMINAL]: data, [OTHER_TERMINAL]: data });
  await app.connect();
  await app.connect({ broker: REAL, terminal: OTHER_TERMINAL });
  const ambiguous = await app.read("/api/v1/history/EURUSD", { period: "H1" }, 409);
  assert.deepEqual(ambiguous.details.map((c: Json) => c.broker), [DEMO, REAL]);
  assert.equal((await app.read("/api/v1/history/EURUSD", { period: "H1", broker: "real" })).bars[0].open, 1.2);
  assert.equal((await app.read("/api/v1/history/EURUSD", { period: "H1", source: REAL })).bars[0].open, 1.2, "source names the broker server, as /history lists it");
  await app.read("/api/v1/history/EURUSD", { period: "D1", broker: "demo" }, 404);
  await app.read("/api/v1/history/EURUSD", { period: "H1", broker: "demo", limit: 100001 }, 400);
});

test("history/files lists the HST files of the known terminals, and history/files/csv downloads one as the legacy CSV with a UTC column", { timeout: 20000 }, async (t) => {
  const data = await tempFolder(t, "rest-data");
  const h1 = bars(MIDNIGHT - 10 * HOUR, HOUR, 10);
  await writeHst(data, DEMO, { version: 401, symbol: "EURUSD", minutes: 60, digits: 5, bars: h1 });
  await writeHst(data, DEMO, { version: 400, symbol: "GBPUSD", minutes: 1440, digits: 5, bars: bars(MIDNIGHT - 3 * DAY, DAY, 3) });
  const app = await start(t, await tempFolder(t, "rest-db"), { [TERMINAL]: data });
  await app.connect();

  const { files } = await app.read("/api/v1/history/files", { symbol: "eurusd" });
  assert.deepEqual(files, [
    {
      file: `${TERMINAL}/${DEMO}/EURUSD60.hst`,
      symbol: "EURUSD",
      broker: DEMO,
      terminal: TERMINAL,
      period: "H1",
      timeframe: 60,
      digits: 5,
      bars: 10,
      from: h1[0].time,
      to: h1[9].time,
      fromUtc: utcMs(h1[0].time),
      toUtc: utcMs(h1[9].time),
    },
  ]);
  assert.deepEqual((await app.read("/api/v1/history/files", { period: "D1" })).files.map((f: Json) => f.symbol), ["GBPUSD"]);

  const res = await app.cli("/api/v1/history/files/csv", { file: files[0].file, from: h1[2].time, to: h1[4].time });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-disposition"), 'attachment; filename="EURUSD_H1_20270114-20270114.csv"');
  assert.deepEqual((await res.text()).trim().split("\n"), [
    "time,open,high,low,close,tick_volume,spread,real_volume,time_utc",
    "2027-01-14 16:00:00,1.10020,1.10070,1.10000,1.10050,12,0,0,2027-01-14T14:00:00Z",
    "2027-01-14 17:00:00,1.10030,1.10080,1.10010,1.10060,13,0,0,2027-01-14T15:00:00Z",
    "2027-01-14 18:00:00,1.10040,1.10060,1.09980,1.10000,14,0,0,2027-01-14T16:00:00Z",
  ]);
  assert.equal((await app.cli("/api/v1/history/files/csv", { file: `${TERMINAL}/../../secret.hst` })).status, 404);
});

test("samples reads a market's recorded samples over a UTC range, oldest first, truncated at a whole second, also with no terminal running", { timeout: 20000 }, async (t) => {
  const db = await tempFolder(t, "rest-db");
  const clock = new FakeClock(NOW);
  const app = await start(t, db, {}, clock);
  const ea = await app.connect();
  await app.post("/api/markets/recording", { brokerServer: DEMO, symbol: "EURUSD", on: true });
  const t0 = MIDNIGHT + 10 * HOUR - 10;
  const quotes = [
    { seq: 1, bid: 1.1, ask: 1.1002, quoteTime: t0 },
    { seq: 2, bid: 1.1001, ask: 1.1003, quoteTime: t0 + 1 },
    { seq: 3, bid: 1.1002, ask: 1.1004, quoteTime: t0 + 1 },
    { seq: 4, bid: 1.1003, ask: 1.1005, quoteTime: t0 + 2 },
  ];
  await app.quote(ea, quotes);
  const sample = (q: (typeof quotes)[number]) => ({ time: q.quoteTime, timeUtc: utcMs(q.quoteTime), bid: q.bid, ask: q.ask, received: NOW });

  const all = await app.read("/api/v1/symbols/EURUSD/samples");
  assert.deepEqual(all, { symbol: "EURUSD", broker: DEMO, from: 0, to: all.to, truncated: false, samples: quotes.map(sample) });
  // Two would split the second holding samples 2 and 3: the page ends before it, and the next starts there.
  const first = await app.read("/api/v1/symbols/EURUSD/samples", { limit: 2 });
  assert.deepEqual([first.truncated, first.samples], [true, [sample(quotes[0])]]);
  const next = await app.read("/api/v1/symbols/EURUSD/samples", { from: first.samples.at(-1).timeUtc + 1, to: utcMs(t0 + 1) });
  assert.deepEqual([next.from, next.to, next.truncated, next.samples], [utcMs(t0) + 1, utcMs(t0 + 1), false, quotes.slice(1, 3).map(sample)]);
  await app.read("/api/v1/symbols/EURUSD/samples", { limit: 100_001 }, 400);

  await app.stop();
  const again = await start(t, db, {}, clock);
  assert.deepEqual((await again.read("/api/v1/symbols/EURUSD/samples")).samples, quotes.map(sample));
  await again.read("/api/v1/symbols/GBPUSD/samples", {}, 404);
});
