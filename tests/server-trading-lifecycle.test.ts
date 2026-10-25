// Approved server/engine lifecycle seam: real DuckDB, ZeroMQ and temporary files.
// Only the OS directory-read boundary is deferred; no product modules are mocked.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Dealer } from "zeromq";
import { openDatabase } from "../src/server/database.js";
import { startServer } from "../src/server/server.js";
import type { TradingPreview } from "../src/server/trading/types.js";
import { LOGIN, resultWire } from "./account-fixtures.js";
import { FakeEA, fakeTerminalIdentity } from "./fake-ea.js";
import { freePort } from "./free-port.js";

function approved(ea: FakeEA): TradingPreview {
  return {
    id: "a".repeat(32), createdAt: 100, expiresAt: 30100,
    intent: { action: "new", accountId: "fixture-account", symbol: "EURUSD", kind: 0, ticket: "0", lots: "0.1", price: "1.1", stopLoss: "0", takeProfit: "0", expiry: null, brokerExpiry: 0, slippage: 20 },
    source: { accountId: "fixture-account", session: ea.session, terminalId: ea.terminal, brokerServer: ea.broker, login: LOGIN },
    marketId: "fixture-market", target: null,
    settings: { enabled: true, maxLots: "1", slippage: 20 },
    limits: { broker: "100", ea: "1", app: "1", maxLots: "1" },
    estimates: { loss: null, reward: null, currency: "USD" }, warnings: [],
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("a queued original-session result is journaled from the first received startup message", { timeout: 15000 }, async (t) => {
  const folder = await fs.mkdtemp(join(tmpdir(), "qb-startup-result-"));
  const database = await openDatabase(folder);
  const eaPort = await freePort();
  const ea = new FakeEA();
  const socket = new Dealer({ routingId: ea.session, receiveTimeout: 10000, linger: 0 });
  socket.connect(`tcp://127.0.0.1:${eaPort}`);
  const preview = approved(ea);
  t.after(async () => { socket.close(); ea.close(); await database.checkpointAndClose(); await fs.rm(folder, { recursive: true, force: true }); });
  await database.journal.admit(preview, "app-window", 200);
  // A restarted EA already has its original result buffered before the app binds.
  await socket.send(resultWire(ea, preview.id));
  await socket.send(ea.helloWire());
  const hello = socket.receive().then(([frame]) => frame.toString());
  void hello.catch(() => {});
  const original = fs.readdir;
  t.mock.method(fs, "readdir", (async (...args: Parameters<typeof fs.readdir>) => {
    if (args[0] === folder) {
      let timer: NodeJS.Timeout | undefined;
      try {
        // If transport was bound too early, let its queued messages finish before startup proceeds.
        // Correct startup cannot reply yet, so the bounded OS delay releases it instead.
        await Promise.race([hello, new Promise<void>((resolve) => { timer = setTimeout(resolve, 1000); })]);
      } finally { clearTimeout(timer); }
    }
    return original(...args);
  }) as typeof fs.readdir);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const server = await startServer({ eaPort, httpPort: await freePort(), windowToken: "startup-result-fixture-token", openDashboard: true, database, resolveTerminal: fakeTerminalIdentity, extraIndicatorPackages: folder });
  try {
    assert.equal(await hello, `C|1|${ea.session}|1`);
    assert.equal((await server.trading!.get({ headers: {} }, preview.id)).outcome, "succeeded");
    assert.equal(server.bridge.snapshot().invalidMessages, 0);
  } finally { await server.close(); }
});

test("normal shutdown waits for accepted result handling and retains its durable outcome", { timeout: 15000 }, async (t) => {
  const folder = await fs.mkdtemp(join(tmpdir(), "qb-shutdown-result-"));
  const database = await openDatabase(folder);
  const eaPort = await freePort();
  const ea = new FakeEA().connect(`tcp://127.0.0.1:${eaPort}`);
  const preview = approved(ea);
  await database.journal.admit(preview, "app-window", 200);
  const server = await startServer({ eaPort, httpPort: await freePort(), windowToken: "shutdown-result-fixture-token", openDashboard: true, database });
  const received = deferred(), release = deferred();
  const unsubscribe = server.bridge.accounts.onResult(async () => { received.resolve(); await release.promise; });
  t.after(async () => { release.resolve(); unsubscribe(); await server.close(); ea.close(); await database.checkpointAndClose(); await fs.rm(folder, { recursive: true, force: true }); });
  await server.trading!.stopAdmissions();
  await ea.send(resultWire(ea, preview.id));
  await received.promise;
  let closed = false;
  const closing = server.close().then(() => { closed = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false, "shutdown must wait for an accepted receive operation");
  release.resolve();
  await closing;
  assert.equal((await server.trading!.get({ headers: {} }, preview.id)).outcome, "succeeded");
});
