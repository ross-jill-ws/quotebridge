// The Feeds view model: what each feed row shows (formatted quote cells and warnings).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FeedSnapshot } from "../src/server/bridge/index.js";
import { describeFeed, sortFeeds } from "../src/dashboard/feeds/feed-row.js";

const NOW = 1_800_000_000_000;

function feed(overrides: Partial<FeedSnapshot> = {}): FeedSnapshot {
  return {
    feed: "mt4-0123456789ab|Demo-Broker|EURUSD",
    terminal: "mt4-0123456789ab",
    broker: "Demo-Broker",
    symbol: "EURUSD",
    timeframe: 60,
    chartTimeframes: [60],
    online: true,
    instances: 1,
    digits: 5,
    interval: 500,
    quoteStatus: "ok",
    quoteUnchangedSince: NOW - 1000,
    stale: false,
    latest: { seq: 7, bid: 1.08421, ask: 1.08433, quoteTime: 1_800_000_000, sampledTime: 1_800_000_001 },
    lastSeen: NOW - 500,
    dropped: 0,
    ...overrides,
  };
}

test("a healthy feed has no warnings", () => {
  assert.deepEqual(describeFeed(feed(), NOW).warnings, []);
});

test("a symbol the EA cannot read warns that there is no valid quote", () => {
  const row = describeFeed(feed({ quoteStatus: "no-quote", latest: undefined }), NOW);
  assert.deepEqual(row.warnings, [{ kind: "no-quote", text: "No valid quote" }]);
});

test("a stale feed warns how long its quote has been unchanged", () => {
  const row = describeFeed(feed({ stale: true, quoteUnchangedSince: NOW - 42_400 }), NOW);
  assert.deepEqual(row.warnings, [{ kind: "stale", text: "Quote unchanged for 42 s" }]);
  const longer = describeFeed(feed({ stale: true, quoteUnchangedSince: NOW - 3 * 60_000 - 5000 }), NOW);
  assert.deepEqual(longer.warnings, [{ kind: "stale", text: "Quote unchanged for 3 min" }]);
});

test("the stale warning follows the server's stale flag, not the client's clock", () => {
  // An offline feed is never stale, however old its quote.
  const row = describeFeed(feed({ online: false, stale: false, quoteUnchangedSince: NOW - 60_000 }), NOW);
  assert.deepEqual(row.warnings, []);
});

test("dropped samples are counted in the warning", () => {
  assert.deepEqual(describeFeed(feed({ dropped: 1 }), NOW).warnings, [{ kind: "dropped", text: "1 sample dropped" }]);
  assert.deepEqual(describeFeed(feed({ dropped: 1250 }), NOW).warnings, [{ kind: "dropped", text: "1,250 samples dropped" }]);
});

test("a feed sent by two charts warns about duplicate EAs", () => {
  const row = describeFeed(feed({ instances: 2, chartTimeframes: [60, 15] }), NOW);
  assert.deepEqual(row.warnings, [{ kind: "duplicate", text: "Duplicate EAs on 2 charts" }]);
});

test("several warnings appear together, most serious first", () => {
  const row = describeFeed(feed({ quoteStatus: "no-quote", latest: undefined, dropped: 3, instances: 3 }), NOW);
  assert.deepEqual(
    row.warnings.map((w) => w.kind),
    ["no-quote", "duplicate", "dropped"],
  );
});

test("bid and ask show the symbol's digits; spread is in points, as in MetaTrader's Market Watch", () => {
  const row = describeFeed(feed({ latest: { seq: 1, bid: 1.0842, ask: 1.08433, quoteTime: 1_800_000_000, sampledTime: 1 } }), NOW);
  assert.equal(row.bid, "1.08420");
  assert.equal(row.ask, "1.08433");
  assert.equal(row.spread, "13");
  const gold = describeFeed(feed({ digits: 2, latest: { seq: 1, bid: 2401.5, ask: 2401.85, quoteTime: 1_800_000_000, sampledTime: 1 } }), NOW);
  assert.deepEqual([gold.bid, gold.ask, gold.spread], ["2401.50", "2401.85", "35"]);
});

test("quote time is the broker's server time as sent, not converted to the viewer's time zone", () => {
  // 1_800_000_000 s = 2027-01-15 08:00:00 (as UTC fields).
  const row = describeFeed(feed(), NOW);
  assert.equal(row.quoteTime, "08:00:00");
  assert.equal(row.quoteDate, "2027-01-15");
});

test("a feed without a quote shows dashes", () => {
  const row = describeFeed(feed({ quoteStatus: "no-quote", latest: undefined }), NOW);
  assert.deepEqual([row.bid, row.ask, row.spread, row.quoteTime, row.quoteDate], ["—", "—", "—", "—", ""]);
});

test("timeframes use MetaTrader's period names", () => {
  const label = (timeframe: number | null) => describeFeed(feed({ timeframe }), NOW).timeframe;
  assert.equal(label(1), "M1");
  assert.equal(label(60), "H1");
  assert.equal(label(240), "H4");
  assert.equal(label(1440), "D1");
  assert.equal(label(10080), "W1");
  assert.equal(label(43200), "MN1");
  assert.equal(label(2), "M2");
  assert.equal(label(null), "—");
});

test("an offline feed says when it was last heard and can be removed; an online one cannot", () => {
  const offline = describeFeed(feed({ online: false, lastSeen: NOW - 3 * 60_000 }), NOW);
  assert.equal(offline.status, "Offline, last heard 3 min ago");
  assert.equal(offline.removable, true);
  const online = describeFeed(feed(), NOW);
  assert.equal(online.status, "Online");
  assert.equal(online.removable, false);
});

test("feeds are listed by symbol, then broker, then terminal, and keep their place when they go offline", () => {
  const feeds = [
    feed({ feed: "b", symbol: "USDJPY", broker: "A", terminal: "mt4-1" }),
    feed({ feed: "c", symbol: "EURUSD", broker: "B", terminal: "mt4-1", online: false }),
    feed({ feed: "a", symbol: "EURUSD", broker: "A", terminal: "mt4-2" }),
    feed({ feed: "d", symbol: "EURUSD", broker: "A", terminal: "mt4-1" }),
  ];
  assert.deepEqual(
    sortFeeds(feeds).map((f) => f.feed),
    ["d", "a", "c", "b"],
  );
});
