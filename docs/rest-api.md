# REST API v1

The public API for the `mt4-quote-bridge` CLI and your own scripts: exact market, account, terminal and trading-request
resources. It answers on the app's HTTP port (shown in Settings), on `127.0.0.1` only, under `/api/v1`.

This is a clean-slate contract. It replaced the earlier legacy-compatible read API (`/symbols…`, `/history…`,
`/indicators/:name/:symbol`) with no adapters: those paths now answer `404 unknown-route`. The data behind it is
unchanged: candles, history and exports come from the same chart history and History-page pipeline as the app
window (see [Chart history](#chart-history)), and indicator values from the same calculation cache as the charts.

Every example on this page is executable: the test suite replays each request and response below against a
running server. `<any>` stands for any value; `<$name>` for a value kept as `{name}` in later examples.

## Authentication and scopes

- Create a key in the **app window › Settings › API keys** with scope `readonly` or `trader`. The app shows the key
  once. Send it as `Authorization: Bearer qbk_…`.
- `readonly` reads everything below but [screenshots](#screenshots). `trader` reads too, takes screenshots, and may
  preview, execute and review trading requests. A `readonly` key on anything but `GET` or `HEAD`, or on a screenshot,
  answers `403 insufficient-scope`.
- A missing, unknown or revoked key answers `401 unauthenticated`. The key and its current scope are checked on
  every request, including a repeated execute.
- No key administers the app. Installation and setup, API keys, network settings, recording and trading enablement,
  lot cap and slippage are the app window's alone.
- Previews have no owner: any `trader` key, or the app window, may execute a valid preview.
- `GET /api/v1/info` is public. `GET /api/auth/session` (outside v1) tells the CLI whose key it holds:
  `{ username, key: { name, prefix, scope }, expires: null }`.

```http
GET /api/v1/info
```

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8

{ "data": { "service": "mt4-quote-bridge", "apiVersion": 1 }, "meta": {} }
```

## Conventions

**Envelopes.** Success answers `{ "data": …, "meta": { … } }`; a collection's `data` is an array. Errors answer
`{ "error": { "code", "message", "details" } }`: `code` is stable (see [Error codes](#error-codes)), `message`
is for people and may change, `details` is null or an object such as the offending `parameter`. Exports are
files, not envelopes; their errors are still structured.

**Identities.** Markets, accounts, terminals, feeds, indicator packages and requests are named by exact,
opaque, stable string IDs; tickets are strings. Nothing is matched by case, substring, readable label or
default: a market is one broker server and one symbol exactly (`EURUSD` and `eurusd` are two markets), an account
is one broker server and one login, however many terminals share it. IDs are references, not secrets. Discovery
answers the readable fields (`brokerServer`, `symbol`, `login`, `label`) beside them.

**Numbers.** Prices, lots and money are decimal strings (`"1.10015"`, `"0.1"`, `"-1.25"`), never JSON numbers.
Quote and candle prices have the market's `digits`; account values are as the terminal reports them, without
trailing zeros, with the account's `currency`. Counts, digits, points and leverage are integers. Unavailable values
are `null`, never zero. String encoding does not make a value more precise than its source: candles and indicator
values are the app's calculated doubles written out exactly.

**Times.** Every time is UTC ISO-8601 (`"2027-01-15T08:00:00.000Z"`). Where MetaTrader stamps broker time,
a sibling `brokerTime` (or `…BrokerTime`) gives the broker server's wall clock without an offset
(`"2027-01-15T10:00:00"`). UTC comes from the broker server's clock rule (Terminals view); while a rule is unknown,
broker time is taken as UTC. Time parameters take UTC as `YYYY-MM-DDTHH:MM:SS[.sss]Z` only.

**Parameters.** A resource refuses parameters it does not take (`400 unknown-parameter`), so there is no symbol
search, broker substring, terminal or feed override and no data-source selector on ordinary reads.

**Paging.** Discovery and journal collections are cursor-paged: `limit` (100 by default, 500 at most) and the
`cursor` from `meta.nextCursor`, null on the last page. Their order is stable and nothing is skipped or repeated
while items are added. Samples are cursor-paged too (1,000 by default, 10,000 at most), stable even where samples
share a time. Candles and indicator values are time-paged: the newest `limit` bars within `from`/`to`, oldest first;
`meta.next.to` is the `to` of the page before, null once `from` or the oldest bar is reached.

**Status codes.** `400` malformed request, `401` unauthenticated, `403` forbidden (scope, demo-only, trading off),
`404` unknown resource or route, `405` wrong method, `409` ambiguity, conflict, an expired or invalidated preview, or a busy app window,
`413`/`415` body too large or not JSON, `422` invalid trading or indicator values, `503` source or app window unavailable,
`504` the terminal did not answer within five seconds, or a screenshot took more than ten.

## Markets

| Endpoint | Answer |
| --- | --- |
| `GET /markets` | Every known market: with a feed now, recorded, saved or in a terminal's HST folder; by symbol, then broker server. Exact filters `brokerServer` and `symbol`; cursor-paged. |
| `GET /markets/{marketId}` | One market: `{ id, brokerServer, symbol, label, digits, connected, recording, sources: [{ terminalId, feedId, connected }] }`. |
| `GET /markets/{marketId}/quote` | The best source's quote with provenance and freshness. |
| `GET /markets/{marketId}/candles` | `timeframe` (required), `from`, `to`, `limit` (900; 1–5000). |
| `GET /markets/{marketId}/samples` | Recorded samples: `from`, `to`, `limit` (1000; 1–10,000), `cursor`. |
| `GET /markets/{marketId}/history` | Closed-bar coverage per timeframe. |
| `GET /markets/{marketId}/export` | A file: `timeframe` and `format` (`csv` or `hst`) required, `from`, `to`. |
| `GET /markets/{marketId}/indicators/{packageId}` | An indicator's values: as candles, plus `p.<parameter>`. |

`timeframe` is one of `M1 M5 M15 M30 H1 H4 D1 W1 MN1`, exactly.

```http
GET /api/v1/markets?brokerServer=EasyForex-Demo
Authorization: Bearer <readonly key>
```

```http
HTTP/1.1 200 OK

{
  "data": [
    {
      "id": "{market}",
      "brokerServer": "EasyForex-Demo",
      "symbol": "EURUSD",
      "label": "EURUSD · EasyForex-Demo",
      "digits": 5,
      "connected": true,
      "recording": true,
      "sources": [{ "terminalId": "mt4-aaaaaaaaaaaa", "feedId": "[\"mt4-aaaaaaaaaaaa\",\"EURUSD\"]", "connected": true }]
    }
  ],
  "meta": { "count": 1, "limit": 100, "nextCursor": null }
}
```

### Quote

Within one exact market, the source is the connected one with the newest broker quote time, then the newest
receipt, then the lowest terminal ID; it fails over automatically. Offline, the last-known quote answers with
`state: "last-known"`; with no feed, the last recorded sample with `state: "recorded"` and null terminal
provenance; with neither, `503 quote-unavailable`. `quoteAgeMs` is the broker quote's age; `sourceSilenceMs` is the
time since the source's last samples (silent at five seconds). A weekend's old quote is not a disconnection.
`stale` is true when offline, silent or when the quote time has not moved for ten seconds. Feeds of one terminal are
under [Terminals](#terminals); this resource is not execution routing.

```http
GET /api/v1/markets/{market}/quote
Authorization: Bearer <readonly key>
```

```http
HTTP/1.1 200 OK

{
  "data": {
    "marketId": "{market}",
    "brokerServer": "EasyForex-Demo",
    "symbol": "EURUSD",
    "digits": 5,
    "bid": "1.10000",
    "ask": "1.10015",
    "spread": "15.0",
    "time": "2027-01-15T08:00:00.000Z",
    "brokerTime": "2027-01-15T10:00:00",
    "state": "connected",
    "stale": false,
    "quoteAgeMs": 0,
    "sourceSilenceMs": 0,
    "sourceSilent": false,
    "provenance": { "terminalId": "mt4-aaaaaaaaaaaa", "feedId": "[\"mt4-aaaaaaaaaaaa\",\"EURUSD\"]", "receivedAt": "2027-01-15T08:00:00.000Z" }
  },
  "meta": {}
}
```

`spread` is in points.

### Candles

The chart's bars, as the Charts view shows them, oldest first: the newest `limit` whose start is from `from` to
`to`. The newest live candle is still forming: `complete: false`. `meta.source` is the feed whose chart history
answered, null for a market known from HST files and saved history alone.

```http
GET /api/v1/markets/{market}/candles?timeframe=H1&limit=2
Authorization: Bearer <readonly key>
```

```http
HTTP/1.1 200 OK

{
  "data": [
    { "time": "2027-01-15T07:00:00.000Z", "brokerTime": "2027-01-15T09:00:00", "open": "1.10020", "high": "1.10070", "low": "1.10000", "close": "1.10050", "complete": true },
    { "time": "2027-01-15T08:00:00.000Z", "brokerTime": "2027-01-15T10:00:00", "open": "1.10000", "high": "1.10000", "low": "1.10000", "close": "1.10000", "complete": false }
  ],
  "meta": {
    "marketId": "{market}",
    "timeframe": "H1",
    "digits": 5,
    "source": { "terminalId": "mt4-aaaaaaaaaaaa", "feedId": "[\"mt4-aaaaaaaaaaaa\",\"EURUSD\"]" },
    "count": 2,
    "limit": 2,
    "next": { "to": "2027-01-15T06:59:59.000Z" }
  }
}
```

To page back, ask again with `to` set to `meta.next.to`.

```http
GET /api/v1/markets/{market}/candles?timeframe=1H
Authorization: Bearer <readonly key>
```

```http
HTTP/1.1 400 Bad Request

{
  "error": {
    "code": "invalid-timeframe",
    "message": "timeframe must be one of M1, M5, M15, M30, H1, H4, D1, W1, MN1.",
    "details": { "parameter": "timeframe", "allowed": ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN1"] }
  }
}
```

### Samples

A recorded market's samples (switch recording on in the app's Feeds view), oldest first; samples of one second are
in one stable order. `from` and `to` are inclusive. The cursor resumes exactly after the last sample given; send it
with the same `from` and `to` (another market or other bounds answer `400 invalid-cursor`).

```http
GET /api/v1/markets/{market}/samples?limit=10
Authorization: Bearer <readonly key>
```

```http
HTTP/1.1 200 OK

{
  "data": [
    { "time": "2027-01-15T08:00:00.000Z", "brokerTime": "2027-01-15T10:00:00", "bid": "1.10000", "ask": "1.10015", "receivedAt": "2027-01-15T08:00:00.000Z" }
  ],
  "meta": { "marketId": "{market}", "digits": 5, "count": 1, "limit": 10, "nextCursor": null }
}
```

### History and export

`history` lists each timeframe with closed bars: MetaTrader's HST file joined with the app's saved history, as the
History page shows it. It answers with no terminal running once history is saved.

```http
GET /api/v1/markets/{market}/history
Authorization: Bearer <readonly key>
```

```http
HTTP/1.1 200 OK

{
  "data": {
    "marketId": "{market}",
    "digits": 5,
    "timeframes": [
      { "timeframe": "H1", "bars": 3, "from": "2027-01-15T05:00:00.000Z", "fromBrokerTime": "2027-01-15T07:00:00", "to": "2027-01-15T07:00:00.000Z", "toBrokerTime": "2027-01-15T09:00:00" }
    ]
  },
  "meta": {}
}
```

`export` downloads the same file the History page does, through the same pipeline, never the forming candle:
`csv` with broker time and a UTC column, or `hst` (MetaTrader's v401 format, broker time). `from` and `to` keep only
the bars that start between them. The file is streamed whole; there is no row limit.

```http
GET /api/v1/markets/{market}/export?timeframe=H1&format=csv
Authorization: Bearer <readonly key>
```

```http
HTTP/1.1 200 OK
Content-Type: text/csv; charset=utf-8
Content-Disposition: attachment; filename*=UTF-8''EURUSD60.csv

time,open,high,low,close,tick_volume,spread,real_volume,time_utc
2027-01-15 07:00:00,1.10000,1.10050,1.09980,1.10030,10,0,0,2027-01-15T05:00:00Z
2027-01-15 08:00:00,1.10010,1.10060,1.09990,1.10040,11,0,0,2027-01-15T06:00:00Z
2027-01-15 09:00:00,1.10020,1.10070,1.10000,1.10050,12,0,0,2027-01-15T07:00:00Z
```

### Indicator values

The values of an enabled package (see [Indicators](#indicators)) over exactly the bars `candles` answers for the same
`timeframe`, `from`, `to` and `limit`, read from the cache the charts use: the CLI gets the very values a chart
shows. Parameters are `p.<id>`; any left out take their defaults, and a value out of range answers
`400 invalid-indicator-parameter`.

- The package also runs over the warm-up bars it declares before the first bar, so the first value is as correct
  as the last. `meta.barsUsed` is how many bars it ran over.
- A closed-bars-only package has no row for the forming bar.
- A value is the calculated double written out exactly, the shortest decimal that reads back as the same number
  (`"1.1004500000000002"`): round it to the market's digits for display.
- A value is `null` where the package has none (during its warm-up, for instance). `styles` appears for outputs
  coloured by style, such as rising and falling.
- Values need a terminal's chart of the market (`503 feed-required` without one). A calculation that throws, runs
  too long or returns bad values answers `422 indicator-failed` with the reason in `details`.

```http
GET /api/v1/markets/{market}/indicators/quotebridge.ma?timeframe=H1&limit=2&p.period=2
Authorization: Bearer <readonly key>
```

```http
HTTP/1.1 200 OK

{
  "data": [
    { "time": "2027-01-15T07:00:00.000Z", "brokerTime": "2027-01-15T09:00:00", "complete": true, "values": { "ma": "1.1004500000000002" } },
    { "time": "2027-01-15T08:00:00.000Z", "brokerTime": "2027-01-15T10:00:00", "complete": false, "values": { "ma": "1.1002500000000002" } }
  ],
  "meta": {
    "marketId": "{market}",
    "indicatorId": "quotebridge.ma",
    "version": "1.0.0",
    "parameters": { "period": 2, "type": "simple" },
    "outputs": [{ "id": "ma", "label": "MA" }],
    "timeframe": "H1",
    "source": { "terminalId": "mt4-aaaaaaaaaaaa", "feedId": "[\"mt4-aaaaaaaaaaaa\",\"EURUSD\"]" },
    "count": 2,
    "limit": 2,
    "barsUsed": 4,
    "next": { "to": "2027-01-15T06:59:59.000Z" }
  }
}
```

## Accounts

| Endpoint | Answer |
| --- | --- |
| `GET /accounts` | Known trading accounts, by broker server and login; cursor-paged. |
| `GET /accounts/{accountId}` | One account's identity, connection and sources. |
| `GET /accounts/{accountId}/funds` | Balance, equity, margin, free margin, margin level, profit, currency, leverage and freshness. |
| `GET /accounts/{accountId}/positions[/{ticket}]` | Open positions only; cursor-paged by ticket. |
| `GET /accounts/{accountId}/orders[/{ticket}]` | Pending limit and stop orders only; cursor-paged by ticket. |
| `GET /accounts/{accountId}/markets/{marketId}/conditions` | The market's contract data from the account's terminal. |

An account is one broker server and login; another terminal on it adds a source, not an account. There is no
active or default account. Accounts the app has seen stay listed after a restart, offline: `connected: false`,
`state: "unavailable"` and null Funds until a terminal reconnects. Funds, positions and orders are read fresh from one
connected terminal of the account (never balance from one terminal with positions from another), within five
seconds (`504 read-timeout`); offline they answer the last complete snapshot with `state: "stale"`, or nulls.
Financial snapshots are kept in memory only.

`executor` says whether the account can trade: `ready` when exactly one connected chart has demo trading
enabled and ready, else `zero`, `multiple`, `not-ready` or `real-account`. A real account is `real-account` however
many of its charts have demo trading enabled: it is readable but never trades.

```http
GET /api/v1/accounts
Authorization: Bearer <readonly key>
```

```http
HTTP/1.1 200 OK

{
  "data": [
    {
      "id": "{account}",
      "brokerServer": "EasyForex-Demo",
      "login": "876543219",
      "label": "EasyForex-Demo · 876543219",
      "demo": true,
      "connected": true,
      "state": "unavailable",
      "currency": "USD",
      "executor": { "state": "ready", "terminalId": "mt4-aaaaaaaaaaaa" },
      "sources": [{ "terminalId": "mt4-aaaaaaaaaaaa", "connected": true, "executorEnabled": true, "ready": true, "maxLots": "0.5" }]
    }
  ],
  "meta": { "count": 1, "limit": 100, "nextCursor": null }
}
```

```http
GET /api/v1/accounts/{account}/funds
Authorization: Bearer <readonly key>
```

```http
HTTP/1.1 200 OK

{
  "data": {
    "accountId": "{account}",
    "currency": "USD",
    "balance": "1000",
    "equity": "999",
    "margin": "10",
    "freeMargin": "989",
    "marginLevel": "9990",
    "profit": "-1",
    "leverage": 100,
    "state": "fresh",
    "capturedAt": "2027-01-15T08:00:00.000Z",
    "capturedBrokerTime": "2027-01-15T10:00:00",
    "receivedAt": "2027-01-15T08:00:00.000Z",
    "terminalId": "mt4-aaaaaaaaaaaa"
  },
  "meta": {}
}
```

`marginLevel` is a percentage, null without margin in use.

### Positions and pending orders

Tickets are MetaTrader's and are unique only within an account: always address one under its account. Trades
placed outside QuoteBridge are listed too. MetaTrader's zero stop loss, take profit or expiry is `null`.

```http
GET /api/v1/accounts/{account}/positions
Authorization: Bearer <readonly key>
```

```http
HTTP/1.1 200 OK

{
  "data": [
    {
      "ticket": "12345",
      "accountId": "{account}",
      "marketId": "{market}",
      "symbol": "EURUSD",
      "side": "buy",
      "lots": "0.1",
      "stopLoss": null,
      "takeProfit": null,
      "magic": -42,
      "openPrice": "1.1",
      "openTime": "2023-11-14T20:13:20.000Z",
      "openBrokerTime": "2023-11-14T22:13:20",
      "currentPrice": "1.09",
      "profit": "-1.25",
      "swap": "0",
      "commission": "0"
    }
  ],
  "meta": { "accountId": "{account}", "currency": "USD", "state": "fresh", "count": 1, "limit": 100, "nextCursor": null }
}
```

```http
GET /api/v1/accounts/{account}/orders/12346
Authorization: Bearer <readonly key>
```

```http
HTTP/1.1 200 OK

{
  "data": {
    "ticket": "12346",
    "accountId": "{account}",
    "marketId": "{market}",
    "symbol": "EURUSD",
    "side": "buy",
    "type": "limit",
    "lots": "0.1",
    "stopLoss": null,
    "takeProfit": null,
    "magic": -42,
    "price": "1.1",
    "placedAt": "2023-11-14T20:13:20.000Z",
    "placedBrokerTime": "2023-11-14T22:13:20",
    "expiry": null,
    "expiryBrokerTime": null,
    "currentPrice": "1.09"
  },
  "meta": { "currency": "USD", "state": "fresh" }
}
```

### Conditions

A market's contract data, read from the account's terminal: its trading chart when there is one, else another
connected chart of the account. Reading needs no trading permission and works on real accounts. The market must be
on the account's broker server.

```http
GET /api/v1/accounts/{account}/markets/{market}/conditions
Authorization: Bearer <readonly key>
```

```http
HTTP/1.1 200 OK

{
  "data": {
    "accountId": "{account}",
    "marketId": "{market}",
    "symbol": "EURUSD",
    "bid": "1.1",
    "ask": "1.10002",
    "digits": 5,
    "point": "0.00001",
    "tickSize": "0.00001",
    "minLots": "0.01",
    "maxLots": "100",
    "lotStep": "0.01",
    "stopLevel": 10,
    "freezeLevel": 5,
    "tradeAllowed": true,
    "quoteTime": "2027-01-15T08:00:00.000Z",
    "quoteBrokerTime": "2027-01-15T10:00:00",
    "tickValue": "1",
    "contractSize": "100000",
    "marginRequired": "1000",
    "swapLong": "-1.25",
    "swapShort": "0.5",
    "swapType": 0,
    "profitCurrency": "USD",
    "terminalId": "mt4-aaaaaaaaaaaa",
    "receivedAt": "2027-01-15T08:00:00.000Z"
  },
  "meta": {}
}
```

`stopLevel` and `freezeLevel` are in points; `marginRequired` is per lot in the account's currency.

```http
GET /api/v1/accounts/{account}/markets/{realMarket}/conditions
Authorization: Bearer <readonly key>
```

```http
HTTP/1.1 409 Conflict

{
  "error": {
    "code": "cross-broker-market",
    "message": "This market is on another broker server than the account. Use the account's own broker server's market.",
    "details": { "accountBrokerServer": "EasyForex-Demo", "marketBrokerServer": "EasyForex-Real" }
  }
}
```

## Indicators

`GET /indicators` lists the enabled packages by ID (cursor-paged); `GET /indicators/{packageId}` describes one.
IDs are exact (`quotebridge.macd`, not `macd`); a disabled or unknown package answers `404 unknown-indicator`. A
parameter is `{ id, label, type, default, min, max, lessThan? }`, or `{ id, label, type: "choice", default,
choices: [{ value, label }] }`. An output's `styles` are the keys of its `styles` values, or null.

```http
GET /api/v1/indicators/quotebridge.ma
Authorization: Bearer <readonly key>
```

```http
HTTP/1.1 200 OK

{
  "data": {
    "id": "quotebridge.ma",
    "version": "1.0.0",
    "name": "Moving average",
    "description": "<any>",
    "placement": "overlay",
    "closedBarsOnly": false,
    "parameters": [
      { "id": "period", "label": "Period", "type": "integer", "default": 20, "min": 1, "max": 500 },
      { "id": "type", "label": "Type", "type": "choice", "default": "simple", "choices": [{ "value": "simple", "label": "Simple" }, { "value": "exponential", "label": "Exponential" }] }
    ],
    "outputs": [{ "id": "ma", "label": "MA", "render": "line", "styles": null }],
    "hash": "<any>"
  },
  "meta": {}
}
```

## Terminals

Read-only diagnostics: `GET /terminals[/{terminalId}]` and `GET /terminals/{terminalId}/feeds[/{feedId}]`. A
terminal's feeds are its own charts' health and quotes, never another terminal's, and never used to route trading.
`connected` is a hello within the last seven seconds. Percent-encode a feed ID in the path.

```http
GET /api/v1/terminals/{terminal}
Authorization: Bearer <readonly key>
```

```http
HTTP/1.1 200 OK

{
  "data": { "id": "mt4-aaaaaaaaaaaa", "name": "mt4-aaaaaaaaaaaa", "brokerServer": "EasyForex-Demo", "eaVersion": "<any>", "connected": true, "lastHelloAt": "2027-01-15T08:00:00.000Z", "feeds": 1 },
  "meta": {}
}
```

```http
GET /api/v1/terminals/{terminal}/feeds/{feed}
Authorization: Bearer <readonly key>
```

```http
HTTP/1.1 200 OK

{
  "data": {
    "id": "[\"mt4-aaaaaaaaaaaa\",\"EURUSD\"]",
    "terminalId": "mt4-aaaaaaaaaaaa",
    "marketId": "{market}",
    "brokerServer": "EasyForex-Demo",
    "symbol": "EURUSD",
    "digits": 5,
    "timeframe": "<any>",
    "online": true,
    "stale": false,
    "instances": 1,
    "quoteStatus": "ok",
    "recording": true,
    "bid": "1.10000",
    "ask": "1.10015",
    "time": "2027-01-15T08:00:00.000Z",
    "brokerTime": "2027-01-15T10:00:00",
    "receivedAt": "2027-01-15T08:00:00.000Z"
  },
  "meta": {}
}
```

## Trading requests

Every change to an account goes through a request: preview it, then execute that exact preview. Only demo accounts
trade, with **Demo trading** switched on in the app window's Settings and exactly one chart per account enabled for
it. MetaTrader's own permissions are yours to set; the app never changes them.

| Endpoint | Answer |
| --- | --- |
| `POST /requests/preview` | A single-use preview of a place, modify, close or cancel (`201`). |
| `POST /requests/{requestId}/execute` | `{ "confirm": true }`: `202` once dispatched; a repeat answers the same record (`200`) and sends nothing. |
| `GET /requests` | The journal of executed requests, oldest first; exact `accountId` filter; cursor-paged. |
| `GET /requests/{requestId}` | A request's record, or its preview while still valid. |
| `POST /requests/{requestId}/review` | `{ "note", "acknowledged": true }` for an unknown outcome. |

### Preview

Every preview names its account. A new order (`action: "place"`) names an exact `marketId` on the account's broker
server (`409 cross-broker-market` otherwise), `side` (`buy`, `sell`), `type` (`market`, `limit`, `stop`) and
`lots`. A limit or stop needs `price` and may have a UTC `expiry` (whole seconds). Stops are either absolute
`stopLoss`/`takeProfit`, or a `risk` plan — never both: `{ "loss": { "amount" | "balancePercent" | "points": "…" },
"rewardRatio": "…" }`, from which the stops are worked out for the given lots, rounded toward entry; a plan that
cannot be met is refused rather than widened. A third form is stop distances: `distance: { "stopLoss"?: "…",
"takeProfit"?: "…" }` in points from the previewed entry (below it for a buy's stop loss, above for a sell's, and the
reverse for a take profit), at least one of them, rounded toward entry the same way (`unsatisfiable-distance` when a
distance reaches past zero or rounds to the entry). Only one form per order. Estimates exclude fees, swaps and slippage
and are not loss caps.

Existing trades are named by account and ticket: `modify` (`price` and `expiry` of a pending order, `stopLoss`,
`takeProfit`; left out stays, `null` clears, zero is not a clear), `close` (a whole position) and `cancel` (a
pending order). There are no lot changes or partial closes. Trades placed outside QuoteBridge can be managed too,
with a warning.

The app reads the account and contract fresh from the account's trading chart (five seconds at most), checks lots
against the broker's steps and the smallest of the broker's, the EA's and the app's caps (caps do not stop managing
a larger existing trade), tick size, stop and freeze levels and margin, and answers the normalized intent the
execute will send. A preview lasts 30 seconds, lives in memory only and is invalidated by a change of settings,
account, terminal or chart. Nothing is sent to MetaTrader.

```http
POST /api/v1/requests/preview
Authorization: Bearer <readonly key>
Content-Type: application/json

{ "accountId": "{account}", "action": "place", "marketId": "{market}", "side": "buy", "type": "market", "lots": "0.10" }
```

```http
HTTP/1.1 403 Forbidden

{ "error": { "code": "insufficient-scope", "message": "This API key may only read. Create a key with the trader scope to send changes.", "details": null } }
```

```http
POST /api/v1/requests/preview
Authorization: Bearer <trader key>
Content-Type: application/json

{ "accountId": "{account}", "action": "place", "marketId": "{market}", "side": "buy", "type": "market", "lots": "0.10" }
```

```http
HTTP/1.1 201 Created

{
  "data": {
    "requestId": "<$requestId>",
    "status": "preview",
    "createdAt": "2027-01-15T08:00:00.000Z",
    "expiresAt": "2027-01-15T08:00:30.000Z",
    "accountId": "{account}",
    "marketId": "{market}",
    "terminalId": "mt4-aaaaaaaaaaaa",
    "normalizedIntent": { "action": "place", "ticket": null, "symbol": "EURUSD", "side": "buy", "type": "market", "lots": "0.1", "price": "1.10002", "stopLoss": null, "takeProfit": null, "expiry": null, "slippage": 20 },
    "target": null,
    "limits": { "broker": "100", "ea": "0.5", "app": "1", "maxLots": "0.5" },
    "estimates": "<any>",
    "warnings": "<any>"
  },
  "meta": {}
}
```

`slippage` is in points, from Settings. A market order's `price` is the quote the preview approved; the EA keeps
within that price and slippage. A fill is not guaranteed.

```http
GET /api/v1/requests/{requestId}
Authorization: Bearer <readonly key>
```

```http
HTTP/1.1 200 OK

{
  "data": {
    "requestId": "{requestId}",
    "status": "preview",
    "createdAt": "2027-01-15T08:00:00.000Z",
    "expiresAt": "2027-01-15T08:00:30.000Z",
    "accountId": "{account}",
    "marketId": "{market}",
    "terminalId": "mt4-aaaaaaaaaaaa",
    "normalizedIntent": "<any>",
    "target": null,
    "limits": "<any>",
    "estimates": "<any>",
    "warnings": "<any>"
  },
  "meta": {}
}
```

### Existing trades

```http
POST /api/v1/requests/preview
Authorization: Bearer <trader key>
Content-Type: application/json

{ "accountId": "{account}", "action": "close", "ticket": "12345" }
```

```http
HTTP/1.1 201 Created

{
  "data": {
    "requestId": "<any>",
    "status": "preview",
    "createdAt": "2027-01-15T08:00:00.000Z",
    "expiresAt": "2027-01-15T08:00:30.000Z",
    "accountId": "{account}",
    "marketId": "{market}",
    "terminalId": "mt4-aaaaaaaaaaaa",
    "normalizedIntent": "<any>",
    "target": {
      "ticket": "12345",
      "symbol": "EURUSD",
      "side": "buy",
      "type": "market",
      "lots": "0.1",
      "openPrice": "1.1",
      "openTime": "2023-11-14T20:13:20.000Z",
      "stopLoss": null,
      "takeProfit": null,
      "expiry": null
    },
    "limits": "<any>",
    "estimates": "<any>",
    "warnings": "<any>"
  },
  "meta": {}
}
```

`target` is the trade as the preview saw it; if it changes before execute, execute refuses (`409 target-changed`)
and a new preview is needed.

### Execute

Execute re-reads the account and contract and checks again that the approved intent still holds, then records the
request durably **before** sending it. It answers `202` with status `dispatching` once sent; the result follows.
At most one request per account is unresolved at a time (`409 account-unresolved`, also for a preview on that account
while one is); other accounts are independent.

- Never retry an execute to find out what happened, and never preview the same order again for that: **GET the
  same request ID**. A repeated execute answers the existing record (`200`) and sends nothing.
- Outcomes: `dispatching`, `succeeded`, `failed` (a definitive refusal, with the broker's code and message) or
  `unknown`. Twenty seconds without a definitive result, a send that may have been interrupted, or a restart while
  dispatching make it `unknown`. The app never resends anything.

```http
POST /api/v1/requests/{requestId}/execute
Authorization: Bearer <trader key>
Content-Type: application/json

{ "confirm": true }
```

```http
HTTP/1.1 202 Accepted

{
  "data": {
    "requestId": "{requestId}",
    "status": "dispatching",
    "reviewed": false,
    "origin": "api-key",
    "createdAt": "2027-01-15T08:00:00.000Z",
    "updatedAt": "2027-01-15T08:00:00.000Z",
    "accountId": "{account}",
    "marketId": "{market}",
    "terminalId": "mt4-aaaaaaaaaaaa",
    "normalizedIntent": "<any>",
    "target": null,
    "limits": "<any>",
    "estimates": "<any>",
    "warnings": "<any>",
    "result": null,
    "events": []
  },
  "meta": {}
}
```

```http
POST /api/v1/requests/{requestId}/execute
Authorization: Bearer <trader key>
Content-Type: application/json

{ "confirm": true }
```

```http
HTTP/1.1 200 OK

{
  "data": {
    "requestId": "{requestId}",
    "status": "dispatching",
    "reviewed": false,
    "origin": "api-key",
    "createdAt": "2027-01-15T08:00:00.000Z",
    "updatedAt": "2027-01-15T08:00:00.000Z",
    "accountId": "{account}",
    "marketId": "{market}",
    "terminalId": "mt4-aaaaaaaaaaaa",
    "normalizedIntent": "<any>",
    "target": null,
    "limits": "<any>",
    "estimates": "<any>",
    "warnings": "<any>",
    "result": null,
    "events": []
  },
  "meta": {}
}
```

A record's `result` is the definitive or latest result: `{ status, ticket, code, message }`, `ticket` null when
MetaTrader confirmed none. `events` is the append-only evidence: `result`, `unknown` (with its `reason`) and
`review` events, each with its time `at`. Records are kept indefinitely.

```http
GET /api/v1/requests?accountId={account}
Authorization: Bearer <readonly key>
```

```http
HTTP/1.1 200 OK

{
  "data": [
    {
      "requestId": "{requestId}",
      "status": "dispatching",
      "reviewed": false,
      "origin": "api-key",
      "createdAt": "2027-01-15T08:00:00.000Z",
      "updatedAt": "2027-01-15T08:00:00.000Z",
      "accountId": "{account}",
      "marketId": "{market}",
      "terminalId": "mt4-aaaaaaaaaaaa",
      "normalizedIntent": "<any>",
      "target": null,
      "limits": "<any>",
      "estimates": "<any>",
      "warnings": "<any>",
      "result": null,
      "events": []
    }
  ],
  "meta": { "count": 1, "limit": 100, "nextCursor": null }
}
```

### Review

An `unknown` outcome blocks its account, previews included, until a definitive result arrives or someone reviews it. First check
MetaTrader's open orders and account history; then review with a note of 8–500 characters and
`acknowledged: true`. Review works with Demo trading off. It does not invent an outcome (the status stays `unknown`,
`reviewed` becomes true) and never resends; a late result can still settle the record.

```http
POST /api/v1/requests/{requestId}/review
Authorization: Bearer <trader key>
Content-Type: application/json

{ "note": "Checked MT4 open orders and history", "acknowledged": true }
```

```http
HTTP/1.1 409 Conflict

{ "error": { "code": "request-not-unknown", "message": "Only a request whose outcome is unknown can be reviewed.", "details": null } }
```

## Screenshots

`GET /screenshots/feeds` shows that the app is running normally: it switches **your own app window** to the Feeds
view, captures it and answers the image with the window's health. The window is left on Feeds. It is captured
whether it is shown, minimised or hidden in the tray, without being shown or focused, and is left that way. It needs
a `trader` key, because it changes the window; a `readonly` key answers `403 insufficient-scope`.

| Field | Value |
| --- | --- |
| `view` | `feeds` |
| `window` | How the window was: `visible`, `minimised` or `hidden` (in the tray). |
| `width`, `height`, `scale` | The image's size in the window's own physical pixels, at its display's scale. |
| `live` | The page's link to the app: `live`, `connecting`, `reconnecting` or `session-ended`. |
| `capturedAt` | When the image was taken. |
| `contentType`, `png` | `image/png`, and the image in base64. |

```http
GET /api/v1/screenshots/feeds
Authorization: Bearer <trader key>
```

```http
HTTP/1.1 200 OK

{
  "data": { "view": "feeds", "window": "hidden", "width": 1800, "height": 1200, "scale": 1.5, "live": "live", "capturedAt": "2027-01-15T08:00:00.000Z", "contentType": "image/png", "png": "<any>" },
  "meta": {}
}
```

With `?format=png` the answer is the image itself (`Content-Type: image/png`) and the fields are headers:
`X-QuoteBridge-View`, `-Window`, `-Width`, `-Height`, `-Scale`, `-Live` and `-Captured-At`.

One screenshot is taken at a time; others wait their turn. Each has ten seconds.

| Refusal | When |
| --- | --- |
| `409 window-busy` | A dialog is open in the window (an order, close, modify or review dialog, or the setup screen). The message names it. Nothing is switched and no image is taken. |
| `503 window-unavailable` | There is no window to capture: the app is still starting, the window is being recreated after a crash, or the server runs without the app (a development run in a browser tab). |
| `504 screenshot-timeout` | The window was not captured within ten seconds; so too while the Terminals view's Remove confirmation is open, which stops the page answering. A hidden window is hidden again. |

```http
GET /api/v1/screenshots/feeds
Authorization: Bearer <readonly key>
```

```http
HTTP/1.1 403 Forbidden

{ "error": { "code": "insufficient-scope", "message": "A screenshot switches the app window's view: use a key with the trader scope.", "details": null } }
```

## Error codes

| Code | Status | Meaning |
| --- | --- | --- |
| `invalid-parameter`, `unknown-parameter`, `invalid-time`, `invalid-timeframe`, `invalid-format`, `invalid-cursor`, `invalid-path`, `invalid-ticket`, `invalid-request-id` | 400 | A query or path value is malformed or not taken. |
| `invalid-json`, `invalid-input`, `unknown-property`, `invalid-action`, `confirmation-required` | 400 | A body is malformed, has an unknown field, or execute lacks `{ "confirm": true }`. |
| `invalid-indicator-parameter` | 400 | An indicator parameter is unknown or out of range. |
| `unauthenticated` | 401 | No valid key or session. |
| `insufficient-scope`, `forbidden-origin`, `not-authorized` | 403 | The key may only read, or the session may not change this. |
| `trading-disabled`, `demo-only`, `trading-not-allowed` | 403 | Demo trading is off, the account is real, or the broker does not allow trading the symbol. |
| `unknown-route`, `unknown-market`, `unknown-account`, `unknown-position`, `unknown-order`, `unknown-terminal`, `unknown-feed`, `unknown-indicator`, `request-not-found`, `no-candles`, `no-history` | 404 | No such resource. |
| `method-not-allowed` | 405 | Use the method the message names. |
| `cross-broker-market` | 409 | The market is not on the account's broker server. |
| `preview-unavailable`, `preview-expired`, `preview-invalidated`, `settings-changed`, `executor-changed`, `identity-changed`, `limits-changed`, `target-changed`, `price-changed`, `estimates-changed`, `expiry-conversion-changed`, `stale-snapshot`, `stale-quote` | 409 | The preview no longer holds: preview again. |
| `account-unresolved` | 409 | The account has a request without a definitive result: GET it, and review it if unknown. |
| `executor-zero`, `executor-multiple`, `executor-not-ready`, `executor-real-account`, `executor-unavailable` | 409 | The account has no single ready demo trading chart, or is a real account (`executor-real-account`), which never trades. |
| `window-busy` | 409 | A dialog is open in the app window; no screenshot was taken. |
| `request-not-unknown`, `account-changed`, `invalid-response`, `invalid-conditions`, `invalid-quote`, `invalid-target`, `clock-rule-required`, `target-unavailable`, `terminal-updating`, `result-mismatch` | 409 | The request conflicts with the current state, or the terminal's data cannot be used. |
| `invalid-decimal`, `numeric-range`, `invalid-side`, `invalid-type`, `invalid-market-fields`, `invalid-volume`, `invalid-tick`, `invalid-stops`, `invalid-entry`, `invalid-expiry`, `ambiguous-expiry`, `conflicting-stops`, `invalid-risk`, `invalid-distance`, `unsatisfiable-distance`, `unsatisfiable-risk`, `risk-unavailable`, `insufficient-margin`, `frozen-target`, `wrong-target-kind`, `invalid-slippage`, `invalid-review` | 422 | A trading value is invalid for this account and market. |
| `indicator-failed` | 422 | The indicator's calculation failed; `details.reason` says why. |
| `body-too-large`, `unsupported-media-type` | 413, 415 | Send JSON bodies of at most 16 KiB. |
| `quote-unavailable`, `feed-required`, `unavailable-source`, `account-unavailable`, `journal-unavailable`, `trading-unavailable`, `trading-stopped` | 503 | The source, journal or engine is unavailable now. |
| `window-unavailable` | 503 | There is no app window to capture now. |
| `read-failed` | 503 | The terminal refused an account or conditions read, such as for an unknown symbol; `details.reason` gives the EA's reason. |
| `read-timeout` | 504 | The terminal did not answer within five seconds. Not an order failure. |
| `screenshot-timeout` | 504 | The app window was not captured within ten seconds. |
| `internal-error` | 500 | Check the app's logs. |

## Chart history

Candles, indicator values, history and exports show a timeframe's bars from these sources, oldest to newest:

1. **Saved history**: the app's own copy in its database, for bars older than the terminal's history file.
2. **MetaTrader's history file** (`<symbol><minutes>.hst` in the terminal's `history` folder). Where the timeframe has
   no file, or a stale one, the bars are rolled up from the M1 file (D1 for W1 and MN1).
3. **The EA's bars**: MetaTrader writes a timeframe's file only when its chart closes or the terminal shuts down, so
   an open chart's recent bars are often not on disk. When a timeframe has no bars, or a gap before the live candles,
   the app asks the QuoteBridge EA (1.10 or later) for the last 900 closed bars of that timeframe; so it does when an
   intraday timeframe has only bars rolled up from the M1 file. It asks once when a feed connects, for its chart's
   timeframe, and when the Charts view opens a timeframe. The bars are kept in saved history, so they survive a
   restart and the History page lists them.
4. **The live candles** the app builds from the EA's quotes since it started (candles and indicator values only).
   The bar still forming takes the live high, low and close.

While the EA is still loading a timeframe's history, the app asks again a little later. An older EA, or an offline
feed, leaves the bars as they are.

Bars start where MetaTrader's own bars of the timeframe do. Some brokers label intraday bars from a session's start
rather than from midnight; CMC's GOLD H4 bars, for example, start at 01:00, 05:00, 09:00 and so on. The live
candles and bars rolled up from the M1 file follow the same times, so the forming bar is never a second bar beside
MetaTrader's. Without a history file or saved bars of the timeframe, bars start at the usual times (H4 at 00:00,
04:00 and so on).
