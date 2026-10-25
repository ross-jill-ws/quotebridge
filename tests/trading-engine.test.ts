import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ApiKeys } from "../src/server/auth/index.js";
import { openDatabase } from "../src/server/database.js";
import { RequestEngine } from "../src/server/trading/engine.js";
import type { TradingSettings, TradeInput } from "../src/server/trading/types.js";
import { conditionsWire, deliver, heartbeat, LOGIN, OTHER_LOGIN, orderRow, pageWire, resultWire, startAccounts, type Page } from "./account-fixtures.js";
import type { FakeEA } from "./fake-ea.js";

async function setup(t: TestContext) {
  const fixture = await startAccounts(t);
  const folder = await mkdtemp(join(tmpdir(), "qb-engine-"));
  const db = await openDatabase(folder);
  t.after(async () => { await db.checkpointAndClose(); await rm(folder, { recursive: true, force: true }); });
  const keys = await ApiKeys.open(db.apiKeys, fixture.clock.now);
  const trader = await keys.create({ name: "Trader", scope: "trader" });
  const readonly = await keys.create({ name: "Reader", scope: "readonly" });
  let settings: TradingSettings = { enabled: true, maxLots: "1", slippage: 20 };
  const options = {
    bridge: fixture.bridge, journal: db.journal, now: fixture.clock.now,
    settings: async () => settings, clockRule: () => ({ winterOffsetMinutes: 0, dst: "none" as const }),
    authorize: (key: string, write: boolean) => keys.check(key, write).ok ? "api-key" as const : undefined,
  };
  let engine = await RequestEngine.open(options);
  t.after(() => engine.close());
  const ea = await fixture.connect();
  const account = await fixture.announce(ea, { enabled: true });
  const input: TradeInput = { action: "new", accountId: account.id, symbol: "EURUSD", side: "buy", type: "market", lots: "0.1" };
  async function answer(ea: FakeEA, page: Page = {}, conditions?: (wire: string) => string) {
    // Account and contract reads start together and share the five-second deadline.
    for (let n = 0; n < 2; n++) {
      const wire = await ea.receive(), f = wire.split("|");
      assert.ok(f[0] === "V" || f[0] === "P");
      const response = f[0] === "V" ? pageWire(ea, f[3], { capturedAt: Math.floor(fixture.clock.now() / 1000), ...page })
        : conditionsWire(ea, f[3], f[6], page.login ?? LOGIN).replace("|0|1700000002|", `|1|${Math.floor(fixture.clock.now() / 1000)}|`);
      await deliver(fixture.bridge, ea, f[0] === "P" && conditions ? conditions(response) : response);
    }
  }
  return { ...fixture, get engine() { return engine; }, db, keys, trader, readonly, ea, account, input, answer,
    changeSettings: (next: TradingSettings) => { settings = next; engine.settingsChanged(); },
    restartEngine: async () => { await engine.close(); engine = await RequestEngine.open(options); } };
}

type Fixture = Awaited<ReturnType<typeof setup>>;
async function approve(f: Fixture, input: TradeInput = f.input, ea = f.ea, page: Page = {}) {
  const pending = f.engine.preview(f.trader.key, input); await f.answer(ea, page); return pending;
}
async function dispatch(f: Fixture, id: string, ea = f.ea, page: Page = {}) {
  const pending = f.engine.execute(f.trader.key, id, true); await f.answer(ea, page);
  const wire = await ea.receive(); assert.ok(wire.startsWith(`X|1|${ea.session}|${id}|`));
  return pending;
}

test("preview uses fresh executor reads, is non-durable and returns detached approved intent", async (t) => {
  const f = await setup(t);
  const pending = f.engine.preview(f.trader.key, f.input);
  await f.answer(f.ea);
  const preview = await pending;
  assert.equal(preview.intent.lots, "0.1");
  assert.equal(preview.expiresAt - preview.createdAt, 30_000);
  assert.deepEqual(await f.engine.list(f.trader.key), []);
  preview.intent.lots = "99";
  await assert.rejects(f.engine.execute(f.trader.key, preview.id, false), { code: "confirmation-required" });
});

test("unknown blocks only its account, review needs acknowledgement, and late evidence preserves review", async (t) => {
  const f = await setup(t);
  const a = await approve(f), otherA = await approve(f);
  const eaB = await f.connect(); const b = await f.announce(eaB, { login: OTHER_LOGIN, enabled: true });
  const previewB = await approve(f, { ...f.input, accountId: b.id }, eaB, { login: OTHER_LOGIN });
  await dispatch(f, a.id);
  f.clock.advance(20_000);
  assert.equal((await f.engine.get(f.trader.key, a.id)).outcome, "unknown");
  assert.equal(f.engine.hasUnresolvedTerminal(f.ea.terminal), true);
  await assert.rejects(f.engine.execute(f.trader.key, otherA.id, true), { code: "account-unresolved" });
  await heartbeat(f.bridge, eaB);
  await dispatch(f, previewB.id, eaB, { login: OTHER_LOGIN });
  await f.changeSettings({ enabled: false, maxLots: "1", slippage: 20 });
  await assert.rejects(f.engine.review(f.readonly.key, a.id, "Inspected MT4 orders/history", true), { code: "not-authorized" });
  await assert.rejects(f.engine.review(f.trader.key, a.id, "short", true), { code: "invalid-review" });
  await assert.rejects(f.engine.review(f.trader.key, a.id, "Inspected MT4 orders/history", false), { code: "invalid-review" });
  const reviewed = await f.engine.review(f.trader.key, a.id, "Inspected MT4 orders/history", true);
  assert.equal(reviewed.outcome, "unknown"); assert.equal(f.engine.hasUnresolvedTerminal(f.ea.terminal), false);
  await deliver(f.bridge, f.ea, resultWire(f.ea, a.id));
  const late = await f.engine.get(f.trader.key, a.id);
  assert.equal(late.outcome, "succeeded"); assert.equal(late.events.filter((e) => e.type === "review").length, 1);
  const evidenceCount = late.events.length;
  await deliver(f.bridge, f.ea, resultWire(f.ea, a.id));
  assert.equal((await f.engine.get(f.readonly.key, a.id)).events.length, evidenceCount);
  assert.equal((await f.engine.execute(f.trader.key, a.id, true)).outcome, "succeeded");
});

test("same-account admission cannot race through fresh reads while independent accounts proceed", async (t) => {
  const f = await setup(t);
  const a = await approve(f), second = await approve(f);
  const eaB = await f.connect(); const b = await f.announce(eaB, { login: OTHER_LOGIN, enabled: true });
  const bp = await approve(f, { ...f.input, accountId: b.id }, eaB, { login: OTHER_LOGIN });
  const executingA = f.engine.execute(f.trader.key, a.id, true);
  const refused = assert.rejects(f.engine.execute(f.trader.key, second.id, true), { code: "account-unresolved" });
  const executingB = f.engine.execute(f.trader.key, bp.id, true);
  await Promise.all([f.answer(f.ea), f.answer(eaB, { login: OTHER_LOGIN })]);
  assert.match(await f.ea.receive(), /^X\|/); assert.match(await eaB.receive(), /^X\|/);
  await Promise.all([executingA, executingB, refused]);
  assert.equal(f.engine.unresolvedCount(), 2);
});

test("restart recovers a lost reply as unknown, retains original source, and never replays execute", async (t) => {
  const f = await setup(t), p = await approve(f);
  await dispatch(f, p.id); await f.restartEngine();
  const recovered = await f.engine.get(f.trader.key, p.id);
  assert.equal(recovered.outcome, "unknown"); assert.equal(f.engine.hasUnresolvedTerminal(f.ea.terminal), true);
  assert.deepEqual(await f.engine.execute(f.trader.key, p.id, true), recovered);
  const replacement = await f.connect({ terminal: f.ea.terminal });
  await f.announce(replacement, { login: OTHER_LOGIN, enabled: true });
  await deliver(f.bridge, replacement, resultWire(replacement, p.id, OTHER_LOGIN));
  assert.equal((await f.engine.get(f.trader.key, p.id)).outcome, "unknown");
  await deliver(f.bridge, f.ea, resultWire(f.ea, p.id));
  assert.equal((await f.engine.get(f.trader.key, p.id)).outcome, "succeeded");
});

test("a crash after durable admission but before any send recovers without creating an order", async (t) => {
  const f = await setup(t), p = await approve(f);
  await f.db.journal.admit(p, "api-key", f.clock.now());
  await f.restartEngine();
  assert.equal((await f.engine.execute(f.trader.key, p.id, true)).outcome, "unknown");
  await assert.rejects(f.ea.receive(), /temporarily unavailable|timed out|EAGAIN/i);
});

test("a journal write failure cannot dispatch anything or leave a phantom record", async (t) => {
  const f = await setup(t), p = await approve(f);
  let reads = 0;
  const off = f.bridge.onChange(() => { if (++reads === 2) f.db.journal.close(); });
  // Initial duplicate lookup succeeds; close the real DB connection only when fresh reads complete,
  // so durable ADMISSION (not lookup) fails before the outbound mutation.
  const pending = assert.rejects(f.engine.execute(f.trader.key, p.id, true), { code: "journal-unavailable" });
  await f.answer(f.ea); await pending; off();
  await assert.rejects(f.ea.receive(), /temporarily unavailable|timed out|EAGAIN/i);
});

test("stopping admissions preserves late result evidence until the transport is drained", async (t) => {
  const f = await setup(t), p = await approve(f);
  await dispatch(f, p.id);
  await f.engine.stopAdmissions();
  await assert.rejects(f.engine.preview(f.trader.key, f.input), { code: "trading-stopped" });
  await assert.rejects(f.engine.execute(f.trader.key, p.id, true), { code: "trading-stopped" });
  await deliver(f.bridge, f.ea, resultWire(f.ea, p.id));
  await f.bridge.close();
  await f.engine.close();
  assert.equal((await f.engine.get(f.trader.key, p.id)).outcome, "succeeded");
  await f.restartEngine();
  assert.equal((await f.engine.get(f.trader.key, p.id)).outcome, "succeeded");
});

test("stopping admissions waits for fresh-read executions without dispatching or detaching late results", async (t) => {
  const f = await setup(t), first = await approve(f);
  await dispatch(f, first.id);
  const eaB = await f.connect();
  const accountB = await f.announce(eaB, { login: OTHER_LOGIN, enabled: true });
  const second = await approve(f, { ...f.input, accountId: accountB.id }, eaB, { login: OTHER_LOGIN });
  const executing = assert.rejects(f.engine.execute(f.trader.key, second.id, true), { code: "trading-stopped" });
  // Wait until validation is actually receiving fresh data, not just queued at duplicate lookup.
  const reads = [await eaB.receive(), await eaB.receive()];
  let stopped = false;
  const stopping = f.engine.stopAdmissions().then(() => { stopped = true; });
  await deliver(f.bridge, f.ea, resultWire(f.ea, first.id));
  assert.equal(stopped, false, "accepted execute work must finish before admissions are drained");
  for (const wire of reads) {
    const fields = wire.split("|");
    await deliver(f.bridge, eaB, fields[0] === "V"
      ? pageWire(eaB, fields[3], { login: OTHER_LOGIN, capturedAt: Math.floor(f.clock.now() / 1000) })
      : conditionsWire(eaB, fields[3], fields[6], OTHER_LOGIN).replace("|0|1700000002|", `|1|${Math.floor(f.clock.now() / 1000)}|`));
  }
  await executing;
  await stopping;
  assert.equal((await f.engine.get(f.trader.key, first.id)).outcome, "succeeded");
  assert.equal((await f.engine.list(f.trader.key)).length, 1, "stopped fresh validation must never admit a second request");
  await assert.rejects(eaB.receive(), /temporarily unavailable|timed out|EAGAIN/i);
});

test("shutdown after durable admission is unknown and remains recoverable without a send", async (t) => {
  const f = await setup(t), p = await approve(f);
  let closing: Promise<void> | undefined;
  const off = f.engine.onChange(() => { if (f.engine.unresolvedCount()) closing ??= f.engine.close(); });
  const pending = f.engine.execute(f.trader.key, p.id, true); await f.answer(f.ea);
  assert.equal((await pending).outcome, "unknown"); await closing; off();
  await f.restartEngine();
  assert.equal((await f.engine.get(f.trader.key, p.id)).outcome, "unknown");
  await assert.rejects(f.ea.receive(), /temporarily unavailable|timed out|EAGAIN/i);
});

test("revoking the executing key during fresh reads fails closed, but another trader may execute a preview", async (t) => {
  const f = await setup(t), p = await approve(f);
  const other = await f.keys.create({ name: "Other trader", scope: "trader" });
  const pending = assert.rejects(f.engine.execute(f.trader.key, p.id, true), { code: "not-authorized" });
  await f.keys.revoke({ id: f.trader.apiKey.id }); await f.answer(f.ea); await pending;
  assert.deepEqual(await f.engine.list(other.key), []);
  // Failed fresh validation consumes that attempt; a new approval may be shared across authorized keys.
  const next = f.engine.preview(other.key, f.input); await f.answer(f.ea); const approved = await next;
  const third = await f.keys.create({ name: "Third trader", scope: "trader" });
  const executing = f.engine.execute(third.key, approved.id, true); await f.answer(f.ea);
  assert.match(await f.ea.receive(), /^X\|/); assert.equal((await executing).origin, "api-key");
});

test("trading-off/settings changes invalidate previews; expiry, stale quotes and disabled operations never journal", async (t) => {
  const f = await setup(t), p = await approve(f);
  f.changeSettings({ enabled: false, maxLots: "1", slippage: 20 });
  await assert.rejects(f.engine.execute(f.trader.key, p.id, true), { code: "preview-unavailable" });
  await assert.rejects(f.engine.preview(f.trader.key, f.input), { code: "trading-disabled" });
  assert.deepEqual(await f.engine.list(f.readonly.key), []);
  f.changeSettings({ enabled: true, maxLots: "1", slippage: 20 });
  const expired = await approve(f); f.clock.advance(30_000); await heartbeat(f.bridge, f.ea);
  // Exercise cleanup through a public read, rather than racing the 250-ms maintenance timer.
  assert.deepEqual(await f.engine.list(f.readonly.key), []);
  await assert.rejects(f.engine.execute(f.trader.key, expired.id, true), { code: "preview-unavailable" });
  const stale = assert.rejects(f.engine.preview(f.trader.key, f.input), { code: "stale-quote" });
  await f.answer(f.ea, {}, (wire) => wire.replace(`|${Math.floor(f.clock.now() / 1000)}|`, `|${Math.floor(f.clock.now() / 1000) - 31}|`));
  await stale; assert.deepEqual(await f.engine.list(f.trader.key), []);
});

test("zero, multiple, unready and real-account executors block mutation previews", async (t) => {
  const f = await setup(t);
  await f.announce(f.ea, { enabled: false });
  await assert.rejects(f.engine.preview(f.trader.key, f.input), { code: "executor-zero" });
  await f.announce(f.ea, { enabled: true, ready: false });
  await assert.rejects(f.engine.preview(f.trader.key, f.input), { code: "executor-not-ready" });
  await f.announce(f.ea, { enabled: true, demo: false });
  await assert.rejects(f.engine.preview(f.trader.key, f.input), { code: "executor-real-account" });
  await f.announce(f.ea, { enabled: true });
  const second = await f.connect(); await f.announce(second, { enabled: true });
  await assert.rejects(f.engine.preview(f.trader.key, f.input), { code: "executor-multiple" });
  await assert.rejects(f.engine.preview(f.readonly.key, f.input), { code: "not-authorized" });
});

test("executor and EA cap changes invalidate an unused preview even when later restored", async (t) => {
  const f = await setup(t), p = await approve(f);
  await f.announce(f.ea, { enabled: false }); await f.announce(f.ea, { enabled: true });
  await assert.rejects(f.engine.execute(f.trader.key, p.id, true), { code: "preview-unavailable" });
  const cap = await approve(f);
  await f.announce(f.ea, { enabled: true, maxLots: "0.4" }); await f.announce(f.ea, { enabled: true });
  await assert.rejects(f.engine.execute(f.trader.key, cap.id, true), { code: "preview-unavailable" });
});

test("existing-target preview starts with a fresh account read and rejects a changed fingerprint at execute", async (t) => {
  const f = await setup(t);
  const page = { total: 1, rows: [orderRow(42)] };
  const input: TradeInput = { action: "close", accountId: f.account.id, ticket: "42" };
  const p = await approve(f, input, f.ea, page);
  assert.ok(p.warnings.some((warning) => warning.includes("outside QuoteBridge")));
  const pending = assert.rejects(f.engine.execute(f.trader.key, p.id, true), { code: "target-changed" });
  await f.answer(f.ea, { ...page, rows: [orderRow(42).replace("0.1000000000", "2.0000000000")] });
  await pending; assert.deepEqual(await f.engine.list(f.trader.key), []);
});

test("broker preflight rejection is definitive; ambiguous and conflicting late results retain evidence", async (t) => {
  const f = await setup(t), p = await approve(f); await dispatch(f, p.id);
  const response = `X|1|${f.ea.session}|${p.id}|${LOGIN}|rejected|0|134|Insufficient free margin`;
  await deliver(f.bridge, f.ea, response);
  const failed = await f.engine.get(f.trader.key, p.id);
  assert.equal(failed.outcome, "failed"); assert.equal(failed.result?.code, 134); assert.equal(f.engine.hasUnresolvedTerminal(f.ea.terminal), false);
  await deliver(f.bridge, f.ea, `X|1|${f.ea.session}|${p.id}|${LOGIN}|unknown|0|128|Broker timeout`);
  assert.equal((await f.engine.get(f.trader.key, p.id)).outcome, "failed");
  assert.equal((await f.engine.get(f.trader.key, p.id)).events.length, 2);
});

test("fresh read timeout never falls back to the previously published account snapshot", async (t) => {
  const f = await setup(t); await approve(f);
  const pending = assert.rejects(f.engine.preview(f.trader.key, f.input), { code: "read-timeout" });
  assert.match(await f.ea.receive(), /^V\|/); assert.match(await f.ea.receive(), /^P\|/);
  f.clock.advance(5000); f.bridge.accounts.list(); await pending;
  assert.deepEqual(await f.engine.list(f.trader.key), []);
});

test("existing-target account and contract reads share one five-second deadline", async (t) => {
  const f = await setup(t);
  const pending = assert.rejects(f.engine.preview(f.trader.key, { action: "close", accountId: f.account.id, ticket: "42" }), { code: "read-timeout" });
  const accountRead = (await f.ea.receive()).split("|"); assert.equal(accountRead[0], "V");
  f.clock.advance(4000);
  await deliver(f.bridge, f.ea, pageWire(f.ea, accountRead[3], { total: 1, rows: [orderRow(42)] }));
  const contractRead = (await f.ea.receive()).split("|"); assert.equal(contractRead[0], "P");
  await heartbeat(f.bridge, f.ea);
  f.clock.advance(1001);
  const wire = conditionsWire(f.ea, contractRead[3]).replace("|0|1700000002|", `|1|${Math.floor(f.clock.now() / 1000)}|`);
  await deliver(f.bridge, f.ea, wire); await pending;
  assert.deepEqual(await f.engine.list(f.trader.key), []);
});

test("a failed actual ZeroMQ send becomes unknown and duplicate execution still cannot retry", async (t) => {
  const f = await setup(t), p = await approve(f);
  let stopped: Promise<void> | undefined;
  const off = f.engine.onChange(() => { if (f.engine.unresolvedCount()) stopped ??= f.bridge.close(); });
  const pending = f.engine.execute(f.trader.key, p.id, true); await f.answer(f.ea);
  assert.equal((await pending).outcome, "unknown"); await stopped; off();
  assert.equal((await f.engine.execute(f.trader.key, p.id, true)).outcome, "unknown");
  assert.equal(f.engine.hasUnresolvedTerminal(f.ea.terminal), true);
});

test("simultaneous execute joins one dispatch, persisted before the EA sees it, and duplicate never resends", async (t) => {
  const f = await setup(t);
  const pending = f.engine.preview(f.trader.key, f.input); await f.answer(f.ea);
  const preview = await pending;
  preview.intent.lots = "99";
  const first = f.engine.execute(f.trader.key, preview.id, true);
  const duplicate = f.engine.execute(f.trader.key, preview.id, true);
  await f.answer(f.ea);
  const wire = (await f.ea.receive()).split("|");
  assert.equal(wire.length, 24);
  assert.deepEqual(wire.slice(0, 11), ["X", "1", f.ea.session, preview.id, LOGIN, f.ea.broker, "N", "0", "EURUSD", "0", "0.1"]);
  assert.equal((await f.db.journal.get(preview.id))?.outcome, "dispatching");
  const [one, two] = await Promise.all([first, duplicate]);
  assert.deepEqual(one, two);
  await deliver(f.bridge, f.ea, resultWire(f.ea, preview.id));
  assert.equal((await f.engine.get(f.trader.key, preview.id)).outcome, "succeeded");
  assert.equal((await f.engine.execute(f.trader.key, preview.id, true)).outcome, "succeeded");
  await assert.rejects(f.engine.execute(f.readonly.key, preview.id, true), { code: "not-authorized" });
  await f.keys.revoke({ id: f.trader.apiKey.id });
  await assert.rejects(f.engine.execute(f.trader.key, preview.id, true), { code: "not-authorized" });
});
