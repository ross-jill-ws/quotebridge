# Development

How to run QuoteBridge for MetaTrader from source while you change it. You don't need the installer for this: it is only for testing installs and updates.

Requires Windows and Node.js 24. Install the dependencies once with `npm ci`.

## `npm run dev`

One command runs the app with live reload. Options are passed after `--`:

```
npm run dev                      # fake terminals and fake EAs, dashboard in your browser
npm run dev -- --app             # the same inside the app window
npm run dev -- --real            # your real terminals, dashboard in your browser
npm run dev -- --real --app      # your real terminals inside the app window
```

Every mode does the same three things while it runs:

| You save a file in | What happens | Typical time |
| --- | --- | --- |
| `src/dashboard/` | The dashboard is rebuilt and every open page (browser tab or app window) reloads itself. | under 1 s |
| `src/server/`, `src/shared/` | The server is rebuilt and restarted through its normal stop path (database checkpoint included). Open pages sign in again by themselves, and EAs reconnect. | about 1 s |
| `src/main/`, `src/shared/` (only with `--app`) | The main process is rebuilt and the whole app relaunches. | 1–2 s |

A build error leaves the running version in place and prints `build failed; nothing reloaded`. Fix the error and save again.

To stop, type `q` and Enter, or press Ctrl+C. With `--app`, Quit in the tray menu also ends the dev run.

### Default: fake terminals and fake EAs

```
npm run dev
```

Use this for most work on the dashboard and the server. Nothing on your machine's MetaTrader side is touched.

- **Ports:** EA 6655, HTTP 6680, away from the app's 5555/5580, so it can run while the installed app or another server is running.
- **Data folder:** `%TEMP%\quotebridge-dev`. Settings, installs into fake terminals and the database survive restarts of the dev run.
- **Fake terminals:** a folder laid out like a MetaTrader user's machine, with four MT4 terminals and one MT5 terminal. One fails to compile, and one reports MetaEditor as open, so every state on the Terminals view and the setup screen can be seen. The compiler is a stand-in that takes about 1.5 s, so progress is visible.
- **Fake EAs:** feeds that cover every row state of the Feeds view: live quotes, a stale quote, a symbol without a valid quote, a duplicate chart, dropped samples, and a feed that goes offline after a few seconds. They answer bar requests like EA 1.10, with 900 synthetic bars of any period ending at their price, so their charts are full. Installing into a fake terminal also starts a fake EA there, which ticks that terminal's checklist.
- **Opening the dashboard:** open `http://127.0.0.1:6680/` (the terminal prints it; Enter prints it again). In a browser tab a dev run needs no sign-in, so you can reload, open more tabs or use another browser, and scripts can call the API with no cookie. Requests still have to come from that address: other sites and other host names are refused, as in the app. The app window (`--app`) and the installed app keep the one-time sign-in.
- **Settings view:** the dev ports override the saved ones, and the view says so; a port change is saved but the run stays on 6655/6680. The theme applies at once in the app window and in a browser tab (the page sets `data-theme`); System follows the colour mode of the window or browser.

### `--app`: inside the app window

```
npm run dev -- --app
```

Runs the real Electron app (tray, window, supervisor, utility process) instead of a browser tab, still with fake terminals and fake EAs unless `--real` is also given. Use it when working on the tray, the window, start-up and shutdown, or anything else in the main process.

- Server changes restart the server inside the app, the same way the app recovers from a crash.
- Dashboard changes reload the app window.
- Main-process changes quit and relaunch the app.
- The app uses the same dev data folder and ports as the mode it runs in, never the installed app's.
- The app window signs itself in. A browser next to it needs a one-time sign-in link, as with the installed app: take it from `dev-sign-in-link.txt` in the data folder (it is not printed). Only your Windows user can read the file; it is rewritten with each new link (Enter makes one, and uses up the one before) and deleted when the dev run stops. Treat the link as a secret: don't paste it into issues or logs.

### `--real`: your real terminals

```
npm run dev -- --real
npm run dev -- --real --app
```

Uses the MetaTrader terminals on this computer and their own MetaEditor, so you can try a change against real EAs.

- **Ports:** the ones in the dev settings, 5555 (EA) and 5580 (HTTP) by default. Real EAs send to the port in their template, normally 5555.
- **Data folder:** `%APPDATA%\QuoteBridge-dev`, separate from the installed app's `%APPDATA%\QuoteBridge`. Managed terminals, install records and settings of a dev run never mix with the installed app's.
- **Port check:** it refuses to start while another program holds one of its ports, and says which:

  ```
  The EA port 5555 on 127.0.0.1 is in use by another program.
  npm run dev -- --real needs the real ports: quit the installed QuoteBridge (tray > Quit) and stop the legacy server, then try again.
  ```

  So before using it: Quit the installed QuoteBridge from the tray, and stop any other server on those ports.
- **EA changes:** the dev app installs the EA sources from the repo's `mt4/` folder. After editing them, click **Recompile** on the terminal's card in the Terminals view. The terminal's MetaEditor compiles the EA, and MetaTrader reloads it on its charts.
- **Nothing is installed until you ask:** the first `--real` run creates the dev settings with setup already done and no managed terminals, so there is no setup screen and every detected terminal is only offered. The bridge files go into a terminal only when you click **Install** on its card; from then on that terminal is managed by the dev run, and later `--real` runs update it on start when the repo's bridge files differ (as the installed app does after an update). Terminals you never installed into are never touched on start.
- **Your terminals are real:** the Terminals view shows a banner saying so. Installing, recompiling and removing change the bridge files in those terminals, just as the installed app does. A terminal the installed app also manages then has two install records, one per data folder, and Remove in the dev run takes out the files the installed app's EA uses too.
- **Existing dev settings are kept:** a `%APPDATA%\QuoteBridge-dev\settings.json` from an earlier run is used as it is, including its managed terminals. To start clean, quit the dev run and delete `%APPDATA%\QuoteBridge-dev`.

When you are done, Quit the dev run and start the installed QuoteBridge again so your EAs have their server back.

## Environment overrides

| Variable | Default | Effect |
| --- | --- | --- |
| `QUOTEBRIDGE_DATA_FOLDER` | see the modes above | Data folder of the dev run. The installed app's `%APPDATA%\QuoteBridge` is refused. |
| `QUOTEBRIDGE_EA_PORT` | 6655, or the settings with `--real` | Port EAs connect to. |
| `QUOTEBRIDGE_HTTP_PORT` | 6680, or the settings with `--real` | Port of the dashboard and API. |
| `QUOTEBRIDGE_DEV_RELOAD_PORT` | 6681; 6682 with `--real` | Port the reload signal uses, so a fake run and a `--real` run can run at once. Only dev builds of the dashboard listen for it; production builds contain no reload code. |

In PowerShell, set one for a single run like this:

```powershell
$env:QUOTEBRIDGE_EA_PORT = '7755'; npm run dev; Remove-Item Env:QUOTEBRIDGE_EA_PORT
```

## Other commands

| Command | What it does |
| --- | --- |
| `npm test` | All tests (a few seconds). |
| `npm run typecheck` | Type-checks everything. |
| `npm run build` | Builds the main process, server and production dashboard into `dist/`. |
| `npm start` | Builds once, then runs the app with Electron, without live reload. |
| `npm run package` | Builds the Windows installer into `release/`. |
| `npm run verify:package` | Checks the unpacked build in `release/win-unpacked`. |

## Which mode to use

| You are working on | Use |
| --- | --- |
| Dashboard pages, styling, the Feeds or Terminals views | `npm run dev` |
| Server: EA protocol, feeds, installer logic | `npm run dev`, plus `npm test` |
| Tray, window, start-up and shutdown | `npm run dev -- --app` |
| The EA (`mt4/`) or anything that must meet a real terminal | `npm run dev -- --real` (add `--app` for the full app) |
| The installer, updates of the installed app | `npm run package`, then install the result |

MetaTrader is the registered trademark of MetaQuotes Ltd. QuoteBridge for MetaTrader is not affiliated with or endorsed by MetaQuotes.
