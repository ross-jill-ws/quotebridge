// Starts the bridge server: the EA endpoint and the HTTP server, both on 127.0.0.1 only.
import { ApiKeys } from "./auth/index.js";
import { BridgeServer, marketKey, type BridgeServerOptions } from "./bridge/index.js";
import { CandleBuilder } from "./candles/index.js";
import { ClockRules, memoryClockRuleStore } from "./clock/index.js";
import type { AppDatabase } from "./database.js";
import { ChartHistory, EaBarFetcher, HistoryCatalog, HistorySaver, PERIOD_OF } from "./history/index.js";
import { startHttpServer } from "./http/http-server.js";
import { IndicatorEngine, IndicatorPackages, IndicatorValues } from "./indicators/index.js";
import { Recorder } from "./recording/index.js";
import { WindowSessions } from "./http/window-session.js";
import { AppSettings, type AppSettingsOptions } from "./settings/index.js";
import { TerminalManager, type TerminalManagerOptions } from "./terminals/index.js";

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
  /** The app's database (clock rules, recording); omitted, clock rules are kept in memory only and nothing is recorded. */
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

export type RunningServer = {
  bridge: BridgeServer;
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
  const bridge = new BridgeServer({
    now: config.now,
    resolveTerminal: config.resolveTerminal ?? ((identity) => terminals?.resolveTerminal(identity)),
    marketInfo: (market) => ({ clockRule: clockRules?.rule(market.brokerServer) ?? null, recording: recorder?.isRecording(market) ?? false }),
  });
  // Before the first sample: the stored rules decide what later samples confirm or contradict.
  const rules = (clockRules = await ClockRules.open(bridge, config.database?.clockRules ?? memoryClockRuleStore(), {
    now: config.now,
    localOffsetMinutes: config.localOffsetMinutes,
  }));
  try {
    // Before the first sample too: each market's last stored sample decides what the merge rule keeps.
    if (config.database) {
      recorder = await Recorder.open(bridge, config.database.recordings, {
        now: config.now,
        clockRule: (brokerServer) => rules.rule(brokerServer),
        digits: (market) => bridge.snapshot().feeds.find((f) => marketKey(f.market) === marketKey(market))?.digits,
      });
      const recording = recorder;
      const saved = config.database.savedBars;
      rules.onRuleChange((brokerServer, rule) => recording.ruleChanged(brokerServer, rule));
      rules.onRuleChange((brokerServer, rule) => saved.recomputeUtc(brokerServer, rule));
    }
    if (config.database) apiKeys = await ApiKeys.open(config.database.apiKeys, config.now);
    await bridge.start(`tcp://127.0.0.1:${config.eaPort}`);
  } catch (e) {
    await recorder?.close();
    await rules.close();
    throw e;
  }
  const candles = new CandleBuilder(bridge, { now: config.now });
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
    eaBars = new EaBarFetcher({
      bridge,
      save: async (market, digits, period, bars) => saved.insert(await recording.ensureMarket(market, digits), period, bars),
      clockRule: (brokerServer) => rules.rule(brokerServer),
    });
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
  const sessions = new WindowSessions({ open: config.openDashboard });
  const settings = config.settings ? new AppSettings(config.settings, { ea: config.eaPort, http: config.httpPort }) : undefined;
  sessions.addToken(config.windowToken);
  let http;
  try {
    http = await startHttpServer({ port: config.httpPort, bridge, candles, history, catalog, saver, clockRules: rules, recorder, apiKeys, sessions, dashboardFolder: config.dashboardFolder, terminals: () => terminals, settings, indicators: { packages, values: indicatorValues } });
  } catch (e) {
    indicatorValues.close();
    await engine.close();
    stopFilling();
    candles.close();
    eaBars?.close();
    await saver?.close();
    await bridge.close();
    await recorder?.close();
    await rules.close();
    throw e;
  }
  // Only after both ports are bound: a failed start must not have begun recovery or detection.
  terminals = config.terminals ? new TerminalManager(config.terminals, {
        bridge,
        eaPort: config.eaPort,
        now: config.now ?? Date.now,
        brokerClock: (brokerServer) => rules.get(brokerServer),
      }) : undefined;
  return {
    bridge,
    terminals,
    httpOrigin: http.origin,
    addWindowToken: (token) => sessions.addToken(token),
    addRemoteToken: (token) => sessions.addToken(token, "remote"),
    async close() {
      await terminals?.close();
      await http.close();
      indicatorValues.close();
      await engine.close();
      stopFilling();
      candles.close();
      eaBars?.close();
      // Before the host's CHECKPOINT: a save stops after the page it is writing.
      await saver?.close();
      await bridge.close();
      // No more samples arrive: the buffered ones are written before the host's CHECKPOINT (ADR 10).
      await recorder?.close();
      await rules.close();
    },
  };
}
