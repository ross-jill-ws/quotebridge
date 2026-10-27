// HTTP server for the app window: dashboard, state endpoint and live WebSocket, on loopback only (127.0.0.1 and ::1,
// so `localhost` reaches it whichever address it resolves to first, and never another program on the same port).
// Every request needs the window session (ADR 5) except the one-time token exchange at /session, and /api/v1 and
// /api/auth/session, which also take an API key (`Authorization: Bearer qbk_…`). A key reaches nothing else.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { userInfo } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ApiKeyRequestError, type ApiKeys, type ApiKeyView } from "../auth/index.js";
import type { BridgeServer } from "../bridge/index.js";
import { MAX_M1_CANDLES, PERIODS, type CandleBuilder, type Period } from "../candles/index.js";
import { ClockRuleRequestError, type ClockRules } from "../clock/index.js";
import { CSV_HEADER, csvRows, hstHeaderBytes, hstRecordBytes, PERIOD_MINUTES, type ChartHistory, type HistoryCatalog, type HistorySaver } from "../history/index.js";
import { MAX_BARS, MAX_ZIP_BYTES, PackageRequestError, type IndicatorPackage, type IndicatorPackages, type IndicatorValues } from "../indicators/index.js";
import { asPortInUse } from "../port-in-use.js";
import { ManifestError, MAX_HISTORY_BARS, parametersFromQuery } from "../../shared/indicator-manifest.js";
import { PAGE_BARS } from "../../shared/periods.js";
import { RecordingRequestError, type Recorder } from "../recording/index.js";
import { SettingsRequestError, type AppSettings } from "../settings/index.js";
import { TerminalRequestError, type TerminalManager } from "../terminals/index.js";
import { LiveSnapshots } from "./live.js";
import { json, write } from "./respond.js";
import { apiError, info, RestV1, type RestAccess, type RestCredential } from "./rest-v1.js";
import type { RequestEngine } from "../trading/index.js";
import type { Screenshots } from "../screenshots/index.js";
import { loopbackHosts, sameOrigin, sessionCookie, type SessionKind, type WindowSessions } from "./window-session.js";

/** Where the dashboard bundle is served from: `src/dashboard/` (or `dist/dashboard/` once built). */
export const DEFAULT_DASHBOARD_FOLDER = fileURLToPath(new URL("../../dashboard/", import.meta.url));

export type HttpServerOptions = {
  port: number;
  bridge: BridgeServer;
  candles: CandleBuilder;
  history: ChartHistory;
  /** The History page's markets and downloads. */
  catalog: HistoryCatalog;
  /** Saved history's saver, when the server has a database. */
  saver?: HistorySaver;
  clockRules: ClockRules;
  /** Recording, when the server has a database. */
  recorder?: Recorder;
  /** API keys, when the server has a database. */
  apiKeys?: ApiKeys;
  sessions: WindowSessions;
  dashboardFolder?: string;
  /** The terminal manager, when the server manages terminals. */
  terminals?: () => TerminalManager | undefined;
  /** The Settings view's model, when the server has a settings store. */
  settings?: AppSettings;
  /** Indicator packages and their cached values. */
  indicators?: { packages: IndicatorPackages; values: IndicatorValues };
  /** The shared trading request engine, when the server has a durable database. */
  trading?: () => RequestEngine<RestCredential> | undefined;
  /** Screenshots of the app window, taken by main. */
  screenshots?: Screenshots;
};

/** The most values one chart request asks for: a run's bars, less the most warm-up a package may declare. */
export const MAX_INDICATOR_LIMIT = MAX_BARS - MAX_HISTORY_BARS;

export type HttpServer = {
  /** e.g. "http://127.0.0.1:43123", the only origin the app window uses. */
  origin: string;
  close(): Promise<void>;
};

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const SEND_A_KEY = "Send an API key: Authorization: Bearer qbk_….";

/** IPv6 loopback cannot be bound on a computer without IPv6: the server then listens on 127.0.0.1 alone. */
const NO_IPV6 = ["EADDRNOTAVAIL", "EAFNOSUPPORT"];

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "frame-ancestors 'none'",
};

export async function startHttpServer(options: HttpServerOptions): Promise<HttpServer> {
  const { bridge, sessions } = options;
  const dashboardFolder = resolve(options.dashboardFolder ?? DEFAULT_DASHBOARD_FOLDER);
  const origin = `http://127.0.0.1:${options.port}`;
  const hosts = loopbackHosts(options.port);
  const cookie = sessionCookie(options.port);
  const connections = new Set<Socket>();

  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    handle(req, res).catch(() => {
      if (res.headersSent) res.destroy();
      else if (req.url?.startsWith("/api/v1")) apiError(res, 500, "internal-error", "Request failed. Check the app's logs.");
      else json(res, 500, { error: "Request failed. Check the app's logs." });
    });
  };
  const live = new LiveSnapshots(bridge, options.indicators?.values, options.indicators?.packages);
  const rest = new RestV1({
    bridge,
    catalog: options.catalog,
    history: options.history,
    clockRule: (brokerServer) => options.clockRules.rule(brokerServer),
    recorder: options.recorder,
    indicators: options.indicators,
    terminalName: (terminalId) => options.terminals?.()?.name(terminalId),
    trading: options.trading,
    screenshots: options.screenshots,
  });
  const onUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer) => {
    if (!hosts.includes(req.headers.host ?? "") || !sessions.authenticated(req.headers, cookie)) return refuse(socket, 401, "Unauthorized");
    if (new URL(req.url ?? "/", origin).pathname !== "/live") return refuse(socket, 404, "Not Found");
    // Only pages of this server may connect.
    if (!sameOrigin(req.headers, options.port)) return refuse(socket, 403, "Forbidden");
    if (live.full) return refuse(socket, 503, "Service Unavailable");
    live.accept(req, socket, head);
  };
  const servers: Server[] = [];
  try {
    for (const address of ["127.0.0.1", "::1"]) {
      const server = createServer(onRequest);
      server.on("upgrade", onUpgrade);
      server.on("connection", (socket) => {
        connections.add(socket);
        socket.once("close", () => connections.delete(socket));
      });
      const listening = await new Promise<boolean>((resolve, reject) => {
        server.once("error", (e: NodeJS.ErrnoException) =>
          address === "::1" && NO_IPV6.includes(e.code ?? "") ? resolve(false) : reject(asPortInUse(e, "http", options.port)),
        );
        server.listen(options.port, address, () => resolve(true));
      });
      if (listening) servers.push(server);
    }
  } catch (e) {
    live.close();
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    throw e;
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    // Only this server's own loopback names: refuses DNS-rebinding hosts.
    if (!hosts.includes(req.headers.host ?? "")) return json(res, 400, { error: "Unexpected host" });
    const url = new URL(req.url ?? "/", origin);

    if (url.pathname === "/session" && req.method === "GET") {
      const session = sessions.exchange(url.searchParams.get("token") ?? "");
      if (!session) return json(res, 401, { error: "This sign-in link has already been used. Reopen the app window." });
      res
        .writeHead(303, {
          location: "/",
          "set-cookie": `${cookie}=${session}; Path=/; HttpOnly; SameSite=Strict`,
          "cache-control": "no-store",
        })
        .end();
      return;
    }

    // Public: the CLI checks the API version before it has a key.
    if (url.pathname === "/api/v1/info" && (req.method === "GET" || req.method === "HEAD")) return json(res, 200, info());

    const v1 = url.pathname === "/api/v1" || url.pathname.startsWith("/api/v1/");
    const api = v1 || url.pathname === "/api/auth/session";
    // REST v1 answers its errors structured, `{ error: { code, message, details } }`.
    const refuse = (status: number, code: string, message: string) => (v1 ? apiError(res, status, code, message) : json(res, status, { error: message }));
    const authorization = req.headers.authorization?.trim();
    if (authorization !== undefined) {
      // The CLI and scripts. The app window never sends one, so a key cannot reach the key endpoints (ADR 5). No
      // cookie is involved, so there is no cross-site request to guard against with the Origin check.
      const scheme = authorization.split(" ")[0];
      if (scheme.toLowerCase() !== "bearer") return refuse(401, "unauthenticated", `${SEND_A_KEY} HTTP Basic is not accepted.`);
      if (!api) return json(res, 403, { error: "An API key reaches only /api/v1 and /api/auth/session." });
      const writes = req.method !== "GET" && req.method !== "HEAD";
      const apiKey = authorization.slice(scheme.length).trim();
      const check = options.apiKeys?.check(apiKey, writes) ?? { ok: false, status: 401, error: "This app keeps no API keys." };
      if (!check.ok) return refuse(check.status, check.status === 401 ? "unauthenticated" : "insufficient-scope", check.error);
      return handleApi(url, req, res, check.key, { apiKey }, check.key.scope);
    }

    const session = sessions.kind(req.headers, cookie);
    if (!session) {
      return refuse(401, "unauthenticated", api ? `${SEND_A_KEY} Create one in Settings › API keys.` : "Open the dashboard from the app window.");
    }

    // The cookie also reaches this host from pages on other local ports (same site): changes only from this server's pages.
    if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req.headers, options.port)) return refuse(403, "forbidden-origin", "Forbidden origin");

    if (api) return handleApi(url, req, res, null, { headers: req.headers }, session);
    if (session !== "window" && req.method !== "GET" && req.method !== "HEAD" &&
      (["/api/settings", "/api/setup", "/api/clock-rules", "/api/recordings/delete", "/api/markets/recording", "/api/history/save", "/api/feeds/remove"].includes(url.pathname) || url.pathname.startsWith("/api/terminals/"))) {
      return json(res, 403, { error: "Only the app window can change administrative settings, recordings or terminal setup." });
    }
    if (options.apiKeys && (url.pathname === "/api/api-keys" || url.pathname === "/api/api-keys/revoke")) {
      if (session !== "window") return json(res, 403, { error: "Only the app window can manage API keys." });
      return handleApiKeys(options.apiKeys, url, req, res);
    }
    if (url.pathname === "/api/state" && req.method === "GET") return json(res, 200, bridge.snapshot());
    if (url.pathname === "/api/candles" && req.method === "GET") return handleCandles(url, res);
    if (options.indicators && url.pathname.startsWith("/api/indicators/package")) {
      const handled = await handlePackages(options.indicators.packages, session, url, req, res);
      if (handled) return;
    }
    if (options.indicators && url.pathname === "/api/indicators/values" && req.method === "GET") return handleIndicatorValues(options.indicators, url, res);
    if (url.pathname === "/api/feeds/remove" && req.method === "POST") {
      const body = await readJson(req).catch(() => undefined);
      const feed = (body as { feed?: unknown } | undefined)?.feed;
      if (typeof feed !== "string" || feed.length > 1000) return json(res, 400, { error: "Expected a feed identifier" });
      try {
        await bridge.remove(feed);
      } catch (e) {
        return json(res, 409, { error: e instanceof Error ? e.message : "Cannot remove this feed" });
      }
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === "/api/history" || url.pathname.startsWith("/api/history/")) return handleHistory(url, req, res);
    if (url.pathname === "/api/clock-rules") return handleClockRules(req, res);
    if (options.recorder && ["/api/markets/recording", "/api/recordings", "/api/recordings/delete"].includes(url.pathname)) return handleRecording(options.recorder, url, req, res);
    if (options.settings && url.pathname === "/api/settings") return handleSettings(options.settings, session, req, res);
    const terminals = options.terminals?.();
    if (terminals) {
      const handled = await handleTerminals(terminals, url, req, res);
      if (handled) return;
    }
    if (url.pathname.startsWith("/api/")) return json(res, 404, { error: "Unknown endpoint" });
    if (req.method === "GET" || req.method === "HEAD") return serveStatic(url.pathname, req, res);
    json(res, 405, { error: "Method not allowed" });
  }

  /** The REST API, past the key or window session check: GET /api/auth/session tells the CLI whose key it holds. */
  function handleApi(url: URL, req: IncomingMessage, res: ServerResponse, key: ApiKeyView | null, credential: RestCredential, access: RestAccess) {
    if (url.pathname !== "/api/auth/session") return rest.handle(url, req, res, credential, access);
    if (!key) return json(res, 401, { error: SEND_A_KEY });
    json(res, 200, { username: windowsUser(), key: { name: key.name, prefix: key.prefix, scope: key.scope }, expires: null });
  }

  /**
   * Settings › API keys, from the app window only: GET /api/api-keys lists them, POST /api/api-keys { name, scope }
   * makes one (201; the key is in this answer only), POST /api/api-keys/revoke { id } revokes one.
   */
  async function handleApiKeys(apiKeys: ApiKeys, url: URL, req: IncomingMessage, res: ServerResponse) {
    const route = `${req.method} ${url.pathname}`;
    if (route === "GET /api/api-keys") return json(res, 200, { keys: apiKeys.list() });
    if (route !== "POST /api/api-keys" && route !== "POST /api/api-keys/revoke") return json(res, 405, { error: "Method not allowed" });
    let body: unknown;
    try {
      body = await readJson(req);
    } catch {
      return json(res, 400, { error: "Expected a JSON body." });
    }
    try {
      if (route === "POST /api/api-keys") return json(res, 201, await apiKeys.create(body));
      json(res, 200, { keys: await apiKeys.revoke(body) });
    } catch (e) {
      if (!(e instanceof ApiKeyRequestError)) throw e;
      json(res, e.status, { error: e.message });
    }
  }

  /** Broker clocks for the Terminals panel: GET lists every broker server's rule, POST sets one as the trader chose. */
  async function handleClockRules(req: IncomingMessage, res: ServerResponse) {
    if (req.method === "GET") return json(res, 200, { clockRules: options.clockRules.list() });
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
    let body: unknown;
    try {
      body = await readJson(req);
    } catch {
      return json(res, 400, { error: "Expected a JSON body." });
    }
    try {
      json(res, 200, await options.clockRules.set(body));
    } catch (e) {
      if (!(e instanceof ClockRuleRequestError)) throw e;
      json(res, e.status, { error: e.message });
    }
  }

  /**
   * Recording: POST /api/markets/recording switches a market on or off (the Feeds rows), GET /api/recordings lists
   * what is recorded (Settings › Recording), POST /api/recordings/delete deletes a market's samples.
   */
  async function handleRecording(recorder: Recorder, url: URL, req: IncomingMessage, res: ServerResponse) {
    const route = `${req.method} ${url.pathname}`;
    try {
      if (route === "GET /api/recordings") return json(res, 200, { recordings: await recorder.list() });
      if (route !== "POST /api/markets/recording" && route !== "POST /api/recordings/delete") return json(res, 405, { error: "Method not allowed" });
      let body: unknown;
      try {
        body = await readJson(req);
      } catch {
        return json(res, 400, { error: "Expected a JSON body." });
      }
      if (route === "POST /api/markets/recording") return json(res, 200, await recorder.setRecording(body));
      json(res, 200, { recordings: await recorder.deleteSamples(body) });
    } catch (e) {
      if (!(e instanceof RecordingRequestError)) throw e;
      json(res, e.status, { error: e.message });
    }
  }

  /**
   * The Charts view's candles for one feed and period, with its latest ask: a page of the chart history, the latest
   * `limit` (1–10,080; 10,080 when not given) older than `before` (UTC seconds; the latest when not given). Candle
   * `time` is its start in UTC seconds (ADR 11); `clockRule` is the broker server's, null while unknown (times are
   * then broker seconds as they are); `source` is "hst", "saved" or "live"; `complete` is true when no older bars exist;
   * `since` is this server's start in epoch milliseconds.
   */
  async function handleCandles(url: URL, res: ServerResponse) {
    const feed = bridge.snapshot().feeds.find((f) => f.feed === url.searchParams.get("feed"));
    if (!feed) return json(res, 404, { error: "Unknown feed" });
    const period = url.searchParams.get("period");
    if (!PERIODS.includes(period as Period)) return json(res, 400, { error: `Expected a period: ${PERIODS.join(", ")}` });
    const limitText = url.searchParams.get("limit");
    const limit = limitText === null ? undefined : Number(limitText);
    if (limit !== undefined && !(/^\d+$/.test(limitText!) && limit >= 1 && limit <= MAX_M1_CANDLES)) {
      return json(res, 400, { error: `Expected a limit from 1 to ${MAX_M1_CANDLES}` });
    }
    const beforeText = url.searchParams.get("before");
    const before = beforeText === null ? undefined : Number(beforeText);
    if (before !== undefined && !(/^\d{1,12}$/.test(beforeText!) && Number.isSafeInteger(before))) return json(res, 400, { error: "Expected before as UTC seconds" });
    const page = await options.history.page(feed, period as Period, limit ?? MAX_M1_CANDLES, before);
    json(res, 200, {
      feed: feed.feed,
      market: feed.market,
      period,
      digits: feed.digits,
      since: options.candles.since,
      ask: options.candles.ask(feed.feed),
      clockRule: feed.clockRule,
      ...page,
    });
  }

  /**
   * The Indicators page: GET /api/indicators/packages lists every package with its manifest and hash, whether it is
   * bundled and enabled, and how many windows' charts use it (as they report it), and `manage`: whether this session
   * may change them; GET /api/indicators/package?id= gives one's README and licence. From the app window only (ADR 5,
   * ADR 12): POST /api/indicators/packages/enabled { id, enabled } switches one on or off; POST
   * /api/indicators/packages/preview (a ZIP, application/zip) checks a package and answers what it is and what it
   * replaces, installing nothing; POST /api/indicators/packages/install (the same ZIP; `?downgrade=1` to confirm an
   * older version) installs it; POST /api/indicators/packages/delete { id } deletes an installed one. The changes
   * answer the list. Returns false when the route is not one of them.
   */
  async function handlePackages(packages: IndicatorPackages, session: SessionKind, url: URL, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const list = () => ({
      manage: session === "window",
      packages: packages.list().map((p) => ({ manifest: p.manifest, hash: p.hash, bundled: p.bundled, enabled: packages.enabled(p.manifest.id), charts: live.chartsUsing(p.manifest.id) })),
    });
    const route = `${req.method} ${url.pathname}`;
    if (route === "GET /api/indicators/packages") {
      json(res, 200, list());
      return true;
    }
    if (route === "GET /api/indicators/package") {
      const pkg = packages.get(url.searchParams.get("id") ?? "");
      if (!pkg) json(res, 404, { error: "Unknown indicator package" });
      else json(res, 200, { id: pkg.manifest.id, readme: pkg.readme, licence: pkg.licence });
      return true;
    }
    const changes = ["enabled", "preview", "install", "delete"].map((name) => `POST /api/indicators/packages/${name}`);
    if (!changes.includes(route)) return false;
    if (session !== "window") {
      json(res, 403, { error: "Only the app window can install, enable, disable or delete indicator packages." });
      return true;
    }
    try {
      if (route === "POST /api/indicators/packages/preview" || route === "POST /api/indicators/packages/install") {
        const zip = await readZip(req);
        if (route === "POST /api/indicators/packages/install") {
          await packages.install(zip, { downgrade: url.searchParams.get("downgrade") === "1" });
          json(res, 200, list());
          return true;
        }
        const { package: pkg, replaces, downgrade } = await packages.preview(zip);
        const about = (p: IndicatorPackage) => ({ manifest: p.manifest, hash: p.hash });
        json(res, 200, { ...about(pkg), readme: pkg.readme, licence: pkg.licence, replaces: replaces && about(replaces), downgrade });
        return true;
      }
      const body = (await readJson(req).catch(() => undefined)) as { id?: unknown; enabled?: unknown } | undefined;
      if (route === "POST /api/indicators/packages/delete") {
        if (typeof body?.id !== "string") throw new PackageRequestError(400, "Expected { id }.");
        await packages.delete(body.id);
        json(res, 200, list());
        return true;
      }
      if (typeof body?.id !== "string" || typeof body.enabled !== "boolean") throw new PackageRequestError(400, "Expected { id, enabled }.");
      if (!(await packages.setEnabled(body.id, body.enabled))) throw new PackageRequestError(404, "Unknown indicator package");
      json(res, 200, list());
    } catch (e) {
      if (!(e instanceof PackageRequestError)) throw e;
      json(res, e.status, { error: e.message, ...e.details });
    }
    return true;
  }

  /**
   * A chart's indicator values: the package's (`package`, its id) for `feed` and `period` with parameters `p.<id>`
   * (their defaults when left out), over the candles page `limit` (1–45,000; 900 when not given) older than `before`
   * (UTC seconds; the latest when not given). See IndicatorValuesAnswer.
   */
  async function handleIndicatorValues(indicators: NonNullable<HttpServerOptions["indicators"]>, url: URL, res: ServerResponse) {
    const query = url.searchParams;
    const feed = bridge.snapshot().feeds.find((f) => f.feed === query.get("feed"));
    if (!feed) return json(res, 404, { error: "Unknown feed" });
    const period = query.get("period");
    if (!PERIODS.includes(period as Period)) return json(res, 400, { error: `Expected a period: ${PERIODS.join(", ")}` });
    const pkg = indicators.packages.get(query.get("package") ?? "");
    // A chart keeps such an indicator in its legend, marked Not available.
    if (!pkg) return json(res, 404, { error: `Unknown indicator package. Packages: ${indicators.packages.list().map((p) => p.manifest.id).join(", ")}`, notAvailable: true });
    if (!indicators.packages.enabled(pkg.manifest.id)) return json(res, 404, { error: `${pkg.manifest.name} is not available: it is disabled on the Indicators page.`, notAvailable: true });
    const limitText = query.get("limit");
    const limit = limitText === null ? PAGE_BARS : Number(limitText);
    if (limitText !== null && !(/^\d+$/.test(limitText) && limit >= 1 && limit <= MAX_INDICATOR_LIMIT)) return json(res, 400, { error: `Expected a limit from 1 to ${MAX_INDICATOR_LIMIT}` });
    const beforeText = query.get("before");
    const before = beforeText === null ? undefined : Number(beforeText);
    if (before !== undefined && !(/^\d{1,12}$/.test(beforeText!) && Number.isSafeInteger(before))) return json(res, 400, { error: "Expected before as UTC seconds" });
    let parameters;
    try {
      parameters = parametersFromQuery(pkg.manifest, query);
    } catch (e) {
      if (!(e instanceof ManifestError)) throw e;
      return json(res, 400, { error: e.message });
    }
    json(res, 200, await indicators.values.values(feed, period as Period, pkg, parameters, limit, before));
  }

  /**
   * The History page: GET /api/history lists every market with its periods; /api/history/csv and /api/history/hst
   * download everything available for `market` (its key, as listed) and `period`; POST /api/history/save { market }
   * saves a market's history once (202; the list shows its progress).
   */
  async function handleHistory(url: URL, req: IncomingMessage, res: ServerResponse) {
    if (url.pathname === "/api/history/save" && options.saver) {
      if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
      const body = await readJson(req).catch(() => undefined);
      const market = parseMarket(typeof (body as { market?: unknown } | undefined)?.market === "string" ? (body as { market: string }).market : null);
      if (!market) return json(res, 400, { error: 'Expected market as ["<broker server>","<symbol>"]' });
      if (!(await options.saver.request(market))) return json(res, 404, { error: `No HST file of ${market.symbol} on ${market.brokerServer} is on this computer.` });
      return json(res, 202, { market: JSON.stringify([market.brokerServer, market.symbol]), saving: options.saver.progress(market) });
    }
    if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
    if (url.pathname === "/api/history") return json(res, 200, { markets: await options.catalog.list() });
    const format = url.pathname === "/api/history/csv" ? "csv" : url.pathname === "/api/history/hst" ? "hst" : undefined;
    if (!format) return json(res, 404, { error: "Unknown endpoint" });
    const market = parseMarket(url.searchParams.get("market"));
    if (!market) return json(res, 400, { error: 'Expected market as ["<broker server>","<symbol>"]' });
    const period = url.searchParams.get("period") as Period;
    if (!PERIODS.includes(period)) return json(res, 400, { error: `Expected a period: ${PERIODS.join(", ")}` });
    const download = await options.catalog.download(market, period);
    if (!download) return json(res, 404, { error: `No history of ${market.symbol} ${period} on ${market.brokerServer} is available.` });
    const minutes = PERIOD_MINUTES[period];
    const { digits, clockRule, pages } = download;
    res.writeHead(200, {
      "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/octet-stream",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${market.symbol}${minutes}.${format}`)}`,
      "cache-control": "no-store",
    });
    // Written a page at a time: a long M1 file is never held whole. A client that goes away stops the loop (closing the file).
    await write(res, format === "csv" ? CSV_HEADER : hstHeaderBytes(market.symbol, minutes, digits));
    for await (const bars of pages) {
      if (res.destroyed) return;
      await write(res, format === "csv" ? csvRows(bars, digits, clockRule) : hstRecordBytes(bars));
    }
    res.end();
  }

  /** The Settings view: GET answers what it shows and whether this session may change it, POST applies a change and answers the same. */
  async function handleSettings(settings: AppSettings, session: SessionKind, req: IncomingMessage, res: ServerResponse) {
    const manage = session === "window";
    if (req.method === "GET") return json(res, 200, { ...(await settings.view()), manage });
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
    let body: unknown;
    try {
      body = await readJson(req);
    } catch {
      return json(res, 400, { error: "Expected a JSON body." });
    }
    try {
      json(res, 200, { ...(await settings.change(body)), manage });
    } catch (e) {
      if (!(e instanceof SettingsRequestError)) throw e;
      json(res, e.status, { error: e.message });
    }
  }

  /** Terminals view and setup screen endpoints. Returns false when the route is not one of them. */
  async function handleTerminals(terminals: TerminalManager, url: URL, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const route = `${req.method} ${url.pathname}`;
    const body = async () => {
      try {
        return await readJson(req);
      } catch {
        throw new TerminalRequestError(400, "Expected a JSON body.");
      }
    };
    try {
      switch (route) {
        case "GET /api/terminals":
          json(res, 200, await terminals.state());
          return true;
        case "POST /api/terminals/rescan":
          json(res, 200, await terminals.rescan());
          return true;
        case "POST /api/terminals/add-folder":
          json(res, 200, { terminal: await terminals.addFolder(((await body()) as { folder?: unknown } | null)?.folder) });
          return true;
        case "POST /api/terminals/install":
          await terminals.install(await body());
          json(res, 202, await terminals.state());
          return true;
        case "POST /api/terminals/remove":
          json(res, 200, await terminals.remove(await body()));
          return true;
        case "POST /api/terminals/decline":
          await terminals.decline(await body());
          json(res, 200, await terminals.state());
          return true;
        case "GET /api/terminals/compile-log":
          json(res, 200, await terminals.compileLog(url.searchParams.get("terminalId") ?? undefined));
          return true;
        case "POST /api/setup":
          await terminals.completeSetup(await body());
          json(res, 202, await terminals.state());
          return true;
        default:
          return false;
      }
    } catch (e) {
      if (e instanceof TerminalRequestError) {
        json(res, e.status, { error: e.message });
        return true;
      }
      throw e;
    }
  }

  async function serveStatic(pathname: string, req: IncomingMessage, res: ServerResponse) {
    let relative: string;
    try {
      relative = decodeURIComponent(pathname);
    } catch {
      return json(res, 400, { error: "Bad path" });
    }
    if (relative.endsWith("/")) relative += "index.html";
    const file = resolve(join(dashboardFolder, relative));
    if (relative.includes("\0") || !file.startsWith(dashboardFolder + sep)) return json(res, 404, { error: "Not found" });
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) return json(res, 404, { error: "Not found" });
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "content-length": info.size,
      "cache-control": "no-cache",
    });
    if (req.method === "HEAD") return void res.end();
    createReadStream(file).on("error", () => res.destroy()).pipe(res);
  }

  return {
    origin,
    close: () =>
      new Promise<void>((resolve) => {
        live.close();
        Promise.all(servers.map((server) => new Promise((closed) => server.close(closed)))).then(() => resolve());
        for (const socket of connections) socket.destroy();
      }),
  };
}

/** The Windows user the app runs as: the CLI says it is signed in as them. */
function windowsUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "owner";
  }
}

/** A market key, `["<broker server>","<symbol>"]`, or null when it is not one. */
function parseMarket(text: string | null): { brokerServer: string; symbol: string } | null {
  try {
    const value: unknown = JSON.parse(text ?? "");
    if (Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === "string" && v.length > 0 && v.length <= 200)) {
      return { brokerServer: value[0], symbol: value[1] };
    }
  } catch {}
  return null;
}

const MAX_BODY_BYTES = 16 * 1024;

/** A package ZIP as the request's body; throws PackageRequestError when it is not one or is too large. */
async function readZip(req: IncomingMessage): Promise<Buffer> {
  if (!/^application\/(zip|x-zip-compressed|octet-stream)\b/.test(req.headers["content-type"] ?? "")) throw new PackageRequestError(415, "Expected a ZIP (application/zip).");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    // Read on to the end: the answer reaches a client still sending.
    if (size <= MAX_ZIP_BYTES) chunks.push(chunk);
  }
  if (size > MAX_ZIP_BYTES) throw new PackageRequestError(413, "The ZIP is larger than 2 MiB.");
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) throw Error("Expected JSON");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Error("Body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function refuse(socket: Socket, status: number, reason: string) {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
