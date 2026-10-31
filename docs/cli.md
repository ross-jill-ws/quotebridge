# Command-line client

`mt4-quote-bridge` is QuoteBridge's command-line client (repository `mt4-quote-bridge-cli`). Each command calls one or
more [REST API v1](rest-api.md) operations; this page lists them all. Trading rules are in [Trading](trading.md).

```text
mt4-quote-bridge <command> <subcommand> [options]
```

Every command has `--help` with its options, output and exit codes.

## Sign-in, scopes and what stays in the app window

| Command | Does | API |
| --- | --- | --- |
| `auth server [url]` | Saves the server URL after checking it (default `http://127.0.0.1:5580`) | `GET /api/v1/info` |
| `auth login [--api-key-stdin]` | Saves an API key after checking it | `GET /api/auth/session` |
| `auth status` | Shows the key's name, scope and expiry, checked with the app | `GET /api/v1/info`, `GET /api/auth/session` |
| `auth logout` | Forgets the saved key locally (revoke it in the app to disable it) | — |
| `config show` | Shows the effective server, config file and whether a key is saved (never the key) | — |

- The app answers on this computer only (`127.0.0.1`, `localhost` or `[::1]`), on the HTTP port in Settings › Connection.
- Create keys in the **app window › Settings › API keys**. `readonly` reads everything but screenshots; `trader` also
  takes screenshots and previews, executes and reviews requests. A `readonly` key's screenshot, preview, execute or
  review answers exit 4 (`insufficient-scope`).
- Installation and setup, API keys, network settings, recording, Demo trading, Real-account trading, the lot cap and slippage are the app
  window's alone. No command changes them.
- The key is saved in `~/.mt4-quote-bridge/config.json` (owner-only). `MT4QB_SERVER`, `MT4QB_API_KEY` and
  `MT4QB_CONFIG` override the saved values.

## Identities

- **Market:** a broker server and a symbol, both exact and case-sensitive. Name it `SYMBOL --broker <broker server>`
  or `--market-id <id>`. `SYMBOL` alone works only when one broker server has it.
- **Account:** a broker server and a login. Name it `--account <account-id>`, or `--account <login> --broker <broker
  server>`; a bare login only when one broker server has it. There is no default, saved or active account. Where a
  command takes both, the account fixes the broker server the symbol is looked up on.
- **Tickets** are MetaTrader's and unique only within an account, so every ticket command takes `--account`.
- Ambiguity lists the candidates (`error.details.candidates`) and exits 6. Nothing is matched by substring, case or
  alias, and there is no interactive picker.

Resolution reads `GET /markets?symbol=…[&brokerServer=…]` and `GET /accounts`, following every cursor.

## Commands

### Markets

| Command | API |
| --- | --- |
| `markets list [--broker S] [--symbol S]` | `GET /markets?brokerServer&symbol` |
| `markets show SYMBOL` | `GET /markets/{marketId}` |
| `markets quote SYMBOL` | `GET /markets/{marketId}/quote` |
| `markets candles SYMBOL --timeframe TF [--from] [--to] [--limit]` | `GET /markets/{marketId}/candles` |
| `markets samples SYMBOL [--from] [--to]` | `GET /markets/{marketId}/samples` |
| `markets history SYMBOL` | `GET /markets/{marketId}/history` |
| `markets export SYMBOL --timeframe TF --format csv\|hst --output FILE [--force] [--from] [--to]` | `GET /markets/{marketId}/export` |
| `markets indicator PACKAGE SYMBOL --timeframe TF [--param id=value]… [--from] [--to] [--limit]` | `GET /markets/{marketId}/indicators/{packageId}` |

`TF` is `M1 M5 M15 M30 H1 H4 D1 W1 MN1`. Candles and indicator values are the newest `--limit` bars within
`--from`/`--to`; the table output prints the `--to` of the page before on stderr.

**Exports** write the file named by `--output` (required). An existing file is never replaced unless `--force` is
given (exit 13 otherwise); an interrupted or refused export leaves no file. With `--json`, stdout gets the file's
metadata, never its bytes:

```json
{ "data": { "path": "C:\\data\\EURUSD60.csv", "bytes": 1234, "contentType": "text/csv; charset=utf-8", "marketId": "…", "brokerServer": "EasyForex-Demo", "symbol": "EURUSD", "timeframe": "H1", "format": "csv", "from": null, "to": null }, "meta": {} }
```

### Accounts

| Command | API |
| --- | --- |
| `accounts list` | `GET /accounts` |
| `accounts show --account A` | `GET /accounts/{accountId}` |
| `accounts funds --account A` | `GET /accounts/{accountId}/funds` |
| `accounts conditions SYMBOL --account A` (or `--market-id`) | `GET /accounts/{accountId}/markets/{marketId}/conditions` |

### Positions and pending orders

| Command | API |
| --- | --- |
| `positions list --account A` | `GET /accounts/{accountId}/positions` |
| `positions show TICKET --account A` | `GET /accounts/{accountId}/positions/{ticket}` |
| `positions modify TICKET --account A [--sl P\|none] [--tp P\|none]` | `POST /requests/preview` (`modify`) |
| `positions close TICKET --account A` | `POST /requests/preview` (`close`) |
| `orders list --account A` | `GET /accounts/{accountId}/orders` |
| `orders show TICKET --account A` | `GET /accounts/{accountId}/orders/{ticket}` |
| `orders preview --account A --symbol S --side buy\|sell --type market\|limit\|stop --lots L [--price] [--expiry] [--sl] [--tp]` | `POST /requests/preview` (`place`) |
| `orders preview … --risk-amount\|--risk-percent\|--risk-points X --reward-ratio R` | `POST /requests/preview` (`place` with `risk`) |
| `orders preview … [--sl-points N] [--tp-points N]` | `POST /requests/preview` (`place` with `distance`) |
| `orders modify TICKET --account A [--price] [--expiry T\|none] [--sl P\|none] [--tp P\|none]` | `POST /requests/preview` (`modify`) |
| `orders cancel TICKET --account A` | `POST /requests/preview` (`cancel`) |

While an account's terminal is offline, its positions and orders are its last snapshot (`meta.state` `stale`), or
none when no terminal of it has answered since the app started (`unavailable`); the table output says so on stderr.

Options left out of a modify stay as they are; `none` clears a stop or an expiry (sent as `null`; zero is not a
clear). There are no lot changes or partial closes.

### Requests

| Command | API |
| --- | --- |
| `requests list [--account A]` | `GET /requests?accountId` |
| `requests show ID` | `GET /requests/{requestId}` |
| `requests execute ID --confirm [--wait S]` | `POST /requests/{requestId}/execute` once, then `GET /requests/{requestId}` |
| `requests review ID --note TEXT --acknowledge` | `POST /requests/{requestId}/review` |

### Indicators and terminals

| Command | API |
| --- | --- |
| `indicators list` / `indicators show PACKAGE` | `GET /indicators[/{packageId}]` |
| `terminals list` / `terminals show ID` | `GET /terminals[/{terminalId}]` |
| `terminals feeds ID [FEED]` | `GET /terminals/{terminalId}/feeds[/{feedId}]` |

Terminals are diagnostics only; they never route trading.

### Screenshots

| Command | API |
| --- | --- |
| `screenshot feeds [--output FILE [--force]] [--json]` | `GET /screenshots/feeds` |
| `screenshot chart SYMBOL [--broker S \| --market-id ID] [--output FILE [--force]] [--json]` | `GET /screenshots/charts/{marketId}` |

A [screenshot](rest-api.md#screenshots) checks that the app looks healthy. It switches **your own app window** to
Feeds, or to the market's chart from its best source feed, and leaves it there; a minimised or hidden window is
captured without being shown. It needs a `trader` key. `SYMBOL` is named as for every market command.

The CLI always asks for JSON. By default it prints the window's health, never the image:

```text
View:    chart
Market:  EURUSD · EasyForex-Demo
Window:  hidden
Live:    live
Size:    1800 × 1200
Scale:   1.5
Time:    2027-01-15T08:00:00.000Z
```

`--json` prints the app's answer, the PNG in base64 included. `--output FILE` writes the PNG on the CLI's own computer
under the export rules: an existing file is never replaced without `--force` (exit 13, and the window is not
touched), and a refused screenshot leaves no file. With `--json`, stdout then gets the health fields plus `path` and
`bytes`, without the base64.

| Refusal | Exit |
| --- | --- |
| `insufficient-scope`: a `readonly` key | 4 |
| `window-busy`: a dialog is open in the app window; nothing was switched or taken | 7 |
| `no-feed`: no terminal streams the market (chart only) | 7 |
| `window-unavailable`: no window to capture (the app is starting, or its window is being recreated) | 9 |
| `screenshot-timeout`: the window was not captured within ten seconds | 9 |

## Trading from the command line

1. Every mutation command previews: `orders preview|modify|cancel`, `positions modify|close`. Nothing is sent; the
   preview lasts 30 seconds and prints its request ID and the execute command.
2. `requests execute ID --confirm` is the only command that sends anything. There is no `--yes`, no prompt to skip and
   no confirmation by default. `--confirm` states that the account holder approved that exact preview.
3. Execute posts once and never retries. It then only reads the request until a definitive result or `--wait`
   seconds (25 by default, 0–60). A lost answer, a timeout or an unknown outcome is answered with
   `requests show ID`, never with another execute or preview. When the app cannot be reached at all (the connection is
   refused) or no key is saved, execute says so and that nothing was sent.
4. An unknown outcome blocks its account, previews included, until a result arrives or you review it after checking
   MetaTrader.

The CLI's agent skill requires the user's explicit approval of each preview; agents never execute on their own
initiative.

## Output, numbers and times

- Tables for people. `--json` prints the API's envelope exactly: `{ "data": …, "meta": … }`. `--all` on a collection
  prints one envelope with every item and the last page's `meta` (such as an account's `currency` and `state`), its
  `count` and `limit` replaced by `count`, `pages` and `nextCursor: null`.
- Errors and hints go to **stderr** only; the table output prints an error's `details.reason` (an indicator's or the
  EA's) on the line below its message. With `--json`, an error is `{ "error": { "code", "message", "details" } }` on
  stderr: the app's [error code](rest-api.md#error-codes), or the CLI's own `usage`, `ambiguous-market`,
  `ambiguous-account`, `unknown-market`, `unknown-account`, `output-exists`, `not-signed-in`, `invalid-key` (not a
  `qbk_` key, exit 3), `unreachable`, `redirect` (the server redirects elsewhere) or `cli-error` (anything else, such
  as a server that is not QuoteBridge).
- Prices, lots and money are decimal strings, as the API gives them. Pass decimals as plain digits (`0.10`, `1.08500`).
- Times are UTC ISO-8601 with a `brokerTime` sibling. `--from`/`--to` take `YYYY-MM-DDTHH:MM:SS[.sss]Z`, or a date
  `YYYY-MM-DD` (that UTC day's start for `--from`, its last second for `--to`). `--expiry` takes UTC whole seconds.
- Collections are cursor-paged: `--limit`, `--cursor` (the previous page's `meta.nextCursor`) or `--all`. Table output
  prints the next `--cursor` on stderr.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success. For `requests show`/`execute`: succeeded, reviewed, or a valid preview |
| 1 | Other error: the app is unreachable or answered unexpectedly (500) |
| 2 | Usage error, or a malformed value (400) |
| 3 | Not signed in, or the key is invalid or revoked (401) |
| 4 | Forbidden (403): `readonly` key, Demo trading off, a real account with Real-account trading off (`real-trading-disabled`), symbol not tradable |
| 5 | Not found (404) |
| 6 | Ambiguous symbol or login |
| 7 | Conflict (409): cross-broker market, preview expired or invalidated, account unresolved, a real account with no `EnableRealTrading` chart (`executor-real-account`), no single ready executor, a dialog open in the app window (`window-busy`), no feed for a chart (`no-feed`) |
| 8 | Invalid trading or indicator values (422) |
| 9 | Source or app window unavailable, the terminal did not answer in five seconds, or a screenshot in ten (503, 504); not an order failure |
| 10 | The request's outcome is unknown and not reviewed: never retry |
| 11 | The request failed definitively |
| 12 | The request was sent and has no definitive result yet |
| 13 | The output file of an export or screenshot exists (no `--force`) |
