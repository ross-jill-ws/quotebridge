// The Feeds view model: what each feed row shows (formatted quote cells and warnings).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FeedSnapshot, TerminalPresence } from "../src/server/bridge/index.js";
import { describeFeed, groupFeeds, nextFlash, priceParts, sortFeeds } from "../src/dashboard/feeds/feed-row.js";

const NOW = 1_800_000_000_000;

function feed(overrides: Partial<FeedSnapshot> = {}): FeedSnapshot {
  return {
    feed: "mt4-0123456789ab|Demo-Broker|EURUSD",
    terminal: "mt4-0123456789ab",
    broker: "Demo-Broker",
    symbol: "EURUSD",
    market: { brokerServer: "Demo-Broker", symbol: "EURUSD" },
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

test("prices are set like a dealing ticket: 3- and 5-digit symbols raise the last digit as the pipette after two pips", () => {
  assert.deepEqual(priceParts(1.08421, 5), { big: "1.08", pips: "42", pipette: "1" });
  assert.deepEqual(priceParts(151.832, 3), { big: "151.", pips: "83", pipette: "2" });
  assert.deepEqual(priceParts(0.6543, 5), { big: "0.65", pips: "43", pipette: "0" }, "trailing zeros are kept");
});

test("2- and 4-digit symbols show their last two digits as pips, with no pipette", () => {
  assert.deepEqual(priceParts(2651.37, 2), { big: "2651.", pips: "37", pipette: "" });
  assert.deepEqual(priceParts(1.0842, 4), { big: "1.08", pips: "42", pipette: "" });
});

test("other digit counts show the plain price", () => {
  assert.deepEqual(priceParts(12345, 0), { big: "12345", pips: "", pipette: "" });
  assert.deepEqual(priceParts(42.5, 1), { big: "42.5", pips: "", pipette: "" });
  assert.deepEqual(priceParts(0.123456, 6), { big: "0.123456", pips: "", pipette: "" });
});

test("a feed seen for the first time does not flash", () => {
  assert.deepEqual(nextFlash(undefined, 1.08421, NOW), { bid: 1.08421, direction: "none", changedAt: NOW });
});

test("a higher bid flashes up and a lower one down, from the time it changed", () => {
  const up = nextFlash({ bid: 1.08421, direction: "none", changedAt: NOW - 5000 }, 1.08425, NOW);
  assert.deepEqual(up, { bid: 1.08425, direction: "up", changedAt: NOW });
  const down = nextFlash(up, 1.0841, NOW + 300);
  assert.deepEqual(down, { bid: 1.0841, direction: "down", changedAt: NOW + 300 });
});

test("an unchanged bid keeps the last flash, so it is not started again", () => {
  const up = { bid: 1.08425, direction: "up" as const, changedAt: NOW };
  assert.deepEqual(nextFlash(up, 1.08425, NOW + 900), up);
});

test("a feed that loses its quote stops flashing; its next quote does not flash", () => {
  const lost = nextFlash({ bid: 1.08425, direction: "up", changedAt: NOW }, undefined, NOW + 100);
  assert.deepEqual(lost, { bid: undefined, direction: "none", changedAt: NOW + 100 });
  assert.equal(nextFlash(lost, 1.0843, NOW + 200).direction, "none");
});

function presence(terminalId: string, overrides: Partial<TerminalPresence> = {}): TerminalPresence {
  return { terminalId, lastHello: NOW - 1000, eaVersion: "1.08", brokerServer: "Demo-Broker", ...overrides };
}

test("feeds are grouped by terminal, each group named by its terminal and listing its feeds by symbol", () => {
  const view = groupFeeds(
    {
      feeds: [
        feed({ feed: "e-usdjpy", terminal: "mt4-e", broker: "Easy", symbol: "USDJPY" }),
        feed({ feed: "c-gold", terminal: "mt4-c", broker: "CMC", symbol: "GOLD" }),
        feed({ feed: "e-eurusd", terminal: "mt4-e", broker: "Easy", symbol: "EURUSD" }),
        feed({ feed: "c-audusd", terminal: "mt4-c", broker: "CMC", symbol: "AUDUSD.a" }),
      ],
      terminals: [presence("mt4-c"), presence("mt4-e")],
    },
    new Map([
      ["mt4-c", "CMC Markets MetaTrader 4"],
      ["mt4-e", "MT4 at easy-forex"],
    ]),
    NOW,
  );
  assert.deepEqual(
    view.groups.map((g) => [g.name, g.terminal, g.feeds.map((f) => f.symbol)]),
    [
      ["CMC Markets MetaTrader 4", "mt4-c", ["AUDUSD.a", "GOLD"]],
      ["MT4 at easy-forex", "mt4-e", ["EURUSD", "USDJPY"]],
    ],
  );
});

test("a terminal the app does not manage is named by its broker", () => {
  const view = groupFeeds({ feeds: [feed({ terminal: "mt4-main", broker: "Demo-Broker" })], terminals: [presence("mt4-main")] }, new Map(), NOW);
  assert.equal(view.groups[0].name, "Demo-Broker");
});

test("a group's head shows the terminal's EA version while connected, and when it was last heard once offline", () => {
  const head = (feeds: FeedSnapshot[], p: TerminalPresence) => groupFeeds({ feeds, terminals: [p] }, new Map(), NOW).groups[0].state;
  assert.deepEqual(head([feed()], presence("mt4-0123456789ab")), { text: "EA 1.08 connected", online: true });
  assert.deepEqual(head([feed()], presence("mt4-0123456789ab", { eaVersion: null })), { text: "EA connected", online: true });
  const offline = [feed({ online: false, lastSeen: NOW - 2 * 3_600_000 }), feed({ feed: "x", symbol: "GOLD", online: false, lastSeen: NOW - 3 * 3_600_000 })];
  assert.deepEqual(head(offline, presence("mt4-0123456789ab", { lastHello: NOW - 4 * 3_600_000 })), { text: "Offline, last heard 2 h ago", online: false });
});

test("the status sentence counts feeds and terminals, and feeds with warnings as needing attention", () => {
  const status = (feeds: FeedSnapshot[]) => {
    const { summary, attention } = groupFeeds({ feeds, terminals: [] }, new Map(), NOW);
    return [summary, attention];
  };
  assert.deepEqual(status([feed()]), ["1 feed from 1 terminal.", ""]);
  assert.deepEqual(
    status([
      feed({ feed: "a", terminal: "mt4-1" }),
      feed({ feed: "b", terminal: "mt4-1", stale: true }),
      feed({ feed: "c", terminal: "mt4-2", online: false }),
    ]),
    ["3 feeds from 2 terminals.", "1 needs attention."],
  );
  assert.deepEqual(status([feed({ feed: "a", dropped: 2 }), feed({ feed: "b", instances: 2 })]), ["2 feeds from 1 terminal.", "2 need attention."]);
});
