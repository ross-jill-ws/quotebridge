import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import type { BridgeSnapshot } from "../src/server/bridge/index.js";
import { PortInUseError, startServer, type ServerConfig } from "../src/server/index.js";
import WebSocket from "ws";
import { FakeClock, FakeEA, freePort, type FakeEAOptions } from "./fake-ea.js";

async function config(overrides: Partial<ServerConfig> = {}): Promise<ServerConfig> {
  return { eaPort: await freePort(), httpPort: await freePort(), windowToken: TOKEN, ...overrides };
}

const TOKEN = "window-token-0123456789";

async function start(t: TestContext, overrides: Partial<ServerConfig> = {}) {
  const cfg = await config(overrides);
  const server = await startServer(cfg);
  t.after(() => server.close());
  const ea = (options?: FakeEAOptions) => {
    const fake = new FakeEA(options).connect(`tcp://127.0.0.1:${cfg.eaPort}`);
    t.after(() => fake.close());
    return fake;
  };
  return { server, cfg, origin: server.httpOrigin, ea };
}

/** The app window opening /session?token=…: returns the session cookie it is given, or the refusal status. */
async function exchange(origin: string, token = TOKEN) {
  const res = await fetch(`${origin}/session?token=${encodeURIComponent(token)}`, { redirect: "manual" });
  const setCookie = res.headers.get("set-cookie");
  return { status: res.status, location: res.headers.get("location"), setCookie, cookie: setCookie?.split(";")[0] };
}

async function signIn(origin: string) {
  const { cookie } = await exchange(origin);
  assert.ok(cookie, "no session cookie");
  return cookie;
}

/** Opens /live and collects its snapshots; rejects with the HTTP status of a refused upgrade. */
function openLive(origin: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(`${origin.replace("http", "ws")}/live`, { headers: { origin, ...headers } });
  const snapshots = collect(ws);
  return new Promise<{ ws: WebSocket } & ReturnType<typeof collect>>((resolve, reject) => {
    ws.once("open", () => resolve({ ws, ...snapshots }));
    ws.once("unexpected-response", (_req, res) => reject(Object.assign(Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    ws.once("error", reject);
  });
}

/** Holds a port the way another program (e.g. the legacy server) would. */
async function occupy(t: TestContext, port: number) {
  const holder = createServer();
  await new Promise<void>((resolve) => holder.listen(port, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => holder.close(() => resolve())));
}

test("an EA port already in use is reported as a structured port-in-use error", { timeout: 10000 }, async (t) => {
  const cfg = await config();
  await occupy(t, cfg.eaPort);

  const error = await startServer(cfg).then(
    () => assert.fail("started on a busy port"),
    (e: unknown) => e,
  );

  assert.ok(error instanceof PortInUseError);
  assert.equal(error.code, "port-in-use");
  assert.equal(error.which, "ea");
  assert.equal(error.port, cfg.eaPort);
});

test("an HTTP port already in use is reported as port-in-use and releases the EA port", { timeout: 10000 }, async (t) => {
  const cfg = await config();
  await occupy(t, cfg.httpPort);

  const error = await startServer(cfg).then(
    () => assert.fail("started on a busy port"),
    (e: unknown) => e,
  );

  assert.ok(error instanceof PortInUseError);
  assert.equal(error.which, "http");
  assert.equal(error.port, cfg.httpPort);
  // Nothing stays bound: a retry on a free HTTP port gets the same EA port.
  const server = await startServer({ ...cfg, httpPort: await freePort() });
  await server.close();
});

test("requests without a session are rejected: dashboard, state endpoint and live WebSocket", { timeout: 10000 }, async (t) => {
  const { origin } = await start(t);

  for (const path of ["/", "/index.html", "/api/state"]) {
    const res = await fetch(origin + path);
    assert.equal(res.status, 401, path);
  }
  const forged = await fetch(origin + "/api/state", { headers: { cookie: "qb_session=forged" } });
  assert.equal(forged.status, 401);
  await assert.rejects(openLive(origin), { status: 401 });
});

test("the window token is exchanged once for a session that opens the dashboard and state endpoint", { timeout: 10000 }, async (t) => {
  const { origin } = await start(t);

  const first = await exchange(origin);
  assert.equal(first.status, 303);
  assert.equal(first.location, "/");
  assert.match(first.setCookie ?? "", /^qb_session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Strict$/);

  const page = await fetch(origin + "/", { headers: { cookie: first.cookie! } });
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
  assert.match(await page.text(), /QuoteBridge for MetaTrader/);

  const state = await fetch(origin + "/api/state", { headers: { cookie: first.cookie! } });
  assert.equal(state.status, 200);
  assert.deepEqual((await state.json()).feeds, []);

  const again = await exchange(origin);
  assert.equal(again.status, 401);
  assert.equal(again.setCookie, null);
  assert.equal((await exchange(origin, "not-the-window-token-at-all")).status, 401);
});

/** Collects live WebSocket snapshots with their arrival times. */
function collect(ws: WebSocket) {
  const received: { at: number; snapshot: BridgeSnapshot }[] = [];
  const waiters: (() => void)[] = [];
  ws.on("message", (data) => {
    received.push({ at: performance.now(), snapshot: JSON.parse(String(data)) });
    waiters.splice(0).forEach((w) => w());
  });
  /** Resolves with the first snapshot (from index `from`) that satisfies `match`. */
  async function until(match: (s: BridgeSnapshot) => boolean, from = 0) {
    for (;;) {
      const hit = received.slice(from).find((r) => match(r.snapshot));
      if (hit) return hit.snapshot;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error("no matching snapshot")), 3000);
        waiters.push(() => (clearTimeout(timer), resolve()));
      });
    }
  }
  return { received, until };
}

test("the live WebSocket sends a snapshot on connect and new snapshots as the fake EA sends ticks", { timeout: 10000 }, async (t) => {
  const { origin, ea } = await start(t);
  const { ws, until } = await openLive(origin, { cookie: await signIn(origin) });
  t.after(() => ws.terminate());

  assert.deepEqual((await until(() => true)).feeds, []);

  const chart = ea({ terminal: "mt4-aaaaaaaaaaaa", symbol: "EURUSD" });
  await chart.request(chart.helloWire());
  const hello = await until((s) => s.feeds.length === 1);
  assert.equal(hello.feeds[0].symbol, "EURUSD");
  assert.equal(hello.feeds[0].online, true);
  assert.deepEqual(hello.terminals.map((p) => [p.terminalId, p.eaVersion]), [["mt4-aaaaaaaaaaaa", "1.08"]]);

  await chart.request(chart.tickWire([{ seq: 1, bid: 1.1, ask: 1.1002, quoteTime: 1700000000 }]));
  const tick = await until((s) => s.feeds[0]?.latest?.seq === 1);
  assert.equal(tick.feeds[0].latest?.bid, 1.1);
  assert.equal(tick.feeds[0].latest?.ask, 1.1002);
});

test("live snapshots are sent at most every 500 ms and the last change is never lost", { timeout: 10000 }, async (t) => {
  const { origin, ea } = await start(t);
  const { ws, received, until } = await openLive(origin, { cookie: await signIn(origin) });
  t.after(() => ws.terminate());
  await until(() => true);
  const chart = ea();
  await chart.request(chart.helloWire());

  // 15 tick batches over about 1.5 s.
  for (let seq = 1; seq <= 15; seq++) {
    await chart.request(chart.tickWire([{ seq, bid: 1 + seq / 1000, ask: 1.0002 + seq / 1000, quoteTime: 1700000000 + seq }]));
    await new Promise((r) => setTimeout(r, 100));
  }

  await until((s) => s.feeds[0]?.latest?.seq === 15);
  const gaps = received.slice(1).map((r, i) => r.at - received[i].at);
  assert.ok(gaps.every((gap) => gap >= 480), `gaps ${gaps.map(Math.round)}`);
  assert.ok(received.length <= 6, `${received.length} snapshots`);
});

test("a feed going offline reaches the live WebSocket without any EA message", { timeout: 10000 }, async (t) => {
  const clock = new FakeClock();
  const { origin, ea } = await start(t, { now: clock.now });
  const { ws, until } = await openLive(origin, { cookie: await signIn(origin) });
  t.after(() => ws.terminate());
  const chart = ea();
  await chart.request(chart.helloWire());
  await until((s) => s.feeds[0]?.online === true);

  clock.advance(7000);

  assert.equal((await until((s) => s.feeds[0]?.online === false)).feeds.length, 1);
});

test("a page on another origin cannot use the session: live WebSocket and changes are refused", { timeout: 10000 }, async (t) => {
  const { origin } = await start(t);
  const cookie = await signIn(origin);
  const otherOrigin = "http://127.0.0.1:1";

  await assert.rejects(openLive(origin, { cookie, origin: otherOrigin }), { status: 403 });
  const res = await fetch(origin + "/api/feeds/remove", {
    method: "POST",
    headers: { cookie, origin: otherOrigin, "content-type": "application/json" },
    body: JSON.stringify({ feed: "x" }),
  });
  assert.equal(res.status, 403);
});

test("an offline feed can be removed over HTTP; an online feed cannot", { timeout: 10000 }, async (t) => {
  const clock = new FakeClock();
  const { origin, ea } = await start(t, { now: clock.now });
  const cookie = await signIn(origin);
  const remove = (feed: unknown) =>
    fetch(origin + "/api/feeds/remove", { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify({ feed }) });
  const state = async () => (await (await fetch(origin + "/api/state", { headers: { cookie } })).json()) as BridgeSnapshot;
  const chart = ea({ terminal: "mt4-aaaaaaaaaaaa", broker: "Demo-Broker", symbol: "EURUSD" });
  await chart.request(chart.helloWire());
  const feed = '["mt4-aaaaaaaaaaaa","Demo-Broker","EURUSD"]';

  const online = await remove(feed);
  assert.equal(online.status, 409);
  assert.match((await online.json()).error, /online/);
  assert.equal((await remove("unknown")).status, 409);
  assert.equal((await remove(42)).status, 400);

  clock.advance(7000);
  assert.equal((await remove(feed)).status, 204);
  assert.deepEqual((await state()).feeds, []);
});
