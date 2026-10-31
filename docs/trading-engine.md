# Trading request engine

The embedded server's `RunningServer.trading` is the shared preview/execute/review service. It is available only with a durable database. This is an internal TypeScript interface. The public REST API's trading requests ([REST API](rest-api.md#trading-requests)) call it with the caller's key or session; the Trading page and CLI are separate integrations.

## Interface

`src/server/trading/index.ts` exports `RequestEngine`, request/preview types, journal types and `TradingError` (`code`, HTTP-style `status`). Server callers supply a `TradingCredential`: an API key, or session headers. The server checks current authorization on every operation, including duplicate execution lookups. `readonly` reads the common journal; `trader`, app-window and authenticated remote-browser sessions may preview, execute and review. No preview is owned by one credential. Never log credentials, account snapshots, journal contents or broker result messages.

- `preview(credential, input)` requires an explicit account ID and either a new-order symbol or an account-qualified ticket. Every mutation, including close/cancel/modify, needs a preview. Fresh account and contract reads come from exactly one ready demo executor, under one five-second deadline; cached data never substitutes. Existing-ticket symbol discovery also uses a fresh executor read. An account with an executing or unresolved request refuses previews (`account-unresolved`) before any read.
- The returned preview has a random 32-hex request ID, 30-second expiry, normalized approved intent, source/market identity, settings, effective limits, target fingerprint, warnings and account-currency estimates. It is detached from internal approval state. Unexecuted previews are memory-only and disappear on restart or invalidation.
- `execute(credential, id, true)` refreshes snapshots, rechecks approval and current permissions, then commits journal admission **before** sending the 24-field EA command. Simultaneous duplicate calls join one execution. Subsequent duplicate calls return the existing record without another send. Another unresolved request blocks only its account; independent accounts proceed.
- `get(credential, id)` / `list(credential)` retrieve durable execution records. After a lost response, retrieve the same request ID; do not create another order to discover what happened.
- `review(credential, id, note, acknowledged)` requires an unknown outcome, an 8–500-character trimmed note and explicit acknowledgement that open orders and account history were checked in MetaTrader. Review is permitted with Demo trading off. It releases the account's block but retains the unknown outcome and review history. It never permits resending the request.

## Safety and numbers

Settings default to `{ enabled: false, maxLots: "1.0", slippage: 20 }`; `realAccounts` (Real-account trading) is absent, which is off, and the settings view always answers it. Only the app window may change them. Any trading-setting change invalidates unused approvals; disabling blocks every new mutation, not reads, review or result tracking. The app never changes MetaTrader permissions. `enabled` gates demo accounts and `realAccounts` real ones (ADR 14): a real account's preview with it off is `real-trading-disabled` (403), checked at preview and again before dispatch. The EA independently executes a real account's command only from a chart with `EnableRealTrading`, a demo one's only with `EnableDemoTrading`.

All external financial numbers are fixed-decimal strings with at most 15 integer and 10 fractional digits. App calculations use scaled integers, including lot/tick alignment, risk conversion and rounding. New-order lots must meet broker steps and the minimum of broker/EA/app caps. Those caps do not prohibit management of a larger existing trade.

New orders require lots and accept either absolute SL/TP or a loss plan (account-currency amount, balance percentage or points) plus reward ratio. Risk-derived stops round toward entry; impossible broker/tick constraints reject rather than increase risk. Estimates exclude fees, swaps and slippage and are not guaranteed loss caps. Missing stops and outside-created trades produce warnings.

Modify omissions preserve fields. `null` explicitly clears SL/TP or pending expiry; zero is not a clearing alias. Lot modifications and partial closes are unsupported. Explicit expiry accepts whole-second UTC timestamps and uses the broker clock rule; a corrected conversion requires a new preview. Ambiguous repeated broker-clock hours that cannot round-trip to the approved UTC instant are rejected. Omitted existing expiry retains its original broker-time value. Changed targets, invalid conditions or changed monetary estimates require a new approval, never a silent recalculation. Market placement and full close preserve the preview's approved price/slippage anchor in the EA as well as in the app.

## Evidence and lifecycle

Schema 9 stores normalized approval, source identity, origin category (never credentials), timestamps, outcome and append-only result/review events. There is no journal deletion or retention limit. Account financial snapshots remain memory-only.

Outcomes are `dispatching`, `succeeded`, `failed` or `unknown`. Broker/preflight rejections are definitive failures. Send interruption after durable admission, ambiguous broker results, 20 seconds without a definitive result, and unfinished work recovered after restart become unknown. There are **no automatic retries** and no exactly-once broker-success claim. The EA's flushed durable duplicate marker remains an additional guard.

Original request/account/session/terminal bindings survive retirement and restart. Late definitive evidence may resolve unknown, preserving review history; duplicate replies are idempotent. Conflicting later evidence is retained without replacing an established definitive outcome.

An affected terminal's update/install/removal/recovery waits for definitive outcome or explicit review, not merely timeout or a login change. Unrelated terminals continue. Quit warns about unresolved requests but remains possible; restart recovers them as unknown. Never remove a DuckDB WAL file.

Regression suites: `trading-engine.test.ts` (real ZeroMQ synthetic EAs), `trading-numeric.test.ts`, `trading-journal.test.ts` (real DuckDB, including abrupt-process WAL recovery), `update-propagation.test.ts`, `settings-http.test.ts`, `server-host.test.ts` and `shell.test.ts`. These tests do not compile or execute MetaTrader; MetaEditor compilation and the user-performed demo walkthrough remain release acceptance steps. Coding agents must never send live orders or change MetaTrader permissions/settings.
