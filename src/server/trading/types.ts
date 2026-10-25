import type { ClockRule } from "../../shared/clock.js";
import type { TradingSettings } from "../../shared/settings-store.js";
import type { AccountBinding, AccountSnapshot, ConditionSnapshot } from "../bridge/accounts.js";
import type { AccountOrder } from "../bridge/account-protocol.js";

export type { TradingSettings } from "../../shared/settings-store.js";
export type RiskPlan = { loss: { amount: string } | { balancePercent: string } | { points: string }; rewardRatio: string };
/** Stop distances in points from the entry, turned into prices at preview (a stop distance in the glossary). */
export type StopDistances = { stopLoss?: string; takeProfit?: string };
export type TradeInput =
  | { action: "new"; accountId: string; symbol: string; side: "buy" | "sell"; type: "market" | "limit" | "stop"; lots: string; price?: string; stopLoss?: string; takeProfit?: string; expiry?: string; risk?: RiskPlan; distance?: StopDistances }
  | { action: "modify"; accountId: string; ticket: string; price?: string; stopLoss?: string | null; takeProfit?: string | null; expiry?: string | null }
  | { action: "close" | "cancel"; accountId: string; ticket: string };

/** Fully normalized EA parameters. Execute validates these, never recalculates the approved risk plan. */
export type ApprovedIntent = {
  action: "new" | "modify" | "close" | "cancel"; accountId: string; symbol: string; kind: number;
  ticket: string; lots: string; price: string; stopLoss: string; takeProfit: string;
  expiry: string | null; brokerExpiry: number; slippage: number;
  /** Explicit UTC expiry must retain its conversion; omitted existing expiry stays in broker time. */
  expiryExplicit?: true;
};
export type TargetFingerprint = Pick<AccountOrder, "ticket" | "kind" | "symbol" | "lots" | "openPrice" | "openTime" | "stopLoss" | "takeProfit" | "expiration">;
export type EffectiveLimits = { broker: string; ea: string; app: string; maxLots: string };
export type TradeEstimates = { loss: string | null; reward: string | null; currency: string | null };
export type TradingPreview = {
  id: string; createdAt: number; expiresAt: number; intent: ApprovedIntent;
  source: AccountBinding; marketId: string; target: TargetFingerprint | null;
  settings: TradingSettings; limits: EffectiveLimits; estimates: TradeEstimates; warnings: string[];
};
export type ValidationContext = {
  account: AccountSnapshot; contract: ConditionSnapshot; settings: TradingSettings;
  eaMaxLots: string; now: number; clockRule: ClockRule | null;
};
export type ValidatedTrade = Pick<TradingPreview, "intent" | "target" | "limits" | "estimates" | "warnings">;

/** Static errors: inputs, account numbers and database/transport exceptions never enter diagnostics. */
export class TradingError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); this.name = "TradingError"; }
}
