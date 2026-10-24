import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { BridgeServer } from "../src/server/bridge/index.js";
import { FakeClock, FakeEA, fakeTerminalIdentity, freeEndpoint } from "./fake-ea.js";

const LOGIN = "876543219";
const row = (ticket: number) => `${ticket},0,EURUSD,0.1000000000,1.1000000000,1700000000,0,0,0,-1.25,0,0,0,1.09`;
const page = (ea: FakeEA, request: string, total = 0, offset = 0, rows = "", balance = "1000.0000000000") =>
  `V|1|${ea.session}|${request}|${LOGIN}|${ea.broker}|USD|0|${balance}|999.0000000000|10.0000000000|989.0000000000|-1.0000000000|100|1|1700000001|${total}|${offset}|${rows}`;

async function announce(bridge: BridgeServer, ea: FakeEA) {
  await ea.send(`I|1|${ea.session}|${LOGIN}|USD|0|0|1|0.5000000000`);
  await ea.request(ea.helloWire());
  return bridge.accounts.list()[0];
}

async function start(t: TestContext) {
  const clock = new FakeClock();
  const bridge = new BridgeServer({ now: clock.now, resolveTerminal: fakeTerminalIdentity });
  const endpoint = await freeEndpoint();
  await bridge.start(endpoint);
  t.after(() => bridge.close());
  const ea = new FakeEA().connect(endpoint);
  t.after(() => ea.close());
  await ea.request(ea.helloWire());
  return { bridge, ea, clock };
}

test("rejected account bodies never expose login or error text in diagnostics", async (t) => {
  const { bridge, ea } = await start(t);
  for (const type of ["I", "V", "P", "X", "E"]) {
    await ea.send(`${type}|1|${ea.session}|${"a".repeat(32)}|876543219|private text|extra`);
  }
  await ea.request(ea.helloWire());
  const diagnostics = JSON.stringify(bridge.snapshot().rejections);
  assert.equal(bridge.snapshot().invalidMessages, 5);
  assert.ok(!diagnostics.includes("876543219"));
  assert.ok(!diagnostics.includes("private text"));
});

test("a real trading account is readable, missing funds are null, and only complete single-source snapshots publish", async (t) => {
  const { bridge, ea, clock } = await start(t);
  const account = await announce(bridge, ea);
  assert.equal(account.login, LOGIN);
  assert.equal(account.funds.balance, null);
  assert.equal(account.state, "unavailable");
  const reading = bridge.accounts.read(account.id);
  const request = (await ea.receive()).split("|")[3];
  await ea.send(page(ea, request, 21, 0, Array.from({ length: 20 }, (_, i) => row(i + 1)).join(";")));
  await ea.request(ea.helloWire());
  assert.equal(bridge.accounts.list()[0].funds.balance, null);
  await ea.send(page(ea, request, 21, 20, row(21)));
  const snapshot = await reading;
  assert.equal(snapshot.funds.balance, "1000.0000000000");
  assert.equal(snapshot.positions.length, 21);
  assert.equal(snapshot.source?.terminalId, ea.terminal);
  assert.equal(snapshot.demo, false);
  assert.equal(snapshot.state, "fresh");
  clock.advance(5000);
  assert.equal(bridge.accounts.list()[0].state, "stale");
  assert.equal(bridge.accounts.list()[0].connected, false);
});
