import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { BridgeServer } from "../src/server/bridge/bridge.js";
import { parseMessage } from "../src/server/bridge/protocol.js";
import { FakeEA, fakeTerminalIdentity, freeEndpoint } from "./fake-ea.js";

// Synthetic account identities only. Validation is exercised through the approved real ZeroMQ seam.
const LOGIN = "12345678";
const REQUEST = "0123456789abcdef0123456789abcdef";
async function wireFixture(t: TestContext) {
  const endpoint = await freeEndpoint();
  const bridge = new BridgeServer({ resolveTerminal: fakeTerminalIdentity });
  await bridge.start(endpoint);
  const chart = new FakeEA({ session: "account-protocol", eaVersion: "1.12" }).connect(endpoint);
  t.after(async () => { chart.close(); await bridge.close(); });
  await chart.request(chart.helloWire());
  return {
    bridge,
    chart,
    async send(wire: string) {
      const handled = new Promise<void>((resolve) => {
        const unsubscribe = bridge.onChange(() => { unsubscribe(); resolve(); });
      });
      await chart.send(wire);
      await handled;
    },
  };
}

const hello = (session: string) => `I|1|${session}|${LOGIN}|USD|1|0|1`;
const ORDER = "101,0,EURUSD,0.1000000000,1.1000000000,1700000000,0.0000000000,1.2000000000,0,-1.2500000000,-0.1000000000,0.0000000000,-42,1.0900000000";
const page = (session: string, total = 1, offset = 0, rows = ORDER) =>
  `V|1|${session}|${REQUEST}|${LOGIN}|Demo-Broker|USD|0|10000.0000000000|9998.6500000000|100.0000000000|9898.6500000000|-1.3500000000|100|1|1700000001|${total}|${offset}|${rows}`;
const conditions = (session: string) =>
  `P|1|${session}|${REQUEST}|${LOGIN}|EURUSD|1.1000000000|1.1002000000|5|0.0000100000|0.0000100000|0.0100000000|100.0000000000|0.0100000000|20|10|0|1700000001|1.0000000000|100000.0000000000|1000.0000000000|-2.5000000000|1.2500000000|0|USD|0|0`;
const field = (wire: string, index: number, value: string) => {
  const fields = wire.split("|"); fields[index] = value; return fields.join("|");
};
const orderField = (index: number, value: string) => {
  const fields = ORDER.split(","); fields[index] = value; return fields.join(",");
};

test("account announcements reject malformed flags over the real EA wire", { timeout: 10000 }, async (t) => {
  const { bridge, chart, send } = await wireFixture(t);
  await send(hello(chart.session).replace("|USD|1|", "|USD|true|"));
  assert.equal(bridge.snapshot().invalidMessages, 1);
  assert.doesNotMatch(bridge.snapshot().rejections[0].reason, new RegExp(LOGIN));
});

test("account pages reject invalid financial syntax over the real EA wire", { timeout: 10000 }, async (t) => {
  const { bridge, chart, send } = await wireFixture(t);
  await send(page(chart.session).replace("0.1000000000,", "1e-1,"));
  assert.equal(bridge.snapshot().invalidMessages, 1);
  assert.equal(bridge.snapshot().rejections[0].reason, "Invalid account message");
});

test("valid account page fixtures preserve financial strings, real-account reads, and the empty zero page", () => {
  const parsed = parseMessage(Buffer.from(page("fixture")));
  assert.deepEqual(parsed, {
    type: "account-page", session: "fixture", request: REQUEST, login: LOGIN, broker: "Demo-Broker", currency: "USD", demo: false,
    balance: "10000.0000000000", equity: "9998.6500000000", margin: "100.0000000000", freeMargin: "9898.6500000000", profit: "-1.3500000000",
    leverage: 100, ready: true, capturedAt: 1700000001, total: 1, offset: 0,
    orders: [{ ticket: "101", kind: 0, symbol: "EURUSD", lots: "0.1000000000", openPrice: "1.1000000000", openTime: 1700000000,
      stopLoss: "0.0000000000", takeProfit: "1.2000000000", expiration: 0, profit: "-1.2500000000", swap: "-0.1000000000", commission: "0.0000000000", magic: -42, closePrice: "1.0900000000" }],
  });
  const empty = parseMessage(Buffer.from(page("fixture", 0, 0, "")));
  assert.equal(empty.type, "account-page");
  if (empty.type === "account-page") assert.deepEqual(empty.orders, []);
});

test("contract responses reject inverted quotes over the real EA wire", { timeout: 10000 }, async (t) => {
  const { bridge, chart, send } = await wireFixture(t);
  await send(conditions(chart.session).replace("|1.1002000000|", "|1.0000000000|"));
  assert.equal(bridge.snapshot().invalidMessages, 1);
});

test("valid conditions fixtures expose all 27 fields and preserve broker precision", () => {
  assert.deepEqual(parseMessage(Buffer.from(conditions("fixture"))), {
    type: "conditions", session: "fixture", request: REQUEST, login: LOGIN, symbol: "EURUSD",
    bid: "1.1000000000", ask: "1.1002000000", digits: 5, point: "0.0000100000", tickSize: "0.0000100000",
    minLots: "0.0100000000", maxLots: "100.0000000000", lotStep: "0.0100000000", stopLevel: 20, freezeLevel: 10,
    tradeAllowed: false, quoteTime: 1700000001, tickValue: "1.0000000000", contractSize: "100000.0000000000",
    marginRequired: "1000.0000000000", swapLong: "-2.5000000000", swapShort: "1.2500000000", swapType: 0,
    profitCurrency: "USD", starting: 0, expiration: 0,
  });
});

test("trade results and read errors reject malformed correlation and status over the real EA wire", { timeout: 10000 }, async (t) => {
  const { bridge, chart, send } = await wireFixture(t);
  await send(`X|1|${chart.session}|${REQUEST}|${LOGIN}|success|101|0|MT4 confirmed operation`);
  await send(`E|1|${chart.session}|${REQUEST.toUpperCase()}|${LOGIN}|Unknown symbol`);
  assert.equal(bridge.snapshot().invalidMessages, 2);
  for (const rejection of bridge.snapshot().rejections) assert.equal(rejection.reason, "Invalid account message");
});

test("valid result fixtures distinguish definitive success, rejection, unknown, and read failure", () => {
  for (const [status, ticket, code, message] of [
    ["succeeded", "101", 0, "MT4 confirmed operation"],
    ["rejected", "0", 9001, "Demo execution disabled or account connection changed"],
    ["unknown", "0", 128, "Broker result uncertain"],
  ] as const) {
    assert.deepEqual(parseMessage(Buffer.from(`X|1|fixture|${REQUEST}|${LOGIN}|${status}|${ticket}|${code}|${message}`)), {
      type: "trade-result", session: "fixture", request: REQUEST, login: LOGIN, status, ticket, code, message,
    });
  }
  assert.deepEqual(parseMessage(Buffer.from(`E|1|fixture|${REQUEST}|${LOGIN}|Unknown symbol`)), {
    type: "read-error", session: "fixture", request: REQUEST, login: LOGIN, message: "Unknown symbol",
  });
});

test("account wire enforces exact fields, lowercase request IDs, bounded lexical numbers, and page sizes", { timeout: 10000 }, async (t) => {
  const { bridge, chart, send } = await wireFixture(t);
  const h = hello(chart.session), v = page(chart.session), p = conditions(chart.session);
  const x = `X|1|${chart.session}|${REQUEST}|${LOGIN}|succeeded|101|0|MT4 confirmed operation`;
  const e = `E|1|${chart.session}|${REQUEST}|${LOGIN}|Unknown symbol`;
  const malformed: string[] = [];
  for (const message of [h, v, p, x, e]) {
    malformed.push(message.split("|").slice(0, -1).join("|"), `${message}|extra`);
  }
  // A nine-field I is the one permitted extension; ten fields is not.
  malformed.push(`${h}|1.0000000000|extra`);
  for (const id of ["", "0", REQUEST.slice(1), `${REQUEST}0`, REQUEST.toUpperCase(), "g".repeat(32)]) {
    for (const message of [v, p, x, e]) malformed.push(field(message, 3, id));
  }
  for (const value of ["0", "-1", "2147483648", "00123", "1.0", " 123"]) malformed.push(field(h, 3, value));
  for (const value of ["NaN", "Infinity", "-Infinity", "1e2", "+1", " 1", "1 ", ".1", "1.", "01", "1,0", "1000000000000000", "0.00000000001", "--1", ""]) {
    malformed.push(`${h}|${value}`, field(v, 8, value), field(p, 6, value));
  }
  for (const index of [5, 6, 7]) malformed.push(field(h, index, "2"));
  malformed.push(field(h, 4, ""), field(h, 4, "U\u0000SD"), field(h, 4, "x".repeat(121)));
  malformed.push(page(chart.session, 1001), page(chart.session, 21), page(chart.session, 1, 1), page(chart.session, 0, 0, ORDER), page(chart.session, 0, 20, ""));
  malformed.push(page(chart.session, 20, 0, Array(21).fill(ORDER).join(";")), page(chart.session, 21, 1, Array(20).fill(ORDER).join(";")));
  for (const [index, value] of [[0, "0"], [1, "6"], [2, ""], [3, "0"], [4, "-1"], [5, "0"], [6, "-1"], [8, "-1"], [12, "2147483648"]] as const) {
    malformed.push(page(chart.session, 1, 0, orderField(index, value)));
  }
  malformed.push(page(chart.session, 1, 0, `${ORDER},extra`), page(chart.session, 1, 0, `${ORDER};`));
  for (const [index, value] of [[8, "11"], [9, "0"], [10, "0"], [11, "0"], [12, "0.001"], [13, "101"], [14, "-1"], [16, "true"], [17, "0"], [18, "-1"], [19, "0"], [23, "4"]] as const) {
    malformed.push(field(p, index, value));
  }
  malformed.push(field(field(p, 6, "999999999999999.9999999999"), 7, "999999999999999.9999999998"));
  malformed.push(field(x, 5, "failed"), field(x, 6, "0"), field(x, 7, "128"), field(x, 8, ""), field(e, 5, "x".repeat(513)));
  let rejected = 0;
  for (const message of malformed) {
    await send(message);
    assert.equal(bridge.snapshot().invalidMessages, ++rejected, `malformed case ${rejected} must be rejected`);
    assert.doesNotMatch(bridge.snapshot().rejections[0].reason, new RegExp(LOGIN));
  }
});

test("valid boundary fixtures retain decimal precision and bounded page geometry", () => {
  const cap = parseMessage(Buffer.from(`${hello("fixture")}|999999999999999.9999999999`));
  assert.equal(cap.type, "account-hello");
  if (cap.type === "account-hello") assert.equal(cap.maxLots, "999999999999999.9999999999");
  // Identical tickets deliberately remain parser-valid: uniqueness belongs to complete-snapshot assembly.
  for (const [total, offset, count] of [[20, 0, 20], [21, 20, 1], [1000, 980, 20]]) {
    const parsed = parseMessage(Buffer.from(page("fixture", total, offset, Array(count).fill(ORDER).join(";"))));
    assert.equal(parsed.type, "account-page");
    if (parsed.type === "account-page") assert.equal(parsed.orders.length, count);
  }
  let p = conditions("fixture");
  p = field(p, 6, "999999999999999.9999999998");
  p = field(p, 7, "999999999999999.9999999999");
  const parsed = parseMessage(Buffer.from(p));
  assert.equal(parsed.type, "conditions");
  if (parsed.type === "conditions") assert.equal(parsed.ask, "999999999999999.9999999999");
  assert.equal(parseMessage(Buffer.from(field(page("fixture", 0, 0, ""), 10, "-0.0000000000"))).type, "account-page");
  assert.equal(parseMessage(Buffer.from(field(conditions("fixture"), 24, ""))).type, "conditions");
  assert.equal(parseMessage(Buffer.from(`E|1|fixture|${REQUEST}|0|Account changed`)).type, "read-error");
});

test("valid account announcement fixtures expose the legacy and additive EA caps without losing decimals", () => {
  assert.deepEqual(parseMessage(Buffer.from(hello("fixture"))), {
    type: "account-hello", session: "fixture", login: LOGIN, currency: "USD", demo: true, enabled: false, ready: true, maxLots: null, realEnabled: false,
  });
  assert.deepEqual(parseMessage(Buffer.from(`${hello("fixture")}|0.5000000000`)), {
    type: "account-hello", session: "fixture", login: LOGIN, currency: "USD", demo: true, enabled: false, ready: true, maxLots: "0.5000000000", realEnabled: false,
  });
  assert.deepEqual(parseMessage(Buffer.from(`${hello("fixture")}|0.5000000000|1`)), {
    type: "account-hello", session: "fixture", login: LOGIN, currency: "USD", demo: true, enabled: false, ready: true, maxLots: "0.5000000000", realEnabled: true,
  });
});
