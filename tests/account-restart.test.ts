// Approved seam: real server/database restarts, FakeEA over ZeroMQ, observations through bridge.accounts.
// Only identity is durable; no HTTP trading routes (#65), SQL inspection or implementation substitutes.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { openDatabase, startServer, type AppDatabase, type RunningServer } from "../src/server/index.js";
import type { AccountIdentity } from "../src/server/identity/index.js";
import { LOGIN, deliver, heartbeat, orderRow, publishSnapshot, readError } from "./account-fixtures.js";
import { FakeClock, FakeEA, fakeTerminalIdentity, type FakeEAOptions } from "./fake-ea.js";
import { freePort } from "./free-port.js";

async function runtime(t: TestContext) {
  const folder = await mkdtemp(join(tmpdir(), "quotebridge-account-restart-"));
  const clock = new FakeClock();
  const eas = new Set<FakeEA>();
  let database: AppDatabase | undefined;
  let server: RunningServer | undefined;
  let endpoint: string;
  let serial = 0;
  const stop = async () => {
    for (const ea of eas) ea.close();
    eas.clear();
    const running = server;
    server = undefined;
    try { await running?.close(); }
    finally {
      const db = database;
      database = undefined;
      await db?.checkpointAndClose();
    }
  };
  t.after(async () => {
    try { await stop(); }
    finally { await rm(folder, { recursive: true, force: true }); }
  });
  const start = async (beforeStart?: (db: AppDatabase) => Promise<unknown>) => {
    assert.equal(server, undefined, "stop the runtime before reopening its database");
    assert.equal(database, undefined);
    database = await openDatabase(folder);
    await beforeStart?.(database);
    const eaPort = await freePort();
    endpoint = `tcp://127.0.0.1:${eaPort}`;
    server = await startServer({
      eaPort, httpPort: await freePort(), windowToken: "account-restart-window-token",
      database, now: clock.now, localOffsetMinutes: () => 0, resolveTerminal: fakeTerminalIdentity,
    });
    return server;
  };
  const connect = async (options: FakeEAOptions = {}) => {
    assert.ok(server);
    const n = ++serial;
    const ea = new FakeEA({
      terminal: `mt4-restart-${n}`, session: `restart-chart-${n}`, symbol: `FIXTURE${n}`,
      eaVersion: "1.12", bars: () => "loading", ...options,
    }).connect(endpoint);
    eas.add(ea);
    // Answer unrelated startup bar requests in FakeEA's pump; receive() sees account/control messages only.
    await heartbeat(server.bridge, ea);
    await deliver(server.bridge, ea, `I|1|${ea.session}|${LOGIN}|USD|1|0|1|0.5000000000`);
    const account = server.bridge.accounts.list().find((a) => a.brokerServer === ea.broker && a.login === LOGIN);
    assert.ok(account, "an announcement makes the trading account discoverable");
    return { ea, account };
  };
  return { start, stop, connect };
}

function offline(identity: AccountIdentity) {
  return {
    id: identity.id, brokerServer: identity.brokerServer, login: identity.login, label: identity.label,
    connected: false, demo: null, ready: null, state: "unavailable",
    funds: { balance: null, equity: null, margin: null, freeMargin: null, profit: null, marginLevel: null, currency: null, leverage: null },
    positions: [], orders: [], source: null, sources: [],
  };
}

test("runtime restart keeps a known trading account but discards Funds, positions, pending orders and live provenance", { timeout: 20000 }, async (t) => {
  const app = await runtime(t);
  const first = await app.start();
  assert.deepEqual(first.bridge.accounts.list(), []);
  const { ea, account } = await app.connect();
  const live = await publishSnapshot(first.bridge, ea, account.id, {
    total: 2, rows: [orderRow(101), orderRow(102, 2)],
  });
  assert.equal(live.id, account.id);
  assert.equal(live.connected, true);
  assert.equal(live.state, "fresh");
  assert.deepEqual(live.funds, {
    balance: "1000.0000000000", equity: "999.0000000000", margin: "10.0000000000",
    freeMargin: "989.0000000000", profit: "-1.0000000000", marginLevel: "9990.0000000000",
    currency: "USD", leverage: 100,
  });
  assert.deepEqual(live.positions.map((p) => [p.ticket, p.kind, p.symbol]), [["101", 0, "EURUSD"]]);
  assert.deepEqual(live.orders.map((o) => [o.ticket, o.kind, o.symbol]), [["102", 2, "EURUSD"]]);
  assert.equal(live.source?.terminalId, ea.terminal);
  assert.equal(live.source?.session, ea.session);

  await app.stop(); // Close the real server before checkpointing/closing its database, just like the host.
  const restarted = await app.start();
  assert.deepEqual(restarted.bridge.accounts.list(), [offline(account)]);
  assert.deepEqual(restarted.bridge.accounts.get(account.id), offline(account));
  await assert.rejects(restarted.bridge.accounts.read(account.id), readError("unavailable-source", 503));
});

test("a new terminal installation reuses the persisted broker/login account ID, but another broker server is distinct", { timeout: 20000 }, async (t) => {
  const app = await runtime(t);
  await app.start();
  const original = await app.connect();
  await app.stop();

  const restarted = await app.start();
  assert.deepEqual(restarted.bridge.accounts.list(), [offline(original.account)], "identity exists before any new EA announces");
  const replacement = await app.connect();
  assert.notEqual(replacement.ea.terminal, original.ea.terminal);
  assert.notDeepEqual(replacement.ea.identity, original.ea.identity, "both installation and data-folder paths change");
  assert.equal(replacement.account.id, original.account.id);
  assert.equal(replacement.account.label, original.account.label);
  assert.equal(replacement.account.connected, true);
  assert.deepEqual(replacement.account.sources.map((s) => s.terminalId), [replacement.ea.terminal]);
  assert.equal(restarted.bridge.accounts.list().length, 1, "reinstallation must not duplicate a trading account");

  const other = await app.connect({ broker: "Other-Broker" });
  assert.equal(other.account.login, original.account.login);
  assert.equal(other.account.brokerServer, "Other-Broker");
  assert.notEqual(other.account.id, original.account.id);
  assert.equal(restarted.bridge.accounts.list().length, 2);

  await app.stop();
  const again = await app.start();
  assert.equal(again.bridge.accounts.list().length, 2);
  assert.deepEqual(again.bridge.accounts.get(original.account.id), offline(original.account));
  assert.deepEqual(again.bridge.accounts.get(other.account.id), offline(other.account));
});

test("a journal-only identity registered before server startup is known offline and survives runtime restart without an EA", { timeout: 20000 }, async (t) => {
  const app = await runtime(t);
  let registered!: AccountIdentity;
  const first = await app.start(async (db) => {
    registered = await db.identities.put({ brokerServer: "Journal-Only", login: "12345678", label: "Imported trading account" });
  });
  assert.deepEqual(first.bridge.accounts.list(), [offline(registered)]);
  assert.equal(first.bridge.accounts.get(registered.id)?.label, "Imported trading account");

  await app.stop();
  const restarted = await app.start();
  assert.deepEqual(restarted.bridge.accounts.list(), [offline(registered)]);
  assert.deepEqual(restarted.bridge.accounts.get(registered.id), offline(registered));
  await assert.rejects(restarted.bridge.accounts.read(registered.id), readError("unavailable-source", 503));
});
