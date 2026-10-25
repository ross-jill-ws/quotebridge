// Approved seam: the public durable journal API, using real temporary DuckDB databases and restart.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { openDatabase } from "../src/server/database.js";
import { DuckDbJournalStore, isUnresolved } from "../src/server/trading/journal.js";
import type { TradeResult } from "../src/server/bridge/account-protocol.js";
import { TradingError, type TradingPreview } from "../src/server/trading/types.js";

function preview(id = "request-a", accountId = "account-a"): TradingPreview {
  return {
    id, createdAt: 100, expiresAt: 30100,
    intent: { action: "new", accountId, symbol: "EURUSD", kind: 0, ticket: "0", lots: "0.10", price: "1.10", stopLoss: "1.09", takeProfit: "1.12", expiry: null, brokerExpiry: 0, slippage: 20 },
    source: { accountId, session: "original-session", terminalId: "terminal-a", brokerServer: "Test-Demo", login: "12345678" },
    marketId: "market-a", target: null,
    settings: { enabled: true, maxLots: "1.0", slippage: 20 },
    limits: { broker: "100", ea: "1", app: "1", maxLots: "1" },
    estimates: { loss: "10.00", reward: "20.00", currency: "USD" }, warnings: ["estimate only"],
  };
}

function reply(request = "request-a", status: TradeResult["status"] = "succeeded"): TradeResult {
  return { type: "trade-result", request, session: "original-session", login: "12345678", status, ticket: status === "succeeded" ? "42" : "0", code: status === "succeeded" ? 0 : 128, message: status === "succeeded" ? "filled" : "broker response" };
}

async function database(t: TestContext) {
  const folder = await mkdtemp(join(tmpdir(), "quotebridge-journal-"));
  let db = await openDatabase(folder);
  t.after(async () => { await db.checkpointAndClose(); await rm(folder, { recursive: true, force: true }); });
  return {
    get db() { return db; },
    async restart() { await db.checkpointAndClose(); db = await openDatabase(folder); return db; },
  };
}

test("admission acknowledges a durable approved preview that survives database restart", async (t) => {
  const fixture = await database(t);
  const approved = preview();
  const admitted = await fixture.db.journal.admit(approved, "api-key", 200);
  assert.deepEqual(admitted, {
    id: "request-a", accountId: "account-a", preview: approved, origin: "api-key", outcome: "dispatching",
    createdAt: 200, updatedAt: 200, result: null, events: [],
  });
  await fixture.restart();
  assert.deepEqual(await fixture.db.journal.get("request-a"), admitted);
  assert.deepEqual(await fixture.db.journal.list(), [admitted]);
  assert.equal(await fixture.db.journal.get("never-admitted"), undefined);
});

test("result evidence cannot be attached to a different request, session or account login", async (t) => {
  const { db } = await database(t); await db.journal.admit(preview(), "api-key", 200);
  for (const changed of [{ request: "request-other" }, { session: "other-session" }, { login: "87654321" }]) {
    await assert.rejects(db.journal.result("request-a", { ...reply(), ...changed }, 300), { code: "result-mismatch" });
  }
  assert.equal((await db.journal.get("request-a"))?.outcome, "dispatching");
  assert.deepEqual((await db.journal.get("request-a"))?.events, []);
});

test("concurrent duplicates return the original admission while only the unresolved account is blocked", async (t) => {
  const { db } = await database(t);
  const [first, duplicate, blocked, independent] = await Promise.allSettled([
    db.journal.admit(preview(), "app-window", 200),
    db.journal.admit({ ...preview(), warnings: ["different caller"] }, "api-key", 201),
    db.journal.admit(preview("request-b"), "remote-browser", 202),
    db.journal.admit(preview("request-c", "account-b"), "remote-browser", 203),
  ]);
  assert.equal(first.status, "fulfilled");
  assert.deepEqual(duplicate, first, "the first approved preview, origin and timestamps win");
  assert.equal(blocked.status, "rejected");
  if (blocked.status === "rejected") {
    assert.ok(blocked.reason instanceof TradingError);
    assert.equal(blocked.reason.code, "account-unresolved");
    assert.equal(blocked.reason.status, 409);
  }
  assert.equal(independent.status, "fulfilled");
  assert.deepEqual((await db.journal.list()).map((r) => r.id), ["request-a", "request-c"]);
});

test("restart recovery durably marks unfinished dispatches unknown and never releases their account", async (t) => {
  const fixture = await database(t);
  await fixture.db.journal.admit(preview(), "app-window", 200);
  await fixture.db.journal.admit(preview("request-b", "account-b"), "api-key", 201);
  await fixture.db.journal.markUnknown("request-b", 300, "send-failed");
  await fixture.restart();
  await fixture.db.journal.recover(400);
  const recovered = await fixture.db.journal.get("request-a");
  assert.equal(recovered?.outcome, "unknown");
  assert.equal(recovered?.updatedAt, 400);
  assert.deepEqual(recovered?.events, [{ type: "unknown", at: 400, reason: "restart" }]);
  assert.ok(recovered && isUnresolved(recovered));
  assert.deepEqual((await fixture.db.journal.get("request-b"))?.events, [{ type: "unknown", at: 300, reason: "send-failed" }]);
  await fixture.db.journal.recover(500);
  assert.deepEqual(await fixture.db.journal.get("request-a"), recovered, "recovery is idempotent");
  await fixture.restart();
  assert.deepEqual(await fixture.db.journal.get("request-a"), recovered);
  await assert.rejects(fixture.db.journal.admit(preview("request-c"), "api-key", 600), { code: "account-unresolved" });
  assert.equal((await fixture.db.journal.admit(preview("request-d", "account-c"), "remote-browser", 601)).outcome, "dispatching");
});

test("broker evidence resolves unknown, duplicate replies are idempotent, and definitive outcomes never downgrade", async (t) => {
  const fixture = await database(t);
  const store = fixture.db.journal;
  await store.admit(preview(), "api-key", 200);
  const ambiguous = await store.result("request-a", reply("request-a", "unknown"), 300);
  assert.equal(ambiguous.outcome, "unknown");
  assert.ok(isUnresolved(ambiguous));
  assert.equal(ambiguous.result?.code, 128);
  const success = await store.result("request-a", reply(), 400);
  assert.equal(success.outcome, "succeeded");
  assert.equal(isUnresolved(success), false);
  assert.deepEqual(success.result, reply());
  assert.deepEqual(await store.result("request-a", reply(), 500), success);
  assert.deepEqual(await store.markUnknown("request-a", 501, "late-timeout"), success);
  const lateUnknown = await store.result("request-a", { ...reply("request-a", "unknown"), message: "late ambiguous response" }, 502);
  assert.equal(lateUnknown.outcome, "succeeded");
  assert.deepEqual(lateUnknown.result, reply());
  assert.deepEqual(lateUnknown.events, [
    { type: "result", at: 300, result: reply("request-a", "unknown") },
    { type: "result", at: 400, result: reply() },
    { type: "result", at: 502, result: { ...reply("request-a", "unknown"), message: "late ambiguous response" } },
  ]);
  await store.admit(preview("request-b"), "remote-browser", 600);
  const failed = await store.result("request-b", { ...reply("request-b", "rejected"), code: 134, message: "not enough money" }, 700);
  assert.equal(failed.outcome, "failed");
  assert.equal(isUnresolved(failed), false);
  assert.equal(failed.result?.code, 134);
  await store.recover(800);
  await fixture.restart();
  assert.deepEqual(await fixture.db.journal.list(), [lateUnknown, failed]);
  assert.deepEqual(await fixture.db.journal.result("request-a", reply(), 899), lateUnknown, "duplicate evidence stays idempotent after restart");
  assert.equal((await fixture.db.journal.admit(preview("request-c"), "app-window", 900)).outcome, "dispatching");
});

test("explicit unknown review releases the account without inventing an outcome and survives a late result", async (t) => {
  const fixture = await database(t);
  const store = fixture.db.journal;
  await store.admit(preview(), "app-window", 200);
  await assert.rejects(store.review("request-a", "Checked MetaTrader", true, 201), { code: "request-not-unknown", status: 409 });
  await store.markUnknown("request-a", 300, "timeout");
  const beforeReview = await store.get("request-a");
  for (const [note, acknowledged] of [["short", true], ["        ", true], ["x".repeat(501), true], ["Checked MetaTrader", false]] as const) {
    await assert.rejects(store.review("request-a", note, acknowledged, 350), { code: "invalid-review", status: 422 });
    assert.deepEqual(await store.get("request-a"), beforeReview);
  }
  const reviewed = await store.review("request-a", "Checked MetaTrader", true, 400);
  assert.equal(reviewed.outcome, "unknown");
  assert.equal(reviewed.result, null);
  assert.equal(isUnresolved(reviewed), false);
  assert.deepEqual(reviewed.events, [
    { type: "unknown", at: 300, reason: "timeout" },
    { type: "review", at: 400, note: "Checked MetaTrader", acknowledged: true },
  ]);
  await fixture.restart();
  await fixture.db.journal.recover(500);
  assert.deepEqual(await fixture.db.journal.get("request-a"), reviewed);
  await fixture.db.journal.review("request-a", "12345678", true, 501);
  await fixture.db.journal.review("request-a", "x".repeat(500), true, 502);
  const repeated = await fixture.db.journal.review("request-a", "12345678", true, 503);
  assert.equal(repeated.events.length, 5, "separate acknowledgements, including repeated notes, are evidence");
  await fixture.db.journal.admit(preview("request-b"), "api-key", 600);
  const resolved = await fixture.db.journal.result("request-a", reply(), 700);
  assert.equal(resolved.outcome, "succeeded");
  assert.deepEqual(resolved.events.slice(0, 5), repeated.events, "late result never erases review history");
  await assert.rejects(fixture.db.journal.review("request-a", "Checked MetaTrader", true, 701), { code: "request-not-unknown" });
  await assert.rejects(fixture.db.journal.admit(preview("request-c"), "api-key", 702), { code: "account-unresolved" });
  assert.deepEqual(await fixture.db.journal.admit(preview(), "api-key", 703), resolved, "review never authorizes a duplicate dispatch");
});

test("input and returned-object mutation cannot change approved intent or durable evidence", async (t) => {
  const fixture = await database(t);
  const store = fixture.db.journal;
  const input = preview();
  const pending = store.admit(input, "app-window", 200);
  input.id = "mutated-id";
  input.intent.lots = "99";
  input.source.session = "mutated-session";
  input.warnings.push("mutated warning");
  const admitted = await pending;
  assert.equal(admitted.id, "request-a");
  assert.equal(admitted.preview.intent.lots, "0.10");
  assert.equal(admitted.preview.source.session, "original-session");
  admitted.preview.intent.lots = "98";
  admitted.events.push({ type: "review", at: 201, note: "invented review", acknowledged: true });
  const listed = await store.list();
  assert.equal(listed[0].preview.intent.lots, "0.10");
  assert.deepEqual(listed[0].preview.warnings, ["estimate only"]);
  assert.deepEqual(listed[0].events, []);
  listed[0].preview.settings.enabled = false;
  const evidence = reply();
  const resolving = store.result("request-a", evidence, 300);
  evidence.message = "caller changed reply";
  evidence.ticket = "99";
  const resolved = await resolving;
  assert.deepEqual(resolved.result, reply());
  resolved.result!.ticket = "98";
  if (resolved.events[0].type === "result") resolved.events[0].result.message = "changed returned evidence";
  const retrieved = await store.get("request-a");
  assert.deepEqual(retrieved?.result, reply());
  assert.deepEqual(retrieved?.events, [{ type: "result", at: 300, result: reply() }]);
  assert.equal(retrieved?.preview.settings.enabled, true);
  retrieved!.events.length = 0;
  await fixture.restart();
  assert.deepEqual((await fixture.db.journal.get("request-a"))?.events, [{ type: "result", at: 300, result: reply() }]);
});

test("failed storage rejects admission with a static safe error and leaves no durable request", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "quotebridge-journal-readonly-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const initialized = await openDatabase(folder);
  const file = initialized.file;
  await initialized.checkpointAndClose();
  const instance = await DuckDBInstance.create(file, { access_mode: "READ_ONLY" });
  const store = new DuckDbJournalStore(await instance.connect());
  try {
    await assert.rejects(store.admit(preview(), "api-key", 200), (error: unknown) => {
      assert.ok(error instanceof TradingError);
      assert.equal(error.code, "journal-unavailable");
      assert.equal(error.status, 503);
      assert.equal(error.message, "journal-unavailable");
      assert.equal(error.cause, undefined);
      assert.ok(!JSON.stringify(error).includes("12345678"));
      assert.ok(!String(error).includes(file));
      return true;
    });
    assert.equal(await store.get("request-a"), undefined);
    assert.deepEqual(await store.list(), [], "a failed transaction does not poison the queue");
  } finally {
    await store.settled();
    store.close();
    instance.closeSync();
  }
  const reopened = await openDatabase(folder);
  try {
    assert.deepEqual(await reopened.journal.list(), []);
    assert.equal((await reopened.journal.admit(preview(), "api-key", 300)).outcome, "dispatching");
  } finally { await reopened.checkpointAndClose(); }
});

test("acknowledged admission survives abrupt process exit without checkpoint and recovers from the WAL", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "quotebridge-journal-crash-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const moduleUrl = new URL("../src/server/database.ts", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import { openDatabase } from ${JSON.stringify(moduleUrl)};
    const db = await openDatabase(${JSON.stringify(folder)});
    await db.journal.admit(${JSON.stringify(preview())}, "app-window", 200);
    process.exit(0);
  `], { encoding: "utf8", timeout: 30000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  const db = await openDatabase(folder);
  try {
    const saved = await db.journal.get("request-a");
    assert.equal(saved?.outcome, "dispatching");
    assert.equal(saved?.preview.intent.lots, "0.10");
    await db.journal.recover(400);
    assert.equal((await db.journal.get("request-a"))?.outcome, "unknown");
    assert.deepEqual(await db.journal.admit(preview(), "api-key", 500), await db.journal.get("request-a"));
  } finally { await db.checkpointAndClose(); }
});
