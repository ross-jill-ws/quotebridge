# Trading-account wire protocol

QuoteBridge EA ↔ app, protocol version `1`. Implementation: `mt4/Include/QuoteBridgeTrading.mqh`, `src/server/bridge/protocol.ts`, and `account-protocol.ts`. This is an internal wire contract, not REST v1. Examples below are synthetic, not real account identities.

## Transport and validation

One UTF-8 body per ZeroMQ DEALER/ROUTER message, `|`-separated fields, no newline or terminator. The ROUTER receives exactly routing identity + body. A body is at most 16,384 bytes. Every message begins `type|1|session`; session is 1–120 ASCII letters, digits, underscore, dot or hyphen and must equal its ZeroMQ routing identity. The verified `H` hello binds the session to a canonical terminal and broker server (see [Terminals](terminals.md)); an account message cannot establish that binding by itself.

All field counts below include type/version/session. No optional trailing fields except the single documented `I` extension. Empty trailing fields still count. Requests use **exactly 32 lowercase hexadecimal characters**, matching the EA's `TradeRequestId`, not the numeric request IDs used by bar messages. Unknown/malformed account messages fail closed; parser errors are static `Invalid account message` and never interpolate a field or body.

### Scalar rules

- Login and ticket are decimal **strings**, canonical positive integers `1..2147483647`. Result ticket `"0"` means unconfirmed; `E` may report login `"0"` after account loss. No signs, leading zeroes, decimal points or whitespace in integer fields.
- Flags are exactly `0` or `1`, exposed as booleans.
- Financial values are retained as decimal **strings**, never reformatted through a JavaScript number. Grammar: `-?(0|[1-9][0-9]{0,14})(\.[0-9]{1,10})?`. Thus magnitude is strictly below `10^15`, with at most ten fractional digits. Reject exponents, `NaN`, infinities, leading plus, padded/empty values, leading zeroes and excessive precision. Negative values are allowed only where specified; negative zero from EA formatting is accepted as zero. Strictly positive fields reject every spelling of zero. The EA currently uses `DoubleToString(value,10)`.
- Broker timestamps are integer seconds `0..9999999999`; capture, quote and opening times must be positive. Zero denotes no expiration/starting date. These are **broker-clock**, not UTC timestamps; convert with the broker's clock rule before exposing UTC.
- Text is nonempty, at most 120 UTF-16 code units, with no leading/trailing whitespace, C0/C1 controls or UTF-8 replacement characters. Result/error messages have a 512-unit limit. `profitCurrency` alone may be empty (metadata unavailable). EA `TradeText` replaces wire/row delimiters with underscores; the protocol has no escaping syntax.
- All pages and results are structurally validated before correlation. Structural validity is not authorization, freshness or evidence that the response belongs to an outstanding request.

## `I`: account announcement (8 or 9 fields)

Sent immediately after each periodic `H` hello, not in response to a read request:

```text
I|1|session|login|currency|demo|enabled|ready[|maxLots]
I|1|chart-example|12345678|USD|1|0|1|0.5000000000
```

`enabled` is `EnableDemoTrading` on this chart; `ready` is the EA's connection/AutoTrading/permissions/fresh-clock readiness. Neither flag bypasses demo-only execution or the app's independent gates. Real accounts remain readable.

**EA 1.12 additive extension:** append configured `MaxDemoOrderLots` as a signed decimal string. Zero/negative caps make the executor not ready, but do not prevent account or conditions reads. The first eight fields are unchanged. The app accepts exactly eight fields from older EAs and exposes `maxLots: null`, **not** a default or zero. It accepts exactly nine fields for the extension. The chart hello's reported version is now `1.12`; its 16-field installation identity format is unchanged from 1.11.

The effective **new-order** cap is the minimum of broker maximum, EA cap and app cap. A missing EA cap is unknown, not permission to assume a value; upgrade before a preview that requires verified limits. Do not automatically raise any configured cap. Full close, modify and cancellation of a larger existing trade are not rejected solely for exceeding the new-order cap. No settings, permissions or live trading actions are automated by this extension.

## `V`: Funds and open-order snapshot page (19 fields)

App request (6 fields):

```text
V|1|session|request|login|broker
```

EA response:

```text
V|1|session|request|login|broker|currency|demo|balance|equity|margin|freeMargin|profit|leverage|ready|capturedAt|total|offset|orders
```

| Index | Field | Rule |
| --- | --- | --- |
| 3–7 | request, login, broker, currency, demo | Common identity/flag rules |
| 8–9 | balance, equity | Signed decimals |
| 10 | margin | Nonnegative decimal |
| 11–12 | freeMargin, profit | Signed decimals |
| 13 | leverage | Integer `1..1000000` |
| 14 | ready | Boolean flag |
| 15 | capturedAt | Positive broker seconds |
| 16 | total | Total orders across this snapshot, `0..1000` |
| 17 | offset | Order index, multiple of 20 |
| 18 | orders | Semicolon-separated rows (below), or empty for a zero-order snapshot |

Each nonempty page has exactly `min(20, total-offset)` rows; `offset < total`. A zero-order snapshot is exactly `total=0`, `offset=0`, and an empty payload (final `|`). No short, oversized or off-grid pages are accepted. A 1,000-order snapshot has 50 pages, with offsets 0 through 980. The EA freezes the account header/order rows on request and sends up to 50 pages per timer so the supported maximum fits the five-second read deadline at either sampling interval. It aborts flushing if its login changes; send backpressure retains the unsent offset for the next timer.

### Order row (exactly 14 comma-separated fields)

```text
ticket,kind,symbol,lots,openPrice,openTime,stopLoss,takeProfit,expiration,profit,swap,commission,magic,closePrice
101,0,EURUSD,0.1000000000,1.1000000000,1700000000,0.0000000000,1.2000000000,0,-1.2500000000,-0.1000000000,0.0000000000,-42,1.0900000000
```

`kind` is MT4 order type `0..5`: buy, sell, buy limit, sell limit, buy stop, sell stop. `lots` and `openPrice` are positive decimals. `stopLoss`, `takeProfit` and `closePrice` are nonnegative decimals (zero stops mean absent on the wire). `profit`, `swap` and `commission` are signed decimals. `magic` is a signed 32-bit integer; external trades are not filtered out. `openTime` is positive; `expiration` permits zero.

The parser intentionally does **not** enforce ticket uniqueness. The complete-snapshot assembler must reject duplicate tickets across **or within** pages, repeated/overlapping pages, conflicting headers and incomplete sequences before publication. Never combine Funds from one source with rows from another.

## `P`: account-scoped symbol conditions (27 fields)

App request (7 fields):

```text
P|1|session|request|login|broker|symbol
```

EA response:

```text
P|1|session|request|login|symbol|bid|ask|digits|point|tickSize|minLots|maxLots|lotStep|stopLevel|freezeLevel|tradeAllowed|quoteTime|tickValue|contractSize|marginRequired|swapLong|swapShort|swapType|profitCurrency|starting|expiration
```

| Index | Field | Rule |
| --- | --- | --- |
| 3–5 | request, login, symbol | Common rules; symbol must match the requested market during correlation |
| 6–7 | bid, ask | Positive decimals; ask ≥ bid, compared without floating-point rounding |
| 8 | digits | Integer `0..10` |
| 9–13 | point, tickSize, minLots, maxLots, lotStep | Positive decimals; maxLots ≥ minLots; lotStep ≤ maxLots |
| 14–15 | stopLevel, freezeLevel | Nonnegative signed-32-bit-range integers, in broker points |
| 16 | tradeAllowed | Boolean flag; false does not prevent reads |
| 17 | quoteTime | Positive broker seconds |
| 18 | tickValue | Nonnegative decimal, account-currency value per tick per lot |
| 19 | contractSize | Positive decimal |
| 20 | marginRequired | Nonnegative decimal |
| 21–22 | swapLong, swapShort | Signed decimals |
| 23 | swapType | MT4 integer `0..3` |
| 24 | profitCurrency | Currency text, or empty when unavailable |
| 25–26 | starting, expiration | Broker seconds; zero means unspecified |

This response contains no broker field: the original verified request/session/account binding supplies it. Conditions are readable without trading permission and on real accounts. Reading a valid response does not establish that its quote is fresh enough for a preview.

## `X`: execution result (9 fields)

```text
X|1|session|request|login|status|ticket|code|message
X|1|chart-example|0123456789abcdef0123456789abcdef|12345678|succeeded|101|0|MT4 confirmed operation
```

- `status=succeeded`: positive ticket and code `0`.
- `status=rejected`: ticket `0`, positive code (broker error or EA preflight code).
- `status=unknown`: ticket `0`, nonnegative code. This is not a retryable rejection.
- Code is an integer `0..2147483647`; message is bounded text, not a safe diagnostic excerpt.

The app-to-EA `X` command is distinct: exactly 24 fields, interpreted by `ExecuteDemo`:

```text
X|1|session|request|login|broker|action|kind|symbol|ticket|lots|price|sl|tp|expiry|slippage|cap|targetOpenTime|targetOpenPrice|targetLots|targetSL|targetTP|targetExpiry|deadline
```

Actions: `N` new, `M` modify, `C` full close, `D` pending cancellation. `expiry` and fingerprint times use broker seconds; `deadline` is the preview expiry in UTC seconds. New orders use zero target fields. Existing actions include the full original target fingerprint. `price` is the approved entry for placement, pending entry for modification, or current approved exit quote for full close. Market placement/close recheck price movement against approved slippage and pass the approved price (not a substituted current quote) to the broker operation. The cap constrains new volume only. This parser handles only the nine-field EA result and does not authorize dispatch. EA durable duplicate markers remain unchanged; never automatically resend an ambiguous execution. See [Trading request engine](trading-engine.md).

## `E`: read error (6 fields)

```text
E|1|session|request|login|message
E|1|chart-example|0123456789abcdef0123456789abcdef|12345678|Unknown symbol
```

Login is the terminal's current login, possibly `0` after account loss. An account-change error cannot be rebound to a different account/request. Error text is returned as private response data only after correct correlation, never used verbatim in rejection diagnostics.

## App correlation, assembly and privacy requirements

These are BridgeServer/service responsibilities, not parser guarantees:

1. Register reads with exact request/session/terminal/account (broker + login) and, for `P`, symbol. Require a verified current peer. Reject unsolicited, wrong-kind, mismatched and expired responses. A successful read has a five-second deadline; cached values cannot substitute for a fresh preview read.
2. Assemble `V` only under that binding, with identical header fields and exactly the declared row count/unique tickets. Publish atomically only after every page arrives. Discard partial state on timeout, disconnect or identity/session change. Financial snapshots stay in memory only.
3. Preserve dispatched `X` requests' original binding through terminal/login changes; do not reroute them or treat a late old result as a new account's result. Execution timeout is unknown, not an automatic retry.
4. Discard unused previews on identity/executor/settings changes. Latest complete single-terminal account snapshot wins; disconnected state is stale, and unavailable balances after restart are null, never fabricated zeroes.
5. Treat **all I/V/P/X/E bodies as private**, including malformed ones. Rejection excerpts retain only type/version/session, never fields after the session. Static parser errors do not solve excerpt privacy by themselves. Logs and diagnostics must mask any separately rendered login to its last four digits. Full identities belong only on authenticated surfaces and in the journal.

## TypeScript integration contract

`parseMessage(Buffer)` returns the `EAMessage` discriminated union. Account variants and limits are re-exported from `protocol.ts`:

- `AccountHello`: `type: "account-hello"`, session, login, currency, demo, enabled, ready, maxLots.
- `AccountPage`: `type: "account-page"`, session, request, login, broker, currency, demo, balance, equity, margin, freeMargin, profit, leverage, ready, capturedAt, total, offset, `orders: AccountOrder[]`.
- `AccountOrder`: ticket, kind, symbol, lots, openPrice, openTime, stopLoss, takeProfit, expiration, profit, swap, commission, magic, closePrice.
- `Conditions`: `type: "conditions"`, session, request, login, and the symbol/contract fields listed above.
- `TradeResult`: `type: "trade-result"`, session, request, login, status, ticket, code, message.
- `ReadError`: `type: "read-error"`, session, request, login, message.
- `AccountMessage` is the union of those five variants. `ORDERS_PER_PAGE=20`, `MAX_ACCOUNT_ORDERS=1000`.

Financial fields and identities are strings; flags are booleans; counts, kind, precision, leverage, magic, error codes and broker timestamps are numbers. The parser does not derive account IDs, margin level, risk or UTC timestamps.

## Account/source service

`BridgeServer.accounts` is the shared internal read/correlation foundation. It does not add public trading routes. The [request engine](trading-engine.md) owns mutation authorization and durable admission; REST and UI integrate with that engine.

- `list()` / `get(accountId)` return deduplicated identities, source connection state, the latest **complete** single-terminal snapshot, Funds, positions and pending orders. `ready` describes readiness at capture. Account provenance separates `capturedBrokerTime` (broker seconds) from `receivedAt` (UTC epoch milliseconds); conditions provenance uses `receivedAt`, since `P` supplies quote time but no separate capture clock. Values absent after restart are `null`, with `state: "unavailable"`; retained in-process snapshots become `stale` after five seconds or source retirement. Empty order collections under `unavailable` do not assert the trading account has no orders.
- `read(accountId)` requests a fresh `V` snapshot with a five-second deadline. Concurrent reads of the same source share its one frozen EA page stream and receive separate returned objects. Pages can arrive out of order, but missing, repeated, overlapping, duplicate-ticket or inconsistent pages never publish. Invalidating a read discards its pages rather than resuming it later.
- `conditions(accountId, {brokerServer, symbol})` rejects cross-broker markets. It prefers a sole executor chart even when that chart is unready or the account is real; otherwise it uses a connected source in stable terminal/session order. It never switches sources midway through a request and does not require trading permission.
- The optional `requireExecutor: true` argument to either read requires exactly one ready demo executor with a known positive EA cap, never a fallback. Permission/executor changes invalidate these reads. A fresh `V` reporting not-ready is rejected; its response is bound to the executor, even if another complete source wins ordinary account discovery ordering. This is a prerequisite for, not an authorization to send, a trade.
- `executor(accountId)` distinguishes `zero`, `multiple`, `not-ready`, `real-account` and `ready`. Source flags and the EA cap remain explicit; the app never sets MetaTrader permissions.
- `expectResult(requestId, binding)` / `onResult(listener)` retain an immutable original account/session/terminal binding for later execution evidence. They send nothing. Dispatched bindings survive revocation/login changes; unknown or mismatched results are rejected, not routed to the new login. Synchronous/asynchronous subscriber failures are contained with static diagnostic text, never exception messages containing account data. Durable request-journal recovery is the request engine's responsibility.
- `restoreResult(requestId, binding)` registers a trusted durable-journal binding without requiring its original session to be online. `dispatch(requestId, binding, wire)` is the engine's post-admission transport boundary and checks that the original source is still the unique ready executor; it cannot reassign an execution to another terminal.

Session binding is established only after verified `H` followed by `I`. A new login/server spell retires old sessions and discards partial reads; a changed login on the same session is refused and retired, never rebound. Full account identities are deliberately absent from diagnostic bridge snapshots and rejection logs.

### Durable identity only

`identity/index.ts` provides domain-separated SHA-256 IDs over exact tuples: broker server + symbol for markets, broker server + canonical login for accounts. Terminal paths and display labels are not inputs. IDs therefore survive reconnection, another supplying terminal, and reinstall even with a new app database. IDs are references, not credentials.

Schema 8 stores only known account identities and display labels in `account_identities`; no balances, positions, connection flags or source snapshots are written. The public `IdentityStore.put` / `list` interface also lets the request journal register an identity without a connected terminal. Startup loads these identities before accepting EA traffic. Financial snapshots remain in memory and must be fetched again after restart. Existing market-keyed recordings and saved history are unchanged.

### Ordinary quote sources

`selectMarketSource(snapshot, market)` chooses quoted sources within an **exact** market: connected source first, newest broker quote time, newest sample receipt time, then lexical terminal ID. A connected source without any quote cannot hide an available last-known quote. All-offline selection is explicitly last-known. Feeds remain terminal-specific; no other terminal's quote is inserted into a feed. Chart-owner handover retains that terminal's newest quote and its exact `quoteReceivedAt`; aggregate sample-health receipts from other charts cannot refresh its provenance. Ordinary REST quote reads return `marketId`, provenance, `quoteAgeMs`, `sourceSilenceMs`, `sourceSilent`, `online` and `stale`. Source silence at five seconds is independent of the broker quote age: repeated samples during a closed market do not prove disconnection. If no in-process quote remains, a recorded quote can still be read with offline/stale metadata.

### API-key scopes

Schema 7 migrates stored `read` → `readonly` and `trade` → `trader`, preserving key hashes, metadata and revocation. Unknown stored scopes grant no access. Key creation accepts only the new scope names. `readonly` cannot mutate, including preview, execution and review. `trader` includes reads and public trading mutations, but neither scope grants installation, key-management, network/security or trading-settings administration. Administrative clock-rule changes, recording controls/deletion, history saves and feed removal also remain app-window-only; remote browsers retain authenticated diagnostics. See [REST API](rest-api.md).

## Regression evidence

`tests/account-protocol.test.ts` sends malformed messages through real ZeroMQ to `BridgeServer.onChange`/rejection snapshots; valid parser calls inspect fixture shapes. `account-state.test.ts` and `account-state-edge.test.ts` exercise correlation, assembly, executor/read-only selection and retained-result binding through actual wire messages and public service results. `account-restart.test.ts` verifies the full server/database restart boundary; `identity-store.test.ts`, `market-sources.test.ts` and `api-keys-http.test.ts` cover persistence, source provenance and scope migration/denial. Source/condition fixtures are synthetic in `tests/account-fixtures.ts`. `tests/ea-wiring.test.ts` checks the bundled source's version/field ordering. These tests do not compile or execute MetaTrader; MetaEditor compilation and user-performed demo acceptance remain separate release steps.
