// The Trading page's and charts' trading model: account grouping and filters (visibility only, never routing), the
// accounts an action may use, preview invalidation, keyboard safety, executor guidance and chart trade lines.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FeedSnapshot } from "../src/server/bridge/index.js";
import { LiveClient, type LiveSocket } from "../src/dashboard/live-client.js";
import type { OrderDefaults } from "../src/shared/settings-store.js";
import { accountGroups, withOrderDefaults, actionBlock, currentTrade, marketQuote, money, describeIntent, chartLines, executorGuide, requestStatus, reviewError, unresolvedBanners, newOrderForm, orderAccounts, shownTime, enterKeyAction, previewKey, requestBody, secondsLeft, unresolvedByAccount, type AccountView, type OrderForm, type PendingView, type PositionView, type RequestView } from "../src/dashboard/trading/trading-model.js";

const account = (id: string, brokerServer: string, extra: Partial<AccountView> = {}): AccountView => ({
  id, brokerServer, login: id.replace(/\D/g, "") || "1", label: `${brokerServer} · ${id}`, demo: true, connected: true, state: "fresh", currency: "USD",
  executor: { state: "ready", terminalId: "mt4-aaaaaaaaaaaa" },
  sources: [{ terminalId: "mt4-aaaaaaaaaaaa", connected: true, executorEnabled: true, ready: true, maxLots: "0.5" }],
  ...extra,
});
const position = (accountId: string, ticket: string, symbol = "EURUSD", extra: Partial<PositionView> = {}): PositionView => ({
  ticket, accountId, marketId: `m-${symbol}`, symbol, side: "buy", lots: "0.1", stopLoss: "1.09", takeProfit: null, magic: 0,
  openPrice: "1.1", openTime: "2027-01-15T08:00:00.000Z", openBrokerTime: "2027-01-15T10:00:00", currentPrice: "1.1001", profit: "1", swap: "0", commission: "0", ...extra,
});
const pending = (accountId: string, ticket: string, extra: Partial<PendingView> = {}): PendingView => ({
  ticket, accountId, marketId: "m-EURUSD", symbol: "EURUSD", side: "buy", type: "limit", lots: "0.1", stopLoss: null, takeProfit: "1.2",
  magic: 27012026, price: "1.08", placedAt: "2027-01-15T08:00:00.000Z", placedBrokerTime: "2027-01-15T10:00:00", expiry: null, expiryBrokerTime: null, currentPrice: "1.1", ...extra,
});

const A = account("acct-1", "Demo-Broker");
const B = account("acct-2", "Demo-Broker");
const OTHER = account("acct-3", "Other-Broker");

test("chart lines show every account's trades on the exact market, labelled by account and ticket, and never another broker's", () => {
  const lines = chartLines({ brokerServer: "Demo-Broker", symbol: "EURUSD" }, [A, B, OTHER], {
    positions: [position("acct-1", "11"), position("acct-2", "11"), position("acct-3", "99"), position("acct-1", "12", "eurusd")],
    orders: [pending("acct-2", "21")],
  }, new Set());
  assert.deepEqual(lines.map((l) => [l.accountId, l.ticket, l.kind, l.price]), [
    ["acct-1", "11", "entry", 1.1],
    ["acct-1", "11", "stop-loss", 1.09],
    ["acct-2", "11", "entry", 1.1],
    ["acct-2", "11", "stop-loss", 1.09],
    ["acct-2", "21", "pending", 1.08],
    ["acct-2", "21", "take-profit", 1.2],
  ]);
  assert.equal(lines[0].label, "1 #11 buy 0.1");
  assert.equal(lines[1].label, "1 #11 SL");
  assert.equal(lines[4].label, "2 #21 buy limit 0.1");
});

test("hiding an account's lines hides only them", () => {
  const lines = chartLines({ brokerServer: "Demo-Broker", symbol: "EURUSD" }, [A, B], { positions: [position("acct-1", "11"), position("acct-2", "12")], orders: [] }, new Set(["acct-1"]));
  assert.deepEqual([...new Set(lines.map((l) => l.accountId))], ["acct-2"]);
});

const ON = { enabled: true, maxLots: "1.0", slippage: 20 };
const request = (requestId: string, accountId: string, status: RequestView["status"], reviewed = false) =>
  ({ requestId, accountId, status, reviewed }) as RequestView;

test("an unresolved request blocks its own account only; the other account stays usable", () => {
  const unresolved = unresolvedByAccount([request("r1", "acct-1", "unknown"), request("r2", "acct-2", "unknown", true), request("r3", "acct-2", "succeeded")]);
  assert.deepEqual([...unresolved.keys()], ["acct-1"]);
  assert.equal(actionBlock(A, ON, unresolved)?.kind, "unresolved");
  assert.equal(actionBlock(A, ON, unresolved)?.requestId, "r1");
  assert.equal(actionBlock(B, ON, unresolved), undefined);
  assert.equal(unresolvedByAccount([request("r4", "acct-2", "dispatching")]).get("acct-2")?.requestId, "r4");
});

test("real accounts are read-only, and trading off, offline or an unready trading chart block with a reason", () => {
  const none = new Map();
  assert.match(actionBlock(account("r", "Real", { demo: false, executor: { state: "real-account", terminalId: null } }), ON, none)!.text, /Real accounts are read-only/);
  assert.match(actionBlock(A, { ...ON, enabled: false }, none)!.text, /Demo trading is off/);
  assert.match(actionBlock(account("o", "Demo-Broker", { connected: false }), ON, none)!.text, /offline/);
  assert.match(actionBlock(account("z", "Demo-Broker", { executor: { state: "zero", terminalId: null } }), ON, none)!.text, /No chart/);
  assert.match(actionBlock(account("z", "Demo-Broker", { executor: { state: "zero", terminalId: null } }), ON, none)!.text, /older than 1\.13/);
  assert.match(actionBlock(account("n", "Demo-Broker", { executor: { state: "not-ready", terminalId: "t" } }), ON, none)!.text, /not ready/);
});

test("a trading chart still running an EA without its lot cap says to reload the EA, not to check permissions", () => {
  // One terminal, three charts: only the enabled one is the trading chart, wherever it sorts.
  const chart = (enabled: boolean, maxLots: string | null) => ({ terminalId: "t", connected: true, executorEnabled: enabled, ready: true, maxLots });
  const old = account("o", "Demo-Broker", { executor: { state: "not-ready", terminalId: "t" }, sources: [chart(false, "1"), chart(true, null), chart(false, "1")] });
  const block = actionBlock(old, ON, new Map())!;
  assert.match(block.text, /older than 1\.12/);
  assert.match(block.text, /attach QuoteBridge to that chart again/);
  assert.equal(executorGuide(old, ON).caps.startsWith("The EA does not report its lot cap"), true);
});

test("a chart's Buy and Sell offer only demo accounts on the chart's own broker server, and none is chosen for you", () => {
  const real = account("acct-9", "Demo-Broker", { demo: false, executor: { state: "real-account", terminalId: null } });
  const choice = orderAccounts([A, OTHER, real], ON, new Map(), "Demo-Broker");
  assert.deepEqual(choice.options.map((o) => [o.account.id, o.block]), [["acct-1", undefined]]);
  assert.equal(newOrderForm("buy", "m-EURUSD").accountId, null, "even a single eligible account must be chosen explicitly");
  assert.match(choice.note!, /Real accounts on Demo-Broker are read-only while Real-account trading is off \(1\)/);
  const elsewhere = orderAccounts([A, OTHER], ON, new Map(), "Third-Broker");
  assert.deepEqual(elsewhere.options, []);
  assert.match(elsewhere.note!, /No demo account on Third-Broker can trade here/);
  // The Trading page's New order offers every demo account; the market follows the account chosen.
  assert.deepEqual(orderAccounts([OTHER, real, A], ON, new Map()).options.map((o) => o.account.id), ["acct-3", "acct-1"]);
});

test("with Real-account trading on, real accounts are offered and set up with EnableRealTrading; Demo trading is not their switch", () => {
  const REAL_ON = { ...ON, enabled: false, realAccounts: true };
  const chart = { terminalId: "t", connected: true, executorEnabled: true, ready: true, maxLots: "0.5" };
  const unset = account("acct-8", "Demo-Broker", { demo: false, executor: { state: "real-account", terminalId: null }, sources: [{ ...chart, executorEnabled: false }] });
  const ready = account("acct-9", "Demo-Broker", { demo: false, executor: { state: "ready", terminalId: "t" }, sources: [chart] });
  assert.match(actionBlock(ready, ON, new Map())!.text, /read-only while Real-account trading is off/);
  assert.equal(actionBlock(ready, REAL_ON, new Map()), undefined);
  assert.match(actionBlock(unset, REAL_ON, new Map())!.text, /EnableRealTrading set to true/);
  assert.match(actionBlock(account("m", "Demo-Broker", { demo: false, executor: { state: "multiple", terminalId: null } }), REAL_ON, new Map())!.text, /More than one chart of this account has EnableRealTrading/);
  // Demo trading off blocks the demo account, not the real ones.
  const choice = orderAccounts([A, unset, ready], REAL_ON, new Map(), "Demo-Broker");
  assert.deepEqual(choice.options.map((o) => [o.account.id, o.block?.kind]), [["acct-1", "off"], ["acct-8", "executor"], ["acct-9", undefined]]);
  assert.doesNotMatch(choice.note!, /read-only/);

  const guide = executorGuide(unset, REAL_ON);
  assert.equal(guide.state, "zero");
  assert.equal(guide.title, "No chart has EnableRealTrading on.");
  assert.match(guide.steps[1].text, /EnableRealTrading/);
  assert.deepEqual([guide.steps[3].text, guide.steps[3].done], ["Switch on Real-account trading in the app window's Settings › Trading.", true]);
  assert.equal(executorGuide(ready, REAL_ON).title, "Ready to trade with real money.");
  assert.equal(executorGuide(ready, ON).state, "real");
});

test("a demo account that cannot trade now says why under the list, as its option cannot be chosen", () => {
  const unset = account("acct-5", "Demo-Broker", { executor: { state: "zero", terminalId: null } });
  const choice = orderAccounts([unset], ON, new Map(), "Demo-Broker");
  assert.equal(choice.options[0]!.block?.kind, "executor");
  const why = "Demo-Broker · acct-5: No chart of this account can trade: its EA is older than 1.13 and has EnableDemoTrading off. Update the EA with Recompile on the Terminals page.";
  assert.equal(choice.note, why);
  assert.equal(orderAccounts([unset, A], ON, new Map(), "Demo-Broker").note, why);
  assert.equal(orderAccounts([A], ON, new Map(), "Demo-Broker").note, undefined);
});

test("times follow Time shown: the broker's clock where MetaTrader stamps one, else UTC labelled as such", () => {
  const iso = "2027-01-15T08:00:00.000Z";
  assert.equal(shownTime(iso, "2027-01-15T10:00:00", "broker"), "2027-01-15 10:00");
  assert.equal(shownTime(iso, null, "broker"), "2027-01-15 08:00 UTC");
  assert.equal(shownTime(iso, "2027-01-15T10:00:00", "utc"), "2027-01-15 08:00");
  const local = new Date(Date.parse(iso) - new Date(iso).getTimezoneOffset() * 60_000).toISOString().slice(0, 16).replace("T", " ");
  assert.equal(shownTime(iso, null, "local"), local);
  assert.equal(shownTime(null, null, "utc"), "—");
});

const PLACE: OrderForm = { kind: "place", accountId: "acct-1", marketId: "m-EURUSD", side: "buy", type: "market", lots: "0.10", price: "", expiry: "", stops: "prices", stopLoss: "", takeProfit: "", stopLossPoints: "", takeProfitPoints: "", lossBy: "amount", loss: "", rewardRatio: "" };

test("a new order needs an explicit account and lots; its body names the account and exact market", () => {
  assert.deepEqual(requestBody({ ...PLACE, accountId: null }), { error: "Choose the account to trade on." });
  assert.deepEqual(requestBody({ ...PLACE, lots: " " }), { error: "Enter the lots." });
  assert.deepEqual(requestBody(PLACE), { body: { accountId: "acct-1", action: "place", marketId: "m-EURUSD", side: "buy", type: "market", lots: "0.10" } });
  assert.deepEqual(requestBody({ ...PLACE, type: "limit" }), { error: "A limit order needs its price." });
  assert.deepEqual(requestBody({ ...PLACE, type: "stop", price: "1.2", expiry: "2027-01-15T10:30", stopLoss: "1.19", takeProfit: "1.25" }), {
    body: { accountId: "acct-1", action: "place", marketId: "m-EURUSD", side: "buy", type: "stop", lots: "0.10", price: "1.2", expiry: new Date("2027-01-15T10:30").toISOString().replace(".000Z", "Z"), stopLoss: "1.19", takeProfit: "1.25" },
  });
});

test("a risk plan replaces absolute stops: loss by amount, balance percent or points, with a reward ratio", () => {
  const risk = { ...PLACE, stops: "risk" as const, stopLoss: "1.0", loss: "1.5", lossBy: "balancePercent" as const, rewardRatio: "2" };
  assert.deepEqual(requestBody(risk), { body: { accountId: "acct-1", action: "place", marketId: "m-EURUSD", side: "buy", type: "market", lots: "0.10", risk: { loss: { balancePercent: "1.5" }, rewardRatio: "2" } } });
  assert.deepEqual(requestBody({ ...risk, loss: "" }), { error: "Enter the loss and the reward ratio of the risk plan." });
});

test("modify sends only what changed; an emptied stop clears it; nothing changed asks for a change", () => {
  const modify: OrderForm = { kind: "modify", accountId: "acct-2", ticket: "11", pending: false, price: "", stopLoss: "1.09", takeProfit: "", expiry: "", original: { price: "", stopLoss: "1.09", takeProfit: "", expiry: "" } };
  assert.deepEqual(requestBody(modify), { error: "Change a value first." });
  assert.deepEqual(requestBody({ ...modify, stopLoss: "" }), { body: { accountId: "acct-2", action: "modify", ticket: "11", stopLoss: null } });
  assert.deepEqual(requestBody({ ...modify, takeProfit: "1.2" }), { body: { accountId: "acct-2", action: "modify", ticket: "11", takeProfit: "1.2" } });
  assert.deepEqual(requestBody({ kind: "close", accountId: "acct-2", ticket: "11" }), { body: { accountId: "acct-2", action: "close", ticket: "11" } });
});

test("a preview holds only for the inputs, account, executor and settings it was made with", () => {
  const key = previewKey(PLACE, A, ON, new Map());
  assert.equal(previewKey({ ...PLACE }, { ...A }, { ...ON }, new Map()), key);
  assert.notEqual(previewKey({ ...PLACE, accountId: "acct-2" }, B, ON, new Map()), key, "another account");
  assert.notEqual(previewKey({ ...PLACE, lots: "0.11" }, A, ON, new Map()), key, "changed input");
  assert.notEqual(previewKey(PLACE, A, { ...ON, maxLots: "0.5" }, new Map()), key, "app cap");
  assert.notEqual(previewKey(PLACE, A, { ...ON, slippage: 30 }, new Map()), key, "slippage");
  assert.notEqual(previewKey(PLACE, A, { ...ON, enabled: false }, new Map()), key, "trading off");
  assert.notEqual(previewKey(PLACE, { ...A, executor: { state: "ready", terminalId: "mt4-bbbbbbbbbbbb" } }, ON, new Map()), key, "another trading chart");
  assert.notEqual(previewKey(PLACE, { ...A, sources: [{ ...A.sources[0], maxLots: "0.2" }] }, ON, new Map()), key, "EA cap");
});

test("a preview of an existing trade holds only while that trade is unchanged, not for live price or profit", () => {
  const close: OrderForm = { kind: "close", accountId: "acct-1", ticket: "11" };
  const trade = position("acct-1", "11");
  const positions = new Map([["acct-1", [trade]], ["acct-2", [position("acct-2", "21")]]]);
  assert.equal(currentTrade(positions, new Map([["acct-1", [pending("acct-1", "21")]]]), "acct-1", "11"), trade);
  assert.equal(currentTrade(positions, new Map(), "acct-1", "21"), null, "a ticket is looked up within its own account only");
  const key = previewKey(close, A, ON, new Map(), trade);
  assert.equal(previewKey(close, A, ON, new Map(), { ...trade, currentPrice: "1.2", profit: "50", swap: "-1" }), key);
  assert.notEqual(previewKey(close, A, ON, new Map(), { ...trade, stopLoss: "1.08" }), key, "stop loss changed in MetaTrader");
  assert.notEqual(previewKey(close, A, ON, new Map(), { ...trade, lots: "0.2" }), key, "lots changed");
  assert.notEqual(previewKey(close, A, ON, new Map(), null), key, "the trade is gone");
  const order = pending("acct-1", "21");
  const cancel = previewKey({ kind: "cancel", accountId: "acct-1", ticket: "21" }, A, ON, new Map(), order);
  assert.notEqual(previewKey({ kind: "cancel", accountId: "acct-1", ticket: "21" }, A, ON, new Map(), { ...order, price: "1.07" }), cancel, "entry moved");
  assert.notEqual(previewKey({ kind: "cancel", accountId: "acct-1", ticket: "21" }, A, ON, new Map(), { ...order, expiry: "2027-01-16T00:00:00.000Z" }), cancel, "expiry set");
});

test("the countdown runs from when the preview arrived, whatever the PC's clock says", () => {
  const preview = { createdAt: "2027-01-15T08:00:00.000Z", expiresAt: "2027-01-15T08:00:30.000Z" };
  assert.equal(secondsLeft(preview, 1000, 1000), 30);
  assert.equal(secondsLeft(preview, 1000, 11_500), 20);
  assert.equal(secondsLeft(preview, 1000, 40_000), 0);
});

test("Enter in the dialog previews; it never executes, before or after a preview", () => {
  for (const stage of ["editing", "previewed", "executing", "sent"] as const) assert.notEqual(enterKeyAction(stage), "execute");
  assert.equal(enterKeyAction("editing"), "preview");
  assert.equal(enterKeyAction("sent"), "none");
});

test("the setup checklist tells zero, one ready, one not ready and several trading charts apart, and explains the caps", () => {
  const zero = executorGuide(account("z", "Demo-Broker", { executor: { state: "zero", terminalId: null }, sources: [{ terminalId: "t", connected: true, executorEnabled: false, ready: true, maxLots: "0.5" }] }), ON);
  assert.equal(zero.state, "zero");
  // A demo account has no chart input to set: open a chart, allow AutoTrading, switch Demo trading on.
  assert.deepEqual(zero.steps.map((s) => s.done), [true, false, true]);
  assert.ok(zero.steps.every((s) => !/EnableDemoTrading|EnableRealTrading/.test(s.text)));
  const ready = executorGuide(A, ON);
  assert.equal(ready.state, "ready");
  assert.ok(ready.steps.every((s) => s.done));
  assert.match(ready.caps, /smallest of the broker's maximum, the EA's cap \(0\.5 lots\) and the app's cap \(1\.0 lots\)/);
  assert.match(ready.caps, /never changes/);
  const notReady = executorGuide(account("n", "Demo-Broker", { executor: { state: "not-ready", terminalId: "t" } }), { ...ON, enabled: false });
  assert.equal(notReady.state, "not-ready");
  assert.deepEqual(notReady.steps.map((s) => s.done), [true, false, false]);
  assert.match(notReady.steps[1].text, /AutoTrading/);
  const multiple = executorGuide(account("m", "Demo-Broker", { demo: false, executor: { state: "multiple", terminalId: null } }), { ...ON, realAccounts: true });
  assert.equal(multiple.title, "More than one chart has EnableRealTrading on.");
  assert.equal(executorGuide(account("r", "R", { demo: false, executor: { state: "real-account", terminalId: null } }), ON).state, "real");
  assert.match(executorGuide(account("u", "Demo-Broker", { sources: [{ ...A.sources[0], maxLots: null }] }), ON).caps, /upgrade the EA/);
});

test("a request's status: Reviewed keeps the unknown outcome underneath", () => {
  assert.deepEqual(requestStatus(request("r", "a", "unknown")), { text: "Unknown", tone: "warn" });
  assert.deepEqual(requestStatus(request("r", "a", "unknown", true)), { text: "Reviewed (outcome unknown)", tone: "neutral" });
  assert.deepEqual(requestStatus(request("r", "a", "succeeded")), { text: "Succeeded", tone: "good" });
  assert.deepEqual(requestStatus(request("r", "a", "failed")), { text: "Failed", tone: "bad" });
  assert.deepEqual(requestStatus(request("r", "a", "dispatching")), { text: "Sending", tone: "neutral" });
});

test("a review needs the MetaTrader check acknowledged and a note of 8 to 500 characters", () => {
  assert.match(reviewError("Checked MT4 orders", false)!, /Confirm/);
  assert.match(reviewError("short", true)!, /8/);
  assert.match(reviewError("x".repeat(501), true)!, /500/);
  assert.equal(reviewError("  Checked MT4 orders  ", true), undefined);
});

test("filters change only which accounts show; unresolved banners name every blocked account regardless", () => {
  const groups = accountGroups([OTHER, B, A], { brokerServer: "Demo-Broker", accountId: "all" });
  assert.deepEqual(groups.map((g) => [g.brokerServer, g.accounts.map((a) => a.id)]), [["Demo-Broker", ["acct-1", "acct-2"]]]);
  assert.deepEqual(accountGroups([OTHER, B, A], { brokerServer: "all", accountId: "acct-2" }).map((g) => g.accounts.map((a) => a.id)), [["acct-2"]]);
  assert.deepEqual(accountGroups([OTHER, A], { brokerServer: "all", accountId: "all" }).map((g) => g.brokerServer), ["Demo-Broker", "Other-Broker"]);
  const banners = unresolvedBanners([A, B, OTHER], unresolvedByAccount([request("r9", "acct-3", "unknown")]));
  assert.deepEqual(banners.map((b) => [b.accountId, b.request.requestId]), [["acct-3", "r9"]]);
});

test("a new order without a symbol asks for one rather than sending an empty market", () => {
  assert.deepEqual(requestBody({ ...PLACE, marketId: "" }), { error: "Choose the symbol." });
});

test("money shows two decimals with the account's currency; unavailable is a dash, never zero", () => {
  assert.equal(money("361.4666666667", "EUR"), "361.47 EUR");
  assert.equal(money("10000", "USD"), "10000.00 USD");
  assert.equal(money("-1.005", null), "-1.01");
  assert.equal(money(null, "USD"), "—");
});

test("an account not yet known to be demo cannot trade, and going offline or blocked invalidates a preview", () => {
  const unknown = account("acct-5", "Demo-Broker", { demo: null });
  assert.match(actionBlock(unknown, ON, new Map())!.text, /not known yet whether/);
  assert.deepEqual(orderAccounts([unknown, A], ON, new Map(), "Demo-Broker").options.map((o) => o.account.id), ["acct-1"]);
  const none = new Map();
  const key = previewKey(PLACE, A, ON, none);
  assert.notEqual(previewKey(PLACE, { ...A, connected: false }, ON, none), key, "offline");
  assert.notEqual(previewKey(PLACE, A, ON, unresolvedByAccount([request("r", "acct-1", "dispatching")])), key, "an unresolved request from elsewhere");
  assert.equal(previewKey(PLACE, A, ON, unresolvedByAccount([request("r", "acct-2", "dispatching")])), key, "another account's request does not matter");
});

test("an intent reads the same in the preview, the journal and the review", () => {
  assert.equal(describeIntent({ action: "place", ticket: null, symbol: "EURUSD", side: "buy", type: "market", lots: "0.1", price: "1.1", stopLoss: null, takeProfit: null, expiry: null, slippage: 20 }), "Buy at market 0.1 lots EURUSD");
  assert.equal(describeIntent({ action: "place", ticket: null, symbol: "EURUSD", side: "sell", type: "limit", lots: "0.1", price: "1.1", stopLoss: null, takeProfit: null, expiry: null, slippage: 20 }), "Sell limit 0.1 lots EURUSD");
  assert.equal(describeIntent({ action: "close", ticket: "12", symbol: "EURUSD", side: "buy", type: "market", lots: "0.1", price: "1.1", stopLoss: null, takeProfit: null, expiry: null, slippage: 20 }), "Close #12 EURUSD");
});

test("unresolved banners also name a journal account that is not listed", () => {
  const banners = unresolvedBanners([A], unresolvedByAccount([request("r1", "acct-gone", "unknown")]));
  assert.deepEqual(banners.map((b) => [b.accountId, b.label]), [["acct-gone", "Account acct-gon…"]]);
});

const QUOTE_NOW = 1_800_000_000_000;
const quoteFeed = (overrides: Partial<FeedSnapshot> = {}): FeedSnapshot => ({
  feed: "mt4-aaaaaaaaaaaa|Demo-Broker|EURUSD", terminal: "mt4-aaaaaaaaaaaa", broker: "Demo-Broker", symbol: "EURUSD", market: { brokerServer: "Demo-Broker", symbol: "EURUSD" },
  timeframe: 60, chartTimeframes: [60], online: true, instances: 1, digits: 5, interval: 500, quoteStatus: "ok", quoteUnchangedSince: QUOTE_NOW - 1000, stale: false,
  latest: { seq: 7, bid: 1.08421, ask: 1.08433, quoteTime: 1_800_000_000, sampledTime: 1_800_000_001 }, quoteTimeUtc: QUOTE_NOW - 1000, quoteReceivedAt: QUOTE_NOW - 500,
  clockRule: null, recording: false, lastSeen: QUOTE_NOW - 500, dropped: 0, samplesAcceptedAt: QUOTE_NOW - 500, samplesMissing: false, ...overrides,
});
const EURUSD = { brokerServer: "Demo-Broker", symbol: "EURUSD" };

test("a market order shows the exact market's Ask and Bid at its digits, the side's price emphasised", () => {
  const other = quoteFeed({ feed: "x", broker: "Other-Broker", market: { brokerServer: "Other-Broker", symbol: "EURUSD" }, latest: { seq: 1, bid: 2, ask: 3, quoteTime: 0, sampledTime: 0 } });
  const buy = marketQuote([other, quoteFeed()], EURUSD, "buy", true, QUOTE_NOW);
  assert.deepEqual(buy, { quote: { bid: 1.08421, ask: 1.08433, digits: 5 }, emphasis: "ask" });
  assert.equal(marketQuote([quoteFeed()], EURUSD, "sell", true, QUOTE_NOW).emphasis, "bid");
});

test("without a live quote the dialog gives the reason, never zero or a stale number shown as live", () => {
  const reason = (feeds: FeedSnapshot[], connected = true) => {
    const q = marketQuote(feeds, EURUSD, "buy", connected, QUOTE_NOW);
    assert.equal(q.quote, undefined);
    return q.reason;
  };
  assert.equal(reason([]), "No feed for this market");
  assert.equal(reason([quoteFeed({ latest: undefined, quoteStatus: "no-quote" })]), "No valid quote");
  assert.equal(reason([quoteFeed({ stale: true, quoteUnchangedSince: QUOTE_NOW - 42_000 })]), "Quote unchanged for 42 s");
  assert.equal(reason([quoteFeed({ samplesMissing: true })]), "No quotes received");
  assert.equal(reason([quoteFeed({ online: false, lastSeen: QUOTE_NOW - 120_000 })]), "Offline, last heard 2 min ago");
  assert.equal(reason([quoteFeed()], false), "Not connected to the app");
});

test("of a market's several feeds, a live one gives the quote", () => {
  const stale = quoteFeed({ feed: "a", stale: true, latest: { seq: 1, bid: 1.07, ask: 1.071, quoteTime: 0, sampledTime: 0 } });
  const offline = quoteFeed({ feed: "b", online: false, latest: { seq: 1, bid: 1.06, ask: 1.061, quoteTime: 0, sampledTime: 0 } });
  assert.equal(marketQuote([stale, offline, quoteFeed()], EURUSD, "sell", true, QUOTE_NOW).quote?.bid, 1.08421);
  assert.equal(marketQuote([offline, stale], EURUSD, "sell", true, QUOTE_NOW).reason, "Quote unchanged for 1 s");
});

test("each snapshot of the quote stream updates the dialog's Ask and Bid", () => {
  const socket: LiveSocket = { onopen: null, onmessage: null, onclose: null, onerror: null, send: () => {}, close: () => {} };
  const shown: (number | undefined)[] = [];
  const client = new LiveClient<{ time: number; feeds: FeedSnapshot[] }>({
    open: () => socket,
    onSnapshot: (s) => {
      shown.push(marketQuote(s.feeds, EURUSD, "buy", true, s.time).quote?.ask);
    },
    onStatus: () => {},
    sessionValid: async () => true,
  });
  client.start();
  socket.onopen?.();
  for (const ask of [1.08433, 1.08441]) {
    socket.onmessage?.({ data: JSON.stringify({ time: QUOTE_NOW, feeds: [quoteFeed({ latest: { seq: 8, bid: ask - 0.00012, ask, quoteTime: 0, sampledTime: 0 } })] }) });
  }
  client.stop();
  assert.deepEqual(shown, [1.08433, 1.08441]);
});

test("of two live feeds of the market, the newest broker quote gives the price, whatever their order", () => {
  const older = quoteFeed({ feed: "a", terminal: "mt4-aaaaaaaaaaaa", latest: { seq: 1, bid: 1.07, ask: 1.071, quoteTime: 1_799_999_990, sampledTime: 0 } });
  const newer = quoteFeed({ feed: "b", terminal: "mt4-bbbbbbbbbbbb", latest: { seq: 1, bid: 1.09, ask: 1.091, quoteTime: 1_800_000_000, sampledTime: 0 } });
  assert.equal(marketQuote([older, newer], EURUSD, "buy", true, QUOTE_NOW).quote?.ask, 1.091);
  assert.equal(marketQuote([newer, older], EURUSD, "buy", true, QUOTE_NOW).quote?.ask, 1.091);
});

test("a source silent for 5 s or more says so beside its price, apart from the quote's age", () => {
  assert.equal(marketQuote([quoteFeed({ quoteReceivedAt: QUOTE_NOW - 4000 })], EURUSD, "buy", true, QUOTE_NOW).silence, undefined);
  const silent = marketQuote([quoteFeed({ quoteReceivedAt: QUOTE_NOW - 7000 })], EURUSD, "buy", true, QUOTE_NOW);
  assert.equal(silent.quote?.ask, 1.08433);
  assert.equal(silent.silence, "No new quote for 7 s");
});

test("stop distances go to the preview as points from the entry; empty ones are left out", () => {
  const distance = { ...PLACE, stops: "distance" as const, stopLoss: "1.09", stopLossPoints: " 200 ", takeProfitPoints: "" };
  assert.deepEqual(requestBody(distance), { body: { accountId: "acct-1", action: "place", marketId: "m-EURUSD", side: "buy", type: "market", lots: "0.10", distance: { stopLoss: "200" } } });
  assert.equal("distance" in (requestBody({ ...distance, stopLossPoints: "" }) as { body: object }).body, false);
});

const EURUSD_DEFAULTS: OrderDefaults = { brokerServer: "Demo-Broker", symbol: "EURUSD", lots: "0.2", stopLossPoints: "200", takeProfitPoints: "400" };
const BTC_DEFAULTS: OrderDefaults = { brokerServer: "Demo-Broker", symbol: "BTCUSD", lots: "0.01", stopLossPoints: null, takeProfitPoints: null };

test("a market's order defaults fill lots and stop distances as the dialog opens on it; the account is still never chosen", () => {
  const form = withOrderDefaults(newOrderForm("sell", "m-EURUSD"), undefined, EURUSD_DEFAULTS);
  assert.deepEqual([form.accountId, form.lots, form.stops, form.stopLossPoints, form.takeProfitPoints], [null, "0.2", "distance", "200", "400"]);
  assert.deepEqual(withOrderDefaults(newOrderForm("buy"), undefined, undefined), newOrderForm("buy"), "no defaults: empty as before");
  const lotsOnly = withOrderDefaults(newOrderForm("buy"), undefined, BTC_DEFAULTS);
  assert.deepEqual([lotsOnly.lots, lotsOnly.stops, lotsOnly.stopLossPoints], ["0.01", "prices", ""]);
});

test("choosing another market replaces the previous market's defaults but keeps what the trader typed", () => {
  const opened = withOrderDefaults(newOrderForm("buy"), undefined, EURUSD_DEFAULTS);
  const switched = withOrderDefaults(opened, EURUSD_DEFAULTS, BTC_DEFAULTS);
  assert.deepEqual([switched.lots, switched.stopLossPoints, switched.takeProfitPoints], ["0.01", "", ""]);
  const typed = withOrderDefaults({ ...opened, lots: "0.3", stopLossPoints: "150" }, EURUSD_DEFAULTS, undefined);
  assert.deepEqual([typed.lots, typed.stopLossPoints, typed.takeProfitPoints], ["0.3", "150", ""]);
});

test("a market's defaults never overwrite what the trader typed, nor the stops they chose", () => {
  const typed = withOrderDefaults({ ...newOrderForm("buy"), lots: "0.5" }, undefined, EURUSD_DEFAULTS);
  assert.deepEqual([typed.lots, typed.stopLossPoints, typed.stops], ["0.5", "200", "distance"]);
  const risk = withOrderDefaults({ ...newOrderForm("buy"), stops: "risk", loss: "10", rewardRatio: "2" }, undefined, EURUSD_DEFAULTS);
  assert.equal(risk.stops, "risk", "a chosen risk plan stays");
  const prices = withOrderDefaults({ ...newOrderForm("buy"), stopLoss: "1.09" }, undefined, EURUSD_DEFAULTS);
  assert.equal(prices.stops, "prices", "a typed stop price stays");
});

test("a default above the lot cap is sent as it is, so Preview refuses it like a typed value", () => {
  const form = withOrderDefaults({ ...PLACE, lots: "" }, undefined, { ...EURUSD_DEFAULTS, lots: "5" });
  assert.equal((requestBody(form) as { body: { lots: string } }).body.lots, "5");
});
