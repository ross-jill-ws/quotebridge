import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { startServer, type ServerConfig } from "../src/server/index.js";
import { FakeClock, FakeEA, type FakeEAOptions, type Quote } from "./fake-ea.js";
import { freePort } from "./free-port.js";

const TOKEN = "window-token-0123456789";

/** Monday 19 October 2026 00:00 in broker server time, in seconds. */
const MONDAY = 1792368000;
const MINUTE = 60;

type Candles = { feed: string; period: string; digits: number; since: number; ask: number | null; candles: { time: number; open: number; high: number; low: number; close: number }[] };

async function start(t: TestContext, overrides: Partial<ServerConfig> = {}) {
  const cfg: ServerConfig = { eaPort: await freePort(), httpPort: await freePort(), windowToken: TOKEN, ...overrides };
  const server = await startServer(cfg);
  t.after(() => server.close());
  const origin = server.httpOrigin;
  const signIn = await fetch(`${origin}/session?token=${TOKEN}`, { redirect: "manual" });
  const cookie = signIn.headers.get("set-cookie")!.split(";")[0];
  const ea = async (options?: FakeEAOptions) => {
    const fake = new FakeEA(options).connect(`tcp://127.0.0.1:${cfg.eaPort}`);
    t.after(() => fake.close());
    await fake.request(fake.helloWire());
    return fake;
  };
  const get = (query: string, headers: Record<string, string> = { cookie }) => fetch(`${origin}/api/candles?${query}`, { headers });
  const candles = async (feed: string, period = "M1", limit?: number) => {
    const res = await get(new URLSearchParams({ feed, period, ...(limit === undefined ? {} : { limit: String(limit) }) }).toString());
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json()) as Candles;
  };
  const remove = (feed: string) =>
    fetch(`${origin}/api/feeds/remove`, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify({ feed }) });
  return { ea, get, candles, remove };
}

/** Sends quotes in batches of at most 32, as the EA does, numbering them from `firstSeq`. */
async function send(chart: FakeEA, quotes: Omit<Quote, "seq">[], firstSeq = 1) {
  for (let i = 0; i < quotes.length; i += 32) {
    await chart.request(chart.tickWire(quotes.slice(i, i + 32).map((q, j) => ({ ...q, seq: firstSeq + i + j }))));
  }
}

const bid = (quoteTime: number, bid: number) => ({ quoteTime, bid, ask: bid + 0.0002 });
const feedOf = (chart: FakeEA) => JSON.stringify([chart.terminal, chart.broker, chart.symbol]);
const ohlc = (c: Candles) => c.candles.map((k) => [k.time, k.open, k.high, k.low, k.close]);

test("samples become M1 bid candles bucketed by quote time", { timeout: 10000 }, async (t) => {
  const { ea, candles } = await start(t);
  const chart = await ea({ symbol: "EURUSD", digits: 5 });

  await send(chart, [
    bid(MONDAY + 5, 1.1),
    bid(MONDAY + 20, 1.1004),
    bid(MONDAY + 40, 1.0998),
    bid(MONDAY + 59, 1.1001),
    bid(MONDAY + 60, 1.1002),
  ]);

  const m1 = await candles(feedOf(chart));
  assert.equal(m1.feed, feedOf(chart));
  assert.equal(m1.period, "M1");
  assert.equal(m1.digits, 5);
  assert.deepEqual(ohlc(m1), [
    [MONDAY, 1.1, 1.1004, 1.0998, 1.1001],
    [MONDAY + MINUTE, 1.1002, 1.1002, 1.1002, 1.1002],
  ]);
});

test("higher periods aggregate the M1 candles, and minutes without samples have no candle", { timeout: 10000 }, async (t) => {
  const { ea, candles } = await start(t);
  const chart = await ea();
  const HOUR = 3600;
  // Sunday 23:58 to Monday 04:00, with a gap from 00:07 to 03:59.
  await send(chart, [
    bid(MONDAY - 2 * MINUTE, 1.2),
    bid(MONDAY - MINUTE + 30, 1.21),
    bid(MONDAY, 1.19),
    bid(MONDAY + 4 * MINUTE, 1.22),
    bid(MONDAY + 5 * MINUTE, 1.18),
    bid(MONDAY + 6 * MINUTE + 59, 1.185),
    bid(MONDAY + 4 * HOUR, 1.3),
  ]);
  const feed = feedOf(chart);

  assert.deepEqual(ohlc(await candles(feed, "M1")), [
    [MONDAY - 120, 1.2, 1.2, 1.2, 1.2],
    [MONDAY - 60, 1.21, 1.21, 1.21, 1.21],
    [MONDAY, 1.19, 1.19, 1.19, 1.19],
    [MONDAY + 240, 1.22, 1.22, 1.22, 1.22],
    [MONDAY + 300, 1.18, 1.18, 1.18, 1.18],
    [MONDAY + 360, 1.185, 1.185, 1.185, 1.185],
    [MONDAY + 14400, 1.3, 1.3, 1.3, 1.3],
  ]);
  assert.deepEqual(ohlc(await candles(feed, "M5")), [
    [MONDAY - 300, 1.2, 1.21, 1.2, 1.21],
    [MONDAY, 1.19, 1.22, 1.19, 1.22],
    [MONDAY + 300, 1.18, 1.185, 1.18, 1.185],
    [MONDAY + 14400, 1.3, 1.3, 1.3, 1.3],
  ]);
  for (const period of ["M15", "M30", "H1", "H4"]) {
    assert.deepEqual(
      ohlc(await candles(feed, period)),
      [
        [MONDAY - { M15: 900, M30: 1800, H1: 3600, H4: 14400 }[period]!, 1.2, 1.21, 1.2, 1.21],
        [MONDAY, 1.19, 1.22, 1.18, 1.185],
        [MONDAY + 14400, 1.3, 1.3, 1.3, 1.3],
      ],
      period,
    );
  }
  assert.deepEqual(ohlc(await candles(feed, "D1")), [
    [MONDAY - 86400, 1.2, 1.21, 1.2, 1.21],
    [MONDAY, 1.19, 1.3, 1.18, 1.3],
  ]);
});

test("W1 candles start on Monday 00:00 and MN1 candles on the 1st of the calendar month", { timeout: 10000 }, async (t) => {
  const { ea, candles } = await start(t);
  const chart = await ea();
  const DAY = 86400;
  // Wed 30 Sep 2026, Thu 1 Oct, Sun 18 Oct 23:59, Mon 19 Oct, Sat 31 Oct 23:59:30, Sun 1 Nov.
  const SEP_30 = 1790726400;
  const OCT_1 = 1790812800;
  const NOV_1 = 1793491200;
  await send(chart, [
    bid(SEP_30 + 600, 1.1),
    bid(OCT_1, 1.12),
    bid(MONDAY - MINUTE, 1.09),
    bid(MONDAY, 1.15),
    bid(NOV_1 - 30, 1.13),
    bid(NOV_1, 1.14),
  ]);
  const feed = feedOf(chart);

  assert.deepEqual(ohlc(await candles(feed, "W1")), [
    [OCT_1 - 3 * DAY, 1.1, 1.12, 1.1, 1.12], // Mon 28 Sep
    [MONDAY - 7 * DAY, 1.09, 1.09, 1.09, 1.09], // Mon 12 Oct
    [MONDAY, 1.15, 1.15, 1.15, 1.15],
    [MONDAY + 7 * DAY, 1.13, 1.14, 1.13, 1.14], // Mon 26 Oct: Sat 31 Oct and Sun 1 Nov
  ]);
  assert.deepEqual(ohlc(await candles(feed, "MN1")), [
    [1788220800, 1.1, 1.1, 1.1, 1.1], // 1 Sep 2026
    [OCT_1, 1.12, 1.15, 1.09, 1.13],
    [NOV_1, 1.14, 1.14, 1.14, 1.14],
  ]);
});

test("the answer says since when candles are built and the latest ask, and limit keeps the latest candles", { timeout: 10000 }, async (t) => {
  const clock = new FakeClock(1_800_000_000_000);
  const { ea, candles } = await start(t, { now: clock.now });
  clock.advance(60_000);
  const chart = await ea({ symbol: "USDJPY", digits: 3 });
  assert.equal((await candles(feedOf(chart))).ask, null);
  await send(chart, [bid(MONDAY, 150.1), bid(MONDAY + MINUTE, 150.2), { quoteTime: MONDAY + 2 * MINUTE, bid: 150.3, ask: 150.318 }]);

  const answer = await candles(feedOf(chart), "M1", 2);
  assert.equal(answer.since, 1_800_000_000_000);
  assert.equal(answer.digits, 3);
  assert.equal(answer.ask, 150.318);
  assert.deepEqual(answer.candles.map((c) => c.close), [150.2, 150.3]);
  assert.deepEqual((await candles(feedOf(chart), "H1", 5)).candles.map((c) => c.close), [150.3]);
});

test("unknown feeds, unknown periods, bad limits and requests without a session are refused", { timeout: 10000 }, async (t) => {
  const { ea, get } = await start(t);
  const chart = await ea();
  const feed = feedOf(chart);
  const status = async (query: Record<string, string>, headers?: Record<string, string>) => (await get(new URLSearchParams(query).toString(), headers)).status;

  assert.equal(await status({ feed: '["mt4-ffffffffffff","Demo-Broker","EURUSD"]', period: "M1" }), 404);
  assert.equal(await status({ period: "M1" }), 404);
  assert.equal(await status({ feed, period: "M2" }), 400);
  assert.equal(await status({ feed }), 400);
  assert.equal(await status({ feed, period: "toString" }), 400);
  for (const limit of ["0", "-1", "1.5", "abc", "10081", ""]) assert.equal(await status({ feed, period: "M1", limit }), 400, `limit ${limit}`);
  assert.equal(await status({ feed, period: "M1", limit: "10080" }), 200);
  assert.equal(await status({ feed, period: "M1" }, {}), 401);
});

test("a removed feed loses its candles; an EA that says hello again starts them afresh", { timeout: 10000 }, async (t) => {
  const clock = new FakeClock();
  const { ea, get, candles, remove } = await start(t, { now: clock.now });
  const chart = await ea();
  const feed = feedOf(chart);
  await send(chart, [bid(MONDAY, 1.1)]);
  assert.equal((await candles(feed)).candles.length, 1);

  clock.advance(7000);
  assert.equal((await remove(feed)).status, 204);
  assert.equal((await get(new URLSearchParams({ feed, period: "M1" }).toString())).status, 404);

  await chart.request(chart.helloWire());
  assert.deepEqual((await candles(feed)).candles, []);
  await send(chart, [bid(MONDAY + MINUTE, 1.2)], 2);
  assert.deepEqual(ohlc(await candles(feed)), [[MONDAY + MINUTE, 1.2, 1.2, 1.2, 1.2]]);
});

test("each feed keeps at most 7 days of M1 candles, oldest dropped, with many feeds ticking", { timeout: 60000 }, async (t) => {
  const { ea, candles } = await start(t);
  const charts = await Promise.all(["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCHF", "XAUUSD"].map((symbol) => ea({ symbol })));
  const minutes = 10080 + 25;

  // Every feed sends one sample a minute for 7 days and 25 minutes.
  await Promise.all(charts.map((chart, n) => send(chart, Array.from({ length: minutes }, (_, i) => bid(MONDAY + i * MINUTE, 1 + n + i / 1e6)))));

  for (const [n, chart] of charts.entries()) {
    const m1 = (await candles(feedOf(chart))).candles;
    assert.equal(m1.length, 10080, chart.symbol);
    assert.equal(m1[0].time, MONDAY + 25 * MINUTE, chart.symbol);
    assert.equal(m1.at(-1)!.close, 1 + n + (minutes - 1) / 1e6, chart.symbol);
    const w1 = (await candles(feedOf(chart), "W1")).candles;
    assert.deepEqual(w1.map((c) => c.time), [MONDAY, MONDAY + 7 * 86400], chart.symbol);
    assert.equal(w1[0].open, 1 + n + 25 / 1e6, chart.symbol);
  }
});
