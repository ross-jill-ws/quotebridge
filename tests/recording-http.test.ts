// Recording over HTTP: the record switch per market, the merge rule across terminals, login switches, Stop and
// Delete, samples surviving a restart, and UTC times recomputed when a clock rule changes. Real server and database
// in a temp folder, fake EAs, a fake clock.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeSnapshot } from "../src/server/bridge/index.js";
import { openDatabase, startServer, type ServerConfig } from "../src/server/index.js";
import { FakeClock, FakeEA, type FakeEAOptions } from "./fake-ea.js";
import { freePort } from "./free-port.js";

const TOKEN = "window-token-0123456789";
const HOUR = 3600;
// 15 January 2027 08:00 UTC.
const WINTER = 1_800_000_000_000;
/** 10:00 broker time on a GMT+2 broker in winter, in broker seconds. */
const T = WINTER / 1000 + 2 * HOUR;

type Recording = {
  brokerServer: string;
  symbol: string;
  recording: boolean;
  samples: number;
  first: number | null;
  last: number | null;
  aboutBytes: number;
  clockRule: unknown;
};

async function tempFolder(t: TestContext) {
  const folder = await mkdtemp(join(tmpdir(), "quotebridge-recording-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

/** A server with its database in `folder`; `stop` takes the app's stop path (close, then CHECKPOINT). */
async function start(t: TestContext, folder: string, clock: FakeClock, overrides: Partial<ServerConfig> = {}) {
  const database = await openDatabase(folder);
  const cfg: ServerConfig = { eaPort: await freePort(), httpPort: await freePort(), windowToken: TOKEN, now: clock.now, localOffsetMinutes: () => 0, database, ...overrides };
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
  const record = async (brokerServer: string, symbol: string, on: boolean) => {
    const res = await post("/api/markets/recording", { brokerServer, symbol, on });
    assert.equal(res.status, 200, await res.clone().text());
  };
  const recordings = async () => (await getJson<{ recordings: Recording[] }>("/api/recordings")).recordings;
  const feeds = async () => (await getJson<BridgeSnapshot>("/api/state")).feeds;
  const setRule = async (brokerServer: string, winterOffsetMinutes: number, dst: string) =>
    assert.equal((await post("/api/clock-rules", { brokerServer, winterOffsetMinutes, dst })).status, 200);
  return { ea, post, record, recordings, feeds, setRule, stop, origin, cookie };
}

/** Sends quotes as [broker seconds, bid] from a chart, numbering them on from its last. */
function sender() {
  const seqs = new Map<FakeEA, number>();
  return async (chart: FakeEA, quotes: [number, number][]) => {
    let seq = seqs.get(chart) ?? 0;
    const rows = quotes.map(([quoteTime, bid]) => ({ seq: ++seq, bid, ask: bid + 0.0002, quoteTime, sampledTime: quoteTime }));
    seqs.set(chart, seq);
    await chart.request(chart.tickWire(rows));
  };
}

test("two terminals on one broker server record one market without duplicates; closing one keeps recording", { timeout: 15000 }, async (t) => {
  const clock = new FakeClock(WINTER);
  const { ea, record, recordings, feeds, setRule } = await start(t, await tempFolder(t), clock);
  await setRule("EasyForex-Demo", 120, "us");
  const first = await ea({ terminal: "mt4-aaaaaaaaaaaa", broker: "EasyForex-Demo", symbol: "EURUSD" });
  const second = await ea({ terminal: "mt4-bbbbbbbbbbbb", broker: "EasyForex-Demo", symbol: "EURUSD" });
  const other = await ea({ terminal: "mt4-aaaaaaaaaaaa", broker: "EasyForex-Demo", symbol: "GBPUSD" });
  assert.deepEqual((await feeds()).map((f) => f.recording), [false, false, false]);

  await record("EasyForex-Demo", "EURUSD", true);
  const shown = await feeds();
  assert.deepEqual(shown.filter((f) => f.symbol === "EURUSD").map((f) => f.recording), [true, true], "every row of the market shows the switch on");
  assert.equal(shown.find((f) => f.symbol === "GBPUSD")?.recording, false);

  const send = sender();
  const quotes: [number, number][] = [[T, 1.1], [T + 1, 1.1001], [T + 2, 1.1002]];
  await send(first, quotes);
  // The second terminal sees the same prices from the same server.
  await send(second, quotes);
  await send(other, [[T, 1.3]]);
  let [eurusd, ...rest] = await recordings();
  assert.equal(rest.length, 0, "only recorded markets are kept");
  assert.equal(eurusd.symbol, "EURUSD");
  assert.equal(eurusd.recording, true);
  assert.equal(eurusd.samples, 3);
  assert.equal(eurusd.first, (T - 2 * HOUR) * 1000, "stored in UTC");
  assert.ok(eurusd.aboutBytes > 0);

  // The first terminal closes; the second keeps the market recorded.
  first.close();
  await send(second, [[T + 3, 1.1003], [T + 4, 1.1004]]);
  [eurusd] = await recordings();
  assert.equal(eurusd.samples, 5);
  assert.equal(eurusd.last, (T + 4 - 2 * HOUR) * 1000);
});

test("a login switch records into the new market; demo and real never mix", { timeout: 15000 }, async (t) => {
  const clock = new FakeClock(WINTER);
  const { ea, record, recordings, feeds, setRule } = await start(t, await tempFolder(t), clock);
  await setRule("EasyForex-Demo", 120, "us");
  await setRule("EasyForex-Real", 120, "us");
  const send = sender();
  const demo = await ea({ terminal: "mt4-aaaaaaaaaaaa", broker: "EasyForex-Demo", session: "chart-demo" });
  await record("EasyForex-Demo", "EURUSD", true);
  await send(demo, [[T, 1.1], [T + 1, 1.1001]]);

  // MetaTrader restarts the EA in the real account: the feed now belongs to the Real market, which is not recorded yet.
  const real = await ea({ terminal: "mt4-aaaaaaaaaaaa", broker: "EasyForex-Real", session: "chart-real" });
  assert.deepEqual((await feeds()).map((f) => [f.market.brokerServer, f.recording]), [["EasyForex-Real", false]]);
  await send(real, [[T + 2, 1.2]]);
  assert.deepEqual((await recordings()).map((r) => [r.brokerServer, r.samples]), [["EasyForex-Demo", 2]]);

  await record("EasyForex-Real", "EURUSD", true);
  assert.equal((await feeds())[0].recording, true);
  await send(real, [[T + 3, 1.2001], [T + 4, 1.2002]]);
  assert.deepEqual((await recordings()).map((r) => [r.brokerServer, r.samples]), [
    ["EasyForex-Demo", 2],
    ["EasyForex-Real", 2],
  ]);
});

test("samples survive a server stop and restart; Stop keeps them; Delete removes them", { timeout: 20000 }, async (t) => {
  const clock = new FakeClock(WINTER);
  const folder = await tempFolder(t);
  const before = await start(t, folder, clock);
  await before.setRule("EasyForex-Demo", 120, "us");
  const send = sender();
  const chart = await before.ea({ broker: "EasyForex-Demo" });
  await before.record("EasyForex-Demo", "EURUSD", true);
  // Within the flush interval: the stop path writes them.
  await send(chart, [[T, 1.1], [T + 1, 1.1001], [T + 2, 1.1002]]);
  await before.stop();
  chart.close();

  const after = await start(t, folder, clock);
  let [eurusd] = await after.recordings();
  assert.equal(eurusd.samples, 3);
  assert.equal(eurusd.recording, true, "recording goes on after a restart");
  const again = await after.ea({ broker: "EasyForex-Demo", session: "chart-again" });
  assert.equal((await after.feeds())[0].recording, true);
  // The EA replays its buffer: what was stored before the restart is not stored twice.
  await send(again, [[T + 1, 1.1001], [T + 2, 1.1002], [T + 3, 1.1003]]);
  assert.equal((await after.recordings())[0].samples, 4);

  await after.record("EasyForex-Demo", "EURUSD", false);
  [eurusd] = await after.recordings();
  assert.deepEqual([eurusd.recording, eurusd.samples], [false, 4], "Stop keeps the data");
  await send(again, [[T + 4, 1.1004]]);
  assert.equal((await after.recordings())[0].samples, 4, "nothing more is recorded");

  const res = await after.post("/api/recordings/delete", { brokerServer: "EasyForex-Demo", symbol: "EURUSD" });
  assert.equal(res.status, 200);
  assert.deepEqual(((await res.json()) as { recordings: Recording[] }).recordings, []);
  assert.deepEqual(await after.recordings(), []);
});

test("a clock rule change recomputes the stored UTC times from their broker seconds", { timeout: 15000 }, async (t) => {
  const clock = new FakeClock(WINTER);
  const { ea, record, recordings, setRule } = await start(t, await tempFolder(t), clock);
  await setRule("EasyForex-Demo", 120, "none");
  const send = sender();
  const chart = await ea({ broker: "EasyForex-Demo" });
  await record("EasyForex-Demo", "EURUSD", true);
  const january = Date.UTC(2027, 0, 15, 10) / 1000;
  const july = Date.UTC(2027, 6, 15, 10) / 1000;
  await send(chart, [[january, 1.1], [july, 1.2]]);
  let [eurusd] = await recordings();
  assert.deepEqual([eurusd.first, eurusd.last], [(january - 2 * HOUR) * 1000, (july - 2 * HOUR) * 1000]);

  // US summer time: the July sample was at 07:00 UTC, not 08:00.
  await setRule("EasyForex-Demo", 120, "us");
  [eurusd] = await recordings();
  assert.deepEqual([eurusd.first, eurusd.last], [(january - 2 * HOUR) * 1000, (july - 3 * HOUR) * 1000]);
  assert.deepEqual(eurusd.clockRule, { winterOffsetMinutes: 120, dst: "us" });
});

test("recording requests that cannot work are refused, and without a session nothing is listed", { timeout: 15000 }, async (t) => {
  const clock = new FakeClock(WINTER);
  const { ea, post, origin } = await start(t, await tempFolder(t), clock);
  await ea({ broker: "EasyForex-Demo" });
  const cases: [string, unknown, number][] = [
    ["/api/markets/recording", { brokerServer: "EasyForex-Demo", symbol: "EURUSD" }, 400],
    ["/api/markets/recording", { brokerServer: "", symbol: "EURUSD", on: true }, 400],
    ["/api/markets/recording", { brokerServer: "EasyForex-Demo", on: true }, 400],
    ["/api/markets/recording", { brokerServer: "Other-Server", symbol: "EURUSD", on: true }, 404],
    ["/api/markets/recording", null, 400],
    ["/api/recordings/delete", { brokerServer: "EasyForex-Demo", symbol: "GBPUSD" }, 404],
  ];
  for (const [path, body, status] of cases) assert.equal((await post(path, body)).status, status, `${path} ${JSON.stringify(body)}`);
  assert.equal((await fetch(`${origin}/api/recordings`)).status, 401);
});
