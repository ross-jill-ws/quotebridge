import { test } from "node:test";
import assert from "node:assert/strict";
import type { FakeEA } from "./fake-ea.js";
import type { AccountBinding } from "../src/server/bridge/accounts.js";
import type { TradeResult } from "../src/server/bridge/account-protocol.js";
import {
  LOGIN, OTHER_LOGIN, UNUSED_REQUEST, bindingOf, conditionsWire, deliver, firstTwenty, heartbeat, orderRow,
  pageWire, publishSnapshot, readError, readRequest, resultWire, startAccounts, type Announcement, type Page,
} from "./account-fixtures.js";

test("result registration rejects a binding whose login does not belong to the announced account", async (t) => {
  const { bridge, connect, announce } = await startAccounts(t);
  const ea = await connect();
  const account = await announce(ea, { enabled: true });
  const binding = bindingOf(account.sources[0]);
  assert.throws(() => bridge.accounts.expectResult(UNUSED_REQUEST, { ...binding, login: OTHER_LOGIN }), readError("invalid-response", 409));
});

for (const scenario of [
  { name: "malformed decimal", response: (ea, request) => pageWire(ea, request, { balance: "NaN" }), code: "invalid-response", status: 409 },
  { name: "mismatched broker", response: (ea, request) => pageWire(ea, request, { broker: "Other-Broker" }), code: "invalid-response", status: 409 },
  { name: "mismatched currency", response: (ea, request) => pageWire(ea, request, { currency: "EUR" }), code: "invalid-response", status: 409 },
  { name: "mismatched account type", response: (ea, request) => pageWire(ea, request, { demo: false }), code: "invalid-response", status: 409 },
  { name: "mismatched login", response: (ea, request) => pageWire(ea, request, { login: OTHER_LOGIN }), code: "account-changed", status: 409 },
  { name: "wrong kind", response: (ea, request) => conditionsWire(ea, request), code: "invalid-response", status: 409 },
  { name: "routing/session mismatch", response: (ea, request) => pageWire(ea, request).replace(`|${ea.session}|`, "|other-route|"), code: "invalid-response", status: 409 },
  { name: "correlated read error", response: (ea, request) => `E|1|${ea.session}|${request}|${LOGIN}|Private EA failure`, code: "read-failed", status: 503 },
  { name: "account lost during read error", response: (ea, request) => `E|1|${ea.session}|${request}|0|Private EA failure`, code: "account-changed", status: 409 },
] satisfies { name: string; response: (ea: FakeEA, request: string) => string; code: string; status: number }[]) {
  test(`account read rejects ${scenario.name} without replacing a complete snapshot`, async (t) => {
    const { bridge, connect, announce } = await startAccounts(t);
    const ea = await connect();
    const account = await announce(ea);
    const before = await publishSnapshot(bridge, ea, account.id, { balance: "750.1234567890", total: 1, rows: [orderRow(99, 2)] });
    const reading = bridge.accounts.read(account.id);
    const rejected = assert.rejects(reading, readError(scenario.code, scenario.status));
    const request = await readRequest(ea, "V");
    await deliver(bridge, ea, scenario.response(ea, request));
    await rejected;
    assert.deepEqual(bridge.accounts.get(account.id), before);
    // A later valid page cannot resurrect the failed assembly.
    await deliver(bridge, ea, pageWire(ea, request, { balance: "9999" }));
    assert.deepEqual(bridge.accounts.get(account.id), before);
  });
}

for (const kind of ["V", "P"] as const) {
  test(`${kind} ignores unsolicited, wrong-request and other-session answers without consuming the bound read`, async (t) => {
    const { bridge, connect, announce } = await startAccounts(t);
    const ea = await connect({ terminal: "mt4-a" });
    const other = await connect({ terminal: "mt4-z" });
    const account = await announce(ea, { enabled: true });
    await announce(other);
    const response = kind === "V" ? pageWire : conditionsWire;
    await deliver(bridge, ea, response(ea, UNUSED_REQUEST));
    assert.equal(bridge.accounts.get(account.id)?.state, "unavailable");
    assert.equal(bridge.accounts.get(account.id)?.funds.balance, null);

    const reading = kind === "V" ? bridge.accounts.read(account.id)
      : bridge.accounts.conditions(account.id, { brokerServer: ea.broker, symbol: "EURUSD" });
    let settled = false;
    void reading.then(() => { settled = true; }, () => { settled = true; });
    const request = await readRequest(ea, kind);
    for (const [sender, wire] of [
      [other, response(other, request)],
      [ea, response(ea, UNUSED_REQUEST)],
      [ea, `E|1|${ea.session}|${UNUSED_REQUEST}|${LOGIN}|Unknown request`],
    ] as const) {
      await deliver(bridge, sender, wire);
      assert.equal(settled, false, "an unbound response must neither resolve nor cancel the original read");
      assert.equal(bridge.accounts.get(account.id)?.funds.balance, null);
    }
    await deliver(bridge, ea, response(ea, request));
    const result = await reading;
    assert.equal(result.source?.session, ea.session);
    if ("funds" in result) assert.equal(result.funds.balance, "1000.0000000000");
    else assert.equal(result.conditions.bid, "1.1000000000");
  });
}

const openingPage: Page = { total: 21, rows: firstTwenty() };
const closingPage: Page = { total: 21, offset: 20, rows: [orderRow(21)] };
for (const scenario of [
  { name: "repeated offset", pages: [openingPage, openingPage] },
  { name: "duplicate ticket within a page", pages: [{ total: 2, rows: [orderRow(1), orderRow(1, 2)] }] },
  { name: "duplicate ticket across pages", pages: [openingPage, { ...closingPage, rows: [orderRow(1, 2)] }] },
  { name: "inconsistent funds", pages: [openingPage, { ...closingPage, balance: "9999.0000000000" }] },
  { name: "inconsistent capture time", pages: [openingPage, { ...closingPage, capturedAt: 1700000002 }] },
  { name: "inconsistent readiness", pages: [openingPage, { ...closingPage, ready: false }] },
  { name: "inconsistent total", pages: [openingPage, { ...closingPage, total: 22, rows: [orderRow(21), orderRow(22)] }] },
  { name: "off-grid overlapping offset", pages: [openingPage, { total: 21, offset: 1, rows: firstTwenty() }] },
] satisfies { name: string; pages: Page[] }[]) {
  test(`snapshot assembly rejects ${scenario.name} atomically and cannot be resumed`, async (t) => {
    const { bridge, connect, announce } = await startAccounts(t);
    const ea = await connect();
    const account = await announce(ea);
    const before = await publishSnapshot(bridge, ea, account.id, { balance: "750.1234567890", total: 1, rows: [orderRow(99, 2)] });
    const reading = bridge.accounts.read(account.id);
    const rejected = assert.rejects(reading, readError("invalid-response", 409));
    const request = await readRequest(ea, "V");
    for (const page of scenario.pages) {
      await deliver(bridge, ea, pageWire(ea, request, page));
      assert.deepEqual(bridge.accounts.get(account.id), before, "not even funds may leak from a partial or rejected snapshot");
    }
    await rejected;
    await deliver(bridge, ea, pageWire(ea, request, closingPage));
    assert.deepEqual(bridge.accounts.get(account.id), before);
    const recovered = await publishSnapshot(bridge, ea, account.id, { total: 1, rows: [orderRow(50, 5)] });
    assert.equal(recovered.positions.length, 0);
    assert.deepEqual(recovered.orders.map((o) => o.ticket), ["50"]);
    assert.equal(recovered.funds.balance, "1000.0000000000");
  });
}

for (const scenario of [
  { name: "malformed spread", response: (ea, request) => conditionsWire(ea, request).replace("|1.1000200000|", "|1.0000000000|"), code: "invalid-response", status: 409 },
  { name: "wrong symbol", response: (ea, request) => conditionsWire(ea, request, "GBPUSD"), code: "invalid-response", status: 409 },
  { name: "wrong login", response: (ea, request) => conditionsWire(ea, request, "EURUSD", OTHER_LOGIN), code: "account-changed", status: 409 },
  { name: "wrong kind", response: (ea, request) => pageWire(ea, request), code: "invalid-response", status: 409 },
  { name: "correlated read error", response: (ea, request) => `E|1|${ea.session}|${request}|${LOGIN}|Private conditions failure`, code: "read-failed", status: 503 },
] satisfies { name: string; response: (ea: FakeEA, request: string) => string; code: string; status: number }[]) {
  test(`conditions reject ${scenario.name} without altering account state`, async (t) => {
    const { bridge, connect, announce } = await startAccounts(t);
    const ea = await connect();
    const account = await announce(ea);
    const before = await publishSnapshot(bridge, ea, account.id);
    const reading = bridge.accounts.conditions(account.id, { brokerServer: ea.broker, symbol: "EURUSD" });
    const rejected = assert.rejects(reading, readError(scenario.code, scenario.status));
    const request = await readRequest(ea, "P");
    await deliver(bridge, ea, scenario.response(ea, request));
    await rejected;
    await deliver(bridge, ea, conditionsWire(ea, request));
    assert.deepEqual(bridge.accounts.get(account.id), before);
    const retry = bridge.accounts.conditions(account.id, { brokerServer: ea.broker, symbol: "EURUSD" });
    const retryRequest = await readRequest(ea, "P");
    await deliver(bridge, ea, conditionsWire(ea, retryRequest));
    assert.equal((await retry).conditions.symbol, "EURUSD");
  });
}

test("a new session's different login on the same terminal and broker retires an in-flight old assembly", async (t) => {
  const { bridge, connect, announce } = await startAccounts(t);
  const old = await connect({ terminal: "mt4-login-switch" });
  const account = await announce(old);
  const before = await publishSnapshot(bridge, old, account.id, { balance: "750.1234567890", total: 1, rows: [orderRow(99)] });
  const reading = bridge.accounts.read(account.id);
  const rejected = assert.rejects(reading, readError("account-changed", 409));
  const request = await readRequest(old, "V");
  await deliver(bridge, old, pageWire(old, request, openingPage));
  const conditions = bridge.accounts.conditions(account.id, { brokerServer: old.broker, symbol: "EURUSD" });
  const conditionsRejected = assert.rejects(conditions, readError("account-changed", 409));
  const conditionsRequest = await readRequest(old, "P");
  const next = await connect({ terminal: old.terminal, broker: old.broker });
  assert.equal(bridge.accounts.get(account.id)?.sources[0].connected, true, "H alone does not announce a login switch");
  const nextAccount = await announce(next, { login: OTHER_LOGIN });
  await Promise.all([rejected, conditionsRejected]);
  assert.notEqual(nextAccount.id, account.id);
  const retired = bridge.accounts.get(account.id)!;
  assert.equal(retired.connected, false);
  assert.equal(retired.state, "stale");
  assert.deepEqual(retired.funds, before.funds);
  assert.deepEqual(retired.positions, before.positions);
  assert.equal(nextAccount.state, "unavailable");
  assert.equal(nextAccount.funds.balance, null);

  for (const wire of [pageWire(old, request, closingPage), conditionsWire(old, conditionsRequest), `I|1|${old.session}|${LOGIN}|USD|1|1|1|0.5`]) {
    await deliver(bridge, old, wire);
    assert.equal(await old.receive(), `R|1|${old.session}`);
  }
  await heartbeat(bridge, old, 0); // An old H cannot resurrect a retired login.
  assert.equal(bridge.accounts.get(account.id)?.connected, false);
  assert.deepEqual(bridge.accounts.get(account.id)?.source, before.source);
  const current = await publishSnapshot(bridge, next, nextAccount.id, { login: OTHER_LOGIN, balance: "5000", total: 1, rows: [orderRow(500, 2)] });
  assert.equal(current.source?.session, next.session);
  assert.equal(current.source?.login, OTHER_LOGIN);
  assert.equal(current.positions.length, 0);
  assert.deepEqual(current.orders.map((o) => o.ticket), ["500"]);
  assert.equal(bridge.accounts.list().length, 2);
});

test("a login change on the same session revokes its source and discards the partial read", async (t) => {
  const { bridge, connect, announce } = await startAccounts(t);
  const ea = await connect();
  const account = await announce(ea);
  const reading = bridge.accounts.read(account.id);
  const request = await readRequest(ea, "V");
  await deliver(bridge, ea, pageWire(ea, request, openingPage));
  const rejected = assert.rejects(reading, readError("account-changed", 409));
  await deliver(bridge, ea, `I|1|${ea.session}|${OTHER_LOGIN}|USD|1|1|1|0.5`);
  await rejected;
  assert.deepEqual(bridge.accounts.list().map((a) => a.login), [LOGIN]);
  assert.equal(bridge.accounts.get(account.id)?.sources[0].login, LOGIN);
  await deliver(bridge, ea, pageWire(ea, request, closingPage));
  assert.equal(bridge.accounts.get(account.id)?.connected, false);
  assert.equal(bridge.accounts.get(account.id)?.funds.balance, null);
});

test("margin level retains decimal precision and fixed notation at supported financial boundaries", async (t) => {
  const { bridge, connect, announce } = await startAccounts(t);
  const ea = await connect();
  const account = await announce(ea);
  const snapshot = await publishSnapshot(bridge, ea, account.id, { equity: "900719925474099.1000000000", margin: "1.0000000000" });
  assert.equal(snapshot.funds.marginLevel, "90071992547409910.0000000000");
  const tinyMargin = await publishSnapshot(bridge, ea, account.id, { equity: "999999999999999.9999999999", margin: "0.0000000001" });
  assert.equal(tinyMargin.funds.marginLevel, "999999999999999999999999900.0000000000");
});

test("the supported 1000-order account snapshot publishes all fifty pages atomically", async (t) => {
  const { bridge, connect, announce } = await startAccounts(t);
  const ea = await connect();
  const account = await announce(ea);
  const reading = bridge.accounts.read(account.id);
  const request = await readRequest(ea, "V");
  for (let offset = 0; offset < 1000; offset += 20) {
    assert.equal(bridge.accounts.get(account.id)?.funds.balance, null);
    await deliver(bridge, ea, pageWire(ea, request, { total: 1000, offset, rows: Array.from({ length: 20 }, (_, i) => orderRow(offset + i + 1)) }));
  }
  const snapshot = await reading;
  assert.equal(snapshot.positions.length, 1000);
  assert.equal(snapshot.positions.at(-1)?.ticket, "1000");
  assert.equal(snapshot.state, "fresh");
});

test("conditions bind a copy of the requested market, never a caller's later broker or symbol mutation", async (t) => {
  const { bridge, connect, announce } = await startAccounts(t);
  const ea = await connect();
  const account = await announce(ea);
  const market = { brokerServer: ea.broker, symbol: "EURUSD" };
  const reading = bridge.accounts.conditions(account.id, market);
  const request = await readRequest(ea, "P");
  market.brokerServer = "Other-Broker";
  market.symbol = "XAUUSD";
  await deliver(bridge, ea, conditionsWire(ea, request));
  const result = await reading;
  assert.deepEqual(result.market, { brokerServer: ea.broker, symbol: "EURUSD" });
  assert.equal(result.source.brokerServer, ea.broker);
});

test("an executor-required read returns that executor's complete snapshot even when another terminal wins the account tie", async (t) => {
  const { bridge, connect, announce } = await startAccounts(t);
  const reader = await connect({ terminal: "mt4-a" });
  const executor = await connect({ terminal: "mt4-z" });
  const account = await announce(reader);
  await publishSnapshot(bridge, reader, account.id, { balance: "111" });
  await announce(executor, { enabled: true });
  const reading = bridge.accounts.read(account.id, true);
  const request = await readRequest(executor, "V");
  await deliver(bridge, executor, pageWire(executor, request, { balance: "222" }));
  const snapshot = await reading;
  assert.equal(snapshot.source?.terminalId, executor.terminal);
  assert.equal(snapshot.funds.balance, "222");
});

test("two terminals deduplicate the same broker/login, while equal logins at different brokers stay distinct", async (t) => {
  const { bridge, connect, announce } = await startAccounts(t);
  const first = await connect({ terminal: "mt4-a", broker: "Broker-A" });
  const second = await connect({ terminal: "mt4-b", broker: "Broker-A" });
  const otherBroker = await connect({ terminal: "mt4-c", broker: "Broker-B" });
  const a = await announce(first);
  const duplicate = await announce(second);
  const b = await announce(otherBroker);
  assert.equal(duplicate.id, a.id);
  assert.notEqual(b.id, a.id);
  assert.equal(b.login, a.login);
  assert.equal(bridge.accounts.list().length, 2);
  assert.deepEqual(bridge.accounts.get(a.id)?.sources.map((s) => s.terminalId), ["mt4-a", "mt4-b"]);
  assert.deepEqual(bridge.accounts.get(b.id)?.sources.map((s) => s.terminalId), ["mt4-c"]);
  await publishSnapshot(bridge, first, a.id, { balance: "111" });
  await publishSnapshot(bridge, otherBroker, b.id, { balance: "222" });
  assert.equal(bridge.accounts.get(a.id)?.funds.balance, "111");
  assert.equal(bridge.accounts.get(b.id)?.funds.balance, "222");
});

test("a real account's executor state is real-account until a chart has EnableRealTrading, whatever EnableDemoTrading says", async (t) => {
  const { bridge, connect, announce } = await startAccounts(t);
  const reader = await connect({ terminal: "mt4-a" });
  const account = await announce(reader, { demo: false });
  assert.deepEqual(bridge.accounts.executor(account.id), { state: "real-account", source: null });
  await announce(await connect({ terminal: "mt4-b" }), { enabled: true, demo: false, ready: true, maxLots: "0.5" });
  await announce(await connect({ terminal: "mt4-c" }), { enabled: true, demo: false, ready: true, maxLots: "0.5" });
  assert.deepEqual(bridge.accounts.executor(account.id), { state: "real-account", source: null });
});

test("each terminal's presence says whether its account is demo, once an EA there has announced it", async (t) => {
  const { bridge, connect, announce } = await startAccounts(t);
  const demo = await connect({ terminal: "mt4-demo" });
  const real = await connect({ terminal: "mt4-real" });
  await connect({ terminal: "mt4-quiet" });
  await announce(demo, { demo: true });
  await announce(real, { demo: false, login: "999" });
  const shown = Object.fromEntries(bridge.snapshot().terminals.map((p) => [p.terminalId, p.demo]));
  assert.deepEqual(shown, { "mt4-demo": true, "mt4-real": false, "mt4-quiet": undefined });
});

for (const scenario of [
  { name: "unready demo", demo: true, ready: false, maxLots: "0.5", state: "not-ready" },
  { name: "unready real", demo: false, ready: false, maxLots: "0.5", state: "not-ready" },
  { name: "ready real", demo: false, ready: true, maxLots: "0.5", state: "ready" },
  { name: "demo with unknown cap", demo: true, ready: true, maxLots: null, state: "not-ready" },
  { name: "demo with zero cap", demo: true, ready: true, maxLots: "0.0000000000", state: "not-ready" },
  { name: "demo with negative cap", demo: true, ready: true, maxLots: "-1.0000000000", state: "not-ready" },
] as const) {
  test(`reads prefer the sole ${scenario.name} executor to a lexically earlier reader`, async (t) => {
    const { bridge, clock, connect, announce } = await startAccounts(t);
    const reader = await connect({ terminal: "mt4-a-reader" });
    const executor = await connect({ terminal: "mt4-z-executor" });
    const account = await announce(reader, { demo: scenario.demo });
    // A real account's trading chart is the one with EnableRealTrading; a demo one's, EnableDemoTrading.
    await announce(executor, scenario.demo ? { enabled: true, demo: true, ready: scenario.ready, maxLots: scenario.maxLots } : { demo: false, ready: scenario.ready, maxLots: scenario.maxLots, realEnabled: true });
    assert.equal(bridge.accounts.executor(account.id).state, scenario.state);
    const market = { brokerServer: executor.broker, symbol: "EURUSD" };
    const reading = bridge.accounts.conditions(account.id, market);
    const request = await readRequest(executor, "P");
    await deliver(bridge, executor, conditionsWire(executor, request));
    assert.deepEqual(await reading, {
      accountId: account.id, market,
      source: { ...bindingOf(bridge.accounts.sources(account.id)[1]), receivedAt: clock.now() },
      conditions: {
        type: "conditions", session: executor.session, request, login: LOGIN, symbol: "EURUSD",
        bid: "1.1000000000", ask: "1.1000200000", digits: 5, point: "0.0000100000", tickSize: "0.0000100000",
        minLots: "0.0100000000", maxLots: "100.0000000000", lotStep: "0.0100000000", stopLevel: 10, freezeLevel: 5,
        tradeAllowed: false, quoteTime: 1700000002, tickValue: "1.0000000000", contractSize: "100000.0000000000",
        marginRequired: "1000.0000000000", swapLong: "-1.2500000000", swapShort: "0.5000000000", swapType: 0,
        profitCurrency: "USD", starting: 0, expiration: 0,
      },
    });
    const snapshot = await publishSnapshot(bridge, executor, account.id, { demo: scenario.demo });
    assert.equal(snapshot.source?.session, executor.session);
    assert.equal(snapshot.demo, scenario.demo);
    assert.deepEqual(snapshot.funds, {
      balance: "1000.0000000000", equity: "999.0000000000", margin: "10.0000000000", freeMargin: "989.0000000000",
      profit: "-1.0000000000", marginLevel: "9990.0000000000", currency: "USD", leverage: 100,
    });
  });
}

for (const enabled of [false, true]) for (const sameTerminal of [false, true]) {
  test(`${enabled ? "several" : "zero"} trading charts of a demo account pick deterministically by ${sameTerminal ? "session" : "terminal"}, not announcement order`, async (t) => {
    const { bridge, connect, announce } = await startAccounts(t);
    const z = await connect({ terminal: sameTerminal ? "mt4-shared" : "mt4-z", session: "z-reader" });
    const a = await connect({ terminal: sameTerminal ? "mt4-shared" : "mt4-a", session: "a-reader" });
    const account = await announce(z, { enabled });
    await announce(a, { enabled });
    // Every chart of a demo account may trade: with several, the first ready one is its trading chart.
    assert.deepEqual([bridge.accounts.executor(account.id).state, bridge.accounts.executor(account.id).source?.session ?? null], enabled ? ["ready", a.session] : ["zero", null]);
    const reading = bridge.accounts.conditions(account.id, { brokerServer: a.broker, symbol: "EURUSD" });
    const request = await readRequest(a, "P");
    await deliver(bridge, a, conditionsWire(a, request));
    assert.equal((await reading).source.session, a.session);
    const snapshot = await publishSnapshot(bridge, a, account.id);
    assert.equal(snapshot.source?.session, a.session);
  });
}

for (const scenario of [
  { name: "zero executors", sources: [{ enabled: false }] },
  { name: "multiple real executors", sources: [{ demo: false, realEnabled: true }, { demo: false, realEnabled: true }] },
  { name: "real account", sources: [{ enabled: true, demo: false }] },
  { name: "unknown EA cap", sources: [{ enabled: true, maxLots: null }] },
  { name: "unready executor", sources: [{ enabled: true, ready: false }] },
] satisfies { name: string; sources: Announcement[] }[]) {
  test(`executor-required account and conditions reads reject ${scenario.name}`, async (t) => {
    const { bridge, connect, announce } = await startAccounts(t);
    const ea = await connect();
    const account = await announce(ea, scenario.sources[0]);
    for (const source of scenario.sources.slice(1)) await announce(await connect(), source);
    const market = { brokerServer: ea.broker, symbol: "EURUSD" };
    await assert.rejects(bridge.accounts.read(account.id, true), readError("executor-unavailable", 503));
    await assert.rejects(bridge.accounts.conditions(account.id, market, true), readError("executor-unavailable", 503));
    // The rejected gated reads must not have left any request on the wire.
    const reading = bridge.accounts.conditions(account.id, market);
    const request = await readRequest(ea, "P");
    await deliver(bridge, ea, conditionsWire(ea, request));
    assert.equal((await reading).source.session, ea.session);
  });
}

test("executor-required reads succeed only with the sole ready demo executor and a known cap", async (t) => {
  const { bridge, connect, announce } = await startAccounts(t);
  const ea = await connect();
  const account = await announce(ea, { enabled: true });
  assert.equal(bridge.accounts.executor(account.id).state, "ready");
  const reading = bridge.accounts.read(account.id, true);
  const request = await readRequest(ea, "V");
  await deliver(bridge, ea, pageWire(ea, request));
  assert.equal((await reading).source?.session, ea.session);
  const conditions = bridge.accounts.conditions(account.id, { brokerServer: ea.broker, symbol: "EURUSD" }, true);
  const conditionRequest = await readRequest(ea, "P");
  await deliver(bridge, ea, conditionsWire(ea, conditionRequest));
  assert.equal((await conditions).source.session, ea.session);
});

test("list expires incomplete account and conditions reads at the fake-clock deadline and keeps offline data stale", async (t) => {
  const { bridge, clock, connect, announce } = await startAccounts(t);
  const ea = await connect();
  const account = await announce(ea);
  const before = await publishSnapshot(bridge, ea, account.id, { balance: "750.1234567890", total: 1, rows: [orderRow(99)] });
  const reading = bridge.accounts.read(account.id);
  const rejected = assert.rejects(reading, readError("read-timeout", 504));
  const request = await readRequest(ea, "V");
  await deliver(bridge, ea, pageWire(ea, request, openingPage));
  const conditions = bridge.accounts.conditions(account.id, { brokerServer: ea.broker, symbol: "EURUSD" });
  const conditionsRejected = assert.rejects(conditions, readError("read-timeout", 504));
  const conditionRequest = await readRequest(ea, "P");
  let settled = 0;
  void reading.then(() => { settled++; }, () => { settled++; });
  void conditions.then(() => { settled++; }, () => { settled++; });
  clock.advance(4999);
  assert.equal(bridge.accounts.list()[0].state, "fresh");
  assert.equal(settled, 0);
  clock.advance(1);
  const expired = bridge.accounts.list()[0];
  await Promise.all([rejected, conditionsRejected]);
  assert.equal(settled, 2);
  assert.equal(expired.state, "stale");
  assert.equal(expired.connected, false);
  assert.equal(expired.sources[0].connected, false);
  assert.deepEqual(expired.funds, before.funds);
  assert.deepEqual(expired.positions, before.positions);
  assert.deepEqual(expired.source, before.source);
  await deliver(bridge, ea, pageWire(ea, request, closingPage));
  await deliver(bridge, ea, conditionsWire(ea, conditionRequest));
  assert.deepEqual(bridge.accounts.get(account.id), expired, "late responses cannot publish or revive the offline source");
  await assert.rejects(bridge.accounts.read(account.id), readError("unavailable-source", 503));
  await assert.rejects(bridge.accounts.conditions(account.id, { brokerServer: ea.broker, symbol: "EURUSD" }), readError("unavailable-source", 503));
  await heartbeat(bridge, ea);
  assert.equal(bridge.accounts.get(account.id)?.connected, true);
  assert.equal(bridge.accounts.get(account.id)?.state, "stale", "a heartbeat alone cannot refresh financial data");
  const recovered = await publishSnapshot(bridge, ea, account.id, { total: 1, rows: [orderRow(50, 5)] });
  assert.equal(recovered.state, "fresh");
  assert.equal(recovered.positions.length, 0);
  assert.deepEqual(recovered.orders.map((o) => o.ticket), ["50"]);
});

test("list expires only reads whose own deadline has elapsed", async (t) => {
  const { bridge, clock, connect, announce } = await startAccounts(t);
  const ea = await connect();
  const account = await announce(ea);
  const first = bridge.accounts.read(account.id);
  const rejected = assert.rejects(first, readError("read-timeout", 504));
  await readRequest(ea, "V");
  clock.advance(3000);
  await heartbeat(bridge, ea);
  const later = bridge.accounts.conditions(account.id, { brokerServer: ea.broker, symbol: "EURUSD" });
  const request = await readRequest(ea, "P");
  let laterSettled = false;
  void later.then(() => { laterSettled = true; }, () => { laterSettled = true; });
  clock.advance(2000);
  assert.equal(bridge.accounts.list()[0].connected, true);
  await rejected;
  assert.equal(laterSettled, false);
  await deliver(bridge, ea, conditionsWire(ea, request));
  assert.equal((await later).source.receivedAt, clock.now());
});

test("interleaved and out-of-order pages publish only complete single-source snapshots, newest receipt wins", async (t) => {
  const { bridge, clock, connect, announce } = await startAccounts(t);
  const a = await connect({ terminal: "mt4-a" });
  const b = await connect({ terminal: "mt4-b" });
  const account = await announce(a, { enabled: true });
  await announce(b);
  const initial = await publishSnapshot(bridge, a, account.id, { balance: "111", total: 2, rows: [orderRow(901, 1), orderRow(902, 2)] });
  clock.advance(1);
  await announce(a);
  await announce(b, { enabled: true });
  const readingB = bridge.accounts.read(account.id);
  const requestB = await readRequest(b, "V");
  const headerB = { balance: "222", capturedAt: 1700000999 };
  await deliver(bridge, b, pageWire(b, requestB, { ...openingPage, ...headerB }));
  assert.deepEqual(bridge.accounts.get(account.id)?.funds, initial.funds);
  assert.deepEqual(bridge.accounts.get(account.id)?.orders, initial.orders);
  clock.advance(1);
  await announce(b);
  await announce(a, { enabled: true });
  const readingA = bridge.accounts.read(account.id);
  const requestA = await readRequest(a, "V");
  const headerA = { balance: "333", capturedAt: 1700000001 };
  // The final page may arrive first, but cannot replace any part of the last complete snapshot.
  await deliver(bridge, a, pageWire(a, requestA, { ...closingPage, ...headerA, rows: [orderRow(300, 5, "GBPUSD")] }));
  await deliver(bridge, b, pageWire(b, requestA, { ...openingPage, ...headerA }));
  assert.deepEqual(bridge.accounts.get(account.id)?.source, initial.source);
  assert.deepEqual(bridge.accounts.get(account.id)?.positions, initial.positions);
  await deliver(bridge, b, pageWire(b, requestB, { ...closingPage, ...headerB, rows: [orderRow(21, 2)] }));
  const completeB = await readingB;
  assert.equal(completeB.funds.balance, "222");
  assert.equal(completeB.positions.length, 20);
  assert.deepEqual(completeB.orders.map((o) => o.ticket), ["21"]);
  assert.equal(completeB.source?.session, b.session);
  assert.equal(completeB.source?.capturedBrokerTime, 1700000999);
  assert.equal(bridge.accounts.get(account.id)?.funds.balance, "222");

  clock.advance(1);
  await deliver(bridge, a, pageWire(a, requestA, {
    ...openingPage, ...headerA, rows: Array.from({ length: 20 }, (_, i) => orderRow(101 + i, i % 2, "GBPUSD")),
  }));
  const completeA = await readingA;
  assert.equal(completeA.funds.balance, "333");
  assert.deepEqual(completeA.positions.map((o) => o.ticket), ["101", "102", "103", "104", "105", "106", "107", "108", "109", "110", "111", "112", "113", "114", "115", "116", "117", "118", "119", "120"]);
  assert.deepEqual(completeA.orders.map((o) => o.ticket), ["300"]);
  assert.ok([...completeA.positions, ...completeA.orders].every((o) => o.symbol === "GBPUSD"));
  assert.deepEqual(completeA.source, {
    accountId: account.id, session: a.session, terminalId: a.terminal, brokerServer: a.broker, login: LOGIN,
    capturedBrokerTime: 1700000001, receivedAt: clock.now(),
  });
  assert.deepEqual(bridge.accounts.get(account.id), completeA, "receipt time, not the broker capture clock, selects the newest complete answer");

  const saved = structuredClone(completeA);
  completeA.funds.balance = "0";
  completeA.positions[0].ticket = "999";
  completeA.source!.login = OTHER_LOGIN;
  completeA.sources[0].connected = false;
  assert.deepEqual(bridge.accounts.get(account.id), saved, "public read results cannot mutate cached state");
  clock.advance(1);
  const empty = await publishSnapshot(bridge, a, account.id, { balance: "444" });
  assert.equal(empty.funds.balance, "444");
  assert.deepEqual(empty.positions, []);
  assert.deepEqual(empty.orders, []);
});

test("a connected partial source cannot make a disconnected complete snapshot fresh", async (t) => {
  const { bridge, clock, connect, announce } = await startAccounts(t);
  const a = await connect({ terminal: "mt4-a" });
  const account = await announce(a);
  const before = await publishSnapshot(bridge, a, account.id, { balance: "111", total: 1, rows: [orderRow(99)] });
  clock.advance(5000);
  const b = await connect({ terminal: "mt4-b" });
  await announce(b);
  const reading = bridge.accounts.read(account.id);
  const request = await readRequest(b, "V");
  await deliver(bridge, b, pageWire(b, request, openingPage));
  const partial = bridge.accounts.get(account.id)!;
  assert.equal(partial.connected, true);
  assert.equal(partial.state, "stale");
  assert.deepEqual(partial.funds, before.funds);
  assert.deepEqual(partial.source, before.source);
  await deliver(bridge, b, pageWire(b, request, closingPage));
  const completed = await reading;
  assert.equal(completed.state, "fresh");
  assert.equal(completed.source?.session, b.session);
  assert.equal(completed.positions.length, 21);
  assert.equal(completed.funds.balance, "1000.0000000000");
});

test("equal-time complete snapshots select a deterministic whole source rather than the last arrival", async (t) => {
  const { bridge, connect, announce } = await startAccounts(t);
  const z = await connect({ terminal: "mt4-z" });
  const a = await connect({ terminal: "mt4-a" });
  const account = await announce(z, { enabled: true });
  await announce(a);
  await publishSnapshot(bridge, z, account.id, { balance: "222", total: 1, rows: [orderRow(22, 2)] });
  await announce(z);
  await announce(a, { enabled: true });
  const selected = await publishSnapshot(bridge, a, account.id, { balance: "111", total: 1, rows: [orderRow(11, 1)] });
  await announce(a);
  await announce(z, { enabled: true });
  const laterArrival = await publishSnapshot(bridge, z, account.id, { balance: "333", total: 1, rows: [orderRow(33, 5)] });
  assert.equal(laterArrival.funds.balance, "111");
  assert.deepEqual(laterArrival.positions.map((o) => o.ticket), ["11"]);
  assert.deepEqual(laterArrival.orders, []);
  assert.deepEqual(laterArrival.source, selected.source);
});

for (const field of ["accountId", "terminalId", "brokerServer", "session"] as const) {
  test(`result registration rejects a mismatched ${field} before accepting any result`, async (t) => {
    const { bridge, connect, announce } = await startAccounts(t);
    const ea = await connect();
    const account = await announce(ea, { enabled: true });
    const binding = bindingOf(account.sources[0]);
    assert.throws(() => bridge.accounts.expectResult(UNUSED_REQUEST, { ...binding, [field]: "other-source" }), readError("invalid-response", 409));
    // A rejected registration did not reserve the request or poison the real binding.
    bridge.accounts.expectResult(UNUSED_REQUEST, binding);
    const received: AccountBinding[] = [];
    t.after(bridge.accounts.onResult((_result, source) => { received.push(source); }));
    await deliver(bridge, ea, resultWire(ea, UNUSED_REQUEST));
    assert.deepEqual(received, [binding]);
  });
}

test("result registration copies its binding and late results stay attached to the retired login, never its replacement", async (t) => {
  const { bridge, connect, announce } = await startAccounts(t);
  const old = await connect({ terminal: "mt4-results" });
  const account = await announce(old, { enabled: true });
  const binding = bindingOf(account.sources[0]);
  const expected = { accountId: account.id, session: old.session, terminalId: old.terminal, brokerServer: old.broker, login: LOGIN };
  const request = "a".repeat(32);
  assert.throws(() => bridge.accounts.expectResult("not-a-request", binding), readError("invalid-response", 409));
  bridge.accounts.expectResult(request, binding);
  assert.throws(() => bridge.accounts.expectResult(request, binding), readError("invalid-response", 409));
  Object.assign(binding, { accountId: "changed", session: "changed", terminalId: "changed", brokerServer: "changed", login: OTHER_LOGIN });

  // Each listener also receives its own copy: one consumer cannot rewrite evidence seen by the next.
  t.after(bridge.accounts.onResult((result, source) => {
    result.login = OTHER_LOGIN;
    result.ticket = "999";
    source.accountId = "changed-by-listener";
    source.login = OTHER_LOGIN;
  }));
  const received: { result: TradeResult; binding: AccountBinding }[] = [];
  const off = bridge.accounts.onResult((result, source) => { received.push({ result, binding: source }); });
  t.after(off);
  const next = await connect({ terminal: old.terminal, broker: old.broker });
  const replacement = await announce(next, { login: OTHER_LOGIN, enabled: true });
  assert.equal(bridge.accounts.get(account.id)?.connected, false);
  assert.equal(bridge.accounts.get(replacement.id)?.connected, true);
  assert.throws(() => bridge.accounts.expectResult(UNUSED_REQUEST, expected), readError("invalid-response", 409), "new registrations cannot bind an already retired source");

  for (const [sender, wire] of [
    [old, resultWire(old, request, OTHER_LOGIN)],
    [next, resultWire(next, request)],
    [old, resultWire(old, UNUSED_REQUEST)],
    [old, resultWire(old, request).replace(`|${old.session}|`, `|${next.session}|`)],
    [old, resultWire(old, request).replace("|succeeded|101|0|", "|succeeded|0|0|")],
  ] as const) {
    await deliver(bridge, sender, wire);
    assert.deepEqual(received, [], "malformed or mismatched X must not reach a result listener");
  }
  await deliver(bridge, old, resultWire(old, request));
  assert.deepEqual(received, [{
    result: { type: "trade-result", session: old.session, request, login: LOGIN, status: "succeeded", ticket: "101", code: 0, message: "MT4 confirmed operation" },
    binding: expected,
  }]);
  assert.notEqual(received[0].binding.accountId, replacement.id);
  assert.equal(bridge.accounts.get(account.id)?.funds.balance, null);
  assert.equal(bridge.accounts.get(replacement.id)?.funds.balance, null, "an X result is evidence, not an account snapshot");
  off();
  await deliver(bridge, old, resultWire(old, request));
  assert.equal(received.length, 1, "unsubscribed consumers receive no later result");
});

test("concurrent account readers share one frozen EA snapshot without cancelling each other's page stream", async (t) => {
  const { bridge, connect, announce } = await startAccounts(t);
  const ea = await connect();
  const account = await announce(ea);
  const first = bridge.accounts.read(account.id);
  const request = await readRequest(ea, "V");
  await deliver(bridge, ea, pageWire(ea, request, openingPage));
  const second = bridge.accounts.read(account.id);
  const results = Promise.all([first, second]);
  await deliver(bridge, ea, pageWire(ea, request, closingPage));
  const [a, b] = await results;
  assert.deepEqual(a, b);
  a.positions.length = 0;
  assert.equal(b.positions.length, 21, "each caller owns a separate returned snapshot");
});

test("result subscriber failures cannot leak private identities or suppress other subscribers", async (t) => {
  const { bridge, connect, announce } = await startAccounts(t);
  const ea = await connect();
  const account = await announce(ea, { enabled: true });
  const lines: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { lines.push(args); });
  bridge.accounts.expectResult(UNUSED_REQUEST, bindingOf(account.sources[0]));
  t.after(bridge.accounts.onResult((result) => { throw Error(`Subscriber failed for ${result.login}`); }));
  t.after(bridge.accounts.onResult(async (result) => { throw Error(`Async subscriber failed for ${result.login}`); }));
  let delivered = false;
  t.after(bridge.accounts.onResult(() => { delivered = true; }));
  await deliver(bridge, ea, resultWire(ea, UNUSED_REQUEST));
  assert.equal(delivered, true);
  assert.ok(!JSON.stringify(lines).includes(LOGIN));
  assert.ok(!JSON.stringify(bridge.snapshot()).includes(LOGIN));
  assert.equal(bridge.snapshot().invalidMessages, 0);
});

test("an executor becoming disabled during a fresh read invalidates the read without publishing partial funds", async (t) => {
  const { bridge, connect, announce } = await startAccounts(t);
  const ea = await connect();
  const account = await announce(ea, { enabled: true });
  const reading = bridge.accounts.read(account.id, true);
  const rejected = assert.rejects(reading, readError("executor-unavailable", 503));
  const request = await readRequest(ea, "V");
  await deliver(bridge, ea, pageWire(ea, request, openingPage));
  await announce(ea, { enabled: false });
  await rejected;
  assert.equal(bridge.accounts.get(account.id)?.funds.balance, null);
});

test("fresh executor reads reject a not-ready capture even if the earlier account announcement was ready", async (t) => {
  const { bridge, connect, announce } = await startAccounts(t);
  const ea = await connect();
  const account = await announce(ea, { enabled: true });
  const reading = bridge.accounts.read(account.id, true);
  const rejected = assert.rejects(reading, readError("executor-unavailable", 503));
  const request = await readRequest(ea, "V");
  await deliver(bridge, ea, pageWire(ea, request, { ready: false }));
  await rejected;
  assert.equal(bridge.accounts.get(account.id)?.funds.balance, null);
});
