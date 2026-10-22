// REST API v1 reads, for the CLI and scripts: the legacy contract (mt4-server-zeromq docs/rest-api.md) field by field.
// Every time field keeps its legacy meaning (broker seconds) and gains a sibling with a `Utc` suffix in UTC
// milliseconds (ADR 11). A symbol resolves to one feed, or to one market (broker server and symbol) for recorded and
// saved data, which answers with no terminal running. What later milestones bring answers 501 naming the milestone.
import type { IncomingMessage, ServerResponse } from "node:http";
import { brokerToUtc, UNKNOWN_RULE, type ClockRule } from "../../shared/clock.js";
import { PERIODS, type Period } from "../../shared/periods.js";
import { marketKey, type BridgeServer, type FeedSnapshot, type Market } from "../bridge/index.js";
import type { Candle, CandleBuilder } from "../candles/index.js";
import { CSV_HEADER, csvRows, PERIOD_MINUTES, type ChartHistory, type HistoryCatalog, type HstBar } from "../history/index.js";
import type { Recorder } from "../recording/index.js";
import { json, write } from "./respond.js";

/** The REST API version; the CLI checks it at /api/v1/info. */
export const API_VERSION = 1;

/** The latest time a query takes, in broker seconds (as the legacy API) and in UTC milliseconds. */
const MAX_SECONDS = 9_999_999_999;
const MAX_MS = MAX_SECONDS * 1000 + 999;

/** Bars read at a time while streaming a file's CSV. */
const CSV_PAGE = 4096;

const NOT_LIVE = "MetaTrader's history (HST) and the app's saved history; not live.";

export type RestV1Options = {
  bridge: BridgeServer;
  candles: CandleBuilder;
  catalog: HistoryCatalog;
  history: ChartHistory;
  clockRule: (brokerServer: string) => ClockRule | null;
  /** Recording, when the server has a database. */
  recorder?: Recorder;
  /** A terminal's name as the Terminals view shows it; undefined when unknown. */
  terminalName: (terminalId: string) => string | undefined;
};

/** A symbol resolved to its market and, when one is known, the feed answering for it. */
type MarketAndFeed = { market: Market; feed: FeedSnapshot | null; digits: number | null };

/** A request the client can fix; `status` is the HTTP status to answer with, `details` e.g. an ambiguous symbol's candidates. */
class RestRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Paths later milestones answer, and which milestone brings them. */
const LATER: [RegExp, number, string][] = [
  [/^\/symbols\/[^/]+\/info$/, 5, "Symbol info (contract details from the account EA)"],
  [/^\/indicators(\/.*)?$/, 4, "Indicators"],
  [/^\/(accounts|positions)(\/.*)?$/, 5, "Accounts and positions"],
  [/^\/budget$/, 5, "The budget"],
  [/^\/orders(\/.*)?$/, 5, "Trading"],
];

export class RestV1 {
  constructor(private readonly options: RestV1Options) {}

  /** Answers a request under /api/v1 (but /api/v1/info, which is public), past the key or window session check. */
  async handle(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = url.pathname.slice("/api/v1".length);
    for (const [pattern, milestone, what] of LATER) {
      if (pattern.test(path)) return json(res, 501, { error: `${what} comes with milestone ${milestone}.` });
    }
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "Method not allowed" });
    const q = url.searchParams;
    try {
      if (path === "/symbols") return json(res, 200, await this.symbols());
      if (path === "/history") return json(res, 200, await this.historyList());
      if (path === "/history/files") return json(res, 200, await this.historyFiles(q));
      if (path === "/history/files/csv") return await this.historyFileCsv(q, res);
      const history = /^\/history\/([^/]+)$/.exec(path);
      if (history) return json(res, 200, await this.historyBars(symbolOf(history[1]), q));
      const symbol = /^\/symbols\/([^/]+)\/(quote|candles|samples)$/.exec(path);
      if (symbol?.[2] === "quote") return json(res, 200, await this.quote(symbolOf(symbol[1]), q));
      if (symbol?.[2] === "candles") return json(res, 200, await this.candles(symbolOf(symbol[1]), q));
      if (symbol?.[2] === "samples") return json(res, 200, await this.samples(symbolOf(symbol[1]), q));
      json(res, 404, { error: "Unknown API v1 endpoint" });
    } catch (e) {
      if (!(e instanceof RestRequestError)) throw e;
      json(res, e.status, { error: e.message, ...(e.details === undefined ? {} : { details: e.details }) });
    }
  }

  /** One row per feed. */
  private async symbols() {
    const history = new Map((await this.options.catalog.list()).map((m) => [m.market, m.periods.map((p) => p.period)]));
    return {
      symbols: this.options.bridge.snapshot().feeds.map((f) => ({
        ...feedInfo(f),
        online: f.online,
        recording: f.recording,
        digits: f.digits,
        bid: f.latest?.bid ?? null,
        ask: f.latest?.ask ?? null,
        quoteTime: f.latest?.quoteTime ?? null,
        quoteTimeUtc: f.quoteTimeUtc,
        // Live candles are built for every period from the feed's quotes.
        livePeriods: this.options.candles.candles(f.feed, "M1").length ? [...PERIODS] : [],
        historyPeriods: history.get(marketKey(f.market)) ?? [],
      })),
    };
  }

  /** An online feed's latest sample (`source: "live"`), else the market's last recorded one (`source: "recorded"`). */
  private async quote(symbol: string, q: URLSearchParams) {
    const { market, feed, digits } = await this.feedElseMarket(symbol, q, async () => this.options.recorder?.storedMarkets() ?? []);
    const where = { symbol: market.symbol, broker: market.brokerServer, terminal: feed?.terminal ?? null, feed: feed?.feed ?? null };
    const shown = digits ?? 5;
    if (feed?.online && feed.latest) {
      const { bid, ask, quoteTime } = feed.latest;
      return { ...where, source: "live", online: true, bid, ask, spread: spread(bid, ask, shown), digits: shown, time: quoteTime, timeUtc: this.utcMs(market.brokerServer, quoteTime) };
    }
    const [last] = (await this.options.recorder?.samples(market, 0, MAX_MS, 1, true)) ?? [];
    if (!last) throw new RestRequestError(409, `No current quote for ${market.symbol}. Switch on recording for it in the app, or check the EA.`);
    return {
      ...where,
      source: "recorded",
      online: feed?.online ?? false,
      bid: last.bid,
      ask: last.ask,
      spread: spread(last.bid, last.ask, shown),
      digits: shown,
      time: last.brokerSeconds,
      timeUtc: last.utcMs,
      received: last.receivedMs,
    };
  }

  /**
   * The last `count` candles: `auto` is the chart's join (HST, then saved history, with the live candles after it),
   * `live` the live candles only, `history` HST and saved bars. Without a feed, `auto` reads history. Live bars say
   * whether they are complete; the last one is still forming.
   */
  private async candles(symbol: string, q: URLSearchParams) {
    const period = parsePeriod(q.get("period"));
    const count = integer(q.get("count"), "count", 1, 2000, 30);
    const mode = q.get("source") || "auto";
    if (mode !== "auto" && mode !== "live" && mode !== "history") throw new RestRequestError(400, "source must be auto, live or history");
    const resolved =
      mode === "live"
        ? withFeed(this.resolveFeed(symbol, q))
        : mode === "auto"
          ? await this.feedElseMarket(symbol, q, () => this.knownMarkets())
          : this.resolveMarket(symbol, q, await this.knownMarkets());
    const { market, feed } = resolved;
    const head = {
      period,
      timeframe: PERIOD_MINUTES[period],
      symbol: market.symbol,
      broker: market.brokerServer,
      terminal: feed?.terminal ?? null,
      feed: feed?.feed ?? null,
      digits: resolved.digits,
    };
    if (feed && mode !== "history") {
      const page =
        mode === "live"
          ? { candles: this.options.candles.candles(feed.feed, period).slice(-count), live: Infinity }
          : await this.options.history.brokerPage(feed, period, count);
      const live = Math.min(page.live, page.candles.length);
      if (!page.candles.length) {
        throw mode === "live"
          ? new RestRequestError(503, `No live candles of ${feed.symbol} yet: none of its quotes has arrived since the app started.`)
          : new RestRequestError(404, `No ${period} candles of ${feed.symbol}: no quote has arrived, and MetaTrader keeps no history of it. See "hist list".`);
      }
      const firstLive = page.candles.length - live;
      return {
        ...head,
        source: live ? "live" : "history",
        status: live ? "live" : "history",
        message: !live ? NOT_LIVE : firstLive === 0 ? "Live candles from the feed's quotes." : "MetaTrader's history with the live candles after it.",
        bars: page.candles.map((c, i) => ({ ...this.bar(market.brokerServer, c), ...(i >= firstLive ? { complete: i < page.candles.length - 1 } : {}) })),
      };
    }
    const series = await this.options.catalog.series(market, period);
    if (!series) throw noHistory(period, market);
    return {
      ...head,
      digits: resolved.digits ?? series.digits,
      source: "history",
      status: "history",
      message: NOT_LIVE,
      bars: (await series.latest(count)).map((b) => this.historyBar(market.brokerServer, b)),
    };
  }

  /**
   * A market's recorded samples from `from` to `to` (UTC ms), oldest first. `truncated` when more follow: a page ends
   * at a whole second (samples are timed to the second) unless one second holds more than `limit`, so the next page
   * starts from the last `timeUtc` + 1.
   */
  private async samples(symbol: string, q: URLSearchParams) {
    const from = integer(q.get("from"), "from", 0, MAX_MS, 0);
    const to = integer(q.get("to"), "to", from, MAX_MS, MAX_MS);
    const limit = integer(q.get("limit"), "limit", 1, 100_000, 10_000);
    const { market } = this.resolveMarket(symbol, q, this.options.recorder?.storedMarkets() ?? []);
    const rows = (await this.options.recorder?.samples(market, from, to, limit + 1)) ?? [];
    const truncated = rows.length > limit;
    let page = rows.slice(0, limit);
    if (truncated) {
      const split = rows[limit].utcMs;
      const whole = page.filter((s) => s.utcMs !== split);
      if (whole.length) page = whole;
    }
    return {
      symbol: market.symbol,
      broker: market.brokerServer,
      from,
      to,
      truncated,
      samples: page.map((s) => ({ time: s.brokerSeconds, timeUtc: s.utcMs, bid: s.bid, ask: s.ask, received: s.receivedMs })),
    };
  }

  /** Each market's periods with bars: HST joined with saved history. `source` is the broker server (?source= picks it). */
  private async historyList() {
    const series = [];
    for (const m of await this.options.catalog.list()) {
      for (const { period } of m.periods) {
        const s = await this.options.catalog.series(m, period);
        if (!s) continue;
        series.push({
          source: m.brokerServer,
          symbol: m.symbol,
          broker: m.brokerServer,
          period,
          timeframe: PERIOD_MINUTES[period],
          bars: s.bars,
          from: s.first,
          to: s.last,
          fromUtc: this.utcMs(m.brokerServer, s.first),
          toUtc: this.utcMs(m.brokerServer, s.last),
        });
      }
    }
    return { series };
  }

  /** A market's bars from `from` to `to` (broker seconds), oldest first; `truncated` when more follow (continue from the last time + 1). */
  private async historyBars(symbol: string, q: URLSearchParams) {
    const period = parsePeriod(q.get("period"));
    const from = integer(q.get("from"), "from", 0, MAX_SECONDS, 0);
    const to = integer(q.get("to"), "to", from, MAX_SECONDS, MAX_SECONDS);
    const limit = integer(q.get("limit"), "limit", 1, 100_000, 10_000);
    const { market } = this.resolveMarket(symbol, q, await this.knownMarkets(), q.get("source") || undefined);
    const series = await this.options.catalog.series(market, period);
    if (!series) throw noHistory(period, market);
    const bars = await series.between(from, to, limit + 1);
    return {
      symbol: market.symbol,
      broker: market.brokerServer,
      period,
      timeframe: PERIOD_MINUTES[period],
      source: market.brokerServer,
      from,
      to,
      truncated: bars.length > limit,
      bars: bars.slice(0, limit).map((b) => this.historyBar(market.brokerServer, b)),
    };
  }

  /** MetaTrader's HST files on this computer, whether saved or not; `?symbol=` and `?period=` narrow the list. */
  private async historyFiles(q: URLSearchParams) {
    const symbol = q.get("symbol")?.toUpperCase();
    const period = q.get("period") ? parsePeriod(q.get("period")) : undefined;
    const files = (await this.options.catalog.files()).filter((f) => (!symbol || f.hst.header.symbol.toUpperCase() === symbol) && (!period || f.period === period));
    return {
      files: files.map((f) => ({
        file: f.file,
        symbol: f.hst.header.symbol,
        broker: f.brokerServer,
        terminal: f.terminalId,
        period: f.period,
        timeframe: PERIOD_MINUTES[f.period],
        digits: f.hst.header.digits,
        bars: f.span.bars,
        from: f.span.first,
        to: f.span.last,
        fromUtc: this.utcMs(f.brokerServer, f.span.first),
        toUtc: this.utcMs(f.brokerServer, f.span.last),
      })),
    };
  }

  /** One listed file's bars from `from` to `to` (broker seconds) as CSV, a page at a time; no row limit. */
  private async historyFileCsv(q: URLSearchParams, res: ServerResponse) {
    const id = q.get("file");
    const from = integer(q.get("from"), "from", 0, MAX_SECONDS, 0);
    const to = integer(q.get("to"), "to", from, MAX_SECONDS, MAX_SECONDS);
    // Only a file from the list: never a path the client made up.
    const file = (await this.options.catalog.files()).find((f) => f.file === id);
    if (!file) throw new RestRequestError(404, `Unknown .hst file ${id ?? ""}. See "hist files".`);
    const { symbol, digits } = file.hst.header;
    const day = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10).replaceAll("-", "");
    const name = `${symbol}_${file.period}_${day(Math.max(from, file.span.first))}-${day(Math.min(to, file.span.last))}.csv`;
    res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name.replace(/[^\w.-]/g, "_")}"`, "cache-control": "no-store" });
    await write(res, CSV_HEADER);
    const rule = this.options.clockRule(file.brokerServer);
    for (let next = from; !res.destroyed; ) {
      const bars = await file.hst.between(next, to, CSV_PAGE);
      if (bars.length) await write(res, csvRows(bars, digits, rule));
      if (bars.length < CSV_PAGE) break;
      next = bars.at(-1)!.time + 1;
    }
    res.end();
  }

  /** The one feed of a symbol: online feeds are preferred, and several still matching answer 409 with the candidates. */
  private resolveFeed(symbol: string, q: URLSearchParams): FeedSnapshot {
    const { broker, terminal, feed } = narrowing(q);
    const feeds = this.options.bridge.snapshot().feeds;
    if (feed) {
      const exact = feeds.find((f) => f.feed === feed);
      if (!exact) throw new RestRequestError(404, "Unknown feed");
      return exact;
    }
    const matches = feeds.filter((f) => f.symbol.toUpperCase() === symbol.toUpperCase() && (!broker || f.broker.toLowerCase().includes(broker)) && this.matchesTerminal(f.terminal, terminal));
    if (!matches.length) throw unknownSymbol(symbol);
    const online = matches.filter((f) => f.online);
    const pick = online.length ? online : matches;
    if (pick.length > 1) throw new RestRequestError(409, `Symbol ${symbol} is ambiguous; pass --broker, --terminal or --feed.`, pick.map(feedInfo));
    return pick[0];
  }

  /**
   * The one market of a symbol among the feeds' markets and `known` ones (recorded, saved, in HST folders), with a
   * feed of it when there is one. Several markets matching answer 409 with the candidates; several feeds of one market
   * do not. `brokerServer`, when given, must match exactly.
   */
  private resolveMarket(symbol: string, q: URLSearchParams, known: readonly (Market & { digits: number | null })[], brokerServer?: string): MarketAndFeed {
    const { broker, terminal, feed } = narrowing(q);
    const sameServer = (m: Market) => !brokerServer || m.brokerServer.toLowerCase() === brokerServer.toLowerCase();
    if (feed) {
      const exact = withFeed(this.resolveFeed(symbol, q));
      if (!sameServer(exact.market)) throw unknownSymbol(symbol);
      return exact;
    }
    const snapshot = this.options.bridge.snapshot();
    const candidates = new Map<string, MarketAndFeed>();
    for (const f of snapshot.feeds) {
      const best = candidates.get(marketKey(f.market))?.feed;
      if (!best || (f.online && !best.online)) candidates.set(marketKey(f.market), withFeed(f));
    }
    for (const m of known) {
      if (!candidates.has(marketKey(m))) candidates.set(marketKey(m), { market: { brokerServer: m.brokerServer, symbol: m.symbol }, feed: null, digits: m.digits });
    }
    // A market's terminals: those of its feeds and those logged into its broker server.
    const terminals = (m: Market) => [
      ...snapshot.feeds.filter((f) => marketKey(f.market) === marketKey(m)).map((f) => f.terminal),
      ...snapshot.terminals.filter((t) => t.brokerServer === m.brokerServer).map((t) => t.terminalId),
    ];
    const matches = [...candidates.values()].filter(
      ({ market: m }) =>
        m.symbol.toUpperCase() === symbol.toUpperCase() &&
        sameServer(m) &&
        (!broker || m.brokerServer.toLowerCase().includes(broker)) &&
        (!terminal || terminals(m).some((id) => this.matchesTerminal(id, terminal))),
    );
    if (!matches.length) throw unknownSymbol(symbol);
    if (matches.length > 1) {
      throw new RestRequestError(
        409,
        `Symbol ${symbol} is ambiguous; pass --broker or --terminal.`,
        matches.map((r) => ({ symbol: r.market.symbol, broker: r.market.brokerServer, terminal: r.feed?.terminal ?? null, feed: r.feed?.feed ?? null })),
      );
    }
    return matches[0];
  }

  /** The symbol's feed, else (no feed matches, and no exact `?feed=` was asked for) its market among `known` ones. */
  private async feedElseMarket(symbol: string, q: URLSearchParams, known: () => Promise<(Market & { digits: number | null })[]>): Promise<MarketAndFeed> {
    try {
      return withFeed(this.resolveFeed(symbol, q));
    } catch (e) {
      if (!(e instanceof RestRequestError) || e.status !== 404 || q.get("feed")) throw e;
      return this.resolveMarket(symbol, q, await known());
    }
  }

  /** Every market the History page knows: its feeds', recorded and saved ones, and those in the HST folders. */
  private async knownMarkets() {
    return (await this.options.catalog.list()).map((m) => ({ brokerServer: m.brokerServer, symbol: m.symbol, digits: m.digits }));
  }

  /** Whether a terminal's ID or name holds `terminal` (lower case); true when no terminal is asked for. */
  private matchesTerminal(terminalId: string, terminal: string | undefined): boolean {
    return !terminal || terminalId.toLowerCase().includes(terminal) || !!this.options.terminalName(terminalId)?.toLowerCase().includes(terminal);
  }

  /** A broker time in seconds as UTC milliseconds, by the broker server's clock rule (as it is while unknown). */
  private utcMs(brokerServer: string, brokerSeconds: number): number {
    return brokerToUtc(this.options.clockRule(brokerServer) ?? UNKNOWN_RULE, brokerSeconds * 1000);
  }

  /** A bar as the API answers it: its start in broker seconds and UTC ms, and its prices. */
  private bar(brokerServer: string, c: Candle) {
    return { time: c.time, timeUtc: this.utcMs(brokerServer, c.time), open: c.open, high: c.high, low: c.low, close: c.close };
  }

  /** An HST or saved bar, with its tick volume and spread. */
  private historyBar(brokerServer: string, b: HstBar) {
    return { ...this.bar(brokerServer, b), volume: b.tickVolume, spread: b.spread };
  }
}

/** Public: the CLI checks the service and API version before signing in. */
export function info() {
  return { service: "mt4-quote-bridge", apiVersion: API_VERSION };
}

/** A path's `:symbol`. */
function symbolOf(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new RestRequestError(400, "Invalid symbol");
  }
}

/** A period as the legacy API takes it: M1 … MN1, reversed (1H, 15M), or minutes (60). */
function parsePeriod(text: string | null): Period {
  const value = (text ?? "").toUpperCase();
  const reversed = /^(\d+)(MN|M|H|D|W)$/.exec(value);
  const name = reversed ? `${reversed[2]}${reversed[1]}` : /^\d+$/.test(value) ? PERIODS.find((p) => PERIOD_MINUTES[p] === Number(value)) : value;
  if (!PERIODS.includes(name as Period)) throw new RestRequestError(400, "Invalid period. Use M1, M5, M15, M30, H1, H4, D1, W1, MN1 (or 1H, 15M, minutes)");
  return name as Period;
}

/** An integer query parameter from `min` to `max`, `fallback` when not given. */
function integer(text: string | null, name: string, min: number, max: number, fallback: number): number {
  if (text === null || text === "") return fallback;
  const n = Number(text);
  if (!/^-?\d+$/.test(text) || !Number.isSafeInteger(n) || n < min || n > max) throw new RestRequestError(400, `${name} must be an integer ${min}–${max}`);
  return n;
}

/** `?broker=` (the broker server) and `?terminal=` (its ID or name): substrings, case-insensitive; `?feed=` exact. */
function narrowing(q: URLSearchParams) {
  const text = (name: string) => {
    const value = q.get(name);
    if (value !== null && value.length > 1000) throw new RestRequestError(400, `Invalid ${name}`);
    return value || undefined;
  };
  return { broker: text("broker")?.toLowerCase(), terminal: text("terminal")?.toLowerCase(), feed: text("feed") };
}

/** A feed with its market. */
const withFeed = (f: FeedSnapshot): MarketAndFeed => ({ market: f.market, feed: f, digits: f.digits });

/** Which feed a row or candidate is, as the legacy API names it. */
const feedInfo = (f: FeedSnapshot) => ({ symbol: f.symbol, broker: f.broker, terminal: f.terminal, feed: f.feed });

/** The spread in points. */
const spread = (bid: number, ask: number, digits: number) => Number(((ask - bid) * 10 ** digits).toFixed(1));

const unknownSymbol = (symbol: string) => new RestRequestError(404, `Unknown symbol ${symbol}. List available symbols with "symbols list".`);

const noHistory = (period: Period, m: Market) => new RestRequestError(404, `No ${period} history of ${m.symbol} on ${m.brokerServer}. See "hist list".`);
