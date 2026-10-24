# REST API v1

Read endpoints for the `mt4-quote-bridge` CLI and your own scripts. They answer on the app's HTTP port, on
`127.0.0.1` only. The shapes follow the legacy server's REST API field by field, so the CLI works unchanged:

```
mt4-quote-bridge auth login --server http://127.0.0.1:<port>
```

`<port>` is the HTTP port shown in Settings. The CLI asks for an API key.

## Authentication

- Create a key in **Settings › API keys** (scope `read`, or `trade`, which includes `read`). The app shows the key
  once.
- Send it as `Authorization: Bearer qbk_…`.
- A missing, unknown or revoked key gets `401`. A `read` key on anything but `GET` or `HEAD` gets `403`.
- `GET /api/v1/info` is public: `{ "service": "mt4-quote-bridge", "apiVersion": 1 }`.
- `GET /api/auth/session` answers `{ username, key: { name, prefix, scope }, expires: null }`.

## Times

MetaTrader stamps everything with the broker's server time. Every time field keeps that meaning: `time`,
`quoteTime`, `from` and `to` are **broker seconds**. Each one has a sibling with a `Utc` suffix (`timeUtc`,
`quoteTimeUtc`, `fromUtc`, `toUtc`) holding **UTC milliseconds**, worked out from the broker server's clock rule
(Terminals view). The samples endpoint takes and returns UTC milliseconds.

## Choosing a symbol

`:symbol` is matched case-insensitively. Several matches answer `409` with the candidates in `details`. Narrow them
with:

- `?broker=`: the broker server, as a substring, case-insensitive;
- `?terminal=`: the terminal's ID or name, as a substring;
- `?feed=`: the exact feed key from `/symbols`.

When several feeds match, online feeds are preferred. Recorded and saved data belongs to a market (broker server and
symbol), so it answers even when no terminal is running.

## Endpoints

| Endpoint | Answer |
| --- | --- |
| `GET /api/v1/symbols` | `{ symbols: [{ symbol, broker, terminal, feed, online, recording, digits, bid, ask, quoteTime, quoteTimeUtc, livePeriods[], historyPeriods[] }] }`, one row per feed. `broker` is the broker server. |
| `GET /api/v1/symbols/:symbol/quote` | The feed's latest sample (`source: "live"`), else the market's last recorded sample (`source: "recorded"`, with `received` in UTC ms). `{ symbol, broker, terminal, feed, source, online, bid, ask, spread (points), digits, time, timeUtc }`. |
| `GET /api/v1/symbols/:symbol/candles?period=H1&count=900&source=auto` | The last `count` bars, 900 when not given (1–5000): `{ period, timeframe, symbol, broker, terminal, feed, digits, source, status, message, bars: [{ time, timeUtc, open, high, low, close, complete? }] }`. `auto` is the chart's history (see [Chart history](#chart-history)), with the live candles after it. `live` gives the live candles only; `history` gives HST and saved bars, with `volume` and `spread`. The last live bar has `complete: false`. |
| `GET /api/v1/symbols/:symbol/samples?from=&to=&limit=10000` | Recorded samples from `from` to `to` (UTC ms), oldest first, `limit` ≤ 100,000: `{ symbol, broker, from, to, truncated, samples: [{ time, timeUtc, bid, ask, received }] }`. With `truncated: true`, continue from the last `timeUtc + 1`: a page ends at a whole second, unless one second holds more than `limit` samples (the rest of that second is then skipped). |
| `GET /api/v1/history` | `{ series: [{ source, symbol, broker, period, timeframe, bars, from, to, fromUtc, toUtc }] }`: each market's periods, from MetaTrader's HST file joined with the app's saved history. `source` is the broker server. |
| `GET /api/v1/history/:symbol?period=H1&from=&to=&limit=10000&source=` | Bars in `[from, to]` (broker seconds), oldest first, `limit` ≤ 100,000, each `{ time, timeUtc, open, high, low, close, volume, spread }`. With `truncated: true`, continue from the last `time + 1`. `source` picks the broker server. |
| `GET /api/v1/history/files?symbol=&period=` | The HST files of the terminals the app has heard from: `{ files: [{ file, symbol, broker, terminal, period, timeframe, digits, bars, from, to, fromUtc, toUtc }] }`. |
| `GET /api/v1/history/files/csv?file=&from=&to=` | One file as a CSV attachment (`time,open,high,low,close,tick_volume,spread,real_volume,time_utc`), with no row limit. `file` is the `file` value from the list. |
| `GET /api/v1/indicators` | The enabled indicator packages: `{ indicators: [{ name, id, version, title, description, placement, closedBarsOnly, parameters[], outputs[], hash }] }`. `name` is the last part of the package ID (`macd` of `quotebridge.macd`). A parameter is `{ id, label, type, default, min, max, lessThan? }`, or `{ id, label, type: "choice", default, choices: [{ value, label }] }`. An output is `{ id, label, render, styles? }`; `styles` are the keys its `<output>_style` takes. |
| `GET /api/v1/indicators/:name` | One enabled package, as listed. `:name` is its `name` or its ID, in any case. |
| `GET /api/v1/indicators/:name/:symbol?period=H1&count=900&p.<param>=` | The package's values over the feed's last `count` bars, 900 when not given (1–5000): `{ indicator, id, version, parameters, outputs: [{ id, label }], period, timeframe, symbol, broker, terminal, feed, source, status, barsUsed, values: [{ time, timeUtc, close, complete?, <output>, <output>_style? }] }`. See [Indicators](#indicators). |

`period` accepts `M1 M5 M15 M30 H1 H4 D1 W1 MN1`, the reversed forms (`1H`, `15M`) or minutes (`60`).

Errors are `{ error, details? }` with `400` (bad input), `401`, `403`, `404` (unknown symbol, no history, or an
unknown or disabled indicator), `409` (ambiguous symbol or indicator name, or no quote yet), `422` (an indicator's calculation failed)
and `503` (no live candles yet).

## Indicators

The app calculates an indicator over the same bars as the Charts view (see [Chart history](#chart-history)), and
the CLI gets the very values the chart shows: both read one cache.

- Parameters are passed as `p.<id>` (`p.fast=8&p.slow=21`). Any left out take their defaults; values outside a
  parameter's range, or a `lessThan` broken, answer `400`.
- The package also gets the warm-up bars it declares before the first of the `count` bars, so the first value is as
  correct as the last. `barsUsed` is how many bars the calculation ran over: the warm-up and the `count` bars at
  least, more when a chart has loaded older bars with the same settings, as the two share one calculation.
- The last bar is the forming one. While it is live it has `complete: false`. A package that works on closed bars
  only (`closedBarsOnly`) has no row for it, so it answers one row fewer than `count`.
- `source` takes only `auto`, the chart's bars; `live` and `history` answer `400`.
- An `<output>` is `null` where the package has no value, during its warm-up for instance. `<output>_style` is there
  only for an output that is coloured by style, such as rising and falling.
- `:symbol` needs a feed: an indicator works from a terminal's live chart, not from recorded or saved data alone.
  `?broker=`, `?terminal=` and `?feed=` narrow it as above.
- An unknown or disabled `:name` answers `404` with the available names in `details`. A short name that two
  installed packages share answers `409` with their IDs; use the ID. A calculation that throws, runs
  too long or returns bad values answers `422` with the reason.

## Chart history

The Charts view and `source=auto` show a period's bars from these sources, oldest to newest:

1. **Saved history**: the app's own copy in its database, for bars older than the terminal's history file.
2. **MetaTrader's history file** (`<symbol><minutes>.hst` in the terminal's `history` folder). Where the period has no
   file, or a stale one, the bars are rolled up from the M1 file (D1 for W1 and MN1).
3. **The EA's bars**: MetaTrader writes a period's file only when its chart closes or the terminal shuts down, so an open
   chart's recent bars are often not on disk. When a period has no bars, or a gap before the live candles, the app asks
   the QuoteBridge EA (1.10 or later) for the last 900 closed bars of that period, of any period, not only the chart's.
   It asks once when a feed connects, for its chart period, and when the Charts view opens a period. The bars are kept
   in saved history, so they survive a restart and the History page lists them. They replace the file's last bar,
   which may have been written while it was still forming.
4. **The live candles** the app builds from the EA's quotes since it started. The bar still forming takes the live
   high, low and close.

While the EA is still loading a period's history, the app asks again a little later. An older EA, or an offline feed,
leaves the chart as it is. Paging back past the EA's bars continues in saved history or the history file.

A chart opens with the last 900 bars, as MetaTrader's charts do, and loads 900 more each time it is scrolled back
near its oldest bar.

## Coming later

These answer `501`, naming the milestone that brings them:

- `/symbols/:symbol/info` (contract details), `/accounts…`, `/positions…`, `/budget` and `/orders…`: milestone 5.
