# QuoteBridge for MetaTrader

A Windows desktop app that bridges MetaTrader 4 quotes to a dashboard.

## Development

Requires Node.js 24 on Windows. Install the dependencies with `npm ci`. See [docs/development.md](docs/development.md) for the full guide to `npm run dev` and its `--app` and `--real` options.

| Command | What it does |
| --- | --- |
| `npm run dev` | The server with fake terminals and fake EAs on ports 6655 (EA) and 6680 (HTTP), with its data in `%TEMP%\quotebridge-dev`. Open the printed sign-in link in a browser. Saving a dashboard file reloads the page. Saving a server file rebuilds the server and restarts it; the page signs in again and the fake EAs reconnect. Press Enter for another sign-in link (the current one is also in `dev-sign-in-link.txt` in the data folder, readable only by you); type `q` and Enter (or press Ctrl+C) to stop. |
| `npm run dev -- --app` | The same inside the app window. A change to the main process (`src/main`, `src/shared`) relaunches the app. |
| `npm run dev -- --real` | Real terminals on the ports from settings (5555 and 5580 by default), with its own data folder `%APPDATA%\QuoteBridge-dev`. It refuses to start while another program, such as an installed QuoteBridge, holds one of those ports. It installs into a terminal only when you click Install on its card, and the Terminals view shows that the terminals are real. Changed EA sources in `mt4/` reach terminals through the Recompile button. Combine it with `--app` to run it in the app window. |
| `npm test` | The tests. |
| `npm run typecheck` | Type-checks everything. |
| `npm run build` | Builds the main process, server and production dashboard into `dist/`. |
| `npm start` | Builds, then runs the app with Electron. |
| `npm run package` | Builds the Windows installer into `release/`. |

`QUOTEBRIDGE_DATA_FOLDER`, `QUOTEBRIDGE_EA_PORT` and `QUOTEBRIDGE_HTTP_PORT` override the data folder and ports of a dev run. A dev run never uses the installed app's `%APPDATA%\QuoteBridge`. The reload signal uses port 6681 (`QUOTEBRIDGE_DEV_RELOAD_PORT`), and only dev builds of the dashboard listen for it.
