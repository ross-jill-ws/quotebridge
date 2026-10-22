// HTTP server for the app window: dashboard, state endpoint and live WebSocket, on 127.0.0.1 only.
// Every request needs the window session (ADR 5) except the one-time token exchange at /session, and /api/v1 and
// /api/auth/session, which also take an API key (`Authorization: Bearer qbk_…`). A key reaches nothing else.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { userInfo } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ApiKeyRequestError, type ApiKeys, type ApiKeyView } from "../auth/index.js";
import type { BridgeServer } from "../bridge/index.js";
import { MAX_M1_CANDLES, PERIODS, type CandleBuilder, type Period } from "../candles/index.js";
import { ClockRuleRequestError, type ClockRules } from "../clock/index.js";
import { CSV_HEADER, csvRows, hstHeaderBytes, hstRecordBytes, PERIOD_MINUTES, type ChartHistory, type HistoryCatalog, type HistorySaver } from "../history/index.js";
import { asPortInUse } from "../port-in-use.js";
import { RecordingRequestError, type Recorder } from "../recording/index.js";
import { SettingsRequestError, type AppSettings } from "../settings/index.js";
import { TerminalRequestError, type TerminalManager } from "../terminals/index.js";
import { LiveSnapshots } from "./live.js";
import { json, write } from "./respond.js";
import { info, RestV1 } from "./rest-v1.js";
import { sessionCookie, type WindowSessions } from "./window-session.js";

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
};

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

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "frame-ancestors 'none'",
};

export async function startHttpServer(options: HttpServerOptions): Promise<HttpServer> {
  const { bridge, sessions } = options;
  const dashboardFolder = resolve(options.dashboardFolder ?? DEFAULT_DASHBOARD_FOLDER);
  const origin = `http://127.0.0.1:${options.port}`;
  const host = `127.0.0.1:${options.port}`;
  const cookie = sessionCookie(options.port);
  const connections = new Set<Socket>();

  const server = createServer((req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: "Request failed. Check the app's logs." });
      else res.destroy();
    });
  });
  const live = new LiveSnapshots(bridge);
  const rest = new RestV1({
    bridge,
    candles: options.candles,
    catalog: options.catalog,
    history: options.history,
    clockRule: (brokerServer) => options.clockRules.rule(brokerServer),
    recorder: options.recorder,
    terminalName: (terminalId) => options.terminals?.()?.name(terminalId),
  });
  server.on("upgrade", (req, socket: Socket, head: Buffer) => {
    if (req.headers.host !== host || !sessions.authenticated(req.headers, cookie)) return refuse(socket, 401, "Unauthorized");
    if (new URL(req.url ?? "/", origin).pathname !== "/live") return refuse(socket, 404, "Not Found");
    // The cookie also reaches 127.0.0.1 from pages on other local ports (same site): only the app window's origin may connect.
    if (req.headers.origin !== origin) return refuse(socket, 403, "Forbidden");
    if (live.full) return refuse(socket, 503, "Service Unavailable");
    live.accept(req, socket, head);
  });
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", (e) => reject(asPortInUse(e, "http", options.port)));
      server.listen(options.port, "127.0.0.1", resolve);
    });
  } catch (e) {
    live.close();
    throw e;
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    // Only the app window's own origin: refuses DNS-rebinding hosts.
    if (req.headers.host !== host) return json(res, 400, { error: "Unexpected host" });
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

    const api = url.pathname === "/api/v1" || url.pathname.startsWith("/api/v1/") || url.pathname === "/api/auth/session";
    const authorization = req.headers.authorization?.trim();
    if (authorization !== undefined) {
      // The CLI and scripts. The app window never sends one, so a key cannot reach the key endpoints (ADR 5). No
      // cookie is involved, so there is no cross-site request to guard against with the Origin check.
      const scheme = authorization.split(" ")[0];
      if (scheme.toLowerCase() !== "bearer") return json(res, 401, { error: `${SEND_A_KEY} HTTP Basic is not accepted.` });
      if (!api) return json(res, 403, { error: "An API key reaches only /api/v1 and /api/auth/session." });
      const writes = req.method !== "GET" && req.method !== "HEAD";
      const check = options.apiKeys?.check(authorization.slice(scheme.length).trim(), writes) ?? { ok: false, status: 401, error: "This app keeps no API keys." };
      if (!check.ok) return json(res, check.status, { error: check.error });
      return handleApi(url, req, res, check.key);
    }

    if (!sessions.authenticated(req.headers, cookie)) {
      return json(res, 401, { error: api ? `${SEND_A_KEY} Create one in Settings › API keys.` : "Open the dashboard from the app window." });
    }

    // The cookie also reaches 127.0.0.1 from pages on other local ports (same site): changes only from the app window's origin.
    if (req.method !== "GET" && req.method !== "HEAD" && req.headers.origin !== origin) return json(res, 403, { error: "Forbidden origin" });

    if (api) return handleApi(url, req, res, null);
    if (options.apiKeys && (url.pathname === "/api/api-keys" || url.pathname === "/api/api-keys/revoke")) return handleApiKeys(options.apiKeys, url, req, res);
    if (url.pathname === "/api/state" && req.method === "GET") return json(res, 200, bridge.snapshot());
    if (url.pathname === "/api/candles" && req.method === "GET") return handleCandles(url, res);
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
    if (options.settings && url.pathname === "/api/settings") return handleSettings(options.settings, req, res);
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
  function handleApi(url: URL, req: IncomingMessage, res: ServerResponse, key: ApiKeyView | null) {
    if (url.pathname !== "/api/auth/session") return rest.handle(url, req, res);
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

  /** The Settings view: GET answers what it shows, POST applies a change and answers the same. */
  async function handleSettings(settings: AppSettings, req: IncomingMessage, res: ServerResponse) {
    if (req.method === "GET") return json(res, 200, await settings.view());
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
    let body: unknown;
    try {
      body = await readJson(req);
    } catch {
      return json(res, 400, { error: "Expected a JSON body." });
    }
    try {
      json(res, 200, await settings.change(body));
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
        server.close(() => resolve());
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
