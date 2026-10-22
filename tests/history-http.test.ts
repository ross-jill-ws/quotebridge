// The History page over HTTP: /api/history lists each market's periods with what the terminal's HST files hold, and
// /api/history/csv and /api/history/hst download a period. Real server, fake EAs, HST files in a temp folder.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HstFile, type HistoryMarket } from "../src/server/history/index.js";
import { openDatabase, startServer, type ServerConfig } from "../src/server/index.js";
import { FakeClock, FakeEA } from "./fake-ea.js";
import { freePort } from "./free-port.js";
import { bars, writeHst } from "./hst-fixtures.js";

const TOKEN = "window-token-0123456789";
const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;
const BROKER = "EasyForex-Demo";
const TERMINAL = "mt4-aaaaaaaaaaaa";
/** The server's clock: 15 January 2027 08:00 UTC, 10:00 on the GMT+2 broker (winter). */
const NOW = Date.UTC(2027, 0, 15, 8);
/** Broker seconds of 15 January 2027 00:00. */
const MIDNIGHT = Date.UTC(2027, 0, 15) / 1000;
const utc = (broker: number) => broker - 2 * HOUR;

type HistoryList = { markets: HistoryMarket[] };

async function start(t: TestContext, overrides: Partial<ServerConfig> = {}) {
  const dataFolder = await mkdtemp(join(tmpdir(), "quotebridge-history-"));
  t.after(() => rm(dataFolder, { recursive: true, force: true }));
  const cfg: ServerConfig = {
    eaPort: await freePort(),
    httpPort: await freePort(),
    windowToken: TOKEN,
    now: new FakeClock(NOW).now,
    localOffsetMinutes: () => 0,
    terminalDataFolder: (terminalId) => (terminalId === TERMINAL ? dataFolder : undefined),
    ...overrides,
  };
  const server = await startServer(cfg);
  let stopped = false;
  const stop = async () => {
    if (!stopped) await server.close();
    stopped = true;
  };
  t.after(stop);
  const origin = server.httpOrigin;
  const signIn = await fetch(`${origin}/session?token=${TOKEN}`, { redirect: "manual" });
  const cookie = signIn.headers.get("set-cookie")!.split(";")[0];
  const rule = await fetch(`${origin}/api/clock-rules`, {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify({ brokerServer: BROKER, winterOffsetMinutes: 120, dst: "us" }),
  });
  assert.equal(rule.status, 200);
  const connect = async (symbol: string, terminal = TERMINAL, broker = BROKER) => {
    const ea = new FakeEA({ terminal, broker, symbol }).connect(`tcp://127.0.0.1:${cfg.eaPort}`);
    t.after(() => ea.close());
    await ea.request(ea.helloWire());
    return ea;
  };
  const get = (path: string) => fetch(`${origin}${path}`, { headers: { cookie } });
  const post = (path: string, body: unknown) =>
    fetch(`${origin}${path}`, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify(body) });
  const list = async () => {
    const res = await get("/api/history");
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json()) as HistoryList;
  };
  return { dataFolder, connect, get, post, list, stop };
}

const market = (symbol: string, broker = BROKER) => JSON.stringify([broker, symbol]);

test("/api/history lists each market of the terminals with the periods its HST files hold", { timeout: 15000 }, async (t) => {
  const { dataFolder, connect, list } = await start(t);
  const h1 = bars(MIDNIGHT - 100 * HOUR, HOUR, 100);
  const d1 = bars(MIDNIGHT - 30 * DAY, DAY, 31);
  await writeHst(dataFolder, BROKER, { version: 401, symbol: "EURUSD", minutes: 60, digits: 5, bars: h1 });
  await writeHst(dataFolder, BROKER, { version: 400, symbol: "EURUSD", minutes: 1440, digits: 5, bars: d1 });
  await writeHst(dataFolder, BROKER, { version: 401, symbol: "XAUUSD", minutes: 1, digits: 2, bars: bars(MIDNIGHT, MINUTE, 10, 2000) });
  await connect("EURUSD");

  const { markets } = await list();
  assert.deepEqual(
    markets.map((m) => [m.symbol, m.brokerServer]),
    [["EURUSD", BROKER], ["XAUUSD", BROKER]],
    "the terminal's other HST symbols are listed too",
  );
  const [eurusd, xauusd] = markets;
  assert.equal(eurusd.market, market("EURUSD"));
  assert.deepEqual(eurusd.terminals, [{ terminalId: TERMINAL, name: TERMINAL }]);
  assert.equal(eurusd.recording, false);
  assert.equal(eurusd.digits, 5);
  assert.deepEqual(eurusd.periods, [
    { period: "H1", hst: { bars: 100, first: utc(h1[0].time), last: utc(h1[99].time) }, saved: null },
    { period: "D1", hst: { bars: 31, first: utc(d1[0].time), last: utc(d1[30].time) }, saved: null },
  ]);
  assert.deepEqual(xauusd.periods.map((p) => [p.period, p.hst?.bars]), [["M1", 10]]);
  assert.equal(xauusd.digits, 2, "digits from the HST file without a feed");
});

test("the CSV download has the legacy columns, broker time, the symbol's digits and a UTC column", { timeout: 15000 }, async (t) => {
  const { dataFolder, connect, get } = await start(t);
  await writeHst(dataFolder, BROKER, {
    version: 401,
    symbol: "EURUSD",
    minutes: 60,
    digits: 5,
    bars: [
      { time: MIDNIGHT + 9 * HOUR, open: 1.1, high: 1.10234, low: 1.0999, close: 1.102, volume: 412, spread: 3, realVolume: 0 },
      { time: MIDNIGHT + 10 * HOUR, open: 1.102, high: 1.103, low: 1.10111, close: 1.10275, volume: 87, spread: 2, realVolume: 5 },
    ],
  });
  await connect("EURUSD");

  const res = await get(`/api/history/csv?${new URLSearchParams({ market: market("EURUSD"), period: "H1" })}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type")!, /^text\/csv/);
  assert.match(res.headers.get("content-disposition")!, /attachment; filename\*=UTF-8''EURUSD60\.csv/);
  assert.equal(
    await res.text(),
    [
      "time,open,high,low,close,tick_volume,spread,real_volume,time_utc",
      "2027-01-15 09:00:00,1.10000,1.10234,1.09990,1.10200,412,3,0,2027-01-15T07:00:00Z",
      "2027-01-15 10:00:00,1.10200,1.10300,1.10111,1.10275,87,2,5,2027-01-15T08:00:00Z",
      "",
    ].join("\n"),
  );
});

test("the HST download is a v401 file in broker time that reads back bar for bar", { timeout: 15000 }, async (t) => {
  const { dataFolder, connect, get } = await start(t);
  // A v400 source: the download is v401 all the same.
  const d1 = bars(MIDNIGHT - 40 * DAY, DAY, 40);
  await writeHst(dataFolder, BROKER, { version: 400, symbol: "EURUSD", minutes: 1440, digits: 5, bars: d1 });
  await connect("EURUSD");

  const res = await get(`/api/history/hst?${new URLSearchParams({ market: market("EURUSD"), period: "D1" })}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition")!, /filename\*=UTF-8''EURUSD1440\.hst/);
  const out = await mkdtemp(join(tmpdir(), "quotebridge-download-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  const path = join(out, "EURUSD1440.hst");
  await writeFile(path, Buffer.from(await res.arrayBuffer()));
  const file = (await HstFile.open(path))!;
  assert.deepEqual(file.header, { version: 401, symbol: "EURUSD", minutes: 1440, digits: 5 });
  const { bars: back, complete } = await file.before(undefined, 1000);
  assert.equal(complete, true);
  assert.deepEqual(
    back,
    d1.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, tickVolume: b.volume, spread: 0, realVolume: 0 })),
  );
});

test("a download of an unknown market or period, or with a malformed query, is refused", { timeout: 15000 }, async (t) => {
  const { dataFolder, connect, get } = await start(t);
  await writeHst(dataFolder, BROKER, { version: 401, symbol: "EURUSD", minutes: 60, digits: 5, bars: bars(MIDNIGHT, HOUR, 3) });
  await connect("EURUSD");
  const status = async (query: Record<string, string>) => (await get(`/api/history/csv?${new URLSearchParams(query)}`)).status;
  assert.equal(await status({ market: market("EURUSD"), period: "M5" }), 404, "no M5 file");
  assert.equal(await status({ market: market("GBPUSD"), period: "H1" }), 404);
  assert.equal(await status({ market: market("EURUSD"), period: "H2" }), 400);
  assert.equal(await status({ market: "EURUSD", period: "H1" }), 400);
  assert.equal(await status({ period: "H1" }), 400);
});

test("a recorded market stays listed after its terminal is gone, with its recording state", { timeout: 20000 }, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "quotebridge-history-db-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const first = await openDatabase(folder);
  const before = await start(t, { database: first });
  await before.connect("GBPUSD");
  const on = await before.post("/api/markets/recording", { brokerServer: BROKER, symbol: "GBPUSD", on: true });
  assert.equal(on.status, 200);
  await before.stop();
  await first.checkpointAndClose();

  const database = await openDatabase(folder);
  const after = await start(t, { database });
  t.after(() => database.checkpointAndClose());
  const { markets } = await after.list();
  assert.deepEqual(
    markets.map(({ symbol, brokerServer, terminals, recording, periods }) => ({ symbol, brokerServer, terminals, recording, periods })),
    [{ symbol: "GBPUSD", brokerServer: BROKER, terminals: [], recording: true, periods: [] }],
  );
});

test("with two terminals on one broker server, each period comes from the file with the newest bar", { timeout: 15000 }, async (t) => {
  const other = await mkdtemp(join(tmpdir(), "quotebridge-history-other-"));
  t.after(() => rm(other, { recursive: true, force: true }));
  const SECOND = "mt4-bbbbbbbbbbbb";
  let main = "";
  const { dataFolder, connect, get, list } = await start(t, { terminalDataFolder: (id) => (id === TERMINAL ? main : id === SECOND ? other : undefined) });
  main = dataFolder;
  // The first terminal's H1 file stopped a week ago; the second's is current but shorter. Only the first has D1.
  await writeHst(dataFolder, BROKER, { version: 401, symbol: "EURUSD", minutes: 60, digits: 5, bars: bars(MIDNIGHT - 7 * DAY - 500 * HOUR, HOUR, 500) });
  await writeHst(dataFolder, BROKER, { version: 401, symbol: "EURUSD", minutes: 1440, digits: 5, bars: bars(MIDNIGHT - 10 * DAY, DAY, 10) });
  const current = bars(MIDNIGHT - 50 * HOUR, HOUR, 50);
  await writeHst(other, BROKER, { version: 401, symbol: "EURUSD", minutes: 60, digits: 5, bars: current });
  await connect("EURUSD");
  await connect("EURUSD", SECOND);

  const [eurusd] = (await list()).markets;
  assert.deepEqual(eurusd.terminals.map((x) => x.terminalId), [TERMINAL, SECOND]);
  assert.deepEqual(eurusd.periods.map((p) => [p.period, p.hst?.bars]), [["H1", 50], ["D1", 10]]);
  const csv = await (await get(`/api/history/csv?${new URLSearchParams({ market: market("EURUSD"), period: "H1" })}`)).text();
  assert.equal(csv.trim().split("\n").length, 51);
});

test("a terminal on the broker server whose data folder is unknown is still named, though its HST cannot be read", { timeout: 15000 }, async (t) => {
  const { connect, list } = await start(t);
  await connect("EURUSD", "mt4-cccccccccccc");
  const [eurusd] = (await list()).markets;
  assert.deepEqual(eurusd.terminals, [{ terminalId: "mt4-cccccccccccc", name: "mt4-cccccccccccc" }]);
  assert.deepEqual(eurusd.periods, []);
});

test("a download longer than one read page comes whole and in order", { timeout: 15000 }, async (t) => {
  const { dataFolder, connect, get } = await start(t);
  const m1 = bars(MIDNIGHT - 10_000 * MINUTE, MINUTE, 10_000);
  await writeHst(dataFolder, BROKER, { version: 401, symbol: "EURUSD", minutes: 1, digits: 5, bars: m1 });
  await connect("EURUSD");
  const csv = (await (await get(`/api/history/csv?${new URLSearchParams({ market: market("EURUSD"), period: "M1" })}`)).text()).trim().split("\n");
  assert.equal(csv.length, 10_001);
  const stamp = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 19).replace("T", " ");
  assert.deepEqual([csv[1].split(",")[0], csv[4097].split(",")[0], csv[10_000].split(",")[0]], [stamp(m1[0].time), stamp(m1[4096].time), stamp(m1[9999].time)]);
});
