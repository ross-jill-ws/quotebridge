// Starts the bridge server: the EA endpoint and the HTTP server, both on 127.0.0.1 only.
import type { IncomingHttpHeaders } from "node:http";
import { DEFAULT_SETTINGS } from "../shared/settings-store.js";
import { ApiKeys } from "./auth/index.js";
import { BridgeServer, marketKey, type BridgeServerOptions } from "./bridge/index.js";
import { CandleBuilder } from "./candles/index.js";
import { ClockRules, memoryClockRuleStore } from "./clock/index.js";
import type { AppDatabase } from "./database.js";
import { ChartHistory, EaBarFetcher, HistoryCatalog, HistorySaver, PERIOD_OF } from "./history/index.js";
import { startHttpServer } from "./http/http-server.js";
import { WindowSessions, sessionCookie } from "./http/window-session.js";
import { IndicatorEngine, IndicatorPackages, IndicatorValues } from "./indicators/index.js";
import { Recorder } from "./recording/index.js";
import { AppSettings, type AppSettingsOptions } from "./settings/index.js";
import { TerminalManager, type TerminalManagerOptions } from "./terminals/index.js";
import { RequestEngine } from "./trading/engine.js";

export type ServerConfig = {
  /** ZeroMQ port QuoteBridge EAs connect to (default setting 5555). */
  eaPort: number;
  /** HTTP port of the dashboard, state endpoint and live WebSocket. */
  httpPort: number;
  /** One-time token the app window exchanges for its session (ADR 5). */
  windowToken: string;
  /**
   * `npm run dev` in a browser tab only: every request counts as signed in, so the dashboard opens without a
   * one-time link. The host and origin checks still apply. Never set by the app.
   */
  openDashboard?: boolean;
  /** Folder holding the dashboard bundle; defaults to the bundled dashboard (a placeholder page until it is built). */
  dashboardFolder?: string;
  /** Clock in epoch milliseconds; injectable for tests. */
  now?: () => number;
  /** Terminal management (Terminals view, setup screen, tray attention); omitted, those endpoints answer 404. */
  terminals?: TerminalManagerOptions;
  /** The Settings view (GET and POST /api/settings); omitted, those endpoints answer 404. */
  settings?: AppSettingsOptions;
  /** The app's database (including the durable trading journal); omitted, trading is unavailable and nothing is recorded. */
  database?: AppDatabase;
  /** A terminal's data folder, for its HST files; defaults to the terminal manager's (none without one). Injectable for tests. */
  terminalDataFolder?: (terminalId: string) => string | undefined;
  /** The PC's local time minus UTC at an instant, in minutes (reads the EA's sampled time); injectable for tests. */
  localOffsetMinutes?: (utcMs: number) => number;
  /** A folder of indicator packages (one subfolder each) the app has beside the bundled ones; for tests. */
  extraIndicatorPackages?: string;
  /** Catalog boundary for standalone/test hosts; the desktop app uses its detected terminal manager. */
  resolveTerminal?: BridgeServerOptions["resolveTerminal"];
};

export type TradingCredential = { apiKey: string } | { headers: IncomingHttpHeaders };

export type RunningServer = {
  bridge: BridgeServer;
  /** Absent without a durable database: never dispatch with an ephemeral journal. */
  trading: RequestEngine<TradingCredential> | undefined;
  terminals: TerminalManager | undefined;
  /** e.g. "http://127.0.0.1:43123". */
  httpOrigin: string;
  /** Accepts another one-time window token, e.g. for an app window recreated after a renderer crash. Throws if too short. */
  addWindowToken(token: string): void;
  /**
   * Accepts a one-time token whose session is a remote browser's: it reads, but may not manage what only the app
   * window owns (ADR 5). The password sign-in of network access will hand these out; tests use it now.
   */
  addRemoteToken(token: string): void;
  close(): Promise<void>;
};

/** Rejects with PortInUseError when the EA or HTTP port is taken; nothing stays bound then. */
export async function startServer(config: ServerConfig): Promise<RunningServer> {
  // Snapshots carry each market's clock rule and recording state, read when they are taken.
  let clockRules: ClockRules | undefined;
  let recorder: Recorder | undefined;
  let saver: HistorySaver | undefined;
  let eaBars: EaBarFetcher | undefined;
  let apiKeys: ApiKeys | undefined;
  let terminals: TerminalManager | undefined;
  let trading: RequestEngine<TradingCredential> | undefined;
  const bridge = new BridgeServer({
    now: config.now,
    identityStore: config.database?.identities,
    resolveTerminal: config.resolveTerminal ?? ((identity) => terminals?.resolveTerminal(identity)),
    marketInfo: (market) => ({ clockRule: clockRules?.rule(market.brokerServer) ?? null, recording: recorder?.isRecording(market) ?? false }),
  });
  const startupCleanup: (() => void | Promise<void>)[] = [() => bridge.close()];
  try {
    // Before the first sample: the stored rules decide what later samples confirm or contradict.
    const rules = (clockRules = await ClockRules.open(bridge, config.database?.clockRules ?? memoryClockRuleStore(), {
      now: config.now,
      localOffsetMinutes: config.localOffsetMinutes,
    }));
    startupCleanup.push(() => rules.close());
    // Before the first sample too: each market's last stored sample decides what the merge rule keeps.
    if (config.database) {
      recorder = await Recorder.open(bridge, config.database.recordings, {
        now: config.now,
        clockRule: (brokerServer) => rules.rule(brokerServer),
        digits: (market) => bridge.snapshot().feeds.find((f) => marketKey(f.market) === marketKey(market))?.digits,
      });
      const recording = recorder;
      startupCleanup.push(() => recording.close());
      const saved = config.database.savedBars;
      rules.onRuleChange((brokerServer, rule) => recording.ruleChanged(brokerServer, rule));
      rules.onRuleChange((brokerServer, rule) => saved.recomputeUtc(brokerServer, rule));
    }
    if (config.database) apiKeys = await ApiKeys.open(config.database.apiKeys, config.now);
    const candles = new CandleBuilder(bridge, { now: config.now });
    startupCleanup.push(() => candles.close());
    const dataFolder = config.terminalDataFolder ?? ((terminalId: string) => terminals?.dataFolder(terminalId));
    const saved = config.database?.savedBars;
    if (saved && recorder) {
      const recording = recorder;
      saver = new HistorySaver({
        store: saved,
        snapshot: () => bridge.snapshot(),
        dataFolder,
        clockRule: (brokerServer) => rules.rule(brokerServer),
        marketId: (market, digits) => recording.ensureMarket(market, digits),
        recorded: () => recording.storedMarkets().filter((m) => m.recording),
        now: config.now,
      });
      startupCleanup.push(() => saver?.close());
      eaBars = new EaBarFetcher({
        bridge,
        save: async (market, digits, period, bars) => saved.insert(await recording.ensureMarket(market, digits), period, bars),
        clockRule: (brokerServer) => rules.rule(brokerServer),
      });
      startupCleanup.push(() => eaBars?.close());
    }
    const history = new ChartHistory({
      dataFolder,
      liveCandles: (feed, period) => candles.candles(feed, period),
      clockRule: (brokerServer) => rules.rule(brokerServer),
      savedBars: saved && ((market, period, before, limit) => saved.before(market, period, before, limit)),
      eaBars,
      now: config.now,
    });
    // A feed that connects gets its chart period's bars from its EA, when chart history has a gap there; after a while
    // away, its market's periods may be asked again.
    const stopFilling = bridge.onOnline((key) => {
      const feed = bridge.snapshot().feeds.find((f) => f.feed === key);
      if (feed) eaBars?.forget(feed.market);
      const period = feed?.timeframe ? PERIOD_OF.get(feed.timeframe) : undefined;
      if (feed && period) history.fill(feed, period).catch((e) => console.error(`Chart history of ${feed.symbol} could not be checked`, e));
    });
    startupCleanup.push(stopFilling);
    const catalog = new HistoryCatalog({
      snapshot: () => bridge.snapshot(),
      dataFolder,
      terminalName: (terminalId) => terminals?.name(terminalId),
      clockRule: (brokerServer) => rules.rule(brokerServer),
      storedMarkets: () => recorder?.storedMarkets() ?? [],
      isRecording: (market) => recorder?.isRecording(market) ?? false,
      saved,
      saving: (market) => saver?.progress(market) ?? null,
    });
    const engine = new IndicatorEngine();
    startupCleanup.push(() => engine.close());
    const packages = await IndicatorPackages.open({
      extraFolder: config.extraIndicatorPackages,
      settings: config.settings?.store,
      store: config.database?.indicatorPackages,
      run: (pkg, bars, parameters) => engine.run(pkg, bars, parameters),
      now: config.now,
    });
    const indicatorValues = new IndicatorValues({
      page: (feed, period, limit, before) => history.page(feed, period, limit, before),
      engine,
      feed: (feedId, market) => {
        const feeds = bridge.snapshot().feeds;
        return feeds.find((f) => f.feed === feedId) ?? feeds.find((f) => marketKey(f.market) === marketKey(market));
      },
      now: config.now,
    });
    startupCleanup.push(() => indicatorValues.close());
    const sessions = new WindowSessions({ open: config.openDashboard });
    const settingsStore = config.settings?.store ?? config.terminals?.settings;
    let lastTrading = { ...(settingsStore ? (await settingsStore.read()).trading : DEFAULT_SETTINGS.trading) };
    const settings = config.settings ? new AppSettings({
      ...config.settings,
      onSaved: (saved) => {
        const next = saved.trading;
        if (next.enabled !== lastTrading.enabled || next.maxLots !== lastTrading.maxLots || next.slippage !== lastTrading.slippage) {
          lastTrading = { ...next };
          trading?.settingsChanged();
        }
        config.settings?.onSaved?.(saved);
      },
    }, { ea: config.eaPort, http: config.httpPort }) : undefined;
    sessions.addToken(config.windowToken);
    if (config.database) trading = await RequestEngine.open<TradingCredential>({
      bridge, journal: config.database.journal, now: config.now,
      settings: async () => ({ ...(settingsStore ? (await settingsStore.read()).trading : DEFAULT_SETTINGS.trading) }),
      clockRule: (brokerServer) => rules.rule(brokerServer),
      terminalAvailable: (terminalId) => terminals?.availableForTrading(terminalId) ?? true,
      authorize: (credential, write) => {
        if ("apiKey" in credential) return apiKeys?.check(credential.apiKey, write).ok ? "api-key" : undefined;
        const { headers } = credential;
        if (write && headers.origin !== `http://127.0.0.1:${config.httpPort}`) return undefined;
        const kind = sessions.kind(headers, sessionCookie(config.httpPort));
        return kind === "window" ? "app-window" : kind === "remote" ? "remote-browser" : undefined;
      },
    });
    startupCleanup.push(() => trading?.close());
    // Recover original result bindings and register every listener before receiving even the first message.
    // On failure, drain transport before detaching listeners or flushing their stores.
    startupCleanup.shift();
    startupCleanup.push(() => bridge.close());
    await bridge.start(`tcp://127.0.0.1:${config.eaPort}`);
    const http = await startHttpServer({ port: config.httpPort, bridge, candles, history, catalog, saver, clockRules: rules, recorder, apiKeys, sessions, dashboardFolder: config.dashboardFolder, terminals: () => terminals, settings, indicators: { packages, values: indicatorValues } });
    startupCleanup.push(() => http.close());
    // Only after both ports are bound and journal recovery completed: no install/detection on a failed bind.
    terminals = config.terminals ? new TerminalManager(config.terminals, {
      bridge,
      eaPort: config.eaPort,
      now: config.now ?? Date.now,
      brokerClock: (brokerServer) => rules.get(brokerServer),
      hasInFlightOrderRequests: (terminalId) => trading?.hasUnresolvedTerminal(terminalId) ?? false,
    }) : undefined;
    startupCleanup.push(() => terminals?.close());
    const stopTradingUpdates = trading?.onChange(() => terminals?.requestsChanged());
    return {
      bridge,
      trading,
      terminals,
      httpOrigin: http.origin,
      addWindowToken: (token) => sessions.addToken(token),
      addRemoteToken: (token) => sessions.addToken(token, "remote"),
      async close() {
        stopTradingUpdates?.();
        await trading?.stopAdmissions();
        // Keep the result listener alive until every accepted receive operation has finished.
        await bridge.close();
        await trading?.close();
        await terminals?.close();
        await http.close();
        indicatorValues.close();
        await engine.close();
        stopFilling();
        candles.close();
        eaBars?.close();
        // Before the host's CHECKPOINT: a save stops after the page it is writing.
        await saver?.close();
        // No more samples arrive: the buffered ones are written before the host's CHECKPOINT (ADR 10).
        await recorder?.close();
        await rules.close();
      },
    };
  } catch (error) {
    // Every partially-created service is drained before the host closes its database.
    for (const cleanup of startupCleanup.reverse()) {
      try { await cleanup(); } catch { /* Preserve the original startup failure. */ }
    }
    throw error;
  }
}
