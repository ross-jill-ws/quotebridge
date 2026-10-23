// Chart history over HTTP: /api/candles pages backwards through the terminal's HST files (v400 and v401), rolls a
// period up from its fill file (M1, or D1 for W1 and MN1) when it has no file or a stale one, joins the live candles on
// (HST wins for closed bars), falls back to live candles without HST, and says when no older bars exist. Real server,
// fake EAs, HST files in a temp folder.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerConfig } from "../src/server/index.js";
import { brokerToUtc, type ClockRule } from "../src/shared/clock.js";
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
/** The broker's clock rule, as `start` registers it: GMT+2 in winter, US daylight-saving dates. */
const RULE: ClockRule = { winterOffsetMinutes: 120, dst: "us" };
/** Broker seconds to UTC seconds on this broker, summer or winter (the clock module has its own tests). */
const utc = (broker: number) => brokerToUtc(RULE, broker * 1000) / 1000;

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
    body: JSON.stringify({ brokerServer: BROKER, ...RULE }),
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

/** An HST bar as the page hands it out. */
const toPage = (b: Page["candles"][number]): Page["candles"][number] => ({ time: utc(b.time), open: b.open, high: b.high, low: b.low, close: b.close });

test("the chart pages backwards through the period's HST file (v401), with the live candles joined on after its last bar", { timeout: 15000 }, async (t) => {
  const { dataFolder, send, page } = await start(t);
  // 2,000 H1 bars ending at 09:00 on 9 January; the app has seen quotes this morning.
  const first = TEN - 6 * DAY - 2000 * HOUR;
  const hst = bars(first, HOUR, 2000);
  await writeHst(dataFolder, BROKER, { version: 401, symbol: "EURUSD", minutes: 60, digits: 5, bars: hst });
  await send([[TEN - HOUR + 30, 1.2], [TEN + 5, 1.21]]);

  const latest = await page("H1", 900);
  assert.equal(latest.source, "hst");
  assert.equal(latest.complete, false);
  assert.equal(latest.candles.length, 900);
  assert.deepEqual(times(latest).slice(-2), [utc(TEN - HOUR), utc(TEN)], "the live candles after the HST file's last bar");
  assert.deepEqual(times(latest).slice(0, -2), hst.slice(-898).map((b) => utc(b.time)));
  assert.deepEqual(latest.candles[0], { time: utc(hst[1102].time), open: hst[1102].open, high: hst[1102].high, low: hst[1102].low, close: hst[1102].close });

  const older = await page("H1", 900, latest.candles[0].time);
  assert.deepEqual(times(older), hst.slice(202, 1102).map((b) => utc(b.time)));
  assert.equal(older.complete, false);
  const oldest = await page("H1", 900, older.candles[0].time);
  assert.deepEqual(times(oldest), hst.slice(0, 202).map((b) => utc(b.time)));
  assert.equal(oldest.complete, true, "no older bars exist");
  assert.deepEqual((await page("H1", 900, oldest.candles[0].time)).candles, []);
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

/** Broker weekdays (Monday to Friday) from `start` up to before `end`, one D1 bar each. */
const weekdays = (start: number, end: number, price?: number) => bars(start, DAY, (end - start) / DAY, price).filter((b) => ![0, 6].includes(new Date(b.time * 1000).getUTCDay()));

/** The bars in [start, end) as one bar. */
function rolled(source: readonly Page["candles"][number][], start: number, end: number) {
  const inside = source.filter((b) => b.time >= start && b.time < end);
  return { time: utc(start), open: inside[0].open, high: Math.max(...inside.map((b) => b.high)), low: Math.min(...inside.map((b) => b.low)), close: inside.at(-1)!.close };
}

const WEEK = 7 * DAY;
/** Sunday 10 January 2027, the current week's start in broker time. */
const SUNDAY = Date.UTC(2027, 0, 10) / 1000;

test("a stale W1 file continues with weeks rolled up from the D1 file, its last (forming) week replaced, then pages back to its own bars", { timeout: 15000 }, async (t) => {
  const { dataFolder, page } = await start(t);
  // MetaTrader last wrote the W1 file three weeks ago, while that week was forming; the D1 file is current to Thursday.
  const ownLast = SUNDAY - 3 * WEEK;
  const own = bars(ownLast - 5 * WEEK, WEEK, 6, 1.3);
  await writeHst(dataFolder, BROKER, { version: 401, symbol: "EURUSD", minutes: 10080, digits: 5, bars: own });
  const d1 = weekdays(ownLast - WEEK + DAY, SUNDAY + 5 * DAY);
  await writeHst(dataFolder, BROKER, { version: 401, symbol: "EURUSD", minutes: 1440, digits: 5, bars: d1 });

  const latest = await page("W1", 3);
  assert.deepEqual(latest.candles, [2, 1, 0].map((n) => rolled(d1, SUNDAY - n * WEEK, SUNDAY - (n - 1) * WEEK)));
  assert.equal(latest.source, "hst");
  assert.equal(latest.complete, false);

  const older = await page("W1", 500, latest.candles[0].time);
  assert.deepEqual(older.candles, [
    ...own.slice(0, -1).map(toPage),
    rolled(d1, ownLast, ownLast + WEEK),
  ], "the own file's bars, then its last week rolled up from D1: no gap, no duplicate week");
  assert.equal(older.complete, true);
});

test("without a W1 or MN1 file, both are rolled up from the D1 file rather than M1; months start on the 1st", { timeout: 15000 }, async (t) => {
  const { dataFolder, page } = await start(t);
  const december = Date.UTC(2026, 11, 1) / 1000;
  const d1 = weekdays(december, SUNDAY + 5 * DAY);
  await writeHst(dataFolder, BROKER, { version: 401, symbol: "EURUSD", minutes: 1440, digits: 5, bars: d1 });
  // An M1 file with other prices, covering only this week.
  await writeHst(dataFolder, BROKER, { version: 401, symbol: "EURUSD", minutes: 1, digits: 5, bars: bars(SUNDAY + DAY, MINUTE, 4 * 1440, 1.5) });

  const w1 = await page("W1", 500);
  assert.equal(w1.candles.length, 7);
  assert.deepEqual(w1.candles.slice(-2), [rolled(d1, SUNDAY - WEEK, SUNDAY), rolled(d1, SUNDAY, SUNDAY + WEEK)]);
  assert.equal(w1.complete, true);

  const months = [Date.UTC(2026, 11, 1), Date.UTC(2027, 0, 1), Date.UTC(2027, 1, 1)].map((ms) => ms / 1000);
  assert.deepEqual((await page("MN1", 500)).candles, [0, 1].map((n) => rolled(d1, months[n], months[n + 1])));
});

test("a stale H1 file is filled from the M1 file, whose last partial hour the live join merges like any forming bar", { timeout: 15000 }, async (t) => {
  const { dataFolder, send, page } = await start(t);
  // The H1 file was last written at 08:15, while 08:00 was forming; the M1 file runs from 07:00 to 09:39.
  const own = [
    { time: TEN - 4 * HOUR, open: 1.3, high: 1.31, low: 1.29, close: 1.3 },
    { time: TEN - 3 * HOUR, open: 1.3, high: 1.32, low: 1.28, close: 1.31 },
    { time: TEN - 2 * HOUR, open: 1.31, high: 1.31, low: 1.31, close: 1.31 },
  ];
  await writeHst(dataFolder, BROKER, { version: 401, symbol: "EURUSD", minutes: 60, digits: 5, bars: own });
  const m1 = bars(TEN - 3 * HOUR, MINUTE, 160);
  await writeHst(dataFolder, BROKER, { version: 401, symbol: "EURUSD", minutes: 1, digits: 5, bars: m1 });
  await send([[TEN - 15 * MINUTE, 1.2], [TEN + 5, 1.21]]);

  const partial = rolled(m1, TEN - HOUR, TEN);
  assert.deepEqual((await page("H1", 500)).candles, [
    toPage(own[0]),
    toPage(own[1]),
    rolled(m1, TEN - 2 * HOUR, TEN - HOUR),
    { ...partial, high: 1.2, close: 1.2 },
    { time: utc(TEN), open: 1.21, high: 1.21, low: 1.21, close: 1.21 },
  ]);
});

test("a period file that is current is used as it is: a fill file reaching no later changes nothing", { timeout: 15000 }, async (t) => {
  const { dataFolder, page } = await start(t);
  const own = bars(TEN - 5 * HOUR, HOUR, 5, 1.3);
  await writeHst(dataFolder, BROKER, { version: 401, symbol: "EURUSD", minutes: 60, digits: 5, bars: own });
  await writeHst(dataFolder, BROKER, { version: 401, symbol: "EURUSD", minutes: 1, digits: 5, bars: bars(TEN - 3 * HOUR, MINUTE, 150) });

  const { candles, complete } = await page("H1", 500);
  assert.deepEqual(candles, own.map(toPage));
  assert.equal(complete, true);
});

test("a broker's Sunday session counts in the week that is closing, as MetaTrader's W1 bars hold it", { timeout: 15000 }, async (t) => {
  const { dataFolder, page } = await start(t);
  // D1 bars every day but Saturday, from Sunday 3 January to Thursday 14 January (EasyForex has a short Sunday session).
  const d1 = bars(SUNDAY - WEEK, DAY, 12).filter((b) => new Date(b.time * 1000).getUTCDay() !== 6);
  await writeHst(dataFolder, BROKER, { version: 401, symbol: "EURUSD", minutes: 1440, digits: 5, bars: d1 });

  // The week dated Sunday 3 January holds Monday 4 to Sunday 10; Sunday 3 January closed the week dated 27 December.
  assert.deepEqual((await page("W1", 500)).candles, [
    rolled(d1, SUNDAY - WEEK, SUNDAY - WEEK + DAY),
    rolled(d1, SUNDAY - WEEK + DAY, SUNDAY + DAY),
    rolled(d1, SUNDAY + DAY, SUNDAY + WEEK),
  ].map((bar, n) => ({ ...bar, time: utc(SUNDAY - (2 - n) * WEEK) })));
});

test("at the join each bucket comes once: the own file's last bar stays unless the fill file holds that whole bucket", { timeout: 15000 }, async (t) => {
  const { dataFolder, page } = await start(t);
  const own = bars(TEN - 4 * HOUR, HOUR, 3, 1.3);
  await writeHst(dataFolder, BROKER, { version: 401, symbol: "EURUSD", minutes: 60, digits: 5, bars: own });
  // The M1 file starts at 08:15, inside the own file's last hour (08:00), and runs to 09:39.
  const m1 = bars(TEN - 2 * HOUR + 15 * MINUTE, MINUTE, 85);
  await writeHst(dataFolder, BROKER, { version: 401, symbol: "EURUSD", minutes: 1, digits: 5, bars: m1 });
  assert.deepEqual((await page("H1", 500)).candles, [...own.map(toPage), rolled(m1, TEN - HOUR, TEN)]);
});

test("a D1 file starting on the Monday holds that whole week, so it replaces the stale W1 file's last bar", { timeout: 15000 }, async (t) => {
  const { dataFolder, page } = await start(t);
  const own = bars(SUNDAY - 3 * WEEK, WEEK, 2, 1.3);
  await writeHst(dataFolder, BROKER, { version: 401, symbol: "EURUSD", minutes: 10080, digits: 5, bars: own });
  const d1 = weekdays(SUNDAY - 2 * WEEK + DAY, SUNDAY + 5 * DAY);
  await writeHst(dataFolder, BROKER, { version: 401, symbol: "EURUSD", minutes: 1440, digits: 5, bars: d1 });
  assert.deepEqual((await page("W1", 500)).candles, [toPage(own[0]), ...[2, 1, 0].map((n) => rolled(d1, SUNDAY - n * WEEK, SUNDAY - (n - 1) * WEEK))]);
});

test("an empty period file counts as none: every closed bar comes from the fill file", { timeout: 15000 }, async (t) => {
  const { dataFolder, page } = await start(t);
  await writeHst(dataFolder, BROKER, { version: 401, symbol: "EURUSD", minutes: 60, digits: 5, bars: [] });
  const m1 = bars(TEN - 2 * HOUR, MINUTE, 120);
  await writeHst(dataFolder, BROKER, { version: 401, symbol: "EURUSD", minutes: 1, digits: 5, bars: m1 });
  assert.deepEqual((await page("H1", 500)).candles, [rolled(m1, TEN - 2 * HOUR, TEN - HOUR), rolled(m1, TEN - HOUR, TEN)]);
});
