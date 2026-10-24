// Ordinary market reads only: not an account executor/preview source selector.
import type { BridgeSnapshot, FeedSnapshot } from "./bridge.js";
import type { Market } from "./protocol.js";

export const SOURCE_SILENCE_MS = 5000;

export type MarketSource = {
  feed: FeedSnapshot;
  /** Offline data is explicitly last-known, never promoted to a live quote. */
  state: "connected" | "last-known";
  provenance: {
    terminalId: string;
    feedId: string;
    brokerServer: string;
    symbol: string;
    /** Broker-clock seconds, not the PC receipt time. */
    quoteTime: number | null;
    /** PC receipt time of the last accepted samples batch, not last hello. */
    receivedAt: number | null;
  };
  /** Age of the quote in UTC, when a quote exists (unknown broker clock rules keep bridge semantics). */
  quoteAgeMs: number | null;
  /** Time since samples were received; hello/bar traffic must not disguise a silent quote source. */
  sourceSilenceMs: number | null;
  /** True at >= 5 seconds or if no samples have ever been received; independent of quote age/online status. */
  sourceSilent: boolean;
};

/**
 * Select within ONE EXACT brokerServer+symbol, never across case-folded symbols or similar broker names.
 * Sources with quotes win over unquoted sources, then connected sources, newest broker quote, newest receipt,
 * lexical Terminal ID (and feed ID as a final tie).
 * When every source is offline retain the best last-known source with the same ordering. Input is never mutated.
 * Consumers can use `.feed` for legacy chart/REST reads; freshness/provenance are for newer market surfaces.
 */
export function selectMarketSource(snapshot: Pick<BridgeSnapshot, "time" | "feeds">, market: Market): MarketSource | null {
  const matching = snapshot.feeds.filter((f) => f.market.brokerServer === market.brokerServer && f.market.symbol === market.symbol);
  const quoted = matching.filter((f) => f.latest);
  const feed = (quoted.length ? quoted : matching).sort(compareSources)[0];
  if (!feed) return null;
  const receivedAt = feed.quoteReceivedAt;
  const sourceSilenceMs = receivedAt === null ? null : Math.max(0, snapshot.time - receivedAt);
  return {
    feed,
    state: feed.online ? "connected" : "last-known",
    provenance: { terminalId: feed.terminal, feedId: feed.feed, brokerServer: feed.market.brokerServer, symbol: feed.market.symbol, quoteTime: feed.latest?.quoteTime ?? null, receivedAt },
    quoteAgeMs: feed.quoteTimeUtc === null ? null : Math.max(0, snapshot.time - feed.quoteTimeUtc),
    sourceSilenceMs,
    sourceSilent: sourceSilenceMs === null || sourceSilenceMs >= SOURCE_SILENCE_MS,
  };
}

function compareSources(a: FeedSnapshot, b: FeedSnapshot): number {
  if (a.online !== b.online) return a.online ? -1 : 1;
  const quote = newest(a.latest?.quoteTime, b.latest?.quoteTime);
  if (quote) return quote;
  const received = newest(a.quoteReceivedAt, b.quoteReceivedAt);
  return received || lexical(a.terminal, b.terminal) || lexical(a.feed, b.feed);
}

function newest(a: number | null | undefined, b: number | null | undefined): number {
  if (a == null) return b == null ? 0 : 1;
  if (b == null) return -1;
  return b - a;
}
const lexical = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
