// Indicator values over HTTP, computed by the server (ADR 12): /api/indicators/values answers a package's values for a
// feed, period and parameters over a candles page's range, with the warm-up before it; the forming bar is computed
// again at most once a second; an older page computes the key again over the longer series; every window shares one
// computation; a failure keeps the last good values, stale; the live stream says when a shown key changed. Real server,
// fake EAs, HST files and fixture packages in temp folders.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { startServer, type ServerConfig } from "../src/server/index.js";
import { brokerToUtc, type ClockRule } from "../src/shared/clock.js";
import { SettingsStore } from "../src/shared/settings-store.js";
import { FakeClock, FakeEA } from "./fake-ea.js";
import { freePort } from "./free-port.js";
import { bars, writeHst, type FixtureBar } from "./hst-fixtures.js";

const TOKEN = "window-token-0123456789";
const SECOND_TOKEN = "window-token-second-window";
const HOUR = 3600;
const DAY = 86400;
const BROKER = "EasyForex-Demo";
const TERMINAL = "mt4-aaaaaaaaaaaa";
/** The server's clock: 15 January 2027 08:00 UTC, 10:00 on the GMT+2 broker (winter). */
const NOW = Date.UTC(2027, 0, 15, 8);
/** Broker seconds of 15 January 2027 10:00. */
const TEN = Date.UTC(2027, 0, 15, 10) / 1000;
const RULE: ClockRule = { winterOffsetMinutes: 120, dst: "us" };
const utc = (broker: number) => brokerToUtc(RULE, broker * 1000) / 1000;

type Point = { time: number; value: number | null; styleKey?: string; complete?: false };
type Values = { key: string; package: string; version: string; outputs: Record<string, Point[]>; complete: boolean; failed: string | null; stale: boolean };

/** 2,000 H1 bars ending at 09:00 today (broker time), before the app's own live candle at 10:00. */
const HST: FixtureBar[] = bars(TEN - 2000 * HOUR, HOUR, 2000);

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

async function start(t: TestContext, overrides: Partial<ServerConfig> = {}) {
  const dataFolder = await mkdtemp(join(tmpdir(), "quotebridge-ind-"));
  t.after(() => rm(dataFolder, { recursive: true, force: true }));
  const packages = join(dataFolder, "packages");
  await mkdir(join(packages, "fussy"), { recursive: true });
  for (const [name, text] of Object.entries(FUSSY)) await writeFile(join(packages, "fussy", name), text);
  await writeHst(dataFolder, BROKER, { version: 401, symbol: "EURUSD", minutes: 60, digits: 5, bars: HST });

  const clock = new FakeClock(NOW);
  const cfg: ServerConfig = {
    eaPort: await freePort(),
    httpPort: await freePort(),
    windowToken: TOKEN,
    now: clock.now,
    localOffsetMinutes: () => 0,
    terminalDataFolder: (terminalId) => (terminalId === TERMINAL ? dataFolder : undefined),
    extraIndicatorPackages: packages,
    ...overrides,
  };
  const server = await startServer(cfg);
  t.after(() => server.close());
  const origin = server.httpOrigin;
  server.addRemoteToken(REMOTE_TOKEN);
  const signIn = async (token: string) => (await fetch(`${origin}/session?token=${token}`, { redirect: "manual" })).headers.get("set-cookie")!.split(";")[0];
  const cookie = await signIn(TOKEN);
  server.addWindowToken(SECOND_TOKEN);
  const secondCookie = await signIn(SECOND_TOKEN);
  const rule = await fetch(`${origin}/api/clock-rules`, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify({ brokerServer: BROKER, ...RULE }) });
  assert.equal(rule.status, 200);
  const chart = new FakeEA({ terminal: TERMINAL, broker: BROKER, symbol: "EURUSD" }).connect(`tcp://127.0.0.1:${cfg.eaPort}`);
  t.after(() => chart.close());
  await chart.request(chart.helloWire());
  let seq = 0;
  /** A live quote at broker seconds `quoteTime`. */
  const send = (quoteTime: number, bid: number) => chart.request(chart.tickWire([{ seq: ++seq, bid, ask: bid + 0.0002, quoteTime, sampledTime: quoteTime }]));
  const feed = JSON.stringify([TERMINAL, "EURUSD"]);
  const ask = (query: Record<string, string | number>, as = cookie) =>
    fetch(`${origin}/api/indicators/values?${new URLSearchParams({ feed, period: "H1", ...Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])) })}`, { headers: { cookie: as } });
  const values = async (query: Record<string, string | number>, as = cookie) => {
    const res = await ask(query, as);
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json()) as Values;
  };
  return { origin, cookie, secondCookie, signIn, clock, send, ask, values };
}

const REMOTE_TOKEN = "remote-token-0123456789";

type PackageRow = { manifest: { id: string; name: string }; bundled: boolean; enabled: boolean; charts: number };
type PackageList = { manage: boolean; packages: PackageRow[] };

async function packageList(origin: string, cookie: string): Promise<PackageList> {
  const res = await fetch(`${origin}/api/indicators/packages`, { headers: { cookie } });
  assert.equal(res.status, 200);
  return (await res.json()) as PackageList;
}

/** Switches a package on or off as `cookie`'s session; the answer's status and body. */
async function setEnabled(origin: string, cookie: string, id: string, enabled: boolean) {
  const res = await fetch(`${origin}/api/indicators/packages/enabled`, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify({ id, enabled }) });
  return { status: res.status, body: (await res.json()) as PackageList & { error?: string } };
}

/** A window's live stream, open; `messages` collects what it hears. */
async function liveStream(t: TestContext, origin: string, cookie: string) {
  const ws = new WebSocket(`${origin.replace("http", "ws")}/live`, { headers: { origin, cookie } });
  t.after(() => ws.terminate());
  const messages: { type?: string }[] = [];
  ws.on("message", (data) => messages.push(JSON.parse(String(data))));
  await new Promise((resolve) => ws.once("open", resolve));
  return { ws, messages };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

const sma = { package: "quotebridge.ma", "p.period": 20, "p.type": "simple" };
/** The mean of the 20 closes ending at `closes[i]`. */
const mean20 = (closes: readonly number[], i: number) => closes.slice(i - 19, i + 1).reduce((a, b) => a + b, 0) / 20;
const round = (v: number | null | undefined) => (v === null || v === undefined ? v : Number(v.toFixed(10)));

test("a chart gets a package's values over its candles page, the warm-up making the first one correct, the forming bar last", { timeout: 20000 }, async (t) => {
  const { send, values } = await start(t);
  await send(TEN + 60, 1.2);

  const answer = await values({ ...sma, limit: 100 });
  assert.equal(answer.package, "quotebridge.ma");
  assert.equal(answer.version, "1.0.0");
  assert.equal(answer.failed, null);
  assert.equal(answer.stale, false);
  assert.equal(answer.complete, false);
  const points = answer.outputs.ma;
  // The page is HST's last 99 bars and the live 10:00 candle.
  assert.deepEqual(points.map((p) => p.time), [...HST.slice(-99).map((b) => utc(b.time)), utc(TEN)]);
  const closes = [...HST.map((b) => b.close), 1.2];
  assert.equal(round(points[0].value), round(mean20(closes, closes.length - 100)), "warmed up on the bars before the page");
  assert.equal(round(points.at(-1)!.value), round(mean20(closes, closes.length - 1)));
  assert.equal(points.at(-1)!.complete, false, "the forming bar");
  assert.ok(points.slice(0, -1).every((p) => p.complete === undefined));
});

test("RSI's values are on its 0–100 scale; an unknown package is 404 and a bad parameter 400", { timeout: 20000 }, async (t) => {
  const { send, values, ask } = await start(t);
  await send(TEN + 60, 1.1);
  const rsi = await values({ package: "quotebridge.rsi", "p.period": 14, limit: 50 });
  assert.equal(rsi.outputs.rsi.length, 50);
  assert.ok(rsi.outputs.rsi.every((p) => p.value !== null && p.value >= 0 && p.value <= 100));
  // Parameters left out take their defaults.
  assert.deepEqual((await values({ package: "quotebridge.rsi", limit: 50 })).outputs, rsi.outputs);

  const unknown = await ask({ package: "nobody.nothing", limit: 10 });
  assert.equal(unknown.status, 404);
  const bad = await ask({ ...sma, "p.period": 0, limit: 10 });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /Period must be a whole number from 1 to 500/);
});

test("the forming bar's values are computed again at most once a second", { timeout: 20000 }, async (t) => {
  const { clock, send, values } = await start(t);
  await send(TEN + 60, 1.2);
  const first = (await values({ ...sma, limit: 10 })).outputs.ma.at(-1)!.value;

  await send(TEN + 120, 1.4);
  clock.advance(500);
  assert.equal((await values({ ...sma, limit: 10 })).outputs.ma.at(-1)!.value, first, "within the second");

  clock.advance(500);
  const closes = [...HST.map((b) => b.close), 1.4];
  assert.equal(round((await values({ ...sma, limit: 10 })).outputs.ma.at(-1)!.value), round(mean20(closes, closes.length - 1)));
});

test("an older page computes the values again over the longer series, warmed up before it", { timeout: 20000 }, async (t) => {
  const { send, values } = await start(t);
  await send(TEN + 60, 1.2);
  const latest = await values({ ...sma, limit: 900 });
  const first = latest.outputs.ma[0].time;

  const older = await values({ ...sma, limit: 900, before: first });
  const closes = HST.map((b) => b.close);
  // The latest page held HST's last 899 bars; this one the 900 before them.
  assert.deepEqual(older.outputs.ma.map((p) => p.time), HST.slice(-1799, -899).map((b) => utc(b.time)));
  assert.equal(round(older.outputs.ma[0].value), round(mean20(closes, 2000 - 1799)));
  assert.equal(round(older.outputs.ma.at(-1)!.value), round(mean20(closes, 2000 - 900)));
  assert.equal(older.complete, false);
  // The running sum starts further back: the same values but for float rounding.
  const rounded = (v: Values) => v.outputs.ma.map((p) => [p.time, round(p.value)]);
  assert.deepEqual(rounded(await values({ ...sma, limit: 900 })), rounded(latest), "the latest page is the same");
});

test("two windows share one computation: within the second, the second window gets the first window's values", { timeout: 20000 }, async (t) => {
  const { clock, send, values, secondCookie } = await start(t);
  await send(TEN + 60, 1.2);
  const first = await values({ ...sma, limit: 10 });

  await send(TEN + 120, 1.4);
  clock.advance(400);
  const second = await values({ ...sma, limit: 10 }, secondCookie);
  assert.deepEqual(second.outputs, first.outputs);
  assert.equal(second.key, first.key);

  clock.advance(600);
  assert.notDeepEqual((await values({ ...sma, limit: 10 }, secondCookie)).outputs, first.outputs);
});

test("a failure keeps the last good values, marked stale with the reason, until the package works again", { timeout: 20000 }, async (t) => {
  const { clock, send, values } = await start(t);
  const fussy = { package: "test.fussy", limit: 5 };
  await send(TEN + 60, 1.2);
  const good = await values(fussy);
  assert.equal(good.failed, null);
  assert.equal(good.outputs.close.at(-1)!.value, 1.2);

  await send(TEN + 120, 2.5);
  clock.advance(1000);
  const failed = await values(fussy);
  assert.equal(failed.failed, "The calculation threw: too high");
  assert.equal(failed.stale, true);
  assert.deepEqual(failed.outputs, good.outputs);

  await send(TEN + 180, 1.3);
  clock.advance(1000);
  const again = await values(fussy);
  assert.equal(again.failed, null);
  assert.equal(again.stale, false);
  assert.equal(again.outputs.close.at(-1)!.value, 1.3);
});

test("a closed-bars-only package has no value at the forming bar, and none of its values move while the bar forms", { timeout: 20000 }, async (t) => {
  const { clock, send, values } = await start(t);
  const eo = { package: "quotebridge.eo", limit: 10 };
  await send(TEN + 60, 1.2);
  const first = await values(eo);
  for (const points of Object.values(first.outputs)) {
    // The page's bars are HST's last 9 and the forming 10:00 candle: the values stop at 09:00.
    assert.equal(points.at(-1)!.time, utc(HST.at(-1)!.time));
    assert.ok(points.every((p) => p.complete === undefined && p.time !== utc(TEN)));
  }
  assert.ok(first.outputs.eo.every((p) => p.value !== null));

  await send(TEN + 120, 1.9);
  clock.advance(1000);
  assert.deepEqual((await values(eo)).outputs, first.outputs, "the forming bar moved; nothing else did");

  // The next bar opens: 10:00 has closed, and has its value.
  await send(TEN + HOUR + 60, 1.3);
  clock.advance(1000);
  const closed = await values(eo);
  assert.equal(closed.outputs.eo.at(-1)!.time, utc(TEN));
  assert.ok(closed.outputs.eo.every((p) => p.complete === undefined));
});

test("the live stream tells a window when the values of a key it shows have changed", { timeout: 20000 }, async (t) => {
  const { origin, cookie, clock, send, values } = await start(t);
  await send(TEN + 60, 1.2);
  const { key } = await values({ ...sma, limit: 10 });

  const ws = new WebSocket(`${origin.replace("http", "ws")}/live`, { headers: { origin, cookie } });
  t.after(() => ws.terminate());
  const changed = new Promise<string[]>((resolve) =>
    ws.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (message.type === "indicators") resolve(message.changed);
    }),
  );
  await new Promise((resolve) => ws.once("open", resolve));
  ws.send(JSON.stringify({ type: "show", keys: [key] }));
  // The server has the list before the quote moves the forming bar.
  await new Promise((resolve) => setTimeout(resolve, 100));
  await send(TEN + 120, 1.4);
  clock.advance(1000);
  assert.deepEqual(await changed, [key]);
});

test("the package list has the bundled packages with their manifests, the Moving average and RSI first", { timeout: 20000 }, async (t) => {
  const { origin, cookie } = await start(t, { extraIndicatorPackages: undefined });
  const res = await fetch(`${origin}/api/indicators/packages`, { headers: { cookie } });
  assert.equal(res.status, 200);
  const { packages } = (await res.json()) as { packages: { manifest: { id: string; name: string }; bundled: boolean; enabled: boolean }[] };
  assert.deepEqual(
    packages.map((p) => [p.manifest.id, p.manifest.name, p.bundled, p.enabled]),
    [
      ["quotebridge.ma", "Moving average", true, true],
      ["quotebridge.rsi", "RSI", true, true],
      ["quotebridge.bollinger", "Bollinger Bands", true, true],
      ["quotebridge.macd", "MACD", true, true],
      ["quotebridge.ao", "Awesome Oscillator", true, true],
      ["quotebridge.ac", "Accelerator Oscillator", true, true],
      ["quotebridge.alligator", "Alligator", true, true],
      ["quotebridge.eo", "EO", true, true],
    ],
  );
});

test("the Indicators page lists each package with how many windows' charts use it, as the windows report", { timeout: 20000 }, async (t) => {
  const { origin, cookie, secondCookie } = await start(t, { extraIndicatorPackages: undefined });
  const first = await liveStream(t, origin, cookie);
  const second = await liveStream(t, origin, secondCookie);
  first.ws.send(JSON.stringify({ type: "charts", packages: ["quotebridge.ma", "quotebridge.rsi"] }));
  second.ws.send(JSON.stringify({ type: "charts", packages: ["quotebridge.ma"] }));
  await settle();
  const list = await packageList(origin, cookie);
  assert.equal(list.manage, true, "the app window manages packages");
  const charts = Object.fromEntries(list.packages.map((p) => [p.manifest.id, p.charts]));
  assert.deepEqual([charts["quotebridge.ma"], charts["quotebridge.rsi"], charts["quotebridge.macd"]], [2, 1, 0]);
  // A window that goes away no longer counts.
  second.ws.close();
  await settle();
  assert.equal((await packageList(origin, cookie)).packages.find((p) => p.manifest.id === "quotebridge.ma")!.charts, 1);
});

test("a package's details give its README and licence", { timeout: 20000 }, async (t) => {
  const { origin, cookie } = await start(t, { extraIndicatorPackages: undefined });
  const res = await fetch(`${origin}/api/indicators/package?id=quotebridge.eo`, { headers: { cookie } });
  assert.equal(res.status, 200);
  const details = (await res.json()) as { readme: string; licence: string };
  assert.match(details.readme, /^# EO/);
  assert.match(details.licence, /Yuexin Zhu/);
  assert.equal((await fetch(`${origin}/api/indicators/package?id=nobody.nothing`, { headers: { cookie } })).status, 404);
});

test("a package disabled from the app window stays disabled after a restart, its values not available, until it is enabled", { timeout: 30000 }, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "quotebridge-ind-settings-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const settings = { store: new SettingsStore(folder) };
  const { origin, cookie, send, ask } = await start(t, { settings });
  await send(TEN + 60, 1.2);
  const { ws, messages } = await liveStream(t, origin, cookie);

  const disabled = await setEnabled(origin, cookie, "quotebridge.rsi", false);
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.packages.find((p) => p.manifest.id === "quotebridge.rsi")!.enabled, false);
  await settle();
  assert.ok(messages.some((m) => m.type === "packages"), "windows hear that the packages changed");
  ws.close();
  const refused = await ask({ package: "quotebridge.rsi", limit: 10 });
  assert.equal(refused.status, 404);
  assert.deepEqual(await refused.json(), { error: "RSI is not available: it is disabled on the Indicators page.", notAvailable: true });

  // The same settings, another server: still disabled.
  const again = await start(t, { settings });
  await again.send(TEN + 60, 1.2);
  assert.equal((await packageList(again.origin, again.cookie)).packages.find((p) => p.manifest.id === "quotebridge.rsi")!.enabled, false);
  assert.equal((await again.ask({ package: "quotebridge.rsi", limit: 10 })).status, 404);
  assert.equal((await setEnabled(again.origin, again.cookie, "quotebridge.rsi", true)).status, 200);
  assert.equal((await again.ask({ package: "quotebridge.rsi", limit: 10 })).status, 200);
  assert.equal((await setEnabled(again.origin, again.cookie, "nobody.nothing", true)).status, 404);
});

test("a remote browser sees the packages read-only: its change is refused with 403", { timeout: 20000 }, async (t) => {
  const { origin, cookie, signIn } = await start(t);
  const remote = await signIn(REMOTE_TOKEN);
  const list = await packageList(origin, remote);
  assert.equal(list.manage, false);
  assert.ok(list.packages.length > 0);
  const refused = await setEnabled(origin, remote, "quotebridge.ma", false);
  assert.equal(refused.status, 403);
  assert.match(refused.body.error ?? "", /app window/);
  assert.equal((await packageList(origin, cookie)).packages.find((p) => p.manifest.id === "quotebridge.ma")!.enabled, true);
});

test("two packages switched off at once both stay off, after a restart too", { timeout: 30000 }, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "quotebridge-ind-settings-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const settings = { store: new SettingsStore(folder) };
  const { origin, cookie } = await start(t, { settings });
  await Promise.all([setEnabled(origin, cookie, "quotebridge.ao", false), setEnabled(origin, cookie, "quotebridge.ac", false)]);
  const off = (list: PackageList) => list.packages.filter((p) => !p.enabled).map((p) => p.manifest.id);
  assert.deepEqual(off(await packageList(origin, cookie)), ["quotebridge.ao", "quotebridge.ac"]);
  const again = await start(t, { settings });
  assert.deepEqual(off(await packageList(again.origin, again.cookie)), ["quotebridge.ao", "quotebridge.ac"]);
});
