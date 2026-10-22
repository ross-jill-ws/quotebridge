// Chart history over HTTP: /api/candles pages backwards through the terminal's HST files (v400 and v401), rolls a
// period up from M1 when it has no file, joins the live candles on (HST wins for closed bars), falls back to live
// candles without HST, and says when no older bars exist. Real server, fake EAs, HST files in a temp folder.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerConfig } from "../src/server/index.js";
import { FakeClock, FakeEA } from "./fake-ea.js";
import { freePort } from "./free-port.js";
import { appendHst, bars, writeHst } from "./hst-fixtures.js";

const TOKEN = "window-token-0123456789";
const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;
const BROKER = "EasyForex-Demo";
const TERMINAL = "mt4-aaaaaaaaaaaa";
/** The server's clock: 15 January 2027 08:00 UTC, 10:00 on the GMT+2 broker (winter). */
const NOW = Date.UTC(2027, 0, 15, 8);
/** Broker seconds of 15 January 2027 10:00. */
const TEN = Date.UTC(2027, 0, 15, 10) / 1000;
/** Broker seconds to UTC seconds on this broker in winter. */
const utc = (broker: number) => broker - 2 * HOUR;

type Page = { candles: { time: number; open: number; high: number; low: number; close: number }[]; source: string; complete: boolean };

async function start(t: TestContext, overrides: Partial<ServerConfig> = {}) {
  const dataFolder = await mkdtemp(join(tmpdir(), "quotebridge-hst-"));
  t.after(() => rm(dataFolder, { recursive: true, force: true }));
  const clock = new FakeClock(NOW);
  const cfg: ServerConfig = {
    eaPort: await freePort(),
    httpPort: await freePort(),
    windowToken: TOKEN,
    now: clock.now,
    localOffsetMinutes: () => 0,
    terminalDataFolder: (terminalId) => (terminalId === TERMINAL ? dataFolder : undefined),
    ...overrides,
  };
  const server = await startServer(cfg);
  t.after(() => server.close());
  const origin = server.httpOrigin;
  const signIn = await fetch(`${origin}/session?token=${TOKEN}`, { redirect: "manual" });
  const cookie = signIn.headers.get("set-cookie")!.split(";")[0];
  const rule = await fetch(`${origin}/api/clock-rules`, {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify({ brokerServer: BROKER, winterOffsetMinutes: 120, dst: "us" }),
  });
  assert.equal(rule.status, 200);
  const chart = new FakeEA({ terminal: TERMINAL, broker: BROKER, symbol: "EURUSD" }).connect(`tcp://127.0.0.1:${cfg.eaPort}`);
  t.after(() => chart.close());
  await chart.request(chart.helloWire());
  let seq = 0;
  /** Live quotes as [broker seconds, bid]. */
  const send = (quotes: [number, number][]) => chart.request(chart.tickWire(quotes.map(([quoteTime, bid]) => ({ seq: ++seq, bid, ask: bid + 0.0002, quoteTime, sampledTime: quoteTime }))));
  const feed = JSON.stringify([TERMINAL, "EURUSD"]);
  const get = (query: Record<string, string | number>) =>
    fetch(`${origin}/api/candles?${new URLSearchParams({ feed, ...Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])) })}`, { headers: { cookie } });
  const page = async (period: string, limit: number, before?: number) => {
    const res = await get({ period, limit, ...(before === undefined ? {} : { before }) });
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json()) as Page;
  };
  return { dataFolder, send, page, get };
}

const times = (p: Page) => p.candles.map((c) => c.time);

test("the chart pages backwards through the period's HST file (v401), with the live candles joined on after its last bar", { timeout: 15000 }, async (t) => {
  const { dataFolder, send, page } = await start(t);
  // 1,200 H1 bars ending at 09:00 on 9 January; the app has seen quotes this morning.
  const first = TEN - 6 * DAY - 1200 * HOUR;
  const hst = bars(first, HOUR, 1200);
  await writeHst(dataFolder, BROKER, { version: 401, symbol: "EURUSD", minutes: 60, digits: 5, bars: hst });
  await send([[TEN - HOUR + 30, 1.2], [TEN + 5, 1.21]]);

  const latest = await page("H1", 500);
  assert.equal(latest.source, "hst");
  assert.equal(latest.complete, false);
  assert.equal(latest.candles.length, 500);
  assert.deepEqual(times(latest).slice(-2), [utc(TEN - HOUR), utc(TEN)], "the live candles after the HST file's last bar");
  assert.deepEqual(times(latest).slice(0, -2), hst.slice(-498).map((b) => utc(b.time)));
  assert.deepEqual(latest.candles[0], { time: utc(hst[702].time), open: hst[702].open, high: hst[702].high, low: hst[702].low, close: hst[702].close });

  const older = await page("H1", 500, latest.candles[0].time);
  assert.deepEqual(times(older), hst.slice(202, 702).map((b) => utc(b.time)));
  assert.equal(older.complete, false);
  const oldest = await page("H1", 500, older.candles[0].time);
  assert.deepEqual(times(oldest), hst.slice(0, 202).map((b) => utc(b.time)));
  assert.equal(oldest.complete, true, "no older bars exist");
  assert.deepEqual((await page("H1", 500, oldest.candles[0].time)).candles, []);
});

test("HST wins for closed bars; the bar still forming keeps HST's open with the live high, low and close; live bars follow", { timeout: 15000 }, async (t) => {
  const { dataFolder, send, page } = await start(t);
  // MetaTrader has written 08:00, 09:00 and the 10:00 bar so far.
  const hst = [
    { time: TEN - 2 * HOUR, open: 1.09, high: 1.093, low: 1.088, close: 1.092 },
    { time: TEN - HOUR, open: 1.092, high: 1.1, low: 1.09, close: 1.1 },
    { time: TEN, open: 1.1, high: 1.105, low: 1.095, close: 1.1 },
  ];
  await writeHst(dataFolder, BROKER, { version: 401, symbol: "EURUSD", minutes: 60, digits: 5, bars: hst });
  // The app started at 09:30: its own 09:00 candle is partial.
  await send([[TEN - 30 * MINUTE, 1.2], [TEN + 15 * MINUTE, 1.101], [TEN + 20 * MINUTE, 1.12], [TEN + HOUR + 5, 1.13]]);

  const { candles, source, complete } = await page("H1", 500);
  assert.deepEqual(candles, [
    { time: utc(TEN - 2 * HOUR), open: 1.09, high: 1.093, low: 1.088, close: 1.092 },
    { time: utc(TEN - HOUR), open: 1.092, high: 1.1, low: 1.09, close: 1.1 },
    { time: utc(TEN), open: 1.1, high: 1.12, low: 1.095, close: 1.12 },
    { time: utc(TEN + HOUR), open: 1.13, high: 1.13, low: 1.13, close: 1.13 },
  ]);
  assert.equal(source, "hst");
  assert.equal(complete, true);
});

test("a period without its own file is rolled up from the M1 file (v400), bucketed on the broker clock, W1 from Sunday", { timeout: 15000 }, async (t) => {
  const { dataFolder, page } = await start(t);
  // Three days of M1 bars, Monday 11 January 2027 00:00 to Wednesday 23:59 broker time.
  const monday = Date.UTC(2027, 0, 11) / 1000;
  const m1 = bars(monday, MINUTE, 3 * 1440);
  await writeHst(dataFolder, BROKER, { version: 400, symbol: "EURUSD", minutes: 1, digits: 5, bars: m1 });

  const h4 = await page("H4", 5);
  assert.equal(h4.candles.length, 5);
  const fourHours = (start: number) => m1.filter((b) => b.time >= start && b.time < start + 4 * HOUR);
  const expected = (start: number) => {
    const inside = fourHours(start);
    return { time: utc(start), open: inside[0].open, high: Math.max(...inside.map((b) => b.high)), low: Math.min(...inside.map((b) => b.low)), close: inside.at(-1)!.close };
  };
  const lastStart = monday + 3 * DAY - 4 * HOUR;
  assert.deepEqual(h4.candles, [4, 3, 2, 1, 0].map((n) => expected(lastStart - n * 4 * HOUR)));
  assert.equal(h4.source, "hst");
  assert.equal(h4.complete, false);

  // Paging back to the first M1 bar: 18 H4 bars in all.
  const rest = await page("H4", 500, h4.candles[0].time);
  assert.equal(rest.candles.length, 13);
  assert.deepEqual(rest.candles[0], expected(monday));
  assert.equal(rest.complete, true);

  // D1 bars start at broker midnight (22:00 UTC the day before); the week began on Sunday 10 January.
  assert.deepEqual(times(await page("D1", 500)), [0, 1, 2].map((n) => utc(monday + n * DAY)));
  assert.deepEqual(times(await page("W1", 500)), [utc(monday - DAY)]);
});

test("without HST the chart has the live candles only, paged the same way", { timeout: 15000 }, async (t) => {
  const { send, page } = await start(t);
  await send([[TEN, 1.1], [TEN + MINUTE, 1.2], [TEN + 2 * MINUTE, 1.3]]);

  const latest = await page("M1", 2);
  assert.deepEqual(latest.candles.map((c) => c.close), [1.2, 1.3]);
  assert.deepEqual([latest.source, latest.complete], ["live", false]);
  const older = await page("M1", 2, latest.candles[0].time);
  assert.deepEqual(older.candles.map((c) => [c.time, c.close]), [[utc(TEN), 1.1]]);
  assert.equal(older.complete, true);
  assert.equal((await page("M1", 500)).complete, true);
});

test("a file MetaTrader appends to while it is read keeps paging; a half-written record is left out", { timeout: 15000 }, async (t) => {
  const { dataFolder, page } = await start(t);
  const first = TEN - 2000 * MINUTE;
  const m1 = bars(first, MINUTE, 1000);
  const path = await writeHst(dataFolder, BROKER, { version: 401, symbol: "EURUSD", minutes: 1, digits: 5, bars: m1 });
  const latest = await page("M1", 500);
  assert.deepEqual(times(latest), m1.slice(500).map((b) => utc(b.time)));

  // MetaTrader adds ten bars and is half-way through the next record.
  const more = bars(first + 1000 * MINUTE, MINUTE, 10);
  await appendHst(path, 401, more, 30);
  const older = await page("M1", 500, latest.candles[0].time);
  assert.deepEqual(times(older), m1.slice(0, 500).map((b) => utc(b.time)));
  assert.equal(older.complete, true);
  assert.deepEqual(times(await page("M1", 10)), more.map((b) => utc(b.time)));
});

test("a before that is not UTC seconds is refused", { timeout: 15000 }, async (t) => {
  const { get } = await start(t);
  for (const before of ["-1", "1.5", "abc", "", "99999999999999"]) assert.equal((await get({ period: "M1", before })).status, 400, `before ${before}`);
  assert.equal((await get({ period: "M1", before: 1800000000 })).status, 200);
});

test("a roll-up pages on past a long run of M1 bars that cannot be right, to the first good bar", { timeout: 15000 }, async (t) => {
  const { dataFolder, page } = await start(t);
  const first = Date.UTC(2027, 0, 4) / 1000;
  const good = bars(first, MINUTE, 1440);
  // A day and more of damaged records (high below low), longer than one read, then good bars again.
  const damaged = bars(first + 1440 * MINUTE, MINUTE, 6000).map((b) => ({ ...b, high: b.low - 0.001 }));
  const recent = bars(first + 7440 * MINUTE, MINUTE, 1440);
  await writeHst(dataFolder, BROKER, { version: 401, symbol: "EURUSD", minutes: 1, digits: 5, bars: [...good, ...damaged, ...recent] });

  const d1 = await page("D1", 500);
  assert.equal(d1.complete, true);
  assert.equal(d1.candles[0].time, utc(first), "the first good day is reached");
});
