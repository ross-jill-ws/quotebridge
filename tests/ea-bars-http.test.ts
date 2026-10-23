// Chart history from the EA's bars over HTTP: when a period has no HST file or a stale one, the server asks the feed's
// EA (1.10+) for its last 900 closed bars, keeps them in saved history and joins them between the HST bars and the live
// candles. A loading answer is asked again; an older EA leaves the chart as it was. Real server and database in temp
// folders, fake EAs answering bar requests, HST fixtures, a fake clock.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryMarket } from "../src/server/history/index.js";
import { openDatabase, startServer, type ServerConfig } from "../src/server/index.js";
import { brokerToUtc, UNKNOWN_RULE, utcToBroker, type ClockRule } from "../src/shared/clock.js";
import { bucketStart, PERIODS, type Period } from "../src/shared/periods.js";
import { FakeClock, FakeEA, type BarAnswer, type FakeBar } from "./fake-ea.js";
import { freePort } from "./free-port.js";
import { bars, writeHst } from "./hst-fixtures.js";
import { fakeFeeds } from "../scripts/dev/fake-feeds.js";

const TOKEN = "window-token-0123456789";
const MINUTE = 60;
const HOUR = 3600;
const BROKER = "EasyForex-Demo";
const TERMINAL = "mt4-aaaaaaaaaaaa";
/** The server's clock: 15 January 2027 08:00 UTC, 10:00 on the GMT+2 broker (winter). */
const NOW = Date.UTC(2027, 0, 15, 8);
/** Broker seconds of 15 January 2027 10:00. */
const TEN = Date.UTC(2027, 0, 15, 10) / 1000;
const RULE: ClockRule = { winterOffsetMinutes: 120, dst: "us" };
const utc = (broker: number) => brokerToUtc(RULE, broker * 1000) / 1000;
const FEED = JSON.stringify([TERMINAL, "EURUSD"]);
const EURUSD = JSON.stringify([BROKER, "EURUSD"]);

type Candle = { time: number; open: number; high: number; low: number; close: number };
type Page = { candles: Candle[]; source: string; complete: boolean; filling: boolean; clockRule: ClockRule | null; ask: number | null };

/** `count` closed intraday bars of `timeframe` minutes, the newest one closed by 10:00. */
const closedBars = (timeframe: number, count: number, price = 1.2): FakeBar[] =>
  bars(TEN - count * timeframe * MINUTE, timeframe * MINUTE, count, price).map((b) => ({ ...b, ...round(b) }));
/** Prices as the EA sends them: five digits. */
const round = ({ open, high, low, close }: Candle) => ({ open: +open.toFixed(5), high: +high.toFixed(5), low: +low.toFixed(5), close: +close.toFixed(5) });
/** An EA with every period's last bars at hand: 900, or 200 weeks or months (fewer than asked for, as MetaTrader may hold). */
const ready: BarAnswer = (timeframe, count) => closedBars(timeframe, timeframe >= 10080 ? 200 : count);

async function tempFolder(t: TestContext, name: string) {
  const folder = await mkdtemp(join(tmpdir(), `quotebridge-${name}-`));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

/** A server with its database in `dbFolder`; `stop` closes it, then CHECKPOINTs. */
async function start(t: TestContext, dbFolder: string, dataFolder: string, overrides: Partial<ServerConfig> = {}) {
  const database = await openDatabase(dbFolder);
  const cfg: ServerConfig = {
    eaPort: await freePort(),
    httpPort: await freePort(),
    windowToken: TOKEN,
    now: new FakeClock(NOW).now,
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
  const rule = await fetch(`${origin}/api/clock-rules`, {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify({ brokerServer: BROKER, ...RULE }),
  });
  assert.equal(rule.status, 200);
  let seq = 0;
  /** A chart of EURUSD on the H1 chart period, which sends a live quote at 10:00:30 broker time. */
  const connect = async (answer: BarAnswer | undefined, eaVersion = "1.10") => {
    const ea = new FakeEA({ terminal: TERMINAL, broker: BROKER, symbol: "EURUSD", timeframe: 60, eaVersion, bars: answer }).connect(`tcp://127.0.0.1:${cfg.eaPort}`);
    t.after(() => ea.close());
    await ea.request(ea.helloWire());
    await ea.request(ea.tickWire([{ seq: ++seq, bid: 1.25, ask: 1.2502, quoteTime: TEN + 30 }]));
    return ea;
  };
  const page = async (period: string, limit = 2000, before?: number, feed = FEED) => {
    const res = await fetch(`${origin}/api/candles?${new URLSearchParams({ feed, period, limit: String(limit), ...(before === undefined ? {} : { before: String(before) }) })}`, { headers: { cookie } });
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json()) as Page;
  };
  /** The latest page once the EA's bars are in (or none are coming). */
  const settled = async (period: string, limit = 2000, feed = FEED) => {
    for (let i = 0; ; i++) {
      const p = await page(period, limit, undefined, feed);
      if (!p.filling) return p;
      if (i > 100) assert.fail(`${period} kept filling`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const markets = async () => {
    const res = await fetch(`${origin}/api/history`, { headers: { cookie } });
    return ((await res.json()) as { markets: HistoryMarket[] }).markets;
  };
  /** The rows of a period's CSV download: broker time and close. */
  const csv = async (period: string) => {
    const res = await fetch(`${origin}/api/history/csv?${new URLSearchParams({ market: EURUSD, period })}`, { headers: { cookie } });
    assert.equal(res.status, 200);
    return (await res.text()).trim().split("\n").slice(1).map((row) => row.split(",").slice(0, 5).join(","));
  };
  /** Saves the market's HST files once ("Save this history") and waits for the save to finish. */
  const save = async () => {
    const res = await fetch(`${origin}/api/history/save`, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify({ market: EURUSD }) });
    assert.equal(res.status, 202, await res.clone().text());
    for (let i = 0; (await markets()).find((m) => m.market === EURUSD)?.saving; i++) {
      if (i > 100) assert.fail("the save did not finish");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  return { connect, page, settled, markets, csv, save, stop, endpoint: `tcp://127.0.0.1:${cfg.eaPort}` };
}

/** A fake bar as the page hands it out. */
const shown = (b: FakeBar): Candle => ({ time: utc(b.time), open: b.open, high: b.high, low: b.low, close: b.close });
/** The live candle of the quote at 10:00:30. */
const LIVE = { time: utc(TEN), open: 1.25, high: 1.25, low: 1.25, close: 1.25 };
/** The live candle of a period. */
const live = (period: Period) => ({ ...LIVE, time: utc(bucketStart(TEN + 30, period)) });
const MINUTES: Record<Period, number> = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440, W1: 10080, MN1: 43200 };

test("with no HST file for its chart period, a feed that connects gets the EA's last 900 bars, then the live candle", { timeout: 20000 }, async (t) => {
  const { connect, settled } = await start(t, await tempFolder(t, "db"), await tempFolder(t, "hst"));
  const ea = await connect(ready);

  const h1 = await settled("H1");
  assert.deepEqual(h1.candles, [...closedBars(60, 900).map(shown), LIVE]);
  assert.equal(h1.source, "saved");
  assert.deepEqual(ea.barRequests, [[60, 900, 0]]);
});

test("every period from M1 to MN1 the chart opens without an HST file is asked of the EA, not only its chart period", { timeout: 30000 }, async (t) => {
  const { connect, page, settled } = await start(t, await tempFolder(t, "db"), await tempFolder(t, "hst"));
  const ea = await connect(ready);

  for (const period of PERIODS) {
    // The first page is either full or says it is filling, however fast the EA answers: never the live candle, done.
    const first = await page(period);
    assert.ok(first.filling || first.candles.length > 1, period);
    const p = await settled(period);
    const count = period === "W1" || period === "MN1" ? 200 : 900;
    assert.deepEqual(p.candles, [...closedBars(MINUTES[period], count).map(shown), live(period)], period);
  }
  assert.deepEqual(ea.barRequests.map(([timeframe]) => timeframe).sort((a, b) => a - b), Object.values(MINUTES));
});

/** Every candle of a period, paging back from the latest `limit` at a time. */
async function allPages(page: (period: string, limit?: number, before?: number) => Promise<Page>, period: string, limit: number) {
  let p = await page(period, limit);
  const out = [...p.candles];
  while (!p.complete) {
    p = await page(period, limit, out[0].time);
    out.unshift(...p.candles);
  }
  return out;
}

test("a stale HST file is continued by the EA's bars up to the live candle, whose bar at the file's last time replaces it", { timeout: 20000 }, async (t) => {
  const dataFolder = await tempFolder(t, "hst");
  // Ends 50 hours ago; its last bar may have been written while forming.
  const file = closedBars(60, 1000, 1.1).map((b) => ({ ...b, time: b.time - 50 * HOUR }));
  await writeHst(dataFolder, BROKER, { version: 401, symbol: "EURUSD", minutes: 60, digits: 5, bars: file });
  const { connect, settled, page } = await start(t, await tempFolder(t, "db"), dataFolder);
  await connect(ready);

  const h1 = await settled("H1");
  const ea = closedBars(60, 900);
  const expected = [...file.slice(0, -1), ...ea.slice(-51)].map(shown).concat(LIVE);
  assert.deepEqual(h1.candles, expected);
  assert.equal(h1.source, "hst");
  assert.deepEqual(await allPages(page, "H1", 170), expected);
});

test("a file staler than the EA's 900 bars keeps its last bar, then the EA's bars follow", { timeout: 20000 }, async (t) => {
  const dataFolder = await tempFolder(t, "hst");
  const file = closedBars(15, 100, 1.1).map((b) => ({ ...b, time: b.time - 1000 * 15 * MINUTE }));
  await writeHst(dataFolder, BROKER, { version: 400, symbol: "EURUSD", minutes: 15, digits: 5, bars: file });
  const { connect, settled, page } = await start(t, await tempFolder(t, "db"), dataFolder);
  await connect(ready);

  const expected = [...file, ...closedBars(15, 900)].map(shown).concat(live("M15"));
  assert.deepEqual((await settled("M15")).candles, expected);
  assert.deepEqual(await allPages(page, "M15", 64), expected);
});

test("the EA's bars are kept in saved history: after a restart the chart shows them without asking again, and the History page lists them", { timeout: 20000 }, async (t) => {
  const dbFolder = await tempFolder(t, "db");
  const dataFolder = await tempFolder(t, "hst");
  const first = await start(t, dbFolder, dataFolder);
  await first.connect(ready);
  await first.settled("H1");
  await first.settled("M5");
  await first.stop();

  const again = await start(t, dbFolder, dataFolder);
  const ea = await again.connect(ready);
  assert.deepEqual((await again.page("H1")).candles, [...closedBars(60, 900).map(shown), LIVE]);
  assert.deepEqual((await again.page("M5")).candles, [...closedBars(5, 900).map(shown), live("M5")]);
  assert.deepEqual(ea.barRequests, []);
  const periods = (await again.markets()).find((m) => m.market === EURUSD)!.periods;
  assert.deepEqual(
    periods.map((p) => [p.period, p.saved?.bars, p.saved?.last]),
    [
      ["M5", 900, utc(TEN - 5 * MINUTE)],
      ["H1", 900, utc(TEN - HOUR)],
    ],
  );
});

test("an EA still loading the period's history is asked again until its bars are in", { timeout: 20000 }, async (t) => {
  const { connect, page, settled } = await start(t, await tempFolder(t, "db"), await tempFolder(t, "hst"));
  let loading = 2;
  const ea = await connect((timeframe, count) => (loading-- > 0 ? "loading" : closedBars(timeframe, count)));

  assert.equal((await page("H1")).filling, true);
  assert.deepEqual((await settled("H1")).candles, [...closedBars(60, 900).map(shown), LIVE]);
  assert.deepEqual(ea.barRequests, [
    [60, 900, 0],
    [60, 900, 0],
    [60, 900, 0],
  ]);
});

test("an EA older than 1.10 is not asked, and the chart stays as it is, with no error", { timeout: 20000 }, async (t) => {
  const { connect, page } = await start(t, await tempFolder(t, "db"), await tempFolder(t, "hst"));
  const ea = await connect(ready, "1.09");

  const h1 = await page("H1");
  assert.deepEqual(h1, { ...h1, candles: [LIVE], source: "live", filling: false });
  assert.deepEqual(ea.barRequests, []);
});

test("an offline feed is not asked, and its chart stays as it is", { timeout: 20000 }, async (t) => {
  const clock = new FakeClock(NOW);
  const { connect, page } = await start(t, await tempFolder(t, "db"), await tempFolder(t, "hst"), { now: clock.now });
  const ea = await connect(() => "loading");
  while (!ea.barRequests.length) await new Promise((resolve) => setTimeout(resolve, 10));
  clock.advance(8000);

  const m15 = await page("M15");
  assert.deepEqual([m15.candles, m15.filling], [[live("M15")], false]);
  assert.deepEqual(ea.barRequests, [[60, 900, 0]]);
});

test("the dev run's fake feeds answer bar requests: every period shows 900 bars, one per bucket, up to the live candle", { timeout: 30000 }, async (t) => {
  const { settled, endpoint, page } = await start(t, await tempFolder(t, "db"), await tempFolder(t, "hst"), { now: Date.now });
  t.after(fakeFeeds(endpoint));
  const feed = JSON.stringify(["mt4-0123456789ab", "GBPUSD"]);
  // Until its first quote is in, with a live candle.
  while ((await page("M1", 1, undefined, feed).catch(() => undefined))?.ask == null) await new Promise((resolve) => setTimeout(resolve, 100));

  for (const period of ["M1", "M15", "H1", "D1", "MN1"] as const) {
    const { candles, clockRule } = await settled(period, 2000, feed);
    // On the broker clock, which the server may have inferred by now (until then, times are broker seconds).
    const starts = candles.map((c) => utcToBroker(clockRule ?? UNKNOWN_RULE, c.time * 1000) / 1000);
    if (period === "MN1") assert.equal(starts[0], Date.UTC(2000, 0, 1) / 1000);
    else assert.equal(candles.length >= 901, true, period);
    // One bar per bucket.
    starts.slice(1).forEach((time, i) => assert.equal(bucketStart(time - 1, period), starts[i], `${period} at ${time}`));
    assert.ok(candles.every((c) => c.low <= Math.min(c.open, c.close) && c.high >= Math.max(c.open, c.close)), period);
  }
});

test("beside a stale HST file, the History download continues into the EA's bars, which replace the file's last bar", { timeout: 20000 }, async (t) => {
  const dataFolder = await tempFolder(t, "hst");
  const file = closedBars(60, 1000, 1.1).map((b) => ({ ...b, time: b.time - 50 * HOUR }));
  await writeHst(dataFolder, BROKER, { version: 401, symbol: "EURUSD", minutes: 60, digits: 5, bars: file });
  const { connect, settled, csv } = await start(t, await tempFolder(t, "db"), dataFolder);
  await connect(ready);
  await settled("H1");

  const row = (b: FakeBar) => [new Date(b.time * 1000).toISOString().slice(0, 19).replace("T", " "), ...[b.open, b.high, b.low, b.close].map((p) => p.toFixed(5))].join(",");
  assert.deepEqual(await csv("H1"), [...file.slice(0, -1), ...closedBars(60, 900).slice(-51)].map(row));
});

test("a save after MetaTrader writes the file fills the hole between the bars saved before and the EA's", { timeout: 20000 }, async (t) => {
  const dataFolder = await tempFolder(t, "hst");
  const QUARTER = 15 * MINUTE;
  // The file as it was: 100 bars ending 1,000 bars ago, saved.
  const whole = closedBars(15, 1100, 1.1);
  await writeHst(dataFolder, BROKER, { version: 400, symbol: "EURUSD", minutes: 15, digits: 5, bars: whole.slice(0, 100) });
  const { connect, settled, save, markets } = await start(t, await tempFolder(t, "db"), dataFolder);
  await connect(ready);
  await save();
  // The EA's last 900 bars: 100 bars after the saved ones are in neither.
  await settled("M15");
  // MetaTrader writes the chart's bars when it closes.
  await writeHst(dataFolder, BROKER, { version: 400, symbol: "EURUSD", minutes: 15, digits: 5, bars: whole });
  await save();

  const m15 = (await markets()).find((m) => m.market === EURUSD)!.periods.find((p) => p.period === "M15")!;
  assert.deepEqual(m15.saved, { bars: 1100, first: utc(whole[0].time), last: utc(TEN - QUARTER) });
});

test("a request the EA drops (a newer request replaced it) is asked again after the answer timeout", { timeout: 30000 }, async (t) => {
  const { connect, page } = await start(t, await tempFolder(t, "db"), await tempFolder(t, "hst"));
  let dropped = false;
  // The first request goes unanswered.
  const ea = await connect((timeframe, count) => (dropped ? closedBars(timeframe, count) : ((dropped = true), [])));

  for (let i = 0; (await page("H1")).filling; i++) {
    if (i > 150) assert.fail("H1 kept filling");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.deepEqual((await page("H1")).candles, [...closedBars(60, 900).map(shown), LIVE]);
  assert.equal(ea.barRequests.length, 2);
});
