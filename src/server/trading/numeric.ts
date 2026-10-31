import { brokerToUtc, isClockRule, utcToBroker } from "../../shared/clock.js";
import { chooseExecutor, sameAccountBinding } from "../bridge/accounts.js";
import type { AccountOrder } from "../bridge/account-protocol.js";
import { marketId } from "../identity/index.js";
import { TradingError, type ApprovedIntent, type EffectiveLimits, type TradeEstimates, type TargetFingerprint, type StopDistances, type TradeInput, type TradingPreview, type ValidatedTrade, type ValidationContext } from "./types.js";

// Every price, volume and monetary calculation uses ten-place fixed integers, never binary floats.
const SCALE = 10_000_000_000n;
const MAX = 10n ** 25n - 1n;
const ESTIMATE_WARNING = "Estimates exclude fees, swaps and slippage; stops are not a guaranteed loss cap.";
function fail(code: string, status = 422): never { throw new TradingError(code, status); }
function decimal(value: unknown, positive = false): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,14})(?:\.\d{1,10})?$/.test(value)) fail("invalid-decimal");
  const [whole, fraction = ""] = value.split(".");
  const units = BigInt(whole) * SCALE + BigInt(fraction.padEnd(10, "0"));
  if (positive && units === 0n) fail("invalid-decimal");
  return units;
}
function fixed(value: bigint): string {
  if (value < 0n || value > MAX) fail("numeric-range");
  const fraction = String(value % SCALE).padStart(10, "0").replace(/0+$/, "");
  return `${value / SCALE}${fraction ? `.${fraction}` : ""}`;
}
const normalized = (value: unknown, positive = false) => fixed(decimal(value, positive));
const minimum = (...values: bigint[]) => values.reduce((a, b) => a < b ? a : b);
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail("invalid-input", 400);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowed.includes(key))) fail("unknown-property", 400);
}
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value.length > 120 || value.trim() !== value || /[|\x00-\x1f\x7f-\x9f]/.test(value)) fail("invalid-input", 400);
}
function schema(value: unknown): asserts value is TradeInput {
  const input = object(value);
  text(input.accountId);
  if (input.action !== "new") {
    if (input.action !== "modify" && input.action !== "close" && input.action !== "cancel") fail("invalid-action", 400);
    keys(input, ["action", "accountId", "ticket", ...(input.action === "modify" ? ["price", "stopLoss", "takeProfit", "expiry"] : [])]);
    if (typeof input.ticket !== "string" || !/^[1-9]\d{0,9}$/.test(input.ticket) || BigInt(input.ticket) > 2147483647n) fail("invalid-ticket", 400);
    if ("price" in input) decimal(input.price, true);
    for (const key of ["stopLoss", "takeProfit"]) if (key in input && input[key] !== null) decimal(input[key], true);
    if ("expiry" in input && input.expiry !== null && typeof input.expiry !== "string") fail("invalid-expiry");
    return;
  }
  keys(input, ["action", "accountId", "symbol", "side", "type", "lots", "price", "stopLoss", "takeProfit", "expiry", "risk", "distance"]);
  text(input.symbol);
  if (input.side !== "buy" && input.side !== "sell") fail("invalid-side");
  if (input.type !== "market" && input.type !== "limit" && input.type !== "stop") fail("invalid-type");
  decimal(input.lots, true);
  if (input.type === "market" && ("price" in input || "expiry" in input)) fail("invalid-market-fields");
  if (input.type !== "market") decimal(input.price, true);
  for (const key of ["stopLoss", "takeProfit"]) if (key in input) decimal(input[key], true);
  if ("risk" in input) {
    if ("stopLoss" in input || "takeProfit" in input) fail("conflicting-stops");
    const risk = object(input.risk); keys(risk, ["loss", "rewardRatio"]);
    decimal(risk.rewardRatio, true);
    const loss = object(risk.loss); keys(loss, ["amount", "balancePercent", "points"]);
    if (Object.keys(loss).length !== 1) fail("invalid-risk");
    const key = Object.keys(loss)[0];
    const target = decimal(loss[key], true);
    if (key === "balancePercent" && target > 100n * SCALE) fail("invalid-risk");
  }
  if ("distance" in input) {
    if ("stopLoss" in input || "takeProfit" in input || "risk" in input) fail("conflicting-stops");
    const distance = object(input.distance); keys(distance, ["stopLoss", "takeProfit"]);
    if (!Object.keys(distance).length) fail("invalid-distance");
    for (const key of Object.keys(distance)) decimal(distance[key], true);
  }
}
export function validateTradeInput(value: unknown): asserts value is TradeInput { schema(value); }
function volumeAndGrid(intent: ApprovedIntent, context: ValidationContext, cap: EffectiveLimits) {
  const c = context.contract.conditions, lots = decimal(intent.lots, true), tick = decimal(c.tickSize, true);
  if (intent.action === "new" && (lots < decimal(c.minLots, true) || lots > decimal(cap.maxLots, true) || lots % decimal(c.lotStep, true))) fail("invalid-volume");
  if (!Number.isInteger(c.digits) || c.digits < 0 || c.digits > 10) fail("invalid-conditions", 409);
  const precision = 10n ** BigInt(10 - c.digits);
  for (const price of [intent.stopLoss, intent.takeProfit, ...(intent.kind >= 2 || intent.action === "new" ? [intent.price] : [])]) {
    if (decimal(price) % tick || decimal(price) % precision) fail("invalid-tick");
  }
}
function current(context: ValidationContext, accountId: string, symbol: string) {
  const { account: a, contract: contract, now, settings } = context, c = contract.conditions;
  if (a.demo === false) {
    if (settings.realAccounts !== true) fail("real-trading-disabled", 403);
  } else {
    if (settings.enabled !== true) fail("trading-disabled", 403);
    if (a.demo !== true) fail("demo-only", 403);
  }
  if (a.connected !== true || a.state !== "fresh" || a.ready !== true || !a.source) fail("account-unavailable", 503);
  const executor = chooseExecutor(a.sources, a.demo === false).source;
  if (!executor || executor.ready !== true || !executor.maxLots || decimal(executor.maxLots) === 0n) fail("executor-unavailable", 409);
  if (decimal(executor.maxLots, true) !== decimal(context.eaMaxLots, true)) fail("limits-changed", 409);
  const source = a.source;
  if (accountId !== a.id || source.accountId !== a.id || source.brokerServer !== a.brokerServer || source.login !== a.login ||
      contract.accountId !== a.id || contract.market.brokerServer !== a.brokerServer || contract.market.symbol !== symbol || c.symbol !== symbol ||
      !sameAccountBinding(source, contract.source) || !sameAccountBinding(source, executor) || c.session !== source.session || c.login !== source.login) fail("identity-changed", 409);
  for (const received of [source.receivedAt, contract.source.receivedAt]) {
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(received) || received > now || now - received > 5000) fail("stale-snapshot", 409);
  }
  if (!context.clockRule || !isClockRule(context.clockRule)) fail("clock-rule-required", 409);
  if (!Number.isSafeInteger(c.quoteTime) || c.quoteTime <= 0) fail("invalid-quote", 409);
  const age = now - brokerToUtc(context.clockRule, c.quoteTime * 1000);
  if (age > 30_000 || age < -5000) fail("stale-quote", 409);
  if (c.tradeAllowed !== true) fail("trading-not-allowed", 403);
  if (decimal(c.ask, true) < decimal(c.bid, true)) fail("invalid-quote", 409);
  if (!Number.isInteger(settings.slippage) || settings.slippage < 0 || settings.slippage > 10000) fail("invalid-slippage");
}
function limits(context: ValidationContext): EffectiveLimits {
  const broker = decimal(context.contract.conditions.maxLots), ea = decimal(context.eaMaxLots, true), app = decimal(context.settings.maxLots, true);
  return { broker: fixed(broker), ea: fixed(ea), app: fixed(app), maxLots: fixed(minimum(broker, ea, app)) };
}
function expiry(value: string, context: ValidationContext): { expiry: string; brokerExpiry: number; expiryExplicit: true } {
  // Broker datetime has whole-second precision; never silently truncate an approved instant.
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.0{1,3})?(?:Z|\+00:00)$/.test(value)) fail("invalid-expiry");
  const utc = Date.parse(value), iso = Number.isFinite(utc) ? new Date(utc).toISOString() : "";
  if (iso.slice(0, 19) !== value.slice(0, 19) || utc <= context.now) fail("invalid-expiry");
  if (!context.clockRule) fail("clock-rule-required", 409);
  const brokerExpiry = utcToBroker(context.clockRule, utc) / 1000;
  if (!Number.isSafeInteger(brokerExpiry) || brokerExpiry <= 0 || brokerExpiry > 9999999999) fail("invalid-expiry");
  if (brokerToUtc(context.clockRule, brokerExpiry * 1000) !== utc) fail("ambiguous-expiry");
  return { expiry: iso, brokerExpiry, expiryExplicit: true };
}
function riskStops(intent: ApprovedIntent, plan: NonNullable<Extract<TradeInput, { action: "new" }>["risk"]>, context: ValidationContext) {
  const c = context.contract.conditions, tick = decimal(c.tickSize, true), value = decimal(c.tickValue, true), lots = decimal(intent.lots, true);
  if (!context.account.funds.currency) fail("risk-unavailable");
  // Distance remains rational until rounding to a tradable tick: even sub-unit budgets retain their exact value.
  let numerator: bigint, denominator: bigint;
  if ("amount" in plan.loss) {
    numerator = decimal(plan.loss.amount, true) * tick * SCALE; denominator = lots * value;
  } else if ("balancePercent" in plan.loss) {
    numerator = decimal(context.account.funds.balance, true) * decimal(plan.loss.balancePercent, true) * tick;
    denominator = 100n * lots * value;
  } else {
    numerator = decimal(plan.loss.points, true) * decimal(c.point, true); denominator = SCALE;
  }
  const buy = intent.kind % 2 === 0;
  intent.stopLoss = towardEntry(intent, tick, numerator, denominator, buy, "unsatisfiable-risk");
  intent.takeProfit = towardEntry(intent, tick, numerator * decimal(plan.rewardRatio, true), denominator * SCALE, !buy, "unsatisfiable-risk");
}
/**
 * The stop n/d away from the entry (below or above it), rounded to a tradable tick toward the entry: never wider than
 * asked. A stop that would reach or pass the entry, or zero, cannot be met (`unmet`).
 */
function towardEntry(intent: ApprovedIntent, tick: bigint, n: bigint, d: bigint, below: boolean, unmet: string): string {
  const entry = decimal(intent.price, true);
  const target = entry * d + (below ? -n : n);
  if (target <= 0n) fail(unmet);
  const divisor = d * tick;
  const rounded = (below ? (target + divisor - 1n) / divisor : target / divisor) * tick;
  if (below ? rounded >= entry : rounded <= entry) fail(unmet);
  return fixed(rounded);
}
/** Stop distances in points from the previewed entry: a buy's stop loss below it and take profit above, a sell's the reverse. */
function distanceStops(intent: ApprovedIntent, distance: StopDistances, context: ValidationContext) {
  const c = context.contract.conditions, tick = decimal(c.tickSize, true), point = decimal(c.point, true), buy = intent.kind % 2 === 0;
  if (distance.stopLoss) intent.stopLoss = towardEntry(intent, tick, decimal(distance.stopLoss, true) * point, SCALE, buy, "unsatisfiable-distance");
  if (distance.takeProfit) intent.takeProfit = towardEntry(intent, tick, decimal(distance.takeProfit, true) * point, SCALE, !buy, "unsatisfiable-distance");
}
function stops(intent: ApprovedIntent, context: ValidationContext) {
  const c = context.contract.conditions, buy = intent.kind % 2 === 0, pending = intent.kind >= 2;
  if (!Number.isInteger(c.stopLevel) || c.stopLevel < 0) fail("invalid-conditions", 409);
  const distance = BigInt(c.stopLevel) * decimal(c.point, true);
  const quote = decimal(buy ? c.ask : c.bid, true), entry = decimal(intent.price, true);
  if (pending) {
    const above = intent.kind === 3 || intent.kind === 4;
    const gap = above ? entry - quote : quote - entry;
    if (gap <= 0n || gap < distance) fail("invalid-entry");
  }
  const reference = pending ? entry : decimal(buy ? c.bid : c.ask, true);
  for (const [stop, below] of [[intent.stopLoss, buy], [intent.takeProfit, !buy]] as const) {
    const price = decimal(stop);
    if (!price) continue;
    const gap = below ? reference - price : price - reference;
    if (gap <= 0n || gap < distance) fail("invalid-stops");
  }
  if (intent.brokerExpiry && (!pending || !context.clockRule || brokerToUtc(context.clockRule, intent.brokerExpiry * 1000) <= context.now)) fail("invalid-expiry");
}
function estimates(intent: ApprovedIntent, context: ValidationContext): TradeEstimates {
  const c = context.contract.conditions;
  let tickValue = 0n;
  try { tickValue = decimal(c.tickValue); } catch (error) { if (!(error instanceof TradingError)) throw error; }
  const tickSize = decimal(c.tickSize, true), buy = intent.kind % 2 === 0;
  const price = decimal(intent.price), lots = decimal(intent.lots);
  const estimate = (stop: string, loss: boolean) => {
    const level = decimal(stop);
    if (!level || !tickValue) return null;
    const signedDistance = buy === loss ? price - level : level - price;
    const distance = signedDistance < 0n ? -signedDistance : signedDistance;
    const numerator = distance * lots * tickValue, denominator = tickSize * SCALE;
    const rounded = (2n * numerator + denominator) / (2n * denominator);
    return `${signedDistance < 0n && rounded ? "-" : ""}${fixed(rounded)}`;
  };
  return { loss: estimate(intent.stopLoss, true), reward: estimate(intent.takeProfit, false), currency: context.account.funds.currency };
}

function findTarget(ticket: string, context: ValidationContext): AccountOrder {
  const matches = [...context.account.positions, ...context.account.orders].filter((order) => order.ticket === ticket);
  if (matches.length !== 1) fail("target-unavailable", 409);
  const target = matches[0];
  if (!Number.isInteger(target.kind) || target.kind < 0 || target.kind > 5) fail("invalid-target", 409);
  return target;
}
function fingerprint(order: AccountOrder): TargetFingerprint {
  return { ticket: order.ticket, kind: order.kind, symbol: order.symbol, lots: normalized(order.lots, true), openPrice: normalized(order.openPrice, true),
    openTime: order.openTime, stopLoss: normalized(order.stopLoss), takeProfit: normalized(order.takeProfit), expiration: order.expiration };
}
function sameTarget(a: TargetFingerprint, b: TargetFingerprint): boolean {
  const fields: (keyof TargetFingerprint)[] = ["ticket", "kind", "symbol", "lots", "openPrice", "openTime", "stopLoss", "takeProfit", "expiration"];
  return fields.every((field) => a[field] === b[field]);
}
function freeze(intent: ApprovedIntent, context: ValidationContext) {
  const c = context.contract.conditions;
  if (!Number.isInteger(c.freezeLevel) || c.freezeLevel < 0) fail("invalid-conditions", 409);
  if (intent.action === "new" || !c.freezeLevel) return;
  const order = findTarget(intent.ticket, context), buy = intent.kind % 2 === 0;
  const distance = BigInt(c.freezeLevel) * decimal(c.point, true);
  if (intent.kind >= 2) {
    const quote = decimal(buy ? c.ask : c.bid, true), above = intent.kind === 3 || intent.kind === 4;
    for (const entry of [order.openPrice, ...(intent.action === "modify" ? [intent.price] : [])]) {
      const gap = above ? decimal(entry, true) - quote : quote - decimal(entry, true);
      if (gap <= distance) fail("frozen-target");
    }
  } else {
    const quote = decimal(buy ? c.bid : c.ask, true);
    const pairs = [[order.stopLoss, buy], [order.takeProfit, !buy],
      ...(intent.action === "modify" ? [[intent.stopLoss, buy], [intent.takeProfit, !buy]] as const : [])] as const;
    for (const [level, below] of pairs) {
      const price = decimal(level);
      if (price && (below ? quote - price : price - quote) <= distance) fail("frozen-target");
    }
  }
}
function validateIntent(intent: ApprovedIntent, context: ValidationContext, cap: EffectiveLimits) {
  freeze(intent, context);
  if (intent.action === "new" || intent.action === "modify") {
    volumeAndGrid(intent, context, cap);
    stops(intent, context);
  }
  if (intent.action === "new" && decimal(context.contract.conditions.marginRequired, true) * decimal(intent.lots, true) >= decimal(context.account.funds.freeMargin) * SCALE) fail("insufficient-margin");
}

/** Public request-engine numeric/risk seam. No I/O, clock reads or mutation of caller-owned values. */
export function validateTrade(input: TradeInput, context: ValidationContext): ValidatedTrade {
  schema(input);
  const order = input.action === "new" ? null : findTarget(input.ticket, context);
  const symbol = input.action === "new" ? input.symbol : order!.symbol;
  current(context, input.accountId, symbol);
  const c = context.contract.conditions;
  let intent: ApprovedIntent;
  if (input.action === "new") {
    intent = {
      action: "new", accountId: input.accountId, symbol,
      kind: input.type === "market" ? input.side === "buy" ? 0 : 1 : input.type === "limit" ? input.side === "buy" ? 2 : 3 : input.side === "buy" ? 4 : 5,
      ticket: "0", lots: normalized(input.lots, true), price: normalized(input.price ?? (input.side === "buy" ? c.ask : c.bid), true),
      stopLoss: normalized(input.stopLoss ?? "0"), takeProfit: normalized(input.takeProfit ?? "0"), expiry: null, brokerExpiry: 0, slippage: context.settings.slippage,
    };
    if ("expiry" in input) Object.assign(intent, expiry(input.expiry!, context));
    if (input.risk) riskStops(intent, input.risk, context);
    if (input.distance) distanceStops(intent, input.distance, context);
  } else {
    const target = fingerprint(order!);
    const pending = target.kind >= 2;
    if ((input.action === "close" && pending) || (input.action === "cancel" && !pending)) fail("wrong-target-kind");
    intent = { action: input.action, accountId: input.accountId, symbol, kind: target.kind, ticket: target.ticket, lots: target.lots,
      price: target.openPrice, stopLoss: target.stopLoss, takeProfit: target.takeProfit, brokerExpiry: target.expiration,
      expiry: target.expiration ? new Date(brokerToUtc(context.clockRule!, target.expiration * 1000)).toISOString() : null, slippage: context.settings.slippage };
    if (input.action === "close") intent.price = normalized(target.kind === 0 ? c.bid : c.ask, true);
    if (input.action === "modify") {
      if (!pending && ("price" in input || "expiry" in input)) fail("invalid-market-fields");
      if ("price" in input) intent.price = normalized(input.price, true);
      if ("stopLoss" in input) intent.stopLoss = input.stopLoss === null ? "0" : normalized(input.stopLoss, true);
      if ("takeProfit" in input) intent.takeProfit = input.takeProfit === null ? "0" : normalized(input.takeProfit, true);
      if ("expiry" in input) Object.assign(intent, input.expiry === null ? { expiry: null, brokerExpiry: 0 } : expiry(input.expiry!, context));
    }
  }
  const cap = limits(context);
  validateIntent(intent, context, cap);
  const warnings = [ESTIMATE_WARNING];
  if (intent.stopLoss === "0") warnings.push("No stop loss is set.");
  if (intent.takeProfit === "0") warnings.push("No take profit is set.");
  if (order && order.magic !== 27012026) warnings.push("This trade was created outside QuoteBridge.");
  return { intent, target: order ? fingerprint(order) : null, limits: cap, estimates: estimates(intent, context), warnings };
}

/** Recheck current conditions against the immutable approval, never the original risk plan. */
export function revalidateTrade(preview: TradingPreview, context: ValidationContext): void {
  const { intent } = preview;
  current(context, intent.accountId, intent.symbol);
  if (!Number.isSafeInteger(preview.createdAt) || !Number.isSafeInteger(preview.expiresAt) || context.now < preview.createdAt || context.now >= preview.expiresAt) fail("preview-expired", 409);
  if (!sameAccountBinding(preview.source, context.account.source!) || preview.marketId !== marketId(context.account.brokerServer, intent.symbol)) fail("identity-changed", 409);
  if (preview.settings.enabled !== context.settings.enabled || (preview.settings.realAccounts === true) !== (context.settings.realAccounts === true) || normalized(preview.settings.maxLots, true) !== normalized(context.settings.maxLots, true) ||
      preview.settings.slippage !== context.settings.slippage || intent.slippage !== context.settings.slippage) fail("settings-changed", 409);
  if (intent.action !== "new") {
    const target = fingerprint(findTarget(intent.ticket, context));
    if (!preview.target || !sameTarget(preview.target, target) || intent.symbol !== target.symbol || intent.kind !== target.kind || intent.lots !== target.lots) fail("target-changed", 409);
  } else if (preview.target !== null) fail("target-changed", 409);
  if (intent.expiryExplicit && intent.expiry !== null && expiry(intent.expiry, context).brokerExpiry !== intent.brokerExpiry) fail("expiry-conversion-changed", 409);
  const cap = limits(context);
  if (intent.action === "new" && normalized(preview.limits.maxLots, true) !== cap.maxLots) fail("limits-changed", 409);
  if ((intent.action === "new" && intent.kind < 2) || intent.action === "close") {
    const c = context.contract.conditions;
    const useAsk = intent.action === "close" ? intent.kind === 1 : intent.kind === 0;
    const quote = decimal(useAsk ? c.ask : c.bid, true), price = decimal(intent.price, true);
    const change = quote > price ? quote - price : price - quote;
    if (change > BigInt(intent.slippage) * decimal(c.point, true)) fail("price-changed", 409);
  }
  const freshEstimates = estimates(intent, context);
  if (freshEstimates.loss !== preview.estimates.loss || freshEstimates.reward !== preview.estimates.reward || freshEstimates.currency !== preview.estimates.currency) fail("estimates-changed", 409);
  validateIntent(intent, context, cap);
}
