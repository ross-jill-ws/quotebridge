// What each request engine refusal means, in words for the trader: the API's error message, which the CLI and the order
// dialog show as they are. The code is the stable part; docs/rest-api.md lists the codes by status.

const MESSAGES: Record<string, string> = {
  // Who may trade, and whether trading is on
  "not-authorized": "This credential may not trade.",
  "trading-disabled": "Demo trading is off in the app window's Settings.",
  "demo-only": "QuoteBridge trades on demo accounts only.",
  "trading-not-allowed": "The broker does not allow trading this symbol on this account.",
  "trading-stopped": "The app is stopping; no request is accepted.",
  "terminal-updating": "The account's terminal is being updated.",
  "journal-unavailable": "The trading journal could not be written; nothing was sent.",
  // The body
  "invalid-input": "The request body is not a trading request: an object with text values as the REST API manual gives them.",
  "unknown-property": "The request body has a field the trading request does not take.",
  "invalid-action": "The action is not place, modify, close or cancel.",
  "invalid-ticket": "A ticket is MetaTrader's order number, such as 12345678.",
  "confirmation-required": "Execute needs { \"confirm\": true }: nothing was sent.",
  // Values for this account and market
  "invalid-decimal": "A price, lots, distance or risk value is not a plain positive decimal such as 0.10 or 1.08500.",
  "numeric-range": "A number is out of range.",
  "invalid-side": "The side is not buy or sell.",
  "invalid-type": "The order type is not market, limit or stop.",
  "invalid-market-fields": "A market order, or a change to an open position, takes no entry price or expiry.",
  "invalid-volume": "A new order's lots are below the broker's minimum, off its lot step, or above the smallest of the broker's, the EA's and the app's lot caps.",
  "invalid-tick": "The price is not on the market's price grid: a whole number of its tick size, within its digits.",
  "invalid-entry": "A limit or stop order's entry is on the wrong side of the price, or nearer to it than the broker's stop level.",
  "invalid-stops": "A stop loss or take profit is on the wrong side of the entry (a market order's current price), or nearer to it than the broker's stop level.",
  "invalid-expiry": "The expiry is not a future UTC time in whole seconds (YYYY-MM-DDTHH:MM:SSZ), or the order is not pending.",
  "ambiguous-expiry": "The expiry falls in the broker's clock change, so it has no single broker time. Choose another time.",
  "conflicting-stops": "Give stops one way: prices, distances in points, or a risk plan.",
  "invalid-risk": "A risk plan takes one loss (an amount, a percentage of the balance up to 100, or points) and a reward ratio.",
  "invalid-distance": "Stop distances need a stop loss or a take profit in points.",
  "unsatisfiable-distance": "A stop distance would reach or pass zero or the entry. Use a smaller distance.",
  "unsatisfiable-risk": "The risk plan's stops would reach or pass zero or the entry with these lots. Change the loss or the lots.",
  "risk-unavailable": "The account's currency is not known yet, so the risk plan cannot be worked out.",
  "insufficient-margin": "The account's free margin does not cover this order.",
  "frozen-target": "The trade, or a stop being set, is within the broker's freeze level of the price or on its wrong side, so it cannot be changed now.",
  "wrong-target-kind": "Close takes an open position and cancel a pending order; this ticket is the other kind.",
  "invalid-slippage": "The slippage in the app window's Settings › Trading is out of range.",
  "invalid-review": "A review needs a note of 8–500 characters and acknowledged: true, after checking MetaTrader's open orders and account history.",
  // The account and its source
  "account-unavailable": "The account's terminal is offline or has not sent a fresh snapshot yet.",
  "account-unresolved": "This account has a request without a definitive result. Check it, and review it if its outcome is unknown.",
  "executor-unavailable": "The account has no single ready trading chart with a known EA lot cap.",
  "target-unavailable": "The account has no open position or pending order with this ticket.",
  "invalid-target": "The terminal reported this trade with an order type QuoteBridge does not know.",
  "invalid-conditions": "The terminal's market conditions cannot be used (digits, stop or freeze level).",
  "invalid-quote": "The terminal's quote for this market cannot be used.",
  "clock-rule-required": "The broker's clock is not known yet, so broker times cannot be worked out. Try again shortly.",
  "read-timeout": "The account's terminal did not answer within five seconds.",
  "account-changed": "The terminal's account changed during the request.",
  "invalid-response": "The terminal's answer could not be used.",
  "result-mismatch": "The terminal's result does not match the request it answers.",
  // The preview no longer holds
  "preview-unavailable": "No valid preview has this ID: it expired, was invalidated or already ran. Preview again.",
  "preview-expired": "The preview has expired. Preview again.",
  "preview-invalidated": "Settings or the account's source changed since the preview. Preview again.",
  "settings-changed": "Demo trading, the lot cap or the slippage changed since the preview. Preview again.",
  "executor-changed": "The account's trading chart changed since the preview. Preview again.",
  "identity-changed": "The account's terminal or chart changed since the preview. Preview again.",
  "limits-changed": "A lot cap changed since the preview. Preview again.",
  "target-changed": "The trade changed since the preview (its stops, entry, expiry or lots). Preview again.",
  "price-changed": "The price moved beyond the slippage since the preview. Preview again.",
  "estimates-changed": "The estimates changed since the preview. Preview again.",
  "expiry-conversion-changed": "The broker's clock changed how the expiry converts since the preview. Preview again.",
  "stale-snapshot": "The account's snapshot is more than five seconds old. Preview again.",
  "stale-quote": "The market's quote is more than 30 seconds old. Preview again when it quotes.",
  // Requests
  "request-not-found": "No request has this ID.",
  "request-not-unknown": "Only a request whose outcome is unknown can be reviewed.",
};

/** The message for a request engine refusal code. */
export function tradingMessage(code: string): string {
  if (code === "executor-real-account") return "QuoteBridge trades on demo accounts only; this real account is read-only.";
  if (code.startsWith("executor-")) return `The account's trading chart is not ready (${code.slice("executor-".length)}). Exactly one chart per account must have demo trading enabled.`;
  return MESSAGES[code] ?? `The request was refused: ${code}. See the REST API manual's error codes.`;
}
