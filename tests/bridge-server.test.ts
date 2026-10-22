import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { BridgeServer } from "../src/server/bridge/index.js";
import { FakeClock, FakeEA, freeEndpoint, type FakeEAOptions } from "./fake-ea.js";

async function startBridge(t: TestContext, clock = new FakeClock()) {
  const endpoint = await freeEndpoint();
  const bridge = new BridgeServer({ now: clock.now });
  await bridge.start(endpoint);
  t.after(() => bridge.close());
  const ea = (options?: FakeEAOptions) => {
    const fake = new FakeEA(options).connect(endpoint);
    t.after(() => fake.close());
    return fake;
  };
  return { bridge, clock, ea, endpoint };
}

test("a feed appears after hello and is subscribed", { timeout: 10000 }, async (t) => {
  const { bridge, clock, ea } = await startBridge(t);
  const chart = ea({ terminal: "mt4-aaaaaaaaaaaa", broker: "Demo-Broker", symbol: "EURUSD", timeframe: 60 });

  assert.equal(await chart.request(chart.helloWire()), `C|1|${chart.session}|1`);

  const { feeds } = bridge.snapshot();
  assert.equal(feeds.length, 1);
  assert.equal(feeds[0].feed, '["mt4-aaaaaaaaaaaa","EURUSD"]');
  assert.equal(feeds[0].terminal, "mt4-aaaaaaaaaaaa");
  assert.equal(feeds[0].broker, "Demo-Broker");
  assert.equal(feeds[0].symbol, "EURUSD");
  assert.equal(feeds[0].timeframe, 60);
  assert.equal(feeds[0].online, true);
  assert.equal(feeds[0].lastSeen, clock.time);
  assert.equal(feeds[0].latest, undefined);
});

test("a tick batch is ACKed once held and its last quote becomes the feed's latest", { timeout: 10000 }, async (t) => {
  const { bridge, ea } = await startBridge(t);
  const chart = ea();
  await chart.request(chart.helloWire());

  const reply = await chart.request(
    chart.tickWire([
      { seq: 1, bid: 1.1, ask: 1.1002, quoteTime: 1700000000 },
      { seq: 2, bid: 1.2, ask: 1.2003, quoteTime: 1700000001 },
    ]),
  );

  assert.equal(reply, `A|1|${chart.session}|2`);
  assert.deepEqual(bridge.snapshot().feeds[0].latest, { seq: 2, bid: 1.2, ask: 1.2003, quoteTime: 1700000001, sampledTime: 1700000002 });
});

test("a replayed batch is ACKed again without moving the latest quote back", { timeout: 10000 }, async (t) => {
  const { bridge, ea } = await startBridge(t);
  const chart = ea();
  await chart.request(chart.helloWire());
  await chart.request(chart.tickWire([{ seq: 5, bid: 1.5, ask: 1.5002, quoteTime: 1700000005 }]));

  assert.equal(await chart.request(chart.tickWire([{ seq: 4, bid: 1.4, ask: 1.4002, quoteTime: 1700000004 }])), `A|1|${chart.session}|4`);
  assert.equal(bridge.snapshot().feeds[0].latest?.seq, 5);
});

test("ticks from an unknown session get a re-hello request and no ACK", { timeout: 10000 }, async (t) => {
  const { bridge, ea } = await startBridge(t);
  const chart = ea();

  assert.equal(await chart.request(chart.tickWire([{ seq: 1, bid: 1.1, ask: 1.1002, quoteTime: 1700000000 }])), `R|1|${chart.session}`);
  assert.deepEqual(bridge.snapshot().feeds, []);
});

test("an invalid quote is rejected without ACK and counted, and the bridge keeps serving", { timeout: 10000 }, async (t) => {
  const { bridge, ea } = await startBridge(t);
  const chart = ea();
  await chart.request(chart.helloWire());

  await chart.ticks([{ seq: 1, bid: 1.2, ask: 1.1, quoteTime: 1700000000 }]); // ask below bid
  await chart.send(chart.tickWire([{ seq: 2, bid: 1.1, ask: 1.1002, quoteTime: 1700000000 }]).replace("1.1,", "NaN,"));
  await chart.send(`H|1|${chart.session}|mt4-aaaaaaaaaaaa|Demo-Broker|EURUSD|5|500|0|ok|60|2000|1|bad version!`);

  assert.equal(await chart.request(chart.tickWire([{ seq: 3, bid: 1.3, ask: 1.3002, quoteTime: 1700000003 }])), `A|1|${chart.session}|3`);
  assert.equal(bridge.snapshot().invalidMessages, 3);
  assert.equal(bridge.snapshot().feeds[0].latest?.seq, 3);
});

test("a symbol without a valid quote is reported as no-quote", { timeout: 10000 }, async (t) => {
  const { bridge, ea } = await startBridge(t);
  const chart = ea();
  chart.quoteStatus = "no-quote";

  await chart.request(chart.helloWire());

  assert.equal(bridge.snapshot().feeds[0].quoteStatus, "no-quote");
});

test("account info and other trading messages are ignored, not counted as invalid", { timeout: 10000 }, async (t) => {
  const { bridge, ea } = await startBridge(t);
  const chart = ea();
  await chart.request(chart.helloWire());

  await chart.send(`I|1|${chart.session}|123456|USD|1|0|1`);
  await chart.send(`E|1|${chart.session}|read failed`);

  assert.equal(await chart.request(chart.tickWire([{ seq: 1, bid: 1.1, ask: 1.1002, quoteTime: 1700000000 }])), `A|1|${chart.session}|1`);
  assert.equal(bridge.snapshot().invalidMessages, 0);
});

test("duplicate charts of one feed: one subscription owner, both counted", { timeout: 10000 }, async (t) => {
  const { bridge, ea } = await startBridge(t);
  const first = ea({ timeframe: 60 });
  const second = ea({ timeframe: 240 });

  assert.equal(await first.request(first.helloWire()), `C|1|${first.session}|1`);
  await second.hello();

  assert.equal(await second.receive(), `C|1|${second.session}|0`);
  assert.equal(await first.receive(), `C|1|${first.session}|1`);
  const { feeds } = bridge.snapshot();
  assert.equal(feeds.length, 1);
  assert.equal(feeds[0].instances, 2);
  assert.equal(feeds[0].timeframe, 60);
  assert.deepEqual(feeds[0].chartTimeframes, [60, 240]);
});

test("dropped counts are summed over a feed's charts", { timeout: 10000 }, async (t) => {
  const { bridge, ea } = await startBridge(t);
  const first = ea();
  const second = ea();
  first.dropped = 3;
  second.dropped = 4;

  await first.request(first.helloWire());
  await second.request(second.helloWire());

  assert.equal(bridge.snapshot().feeds[0].dropped, 7);
});

test("a feed goes offline 7 s after its last message", { timeout: 10000 }, async (t) => {
  const { bridge, clock, ea } = await startBridge(t);
  const chart = ea();
  await chart.request(chart.helloWire());

  clock.advance(6999);
  assert.equal(bridge.snapshot().feeds[0].online, true);
  clock.advance(1);
  assert.equal(bridge.snapshot().feeds[0].online, false);
  assert.equal(bridge.snapshot().feeds[0].instances, 0);

  await chart.request(chart.helloWire());
  assert.equal(bridge.snapshot().feeds[0].online, true);
});

test("when the owner chart goes offline, a duplicate chart takes over the subscription", { timeout: 10000 }, async (t) => {
  const { bridge, clock, ea } = await startBridge(t);
  const first = ea({ timeframe: 60 });
  const second = ea({ timeframe: 240 });
  await first.request(first.helloWire());
  await second.hello();
  assert.equal(await second.receive(), `C|1|${second.session}|0`);
  await first.receive();

  clock.advance(5000);
  await second.hello();
  assert.equal(await second.receive(), `C|1|${second.session}|0`);
  clock.advance(2000);
  await second.hello();

  assert.equal(await second.receive(), `C|1|${second.session}|1`);
  assert.equal(bridge.snapshot().feeds[0].timeframe, 240);
  assert.equal(bridge.snapshot().feeds[0].instances, 1);
});

test("a quote unchanged for 10 s on an online feed is stale until its quote time moves", { timeout: 10000 }, async (t) => {
  const { bridge, clock, ea } = await startBridge(t);
  const chart = ea();
  await chart.request(chart.helloWire());
  await chart.request(chart.tickWire([{ seq: 1, bid: 1.1, ask: 1.1002, quoteTime: 1700000000 }]));
  const since = clock.time;

  clock.advance(5000);
  await chart.request(chart.tickWire([{ seq: 2, bid: 1.1, ask: 1.1002, quoteTime: 1700000000 }]));
  clock.advance(4999);
  await chart.request(chart.helloWire());
  assert.equal(bridge.snapshot().feeds[0].stale, false);
  clock.advance(1);
  assert.equal(bridge.snapshot().feeds[0].stale, true);
  assert.equal(bridge.snapshot().feeds[0].quoteUnchangedSince, since);

  await chart.request(chart.tickWire([{ seq: 3, bid: 1.1001, ask: 1.1003, quoteTime: 1700000011 }]));
  assert.equal(bridge.snapshot().feeds[0].stale, false);
});

test("terminal presence records the last hello and the EA version from a 1.08 hello", { timeout: 10000 }, async (t) => {
  const { bridge, clock, ea } = await startBridge(t);
  const eurusd = ea({ terminal: "mt4-aaaaaaaaaaaa", symbol: "EURUSD", eaVersion: "1.08" });
  const gbpusd = ea({ terminal: "mt4-aaaaaaaaaaaa", symbol: "GBPUSD", eaVersion: "1.08" });

  await eurusd.request(eurusd.helloWire());
  clock.advance(1500);
  await gbpusd.request(gbpusd.helloWire());

  assert.deepEqual(bridge.snapshot().terminals, [{ terminalId: "mt4-aaaaaaaaaaaa", lastHello: clock.time, eaVersion: "1.08", brokerServer: "Demo-Broker" }]);
});

test("a hello without the version field (EA 1.07 and older) means version unknown", { timeout: 10000 }, async (t) => {
  const { bridge, ea } = await startBridge(t);
  const v107 = ea({ terminal: "mt4-bbbbbbbbbbbb", eaVersion: null });
  const oldest = ea({ terminal: "mt4-cccccccccccc" });

  assert.equal(await v107.request(v107.helloWire()), `C|1|${v107.session}|1`);
  // The oldest EAs send 10 fields: no period, candle capacity or EA version.
  assert.equal(await oldest.request(`H|1|${oldest.session}|mt4-cccccccccccc|Demo-Broker|EURUSD|5|500|0|ok`), `C|1|${oldest.session}|1`);

  const terminals = bridge.snapshot().terminals;
  assert.deepEqual(
    terminals.map(({ terminalId, eaVersion }) => ({ terminalId, eaVersion })),
    [
      { terminalId: "mt4-bbbbbbbbbbbb", eaVersion: null },
      { terminalId: "mt4-cccccccccccc", eaVersion: null },
    ],
  );
  assert.equal(bridge.snapshot().feeds.find((f) => f.terminal === "mt4-cccccccccccc")?.timeframe, null);
});

test("an EA updated to 1.08 replaces the unknown version on its next hello", { timeout: 10000 }, async (t) => {
  const { bridge, ea } = await startBridge(t);
  const before = ea({ terminal: "mt4-dddddddddddd", eaVersion: null });
  await before.request(before.helloWire());
  before.close();
  const after = ea({ terminal: "mt4-dddddddddddd", eaVersion: "1.08" });

  await after.request(after.helloWire());

  assert.equal(bridge.snapshot().terminals[0].eaVersion, "1.08");
});

test("only an offline feed can be removed; its EA brings it back with the next hello", { timeout: 10000 }, async (t) => {
  const { bridge, clock, ea } = await startBridge(t);
  const chart = ea({ terminal: "mt4-eeeeeeeeeeee", timeframe: 1440 });
  await chart.request(chart.helloWire());
  const { feed } = bridge.snapshot().feeds[0];

  await assert.rejects(bridge.remove(feed), /online/);
  clock.advance(7000);
  await bridge.remove(feed);

  assert.deepEqual(bridge.snapshot().feeds, []);
  assert.equal(bridge.snapshot().terminals[0].terminalId, "mt4-eeeeeeeeeeee");
  await assert.rejects(bridge.remove(feed), /Unknown feed/);

  assert.equal(await chart.request(chart.helloWire()), `C|1|${chart.session}|1`);
  assert.equal(bridge.snapshot().feeds[0].feed, feed);
});
