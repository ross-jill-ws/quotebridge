// REST v1 trading requests over HTTP (approved seam): preview, execute, status and review through the shared request
// engine, with readonly/trader scopes, explicit accounts and markets, account-qualified tickets, 202 dispatch and
// idempotent duplicates. Real server and database, fake EAs over real ZeroMQ, fake clock. No real orders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { accountId, marketId } from "../src/server/identity/index.js";
import { LOGIN, OTHER_LOGIN, orderRow, resultWire } from "./account-fixtures.js";
import type { FakeEA } from "./fake-ea.js";
import { DEMO, OTHER_TERMINAL, REAL, startRest, tempFolder, type Json, type RestApp } from "./rest-fixtures.js";

const ACCOUNT = accountId(DEMO, LOGIN);
const EURUSD = marketId(DEMO, "EURUSD");
const PLACE = { accountId: ACCOUNT, action: "place", marketId: EURUSD, side: "buy", type: "market", lots: "0.10" };

async function trading(t: Parameters<typeof startRest>[0]) {
  const app = await startRest(t, await tempFolder(t, "rest-db"), { trading: true });
  const ea = await app.connect();
  await app.announce(ea, { enabled: true });
  return { app, ea };
}

/** The next order command the EA receives (chart-history bar requests aside). */
async function command(ea: FakeEA) {
  let wire = await ea.receive();
  while (wire.startsWith("G|")) wire = await ea.receive();
  assert.match(wire, /^X\|/);
  return wire;
}

/** POSTs as `send` does, answering the engine's fresh account and contract reads from `ea`. */
async function withReads(app: RestApp, ea: FakeEA, path: string, body: unknown, status: number, key = app.traderKey, page = {}) {
  const pending = app.send(path, body, status, key);
  await app.answer(ea, 2, page);
  return pending;
}

/** Asserts the EA receives nothing more but chart-history bar requests. */
async function noCommand(ea: FakeEA) {
  for (;;) {
    let wire: string;
    try {
      wire = await ea.receive();
    } catch (e) {
      assert.match(String(e), /No message|timed out|EAGAIN|temporarily unavailable/i);
      return;
    }
    assert.ok(wire.startsWith("G|"), `unexpected ${wire.split("|")[0]} message`);
  }
}

test("a place preview is normalized and single-use; execute answers 202, a duplicate the same record, and only one order is sent", { timeout: 30000 }, async (t) => {
  const { app, ea } = await trading(t);
  const preview = await withReads(app, ea, "/api/v1/requests/preview", PLACE, 201);
  const p = preview.data;
  assert.match(p.requestId, /^[0-9a-f]{32}$/);
  assert.equal(p.status, "preview");
  assert.equal(Date.parse(p.expiresAt) - Date.parse(p.createdAt), 30_000);
  assert.deepEqual([p.accountId, p.marketId, p.terminalId], [ACCOUNT, EURUSD, "mt4-aaaaaaaaaaaa"]);
  assert.deepEqual(p.normalizedIntent, { action: "place", ticket: null, symbol: "EURUSD", side: "buy", type: "market", lots: "0.1", price: p.normalizedIntent.price, stopLoss: null, takeProfit: null, expiry: null, slippage: 20 });
  assert.match(p.normalizedIntent.price, /^\d+(\.\d+)?$/);
  assert.deepEqual(p.limits, { broker: "100", ea: "0.5", app: "1", maxLots: "0.5" });
  assert.ok(p.warnings.length, "no stops: the preview warns");
  // Readable while valid, by any authorized reader.
  assert.deepEqual((await app.read(`/api/v1/requests/${p.requestId}`)).data, p);

  // Another trader key may execute it: previews have no owner.
  const executing = app.send(`/api/v1/requests/${p.requestId}/execute`, { confirm: true }, 202, app.otherTraderKey);
  await app.answer(ea, 2);
  const wire = await command(ea);
  assert.ok(wire.startsWith(`X|1|${ea.session}|${p.requestId}|${LOGIN}|${DEMO}|N|0|EURUSD|`), "a buy at market for the previewed account");
  const accepted = (await executing).data;
  assert.deepEqual([accepted.requestId, accepted.status, accepted.reviewed, accepted.origin], [p.requestId, "dispatching", false, "api-key"]);
  const again = await app.send(`/api/v1/requests/${p.requestId}/execute`, { confirm: true }, 200);
  assert.deepEqual(again.data, accepted, "a duplicate returns the existing record");
  await noCommand(ea);

  await ea.send(resultWire(ea, p.requestId));
  let done: Json = {};
  for (let i = 0; i < 100 && done.status !== "succeeded"; i++) {
    done = (await app.read(`/api/v1/requests/${p.requestId}`)).data;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual([done.status, done.result], ["succeeded", { status: "succeeded", ticket: "101", code: 0, message: "MT4 confirmed operation" }]);
  assert.deepEqual(done.events.map((e: Json) => e.type), ["result"]);
});

test("simultaneous executes of one preview send one order: one answers 202, the other the same record with 200", { timeout: 30000 }, async (t) => {
  const { app, ea } = await trading(t);
  const p = (await withReads(app, ea, "/api/v1/requests/preview", PLACE, 201)).data;
  const execute = async (key: string) => {
    const res = await app.cli(`/api/v1/requests/${p.requestId}/execute`, {}, { key, method: "POST", body: JSON.stringify({ confirm: true }) });
    return { status: res.status, body: (await res.json()) as Json };
  };
  const both = Promise.all([execute(app.traderKey), execute(app.otherTraderKey)]);
  await app.answer(ea, 2);
  await command(ea);
  const answers = await both;
  assert.deepEqual(answers.map((a) => a.status).sort(), [200, 202]);
  assert.deepEqual(answers[0].body.data, answers[1].body.data);
  await noCommand(ea);
});

test("readonly may read requests but cannot preview, execute or review; the app window previews through the same engine", { timeout: 30000 }, async (t) => {
  const { app, ea } = await trading(t);
  for (const path of ["/api/v1/requests/preview", `/api/v1/requests/${"a".repeat(32)}/execute`, `/api/v1/requests/${"a".repeat(32)}/review`]) {
    const refused = await app.send(path, {}, 403, app.readonlyKey);
    assert.equal(refused.error.code, "insufficient-scope", path);
  }
  assert.deepEqual((await app.read("/api/v1/requests")).data, []);

  // The window's session previews; a trader key executes: one shared request engine.
  const previewing = fetch(`${app.origin}/api/v1/requests/preview`, { method: "POST", headers: { cookie: app.cookie, origin: app.origin, "content-type": "application/json" }, body: JSON.stringify(PLACE) });
  await app.answer(ea, 2);
  const preview = (await (await previewing).json()) as Json;
  const executing = app.send(`/api/v1/requests/${preview.data.requestId}/execute`, { confirm: true }, 202);
  await app.answer(ea, 2);
  await command(ea);
  assert.equal((await executing).data.status, "dispatching");
  assert.deepEqual((await app.read("/api/v1/requests", { accountId: ACCOUNT })).data.map((r: Json) => r.requestId), [preview.data.requestId]);
});

test("previews need an exact known account and a market on its broker server; the body is checked strictly", { timeout: 30000 }, async (t) => {
  const { app, ea } = await trading(t);
  await app.connect({ terminal: OTHER_TERMINAL, broker: REAL });
  const refuse = async (body: unknown, status: number, code: string) => assert.equal((await app.send("/api/v1/requests/preview", body, status)).error.code, code, JSON.stringify(body));
  await refuse({ ...PLACE, marketId: marketId(REAL, "EURUSD") }, 409, "cross-broker-market");
  await refuse({ ...PLACE, accountId: accountId(DEMO, OTHER_LOGIN) }, 404, "unknown-account");
  await refuse({ ...PLACE, marketId: marketId(DEMO, "USDJPY") }, 404, "unknown-market");
  await refuse({ ...PLACE, marketId: undefined, symbol: "EURUSD" }, 400, "invalid-input");
  await refuse({ ...PLACE, symbol: "EURUSD" }, 400, "unknown-property");
  await refuse({ ...PLACE, action: "new" }, 400, "invalid-action");
  await refuse({ ...PLACE, type: 0 }, 422, "invalid-type");
  await refuse({ ...PLACE, lots: 0.1 }, 422, "invalid-decimal");
  await refuse({ ...PLACE, lots: "1e-1" }, 422, "invalid-decimal");
  await refuse({ accountId: ACCOUNT, action: "close", ticket: "0012" }, 400, "invalid-ticket");
  const res = await app.cli("/api/v1/requests/preview", {}, { key: app.traderKey, method: "POST", body: "{" });
  assert.deepEqual([res.status, ((await res.json()) as Json).error.code], [400, "invalid-json"]);
  await noCommand(ea);

  const preview = (await withReads(app, ea, "/api/v1/requests/preview", PLACE, 201)).data;
  for (const body of [{}, { confirm: "true" }, { confirm: true, extra: 1 }]) {
    assert.equal((await app.send(`/api/v1/requests/${preview.requestId}/execute`, body, 400)).error.code, "confirmation-required", JSON.stringify(body));
  }
  assert.equal((await app.send(`/api/v1/requests/${"b".repeat(32)}/execute`, { confirm: true }, 409)).error.code, "preview-unavailable");
  assert.equal((await app.read(`/api/v1/requests/${"b".repeat(32)}`, {}, 404)).error.code, "request-not-found");
  assert.equal((await app.read("/api/v1/requests/not-an-id", {}, 400)).error.code, "invalid-request-id");
  // Thirty seconds on, the preview has expired.
  app.clock.advance(30_000);
  assert.equal((await app.read(`/api/v1/requests/${preview.requestId}`, {}, 404)).error.code, "request-not-found");
});

test("close targets the account-qualified ticket on that account's own terminal, even when another account has the same ticket", { timeout: 30000 }, async (t) => {
  const { app, ea } = await trading(t);
  const other = await app.connect({ terminal: OTHER_TERMINAL });
  const second = await app.announce(other, { login: OTHER_LOGIN, enabled: true });
  const rows = { rows: [orderRow(7, 0)], total: 1 };
  // The ticket's market is found in a fresh account read first, then its contract is read.
  const pending = app.send("/api/v1/requests/preview", { accountId: second, action: "close", ticket: "7" }, 201);
  await app.answer(other, 1, { ...rows, login: OTHER_LOGIN });
  await app.answer(other, 1, { ...rows, login: OTHER_LOGIN });
  const preview = (await pending).data;
  assert.deepEqual([preview.accountId, preview.terminalId, preview.normalizedIntent.action, preview.normalizedIntent.ticket], [second, OTHER_TERMINAL, "close", "7"]);
  assert.deepEqual([preview.target.ticket, preview.target.side, preview.target.lots], ["7", "buy", "0.1"]);
  await noCommand(ea);
});

test("an unknown outcome blocks only its account until reviewed with a note and acknowledgement; review is recorded beside it", { timeout: 40000 }, async (t) => {
  const { app, ea } = await trading(t);
  const preview = (await withReads(app, ea, "/api/v1/requests/preview", PLACE, 201)).data;
  const second = (await withReads(app, ea, "/api/v1/requests/preview", PLACE, 201)).data;
  const executing = app.send(`/api/v1/requests/${preview.requestId}/execute`, { confirm: true }, 202);
  await app.answer(ea, 2);
  await command(ea);
  await executing;
  app.clock.advance(20_000);
  const unknown = (await app.read(`/api/v1/requests/${preview.requestId}`)).data;
  assert.deepEqual([unknown.status, unknown.reviewed, unknown.events.map((e: Json) => [e.type, e.reason])], ["unknown", false, [["unknown", "result-timeout"]]]);
  assert.equal((await app.send(`/api/v1/requests/${second.requestId}/execute`, { confirm: true }, 409)).error.code, "account-unresolved");

  const review = (body: unknown, status: number, key = app.traderKey) => app.send(`/api/v1/requests/${preview.requestId}/review`, body, status, key);
  assert.equal((await review({ note: "short", acknowledged: true }, 422)).error.code, "invalid-review");
  assert.equal((await review({ note: "Checked MT4 orders and history", acknowledged: false }, 422)).error.code, "invalid-review");
  assert.equal((await review({ note: "Checked MT4 orders and history" }, 422)).error.code, "invalid-review");
  const reviewed = (await review({ note: "  Checked MT4 orders and history  ", acknowledged: true }, 200)).data;
  assert.deepEqual([reviewed.status, reviewed.reviewed], ["unknown", true], "review does not invent an outcome");
  const event = reviewed.events.at(-1);
  assert.deepEqual([event.type, event.note, typeof event.at], ["review", "Checked MT4 orders and history", "string"]);
});

test("requests list the journal oldest first by cursor, filtered by exact account", { timeout: 40000 }, async (t) => {
  const { app, ea } = await trading(t);
  const ids: string[] = [];
  for (let n = 0; n < 3; n++) {
    const preview = (await withReads(app, ea, "/api/v1/requests/preview", PLACE, 201)).data;
    const executing = app.send(`/api/v1/requests/${preview.requestId}/execute`, { confirm: true }, 202);
    await app.answer(ea, 2);
    await command(ea);
    await executing;
    await ea.send(resultWire(ea, preview.requestId));
    for (let i = 0; i < 100 && (await app.read(`/api/v1/requests/${preview.requestId}`)).data.status === "dispatching"; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    ids.push(preview.requestId);
    app.clock.advance(1000);
  }
  const first = await app.read("/api/v1/requests", { limit: 2 });
  assert.deepEqual(first.data.map((r: Json) => r.requestId), ids.slice(0, 2));
  const rest = await app.read("/api/v1/requests", { limit: 2, cursor: first.meta.nextCursor });
  assert.deepEqual([rest.data.map((r: Json) => r.requestId), rest.meta.nextCursor], [ids.slice(2), null]);
  assert.deepEqual((await app.read("/api/v1/requests", { accountId: accountId(DEMO, OTHER_LOGIN) })).data, []);
  assert.equal((await app.read("/api/v1/requests", { limit: 501 }, 400)).error.code, "invalid-parameter");
});
