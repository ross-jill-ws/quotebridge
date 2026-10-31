// Every refusal the request engine can raise says in words what is wrong; none falls back to the bare code (M5-17).
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { tradingMessage } from "../src/server/trading/index.js";

/** The engine's refusal codes, as docs/rest-api.md lists them under trading. */
const CODES = [
  "not-authorized", "trading-disabled", "real-trading-disabled", "demo-only", "trading-not-allowed", "trading-stopped", "terminal-updating", "journal-unavailable",
  "invalid-input", "unknown-property", "invalid-action", "invalid-ticket", "confirmation-required",
  "invalid-decimal", "numeric-range", "invalid-side", "invalid-type", "invalid-market-fields", "invalid-volume", "invalid-tick", "invalid-entry",
  "invalid-stops", "invalid-expiry", "ambiguous-expiry", "conflicting-stops", "invalid-risk", "invalid-distance", "unsatisfiable-distance",
  "unsatisfiable-risk", "risk-unavailable", "insufficient-margin", "frozen-target", "wrong-target-kind", "invalid-slippage", "invalid-review",
  "account-unavailable", "account-unresolved", "executor-unavailable", "target-unavailable", "invalid-target", "invalid-conditions", "invalid-quote",
  "clock-rule-required", "read-timeout", "account-changed", "invalid-response", "result-mismatch",
  "preview-unavailable", "preview-expired", "preview-invalidated", "settings-changed", "executor-changed", "identity-changed", "limits-changed",
  "target-changed", "price-changed", "estimates-changed", "expiry-conversion-changed", "stale-snapshot", "stale-quote",
  "request-not-found", "request-not-unknown",
  "executor-zero", "executor-multiple", "executor-not-ready", "executor-real-account",
];

test("every trading refusal has its own message, not the bare code", () => {
  const generic = CODES.filter((code) => /The request was refused|See the REST API manual/.test(tradingMessage(code)));
  assert.deepEqual(generic, []);
});

test("the list above has every code the request engine raises", () => {
  const folder = new URL("../src/server/trading/", import.meta.url);
  const raised = new Set<string>();
  for (const file of readdirSync(folder).filter((f) => f.endsWith(".ts"))) {
    for (const [, code] of readFileSync(new URL(file, folder), "utf8").matchAll(/(?:fail|TradingError)\(\s*"([a-z-]+)"/g)) raised.add(code);
  }
  assert.ok(raised.size > 30, "the scan finds the engine's codes");
  assert.deepEqual([...raised].filter((code) => !CODES.includes(code)), []);
});

test("refusals the CLI check met say what to fix", () => {
  assert.match(tradingMessage("invalid-volume"), /lot caps/);
  assert.match(tradingMessage("invalid-stops"), /wrong side of the entry \(a market order's current price\), or nearer to it than the broker's stop level/);
  assert.match(tradingMessage("target-changed"), /The trade changed since the preview.*Preview again/);
  assert.match(tradingMessage("executor-real-account"), /real account is read-only/);
  assert.match(tradingMessage("executor-real-account"), /EnableRealTrading/);
  assert.doesNotMatch(tradingMessage("executor-real-account"), /must have trading enabled/);
  assert.match(tradingMessage("executor-zero"), /A demo account needs a connected chart running EA 1\.13 or later/);
  assert.match(tradingMessage("real-trading-disabled"), /Real-account trading is off/);
});
