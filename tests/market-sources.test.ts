// Approved seam: real ZeroMQ announcements/quotes, bridge snapshots and REST v1 fetches, not fabricated feeds.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.js";
import { selectMarketSource } from "../src/server/bridge/market-source.js";
import { marketId } from "../src/server/identity/index.js";
import { FakeClock, FakeEA, fakeTerminalIdentity, type FakeEAOptions } from "./fake-ea.js";
import { freePort } from "./free-port.js";
import { bars, writeHst } from "./hst-fixtures.js";

const MARKET = { brokerServer: "Demo-Broker", symbol: "EURUSD" };
const A = "mt4-aaaaaaaaaaaa";
const B = "mt4-bbbbbbbbbbbb";
const NOW = 1_800_000_000_000;
const QUOTE = `/markets/${marketId(MARKET.brokerServer, MARKET.symbol)}/quote`;
const MACD = `/markets/${marketId(MARKET.brokerServer, MARKET.symbol)}/indicators/quotebridge.macd?timeframe=M1&limit=2`;

async function start(t: TestContext, dataFolders: Record<string, string> = {}) {
  const clock = new FakeClock(NOW);
  const eaPort = await freePort();
  const server = await startServer({ eaPort, httpPort: await freePort(), windowToken: "market-source-window-token", openDashboard: true, resolveTerminal: fakeTerminalIdentity, now: clock.now, terminalDataFolder: (terminal) => dataFolders[terminal] });
  t.after(() => server.close());
  const connect = async (terminal: string, options: FakeEAOptions = {}) => {
    const ea = new FakeEA({ terminal, broker: MARKET.brokerServer, symbol: MARKET.symbol, ...options }).connect(`tcp://127.0.0.1:${eaPort}`);
    t.after(() => ea.close());
    await ea.request(ea.helloWire());
    return ea;
  };
  const quote = async (ea: FakeEA, seq: number, quoteTime: number, bid = 1.1) => {
    const ack = await ea.request(ea.tickWire([{ seq, quoteTime, bid, ask: bid + 0.0002 }]));
    assert.equal(ack, `A|1|${ea.session}|${seq}`);
  };
  const read = async (path: string, status = 200) => {
    const response = await fetch(`${server.httpOrigin}/api/v1${path}`);
    assert.equal(response.status, status, await response.clone().text());
    return await response.json() as Record<string, any>;
  };
  const source = () => selectMarketSource(server.bridge.snapshot(), MARKET);
  return { server, clock, connect, quote, read, source };
}

test("one exact market selects the newest connected broker quote, then receipt time, then stable terminal ID through REST", { timeout: 20000 }, async (t) => {
  const app = await start(t);
  const b = await app.connect(B);
  const a = await app.connect(A);
  await app.quote(b, 1, NOW / 1000 - 1, 1.2);
  app.clock.advance(100);
  await app.quote(a, 1, NOW / 1000 - 2, 1.1);
  assert.equal(app.source()?.feed.terminal, B, "broker quote time beats receipt time and insertion order");
  assert.equal((await app.read(QUOTE)).data.provenance.terminalId, B);
  assert.equal((await app.read(MACD)).meta.source.terminalId, B);
  await app.quote(a, 2, NOW / 1000 - 1, 1.3);
  assert.equal(app.source()?.feed.terminal, A, "newer receipt breaks equal quote times");
  assert.equal((await app.read(QUOTE)).data.bid, "1.30000");
  assert.equal((await app.read(MACD)).meta.source.terminalId, A);
  await app.quote(b, 2, NOW / 1000 - 1, 1.4);
  assert.equal(app.source()?.feed.terminal, A, "stable terminal ID breaks a full tie, independent of insertion");
  assert.equal((await app.read(QUOTE)).data.provenance.terminalId, A);
});

test("quote age and five-second source silence are independent; hello and replay traffic do not refresh receipt time", { timeout: 20000 }, async (t) => {
  const app = await start(t);
  assert.equal(app.source(), null);
  const a = await app.connect(A);
  const unquoted = app.source()!;
  assert.equal(unquoted.quoteAgeMs, null);
  assert.equal(unquoted.sourceSilenceMs, null);
  assert.equal(unquoted.sourceSilent, true);
  const oldQuoteTime = NOW / 1000 - 60;
  await app.quote(a, 1, oldQuoteTime);
  assert.deepEqual(app.source(), {
    feed: app.server.bridge.snapshot().feeds[0],
    state: "connected",
    provenance: { terminalId: A, feedId: a.feedKey(), brokerServer: MARKET.brokerServer, symbol: MARKET.symbol, quoteTime: oldQuoteTime, receivedAt: NOW },
    quoteAgeMs: 60000,
    sourceSilenceMs: 0,
    sourceSilent: false,
  });
  app.clock.advance(4999);
  await a.request(a.helloWire());
  assert.equal(app.source()!.sourceSilent, false);
  app.clock.advance(1);
  assert.deepEqual([app.source()!.sourceSilenceMs, app.source()!.quoteAgeMs, app.source()!.sourceSilent, app.source()!.state], [5000, 65000, true, "connected"]);
  await app.quote(a, 1, oldQuoteTime); // replay is acknowledged, but no new sample has been accepted
  assert.equal(app.source()!.provenance.receivedAt, NOW);
  await app.quote(a, 2, oldQuoteTime);
  assert.deepEqual([app.source()!.sourceSilenceMs, app.source()!.quoteAgeMs, app.source()!.sourceSilent], [0, 65000, false]);
});

test("a connected source beats a newer offline quote; all-offline fallback is explicitly last-known", { timeout: 20000 }, async (t) => {
  const app = await start(t);
  const b = await app.connect(B);
  const a = await app.connect(A);
  await app.quote(a, 1, NOW / 1000 - 10, 1.1);
  await app.quote(b, 1, NOW / 1000, 1.2);
  app.clock.advance(8000);
  await a.request(a.helloWire());
  assert.equal(app.source()!.feed.terminal, A);
  assert.equal((await app.read(QUOTE)).data.bid, "1.10000");
  app.clock.advance(8000);
  const fallback = app.source()!;
  assert.deepEqual([fallback.feed.terminal, fallback.state, fallback.feed.latest!.bid, fallback.sourceSilent], [B, "last-known", 1.2, true]);
  assert.equal(fallback.provenance.receivedAt, NOW);
  const offline = (await app.read(QUOTE)).data;
  assert.equal(offline.state, "last-known");
  assert.equal(offline.stale, true);
  assert.equal(offline.provenance.terminalId, B);
  assert.equal(offline.sourceSilent, true);
});

test("ordinary reads never choose across exact markets, including differently cased broker/symbol spellings and offline peers", { timeout: 20000 }, async (t) => {
  const app = await start(t);
  const a = await app.connect(A);
  const otherBroker = await app.connect(B, { broker: "demo-broker" });
  const otherSymbol = await app.connect("mt4-cccccccccccc", { symbol: "eurusd" });
  await app.quote(a, 1, NOW / 1000 - 10, 1.1);
  await app.quote(otherBroker, 1, NOW / 1000, 1.2);
  await app.quote(otherSymbol, 1, NOW / 1000 + 10, 1.3);
  assert.equal(app.source()!.feed.terminal, A, "selection filters exact identity before ordering");
  // Each exact market has its own ID and quote; none is reached by a similar spelling.
  const exact = async (brokerServer: string, symbol: string) => (await app.read(`/markets/${marketId(brokerServer, symbol)}/quote`)).data;
  assert.deepEqual([(await exact(MARKET.brokerServer, "EURUSD")).bid, (await exact("demo-broker", "EURUSD")).bid, (await exact(MARKET.brokerServer, "eurusd")).bid], ["1.10000", "1.20000", "1.30000"]);
  assert.equal((await app.read(`/markets?brokerServer=DEMO-BROKER&symbol=EURUSD`)).data.length, 0, "filters are exact");
  app.clock.advance(8000);
  await a.request(a.helloWire());
  assert.deepEqual([(await exact(MARKET.brokerServer, "EURUSD")).provenance.terminalId, (await exact("demo-broker", "EURUSD")).provenance.terminalId], [A, B]);
});

test("history market resolution uses the best source and explicit terminal narrowing instead of insertion order", { timeout: 20000 }, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "quotebridge-source-history-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await writeHst(folder, MARKET.brokerServer, { version: 401, symbol: MARKET.symbol, minutes: 1, digits: 5, bars: bars(NOW / 1000 - 600, 60, 5) });
  const app = await start(t, { [A]: folder, [B]: folder });
  const a = await app.connect(A);
  const b = await app.connect(B);
  await app.quote(a, 1, NOW / 1000 - 10);
  await app.quote(b, 1, NOW / 1000);
  const path = `/markets/${marketId(MARKET.brokerServer, MARKET.symbol)}/candles?timeframe=M1`;
  assert.equal((await app.read(path)).meta.source.terminalId, B);
  app.clock.advance(8000);
  assert.equal((await app.read(path)).meta.source.terminalId, B, "offline market resolution keeps the newest last-known source");
});

test("an unquoted connected terminal cannot hide an available offline last-known quote", async (t) => {
  const app = await start(t);
  const a = await app.connect(A);
  await app.quote(a, 1, NOW / 1000, 1.2);
  app.clock.advance(8000);
  await app.connect(B);
  const quote = (await app.read(QUOTE)).data;
  assert.equal(quote.provenance.terminalId, A);
  assert.equal(quote.state, "last-known");
  assert.equal(quote.quoteAgeMs, 8000);
});

test("a previous chart owner's buffered samples cannot refresh the current quote's receipt provenance", async (t) => {
  const app = await start(t);
  const old = await app.connect(A);
  const b = await app.connect(B);
  await app.quote(old, 1, NOW / 1000 - 10);
  app.clock.advance(8000);
  const current = await app.connect(A);
  assert.equal(await old.receive(), `C|1|${old.session}|0`);
  await app.quote(current, 1, NOW / 1000, 1.2);
  app.clock.advance(100);
  await app.quote(b, 1, NOW / 1000, 1.3);
  app.clock.advance(100);
  await app.quote(old, 2, NOW / 1000 - 5, 1.1);
  const quote = (await app.read(QUOTE)).data;
  assert.equal(quote.provenance.terminalId, B, "the older buffered quote is not the selected quote's receipt");
  const aQuote = (await app.read(`/terminals/${A}/feeds/${encodeURIComponent(current.feedKey())}`)).data;
  assert.equal(aQuote.bid, "1.20000");
  assert.equal(aQuote.receivedAt, new Date(NOW + 8000).toISOString());
  assert.equal(app.server.bridge.snapshot().feeds.find((f) => f.terminal === A)?.samplesAcceptedAt, NOW + 8200, "aggregate sample-health monitoring remains independent");
});

test("chart ownership handover retains the terminal's last quote with its original receipt and explicit silence", async (t) => {
  const app = await start(t);
  const old = await app.connect(A);
  await app.quote(old, 1, NOW / 1000, 1.2);
  app.clock.advance(8000);
  await app.connect(A);
  await old.receive();
  const quote = (await app.read(QUOTE)).data;
  assert.equal(quote.bid, "1.20000");
  assert.equal(quote.provenance.receivedAt, new Date(NOW).toISOString());
  assert.equal(quote.sourceSilenceMs, 8000);
  assert.equal(quote.stale, true);
});
