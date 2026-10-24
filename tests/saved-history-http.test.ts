// Saved history over HTTP: the app's own copy of a market's HST bars. "Save this history" (POST /api/history/save)
// copies every HST period once, recorded markets are saved at start and hourly, saving twice adds nothing, and the
// chart and the downloads continue into the saved bars once MetaTrader trims its files or the terminal is gone.
// Real server and database in temp folders, fake EAs, HST fixtures, a fake clock.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryMarket } from "../src/server/history/index.js";
import { openDatabase, startServer, type ServerConfig } from "../src/server/index.js";
import { FakeClock, FakeEA, fakeTerminalIdentity } from "./fake-ea.js";
import { freePort } from "./free-port.js";
import { appendHst, bars, writeHst } from "./hst-fixtures.js";

const TOKEN = "window-token-0123456789";
const HOUR = 3600;
const DAY = 86400;
const BROKER = "EasyForex-Demo";
const TERMINAL = "mt4-aaaaaaaaaaaa";
/** The server's clock: 15 January 2027 08:00 UTC, 10:00 on the GMT+2 broker (winter). */
const NOW = Date.UTC(2027, 0, 15, 8);
/** Broker seconds of 15 January 2027 00:00. */
const MIDNIGHT = Date.UTC(2027, 0, 15) / 1000;
const utc = (broker: number) => broker - 2 * HOUR;
const EURUSD = JSON.stringify([BROKER, "EURUSD"]);

type Page = { candles: { time: number }[]; source: string; complete: boolean };

async function tempFolder(t: TestContext, name: string) {
  const folder = await mkdtemp(join(tmpdir(), `quotebridge-${name}-`));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

/** A server with its database in `dbFolder` and the terminal's data folder `dataFolder`; `stop` closes, then CHECKPOINTs. */
async function start(t: TestContext, dbFolder: string, dataFolder: string, clock = new FakeClock(NOW), overrides: Partial<ServerConfig> = {}) {
  const database = await openDatabase(dbFolder);
  const cfg: ServerConfig = {
    eaPort: await freePort(),
    httpPort: await freePort(),
    windowToken: TOKEN,
    resolveTerminal: fakeTerminalIdentity,
    now: clock.now,
    localOffsetMinutes: () => 0,
    terminalDataFolder: (terminalId) => (terminalId === TERMINAL ? dataFolder : undefined),
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
  const get = (path: string) => fetch(`${origin}${path}`, { headers: { cookie } });
  const post = (path: string, body: unknown) =>
    fetch(`${origin}${path}`, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify(body) });
  const rule = await post("/api/clock-rules", { brokerServer: BROKER, winterOffsetMinutes: 120, dst: "us" });
  assert.equal(rule.status, 200);
  const connect = async (symbol = "EURUSD", terminal = TERMINAL) => {
    const ea = new FakeEA({ terminal, broker: BROKER, symbol }).connect(`tcp://127.0.0.1:${cfg.eaPort}`);
    t.after(() => ea.close());
    await ea.request(ea.helloWire());
    return ea;
  };
  const markets = async () => {
    const res = await get("/api/history");
    assert.equal(res.status, 200, await res.clone().text());
    return ((await res.json()) as { markets: HistoryMarket[] }).markets;
  };
  const eurusd = async () => (await markets()).find((m) => m.market === EURUSD)!;
  /** Saved bars per period, once no save is running. */
  const saved = async () => {
    for (let i = 0; ; i++) {
      const m = await eurusd();
      if (!m.saving) return Object.fromEntries(m.periods.map((p) => [p.period, p.saved?.bars ?? 0]));
      if (i > 100) assert.fail("the save did not finish");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const save = async (market = EURUSD) => {
    const res = await post("/api/history/save", { market });
    assert.equal(res.status, 202, await res.clone().text());
  };
  const csv = async () => (await (await get(`/api/history/csv?${new URLSearchParams({ market: EURUSD, period: "H1" })}`)).text()).trim().split("\n").slice(1);
  return { get, post, connect, markets, eurusd, saved, save, csv, stop };
}

test("Save this history copies every HST period of the market; saving again adds nothing", { timeout: 20000 }, async (t) => {
  const data = await tempFolder(t, "saved-data");
  const h1 = bars(MIDNIGHT - 100 * HOUR, HOUR, 100);
  const d1 = bars(MIDNIGHT - 30 * DAY, DAY, 31);
  await writeHst(data, BROKER, { version: 401, symbol: "EURUSD", minutes: 60, digits: 5, bars: h1 });
  await writeHst(data, BROKER, { version: 400, symbol: "EURUSD", minutes: 1440, digits: 5, bars: d1 });
  const app = await start(t, await tempFolder(t, "saved-db"), data);
  await app.connect();
  assert.deepEqual(await app.saved(), { H1: 0, D1: 0 }, "nothing saved before asking");

  await app.save();
  assert.deepEqual(await app.saved(), { H1: 100, D1: 31 });
  const [h1Period] = (await app.eurusd()).periods;
  assert.deepEqual(h1Period.saved, { bars: 100, first: utc(h1[0].time), last: utc(h1[99].time) });

  await app.save();
  assert.deepEqual(await app.saved(), { H1: 100, D1: 31 }, "saving twice adds nothing");
});

test("after MetaTrader trims its HST file, the chart and the CSV continue into the saved bars without a seam", { timeout: 20000 }, async (t) => {
  const data = await tempFolder(t, "saved-data");
  const h1 = bars(MIDNIGHT - 600 * HOUR, HOUR, 600);
  await writeHst(data, BROKER, { version: 401, symbol: "EURUSD", minutes: 60, digits: 5, bars: h1 });
  const app = await start(t, await tempFolder(t, "saved-db"), data);
  await app.connect();
  await app.save();
  assert.deepEqual(await app.saved(), { H1: 600 });

  // MetaTrader keeps only the newest 200 bars, then writes two more.
  const kept = h1.slice(400);
  const more = bars(MIDNIGHT, HOUR, 2);
  const path = await writeHst(data, BROKER, { version: 401, symbol: "EURUSD", minutes: 60, digits: 5, bars: kept });
  await appendHst(path, 401, more);

  const all = [...h1, ...more].map((b) => utc(b.time));
  const feed = JSON.stringify([TERMINAL, "EURUSD"]);
  const page = async (before?: number) => {
    const res = await app.get(`/api/candles?${new URLSearchParams({ feed, period: "H1", limit: "500", ...(before === undefined ? {} : { before: String(before) }) })}`);
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json()) as Page;
  };
  const latest = await page();
  assert.deepEqual(latest.candles.map((c) => c.time), all.slice(-500));
  assert.equal(latest.source, "hst");
  assert.equal(latest.complete, false);
  const older = await page(latest.candles[0].time);
  assert.deepEqual(older.candles.map((c) => c.time), all.slice(0, -500), "the rest of the saved bars, oldest first");
  assert.equal(older.source, "saved");
  assert.equal(older.complete, true);

  const csv = await app.csv();
  assert.equal(csv.length, 602, "saved bars older than the file's first, then the file");
  const stamp = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 19).replace("T", " ");
  assert.deepEqual(
    csv.map((row) => row.split(",")[0]),
    [...h1, ...more].map((b) => stamp(b.time)),
  );

  await app.save();
  assert.deepEqual(await app.saved(), { H1: 602 }, "the new bars are added");
});

test("a market whose terminal was removed still lists and downloads its saved bars", { timeout: 20000 }, async (t) => {
  const data = await tempFolder(t, "saved-data");
  const db = await tempFolder(t, "saved-db");
  const h1 = bars(MIDNIGHT - 50 * HOUR, HOUR, 50);
  await writeHst(data, BROKER, { version: 401, symbol: "EURUSD", minutes: 60, digits: 3, bars: h1 });
  const before = await start(t, db, data);
  await before.connect();
  await before.save();
  assert.deepEqual(await before.saved(), { H1: 50 });
  await before.stop();

  // The terminal and its files are gone; nothing connects.
  await rm(data, { recursive: true, force: true });
  const after = await start(t, db, data);
  const [eurusd] = await after.markets();
  assert.deepEqual(
    { market: eurusd.market, terminals: eurusd.terminals, recording: eurusd.recording, digits: eurusd.digits },
    { market: EURUSD, terminals: [], recording: false, digits: 3 },
  );
  assert.deepEqual(eurusd.periods, [{ period: "H1", hst: null, saved: { bars: 50, first: utc(h1[0].time), last: utc(h1[49].time) } }]);
  const csv = await after.csv();
  assert.equal(csv.length, 50);
  assert.equal(csv[0], `${new Date(h1[0].time * 1000).toISOString().slice(0, 19).replace("T", " ")},${h1[0].open.toFixed(3)},${h1[0].high.toFixed(3)},${h1[0].low.toFixed(3)},${h1[0].close.toFixed(3)},${h1[0].volume},0,0,${new Date(utc(h1[0].time) * 1000).toISOString().slice(0, 19)}Z`);
  const save = await after.post("/api/history/save", { market: EURUSD });
  assert.equal(save.status, 404, "with no HST file there is nothing to save");
});

test("recorded markets are saved at start and again after an hour", { timeout: 30000 }, async (t) => {
  const data = await tempFolder(t, "saved-data");
  const db = await tempFolder(t, "saved-db");
  const clock = new FakeClock(NOW);
  const first = await start(t, db, data, clock);
  await first.connect();
  const on = await first.post("/api/markets/recording", { brokerServer: BROKER, symbol: "EURUSD", on: true });
  assert.equal(on.status, 200);
  await first.stop();

  const h1 = bars(MIDNIGHT - 20 * HOUR, HOUR, 20);
  const path = await writeHst(data, BROKER, { version: 401, symbol: "EURUSD", minutes: 60, digits: 5, bars: h1 });
  const app = await start(t, db, data, clock);
  await app.connect();
  const settle = async (bars: number) => {
    for (let i = 0; i < 60 && (await app.saved()).H1 !== bars; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    return (await app.saved()).H1;
  };
  assert.equal(await settle(20), 20, "saved at start, unasked");
  assert.equal((await app.eurusd()).recording, true);

  await appendHst(path, 401, bars(MIDNIGHT, HOUR, 3));
  clock.advance(59 * 60_000);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal((await app.saved()).H1, 20, "not again within the hour");
  clock.advance(60_000);
  assert.equal(await settle(23), 23, "again after an hour");
});

test("with two terminals on one broker server, bars only the older file holds are saved, and its unfinished last bar never wins", { timeout: 20000 }, async (t) => {
  const current = await tempFolder(t, "saved-current");
  const stale = await tempFolder(t, "saved-stale");
  const db = await tempFolder(t, "saved-db");
  const SECOND = "mt4-bbbbbbbbbbbb";
  const app = await start(t, db, current, new FakeClock(NOW), {
    terminalDataFolder: (id) => (id === TERMINAL ? current : id === SECOND ? stale : undefined),
  });
  // The current terminal's file holds the newest 50 bars. The stale one stopped 30 bars ago, as its last bar was forming.
  const h1 = bars(MIDNIGHT - 120 * HOUR, HOUR, 120);
  const unfinished = { ...h1[89], close: h1[89].open, volume: 1 };
  await writeHst(current, BROKER, { version: 401, symbol: "EURUSD", minutes: 60, digits: 5, bars: h1.slice(70) });
  await writeHst(stale, BROKER, { version: 401, symbol: "EURUSD", minutes: 60, digits: 5, bars: [...h1.slice(0, 89), unfinished] });
  await app.connect("EURUSD", SECOND);
  await app.connect();
  await app.save();
  assert.deepEqual(await app.saved(), { H1: 120 });
  await app.save();
  await app.saved();
  await app.stop();

  // Only the saved copy is left to download.
  const after = await start(t, db, current, new FakeClock(NOW), { terminalDataFolder: () => undefined });
  const rows = await after.csv();
  assert.equal(rows.length, 120);
  const volumes = rows.map((row) => Number(row.split(",")[5]));
  assert.deepEqual(volumes, h1.map((b) => b.volume), "every bar as the newest file holds it");
});
