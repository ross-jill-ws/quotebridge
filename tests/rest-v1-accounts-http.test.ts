// REST v1 account resources over HTTP (approved seam): deduplicated account identities, Funds, open positions and
// pending orders read fresh from one terminal, account-qualified tickets, account-scoped conditions with cross-broker
// rejection, and offline/null state after restart. Real server and database, fake EAs over real ZeroMQ, fake clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { accountId, marketId } from "../src/server/identity/index.js";
import { deliver, LOGIN, OTHER_LOGIN, orderRow } from "./account-fixtures.js";
import { DEMO, HOUR, NOW, OTHER_TERMINAL, REAL, startRest, tempFolder, TERMINAL, type Json } from "./rest-fixtures.js";

const ACCOUNT = accountId(DEMO, LOGIN);
const EURUSD = marketId(DEMO, "EURUSD");
/** Broker seconds of the fixture orders' open time, and its UTC on the GMT+2 broker (winter: 2023-11-14). */
const OPENED = 1700000000;

test("accounts are deduplicated across terminals, with explicit identity, label and each source's executor state", { timeout: 20000 }, async (t) => {
  const app = await startRest(t, await tempFolder(t, "rest-db"));
  const a = await app.connect();
  const b = await app.connect({ terminal: OTHER_TERMINAL });
  await app.announce(a, { enabled: true });
  await app.announce(b);

  const { data, meta } = await app.read("/api/v1/accounts");
  assert.deepEqual(meta, { count: 1, limit: 100, nextCursor: null });
  assert.deepEqual(data, [{
    id: ACCOUNT,
    brokerServer: DEMO,
    login: LOGIN,
    label: `${DEMO} · ${LOGIN}`,
    demo: true,
    connected: true,
    state: "unavailable",
    currency: "USD",
    executor: { state: "ready", terminalId: TERMINAL },
    sources: [
      { terminalId: TERMINAL, connected: true, executorEnabled: true, ready: true, maxLots: "0.5" },
      { terminalId: OTHER_TERMINAL, connected: true, executorEnabled: false, ready: true, maxLots: "0.5" },
    ],
  }]);
  assert.deepEqual((await app.read(`/api/v1/accounts/${ACCOUNT}`)).data, data[0]);
  assert.equal((await app.read(`/api/v1/accounts/${accountId(DEMO, OTHER_LOGIN)}`, {}, 404)).error.code, "unknown-account");
  await app.announce(b, { enabled: true });
  assert.deepEqual((await app.read(`/api/v1/accounts/${ACCOUNT}`)).data.executor, { state: "multiple", terminalId: null }, "two executors block trading");
});

test("funds, positions and pending orders come fresh from one terminal as decimal strings with UTC and broker times", { timeout: 20000 }, async (t) => {
  const app = await startRest(t, await tempFolder(t, "rest-db"));
  const ea = await app.connect();
  await app.announce(ea);
  const page = {
    rows: [orderRow(11, 0), orderRow(12, 1, "GBPUSD"), orderRow(13, 2), orderRow(14, 5)].map((r, i) => (i === 3 ? r.replace(",0,0,0,-1.25", ",1.2000000000,1.0500000000,1700003600,-1.25") : r)),
    total: 4,
  };
  const read = async (path: string, status = 200) => {
    const pending = app.read(path, {}, status);
    await app.answer(ea, 1, page);
    return pending;
  };

  const funds = await read(`/api/v1/accounts/${ACCOUNT}/funds`);
  assert.deepEqual(funds, {
    data: {
      accountId: ACCOUNT,
      currency: "USD",
      balance: "1000",
      equity: "999",
      margin: "10",
      freeMargin: "989",
      marginLevel: "9990",
      profit: "-1",
      leverage: 100,
      state: "fresh",
      capturedAt: new Date(NOW).toISOString(),
      capturedBrokerTime: new Date(NOW + 2 * HOUR * 1000).toISOString().slice(0, 19),
      receivedAt: new Date(NOW).toISOString(),
      terminalId: TERMINAL,
    },
    meta: {},
  });

  const positions = await read(`/api/v1/accounts/${ACCOUNT}/positions`);
  assert.deepEqual(positions.meta, { accountId: ACCOUNT, currency: "USD", state: "fresh", count: 2, limit: 100, nextCursor: null });
  assert.deepEqual(positions.data[0], {
    ticket: "11",
    accountId: ACCOUNT,
    marketId: EURUSD,
    symbol: "EURUSD",
    side: "buy",
    lots: "0.1",
    openPrice: "1.1",
    openTime: new Date((OPENED - 2 * HOUR) * 1000).toISOString(),
    openBrokerTime: new Date(OPENED * 1000).toISOString().slice(0, 19),
    stopLoss: null,
    takeProfit: null,
    currentPrice: "1.09",
    profit: "-1.25",
    swap: "0",
    commission: "0",
    magic: -42,
  });
  assert.deepEqual(positions.data.map((p: Json) => [p.ticket, p.side, p.marketId]), [["11", "buy", EURUSD], ["12", "sell", marketId(DEMO, "GBPUSD")]]);

  const orders = await read(`/api/v1/accounts/${ACCOUNT}/orders`);
  assert.deepEqual(orders.data.map((o: Json) => [o.ticket, o.side, o.type]), [["13", "buy", "limit"], ["14", "sell", "stop"]]);
  assert.deepEqual([orders.data[1].stopLoss, orders.data[1].takeProfit, orders.data[1].expiry], ["1.2", "1.05", new Date((1700003600 - 2 * HOUR) * 1000).toISOString()]);
  assert.equal(orders.data[0].expiry, null);

  assert.equal((await read(`/api/v1/accounts/${ACCOUNT}/positions/11`)).data.ticket, "11");
  assert.equal((await read(`/api/v1/accounts/${ACCOUNT}/orders/14`)).data.type, "stop");
  assert.equal((await read(`/api/v1/accounts/${ACCOUNT}/positions/13`, 404)).error.code, "unknown-position", "a pending order is not a position");
  assert.equal((await read(`/api/v1/accounts/${ACCOUNT}/orders/11`, 404)).error.code, "unknown-order");
  for (const ticket of ["0x1", "012", "2147483648"]) assert.equal((await app.read(`/api/v1/accounts/${ACCOUNT}/positions/${ticket}`, {}, 400)).error.code, "invalid-ticket", ticket);
});

test("tickets are account-qualified: the same ticket on two accounts names two different positions", { timeout: 20000 }, async (t) => {
  const app = await startRest(t, await tempFolder(t, "rest-db"));
  const a = await app.connect();
  const b = await app.connect({ terminal: OTHER_TERMINAL });
  const first = await app.announce(a);
  const second = await app.announce(b, { login: OTHER_LOGIN });
  const mine = app.read(`/api/v1/accounts/${first}/positions/7`);
  await app.answer(a, 1, { rows: [orderRow(7, 0)], total: 1 });
  const theirs = app.read(`/api/v1/accounts/${second}/positions/7`);
  await app.answer(b, 1, { login: OTHER_LOGIN, rows: [orderRow(7, 1, "GBPUSD")], total: 1 });
  assert.deepEqual([(await mine).data.accountId, (await mine).data.side], [first, "buy"]);
  assert.deepEqual([(await theirs).data.accountId, (await theirs).data.side], [second, "sell"]);
});

test("conditions are read from the account's source; a market on another broker server is rejected before any read", { timeout: 20000 }, async (t) => {
  const app = await startRest(t, await tempFolder(t, "rest-db"));
  const ea = await app.connect();
  await app.connect({ terminal: OTHER_TERMINAL, broker: REAL });
  // A real account: conditions do not need trading permission or a demo account.
  await app.announce(ea, { demo: false });
  const pending = app.read(`/api/v1/accounts/${ACCOUNT}/markets/${EURUSD}/conditions`);
  await app.answer(ea, 1);
  const { data } = await pending;
  assert.deepEqual(data, {
    accountId: ACCOUNT,
    marketId: EURUSD,
    symbol: "EURUSD",
    bid: "1.1",
    ask: "1.10002",
    digits: 5,
    point: "0.00001",
    tickSize: "0.00001",
    minLots: "0.01",
    maxLots: "100",
    lotStep: "0.01",
    stopLevel: 10,
    freezeLevel: 5,
    tradeAllowed: true,
    quoteTime: new Date(NOW).toISOString(),
    quoteBrokerTime: new Date(NOW + 2 * HOUR * 1000).toISOString().slice(0, 19),
    tickValue: "1",
    contractSize: "100000",
    marginRequired: "1000",
    swapLong: "-1.25",
    swapShort: "0.5",
    swapType: 0,
    profitCurrency: "USD",
    terminalId: TERMINAL,
    receivedAt: new Date(NOW).toISOString(),
  });
  const cross = await app.read(`/api/v1/accounts/${ACCOUNT}/markets/${marketId(REAL, "EURUSD")}/conditions`, {}, 409);
  assert.equal(cross.error.code, "cross-broker-market");
  assert.equal((await app.read(`/api/v1/accounts/${ACCOUNT}/markets/${marketId(DEMO, "USDJPY")}/conditions`, {}, 404)).error.code, "unknown-market");
});

test("a read the EA cannot answer says which read failed and gives the EA's reason", { timeout: 20000 }, async (t) => {
  const app = await startRest(t, await tempFolder(t, "rest-db"));
  const ea = await app.connect();
  await app.announce(ea);
  const refuse = async () => {
    let wire = await ea.receive();
    while (wire.startsWith("G|")) wire = await ea.receive();
    await deliver(app.server.bridge, ea, `E|1|${ea.session}|${wire.split("|")[3]}|${LOGIN}|Unknown symbol`);
  };
  const conditions = app.read(`/api/v1/accounts/${ACCOUNT}/markets/${EURUSD}/conditions`, {}, 503);
  await refuse();
  assert.deepEqual((await conditions).error, { code: "read-failed", message: "The terminal could not read this market's conditions.", details: { reason: "Unknown symbol" } });
  const funds = app.read(`/api/v1/accounts/${ACCOUNT}/funds`, {}, 503);
  await refuse();
  assert.deepEqual((await funds).error, { code: "read-failed", message: "The terminal could not read its account.", details: { reason: "Unknown symbol" } });
});

test("after a restart a known account is offline with null Funds, never zero; a silent source times out with 504", { timeout: 30000 }, async (t) => {
  const db = await tempFolder(t, "rest-db");
  const app = await startRest(t, db);
  const ea = await app.connect();
  await app.announce(ea);
  const silent = app.read(`/api/v1/accounts/${ACCOUNT}/funds`, {}, 504);
  await ea.receive();
  // The EA never answers: the five-second read deadline passes.
  assert.equal((await silent).error.code, "read-timeout");
  await app.stop();

  const again = await startRest(t, db, { clock: app.clock });
  const [account] = (await again.read("/api/v1/accounts")).data;
  assert.deepEqual([account.id, account.connected, account.state, account.demo, account.executor], [ACCOUNT, false, "unavailable", null, { state: "zero", terminalId: null }]);
  const funds = (await again.read(`/api/v1/accounts/${ACCOUNT}/funds`)).data;
  assert.deepEqual(funds, {
    accountId: ACCOUNT, currency: null, balance: null, equity: null, margin: null, freeMargin: null, marginLevel: null, profit: null, leverage: null,
    state: "unavailable", capturedAt: null, capturedBrokerTime: null, receivedAt: null, terminalId: null,
  });
  const positions = await again.read(`/api/v1/accounts/${ACCOUNT}/positions`);
  assert.deepEqual([positions.data, positions.meta.state], [[], "unavailable"]);
});

test("an account whose terminal falls silent for over five seconds is disconnected and stale, with its last Funds, never null or zero", { timeout: 20000 }, async (t) => {
  const app = await startRest(t, await tempFolder(t, "rest-db"));
  const ea = await app.connect();
  await app.announce(ea);
  const reading = app.read(`/api/v1/accounts/${ACCOUNT}/funds`);
  await app.answer(ea, 1, { rows: [orderRow(11, 0)], total: 1 });
  const fresh = (await reading).data;
  assert.deepEqual([fresh.state, fresh.balance, fresh.equity], ["fresh", "1000", "999"]);

  // No heartbeat for 5.001 seconds: no terminal of the account is connected; nothing is asked of the EA.
  app.clock.advance(5001);
  const account = (await app.read(`/api/v1/accounts/${ACCOUNT}`)).data;
  assert.deepEqual([account.connected, account.state, account.sources.map((s: Json) => s.connected)], [false, "stale", [false]]);
  assert.deepEqual((await app.read(`/api/v1/accounts/${ACCOUNT}/funds`)).data, { ...fresh, state: "stale" }, "the last values, marked stale");
  const positions = await app.read(`/api/v1/accounts/${ACCOUNT}/positions`);
  assert.deepEqual([positions.meta.state, positions.data.map((p: Json) => p.ticket)], ["stale", ["11"]]);
});
