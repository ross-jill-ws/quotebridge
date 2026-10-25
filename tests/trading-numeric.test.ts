import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccountOrder } from "../src/server/bridge/account-protocol.js";
import { marketId } from "../src/server/identity/index.js";
import { revalidateTrade, validateTrade } from "../src/server/trading/numeric.js";
import { TradingError, type TradeInput, type TradingPreview, type ValidationContext } from "../src/server/trading/types.js";

const NOW = Date.parse("2026-01-15T12:00:00Z");
function context(): ValidationContext {
  const binding = { accountId: "demo-account", session: "session", terminalId: "terminal", brokerServer: "Example-Demo", login: "12345" };
  return {
    now: NOW, clockRule: { winterOffsetMinutes: 120, dst: "us" },
    settings: { enabled: true, maxLots: "1.0", slippage: 20 }, eaMaxLots: "2.0",
    account: {
      id: binding.accountId, brokerServer: binding.brokerServer, login: binding.login, label: "Demo fixture",
      connected: true, demo: true, ready: true, state: "fresh",
      funds: { balance: "10000", equity: "10000", margin: "0", freeMargin: "10000", profit: "0", marginLevel: null, currency: "USD", leverage: 100 },
      positions: [], orders: [], source: { ...binding, capturedBrokerTime: 1768485600, receivedAt: NOW },
      sources: [{ ...binding, enabled: true, ready: true, connected: true, maxLots: "2" }],
    },
    contract: {
      accountId: binding.accountId, market: { brokerServer: binding.brokerServer, symbol: "EURUSD" }, source: { ...binding, receivedAt: NOW },
      conditions: {
        type: "conditions", session: binding.session, request: "request", login: binding.login, symbol: "EURUSD",
        bid: "1.10000", ask: "1.10020", digits: 5, point: "0.00001", tickSize: "0.00001",
        minLots: "0.01", maxLots: "100", lotStep: "0.01", stopLevel: 10, freezeLevel: 0, tradeAllowed: true,
        quoteTime: 1768485600, tickValue: "1", contractSize: "100000", marginRequired: "1000",
        swapLong: "0", swapShort: "0", swapType: 0, profitCurrency: "USD", starting: 0, expiration: 0,
      },
    },
  };
}
const buy = (extra: Partial<Extract<TradeInput, { action: "new" }>> = {}): Extract<TradeInput, { action: "new" }> => ({
  action: "new", accountId: "demo-account", symbol: "EURUSD", side: "buy", type: "market", lots: "0.10", ...extra,
});

function rejects(input: unknown, ctx = context(), code?: string) {
  assert.throws(() => validateTrade(input as TradeInput, ctx), (error: unknown) => error instanceof TradingError && (!code || error.code === code));
}

test("runtime new-order schema rejects ambiguous values and unsupported fields", () => {
  for (const input of [null, [], {}, { ...buy(), lots: undefined }, { ...buy(), lots: 0.1 },
    { ...buy(), side: "BUY" }, { ...buy(), type: "instant" }, { ...buy(), partial: true },
    { ...buy(), type: ["limit"], price: "1.101" }, { ...buy(), type: { toString: () => "limit" }, price: "1.101" },
    { ...buy(), price: "1.1" }, { ...buy(), expiry: "2026-01-16T00:00:00Z" },
    { ...buy(), stopLoss: null }, { ...buy(), stopLoss: "0" }, { ...buy(), takeProfit: "0.0000" },
    { ...buy(), risk: { loss: { amount: "10" }, rewardRatio: "2" }, stopLoss: "1.09" },
    ...["1e-1", " 0.1", "+0.1", "-0.1", ".1", "01", "1.", "NaN", "Infinity", "0.12345678901", "1000000000000000", "0"].map((lots) => ({ ...buy(), lots }))]) rejects(input);
});

test("new volume obeys exact tick/lot grids and the minimum of all caps", () => {
  for (const lots of ["0.001", "0.015", "1.01"]) rejects(buy({ lots }));
  const ctx = context();
  ctx.eaMaxLots = "0.25"; ctx.account.sources[0].maxLots = "0.25";
  assert.equal(validateTrade(buy({ lots: "0.25" }), ctx).limits.maxLots, "0.25");
  rejects(buy({ lots: "0.26" }), ctx);
  ctx.contract.conditions.maxLots = "0.2";
  rejects(buy({ lots: "0.25" }), ctx);
  ctx.contract.conditions.tickSize = "0.00005";
  rejects(buy({ stopLoss: "1.09901" }), ctx);
  assert.equal(validateTrade(buy({ stopLoss: "1.09905" }), ctx).intent.stopLoss, "1.09905");
});

test("every mutation needs a fresh demo-ready executor, same-account contract and broker-clock quote", () => {
  const changes: ((ctx: ValidationContext) => void)[] = [
    (c) => { c.settings.enabled = false; }, (c) => { c.account.demo = false; },
    (c) => { c.account.ready = false; }, (c) => { c.account.connected = false; },
    (c) => { c.account.state = "stale"; }, (c) => { c.account.source = null; },
    (c) => { c.account.sources = []; }, (c) => { c.account.sources.push({ ...c.account.sources[0], session: "other" }); },
    (c) => { c.account.sources[0].ready = false; }, (c) => { c.account.sources[0].enabled = false; },
    (c) => { c.account.source!.receivedAt -= 5001; }, (c) => { c.contract.source.receivedAt -= 5001; },
    (c) => { c.contract.source.receivedAt++; }, (c) => { c.account.source!.receivedAt = NaN; },
    (c) => { c.contract.source.session = "other"; }, (c) => { c.contract.source.login = "54321"; },
    (c) => { c.contract.accountId = "other"; }, (c) => { c.contract.market.brokerServer = "Other-Demo"; },
    (c) => { c.contract.market.symbol = "OTHER"; }, (c) => { c.contract.conditions.symbol = "OTHER"; },
    (c) => { c.contract.conditions.login = "54321"; }, (c) => { c.contract.conditions.session = "other"; },
    (c) => { c.contract.conditions.tradeAllowed = false; }, (c) => { c.clockRule = null; },
    (c) => { c.contract.conditions.quoteTime -= 31; }, (c) => { c.contract.conditions.quoteTime += 6; },
    (c) => { c.contract.conditions.ask = "1.09"; }, (c) => { c.settings.slippage = 0.5; },
  ];
  for (const change of changes) { const ctx = context(); change(ctx); rejects(buy(), ctx); }
  const ctx = context();
  ctx.account.source!.receivedAt -= 5000; ctx.contract.source.receivedAt -= 5000;
  ctx.contract.conditions.quoteTime -= 30;
  assert.equal(validateTrade(buy(), ctx).intent.price, "1.1002");
  ctx.contract.conditions.quoteTime += 35;
  assert.equal(validateTrade(buy(), ctx).intent.price, "1.1002");
});

test("new orders require known positive margin cost and strictly sufficient free margin", () => {
  const ctx = context();
  ctx.account.funds.freeMargin = "100";
  rejects(buy(), ctx);
  ctx.account.funds.freeMargin = "100.0000000001";
  assert.equal(validateTrade(buy(), ctx).intent.lots, "0.1");
  for (const margin of ["0", "-1", "NaN"]) { ctx.contract.conditions.marginRequired = margin; rejects(buy(), ctx); }
});

test("stops respect the closing side of the spread and exact broker stop boundaries", () => {
  assert.equal(validateTrade(buy({ stopLoss: "1.0999", takeProfit: "1.1001" }), context()).intent.stopLoss, "1.0999");
  for (const stopLoss of ["1.09991", "1.1", "1.1002"]) rejects(buy({ stopLoss }));
  for (const takeProfit of ["1.10009", "1.1", "1.099"]) rejects(buy({ takeProfit }));
  assert.equal(validateTrade(buy({ side: "sell", stopLoss: "1.1003", takeProfit: "1.1001" }), context()).intent.kind, 1);
  rejects(buy({ side: "sell", stopLoss: "1.10029" }));
  rejects(buy({ side: "sell", takeProfit: "1.10011" }));
  const ctx = context(); ctx.contract.conditions.stopLevel = 0;
  rejects(buy({ stopLoss: "1.1" }), ctx);
});

test("pending types use their correct quote side, entry-relative stops and UTC expiry", () => {
  const ctx = context();
  const cases = [
    { side: "buy", type: "limit", price: "1.1001", stopLoss: "1.1", takeProfit: "1.1002", kind: 2 },
    { side: "sell", type: "limit", price: "1.1001", stopLoss: "1.1002", takeProfit: "1.1", kind: 3 },
    { side: "buy", type: "stop", price: "1.1003", stopLoss: "1.1002", takeProfit: "1.1004", kind: 4 },
    { side: "sell", type: "stop", price: "1.0999", stopLoss: "1.1", takeProfit: "1.0998", kind: 5 },
  ] as const;
  for (const { kind, ...fields } of cases) assert.equal(validateTrade(buy(fields), ctx).intent.kind, kind);
  for (const fields of [
    { type: "limit", price: "1.10011" }, { type: "stop", price: "1.10029" },
    { type: "limit", price: "1.101" }, { type: "stop", price: "1.099" },
  ] as const) rejects(buy(fields), ctx);
  const pending = buy({ type: "limit", price: "1.09", expiry: "2026-01-15T13:00:00+00:00" });
  assert.deepEqual({ expiry: validateTrade(pending, ctx).intent.expiry, broker: validateTrade(pending, ctx).intent.brokerExpiry },
    { expiry: "2026-01-15T13:00:00.000Z", broker: 1768489200 });
  // July uses the US summer offset (+3), not January's +2.
  assert.equal(validateTrade({ ...pending, expiry: "2026-07-01T12:00:00Z" }, ctx).intent.brokerExpiry, 1782918000);
  for (const expiry of ["2026-01-15T12:00:00Z", "2026-02-30T13:00:00Z", "2026-01-16", "2026-01-16T12:00:00", "2026-01-16T12:00:00+02:00", "2026-01-16T12:00:60Z", "2026-01-16T24:00:00Z", "2026-01-16T12:00:00.001Z", "0"]) rejects({ ...pending, expiry }, ctx);
});

function fractionalContract(): ValidationContext {
  const ctx = context();
  Object.assign(ctx.contract.conditions, { bid: "100", ask: "100.25", digits: 2, point: "0.01", tickSize: "0.25", lotStep: "0.05", minLots: "0.05", tickValue: "2.5" });
  return ctx;
}

test("risk amount, balance percentage and points round both stops toward entry on non-point ticks", () => {
  // 0.15 lots earns/loses USD 0.375 per 0.25 tick. USD 1 permits 2 2/3 ticks;
  // ratio 2 permits 5 1/3 reward ticks. Approve 2 loss ticks and 5 reward ticks.
  for (const loss of [{ amount: "1" }, { balancePercent: "0.01" }, { points: "66" }]) {
    for (const side of ["buy", "sell"] as const) {
      const result = validateTrade(buy({ side, lots: "0.15", risk: { loss, rewardRatio: "2" } }), fractionalContract());
      assert.deepEqual({ sl: result.intent.stopLoss, tp: result.intent.takeProfit, estimates: result.estimates }, side === "buy"
        ? { sl: "99.75", tp: "101.5", estimates: { loss: "0.75", reward: "1.875", currency: "USD" } }
        : { sl: "100.5", tp: "98.75", estimates: { loss: "0.75", reward: "1.875", currency: "USD" } });
    }
  }
});

test("risk never widens an unsatisfiable budget and rejects malformed or unavailable plans", () => {
  rejects(buy({ lots: "0.15", risk: { loss: { amount: "0.1" }, rewardRatio: "2" } }), fractionalContract());
  const risk = { loss: { amount: "10" }, rewardRatio: "2" };
  for (const bad of [null, {}, { ...risk, extra: true }, { loss: {}, rewardRatio: "2" },
    { loss: { amount: "10", points: "10" }, rewardRatio: "2" },
    { loss: { amount: "0" }, rewardRatio: "2" }, { loss: { balancePercent: "100.0000000001" }, rewardRatio: "2" },
    { loss: { points: "10" }, rewardRatio: "0" }, { loss: { amount: 10 }, rewardRatio: "2" },
    { ...risk, rewardRatio: "1e2" }]) rejects({ ...buy(), risk: bad });
  const ctx = context(); ctx.contract.conditions.tickValue = "0";
  rejects(buy({ risk }), ctx);
  const absolute = validateTrade(buy({ stopLoss: "1.09" }), ctx);
  assert.deepEqual(absolute.estimates, { loss: null, reward: null, currency: "USD" });
  assert.ok(validateTrade(buy(), context()).warnings.includes("No stop loss is set."));
  assert.ok(validateTrade(buy(), context()).warnings.includes("No take profit is set."));
});

test("risk arithmetic retains the final decimal at the 15-integer/10-fraction boundary", () => {
  const ctx = context();
  Object.assign(ctx.contract.conditions, { bid: "999999999999999.9999999997", ask: "999999999999999.9999999998", point: "0.0000000001", tickSize: "0.0000000001", digits: 10, stopLevel: 0, tickValue: "1" });
  const result = validateTrade(buy({ lots: "1", risk: { loss: { points: "2" }, rewardRatio: "0.5" } }), ctx);
  assert.equal(result.intent.stopLoss, "999999999999999.9999999996");
  assert.equal(result.intent.takeProfit, "999999999999999.9999999999");
  assert.deepEqual(result.estimates, { loss: "2", reward: "1", currency: "USD" });
  rejects(buy({ lots: "1", risk: { loss: { points: "2" }, rewardRatio: "1" } }), ctx);
});

function existing(ctx: ValidationContext, pending = false): AccountOrder {
  const order: AccountOrder = { ticket: "42", kind: pending ? 2 : 0, symbol: "EURUSD", lots: "7.1250", openPrice: pending ? "1.0900" : "1.1000",
    openTime: 1768399200, stopLoss: "1.0800", takeProfit: "1.1200", expiration: pending ? 1768489200 : 0,
    profit: "12", swap: "-1", commission: "-2", magic: 0, closePrice: "1.1000" };
  (pending ? ctx.account.orders : ctx.account.positions).push(order);
  return order;
}
const manage = <T extends "modify" | "close" | "cancel">(action: T) => ({ action, accountId: "demo-account", ticket: "42" });

test("external large trades can be modified or fully closed despite current new-volume limits and margin", () => {
  const ctx = context(); existing(ctx);
  Object.assign(ctx.contract.conditions, { minLots: "0.2", maxLots: "0.5", lotStep: "0.2", marginRequired: "0" });
  ctx.account.funds.freeMargin = "-100";
  for (const action of ["modify", "close"] as const) {
    const result = validateTrade(manage(action), ctx);
    assert.equal(result.intent.lots, "7.125");
    assert.equal(result.intent.price, "1.1");
    assert.deepEqual(result.target, { ticket: "42", kind: 0, symbol: "EURUSD", lots: "7.125", openPrice: "1.1", openTime: 1768399200, stopLoss: "1.08", takeProfit: "1.12", expiration: 0 });
    assert.ok(result.warnings.includes("This trade was created outside QuoteBridge."));
  }
  rejects(manage("cancel"), ctx);
  rejects({ ...manage("close"), accountId: "another-account" }, ctx);
  rejects({ ...manage("close"), ticket: "43" }, ctx);
  for (const bad of [{ ...manage("modify"), lots: "1" }, { ...manage("close"), lots: "1" },
    { ...manage("close"), partial: true }, { ...manage("close"), stopLoss: "1.09" },
    { ...manage("modify"), risk: { loss: { amount: "10" }, rewardRatio: "2" } },
    { ...manage("modify"), price: "1.1" }, { ...manage("modify"), expiry: null }]) rejects(bad, ctx);
});

test("modify omissions preserve stops/expiry while null alone clears them", () => {
  const ctx = context(); const order = existing(ctx, true);
  assert.equal(validateTrade(manage("modify"), ctx).intent.brokerExpiry, 1768489200);
  const changed = validateTrade({ ...manage("modify"), action: "modify", price: "1.0910", stopLoss: null, takeProfit: null, expiry: null }, ctx);
  assert.deepEqual(changed.intent, { action: "modify", accountId: "demo-account", ticket: "42", symbol: "EURUSD", kind: 2, lots: "7.125", price: "1.091", stopLoss: "0", takeProfit: "0", expiry: null, brokerExpiry: 0, slippage: 20 });
  assert.equal(order.expiration, 1768489200);
  assert.equal(validateTrade(manage("cancel"), ctx).intent.kind, 2);
  rejects(manage("close"), ctx);
  for (const field of ["stopLoss", "takeProfit", "expiry"]) for (const value of ["0", 0, undefined]) rejects({ ...manage("modify"), [field]: value }, ctx);
  assert.equal(validateTrade({ ...manage("modify"), action: "modify", expiry: "2026-01-15T14:00:00Z" }, ctx).intent.brokerExpiry, 1768492800);
  order.magic = 27012026;
  assert.ok(!validateTrade(manage("cancel"), ctx).warnings.includes("This trade was created outside QuoteBridge."));
});

test("freeze boundaries block existing stop/entry edits, closes and cancellations, not new placement", () => {
  for (const kind of [0, 1]) {
    for (const field of ["stopLoss", "takeProfit"] as const) {
      const ctx = context(); const order = existing(ctx); order.kind = kind;
      if (kind === 1) { order.stopLoss = "1.12"; order.takeProfit = "1.08"; }
      ctx.contract.conditions.freezeLevel = 20;
      order[field] = kind === 0 ? field === "stopLoss" ? "1.0998" : "1.1002" : field === "stopLoss" ? "1.1004" : "1.1";
      rejects(manage("close"), ctx, "frozen-target");
      rejects({ ...manage("modify"), [field]: null }, ctx, "frozen-target");
      order[field] = kind === 0 ? field === "stopLoss" ? "1.09979" : "1.10021" : field === "stopLoss" ? "1.10041" : "1.09999";
      assert.equal(validateTrade(manage("close"), ctx).intent.kind, kind);
    }
  }
  const ctx = context(); const order = existing(ctx, true);
  ctx.contract.conditions.freezeLevel = 20;
  order.openPrice = "1.1";
  rejects(manage("cancel"), ctx, "frozen-target");
  rejects({ ...manage("modify"), price: "1.09" }, ctx, "frozen-target");
  order.openPrice = "1.09999";
  assert.equal(validateTrade(manage("cancel"), ctx).intent.price, "1.09999");
  rejects({ ...manage("modify"), price: "1.1" }, ctx, "frozen-target");
  const market = context(); existing(market); market.contract.conditions.freezeLevel = 20;
  rejects({ ...manage("modify"), stopLoss: "1.0998" }, market, "frozen-target");
  assert.equal(validateTrade(buy({ stopLoss: "1.0998" }), market).intent.stopLoss, "1.0998");
});

function preview(input: TradeInput, ctx: ValidationContext): TradingPreview {
  return { ...validateTrade(input, ctx), id: "preview", createdAt: ctx.now, expiresAt: ctx.now + 30000,
    source: { ...ctx.account.source! }, marketId: marketId(ctx.contract.market.brokerServer, ctx.contract.market.symbol), settings: { ...ctx.settings } };
}
function rejectsRevalidation(p: TradingPreview, ctx: ValidationContext, code?: string) {
  assert.throws(() => revalidateTrade(p, ctx), (error: unknown) => error instanceof TradingError && (!code || error.code === code));
}
function freezeDeep(value: unknown) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
}

test("revalidation preserves the approved percentage-risk intent despite balance changes", () => {
  const ctx = context();
  const p = preview(buy({ risk: { loss: { balancePercent: "1" }, rewardRatio: "2" } }), ctx);
  const approved = structuredClone(p);
  ctx.account.funds.balance = "5000";
  freezeDeep(p); freezeDeep(ctx);
  assert.equal(revalidateTrade(p, ctx), undefined);
  assert.deepEqual(p, approved);
  assert.equal(p.intent.stopLoss, "1.0902");
  assert.equal(p.intent.takeProfit, "1.1202");
});

test("revalidation rejects expiry, settings/source/market changes and newly invalid quote/grid/stops/margin", () => {
  const changes: ((ctx: ValidationContext) => void)[] = [
    (c) => { c.now += 30000; c.account.source!.receivedAt = c.now; c.contract.source.receivedAt = c.now; c.contract.conditions.quoteTime += 30; },
    (c) => { c.settings.enabled = false; }, (c) => { c.settings.maxLots = "2"; }, (c) => { c.settings.slippage = 21; },
    (c) => { c.account.demo = false; }, (c) => { c.contract.conditions.quoteTime -= 31; },
    (c) => { c.contract.conditions.tickSize = "0.0003"; }, (c) => { c.contract.conditions.lotStep = "0.03"; },
    (c) => { c.contract.conditions.stopLevel = 200; }, (c) => { c.account.funds.freeMargin = "99"; },
    (c) => { c.contract.conditions.ask = "1.10041"; },
    (c) => { c.account.source!.session = "replacement"; c.contract.source.session = "replacement"; c.contract.conditions.session = "replacement"; c.account.sources[0].session = "replacement"; },
  ];
  for (const change of changes) {
    const ctx = context(); const p = preview(buy({ stopLoss: "1.099", takeProfit: "1.102" }), ctx);
    change(ctx); rejectsRevalidation(p, ctx);
  }
  const ctx = context(); const p = preview(buy(), ctx); p.marketId = marketId("Other-Demo", "EURUSD");
  rejectsRevalidation(p, ctx);
});

test("effective cap changes invalidate new approvals only when the approved cap changes", () => {
  const ctx = context(); const p = preview(buy(), ctx);
  ctx.contract.conditions.maxLots = "50";
  assert.equal(revalidateTrade(p, ctx), undefined); // Broker cap is still nonbinding.
  ctx.eaMaxLots = "0.75"; ctx.account.sources[0].maxLots = "0.75";
  rejectsRevalidation(p, ctx, "limits-changed"); // Still above lots, but changes the approved effective cap.
  const external = context(); existing(external); const close = preview(manage("close"), external);
  external.eaMaxLots = "0.01"; external.account.sources[0].maxLots = "0.01"; external.contract.conditions.maxLots = "0.1";
  assert.equal(revalidateTrade(close, external), undefined);
});

test("account-qualified fingerprints reject target edits but ignore live profit/swap/close-price changes", () => {
  const ctx = context(); const order = existing(ctx, true); const p = preview(manage("modify"), ctx);
  Object.assign(order, { profit: "200", swap: "-3", commission: "-4", closePrice: "1.101", lots: "7.1250000" });
  assert.equal(revalidateTrade(p, ctx), undefined);
  for (const change of [
    { lots: "7.12" }, { kind: 4 }, { symbol: "OTHER" }, { openPrice: "1.09001" },
    { openTime: 1768399201 }, { stopLoss: "1.08001" }, { takeProfit: "1.12001" }, { expiration: 1768489201 }, { ticket: "43" },
  ]) { const fresh = structuredClone(ctx); Object.assign(fresh.account.orders[0], change); rejectsRevalidation(p, fresh); }
  const before = structuredClone(p);
  // A corrected clock rule changes the UTC display, not the original broker expiry approved for an omission.
  ctx.clockRule = { winterOffsetMinutes: 150, dst: "none" }; ctx.contract.conditions.quoteTime += 1800;
  assert.equal(revalidateTrade(p, ctx), undefined);
  assert.deepEqual(p, before);
});

test("estimates distinguish a TP inside the spread from profit and a profitable SL from loss", () => {
  assert.deepEqual(validateTrade(buy({ takeProfit: "1.1001" }), context()).estimates, { loss: null, reward: "-1", currency: "USD" });
  assert.deepEqual(validateTrade(buy({ side: "sell", takeProfit: "1.1001" }), context()).estimates, { loss: null, reward: "-1", currency: "USD" });
  const ctx = context(); const order = existing(ctx); order.openPrice = "1.05";
  assert.deepEqual(validateTrade(manage("modify"), ctx).estimates, { loss: "-21375", reward: "49875", currency: "USD" });
  for (const unavailable of ["0", "-1", "NaN"]) {
    ctx.contract.conditions.tickValue = unavailable;
    assert.deepEqual(validateTrade(manage("modify"), ctx).estimates, { loss: null, reward: null, currency: "USD" });
    rejects(buy({ risk: { loss: { points: "100" }, rewardRatio: "2" } }), ctx);
  }
});

test("a zero broker new-order limit still permits managing an existing position", () => {
  const ctx = context(); existing(ctx); const p = preview(manage("close"), ctx);
  ctx.contract.conditions.maxLots = "0";
  assert.equal(validateTrade(manage("close"), ctx).intent.lots, "7.125");
  assert.equal(revalidateTrade(p, ctx), undefined);
  rejects(buy(), ctx);
});

test("fresh executor cap evidence must agree and new prices must survive EA decimal normalization", () => {
  const mismatch = context(); mismatch.account.sources[0].maxLots = "0.05";
  rejects(buy(), mismatch);
  const quote = context(); quote.contract.conditions.tickSize = "0.0003";
  rejects(buy(), quote);
  const precision = context();
  Object.assign(precision.contract.conditions, { tickSize: "0.000001", stopLevel: 0 });
  rejects(buy({ stopLoss: "1.099999" }), precision);
  for (const digits of [-1, 11, 2.5]) { precision.contract.conditions.digits = digits; rejects(buy(), precision); }
  const expiry = { toString: () => "2026-01-16T12:00:00Z" };
  rejects({ ...buy({ type: "limit", price: "1.09" }), expiry });
});

test("fingerprint field ordering is irrelevant and allowed quote movement never rewrites stops", () => {
  const ctx = context(); existing(ctx);
  const p = preview(manage("modify"), ctx);
  p.target = { expiration: 0, takeProfit: "1.12", stopLoss: "1.08", openTime: 1768399200, openPrice: "1.1", lots: "7.125", symbol: "EURUSD", kind: 0, ticket: "42" };
  assert.equal(revalidateTrade(p, ctx), undefined);
  const risk = preview(buy({ risk: { loss: { amount: "100" }, rewardRatio: "2" } }), ctx);
  const approved = structuredClone(risk);
  ctx.contract.conditions.bid = "1.1002"; ctx.contract.conditions.ask = "1.1004";
  freezeDeep(risk); freezeDeep(ctx);
  assert.equal(revalidateTrade(risk, ctx), undefined); // Exactly 20 points, the approved slippage.
  assert.deepEqual(risk, approved);
});

test("all four pending types enforce strict freeze boundaries again during execution", () => {
  const cases = [
    { kind: 2, frozen: "1.1", outside: "1.09999", bid: "1.09999", ask: "1.10019" },
    { kind: 3, frozen: "1.1002", outside: "1.10021", bid: "1.10001", ask: "1.10021" },
    { kind: 4, frozen: "1.1004", outside: "1.10041", bid: "1.10001", ask: "1.10021" },
    { kind: 5, frozen: "1.0998", outside: "1.09979", bid: "1.09999", ask: "1.10019" },
  ];
  for (const sample of cases) {
    const ctx = context(); const order = existing(ctx, true);
    Object.assign(order, { kind: sample.kind, openPrice: sample.frozen, stopLoss: "0", takeProfit: "0" });
    ctx.contract.conditions.freezeLevel = 20;
    rejects(manage("cancel"), ctx, "frozen-target");
    rejects({ ...manage("modify"), price: sample.outside }, ctx, "frozen-target");
    order.openPrice = sample.outside;
    const approved = preview(manage("cancel"), ctx);
    assert.equal(revalidateTrade(approved, ctx), undefined);
    Object.assign(ctx.contract.conditions, { bid: sample.bid, ask: sample.ask });
    rejectsRevalidation(approved, ctx, "frozen-target");
  }
});

test("pending risk uses the approved entry and validation never mutates its input or snapshots", () => {
  const ctx = fractionalContract();
  const input = buy({ type: "limit", price: "99", lots: "0.15", risk: { loss: { amount: "1" }, rewardRatio: "2" } });
  freezeDeep(input); freezeDeep(ctx);
  const result = validateTrade(input, ctx);
  assert.deepEqual({ price: result.intent.price, sl: result.intent.stopLoss, tp: result.intent.takeProfit }, { price: "99", sl: "98.5", tp: "100.25" });
  assert.deepEqual(result.estimates, { loss: "0.75", reward: "1.875", currency: "USD" });
  // Mutating the returned approval does not mutate its source input or conditions.
  result.intent.price = "98";
  assert.equal(input.price, "99"); assert.equal(ctx.contract.conditions.ask, "100.25");
});

test("new market intent normalizes decimals and exposes effective caps and account-currency estimates", () => {
  const result = validateTrade(buy({ stopLoss: "1.09900", takeProfit: "1.10200" }), context());
  assert.deepEqual(result, {
    intent: { action: "new", accountId: "demo-account", symbol: "EURUSD", kind: 0, ticket: "0", lots: "0.1", price: "1.1002", stopLoss: "1.099", takeProfit: "1.102", expiry: null, brokerExpiry: 0, slippage: 20 },
    target: null, limits: { broker: "100", ea: "2", app: "1", maxLots: "1" },
    estimates: { loss: "12", reward: "18", currency: "USD" },
    warnings: ["Estimates exclude fees, swaps and slippage; stops are not a guaranteed loss cap."],
  });
});

test("full close approves the current exit quote, not the historic entry, and cannot widen approved slippage", () => {
  const ctx = context(); const order = existing(ctx); order.openPrice = "1.05";
  const approved = preview(manage("close"), ctx);
  assert.equal(approved.intent.price, "1.1");
  assert.equal(approved.target?.openPrice, "1.05");
  ctx.contract.conditions.bid = "1.10021"; ctx.contract.conditions.ask = "1.10041";
  rejectsRevalidation(approved, ctx, "price-changed");
});

test("changed monetary conditions require new approval instead of silently changing approved risk", () => {
  const ctx = context();
  const approved = preview(buy({ risk: { loss: { amount: "100" }, rewardRatio: "2" } }), ctx);
  ctx.contract.conditions.tickValue = "2";
  rejectsRevalidation(approved, ctx, "estimates-changed");
});

test("a corrected broker clock cannot change an explicitly approved UTC expiry", () => {
  for (const modifying of [false, true]) {
    const ctx = context();
    if (modifying) existing(ctx, true);
    const input: TradeInput = modifying ? { ...manage("modify"), expiry: "2026-01-15T13:00:00Z" }
      : buy({ type: "limit", price: "1.09", expiry: "2026-01-15T13:00:00Z" });
    const approved = preview(input, ctx);
    assert.equal(approved.intent.expiry, "2026-01-15T13:00:00.000Z");
    assert.equal(approved.intent.brokerExpiry, 1768489200);
    ctx.clockRule = { winterOffsetMinutes: 150, dst: "none" }; ctx.contract.conditions.quoteTime += 1800;
    rejectsRevalidation(approved, ctx, "expiry-conversion-changed");
  }
});
