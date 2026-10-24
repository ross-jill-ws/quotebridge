import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { BridgeServer, MAX_REJECTIONS } from "../src/server/bridge/index.js";
import { FakeClock, FakeEA, fakeTerminalIdentity, freeEndpoint, type FakeEAOptions } from "./fake-ea.js";

async function startBridge(t: TestContext, clock = new FakeClock()) {
  const endpoint = await freeEndpoint();
  const bridge = new BridgeServer({ now: clock.now, resolveTerminal: fakeTerminalIdentity });
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
  assert.equal(await chart.request(`H|1|${chart.session}|mt4-aaaaaaaaaaaa|Demo-Broker|EURUSD|5|500|0|ok|60|2000|1|bad version!`), `C|1|${chart.session}|0`);
  assert.equal(await chart.request(chart.helloWire()), `C|1|${chart.session}|1`);

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

test("terminal presence records the last hello and the EA version from a verified 1.11 hello", { timeout: 10000 }, async (t) => {
  const { bridge, clock, ea } = await startBridge(t);
  const eurusd = ea({ terminal: "mt4-aaaaaaaaaaaa", symbol: "EURUSD" });
  const gbpusd = ea({ terminal: "mt4-aaaaaaaaaaaa", symbol: "GBPUSD" });

  await eurusd.request(eurusd.helloWire());
  clock.advance(1500);
  await gbpusd.request(gbpusd.helloWire());

  assert.deepEqual(bridge.snapshot().terminals, [{ terminalId: "mt4-aaaaaaaaaaaa", lastHello: clock.time, eaVersion: "1.11", brokerServer: "Demo-Broker" }]);
});

test("legacy hellos cannot verify a terminal identity, publish nothing and cannot request bars", { timeout: 10000 }, async (t) => {
  const { bridge, ea } = await startBridge(t);
  const oldest = ea({ terminal: "mt4-cccccccccccc" });
  const peers = [ea({ eaVersion: null }), ea({ eaVersion: "1.08" }), ea({ eaVersion: "1.10" }), oldest];

  for (const peer of peers) {
    // The oldest EAs send 10 fields: no period, candle capacity or EA version.
    const wire = peer === oldest ? `H|1|${peer.session}|${peer.terminal}|Demo-Broker|EURUSD|5|500|0|ok` : peer.helloWire();
    assert.equal(await peer.request(wire), `C|1|${peer.session}|0`);
    assert.equal(await bridge.requestBars(peer.feedKey(), 60, 900), null);
  }

  const snapshot = bridge.snapshot();
  assert.deepEqual(snapshot.feeds, []);
  assert.deepEqual(snapshot.terminals, []);
  assert.equal(snapshot.invalidMessages, peers.length);
  assert.equal(snapshot.rejections.length, peers.length);
  for (const rejection of snapshot.rejections) {
    assert.match(rejection.reason, /Terminal identity unverified.*upgrade the EA to 1\.11.*rescan\/setup/);
    assert.equal(rejection.feed, null);
  }
});

test("an EA updated to 1.11 establishes verified presence on its next hello", { timeout: 10000 }, async (t) => {
  const { bridge, ea } = await startBridge(t);
  const before = ea({ terminal: "mt4-dddddddddddd", eaVersion: null });
  assert.equal(await before.request(before.helloWire()), `C|1|${before.session}|0`);
  assert.deepEqual(bridge.snapshot().terminals, []);
  before.close();
  const after = ea({ terminal: "mt4-dddddddddddd" });

  assert.equal(await after.request(after.helloWire()), `C|1|${after.session}|1`);

  assert.equal(bridge.snapshot().terminals[0].eaVersion, "1.11");
  assert.equal(bridge.snapshot().feeds[0].terminal, after.terminal);
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

test("a batch naming an old session on its new session's route is listed with its reason and attributed to the feed", { timeout: 10000 }, async (t) => {
  const { bridge, clock, ea } = await startBridge(t);
  const chart = ea({ session: "chart-new" });
  await chart.request(chart.helloWire());

  // EA 1.08 after a chart change: the new session's socket sends a batch still naming the old session.
  await chart.send("T|1|chart-old|7,1.1,1.1002,1700000000,1700000001");
  await chart.request(chart.helloWire());

  const rejection = { time: clock.time, reason: "Routing identity mismatch", route: "chart-new", excerpt: "T|1|chart-old|7,1.1,1.1002,1700000000,1700000001", feed: chart.feedKey() };
  assert.deepEqual(bridge.snapshot().rejections, [rejection]);
  assert.deepEqual(bridge.snapshot().feeds[0].lastRejection, rejection);
  assert.equal(bridge.snapshot().invalidMessages, 1);
});

test("malformed and invalid-quote messages are listed with their reasons; an unknown route's is attributed to no feed", { timeout: 10000 }, async (t) => {
  const { bridge, ea } = await startBridge(t);
  const chart = ea({ session: "chart-known" });
  const stranger = ea({ session: "chart-stranger" });
  await chart.request(chart.helloWire());

  await chart.ticks([{ seq: 1, bid: 1.2, ask: 1.1, quoteTime: 1700000000 }]); // ask below bid
  await chart.send("garbage\x01" + "x".repeat(100));
  await chart.request(chart.helloWire());
  // Another socket: its message is not ordered after the chart's, so wait for it.
  await stranger.send(`Z|1|chart-stranger|what`);
  while (bridge.snapshot().invalidMessages < 3) await new Promise((resolve) => setTimeout(resolve, 5));

  const { rejections, feeds } = bridge.snapshot();
  assert.deepEqual(
    rejections.map(({ reason, route, feed }) => ({ reason, route, feed })),
    [
      { reason: "Unknown message", route: "chart-stranger", feed: null },
      { reason: "Invalid protocol/session", route: "chart-known", feed: chart.feedKey() },
      { reason: "Invalid quote", route: "chart-known", feed: chart.feedKey() },
    ],
  );
  assert.equal(rejections[1].excerpt, "garbage?" + "x".repeat(52) + "…");
  assert.equal(feeds[0].lastRejection?.reason, "Invalid protocol/session");
  assert.equal(bridge.snapshot().invalidMessages, 3);
});

test("the rejection list stays bounded, oldest dropping out, while the count keeps counting", { timeout: 10000 }, async (t) => {
  const { bridge, ea } = await startBridge(t);
  const chart = ea();
  await chart.request(chart.helloWire());

  for (let i = 1; i <= MAX_REJECTIONS + 5; i++) await chart.send(`T|1|${chart.session}|bad-${i}`);
  await chart.request(chart.helloWire());

  const { rejections, invalidMessages } = bridge.snapshot();
  assert.equal(invalidMessages, MAX_REJECTIONS + 5);
  assert.equal(rejections.length, MAX_REJECTIONS);
  assert.match(rejections[0].excerpt, new RegExp(`bad-${MAX_REJECTIONS + 5}$`));
  assert.match(rejections.at(-1)!.excerpt, /bad-6$/);
});

test("removing a feed forgets its latest rejection", { timeout: 10000 }, async (t) => {
  const { bridge, clock, ea } = await startBridge(t);
  const chart = ea();
  await chart.request(chart.helloWire());
  await chart.send(`T|1|${chart.session}|bad`);
  await chart.request(chart.helloWire());
  chart.close();
  clock.advance(60000);

  await bridge.remove(chart.feedKey());
  const again = ea({ session: chart.session });
  await again.request(again.helloWire());

  assert.equal(bridge.snapshot().feeds[0].lastRejection, undefined);
  assert.equal(bridge.snapshot().rejections.length, 1);
});

test("a rejected account-info or trading message keeps only its type and session in the excerpt", { timeout: 10000 }, async (t) => {
  const { bridge, ea } = await startBridge(t);
  const chart = ea({ session: "chart-new" });
  await chart.request(chart.helloWire());

  await chart.send("I|1|chart-old|123456|USD|1|0|1");
  await chart.request(chart.helloWire());

  assert.equal(bridge.snapshot().rejections[0].reason, "Routing identity mismatch");
  assert.equal(bridge.snapshot().rejections[0].excerpt, "I|1|chart-old|…");
});

test("an online feed with no samples accepted for 30 s is missing samples, never or not lately, until a batch is accepted", { timeout: 10000 }, async (t) => {
  const { bridge, clock, ea } = await startBridge(t);
  const chart = ea();
  const helloFor = async (ms: number) => {
    for (let waited = 0; waited < ms; waited += 2000) {
      clock.advance(2000);
      await chart.request(chart.helloWire());
    }
  };
  await chart.request(chart.helloWire());

  await helloFor(28000);
  assert.equal(bridge.snapshot().feeds[0].samplesMissing, false);
  await helloFor(2000);
  assert.deepEqual([bridge.snapshot().feeds[0].samplesMissing, bridge.snapshot().feeds[0].samplesAcceptedAt], [true, null]);

  await chart.request(chart.tickWire([{ seq: 1, bid: 1.1, ask: 1.1002, quoteTime: 1700000000 }]));
  assert.deepEqual([bridge.snapshot().feeds[0].samplesMissing, bridge.snapshot().feeds[0].samplesAcceptedAt], [false, clock.time]);

  await helloFor(30000);
  assert.equal(bridge.snapshot().feeds[0].samplesMissing, true);
});

test("a feed is not missing samples while offline, and its 30 s start again when it comes back", { timeout: 10000 }, async (t) => {
  const { bridge, clock, ea } = await startBridge(t);
  const chart = ea();
  await chart.request(chart.helloWire());

  clock.advance(60000);
  assert.equal(bridge.snapshot().feeds[0].online, false);
  assert.equal(bridge.snapshot().feeds[0].samplesMissing, false);

  await chart.request(chart.helloWire());
  clock.advance(5000);
  assert.equal(bridge.snapshot().feeds[0].samplesMissing, false);
  for (let waited = 5000; waited < 30000; waited += 5000) {
    await chart.request(chart.helloWire());
    clock.advance(5000);
  }
  assert.equal(bridge.snapshot().feeds[0].samplesMissing, true);
});

test("a replayed batch is ACKed but does not count as samples received", { timeout: 10000 }, async (t) => {
  const { bridge, clock, ea } = await startBridge(t);
  const chart = ea();
  await chart.request(chart.helloWire());
  await chart.request(chart.tickWire([{ seq: 5, bid: 1.5, ask: 1.5002, quoteTime: 1700000005 }]));
  const accepted = clock.time;

  for (let i = 0; i < 16; i++) {
    clock.advance(2000);
    assert.equal(await chart.request(chart.tickWire([{ seq: 5, bid: 1.5, ask: 1.5002, quoteTime: 1700000005 }])), `A|1|${chart.session}|5`);
  }

  assert.deepEqual([bridge.snapshot().feeds[0].samplesMissing, bridge.snapshot().feeds[0].samplesAcceptedAt], [true, accepted]);
});

test("a bar request goes to the verified feed's owner chart (EA 1.11+), and its answer pages come back with the feed and market", { timeout: 10000 }, async (t) => {
  const { bridge, ea } = await startBridge(t);
  const chart = ea({ terminal: "mt4-aaaaaaaaaaaa", broker: "Demo-Broker", symbol: "EURUSD", eaVersion: "1.11" });
  await chart.request(chart.helloWire());
  const pages: unknown[] = [];
  bridge.onBars((event) => pages.push(event));

  const request = await bridge.requestBars(chart.feedKey(), 60, 900);
  assert.equal(typeof request, "number");
  assert.equal(await chart.receive(), `G|1|${chart.session}|${request}|60|900|0`);
  await chart.send(`G|1|${chart.session}|${request}|60|ok|2|0|1800000000,1.1,1.2,1.05,1.15,42;1800003600,1.15,1.16,1.14,1.14,7`);
  await chart.send(`G|1|${chart.session}|${request}|60|loading|0|0|`);
  await chart.request(chart.helloWire());

  const market = { brokerServer: "Demo-Broker", symbol: "EURUSD" };
  assert.deepEqual(pages, [
    {
      feed: chart.feedKey(),
      market,
      request,
      timeframe: 60,
      status: "ok",
      total: 2,
      offset: 0,
      bars: [
        { time: 1800000000, open: 1.1, high: 1.2, low: 1.05, close: 1.15, tickVolume: 42 },
        { time: 1800003600, open: 1.15, high: 1.16, low: 1.14, close: 1.14, tickVolume: 7 },
      ],
    },
    { feed: chart.feedKey(), market, request, timeframe: 60, status: "loading", total: 0, offset: 0, bars: [] },
  ]);
  assert.equal(bridge.snapshot().invalidMessages, 0);
});

test("no bar request goes to an unverified old EA, or to an offline feed", { timeout: 10000 }, async (t) => {
  const { bridge, clock, ea } = await startBridge(t);
  const old = ea({ symbol: "EURUSD", eaVersion: "1.09" });
  const fresh = ea({ symbol: "GBPUSD", eaVersion: "1.11" });
  assert.equal(await old.request(old.helloWire()), `C|1|${old.session}|0`);
  await fresh.request(fresh.helloWire());

  assert.equal(await bridge.requestBars(old.feedKey(), 60, 900), null);
  clock.advance(8000);
  assert.equal(await bridge.requestBars(fresh.feedKey(), 60, 900), null);
  assert.equal(await bridge.requestBars('["mt4-unknown","EURUSD"]', 60, 900), null);
});

test("malformed bar pages are rejected with their reasons", { timeout: 10000 }, async (t) => {
  const { bridge, ea } = await startBridge(t);
  const chart = ea({ session: "chart-bars", eaVersion: "1.11" });
  await chart.request(chart.helloWire());
  const wires = [
    "G|1|chart-bars|7|60|ok|2|0|1800000000,1.1,1.2,1.05,1.15,1", // one row of two
    "G|1|chart-bars|7|60|ok|2|0|1800003600,1.1,1.2,1.05,1.15,1;1800000000,1.1,1.2,1.05,1.15,1", // times go back
    "G|1|chart-bars|7|60|ok|1|0|1800000000,1.1,1.0,1.05,1.15,1", // high below low
    "G|1|chart-bars|7|60|ok|1|0|1800000000,1.1,1.2,1.05,1.15", // no volume
    "G|1|chart-bars|7|60|ok|901|0|", // more than 900
    "G|1|chart-bars|7|60|loading|3|0|", // loading with bars
    "G|1|chart-bars|7|7|ok|1|0|1800000000,1.1,1.2,1.05,1.15,1", // not a period
  ];
  for (const wire of wires) await chart.send(wire);
  await chart.request(chart.helloWire());

  assert.deepEqual(
    bridge.snapshot().rejections.map((r) => r.reason).reverse(),
    ["Invalid bar page size", "Invalid bar", "Invalid bar", "Invalid bar", "Invalid bar page size", "Invalid bar page size", "Invalid period"],
  );
});

test("a broker replacement refused at the peer limit cannot retire existing registrations", { timeout: 60000 }, async (t) => {
  const { bridge, clock, ea } = await startBridge(t);
  for (let i = 0; i < 1000; i++) {
    const chart = ea({ session: `capacity-${i}`, symbol: `SYM${i}` });
    assert.equal(await chart.request(chart.helloWire()), `C|1|${chart.session}|1`);
  }
  const replacement = ea({ symbol: "SYM0", broker: "Other-Broker" });
  assert.equal(await replacement.request(replacement.helloWire()), `C|1|${replacement.session}|0`);
  assert.equal(bridge.snapshot().rejections[0].reason, "Peer limit reached");
  assert.equal(bridge.snapshot().feeds.length, 1000);
  assert.deepEqual(bridge.snapshot().terminals.map((p) => p.brokerServer), ["Demo-Broker"]);
  clock.advance(60001);
  assert.equal(await replacement.request(replacement.helloWire()), `C|1|${replacement.session}|1`);
  assert.deepEqual(bridge.snapshot().feeds.map((f) => f.market.brokerServer), ["Other-Broker"]);
});
