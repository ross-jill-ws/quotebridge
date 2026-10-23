// The EA's bars: what a chart in MetaTrader shows, asked of the feed's EA (1.10+) when the HST files cannot show it
// (MetaTrader writes a period's file only when its chart closes). Chart history asks for a market's period when it has
// a gap (chart-history.ts): as a feed connects (its chart period) and as a chart opens the period; the last 900 closed
// bars go into saved history, so they survive a restart. A market's period is asked once per run while its bars come
// in (a feed that comes online again may ask again); a "loading" answer is asked again a little later, and so is an
// unanswered one (the EA streams one request at a time: a newer one replaces it), a few times (an older EA is not asked
// at all).
import { brokerToUtc, UNKNOWN_RULE, type ClockRule } from "../../shared/clock.js";
import type { Period } from "../../shared/periods.js";
import { marketKey, MAX_REQUEST_BARS, type BarsEvent, type BridgeServer, type EaBar, type FeedSnapshot, type Market } from "../bridge/index.js";
import { PERIOD_MINUTES, PERIOD_OF } from "./chart-history.js";
import type { SavedBar } from "./saved-store.js";

/** A "loading" answer is asked again after this long, at most LOADING_TRIES times in all. */
export const LOADING_RETRY_MS = 1000;
const LOADING_TRIES = 30;
/** A request with no page for this long is asked again, at most UNANSWERED_TRIES times in all. */
export const ANSWER_TIMEOUT_MS = 10_000;
const UNANSWERED_TRIES = 3;

export type EaBarFetcherOptions = {
  bridge: Pick<BridgeServer, "requestBars" | "onBars">;
  /** Saves bars of a market's period, `time` in broker seconds and `utc` in UTC seconds. */
  save: (market: Market, digits: number, period: Period, bars: SavedBar[]) => Promise<void>;
  clockRule: (brokerServer: string) => ClockRule | null;
};

type Asking = {
  feed: string;
  digits: number;
  /** The request's number once sent; undefined while sending or waiting to ask again. */
  request?: number;
  /** Requests sent, and of them those that went unanswered. */
  tries: number;
  unanswered: number;
  pages: Map<number, EaBar[]>;
  timer?: NodeJS.Timeout;
};

export class EaBarFetcher {
  /** Per market period key: being asked for. */
  private readonly asking = new Map<string, Asking>();
  /** Market period keys whose bars came in this run. */
  private readonly answered = new Set<string>();
  private readonly unsubscribe: () => void;
  private closed = false;

  constructor(private readonly options: EaBarFetcherOptions) {
    this.unsubscribe = options.bridge.onBars((event) => this.page(event));
  }

  /**
   * Asks the feed's EA for the market's period, unless its bars came in this run or are on their way. Resolves once the
   * request is sent, or refused (an offline feed, an older EA).
   */
  async want(feed: FeedSnapshot, period: Period): Promise<void> {
    const key = periodKey(feed.market, period);
    if (this.closed || !feed.online || this.answered.has(key) || this.asking.has(key)) return;
    const asking: Asking = { feed: feed.feed, digits: feed.digits, tries: 0, unanswered: 0, pages: new Map() };
    this.asking.set(key, asking);
    await this.ask(key, asking, period);
  }

  /** Lets a market's periods be asked for again, as when one of its feeds comes online again after a while away. */
  forget(market: Market) {
    const prefix = `${marketKey(market)}|`;
    for (const key of this.answered) if (key.startsWith(prefix)) this.answered.delete(key);
  }

  /** Whether bars of the market's period are being asked for. */
  filling(market: Market, period: Period): boolean {
    return this.asking.has(periodKey(market, period));
  }

  close() {
    this.closed = true;
    this.unsubscribe();
    for (const asking of this.asking.values()) clearTimeout(asking.timer);
    this.asking.clear();
  }

  private async ask(key: string, asking: Asking, period: Period) {
    asking.tries++;
    asking.pages.clear();
    const request = await this.options.bridge.requestBars(asking.feed, PERIOD_MINUTES[period], MAX_REQUEST_BARS).catch(() => null);
    if (this.asking.get(key) !== asking) return;
    if (request === null) return this.drop(key, asking);
    asking.request = request;
    this.expect(key, asking, period);
  }

  /** (Re)starts the wait for the request's next page; an unanswered request is asked again, a few times. */
  private expect(key: string, asking: Asking, period: Period) {
    clearTimeout(asking.timer);
    asking.timer = setTimeout(() => {
      if (this.asking.get(key) !== asking) return;
      asking.request = undefined;
      if (++asking.unanswered >= UNANSWERED_TRIES) this.drop(key, asking);
      else void this.ask(key, asking, period);
    }, ANSWER_TIMEOUT_MS);
  }

  /** Stops asking, unless the market's period is being asked for anew. */
  private drop(key: string, asking: Asking) {
    clearTimeout(asking.timer);
    if (this.asking.get(key) === asking) this.asking.delete(key);
  }

  private page(event: BarsEvent) {
    const period = PERIOD_OF.get(event.timeframe);
    const key = period && periodKey(event.market, period);
    const asking = key && this.asking.get(key);
    if (!period || !key || !asking || asking.request !== event.request) return;
    if (event.status === "loading") {
      clearTimeout(asking.timer);
      asking.request = undefined;
      if (asking.tries >= LOADING_TRIES) this.drop(key, asking);
      else asking.timer = setTimeout(() => this.asking.get(key) === asking && void this.ask(key, asking, period), LOADING_RETRY_MS);
      return;
    }
    asking.pages.set(event.offset, event.bars);
    const received = [...asking.pages.values()].reduce((n, bars) => n + bars.length, 0);
    if (received < event.total) {
      this.expect(key, asking, period);
      return;
    }
    clearTimeout(asking.timer);
    asking.request = undefined;
    const rule = this.options.clockRule(event.market.brokerServer) ?? UNKNOWN_RULE;
    const bars = [...asking.pages.entries()]
      .sort(([a], [b]) => a - b)
      .flatMap(([, page]) => page)
      .map((b): SavedBar => ({ ...b, spread: 0, realVolume: 0, utc: brokerToUtc(rule, b.time * 1000) / 1000 }));
    // Still filling until the bars can be read back.
    this.options
      .save(event.market, asking.digits, period, bars)
      .then(
        () => this.answered.add(key),
        (e) => console.error(`The EA's ${period} bars of ${event.market.symbol} on ${event.market.brokerServer} could not be saved`, e),
      )
      .finally(() => this.drop(key, asking));
  }
}

const periodKey = (market: Market, period: Period) => `${marketKey(market)}|${period}`;
