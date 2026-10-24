# Terminals and feed identity

A terminal is one MetaTrader installation and its data folder, not a broker server or trading account. **Feeds** uses the same Terminal ID and name as **Terminals**. Charts in one terminal share a group even if their saved EA `TerminalId` inputs differ. Two installations remain separate even when they use the same broker, login and symbols.

## Setup and upgrades

The QuoteBridge EA must be **1.11 or later**. It reports MetaTrader's installation and data-folder paths; the app matches both against its detected terminal catalog. There are no aliases to maintain, and you do not need to change saved chart labels or profiles.

Managed terminals receive bridge-file updates through the app's normal update process. If a chart is still running an older EA:

1. In **Terminals**, rescan and check that the installation is listed. Use **Install** or **Recompile** if needed; a failed compile leaves the old EA in place.
2. In MetaTrader, refresh Navigator. If the chart still runs the older EA, reload QuoteBridge on that chart yourself, or restart the terminal when safe. Do not interrupt an in-flight order request. Keep your existing permissions; enabling AutoTrading is not needed for quotes.
3. Check **Feeds**: the terminal's charts should appear under its one name. In the reported EasyForex case, EURUSD, XAUUSD and Bitcoin should share that group regardless of their saved `TerminalId` values.

For an undetected or portable terminal, use **Add folder** in Terminals to confirm its installation/data-folder pairing. The EA retries hello automatically, so no label edits are needed after a rescan or confirmation.

## Unverified connections

An older EA without paths, unknown installation, mismatched pair or malformed paths is not assigned to any terminal. It remains unsubscribed: no feeds, samples, recording or execution routing from that connection. Feeds shows a setup/upgrade notice while identity refusals are being received; `/api/state` includes their rejection reasons with stable code `terminal-identity`. The app never guesses using a broker name, login, symbol or chart label. A rejected hello also revokes any earlier subscription on that session, retaining its original installation/market binding and sample sequence watermark in the bounded peer registry. Retrying cannot rebind that session or record an acknowledged batch again.

Existing recordings and saved history remain available: they belong to a **market** (broker server + symbol), not a chart label. There is no database identity migration or copying of recorded data. After an upgrade, transient feed groups are rebuilt from verified hellos. Reconnects keep the same Terminal ID; changing broker server clears the old live quotes/candles and requires the terminal's other charts to say hello again before their samples are accepted. The EA discards unacknowledged old-account samples on an account restart rather than send them under its new market.

## EA protocol

The 1.11 hello is UTF-8, pipe-separated, with exactly 16 fields:

```text
H|1|session|legacyTerminalId|brokerServer|symbol|digits|interval|dropped|quoteStatus|timeframe|2000|1|eaVersion|installationFolder|dataFolder
```

The first 14 fields are unchanged. The last two come from `TerminalInfoString(TERMINAL_PATH)` and `TerminalInfoString(TERMINAL_DATA_PATH)`. Each path is absolute, at most 1,000 characters, without control characters or `.`/`..` path components. Windows drive and UNC paths are supported. Matching ignores case, slash direction and trailing separators. It requires exactly one detected, paired MT4 catalog entry; MT5, unconfirmed portable folders and saved-but-undetected terminals do not establish identity.

The canonical ID remains `mt4-` plus the first 12 hex digits of SHA-256 over the normalized data-folder path (uppercase, backslashes, no trailing separator, UTF-8). The chart's legacy label never chooses that ID. This verifies consistency with the local catalog; it is not cryptographic authentication of local software or sufficient permission to trade.

Legacy 10–14-field hellos remain parseable for explicit upgrade diagnostics, but cannot subscribe. A refused hello gets `C|1|session|0`; samples without a verified session get `R|1|session`, not an ACK. Once detection/setup succeeds, a later valid hello gets the normal subscription response. An existing session cannot change its installation, symbol or broker server; account/server changes use the EA's new session, retaining the same canonical Terminal ID. No change to the sample or bar wire format is required.
