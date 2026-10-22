// Broker clocks over HTTP (ADR 11): markets on feeds, offset and rule inference from samples, mismatches,
// rules the trader sets, and candles that carry their UTC start. Real server, fake EAs, a fake clock.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeSnapshot } from "../src/server/bridge/index.js";
import { openDatabase, startServer, type AppDatabase, type ServerConfig } from "../src/server/index.js";
import { FakeClock, FakeEA, type FakeEAOptions } from "./fake-ea.js";
import { freePort } from "./free-port.js";

const TOKEN = "window-token-0123456789";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

type BrokerClock = {
  brokerServer: string;
  rule: { winterOffsetMinutes: number; dst: string };
  source: "inferred" | "set";
  description: string;
  lastObserved: { offsetMinutes: number; at: number } | null;
  mismatch: { observedOffsetMinutes: number; since: number } | null;
};

async function start(t: TestContext, clock: FakeClock, overrides: Partial<ServerConfig> = {}) {
  const cfg: ServerConfig = {
    eaPort: await freePort(),
    httpPort: await freePort(),
    windowToken: TOKEN,
    now: clock.now,
    // The PC's local time is UTC in these tests, so an EA's sampled time (TimeLocal) reads as UTC.
    localOffsetMinutes: () => 0,
    ...overrides,
  };
  const server = await startServer(cfg);
  let closed = false;
  const close = async () => {
    if (!closed) await server.close();
    closed = true;
  };
  t.after(close);
  const origin = server.httpOrigin;
  const signIn = await fetch(`${origin}/session?token=${TOKEN}`, { redirect: "manual" });
  const cookie = signIn.headers.get("set-cookie")!.split(";")[0];
  const ea = async (options?: FakeEAOptions) => {
    const fake = new FakeEA(options).connect(`tcp://127.0.0.1:${cfg.eaPort}`);
    t.after(() => fake.close());
    await fake.request(fake.helloWire());
    return fake;
  };
  const getJson = async <T>(path: string) => {
    const res = await fetch(`${origin}${path}`, { headers: { cookie } });
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json()) as T;
  };
  const post = (path: string, body: unknown) =>
    fetch(`${origin}${path}`, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify(body) });
  const rules = async () => (await getJson<{ clockRules: BrokerClock[] }>("/api/clock-rules")).clockRules;
  const rule = async (brokerServer: string) => (await rules()).find((r) => r.brokerServer === brokerServer);
  return { ea, getJson, post, rules, rule, close, cookie, origin };
}

/**
 * A live sample: quote time `offset` minutes ahead of the server's UTC clock (plus `lagMs` behind), sampled now.
 * Each call sends a newer quote time than the last, as a ticking market does.
 */
function ticker(clock: FakeClock) {
  let seq = 0;
  return async (chart: FakeEA, offsetMinutes: number, options: { lagMs?: number; bid?: number; sampledLagMs?: number } = {}) => {
    seq++;
    const quoteTime = Math.floor((clock.time + offsetMinutes * MINUTE - (options.lagMs ?? 0)) / 1000) + seq;
    const sampledTime = Math.floor((clock.time - (options.sampledLagMs ?? 0)) / 1000);
    const bid = options.bid ?? 1.1;
    await chart.request(chart.tickWire([{ seq, bid, ask: bid + 0.0002, quoteTime, sampledTime }]));
    return quoteTime;
  };
}

// 15 January 2027 08:00 UTC: winter on both US and EU dates.
const WINTER = 1_800_000_000_000;

test("the first live samples set the rule: +2 is GMT+2 with US daylight saving, and the offset is remembered", { timeout: 10000 }, async (t) => {
  const clock = new FakeClock(WINTER);
  const { ea, rule } = await start(t, clock);
  const chart = await ea({ broker: "EasyForex-Demo" });
  const tick = ticker(clock);

  await tick(chart, 120);
  await tick(chart, 120);

  const clockRule = await rule("EasyForex-Demo");
  assert.deepEqual(clockRule?.rule, { winterOffsetMinutes: 120, dst: "us" });
  assert.equal(clockRule?.source, "inferred");
  assert.equal(clockRule?.description, "GMT+2, GMT+3 in US summer time");
  assert.deepEqual(clockRule?.lastObserved, { offsetMinutes: 120, at: WINTER });
  assert.equal(clockRule?.mismatch, null);

  // The market closes: the last offset stands.
  clock.advance(48 * HOUR);
  assert.deepEqual((await rule("EasyForex-Demo"))?.lastObserved, { offsetMinutes: 120, at: WINTER });
});

test("other offsets give a fixed rule; quote times a few seconds behind still round to the offset", { timeout: 10000 }, async (t) => {
  const clock = new FakeClock(WINTER);
  const { ea, rule } = await start(t, clock);
  const chart = await ea({ broker: "Asia-Live" });
  const tick = ticker(clock);
  await tick(chart, 330, { lagMs: 20_000 });
  await tick(chart, 330, { lagMs: 20_000 });
  const west = await ea({ broker: "West-Live", terminal: "mt4-bbbbbbbbbbbb" });
  await tick(west, -300);
  await tick(west, -300);

  assert.deepEqual((await rule("Asia-Live"))?.rule, { winterOffsetMinutes: 330, dst: "none" });
  assert.equal((await rule("Asia-Live"))?.description, "GMT+5:30, no daylight saving");
  assert.deepEqual((await rule("West-Live"))?.rule, { winterOffsetMinutes: -300, dst: "none" });
});

test("old quotes, replayed samples and a feed's first sample infer nothing", { timeout: 10000 }, async (t) => {
  const clock = new FakeClock(WINTER);
  const { ea, rules } = await start(t, clock);
  const chart = await ea({ broker: "Quiet-Broker" });
  const tick = ticker(clock);

  // The feed's first sample could be a frozen quote.
  await tick(chart, 120, { lagMs: 20 * MINUTE, sampledLagMs: 20 * MINUTE });
  // Replayed from the EA's buffer: sampled 15 minutes ago, while the app was not running. It would round to +1:45.
  await tick(chart, 120, { lagMs: 15 * MINUTE, sampledLagMs: 15 * MINUTE });
  // A quote that is minutes old.
  await tick(chart, 120, { lagMs: 3 * MINUTE });
  assert.deepEqual(await rules(), []);

  // A frozen quote (the market is closed) repeats its quote time: only its first sample arrives fresh.
  const frozen = await ea({ broker: "Closed-Broker", terminal: "mt4-cccccccccccc", symbol: "GBPUSD" });
  const quoteTime = Math.floor((clock.time + 120 * MINUTE) / 1000);
  await frozen.request(frozen.tickWire([{ seq: 1, bid: 1.3, ask: 1.3002, quoteTime, sampledTime: clock.time / 1000 }]));
  await frozen.request(frozen.tickWire([{ seq: 2, bid: 1.3, ask: 1.3002, quoteTime, sampledTime: clock.time / 1000 }]));
  assert.deepEqual(await rules(), []);
});

test("an observed offset that contradicts the rule for 10 minutes is flagged, and clears when it agrees again", { timeout: 10000 }, async (t) => {
  const clock = new FakeClock(WINTER);
  const { ea, rule } = await start(t, clock);
  const chart = await ea({ broker: "Shifted-Broker" });
  const tick = ticker(clock);
  await tick(chart, 120);
  await tick(chart, 120);

  // The broker moves to +3 in winter.
  await tick(chart, 180);
  const since = clock.time;
  clock.advance(5 * MINUTE);
  await tick(chart, 180);
  clock.advance(4 * MINUTE);
  await tick(chart, 180);
  assert.equal((await rule("Shifted-Broker"))?.mismatch, null, "not yet 10 minutes");
  clock.advance(MINUTE);
  await tick(chart, 180);
  const flagged = await rule("Shifted-Broker");
  assert.deepEqual(flagged?.mismatch, { observedOffsetMinutes: 180, since });
  assert.deepEqual(flagged?.rule, { winterOffsetMinutes: 120, dst: "us" }, "inference never replaces the rule");
  assert.deepEqual(flagged?.lastObserved, { offsetMinutes: 180, at: clock.time });

  await tick(chart, 120);
  assert.equal((await rule("Shifted-Broker"))?.mismatch, null);
});

test("a mismatch must be seen for 10 minutes of live samples, not across a closed market", { timeout: 10000 }, async (t) => {
  const clock = new FakeClock(WINTER);
  const { ea, rule } = await start(t, clock);
  const chart = await ea({ broker: "Weekend-Broker" });
  const tick = ticker(clock);
  await tick(chart, 120);
  await tick(chart, 120);

  // One contradicting sample before the weekend, the next after it.
  await tick(chart, 180);
  clock.advance(48 * HOUR);
  await tick(chart, 180);
  assert.equal((await rule("Weekend-Broker"))?.mismatch, null);
  clock.advance(5 * MINUTE);
  await tick(chart, 180);
  clock.advance(5 * MINUTE);
  await tick(chart, 180);
  assert.deepEqual((await rule("Weekend-Broker"))?.mismatch, { observedOffsetMinutes: 180, since: clock.time - 10 * MINUTE });
});

test("a rule the trader sets is never replaced by inference, only flagged, and survives a restart", { timeout: 20000 }, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "quotebridge-clock-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const clock = new FakeClock(WINTER);
  let database: AppDatabase = await openDatabase(folder);
  const first = await start(t, clock, { database });
  const chart = await first.ea({ broker: "CMC-Live" });
  const tick = ticker(clock);
  await tick(chart, 120);
  await tick(chart, 120);

  const set = await first.post("/api/clock-rules", { brokerServer: "CMC-Live", winterOffsetMinutes: 0, dst: "eu" });
  assert.equal(set.status, 200, await set.clone().text());
  const answer = (await set.json()) as BrokerClock;
  assert.deepEqual(answer.rule, { winterOffsetMinutes: 0, dst: "eu" });
  assert.equal(answer.source, "set");

  await tick(chart, 120);
  clock.advance(5 * MINUTE);
  await tick(chart, 120);
  clock.advance(5 * MINUTE);
  await tick(chart, 120);
  const flagged = await first.rule("CMC-Live");
  assert.deepEqual(flagged?.rule, { winterOffsetMinutes: 0, dst: "eu" });
  assert.equal(flagged?.source, "set");
  assert.equal(flagged?.mismatch?.observedOffsetMinutes, 120);

  chart.close();
  await first.close();
  await database.checkpointAndClose();
  database = await openDatabase(folder);
  t.after(() => database.checkpointAndClose().catch(() => {}));
  const second = await start(t, clock, { database });
  const again = await second.rule("CMC-Live");
  assert.deepEqual(again?.rule, { winterOffsetMinutes: 0, dst: "eu" });
  assert.equal(again?.source, "set");
  assert.deepEqual(again?.lastObserved, { offsetMinutes: 120, at: clock.time });
});

test("setting a rule checks the broker server, the offset (−12:00 to +14:00 in 15-minute steps) and the convention", { timeout: 10000 }, async (t) => {
  const clock = new FakeClock(WINTER);
  const { post, rule, origin, cookie } = await start(t, clock);
  const status = async (body: unknown) => (await post("/api/clock-rules", body)).status;

  assert.equal(await status({ brokerServer: "X-Live", winterOffsetMinutes: 125, dst: "none" }), 400);
  assert.equal(await status({ brokerServer: "X-Live", winterOffsetMinutes: 15 * 60, dst: "none" }), 400);
  assert.equal(await status({ brokerServer: "X-Live", winterOffsetMinutes: -13 * 60, dst: "none" }), 400);
  assert.equal(await status({ brokerServer: "X-Live", winterOffsetMinutes: 60, dst: "au" }), 400);
  assert.equal(await status({ brokerServer: "", winterOffsetMinutes: 60, dst: "none" }), 400);
  assert.equal(await status({ winterOffsetMinutes: 60, dst: "none" }), 400);
  assert.equal(await status({ brokerServer: "X-Live", winterOffsetMinutes: 14 * 60, dst: "none" }), 200);
  assert.equal(await status({ brokerServer: "Y-Live", winterOffsetMinutes: -12 * 60 + 45, dst: "us" }), 200);
  assert.deepEqual((await rule("Y-Live"))?.rule, { winterOffsetMinutes: -675, dst: "us" });
  assert.equal((await rule("Y-Live"))?.lastObserved, null);

  // Changes only from the app window.
  const foreign = await fetch(`${origin}/api/clock-rules`, {
    method: "POST",
    headers: { cookie, origin: "http://127.0.0.1:1", "content-type": "application/json" },
    body: JSON.stringify({ brokerServer: "Z-Live", winterOffsetMinutes: 0, dst: "none" }),
  });
  assert.equal(foreign.status, 403);
  assert.equal((await fetch(`${origin}/api/clock-rules`)).status, 401);
});

test("each feed carries its market from its terminal's latest hello; a login switch restarts the feed's candles", { timeout: 10000 }, async (t) => {
  const clock = new FakeClock(WINTER);
  const { ea, getJson } = await start(t, clock);
  const tick = ticker(clock);
  const demo = await ea({ terminal: "mt4-aaaaaaaaaaaa", broker: "EasyForex-Demo", symbol: "EURUSD", session: "chart-demo" });
  const demoTime = await tick(demo, 120, { bid: 1.1 });

  const before = (await getJson<BridgeSnapshot>("/api/state")).feeds;
  assert.equal(before.length, 1);
  assert.deepEqual(before[0].market, { brokerServer: "EasyForex-Demo", symbol: "EURUSD" });
  const feed = before[0].feed;
  const candles = async () => (await getJson<{ candles: { time: number; close: number }[] }>(`/api/candles?${new URLSearchParams({ feed, period: "M1" })}`)).candles;
  assert.deepEqual((await candles()).map((c) => c.close), [1.1]);

  // The trader logs the terminal into the real account: MetaTrader restarts the EA, which says hello again.
  const real = await ea({ terminal: "mt4-aaaaaaaaaaaa", broker: "EasyForex-Real", symbol: "EURUSD", session: "chart-real" });
  const after = (await getJson<BridgeSnapshot>("/api/state")).feeds;
  assert.equal(after.length, 1, "the same feed, now on the Real market");
  assert.equal(after[0].feed, feed);
  assert.deepEqual(after[0].market, { brokerServer: "EasyForex-Real", symbol: "EURUSD" });
  assert.equal(after[0].broker, "EasyForex-Real");

  clock.advance(1000);
  await tick(real, 120, { bid: 1.2 });
  const restarted = await candles();
  assert.deepEqual(restarted.map((c) => c.close), [1.2], "no candle mixes prices from two broker servers");
  assert.ok(restarted[0].time >= demoTime - (demoTime % 60) - 2 * 3600);
});

test("candles and the live snapshot hand out UTC times from the broker server's rule, with the rule; W1 starts on Sunday broker time", { timeout: 10000 }, async (t) => {
  const clock = new FakeClock(WINTER);
  const { ea, getJson } = await start(t, clock);
  const chart = await ea({ broker: "EasyForex-Demo" });
  const tick = ticker(clock);
  await tick(chart, 120);
  const quoteTime = await tick(chart, 120);

  const [state] = (await getJson<BridgeSnapshot>("/api/state")).feeds;
  assert.deepEqual(state.clockRule, { winterOffsetMinutes: 120, dst: "us" });
  assert.equal(state.quoteTimeUtc, (quoteTime - 2 * 3600) * 1000);
  type Answer = { clockRule: unknown; candles: { time: number }[] };
  const answer = async (period: string) => getJson<Answer>(`/api/candles?${new URLSearchParams({ feed: state.feed, period })}`);
  const m1 = await answer("M1");
  assert.deepEqual(m1.clockRule, { winterOffsetMinutes: 120, dst: "us" });
  assert.equal(m1.candles[0].time, quoteTime - (quoteTime % 60) - 2 * 3600);

  // Friday 15 January 2027, 10:00 broker time: the week began on Sunday 10 January, 00:00 broker time (Saturday 22:00 UTC).
  const [w1] = (await answer("W1")).candles;
  assert.equal(w1.time, Date.UTC(2027, 0, 9, 22) / 1000);
});
