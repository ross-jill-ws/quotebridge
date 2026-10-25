// The Settings view's endpoints on the real server: GET and POST /api/settings with a settings store
// in a temp folder. The server stays the single writer; each save is handed on (to main) like Setup's.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerConfig } from "../src/server/index.js";
import { openDatabase } from "../src/server/database.js";
import { conditionsWire, deliver, LOGIN, pageWire, heartbeat } from "./account-fixtures.js";
import { FakeClock, FakeEA, fakeTerminalIdentity } from "./fake-ea.js";
import type { SettingsView } from "../src/server/settings/index.js";
import { SettingsStore, type Settings } from "../src/shared/settings-store.js";
import { freePort } from "./free-port.js";

const TOKEN = "window-token-0123456789";

async function start(t: TestContext, options: { withSettings?: boolean; withDatabase?: boolean; now?: () => number } = {}) {
  const folder = await mkdtemp(join(tmpdir(), "quotebridge-settings-http-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const store = new SettingsStore(folder);
  const saved: Settings[] = [];
  const database = options.withDatabase ? await openDatabase(folder) : undefined;
  t.after(() => database?.checkpointAndClose());
  const cfg: ServerConfig = {
    eaPort: await freePort(),
    httpPort: await freePort(),
    windowToken: TOKEN,
    database, now: options.now, resolveTerminal: fakeTerminalIdentity,
    ...(options.withSettings === false ? {} : { settings: { store, onSaved: (s: Settings) => void saved.push(s) } }),
  };
  // The saved ports are the ones this server runs on, as in the app.
  await store.update((s) => void (s.ports = { ea: cfg.eaPort, http: cfg.httpPort }));
  const server = await startServer(cfg);
  t.after(() => server.close());
  const origin = server.httpOrigin;
  const res = await fetch(`${origin}/session?token=${TOKEN}`, { redirect: "manual" });
  const cookie = res.headers.get("set-cookie")!.split(";")[0];
  const get = async () => {
    const r = await fetch(`${origin}/api/settings`, { headers: { cookie } });
    return { status: r.status, body: (await r.json()) as SettingsView & { error?: string } };
  };
  const post = async (body: unknown) => {
    const r = await fetch(`${origin}/api/settings`, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as SettingsView & { error?: string } };
  };
  return { cfg, store, saved, get, post, server, cookie };
}

test("GET /api/settings answers the saved settings the view shows and the ports this server runs on", async (t) => {
  const { cfg, get } = await start(t);

  const { status, body } = await get();

  assert.equal(status, 200);
  assert.deepEqual(body, {
    startWithWindows: true,
    openWindowAtStartup: false,
    theme: "system",
    flashPrices: true,
    chartColours: "default",
    timeShown: "broker",
    trading: { enabled: false, maxLots: "1.0", slippage: 20 },
    orderDefaults: [],
    ports: { ea: cfg.eaPort, http: cfg.httpPort },
    portsInUse: { ea: cfg.eaPort, http: cfg.httpPort },
    manage: true,
  });
});

test("app-window trading changes are persisted and handed to the host before the response", async (t) => {
  const { store, saved, post, get } = await start(t);
  const trading = { enabled: true, maxLots: "0.10", slippage: 5 };
  const response = await post({ trading });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.trading, trading);
  assert.deepEqual((await get()).body.trading, trading);
  assert.deepEqual((await store.read()).trading, trading);
  assert.deepEqual(saved.at(-1)?.trading, trading);
});

test("remote browsers and API credentials cannot mutate trading settings", async (t) => {
  const f = await start(t);
  assert.equal(f.server.trading, undefined, "there is no ephemeral request engine without a database");
  const origin = f.server.httpOrigin;
  f.server.addRemoteToken("remote-token-0123456789");
  const exchange = await fetch(`${origin}/session?token=remote-token-0123456789`, { redirect: "manual" });
  const remote = exchange.headers.get("set-cookie")!.split(";")[0];
  for (const headers of [{ cookie: remote }, { authorization: "Bearer synthetic-not-a-key" }] as Record<string, string>[]) {
    const response = await fetch(`${origin}/api/settings`, { method: "POST", headers: { ...headers, origin, "content-type": "application/json" },
      body: JSON.stringify({ trading: { enabled: true, maxLots: "2", slippage: 1 } }) });
    assert.equal(response.status, 403);
    await response.text();
  }
  assert.equal((await f.get()).body.trading.enabled, false);
  assert.equal(f.saved.length, 0);
  // The dashboard shows the trading settings read-only where it may not change them.
  assert.equal((await f.get()).body.manage, true, "the app window manages settings");
  const remoteView = (await (await fetch(`${origin}/api/settings`, { headers: { cookie: remote } })).json()) as SettingsView;
  assert.equal(remoteView.manage, false, "a remote browser sees them read-only");
  assert.deepEqual(remoteView.trading, { enabled: false, maxLots: "1.0", slippage: 20 });
});

test("trading setting changes discard unused previews, but unrelated settings preserve approval", { timeout: 15000 }, async (t) => {
  const clock = new FakeClock();
  const f = await start(t, { withDatabase: true, now: clock.now });
  const credential = { headers: { cookie: f.cookie, origin: f.server.httpOrigin } };
  const engine = f.server.trading!;
  const ea = new FakeEA({ bars: () => [] }).connect(`tcp://127.0.0.1:${f.cfg.eaPort}`);
  t.after(() => ea.close());
  await heartbeat(f.server.bridge, ea);
  await deliver(f.server.bridge, ea, `I|1|${ea.session}|${LOGIN}|USD|1|1|1|1.0`);
  const accountId = f.server.bridge.accounts.list()[0].id;
  const rule = await fetch(`${f.server.httpOrigin}/api/clock-rules`, { method: "POST", headers: { ...credential.headers, "content-type": "application/json" },
    body: JSON.stringify({ brokerServer: ea.broker, winterOffsetMinutes: 0, dst: "none" }) });
  assert.equal(rule.status, 200);
  await rule.text();
  await f.post({ trading: { enabled: true, maxLots: "1.0", slippage: 20 } });
  const answer = async () => {
    for (let n = 0; n < 2; n++) {
      let fields = (await ea.receive()).split("|");
      while (fields[0] === "B" || fields[0] === "C") fields = (await ea.receive()).split("|");
      assert.ok(fields[0] === "V" || fields[0] === "P");
      await deliver(f.server.bridge, ea, fields[0] === "V" ? pageWire(ea, fields[3], { capturedAt: Math.floor(clock.now() / 1000) })
        : conditionsWire(ea, fields[3]).replace("|0|1700000002|", `|1|${Math.floor(clock.now() / 1000)}|`));
    }
  };
  const preview = async () => {
    const pending = engine.preview(credential, { action: "new", accountId, symbol: "EURUSD", side: "buy", type: "market", lots: "0.1" });
    await answer();
    return pending;
  };
  for (const trading of [{ enabled: true, maxLots: "0.5", slippage: 20 }, { enabled: true, maxLots: "0.5", slippage: 10 }, { enabled: false, maxLots: "0.5", slippage: 10 }]) {
    const approved = await preview();
    assert.equal((await f.post({ trading })).status, 200);
    await assert.rejects(engine.execute(credential, approved.id, true), { code: "preview-unavailable" });
    assert.deepEqual(await engine.list(credential), []);
  }
  await f.post({ trading: { enabled: true, maxLots: "0.5", slippage: 10 } });
  const approved = await preview();
  await f.post({ theme: "dark", trading: { enabled: true, maxLots: "0.5", slippage: 10 }, orderDefaults: [{ brokerServer: ea.broker, symbol: "EURUSD", lots: "0.2", stopLossPoints: "100", takeProfitPoints: null }] });
  const execution = engine.execute(credential, approved.id, true);
  await answer();
  assert.equal((await ea.receive()).split("|")[0], "X", "unrelated settings did not discard approval");
  assert.equal((await execution).origin, "app-window");
});

test("the app window saves each market's order defaults; a remote browser reads them but cannot change them", async (t) => {
  const f = await start(t);
  const orderDefaults = [{ brokerServer: "EasyForex-Demo", symbol: "BTCUSD", lots: "0.05", stopLossPoints: "50000", takeProfitPoints: "100000" }];
  const response = await f.post({ orderDefaults });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.orderDefaults, orderDefaults);
  assert.deepEqual((await f.store.read()).orderDefaults, orderDefaults);
  assert.deepEqual(f.saved.at(-1)?.orderDefaults, orderDefaults);

  const origin = f.server.httpOrigin;
  f.server.addRemoteToken("remote-token-0123456789");
  const exchange = await fetch(`${origin}/session?token=remote-token-0123456789`, { redirect: "manual" });
  const remote = exchange.headers.get("set-cookie")!.split(";")[0];
  const refused = await fetch(`${origin}/api/settings`, { method: "POST", headers: { cookie: remote, origin, "content-type": "application/json" }, body: JSON.stringify({ orderDefaults: [] }) });
  assert.equal(refused.status, 403);
  await refused.text();
  const remoteView = (await (await fetch(`${origin}/api/settings`, { headers: { cookie: remote } })).json()) as SettingsView;
  assert.deepEqual(remoteView.orderDefaults, orderDefaults);
});

test("invalid order defaults cannot save any settings", async (t) => {
  const { post, store, saved } = await start(t);
  const good = { brokerServer: "Demo-Broker", symbol: "EURUSD", lots: "0.1", stopLossPoints: null, takeProfitPoints: null };
  for (const orderDefaults of [null, {}, [null], [{ ...good, lots: "0" }], [{ ...good, lots: null }], [good, good]]) {
    const response = await post({ theme: "dark", orderDefaults });
    assert.equal(response.status, 400, JSON.stringify(orderDefaults));
    assert.match(response.body.error!, /order defaults/i);
  }
  assert.equal((await store.read()).theme, "system");
  assert.equal(saved.length, 0);
});

test("invalid trading changes cannot save any settings or notify the host", async (t) => {
  const { store, saved, post } = await start(t);
  for (const trading of [null, [], {}, { enabled: true },
    { enabled: "yes", maxLots: "1.0", slippage: 20 },
    { enabled: true, maxLots: 1, slippage: 20 },
    { enabled: true, maxLots: "0", slippage: 20 },
    { enabled: true, maxLots: "1e2", slippage: 20 },
    { enabled: true, maxLots: "1.0", slippage: -1 },
    { enabled: true, maxLots: "1.0", slippage: 0.5 },
    { enabled: true, maxLots: "1.0", slippage: 20, extra: true }]) {
    assert.equal((await post({ theme: "dark", trading })).status, 400, JSON.stringify(trading));
  }
  assert.equal((await store.read()).theme, "system");
  assert.deepEqual((await store.read()).trading, { enabled: false, maxLots: "1.0", slippage: 20 });
  assert.equal(saved.length, 0);
});

test("a change is saved by the server, answered with the new view and handed on so main applies it", async (t) => {
  const { store, saved, post } = await start(t);

  const { status, body } = await post({ openWindowAtStartup: true, theme: "dark", startWithWindows: false });

  assert.equal(status, 200);
  assert.equal(body.openWindowAtStartup, true);
  assert.equal(body.theme, "dark");
  assert.equal(body.startWithWindows, false);
  const stored = await store.read();
  assert.equal(stored.theme, "dark");
  assert.equal(stored.openWindowAtStartup, true);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].theme, "dark");
});

test("a new port is saved for the next start; the server keeps running on the old one until main restarts it", async (t) => {
  const { cfg, store, saved, post } = await start(t);
  const ea = await freePort();

  const { status, body } = await post({ ports: { ea } });

  assert.equal(status, 200);
  assert.deepEqual(body.ports, { ea, http: cfg.httpPort });
  assert.deepEqual(body.portsInUse, { ea: cfg.eaPort, http: cfg.httpPort });
  assert.deepEqual((await store.read()).ports, { ea, http: cfg.httpPort });
  assert.deepEqual(saved.at(-1)?.ports, { ea, http: cfg.httpPort });
});

test("a port that cannot work is refused with a plain reason and nothing is saved", async (t) => {
  const { cfg, store, saved, post } = await start(t);
  const busy = createServer();
  await new Promise<void>((resolve) => busy.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => busy.close(() => resolve())));
  const busyPort = (busy.address() as { port: number }).port;

  const cases: [unknown, RegExp][] = [
    [{ ports: { ea: 80 } }, /1024 to 65535/],
    [{ ports: { http: 70000 } }, /1024 to 65535/],
    [{ ports: { ea: "6000" } }, /1024 to 65535/],
    [{ ports: { ea: cfg.httpPort } }, /differ/],
    [{ ports: { http: busyPort } }, new RegExp(`${busyPort} is in use`)],
  ];
  for (const [change, reason] of cases) {
    const { status, body } = await post(change);
    assert.equal(status, 400, JSON.stringify(change));
    assert.match(body.error ?? "", reason, JSON.stringify(change));
  }
  assert.deepEqual((await store.read()).ports, { ea: cfg.eaPort, http: cfg.httpPort });
  assert.equal(saved.length, 0);
});

test("only the Settings view's own settings can be changed, with values of the right kind", async (t) => {
  const { store, saved, post } = await start(t);

  for (const change of [{ setupCompleted: false }, { managedTerminals: [] }, { theme: "purple" }, { startWithWindows: "yes" }, { flashPrices: 1 }, [], null]) {
    const { status } = await post(change);
    assert.equal(status, 400, JSON.stringify(change));
  }
  assert.equal((await store.read()).theme, "system");
  assert.equal(saved.length, 0);
});

test("without a settings store the endpoints are not there", async (t) => {
  const { get } = await start(t, { withSettings: false });
  assert.equal((await get()).status, 404);
});

test("Flash prices can be turned off and on from the Settings view", async (t) => {
  const { store, saved, post } = await start(t);

  const { status, body } = await post({ flashPrices: false });

  assert.equal(status, 200);
  assert.equal(body.flashPrices, false);
  assert.equal((await store.read()).flashPrices, false);
  assert.equal(saved.at(-1)?.flashPrices, false);
  assert.equal((await post({ flashPrices: true })).body.flashPrices, true);
});

test("Chart colours can be switched to Green on black and back from the Settings view", async (t) => {
  const { store, saved, get, post } = await start(t);
  assert.equal((await get()).body.chartColours, "default");

  const { status, body } = await post({ chartColours: "green-on-black" });

  assert.equal(status, 200);
  assert.equal(body.chartColours, "green-on-black");
  assert.equal((await store.read()).chartColours, "green-on-black");
  assert.equal(saved.at(-1)?.chartColours, "green-on-black");
  assert.equal((await post({ chartColours: "default" })).body.chartColours, "default");
  for (const value of ["classic", true, null]) {
    assert.equal((await post({ chartColours: value })).status, 400, JSON.stringify(value));
  }
});

test("Time shown is broker time by default and can be switched to local time or UTC from the Settings view", async (t) => {
  const { store, saved, get, post } = await start(t);
  assert.equal((await get()).body.timeShown, "broker");

  for (const timeShown of ["local", "utc", "broker"]) {
    const { status, body } = await post({ timeShown });
    assert.equal(status, 200);
    assert.equal(body.timeShown, timeShown);
    assert.equal((await store.read()).timeShown, timeShown);
    assert.equal(saved.at(-1)?.timeShown, timeShown);
  }
  for (const value of ["gmt", "", 0, null]) {
    const { status, body } = await post({ timeShown: value });
    assert.equal(status, 400, JSON.stringify(value));
    assert.match(body.error ?? "", /broker, local, utc/);
  }
});
