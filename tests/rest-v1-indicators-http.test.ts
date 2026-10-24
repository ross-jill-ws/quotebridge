// REST v1 indicators over HTTP, as the CLI sends them with a Bearer key: the enabled packages listed and described as
// the legacy contract does, and a package's values in the legacy shape (`values: [{ time, close, complete?, <output>,
// <output>_style? }]`) with a `timeUtc` beside each broker time, read from the cache the charts use. Real server and
// database in temp folders, a fake EA, HST fixtures, fixture packages and a fake clock.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, startServer, type ServerConfig } from "../src/server/index.js";
import { FakeClock, FakeEA, fakeTerminalIdentity } from "./fake-ea.js";
import { freePort } from "./free-port.js";
import { bars, writeHst, type FixtureBar } from "./hst-fixtures.js";

const TOKEN = "window-token-0123456789";
const HOUR = 3600;
const DEMO = "EasyForex-Demo";
const REAL = "EasyForex-Real";
const TERMINAL = "mt4-aaaaaaaaaaaa";
const OTHER_TERMINAL = "mt4-bbbbbbbbbbbb";
/** The server's clock: 15 January 2027 08:00 UTC, 10:00 on the GMT+2 brokers (winter). */
const NOW = Date.UTC(2027, 0, 15, 8);
/** Broker seconds of 15 January 2027 10:00. */
const TEN = Date.UTC(2027, 0, 15, 10) / 1000;
/** UTC milliseconds of a broker time in seconds, on the GMT+2 brokers in winter. */
const utcMs = (broker: number) => (broker - 2 * HOUR) * 1000;

/** 6,000 H1 bars ending at 09:00 today (broker time), before the app's own live candle at 10:00. */
const HST: FixtureBar[] = bars(TEN - 6000 * HOUR, HOUR, 6000);

type Json = Record<string, any>;

/** A package that echoes the close, and throws while the close is above 2. */
const FUSSY = {
  "manifest.json": JSON.stringify({
    apiVersion: 1,
    id: "test.fussy",
    version: "1.0.0",
    name: "Fussy",
    description: "Echoes the close; throws above 2.",
    license: "MIT",
    entry: "calculate.js",
    inputs: [{ id: "source", label: "Close", kind: "numeric", alignment: "exact", field: "close", history: { bars: 1 } }],
    parameters: [],
    outputs: [{ id: "close", label: "Close", kind: "numeric", render: "line", placement: "pane", color: "#ffffff", unit: { input: "source" } }],
  }),
  "calculate.js": `exports.calculate = function ({ inputs, timeline }) {
    const points = inputs.source.points;
    if (points.length && points[points.length - 1].value > 2) throw new Error("too high");
    return { outputs: { close: timeline.map((time, i) => ({ time, value: points[i].value })) } };
  };`,
  "README.md": "Fussy",
  LICENSE: "MIT",
};

async function start(t: TestContext) {
  const folder = await mkdtemp(join(tmpdir(), "quotebridge-rest-ind-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const packages = join(folder, "packages");
  await mkdir(join(packages, "fussy"), { recursive: true });
  for (const [name, text] of Object.entries(FUSSY)) await writeFile(join(packages, "fussy", name), text);
  const dataFolder = join(folder, "data");
  await writeHst(dataFolder, DEMO, { version: 401, symbol: "EURUSD", minutes: 60, digits: 5, bars: HST });
  const database = await openDatabase(join(folder, "db"));
  const clock = new FakeClock(NOW);
  const cfg: ServerConfig = {
    eaPort: await freePort(),
    httpPort: await freePort(),
    windowToken: TOKEN,
    resolveTerminal: fakeTerminalIdentity,
    now: clock.now,
    localOffsetMinutes: () => 0,
    terminalDataFolder: (terminalId) => (terminalId === TERMINAL ? dataFolder : undefined),
    database,
    extraIndicatorPackages: packages,
  };
  const server = await startServer(cfg);
  t.after(async () => {
    await server.close();
    await database.checkpointAndClose();
  });
  const origin = server.httpOrigin;
  const cookie = (await fetch(`${origin}/session?token=${TOKEN}`, { redirect: "manual" })).headers.get("set-cookie")!.split(";")[0];
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${origin}${path}`, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.ok(res.ok, `${path}: ${res.status} ${await res.clone().text()}`);
    return (await res.json()) as Json;
  };
  for (const brokerServer of [DEMO, REAL]) await post("/api/clock-rules", { brokerServer, winterOffsetMinutes: 120, dst: "us" });
  const { key } = await post("/api/api-keys", { name: "CLI", scope: "readonly" });
  const search = (query: Record<string, string | number>) => {
    const s = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
    return s.size ? `?${s}` : "";
  };
  /** As the CLI: a Bearer key, no cookie. */
  const cli = (path: string, query: Record<string, string | number> = {}, init: RequestInit = {}) =>
    fetch(`${origin}${path}${search(query)}`, { ...init, headers: { authorization: `Bearer ${key}`, ...init.headers } });
  /** The JSON of a CLI GET, asserting its status. */
  const read = async (path: string, query: Record<string, string | number> = {}, status = 200) => {
    const res = await cli(path, query);
    assert.equal(res.status, status, `${path}: ${await res.clone().text()}`);
    return (await res.json()) as Json;
  };
  /** The chart endpoint's answer, as the app window asks for it. */
  const chart = async (query: Record<string, string | number>) => {
    const res = await fetch(`${origin}/api/indicators/values${search(query)}`, { headers: { cookie } });
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json()) as Json;
  };
  const connect = async (options: { terminal?: string; broker?: string } = {}) => {
    const ea = new FakeEA({ terminal: options.terminal ?? TERMINAL, broker: options.broker ?? DEMO, symbol: "EURUSD", digits: 5 }).connect(`tcp://127.0.0.1:${cfg.eaPort}`);
    t.after(() => ea.close());
    await ea.request(ea.helloWire());
    let seq = 0;
    /** A live quote at broker seconds `quoteTime`. */
    const send = (quoteTime: number, bid: number) => ea.request(ea.tickWire([{ seq: ++seq, bid, ask: bid + 0.0002, quoteTime, sampledTime: quoteTime }]));
    return { ea, send };
  };
  return { origin, cookie, clock, post, cli, read, chart, connect };
}

test("the indicator list has the enabled packages as the legacy contract summarises them; a disabled one leaves it", { timeout: 20000 }, async (t) => {
  const app = await start(t);
  const { indicators } = await app.read("/api/v1/indicators");
  assert.deepEqual(indicators.map((i: Json) => i.name).sort(), ["ac", "alligator", "ao", "bollinger", "eo", "fussy", "ma", "macd", "rsi"]);
  const macd = indicators.find((i: Json) => i.name === "macd");
  assert.deepEqual(macd, {
    name: "macd",
    id: "quotebridge.macd",
    version: "1.0.0",
    title: "MACD",
    description: macd.description,
    placement: "pane",
    closedBarsOnly: false,
    parameters: [
      { id: "fast", label: "Fast EMA", type: "integer", default: 12, min: 1, max: 500, lessThan: "slow" },
      { id: "slow", label: "Slow EMA", type: "integer", default: 26, min: 1, max: 500 },
      { id: "signal", label: "Signal SMA", type: "integer", default: 9, min: 1, max: 500 },
    ],
    outputs: [
      { id: "macd", label: "MACD", render: "histogram" },
      { id: "signal", label: "Signal", render: "line" },
    ],
    hash: macd.hash,
  });
  assert.match(macd.hash, /^[0-9a-f]{64}$/);
  // A palette's style keys; a choice parameter's values.
  assert.deepEqual(indicators.find((i: Json) => i.name === "ao").outputs, [{ id: "ao", label: "AO", render: "histogram", styles: ["rising", "falling"] }]);
  assert.deepEqual(
    indicators.find((i: Json) => i.name === "ma").parameters.find((p: Json) => p.id === "type").choices.map((c: Json) => c.value),
    ["simple", "exponential"],
  );
  assert.equal(indicators.find((i: Json) => i.name === "eo").closedBarsOnly, true);

  // Described by its short name or its id, in any case.
  assert.deepEqual(await app.read("/api/v1/indicators/MACD"), macd);
  assert.deepEqual(await app.read("/api/v1/indicators/quotebridge.macd"), macd);

  await app.post("/api/indicators/packages/enabled", { id: "quotebridge.macd", enabled: false });
  assert.ok(!(await app.read("/api/v1/indicators")).indicators.some((i: Json) => i.name === "macd"));
  const gone = await app.read("/api/v1/indicators/macd", {}, 404);
  assert.match(gone.error, /Unknown or disabled indicator macd/);
  assert.ok(gone.details.includes("rsi") && !gone.details.includes("macd"), "the available names");
});

/** The mean of the 20 closes ending at `closes[i]`. */
const mean20 = (closes: readonly number[], i: number) => closes.slice(i - 19, i + 1).reduce((a, b) => a + b, 0) / 20;
const round = (v: number | null | undefined) => (v === null || v === undefined ? v : Number(v.toFixed(10)));

test("a package's values come in the legacy shape over the last count bars, warmed up before them, the forming bar last", { timeout: 20000 }, async (t) => {
  const app = await start(t);
  const { send } = await app.connect();
  await send(TEN + 60, 1.2);

  const answer = await app.read("/api/v1/indicators/ma/eurusd", { period: "1H", count: 30, "p.period": 20 });
  const { values, ...head } = answer;
  assert.deepEqual(head, {
    indicator: "ma",
    id: "quotebridge.ma",
    version: "1.0.0",
    parameters: { period: 20, type: "simple" },
    outputs: [{ id: "ma", label: "MA" }],
    period: "H1",
    timeframe: 60,
    symbol: "EURUSD",
    broker: DEMO,
    terminal: TERMINAL,
    feed: head.feed,
    source: "live",
    status: "live",
    // The 30 bars and the 519 of warm-up (the period plus 499) before them.
    barsUsed: 549,
  });
  // HST's last 29 bars and the live 10:00 candle, in broker seconds with their UTC milliseconds.
  const closes = [...HST.map((b) => b.close), 1.2];
  const times = [...HST.slice(-29).map((b) => b.time), TEN];
  assert.deepEqual(
    values.map((v: Json) => ({ ...v, ma: round(v.ma) })),
    times.map((time, i) => ({
      time,
      timeUtc: utcMs(time),
      close: closes[closes.length - 30 + i],
      ...(i === 29 ? { complete: false } : {}),
      ma: round(mean20(closes, closes.length - 30 + i)),
    })),
  );

  // The chart's values for the same key: the same numbers.
  const chart = await app.chart({ feed: head.feed, period: "H1", package: "quotebridge.ma", "p.period": 20, "p.type": "simple", limit: 30 });
  assert.deepEqual(
    values.map((v: Json) => v.ma),
    chart.outputs.ma.map((p: Json) => p.value),
  );
});

test("count is 900 when not given and 5000 at most, the warm-up added on top", { timeout: 30000 }, async (t) => {
  const app = await start(t);
  const { send } = await app.connect();
  await send(TEN + 60, 1.2);
  const closes = [...HST.map((b) => b.close), 1.2];

  const standard = await app.read("/api/v1/indicators/ma/EURUSD", { period: "H1" });
  assert.equal(standard.values.length, 900);
  assert.equal(standard.values[0].time, HST.at(-899)!.time);

  const most = await app.read("/api/v1/indicators/ma/EURUSD", { period: "H1", count: 5000 });
  assert.equal(most.values.length, 5000);
  assert.equal(most.barsUsed, 5519);
  assert.equal(round(most.values[0].ma), round(mean20(closes, closes.length - 5000)), "the first value warmed up");

  for (const count of [0, 5001, "x"]) {
    assert.match((await app.read("/api/v1/indicators/ma/EURUSD", { period: "H1", count }, 400)).error, /count must be an integer 1–5000/);
  }
  assert.match((await app.read("/api/v1/indicators/ma/EURUSD", { period: "H1", "p.period": 0 }, 400)).error, /Period must be a whole number from 1 to 500/);
  assert.match((await app.read("/api/v1/indicators/ma/EURUSD", { period: "H1", "p.nothing": 1 }, 400)).error, /has no parameter nothing/);
  assert.equal((await app.read("/api/v1/indicators/ma/EURUSD", { period: "H2" }, 400)).error.startsWith("Invalid period"), true);
});

test("a closed-bars-only package has no row for the forming bar; a palette output has its style", { timeout: 20000 }, async (t) => {
  const app = await start(t);
  const { send } = await app.connect();
  await send(TEN + 60, 1.2);

  const eo = await app.read("/api/v1/indicators/eo/EURUSD", { period: "H1", count: 10 });
  // HST's last 9 bars; the forming 10:00 candle is left out.
  assert.deepEqual(eo.values.map((v: Json) => v.time), HST.slice(-9).map((b) => b.time));
  assert.deepEqual(Object.keys(eo.values[0]), ["time", "timeUtc", "close", "histogram", "histogram_style", "eo"]);
  assert.ok(eo.values.every((v: Json) => v.complete === undefined && typeof v.eo === "number" && ["rising", "falling"].includes(v.histogram_style)));

  const ao = await app.read("/api/v1/indicators/ao/EURUSD", { period: "H1", count: 10 });
  assert.equal(ao.values.length, 10);
  assert.equal(ao.values.at(-1).complete, false);
  assert.ok(ao.values.every((v: Json) => ["rising", "falling"].includes(v.ao_style)));
});

test("a failed calculation answers 422 with the reason; an unknown or disabled package 404 with the names", { timeout: 20000 }, async (t) => {
  const app = await start(t);
  const { send } = await app.connect();
  await send(TEN + 60, 2.5);
  const failed = await app.read("/api/v1/indicators/fussy/EURUSD", { period: "H1", count: 5 }, 422);
  assert.equal(failed.error, "Fussy failed: The calculation threw: too high");

  const unknown = await app.read("/api/v1/indicators/nothing/EURUSD", { period: "H1" }, 404);
  assert.match(unknown.error, /Unknown or disabled indicator nothing/);
  assert.ok(unknown.details.includes("macd"));
  await app.post("/api/indicators/packages/enabled", { id: "quotebridge.rsi", enabled: false });
  const disabled = await app.read("/api/v1/indicators/rsi/EURUSD", { period: "H1" }, 404);
  assert.ok(!disabled.details.includes("rsi"));
  assert.match((await app.read("/api/v1/indicators/ma/GBPUSD", { period: "H1" }, 404)).error, /Unknown symbol GBPUSD/);
});

test("an ambiguous symbol answers 409 with the candidates, narrowed by broker or terminal", { timeout: 20000 }, async (t) => {
  const app = await start(t);
  const demo = await app.connect();
  const real = await app.connect({ broker: REAL, terminal: OTHER_TERMINAL });
  await demo.send(TEN + 60, 1.2);
  await real.send(TEN + 60, 1.3);

  const ambiguous = await app.read("/api/v1/indicators/ma/EURUSD", { period: "H1" }, 409);
  assert.match(ambiguous.error, /ambiguous/);
  assert.deepEqual(ambiguous.details.map((c: Json) => c.broker).sort(), [DEMO, REAL]);

  const byBroker = await app.read("/api/v1/indicators/ma/EURUSD", { period: "H1", count: 3, broker: "real" });
  assert.deepEqual([byBroker.broker, byBroker.terminal, byBroker.values.at(-1).close], [REAL, OTHER_TERMINAL, 1.3]);
  const byTerminal = await app.read("/api/v1/indicators/ma/EURUSD", { period: "H1", count: 3, terminal: "aaaa" });
  assert.deepEqual([byTerminal.broker, byTerminal.values.at(-1).close], [DEMO, 1.2]);
});

test("the indicator endpoints need a key; a readonly key may only GET them, and reaches no chart endpoint", { timeout: 20000 }, async (t) => {
  const app = await start(t);
  for (const path of ["/api/v1/indicators", "/api/v1/indicators/ma", "/api/v1/indicators/ma/EURUSD?period=H1"]) {
    assert.equal((await fetch(`${app.origin}${path}`)).status, 401, path);
    assert.equal((await fetch(`${app.origin}${path}`, { headers: { authorization: "Bearer qbk_unknown" } })).status, 401, path);
  }
  const post = await app.cli("/api/v1/indicators/ma/EURUSD", { period: "H1" }, { method: "POST" });
  assert.equal(post.status, 403);
  assert.match((await post.json()).error, /may only read/);
  assert.equal((await app.cli("/api/indicators/values", { package: "quotebridge.ma", period: "H1" })).status, 403);
});

test("with no live candle yet, the values are over the history and no bar is marked forming", { timeout: 20000 }, async (t) => {
  const app = await start(t);
  await app.connect();
  const answer = await app.read("/api/v1/indicators/ma/EURUSD", { period: "H1", count: 3 });
  assert.deepEqual([answer.source, answer.status], ["history", "history"]);
  assert.deepEqual(answer.values.map((v: Json) => v.time), HST.slice(-3).map((b) => b.time));
  assert.ok(answer.values.every((v: Json) => v.complete === undefined && typeof v.ma === "number"));
});
