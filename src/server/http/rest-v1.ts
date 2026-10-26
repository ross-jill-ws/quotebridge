// Public REST API v1, for the CLI and scripts: exact market, account, terminal and request resources (M5 spec, Public
// REST v1 contract). No legacy paths, selectors or adapters. Success answers `{ data, meta }`, errors
// `{ error: { code, message, details } }`; exports are files. Prices, lots and money are decimal strings, IDs and
// tickets strings, times UTC ISO-8601 (with `brokerTime` beside them where MetaTrader stamps broker time).
// Reads reuse M3 chart history and M4 indicator values; trading goes through the shared request engine.
import type { IncomingMessage, ServerResponse } from "node:http";
import { UNKNOWN_RULE, brokerToUtc, utcToBroker, type ClockRule } from "../../shared/clock.js";
import { PAGE_BARS, PERIODS, type Period } from "../../shared/periods.js";
import { marketKey, type BridgeServer, type BridgeSnapshot, type FeedSnapshot, type Market, type TerminalPresence } from "../bridge/index.js";
import { ONLINE_WINDOW_MS } from "../bridge/bridge.js";
import { AccountReadError, type AccountSnapshot } from "../bridge/accounts.js";
import type { AccountOrder } from "../bridge/account-protocol.js";
import { selectMarketSource } from "../bridge/market-source.js";
import type { Candle } from "../candles/index.js";
import { CSV_HEADER, csvRows, hstHeaderBytes, hstRecordBytes, PERIOD_MINUTES, PERIOD_OF, type ChartHistory, type HistoryCatalog, type HistoryPage } from "../history/index.js";
import { marketId } from "../identity/index.js";
import { ManifestError, parametersFromQuery } from "../../shared/indicator-manifest.js";
import type { IndicatorPackage, IndicatorPackages, IndicatorValues } from "../indicators/index.js";
import type { Recorder } from "../recording/index.js";
import type { TradeResult } from "../bridge/account-protocol.js";
import { TradingError, type JournalRecord, type RequestEngine, type TradeInput, type TradingPreview } from "../trading/index.js";
import { json, write } from "./respond.js";

/** The REST API version; the CLI checks it at /api/v1/info. */
export const API_VERSION = 1;

/** The latest time a query takes, in UTC milliseconds. */
const MAX_MS = 9_999_999_999_999;

/** Discovery and journal collections: a page of 100 by default, 500 at most. */
const PAGE = { default: 100, max: 500 };

/** Who is asking, for the request engine: an API key, or the app window's (or a remote browser's) session headers. */
export type RestCredential = { apiKey: string } | { headers: IncomingMessage["headers"] };

export type RestV1Options = {
  bridge: BridgeServer;
  catalog: HistoryCatalog;
  history: ChartHistory;
  clockRule: (brokerServer: string) => ClockRule | null;
  /** Recording, when the server has a database. */
  recorder?: Recorder;
  /** Indicator packages and their cached values, shared with the charts. */
  indicators?: { packages: IndicatorPackages; values: IndicatorValues };
  /** A terminal's name as the Terminals view shows it; undefined when unknown. */
  terminalName: (terminalId: string) => string | undefined;
  /** The shared request engine; absent without a durable database. */
  trading?: () => RequestEngine<RestCredential> | undefined;
};

/** An answer the client can act on: `status` is the HTTP status, `code` stable, `details` e.g. candidates. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown = null,
  ) {
    super(message);
  }
}

/** Writes a structured error. */
export function apiError(res: ServerResponse, status: number, code: string, message: string, details: unknown = null) {
  json(res, status, { error: { code, message, details } });
}

type Context = { query: URLSearchParams; req: IncomingMessage; res: ServerResponse; credential: RestCredential; params: string[] };
type Answer = { data: unknown; meta?: Record<string, unknown>; status?: number } | "sent";
type Route = { method: "GET" | "POST"; pattern: RegExp; run: (c: Context) => Promise<Answer> };

/** A bar read's timeframe, `limit` and bounds in broker seconds: `from` inclusive, `before` exclusive (none when undefined). */
type BarWindow = { period: Period; limit: number; from: number; before: number | undefined };

/** A known market, as discovery lists it. */
type KnownMarket = Market & { id: string; digits: number | null };

export class RestV1 {
  private readonly routes: Route[];

  constructor(private readonly options: RestV1Options) {
    const get = (pattern: RegExp, run: Route["run"]): Route => ({ method: "GET", pattern, run });
    const post = (pattern: RegExp, run: Route["run"]): Route => ({ method: "POST", pattern, run });
    this.routes = [
      get(/^\/markets$/, (c) => this.markets(c)),
      get(/^\/markets\/([^/]+)$/, (c) => this.market(c)),
      get(/^\/markets\/([^/]+)\/quote$/, (c) => this.quote(c)),
      get(/^\/markets\/([^/]+)\/candles$/, (c) => this.candles(c)),
      get(/^\/markets\/([^/]+)\/samples$/, (c) => this.samples(c)),
      get(/^\/markets\/([^/]+)\/history$/, (c) => this.historyCoverage(c)),
      get(/^\/markets\/([^/]+)\/export$/, (c) => this.export(c)),
      get(/^\/markets\/([^/]+)\/indicators\/([^/]+)$/, (c) => this.indicatorValues(c)),
      get(/^\/accounts$/, (c) => this.accounts(c)),
      get(/^\/accounts\/([^/]+)$/, (c) => this.account(c)),
      get(/^\/accounts\/([^/]+)\/funds$/, (c) => this.funds(c)),
      get(/^\/accounts\/([^/]+)\/positions(?:\/([^/]+))?$/, (c) => this.trades(c, "positions")),
      get(/^\/accounts\/([^/]+)\/orders(?:\/([^/]+))?$/, (c) => this.trades(c, "orders")),
      get(/^\/accounts\/([^/]+)\/markets\/([^/]+)\/conditions$/, (c) => this.conditions(c)),
      get(/^\/terminals$/, (c) => this.terminals(c)),
      get(/^\/terminals\/([^/]+)$/, (c) => this.terminal(c)),
      get(/^\/terminals\/([^/]+)\/feeds$/, (c) => this.terminalFeeds(c)),
      get(/^\/terminals\/([^/]+)\/feeds\/([^/]+)$/, (c) => this.terminalFeed(c)),
      post(/^\/requests\/preview$/, (c) => this.preview(c)),
      post(/^\/requests\/([^/]+)\/execute$/, (c) => this.execute(c)),
      post(/^\/requests\/([^/]+)\/review$/, (c) => this.review(c)),
      get(/^\/requests$/, (c) => this.requests(c)),
      // Not /requests/preview, which is a POST.
      get(/^\/requests\/(?!preview$)([^/]+)$/, (c) => this.request(c)),
      get(/^\/indicators$/, (c) => this.indicatorList(c)),
      get(/^\/indicators\/([^/]+)$/, (c) => this.indicator(c)),
    ];
  }

  /** Answers a request under /api/v1 (but /api/v1/info, which is public), past the key or window session check. */
  async handle(url: URL, req: IncomingMessage, res: ServerResponse, credential: RestCredential): Promise<void> {
    const path = url.pathname.slice("/api/v1".length);
    const method = req.method === "HEAD" ? "GET" : req.method;
    try {
      const matching = this.routes.map((route) => ({ route, match: route.pattern.exec(path) })).filter((r) => r.match);
      if (!matching.length) throw new ApiError(404, "unknown-route", `No API v1 resource at ${path || "/"}. See the REST API manual.`);
      const found = matching.find((r) => r.route.method === method);
      if (!found) throw new ApiError(405, "method-not-allowed", `${req.method} is not allowed here; use ${[...new Set(matching.map((r) => r.route.method))].join(" or ")}.`);
      // An optional segment left out stays undefined.
      const params = found.match!.slice(1).map((p) => (p === undefined ? (undefined as never) : segment(p)));
      const answer = await found.route.run({ query: url.searchParams, req, res, credential, params });
      if (answer === "sent") return;
      json(res, answer.status ?? 200, { data: answer.data, meta: answer.meta ?? {} });
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      if (res.headersSent) return void res.destroy();
      apiError(res, e.status, e.code, e.message, e.details);
    }
  }

  /** GET /markets: every known market, by symbol then broker server; `brokerServer` and `symbol` filter exactly. */
  private async markets(c: Context): Promise<Answer> {
    only(c.query, ["brokerServer", "symbol", "limit", "cursor"]);
    const brokerServer = text(c.query, "brokerServer");
    const symbol = text(c.query, "symbol");
    const markets = (await this.knownMarkets()).filter((m) => (brokerServer === undefined || m.brokerServer === brokerServer) && (symbol === undefined || m.symbol === symbol));
    return paginate(c.query, markets.map((m) => this.marketView(m)), (m) => [m.symbol, m.brokerServer, m.id]);
  }

  /** GET /markets/{marketId}. */
  private async market(c: Context): Promise<Answer> {
    only(c.query, []);
    return { data: this.marketView(await this.knownMarket(c.params[0])) };
  }

  /** A market as discovery describes it, with its feeds as sources. */
  private marketView(m: KnownMarket) {
    const feeds = this.feedsOf(m);
    return {
      id: m.id,
      brokerServer: m.brokerServer,
      symbol: m.symbol,
      label: `${m.symbol} · ${m.brokerServer}`,
      digits: m.digits,
      connected: feeds.some((f) => f.online),
      recording: this.options.recorder?.isRecording(m) ?? false,
      sources: feeds.map((f) => ({ terminalId: f.terminal, feedId: f.feed, connected: f.online })),
    };
  }

  /** Every market the app knows: its feeds', recorded and saved ones, and those in the HST folders. */
  private async knownMarkets(): Promise<KnownMarket[]> {
    return (await this.options.catalog.list()).map((m) => ({ id: marketId(m.brokerServer, m.symbol), brokerServer: m.brokerServer, symbol: m.symbol, digits: m.digits }));
  }

  /** A market by its exact ID; unknown answers 404. */
  private async knownMarket(id: string): Promise<KnownMarket> {
    const market = (await this.knownMarkets()).find((m) => m.id === id);
    if (!market) throw new ApiError(404, "unknown-market", "No known market has this ID. List markets with GET /api/v1/markets.");
    return market;
  }

  /**
   * GET /markets/{marketId}/quote: the exact market's best source (connected, newest broker quote, newest receipt,
   * terminal ID), explicitly `last-known` when offline; else its last recorded sample (`recorded`, no terminal).
   */
  private async quote(c: Context): Promise<Answer> {
    only(c.query, []);
    const market = await this.knownMarket(c.params[0]);
    const snapshot = this.options.bridge.snapshot();
    const source = selectMarketSource(snapshot, market);
    const digits = market.digits ?? source?.feed.digits ?? 5;
    const head = { marketId: market.id, brokerServer: market.brokerServer, symbol: market.symbol, digits };
    if (source?.feed.latest) {
      const { bid, ask, quoteTime } = source.feed.latest;
      return {
        data: {
          ...head,
          ...prices(bid, ask, digits),
          ...this.times(market.brokerServer, quoteTime),
          state: source.state,
          stale: source.state !== "connected" || source.feed.stale || source.sourceSilent,
          quoteAgeMs: source.quoteAgeMs,
          sourceSilenceMs: source.sourceSilenceMs,
          sourceSilent: source.sourceSilent,
          provenance: { terminalId: source.feed.terminal, feedId: source.feed.feed, receivedAt: iso(source.provenance.receivedAt) },
        },
      };
    }
    const [last] = (await this.options.recorder?.samples(market, 0, MAX_MS, 1, true)) ?? [];
    if (!last) throw new ApiError(503, "quote-unavailable", "No quote of this market has arrived, and none is recorded. Check the EA, or switch on recording in the app.");
    return {
      data: {
        ...head,
        ...prices(last.bid, last.ask, digits),
        time: iso(last.utcMs),
        brokerTime: brokerIso(last.brokerSeconds),
        state: "recorded",
        stale: true,
        quoteAgeMs: Math.max(0, snapshot.time - last.utcMs),
        sourceSilenceMs: Math.max(0, snapshot.time - last.receivedMs),
        sourceSilent: true,
        provenance: { terminalId: null, feedId: null, receivedAt: iso(last.receivedMs) },
      },
    };
  }

  /**
   * GET /markets/{marketId}/candles: the chart's bars of `timeframe` (M3 chart history: saved history, HST, the EA's
   * bars, then the live candles), the newest `limit` (900; 5000 at most) whose start is from `from` to `to`, oldest
   * first. The newest live candle is the forming one, `complete: false`. `meta.next.to` reads the page before.
   */
  private async candles(c: Context): Promise<Answer> {
    only(c.query, ["timeframe", "from", "to", "limit"]);
    const market = await this.knownMarket(c.params[0]);
    const window = this.barWindow(c.query, market, PAGE_BARS);
    const { bars, digits, forming, source } = await this.bars(market, window);
    const bar = (b: Candle) => ({
      ...this.times(market.brokerServer, b.time),
      open: price(b.open, digits),
      high: price(b.high, digits),
      low: price(b.low, digits),
      close: price(b.close, digits),
      complete: b.time !== forming,
    });
    return { data: bars.map(bar), meta: { marketId: market.id, timeframe: window.period, digits, source, count: bars.length, limit: window.limit, next: this.next(market, bars, window) } };
  }

  /**
   * GET /markets/{marketId}/samples: recorded samples from `from` to `to` (UTC, inclusive), oldest first, in one stable
   * order even where they share a time; `limit` 1000 by default, 10,000 at most. The cursor resumes after the last
   * one: the time it reached and how many at that time were already given.
   */
  private async samples(c: Context): Promise<Answer> {
    only(c.query, ["from", "to", "limit", "cursor"]);
    const market = await this.knownMarket(c.params[0]);
    const from = time(c.query, "from") ?? 0, to = time(c.query, "to") ?? MAX_MS;
    if (from > to) throw new ApiError(400, "invalid-time", "from must not be after to.", { parameter: "from" });
    const limit = integer(c.query, "limit", 1, 10_000, 1000);
    // A cursor holds the market and bounds it pages through: with others, its position would skip samples silently.
    const cursor = cursorOf(c.query);
    const [cursorMarket, cursorFrom, cursorTo, at, skip] = (cursor ?? [market.id, from, to, from, 0]) as [string, number, number, number, number];
    if (cursor && (cursor.length !== 5 || cursorMarket !== market.id || cursorFrom !== from || cursorTo !== to || ![at, skip].every((n) => Number.isSafeInteger(n) && n >= 0) || at < from)) {
      throw new ApiError(400, "invalid-cursor", "cursor is not one this API gave out for this market, from and to.", { parameter: "cursor" });
    }
    const rows = (await this.options.recorder?.samples(market, at, to, limit + 1, false, skip)) ?? [];
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const sameTime = last ? page.filter((s) => s.utcMs === last.utcMs).length + (last.utcMs === at ? skip : 0) : 0;
    const digits = market.digits ?? 5;
    return {
      data: page.map((s) => ({ time: iso(s.utcMs), brokerTime: brokerIso(s.brokerSeconds), bid: price(s.bid, digits), ask: price(s.ask, digits), receivedAt: iso(s.receivedMs) })),
      meta: { marketId: market.id, digits, count: page.length, limit, nextCursor: rows.length > limit && last ? encodeCursor([market.id, from, to, last.utcMs, sameTime]) : null },
    };
  }

  /** GET /markets/{marketId}/history: each timeframe's closed bars, MetaTrader's HST file joined with saved history. */
  private async historyCoverage(c: Context): Promise<Answer> {
    only(c.query, []);
    const market = await this.knownMarket(c.params[0]);
    const listed = (await this.options.catalog.list()).find((m) => marketKey(m) === marketKey(market));
    const timeframes = [];
    let digits = market.digits;
    for (const { period } of listed?.periods ?? []) {
      const series = await this.options.catalog.series(market, period);
      if (!series) continue;
      digits ??= series.digits;
      const from = this.times(market.brokerServer, series.first), to = this.times(market.brokerServer, series.last);
      timeframes.push({ timeframe: period, bars: series.bars, from: from.time, fromBrokerTime: from.brokerTime, to: to.time, toBrokerTime: to.brokerTime });
    }
    return { data: { marketId: market.id, digits, timeframes } };
  }

  /**
   * GET /markets/{marketId}/export: a timeframe's closed bars as the History page downloads them (M3 pipeline: CSV
   * with broker and UTC time, or an HST v401 file in broker time), from `from` to `to` when given. No forming bar.
   */
  private async export(c: Context): Promise<Answer> {
    only(c.query, ["timeframe", "format", "from", "to"]);
    const market = await this.knownMarket(c.params[0]);
    const period = timeframe(c.query);
    const format = c.query.get("format");
    if (format !== "csv" && format !== "hst") throw new ApiError(400, "invalid-format", "format must be csv or hst.", { parameter: "format", allowed: ["csv", "hst"] });
    const window = this.barWindow(c.query, market, 1);
    const download = await this.options.catalog.download(market, period);
    if (!download) throw new ApiError(404, "no-history", `No ${period} history of this market is available. See GET /api/v1/markets/{marketId}/history.`);
    const minutes = PERIOD_MINUTES[period];
    const { digits, clockRule, pages } = download;
    const { res } = c;
    res.writeHead(200, {
      "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/octet-stream",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${market.symbol}${minutes}.${format}`)}`,
      "cache-control": "no-store",
    });
    // A page at a time: a long M1 file is never held whole. A client that goes away stops the loop (closing the file).
    await write(res, format === "csv" ? CSV_HEADER : hstHeaderBytes(market.symbol, minutes, digits));
    for await (const page of pages) {
      if (res.destroyed) return "sent";
      const bars = page.filter((b) => b.time >= window.from && (window.before === undefined || b.time < window.before));
      if (bars.length) await write(res, format === "csv" ? csvRows(bars, digits, clockRule) : hstRecordBytes(bars));
    }
    res.end();
    return "sent";
  }

  /** GET /accounts: trading accounts, one per broker server and login however many terminals share it. */
  private async accounts(c: Context): Promise<Answer> {
    only(c.query, ["limit", "cursor"]);
    return paginate(c.query, this.options.bridge.accounts.list().map((a) => this.accountView(a)), (a) => [a.brokerServer, a.login, a.id]);
  }

  /** GET /accounts/{accountId}. */
  private async account(c: Context): Promise<Answer> {
    only(c.query, []);
    return { data: this.accountView(this.knownAccount(c.params[0])) };
  }

  /** GET /accounts/{accountId}/funds: read fresh from a connected terminal; offline, the last snapshot or nulls. */
  private async funds(c: Context): Promise<Answer> {
    only(c.query, []);
    const a = await this.accountSnapshot(c.params[0]);
    const captured = a.source ? this.times(a.brokerServer, a.source.capturedBrokerTime) : null;
    const f = a.funds;
    return {
      data: {
        accountId: a.id,
        currency: f.currency,
        balance: canonical(f.balance),
        equity: canonical(f.equity),
        margin: canonical(f.margin),
        freeMargin: canonical(f.freeMargin),
        marginLevel: canonical(f.marginLevel),
        profit: canonical(f.profit),
        leverage: f.leverage,
        state: a.state,
        capturedAt: captured?.time ?? null,
        capturedBrokerTime: captured?.brokerTime ?? null,
        receivedAt: iso(a.source?.receivedAt ?? null),
        terminalId: a.source?.terminalId ?? null,
      },
    };
  }

  /**
   * GET /accounts/{accountId}/positions[/{ticket}] (open positions, market buys and sells only) and
   * /accounts/{accountId}/orders[/{ticket}] (pending limit and stop orders only), from one fresh snapshot.
   */
  private async trades(c: Context, kind: "positions" | "orders"): Promise<Answer> {
    const ticket = c.params[1];
    only(c.query, ticket === undefined ? ["limit", "cursor"] : []);
    if (ticket !== undefined && !isTicket(ticket)) throw new ApiError(400, "invalid-ticket", "A ticket is MetaTrader's order number, such as 12345678.");
    const a = await this.accountSnapshot(c.params[0]);
    const views = a[kind].map((o) => this.orderView(a, o));
    if (ticket === undefined) {
      const page = paginate(c.query, views, (o) => [Number(o.ticket)]) as Exclude<Answer, "sent">;
      return { ...page, meta: { accountId: a.id, currency: a.funds.currency, state: a.state, ...page.meta } };
    }
    const found = views.find((o) => o.ticket === ticket);
    if (!found) {
      throw kind === "positions"
        ? new ApiError(404, "unknown-position", "This account has no open position with this ticket.")
        : new ApiError(404, "unknown-order", "This account has no pending order with this ticket.");
    }
    return { data: found, meta: { currency: a.funds.currency, state: a.state } };
  }

  /** GET /accounts/{accountId}/markets/{marketId}/conditions: the market's contract data from the account's own terminal. */
  private async conditions(c: Context): Promise<Answer> {
    only(c.query, []);
    const account = this.knownAccount(c.params[0]);
    const market = await this.knownMarket(c.params[1]);
    if (market.brokerServer !== account.brokerServer) {
      throw new ApiError(409, "cross-broker-market", "This market is on another broker server than the account. Use the account's own broker server's market.", { accountBrokerServer: account.brokerServer, marketBrokerServer: market.brokerServer });
    }
    const snapshot = await accountRead(() => this.options.bridge.accounts.conditions(account.id, market), "this market's conditions");
    const k = snapshot.conditions;
    const quote = this.times(market.brokerServer, k.quoteTime);
    return {
      data: {
        accountId: account.id,
        marketId: market.id,
        symbol: market.symbol,
        bid: canonical(k.bid),
        ask: canonical(k.ask),
        digits: k.digits,
        point: canonical(k.point),
        tickSize: canonical(k.tickSize),
        minLots: canonical(k.minLots),
        maxLots: canonical(k.maxLots),
        lotStep: canonical(k.lotStep),
        stopLevel: k.stopLevel,
        freezeLevel: k.freezeLevel,
        tradeAllowed: k.tradeAllowed,
        quoteTime: quote.time,
        quoteBrokerTime: quote.brokerTime,
        tickValue: canonical(k.tickValue),
        contractSize: canonical(k.contractSize),
        marginRequired: canonical(k.marginRequired),
        swapLong: canonical(k.swapLong),
        swapShort: canonical(k.swapShort),
        swapType: k.swapType,
        profitCurrency: k.profitCurrency,
        terminalId: snapshot.source.terminalId,
        receivedAt: iso(snapshot.source.receivedAt),
      },
    };
  }

  /** An account by its exact ID; unknown answers 404. */
  private knownAccount(id: string): AccountSnapshot {
    const account = this.options.bridge.accounts.get(id);
    if (!account) throw new ApiError(404, "unknown-account", "No known trading account has this ID. List them with GET /api/v1/accounts.");
    return account;
  }

  /** A fresh complete snapshot when a terminal of the account is connected; else the last one (stale) or none (unavailable). */
  private async accountSnapshot(id: string): Promise<AccountSnapshot> {
    const known = this.knownAccount(id);
    if (!known.connected) return known;
    return accountRead(() => this.options.bridge.accounts.read(id));
  }

  /** An account as discovery describes it: identity, connection, executor and sources; no Funds. */
  private accountView(a: AccountSnapshot) {
    const executor = this.options.bridge.accounts.executor(a.id);
    return {
      id: a.id,
      brokerServer: a.brokerServer,
      login: a.login,
      label: a.label,
      demo: a.demo,
      connected: a.connected,
      state: a.state,
      currency: a.funds.currency,
      executor: { state: executor.state, terminalId: executor.source?.terminalId ?? null },
      sources: a.sources.map((s) => ({ terminalId: s.terminalId, connected: s.connected, executorEnabled: s.enabled, ready: s.ready, maxLots: canonical(s.maxLots) })),
    };
  }

  /** A position or pending order; MetaTrader's zero stop, take profit or expiry is none (null). */
  private orderView(a: AccountSnapshot, o: AccountOrder) {
    const opened = this.times(a.brokerServer, o.openTime);
    const head = { ticket: o.ticket, accountId: a.id, marketId: marketId(a.brokerServer, o.symbol), symbol: o.symbol, side: sideOf(o.kind) };
    const common = { lots: canonical(o.lots), stopLoss: unlessZero(o.stopLoss), takeProfit: unlessZero(o.takeProfit), magic: o.magic };
    if (o.kind < 2) {
      return { ...head, ...common, openPrice: canonical(o.openPrice), openTime: opened.time, openBrokerTime: opened.brokerTime, currentPrice: canonical(o.closePrice), profit: canonical(o.profit), swap: canonical(o.swap), commission: canonical(o.commission) };
    }
    const expiry = o.expiration ? this.times(a.brokerServer, o.expiration) : null;
    return {
      ...head,
      type: typeOf(o.kind),
      ...common,
      price: canonical(o.openPrice),
      placedAt: opened.time,
      placedBrokerTime: opened.brokerTime,
      expiry: expiry?.time ?? null,
      expiryBrokerTime: expiry?.brokerTime ?? null,
      currentPrice: canonical(o.closePrice),
    };
  }

  /**
   * POST /requests/preview: a single-use, 30-second preview of a place, modify, close or cancel for an explicit
   * account. A place names an exact `marketId` on the account's broker server; the others an account-qualified
   * `ticket`. Nothing is sent to MetaTrader.
   */
  private async preview(c: Context): Promise<Answer> {
    only(c.query, []);
    const body = await jsonBody(c.req);
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "invalid-input", "Expected a JSON object.");
    const input = { ...(body as Record<string, unknown>) };
    if (typeof input.accountId !== "string") throw new ApiError(400, "invalid-input", "accountId is required.", { property: "accountId" });
    const account = this.knownAccount(input.accountId);
    if (input.action === "place") {
      if (typeof input.marketId !== "string") throw new ApiError(400, "invalid-input", "A place request needs marketId.", { property: "marketId" });
      if ("symbol" in input) throw new ApiError(400, "unknown-property", "Name the market by marketId, not symbol.", { property: "symbol" });
      const market = await this.knownMarket(input.marketId);
      if (market.brokerServer !== account.brokerServer) {
        throw new ApiError(409, "cross-broker-market", "This market is on another broker server than the account.", { accountBrokerServer: account.brokerServer, marketBrokerServer: market.brokerServer });
      }
      delete input.marketId;
      Object.assign(input, { action: "new", symbol: market.symbol });
    } else if (input.action === "new") {
      throw new ApiError(400, "invalid-action", "action must be place, modify, close or cancel.", { property: "action" });
    }
    const preview = await this.engine((engine) => engine.preview(c.credential, input as TradeInput));
    return { status: 201, data: this.previewView(preview) };
  }

  /** POST /requests/{requestId}/execute `{ confirm: true }`: 202 once dispatch is accepted; a duplicate answers the existing record. */
  private async execute(c: Context): Promise<Answer> {
    only(c.query, []);
    const id = requestId(c.params[0]);
    const body = await jsonBody(c.req);
    const keys = body !== null && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [];
    if (keys.length !== 1 || (body as { confirm?: unknown }).confirm !== true) {
      throw new ApiError(400, "confirmation-required", "Confirm the previewed request explicitly with { \"confirm\": true }.");
    }
    // 202 only for the call that admitted the dispatch; one joining or repeating it answers the existing record.
    const { record, admitted } = await this.engine((engine) => engine.executeRequest(c.credential, id, true));
    return { status: admitted ? 202 : 200, data: this.recordView(record) };
  }

  /** POST /requests/{requestId}/review `{ note, acknowledged: true }`: acknowledges an unknown outcome after checking MetaTrader. */
  private async review(c: Context): Promise<Answer> {
    only(c.query, []);
    const id = requestId(c.params[0]);
    const body = (await jsonBody(c.req)) as { note?: unknown; acknowledged?: unknown } | null;
    if (body === null || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => k !== "note" && k !== "acknowledged")) {
      throw new ApiError(400, "invalid-input", "Expected { note, acknowledged }.");
    }
    const record = await this.engine((engine) => engine.review(c.credential, id, body.note as string, body.acknowledged as boolean));
    return { data: this.recordView(record) };
  }

  /** GET /requests: the common journal of dispatched requests, oldest first; `accountId` filters exactly. */
  private async requests(c: Context): Promise<Answer> {
    only(c.query, ["accountId", "limit", "cursor"]);
    const account = text(c.query, "accountId");
    const records = await this.engine((engine) => engine.list(c.credential));
    return paginate(c.query, records.filter((r) => account === undefined || r.accountId === account).map((r) => this.recordView(r)), (r) => [Date.parse(r.createdAt), r.requestId]);
  }

  /** GET /requests/{requestId}: its journal record, else the preview while it is still valid. */
  private async request(c: Context): Promise<Answer> {
    only(c.query, []);
    const id = requestId(c.params[0]);
    const record = await this.engine((engine) => engine.get(c.credential, id).catch((e: unknown) => (e instanceof TradingError && e.code === "request-not-found" ? undefined : Promise.reject(e))));
    if (record) return { data: this.recordView(record) };
    const preview = await this.engine((engine) => engine.previewOf(c.credential, id));
    if (!preview) throw new ApiError(404, "request-not-found", "No request or valid preview has this ID; previews expire after 30 seconds.");
    return { data: this.previewView(preview) };
  }

  /** Runs on the shared request engine; its refusals answer with their stable codes. */
  private async engine<T>(run: (engine: RequestEngine<RestCredential>) => Promise<T>): Promise<T> {
    const engine = this.options.trading?.();
    if (!engine) throw new ApiError(503, "trading-unavailable", "Trading needs the app's database, which this run of the app does not have.");
    try {
      return await run(engine);
    } catch (e) {
      if (e instanceof TradingError) throw new ApiError(e.status, e.code, tradingMessage(e.code));
      if (e instanceof AccountReadError) return accountRead(() => Promise.reject(e));
      throw e;
    }
  }

  /** A preview, as preview and GET /requests/{requestId} answer it while valid. */
  private previewView(p: TradingPreview) {
    return {
      requestId: p.id,
      status: "preview",
      createdAt: iso(p.createdAt),
      expiresAt: iso(p.expiresAt),
      ...this.approval(p),
    };
  }

  /** A journal record: the approved preview, outcome, result and evidence events. */
  private recordView(r: JournalRecord) {
    const result = (x: TradeResult) => ({ status: x.status, ticket: x.ticket === "0" ? null : x.ticket, code: x.code, message: x.message });
    return {
      requestId: r.id,
      status: r.outcome,
      reviewed: r.events.some((e) => e.type === "review"),
      origin: r.origin,
      createdAt: iso(r.createdAt),
      updatedAt: iso(r.updatedAt),
      ...this.approval(r.preview),
      result: r.result && result(r.result),
      events: r.events.map((e) =>
        e.type === "review" ? { type: e.type, at: iso(e.at), note: e.note } : e.type === "result" ? { type: e.type, at: iso(e.at), result: result(e.result) } : { type: e.type, at: iso(e.at), reason: e.reason },
      ),
    };
  }

  /** What a preview approved: the account, market and terminal, the normalized intent, its target, limits and estimates. */
  private approval(p: TradingPreview) {
    const i = p.intent;
    const target = p.target;
    const brokerServer = p.source.brokerServer;
    return {
      accountId: i.accountId,
      marketId: p.marketId,
      terminalId: p.source.terminalId,
      normalizedIntent: {
        action: i.action === "new" ? "place" : i.action,
        ticket: i.action === "new" ? null : i.ticket,
        symbol: i.symbol,
        side: sideOf(i.kind),
        type: typeOf(i.kind),
        lots: i.lots,
        price: unlessZero(i.price),
        stopLoss: unlessZero(i.stopLoss),
        takeProfit: unlessZero(i.takeProfit),
        expiry: i.expiry,
        slippage: i.slippage,
      },
      target: target && {
        ticket: target.ticket,
        symbol: target.symbol,
        side: sideOf(target.kind),
        type: typeOf(target.kind),
        lots: canonical(target.lots),
        openPrice: canonical(target.openPrice),
        openTime: this.times(brokerServer, target.openTime).time,
        stopLoss: unlessZero(target.stopLoss),
        takeProfit: unlessZero(target.takeProfit),
        expiry: target.expiration ? this.times(brokerServer, target.expiration).time : null,
      },
      limits: p.limits,
      estimates: p.estimates,
      warnings: p.warnings,
    };
  }

  /** GET /terminals: read-only diagnostics of each terminal heard from, by ID. Not execution routing. */
  private async terminals(c: Context): Promise<Answer> {
    only(c.query, ["limit", "cursor"]);
    const snapshot = this.options.bridge.snapshot();
    return paginate(c.query, snapshot.terminals.map((t) => this.terminalView(t, snapshot)), (t) => [t.id]);
  }

  /** GET /terminals/{terminalId}. */
  private async terminal(c: Context): Promise<Answer> {
    only(c.query, []);
    const snapshot = this.options.bridge.snapshot();
    return { data: this.terminalView(this.knownTerminal(c.params[0], snapshot), snapshot) };
  }

  /** GET /terminals/{terminalId}/feeds: that terminal's own feeds, their health and its own quotes. */
  private async terminalFeeds(c: Context): Promise<Answer> {
    only(c.query, ["limit", "cursor"]);
    const snapshot = this.options.bridge.snapshot();
    const terminal = this.knownTerminal(c.params[0], snapshot);
    return paginate(c.query, snapshot.feeds.filter((f) => f.terminal === terminal.terminalId).map((f) => this.feedView(f)), (f) => [f.symbol, f.id]);
  }

  /** GET /terminals/{terminalId}/feeds/{feedId}. */
  private async terminalFeed(c: Context): Promise<Answer> {
    only(c.query, []);
    const snapshot = this.options.bridge.snapshot();
    const terminal = this.knownTerminal(c.params[0], snapshot);
    const feed = snapshot.feeds.find((f) => f.terminal === terminal.terminalId && f.feed === c.params[1]);
    if (!feed) throw new ApiError(404, "unknown-feed", "This terminal has no feed with this ID. List them with GET /api/v1/terminals/{terminalId}/feeds.");
    return { data: this.feedView(feed) };
  }

  /** A terminal heard from since the app started, by its exact ID; unknown answers 404. */
  private knownTerminal(id: string, snapshot: BridgeSnapshot): TerminalPresence {
    const terminal = snapshot.terminals.find((t) => t.terminalId === id);
    if (!terminal) throw new ApiError(404, "unknown-terminal", "No terminal with this ID has connected since the app started. List them with GET /api/v1/terminals.");
    return terminal;
  }

  /** A terminal's diagnostics. */
  private terminalView(t: TerminalPresence, snapshot: BridgeSnapshot) {
    return {
      id: t.terminalId,
      name: this.options.terminalName(t.terminalId) ?? t.terminalId,
      brokerServer: t.brokerServer,
      eaVersion: t.eaVersion,
      connected: snapshot.time - t.lastHello < ONLINE_WINDOW_MS,
      lastHelloAt: iso(t.lastHello),
      feeds: snapshot.feeds.filter((f) => f.terminal === t.terminalId).length,
    };
  }

  /** A feed's health and its own terminal's quote. */
  private feedView(f: FeedSnapshot) {
    const quote = f.latest;
    return {
      id: f.feed,
      terminalId: f.terminal,
      marketId: marketId(f.market.brokerServer, f.market.symbol),
      brokerServer: f.market.brokerServer,
      symbol: f.market.symbol,
      digits: f.digits,
      timeframe: f.timeframe === null ? null : (PERIOD_OF.get(f.timeframe) ?? null),
      online: f.online,
      stale: f.stale,
      instances: f.instances,
      quoteStatus: f.quoteStatus,
      recording: f.recording,
      bid: quote ? price(quote.bid, f.digits) : null,
      ask: quote ? price(quote.ask, f.digits) : null,
      time: iso(f.quoteTimeUtc),
      brokerTime: quote ? brokerIso(quote.quoteTime) : null,
      receivedAt: iso(f.quoteReceivedAt),
    };
  }

  /** GET /indicators: the enabled packages, by ID. */
  private async indicatorList(c: Context): Promise<Answer> {
    only(c.query, ["limit", "cursor"]);
    return paginate(c.query, this.enabledPackages().map(packageView), (p) => [p.id]);
  }

  /** GET /indicators/{packageId}. */
  private async indicator(c: Context): Promise<Answer> {
    only(c.query, []);
    return { data: packageView(this.indicatorPackage(c.params[0])) };
  }

  /** The installed packages switched on in the Indicators page. */
  private enabledPackages(): IndicatorPackage[] {
    const packages = this.options.indicators?.packages;
    return (packages?.list() ?? []).filter((p) => packages!.enabled(p.manifest.id));
  }

  /** An enabled package by its exact ID; unknown or disabled answers 404. */
  private indicatorPackage(id: string): IndicatorPackage {
    const pkg = this.enabledPackages().find((p) => p.manifest.id === id);
    if (!pkg) throw new ApiError(404, "unknown-indicator", "No enabled indicator package has this ID. List them with GET /api/v1/indicators.");
    return pkg;
  }

  /**
   * GET /markets/{marketId}/indicators/{packageId}: the package's values (parameters `p.<id>`, their defaults when left
   * out) over the bars GET …/candles answers for the same window, read from the cache the charts use and warmed up on
   * the bars before them. A closed-bars-only package has no row for the forming bar. A failed calculation answers 422.
   */
  private async indicatorValues(c: Context): Promise<Answer> {
    only(c.query, ["timeframe", "from", "to", "limit"], true);
    const market = await this.knownMarket(c.params[0]);
    const pkg = this.indicatorPackage(c.params[1]);
    const { manifest } = pkg;
    const window = this.barWindow(c.query, market, PAGE_BARS);
    let parameters;
    try {
      parameters = parametersFromQuery(manifest, c.query);
    } catch (e) {
      if (!(e instanceof ManifestError)) throw e;
      throw new ApiError(400, "invalid-indicator-parameter", e.message);
    }
    const feed = selectMarketSource(this.options.bridge.snapshot(), market)?.feed;
    if (!feed) throw new ApiError(503, "feed-required", "Indicators are calculated over a terminal's chart of this market; none has connected since the app started.");
    // The values' cache and the bars come from this one feed.
    const { bars, forming, page, source } = await this.bars(market, window, feed);
    // The cache works over the page in UTC seconds, and times its values so.
    const utc = (b: Candle) => this.utcMs(market.brokerServer, b.time) / 1000;
    const answer = await this.options.indicators!.values.valuesOver(feed, window.period, pkg, parameters, { ...page!, candles: bars.map((b) => ({ ...b, time: utc(b) })) });
    if (answer.failed !== null) throw new ApiError(422, "indicator-failed", `${manifest.name} failed: ${answer.failed}`, { reason: answer.failed });
    const byTime = manifest.outputs.map((o) => ({ o, points: new Map(answer.outputs[o.id].map((p) => [p.time, p])) }));
    const rows = manifest.closedBarsOnly ? bars.filter((b) => b.time !== forming) : bars;
    const styled = manifest.outputs.filter((o) => o.palette);
    return {
      data: rows.map((b) => ({
        ...this.times(market.brokerServer, b.time),
        complete: b.time !== forming,
        values: Object.fromEntries(byTime.map(({ o, points }) => [o.id, decimal(points.get(utc(b))?.value)])),
        ...(styled.length ? { styles: Object.fromEntries(byTime.filter(({ o }) => o.palette).map(({ o, points }) => [o.id, points.get(utc(b))?.styleKey ?? null])) } : {}),
      })),
      meta: {
        marketId: market.id,
        indicatorId: manifest.id,
        version: manifest.version,
        parameters,
        outputs: manifest.outputs.map((o) => ({ id: o.id, label: o.label })),
        timeframe: window.period,
        source,
        count: rows.length,
        limit: window.limit,
        barsUsed: answer.barsUsed,
        next: this.next(market, bars, window),
      },
    };
  }

  /** A bar read's timeframe, limit and bounds (broker seconds: `before` exclusive, `from` inclusive). */
  private barWindow(q: URLSearchParams, market: Market, fallback: number): BarWindow {
    const period = timeframe(q);
    const limit = integer(q, "limit", 1, 5000, fallback);
    const rule = this.options.clockRule(market.brokerServer) ?? UNKNOWN_RULE;
    const fromMs = time(q, "from"), toMs = time(q, "to");
    if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) throw new ApiError(400, "invalid-time", "from must not be after to.", { parameter: "from" });
    const from = fromMs === undefined ? -Infinity : Math.ceil(utcToBroker(rule, fromMs) / 1000);
    const before = toMs === undefined ? undefined : Math.floor(utcToBroker(rule, toMs) / 1000) + 1;
    return { period, limit, from, before };
  }

  /**
   * A market's newest bars in a window, oldest first: its best feed's chart history (live candles included), else the
   * HST files and saved history of a market without a feed. `forming` is the forming live candle's start, if any.
   */
  private async bars(market: KnownMarket, window: BarWindow, feed = selectMarketSource(this.options.bridge.snapshot(), market)?.feed) {
    let bars: Candle[];
    let digits = market.digits ?? feed?.digits;
    let forming: number | undefined;
    let page: HistoryPage | undefined;
    if (feed) {
      const broker = await this.options.history.brokerPage(feed, window.period, window.limit, window.before);
      bars = broker.candles;
      page = broker;
      forming = broker.forming;
    } else {
      const series = await this.options.catalog.series(market, window.period);
      bars = series ? await series.latest(window.limit, window.before) : [];
      digits ??= series?.digits;
    }
    bars = bars.filter((b) => b.time >= window.from);
    if (!bars.length && window.before === undefined && window.from === -Infinity) {
      throw new ApiError(404, "no-candles", `No ${window.period} candles of this market: no quote has arrived, and MetaTrader keeps no history of it. See GET /api/v1/markets/{marketId}/history.`);
    }
    // Provenance: the feed whose chart history answered, or none for HST files and saved history alone.
    const source = feed ? { terminalId: feed.terminal, feedId: feed.feed } : null;
    return { bars, digits: digits ?? 5, forming, page, source };
  }

  /** The window of the page before a full one, or null when this one reached `from` or the oldest bar. */
  private next(market: Market, bars: Candle[], window: BarWindow) {
    if (bars.length < window.limit || bars[0].time <= window.from) return null;
    // The broker second before the oldest bar, written in UTC: read back, it is that same broker second. In a gap the
    // broker clock skips at a clock change it does not exist; the UTC second before the bar's start reads back earlier.
    const rule = this.options.clockRule(market.brokerServer) ?? UNKNOWN_RULE;
    const oldest = bars[0].time;
    const to = this.utcMs(market.brokerServer, oldest - 1);
    return { to: iso(Math.floor(utcToBroker(rule, to) / 1000) < oldest ? to : this.utcMs(market.brokerServer, oldest) - 1000) };
  }

  /** A broker time in seconds as `time` (UTC ISO, by the broker server's clock rule) and `brokerTime`. */
  private times(brokerServer: string, brokerSeconds: number) {
    return { time: iso(this.utcMs(brokerServer, brokerSeconds)), brokerTime: brokerIso(brokerSeconds) };
  }

  /** The exact market's feeds, by terminal. */
  private feedsOf(m: Market): FeedSnapshot[] {
    return this.options.bridge
      .snapshot()
      .feeds.filter((f) => marketKey(f.market) === marketKey(m))
      .sort((a, b) => lexical(a.terminal, b.terminal) || lexical(a.feed, b.feed));
  }

  /** A broker time in seconds as UTC milliseconds, by the broker server's clock rule (as it is while unknown). */
  private utcMs(brokerServer: string, brokerSeconds: number): number {
    return brokerToUtc(this.options.clockRule(brokerServer) ?? UNKNOWN_RULE, brokerSeconds * 1000);
  }
}

/** Public: the CLI checks the service and API version before signing in. */
export function info() {
  return { data: { service: "mt4-quote-bridge", apiVersion: API_VERSION }, meta: {} };
}

/** UTC milliseconds as ISO-8601, null as null. */
const iso = <T extends number | null>(ms: T): T extends number ? string : string | null => (ms === null ? null : new Date(ms).toISOString()) as never;

/** Broker seconds as ISO-8601 without an offset: the broker server's wall clock. */
const brokerIso = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 19);

/** A price at the market's precision. */
const price = (value: number, digits: number) => value.toFixed(digits);

/** Bid, ask and the spread in points (one decimal). */
const prices = (bid: number, ask: number, digits: number) => ({ bid: price(bid, digits), ask: price(ask, digits), spread: ((ask - bid) * 10 ** digits).toFixed(1) });

const MAX_BODY_BYTES = 16 * 1024;

/** A request's JSON body, at most 16 KiB. */
async function jsonBody(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) throw new ApiError(415, "unsupported-media-type", "Send the body as application/json.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    // Read on to the end: the answer reaches a client still sending.
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  }
  if (size > MAX_BODY_BYTES) throw new ApiError(413, "body-too-large", "The body is larger than 16 KiB.");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "invalid-json", "The body is not valid JSON.");
  }
}

/** A request ID: 32 lowercase hexadecimal characters. */
function requestId(text: string): string {
  if (!/^[0-9a-f]{32}$/.test(text)) throw new ApiError(400, "invalid-request-id", "A request ID is 32 lowercase hexadecimal characters, as a preview answers it.");
  return text;
}

/** What a request engine refusal means, for its message; the code is the stable part. */
function tradingMessage(code: string): string {
  const messages: Record<string, string> = {
    "not-authorized": "This credential may not trade.",
    "trading-disabled": "Demo trading is off in the app window's Settings.",
    "demo-only": "QuoteBridge trades on demo accounts only.",
    "preview-unavailable": "No valid preview has this ID: it expired, was invalidated or already ran. Preview again.",
    "preview-expired": "The preview has expired. Preview again.",
    "preview-invalidated": "Settings or the account's source changed since the preview. Preview again.",
    "account-unresolved": "This account has a request without a definitive result. Check it, and review it if its outcome is unknown.",
    "request-not-found": "No request has this ID.",
    "request-not-unknown": "Only a request whose outcome is unknown can be reviewed.",
    "invalid-review": "A review needs a note of 8–500 characters and acknowledged: true, after checking MetaTrader's open orders and account history.",
    "read-timeout": "The account's terminal did not answer within five seconds.",
    "journal-unavailable": "The trading journal could not be written; nothing was sent.",
    "trading-stopped": "The app is stopping; no request is accepted.",
    "terminal-updating": "The account's terminal is being updated.",
  };
  if (messages[code]) return messages[code];
  if (code.startsWith("executor-")) return `The account's trading chart is not ready (${code.slice("executor-".length)}). Exactly one chart per account must have demo trading enabled.`;
  return `The request was refused: ${code}. See the REST API manual's error codes.`;
}

/** Whether text is MetaTrader's ticket: a positive 32-bit integer, in decimal, as the request engine takes it. */
const isTicket = (text: string) => /^[1-9]\d{0,9}$/.test(text) && Number(text) <= 2147483647;

/** MetaTrader's order kinds: 0 buy, 1 sell, 2 buy limit, 3 sell limit, 4 buy stop, 5 sell stop. */
const sideOf = (kind: number) => (kind % 2 === 0 ? "buy" : "sell");
const typeOf = (kind: number) => (kind < 2 ? "market" : kind < 4 ? "limit" : "stop");

/** MetaTrader's zero price, stop loss or take profit is none: null; any other, canonical. */
const unlessZero = (value: string) => (/^0(\.0*)?$/.test(value) ? null : canonical(value));

/** An EA decimal string (ten fraction digits on the wire) without trailing zeros: `1000.0000000000` is `1000`. */
function canonical<T extends string | null>(value: T): T {
  if (value === null || !value.includes(".")) return value;
  const trimmed = value.replace(/0+$/, "").replace(/\.$/, "");
  return (trimmed === "-0" ? "0" : trimmed) as T;
}

/**
 * An account or conditions read (`what` it reads, for a refusal); its failures (no source, timeout, a changed account,
 * the EA's refusal with its reason) answer with their code.
 */
async function accountRead<T>(read: () => Promise<T>, what = "its account"): Promise<T> {
  try {
    return await read();
  } catch (e) {
    if (!(e instanceof AccountReadError)) throw e;
    const messages: Record<AccountReadError["code"], string> = {
      "unavailable-source": "No terminal of this account is connected to answer.",
      "read-timeout": "The account's terminal did not answer within five seconds.",
      "account-changed": "The terminal's account changed while it was answering. Ask again.",
      "invalid-response": "The terminal's answer was not valid.",
      "read-failed": `The terminal could not read ${what}.`,
      "executor-unavailable": "The account's trading chart is not available.",
      "cross-broker-market": "This market is on another broker server than the account.",
    };
    // One stable status per code: the request engine answers executor-unavailable with 409 too.
    throw new ApiError(e.code === "executor-unavailable" ? 409 : e.status, e.code, messages[e.code], e.reason === undefined ? undefined : { reason: e.reason });
  }
}

/**
 * A calculated number as a plain decimal string (never exponent notation), the shortest that reads back as the same
 * double; null for none or a non-finite value.
 */
export function decimal(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const text = String(value);
  const exponent = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (!exponent) return text;
  const [, sign, lead, rest = "", power] = exponent;
  const digits = lead + rest, point = 1 + Number(power);
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  return `${sign}${digits.padEnd(point, "0")}${digits.length > point ? `.${digits.slice(point)}` : ""}`;
}

/** A package as discovery describes it. */
function packageView(p: IndicatorPackage) {
  const { manifest } = p;
  return {
    id: manifest.id,
    version: manifest.version,
    name: manifest.name,
    description: manifest.description,
    placement: manifest.outputs[0].placement,
    closedBarsOnly: manifest.closedBarsOnly ?? false,
    parameters: manifest.parameters.map((x) =>
      x.type === "choice"
        ? { id: x.id, label: x.label, type: x.type, default: x.default, choices: x.choices }
        : { id: x.id, label: x.label, type: x.type, default: x.default, min: x.min, max: x.max, ...(x.lessThan ? { lessThan: x.lessThan } : {}) },
    ),
    outputs: manifest.outputs.map((o) => ({ id: o.id, label: o.label, render: o.render, styles: o.palette ? Object.keys(o.palette) : null })),
    hash: p.hash,
  };
}

/** A path segment, decoded. */
function segment(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    throw new ApiError(400, "invalid-path", "The path is not valid percent-encoding.");
  }
}

/** An optional text query parameter, matched exactly; at most 1,000 characters. */
function text(q: URLSearchParams, name: string): string | undefined {
  const value = q.get(name);
  if (value === null) return undefined;
  if (!value.length || value.length > 1000) throw new ApiError(400, "invalid-parameter", `${name} must be 1–1000 characters.`, { parameter: name });
  return value;
}

/** Refuses query parameters a route does not take (`p.<id>` indicator parameters when `parameters`). */
function only(q: URLSearchParams, names: string[], parameters = false) {
  for (const name of new Set(q.keys())) {
    if (q.getAll(name).length > 1) throw new ApiError(400, "invalid-parameter", `${name} is given more than once.`, { parameter: name });
    if (!names.includes(name) && !(parameters && name.startsWith("p."))) throw new ApiError(400, "unknown-parameter", `This resource takes no ${name} parameter.`, { parameter: name, allowed: names });
  }
}

/** `timeframe`, required: one of MetaTrader's periods, exactly. */
function timeframe(q: URLSearchParams): Period {
  const value = q.get("timeframe");
  if (!PERIODS.includes(value as Period)) throw new ApiError(400, "invalid-timeframe", `timeframe must be one of ${PERIODS.join(", ")}.`, { parameter: "timeframe", allowed: PERIODS });
  return value as Period;
}

/** An optional UTC time parameter as `YYYY-MM-DDTHH:MM:SS[.sss]Z`, in UTC milliseconds. */
function time(q: URLSearchParams, name: string): number | undefined {
  const value = q.get(name);
  if (value === null) return undefined;
  const ms = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value) ? Date.parse(value) : NaN;
  // Round-trips only when every field was in range (no 30 February).
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19) || ms < 0 || ms > MAX_MS) {
    throw new ApiError(400, "invalid-time", `${name} must be a UTC time such as 2027-01-15T08:00:00Z.`, { parameter: name });
  }
  return ms;
}

/** An integer query parameter from `min` to `max`, `fallback` when not given. */
function integer(q: URLSearchParams, name: string, min: number, max: number, fallback: number): number {
  const value = q.get(name);
  if (value === null) return fallback;
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new ApiError(400, "invalid-parameter", `${name} must be an integer from ${min} to ${max}.`, { parameter: name });
  }
  return n;
}

type SortKey = (string | number)[];

/**
 * A page of `items` after `cursor`, in the order of their keys (unique per item): `limit` 100 by default, 500 at most.
 * `nextCursor` (opaque) continues after the last item, null at the end; nothing is skipped or repeated while items
 * are added.
 */
function paginate<T>(q: URLSearchParams, items: T[], key: (item: T) => SortKey): Answer {
  const limit = integer(q, "limit", 1, PAGE.max, PAGE.default);
  const after = cursorOf(q);
  const sorted = items.map((item) => ({ item, key: key(item) })).sort((a, b) => compareKeys(a.key, b.key));
  const rest = after ? sorted.filter((s) => compareKeys(s.key, after) > 0) : sorted;
  const shown = rest.slice(0, limit);
  const nextCursor = rest.length > limit ? encodeCursor(shown.at(-1)!.key) : null;
  return { data: shown.map((s) => s.item), meta: { count: shown.length, limit, nextCursor } };
}

/** A cursor: the last item's sort key, opaque to clients. */
const encodeCursor = (key: SortKey) => Buffer.from(JSON.stringify(key)).toString("base64url");

/** The `cursor` parameter's sort key, null when not given; one this API did not give out answers 400. */
function cursorOf(q: URLSearchParams): SortKey | null {
  const cursor = q.get("cursor");
  if (cursor === null) return null;
  try {
    const key: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(key) && key.length && key.every((k) => typeof k === "string" || typeof k === "number")) return key;
  } catch {}
  throw new ApiError(400, "invalid-cursor", "cursor is not one this API gave out.", { parameter: "cursor" });
}

/** Orders sort keys element by element: numbers numerically, strings by code unit. */
function compareKeys(a: SortKey, b: SortKey): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return lexical(String(x), String(y));
  }
  return 0;
}

const lexical = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
