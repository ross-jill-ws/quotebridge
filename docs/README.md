# User manual

QuoteBridge for MetaTrader carries live quotes out of every MetaTrader 4 terminal on your PC into one window, records
them, charts them with indicators, trades on demo accounts and serves it all to your scripts.

## Start here

- [Install](install.md): download, check and run the installer; update and uninstall.
- [Getting started](getting-started.md): the setup screen, the three steps in MetaTrader, then feeds, charts, history,
  indicators, trading and scripts, with pictures.

## Using the app

- [Terminals and feed identity](terminals.md): setup, EA upgrades and how charts share a verified terminal identity.
- [Indicator packages](indicator-packages.md): the package format, for writing your own indicators or converting MT4
  ones, and how to install them.
- [Trading](trading.md): demo and opt-in real trading across accounts, the EA and app gates, preview/execute and unknown outcomes.
- [Trading page](trading-page.md): the app window's view of accounts, positions and orders.

## Scripts and agents

- [Command-line client](cli.md): every `mt4-quote-bridge` command and the API calls behind it.
- [REST API v1](rest-api.md): markets, accounts, terminals, screenshots and trading requests for the CLI and your own
  scripts.
- [Account protocol and sources](account-protocol.md): EA message validation, account identity, read-source selection
  and API-key scopes.

## Building from source

- [Development](development.md): running the app from source with `npm run dev`, and releasing.
- [Trading engine](trading-engine.md): the server's internal preview/execute/review interface.
