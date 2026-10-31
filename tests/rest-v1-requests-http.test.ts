// REST v1 trading requests over HTTP (approved seam): preview, execute, status and review through the shared request
// engine, with readonly/trader scopes, explicit accounts and markets, account-qualified tickets, 202 dispatch and
// idempotent duplicates. Real server and database, fake EAs over real ZeroMQ, fake clock. No real orders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { accountId, marketId } from "../src/server/identity/index.js";
import { actionBlock, newOrderForm, requestBody, unresolvedByAccount, type AccountView, type OrderForm, type RequestView } from "../src/dashboard/trading/trading-model.js";
import { deliver, LOGIN, OTHER_LOGIN, orderRow, resultWire } from "./account-fixtures.js";
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

/** POSTs as a browser session (`cookie`, the app window's by default) does, asserting the status. */
async function browserSend(app: RestApp, path: string, body: unknown, status: number, cookie = app.cookie) {
  const res = await fetch(`${app.origin}${path}`, { method: "POST", headers: { cookie, origin: app.origin, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(res.status, status, `${path}: ${await res.clone().text()}`);
  return (await res.json()) as Json;
}

/** A heartbeat from the chart, as after the clock moved on: its terminal is connected again. */
async function alive(app: RestApp, ea: FakeEA) {
  await deliver(app.server.bridge, ea, ea.helloWire());
  for (let wire = await ea.receive(); !wire.startsWith("C|"); wire = await ea.receive());
}

/** Waits until the request's status is no longer dispatching. */
async function settled(app: RestApp, id: string) {
  for (let i = 0; i < 100 && (await app.read(`/api/v1/requests/${id}`)).data.status === "dispatching"; i++) await new Promise((resolve) => setTimeout(resolve, 20));
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
  assert.equal((await app.send("/api/v1/requests/preview", PLACE, 409)).error.code, "account-unresolved", "nor may a new preview be made");

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
    await settled(app, preview.requestId);
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

test("a real account trades over REST once Real-account trading is on and its chart has EnableRealTrading", { timeout: 30000 }, async (t) => {
  const app = await startRest(t, await tempFolder(t, "rest-db"), { trading: true });
  const ea = await app.connect();
  await app.announce(ea, { demo: false, realEnabled: true });
  const real = { demo: false };
  assert.equal((await app.send("/api/v1/requests/preview", PLACE, 403)).error.code, "real-trading-disabled");
  await noCommand(ea);
  // Only the app window switches it on (settings-http covers remote browsers and API keys); Demo trading may stay off.
  await browserSend(app, "/api/settings", { trading: { enabled: false, maxLots: "1.0", slippage: 20, realAccounts: true } }, 200);
  const account = (await app.read(`/api/v1/accounts/${ACCOUNT}`)).data;
  assert.deepEqual([account.demo, account.executor.state], [false, "ready"]);
  const p = (await withReads(app, ea, "/api/v1/requests/preview", PLACE, 201, app.traderKey, real)).data;
  const executing = app.send(`/api/v1/requests/${p.requestId}/execute`, { confirm: true }, 202);
  await app.answer(ea, 2, real);
  assert.match(await command(ea), new RegExp(`^X\\|1\\|${ea.session}\\|${p.requestId}\\|`));
  await executing;
});

test("a real account reads over REST, but its place and close previews answer 409 executor-real-account and the EA receives no order", { timeout: 30000 }, async (t) => {
  const app = await startRest(t, await tempFolder(t, "rest-db"), { trading: true });
  await app.post("/api/settings", { trading: { enabled: true, maxLots: "1.0", slippage: 20, realAccounts: true } });
  const ea = await app.connect();
  // EnableDemoTrading on a real account's chart: still no trading chart.
  await app.announce(ea, { demo: false, enabled: true, realEnabled: false });
  const page = { demo: false, rows: [orderRow(7, 0), orderRow(8, 2)], total: 2 };
  const read = async (path: string) => {
    const pending = app.read(path);
    await app.answer(ea, 1, page);
    return (await pending).data;
  };
  const account = (await app.read(`/api/v1/accounts/${ACCOUNT}`)).data;
  assert.deepEqual([account.demo, account.executor.state], [false, "real-account"]);
  const funds = await read(`/api/v1/accounts/${ACCOUNT}/funds`);
  assert.deepEqual([funds.balance, funds.state], ["1000", "fresh"]);
  assert.deepEqual((await read(`/api/v1/accounts/${ACCOUNT}/positions`)).map((p: Json) => p.ticket), ["7"]);
  assert.deepEqual((await read(`/api/v1/accounts/${ACCOUNT}/orders`)).map((o: Json) => o.ticket), ["8"]);

  for (const body of [PLACE, { accountId: ACCOUNT, action: "close", ticket: "7" }]) {
    assert.equal((await app.send("/api/v1/requests/preview", body, 409)).error.code, "executor-real-account", body.action);
  }
  // No account read, conditions read or order: nothing at all reaches the EA.
  await noCommand(ea);
});

test("a key revoked mid-flow is refused at once: its execute answers 401 and sends nothing, another trader key may still execute; a revoked key's duplicate gets no record", { timeout: 40000 }, async (t) => {
  const { app, ea } = await trading(t);
  const revoke = async (name: string) => {
    const { keys } = await app.windowGet("/api/api-keys");
    await app.post("/api/api-keys/revoke", { id: (keys as Json[]).find((k) => k.name === name)!.id });
  };
  const p = (await withReads(app, ea, "/api/v1/requests/preview", PLACE, 201)).data;
  const execute = `/api/v1/requests/${p.requestId}/execute`;
  await revoke("Trader");
  assert.equal((await app.send(execute, { confirm: true }, 401, app.traderKey)).error.code, "unauthenticated");
  await noCommand(ea);

  // The preview is still valid: another trader key executes it.
  const executing = app.send(execute, { confirm: true }, 202, app.otherTraderKey);
  await app.answer(ea, 2);
  await command(ea);
  assert.equal((await executing).data.requestId, p.requestId);
  await revoke("Other trader");
  const duplicate = await app.send(execute, { confirm: true }, 401, app.otherTraderKey);
  assert.deepEqual([Object.keys(duplicate), duplicate.error.code], [["error"], "unauthenticated"], "not the record");
  assert.equal((await app.read(`/api/v1/requests/${p.requestId}`, {}, 401, app.otherTraderKey)).error.code, "unauthenticated");
  await noCommand(ea);
});

test("after a restart a journal-linked account is offline with null Funds; its request is unknown, and executing it again answers the record without a send", { timeout: 40000 }, async (t) => {
  const db = await tempFolder(t, "rest-db");
  const app = await startRest(t, db, { trading: true });
  const ea = await app.connect();
  await app.announce(ea, { enabled: true });
  const p = (await withReads(app, ea, "/api/v1/requests/preview", PLACE, 201)).data;
  const execute = `/api/v1/requests/${p.requestId}/execute`;
  const executing = app.send(execute, { confirm: true }, 202);
  await app.answer(ea, 2);
  await command(ea);
  await executing;
  // The app stops before MetaTrader's answer arrives.
  await app.stop();

  const again = await startRest(t, db, { clock: app.clock, trading: true });
  const [account] = (await again.read("/api/v1/accounts")).data;
  assert.deepEqual([account.id, account.connected, account.state, account.currency, account.executor.state], [ACCOUNT, false, "unavailable", null, "zero"]);
  const funds = (await again.read(`/api/v1/accounts/${ACCOUNT}/funds`)).data;
  for (const field of ["balance", "equity", "margin", "freeMargin", "marginLevel", "profit", "leverage"]) assert.equal(funds[field], null, `${field} is unknown, never zero`);
  const listed = (await again.read("/api/v1/requests", { accountId: ACCOUNT })).data;
  assert.deepEqual(listed.map((r: Json) => [r.requestId, r.status, r.reviewed, r.origin]), [[p.requestId, "unknown", false, "api-key"]]);
  assert.deepEqual(listed[0].events.map((e: Json) => [e.type, e.reason]), [["unknown", "restart"]]);

  // Its chart connects again, ready to trade: executing the same ID answers the record and sends nothing.
  const back = await again.connect();
  await again.announce(back, { enabled: true });
  const duplicate = await again.send(execute, { confirm: true }, 200);
  assert.deepEqual(duplicate.data, listed[0]);
  await noCommand(back);
});

test("a remote browser may preview, execute and review, recorded as remote-browser; its settings and key changes stay 403", { timeout: 40000 }, async (t) => {
  const { app, ea } = await trading(t);
  const token = "remote-token-0123456789";
  app.server.addRemoteToken(token);
  const signIn = await fetch(`${app.origin}/session?token=${token}`, { redirect: "manual" });
  const remote = signIn.headers.get("set-cookie")!.split(";")[0];

  const previewing = browserSend(app, "/api/v1/requests/preview", PLACE, 201, remote);
  await app.answer(ea, 2);
  const p = (await previewing).data;
  const executing = browserSend(app, `/api/v1/requests/${p.requestId}/execute`, { confirm: true }, 202, remote);
  await app.answer(ea, 2);
  await command(ea);
  assert.deepEqual([(await executing).data.status, (await executing).data.origin], ["dispatching", "remote-browser"]);
  app.clock.advance(20_000);
  const unknown = (await (await fetch(`${app.origin}/api/v1/requests/${p.requestId}`, { headers: { cookie: remote } })).json()) as Json;
  assert.equal(unknown.data.status, "unknown");
  const reviewed = (await browserSend(app, `/api/v1/requests/${p.requestId}/review`, { note: "Checked MT4 orders and history", acknowledged: true }, 200, remote)).data;
  assert.deepEqual([reviewed.status, reviewed.reviewed], ["unknown", true]);
  assert.equal((await app.read(`/api/v1/requests/${p.requestId}`)).data.origin, "remote-browser", "the journal records who executed it");

  // In the same session: no settings and no keys.
  await browserSend(app, "/api/settings", { trading: { enabled: false, maxLots: "1.0", slippage: 20 } }, 403, remote);
  await browserSend(app, "/api/api-keys", { name: "Remote trader", scope: "trader" }, 403, remote);
  assert.equal((await app.windowGet("/api/settings")).trading.enabled, true);
  assert.deepEqual(((await app.windowGet("/api/api-keys")).keys as Json[]).map((k) => k.name), ["Reader", "Trader", "Other trader"]);
});

test("the CLI's key and the dashboard's window session see one journal: an unknown request blocks only its account until the window reviews it", { timeout: 60000 }, async (t) => {
  const { app, ea } = await trading(t);
  const other = await app.connect({ terminal: OTHER_TERMINAL });
  const B = await app.announce(other, { login: OTHER_LOGIN, enabled: true });
  const placeOn = (id: string) => ({ ...PLACE, accountId: id });
  const page = (id: string) => (id === B ? { login: OTHER_LOGIN } : {});
  const eaOf = (id: string) => (id === B ? other : ea);
  /** POSTs with the window session, answering the engine's reads of the account's chart. */
  const windowWithReads = async (id: string, path: string, body: unknown, status: number) => {
    const pending = browserSend(app, path, body, status);
    await app.answer(eaOf(id), 2, page(id));
    return pending;
  };
  /** What the Trading page shows: the accounts, settings and requests it reads with the window session. */
  const dashboard = async () => {
    const accounts = (await app.windowGet("/api/v1/accounts")).data as AccountView[];
    const settings = (await app.windowGet("/api/settings")).trading;
    const unresolved = unresolvedByAccount((await app.windowGet("/api/v1/requests")).data as RequestView[]);
    const block = (id: string) => actionBlock(accounts.find((a) => a.id === id)!, settings, unresolved);
    return { unresolved, block };
  };

  // A trader key's preview, executed through the window: the window is its origin.
  const first = (await withReads(app, other, "/api/v1/requests/preview", placeOn(B), 201, app.traderKey, page(B))).data;
  const viaWindow = browserSend(app, `/api/v1/requests/${first.requestId}/execute`, { confirm: true }, 202);
  await app.answer(other, 2, page(B));
  await command(other);
  assert.equal((await viaWindow).data.origin, "app-window");
  await other.send(resultWire(other, first.requestId, OTHER_LOGIN));
  await settled(app, first.requestId);

  // The CLI's trader key previews and executes on A; MetaTrader never answers.
  const p = (await withReads(app, ea, "/api/v1/requests/preview", PLACE, 201)).data;
  const executing = app.send(`/api/v1/requests/${p.requestId}/execute`, { confirm: true }, 202);
  await app.answer(ea, 2);
  await command(ea);
  assert.equal((await executing).data.origin, "api-key");
  app.clock.advance(20_000);
  await alive(app, ea);
  await alive(app, other);

  const before = await dashboard();
  assert.deepEqual([...before.unresolved.keys()], [ACCOUNT]);
  assert.deepEqual([before.block(ACCOUNT)?.kind, before.block(ACCOUNT)?.requestId], ["unresolved", p.requestId]);
  assert.equal(before.block(B), undefined, "another account is not blocked");

  // The window cannot even preview on A, as the dashboard shows it; on B it runs.
  assert.equal((await browserSend(app, "/api/v1/requests/preview", PLACE, 409)).error.code, "account-unresolved");
  await noCommand(ea);
  const onB = (await windowWithReads(B, "/api/v1/requests/preview", placeOn(B), 201)).data;
  const runningB = browserSend(app, `/api/v1/requests/${onB.requestId}/execute`, { confirm: true }, 202);
  await app.answer(other, 2, page(B));
  await command(other);
  assert.deepEqual([(await runningB).data.status, (await runningB).data.origin], ["dispatching", "app-window"]);
  await noCommand(ea);

  // The window reviews A as the review dialog posts it; the CLI reads it back.
  const note = " Checked MT4 orders and history ";
  await browserSend(app, `/api/v1/requests/${p.requestId}/review`, { note: note.trim(), acknowledged: true }, 200);
  const back = (await app.read(`/api/v1/requests/${p.requestId}`, {}, 200, app.traderKey)).data;
  assert.deepEqual([back.status, back.reviewed], ["unknown", true], "reviewed, the outcome still unknown");
  const after = await dashboard();
  assert.equal(after.block(ACCOUNT), undefined, "A may trade again");
  assert.deepEqual([...after.unresolved.keys()], [B], "only B's own request, still sending, is open");
});

test("the dashboard's request bodies are REST v1 previews: every order form the dialogs post previews with 201 and nothing is sent", { timeout: 60000 }, async (t) => {
  const { app, ea } = await trading(t);
  // A position with a stop loss and a buy limit at 1.095, as the dialogs open them.
  const rows = [orderRow(21, 0).replace(",0,0,0,-1.25", ",1.0900000000,0,0,-1.25"), orderRow(22, 2).replace(",1.1000000000,", ",1.0950000000,")];
  const place = (form: Partial<OrderForm>) => ({ ...newOrderForm("buy", EURUSD), accountId: ACCOUNT, lots: "0.10", ...form }) as OrderForm;
  const expiry = "2027-01-16T12:00";
  const forms: [string, OrderForm][] = [
    ["market", place({})],
    ["stop with expiry", place({ type: "stop", price: "1.10100", expiry })],
    ...(["amount", "balancePercent", "points"] as const).map((lossBy): [string, OrderForm] => [`risk by ${lossBy}`, place({ stops: "risk", lossBy, loss: { amount: "5", balancePercent: "1", points: "200" }[lossBy], rewardRatio: "2" })]),
    ["stop distances", place({ stops: "distance", stopLossPoints: "200", takeProfitPoints: "400" })],
    ["modify clearing the stop loss", { kind: "modify", accountId: ACCOUNT, ticket: "21", pending: false, original: { price: "1.1", stopLoss: "1.09", takeProfit: "", expiry: "" }, price: "1.1", stopLoss: "", takeProfit: "", expiry: "" }],
    ["pending modify with expiry", { kind: "modify", accountId: ACCOUNT, ticket: "22", pending: true, original: { price: "1.095", stopLoss: "", takeProfit: "", expiry: "" }, price: "1.095", stopLoss: "", takeProfit: "", expiry }],
    ["close", { kind: "close", accountId: ACCOUNT, ticket: "21" }],
    ["cancel", { kind: "cancel", accountId: ACCOUNT, ticket: "22" }],
  ];
  for (const [name, form] of forms) {
    const built = requestBody(form);
    assert.ok("body" in built, `${name}: ${"error" in built ? built.error : ""}`);
    if (name === "modify clearing the stop loss") assert.equal(built.body.stopLoss, null, "a cleared field is null");
    const pending = browserSend(app, "/api/v1/requests/preview", built.body, 201);
    await app.answer(ea, 2, { rows, total: rows.length });
    const preview = (await pending).data;
    assert.equal(preview.status, "preview", name);
    if ("lossBy" in form && form.stops === "risk") assert.ok(preview.normalizedIntent.stopLoss && preview.normalizedIntent.takeProfit, `${name}: the plan sets both stops`);
    if (name === "stop distances") assert.ok(preview.normalizedIntent.stopLoss && preview.normalizedIntent.takeProfit, "the distances become both stops");
  }
  await noCommand(ea);
  assert.deepEqual((await app.read("/api/v1/requests")).data, [], "previews only: nothing executed");
});
