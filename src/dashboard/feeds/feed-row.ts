// What one row of the Feeds view shows: formatted quote cells and warnings, from a feed snapshot.
import type { FeedSnapshot } from "../../server/bridge/index.js";
import { count, duration } from "../format.js";

export type FeedWarning = { kind: "no-quote" | "stale" | "dropped" | "duplicate"; text: string };

export type FeedRow = {
  /** "Online", or "Offline, last heard 3 min ago". */
  status: string;
  /** Only offline feeds can be removed from the list (a reconnecting EA adds it again). */
  removable: boolean;
  /** MetaTrader period name of the owner chart: "H1"; "—" when the EA does not report it. */
  timeframe: string;
  bid: string;
  ask: string;
  /** In points, as MetaTrader's Market Watch shows it. */
  spread: string;
  /** The broker's server time of the quote (as sent by the EA, no time-zone conversion): "08:00:00". */
  quoteTime: string;
  /** Its date, "2027-01-15"; empty without a quote. */
  quoteDate: string;
  /** Most serious first. */
  warnings: FeedWarning[];
};

const NONE = "—";

const PERIOD_NAMES: Record<number, string> = {
  1: "M1",
  5: "M5",
  15: "M15",
  30: "M30",
  60: "H1",
  240: "H4",
  1440: "D1",
  10080: "W1",
  43200: "MN1",
};

export function timeframeLabel(minutes: number | null): string {
  if (minutes === null) return NONE;
  return PERIOD_NAMES[minutes] ?? `M${minutes}`;
}

export function describeFeed(feed: FeedSnapshot, snapshotTime: number): FeedRow {
  const { latest, digits } = feed;
  // MT4 quote times are the broker's server time in epoch seconds; read the fields as UTC so nothing shifts them.
  const stamp = latest ? new Date(latest.quoteTime * 1000).toISOString() : "";
  return {
    status: feed.online ? "Online" : `Offline, last heard ${duration(snapshotTime - feed.lastSeen)} ago`,
    removable: !feed.online,
    timeframe: timeframeLabel(feed.timeframe),
    bid: latest ? latest.bid.toFixed(digits) : NONE,
    ask: latest ? latest.ask.toFixed(digits) : NONE,
    spread: latest ? String(Math.round((latest.ask - latest.bid) * 10 ** digits)) : NONE,
    quoteTime: latest ? stamp.slice(11, 19) : NONE,
    quoteDate: stamp.slice(0, 10),
    warnings: warnings(feed, snapshotTime),
  };
}

function warnings(feed: FeedSnapshot, snapshotTime: number): FeedWarning[] {
  const list: FeedWarning[] = [];
  if (feed.quoteStatus === "no-quote") list.push({ kind: "no-quote", text: "No valid quote" });
  if (feed.instances > 1) list.push({ kind: "duplicate", text: `Duplicate EAs on ${feed.instances} charts` });
  if (feed.stale) {
    const since = feed.quoteUnchangedSince ?? snapshotTime;
    list.push({ kind: "stale", text: `Quote unchanged for ${duration(snapshotTime - since)}` });
  }
  if (feed.dropped > 0) {
    list.push({ kind: "dropped", text: `${count(feed.dropped)} ${feed.dropped === 1 ? "sample" : "samples"} dropped` });
  }
  return list;
}

/** Symbol, then broker, then terminal: a feed keeps its place when it goes offline or comes back. */
export function sortFeeds(feeds: readonly FeedSnapshot[]): FeedSnapshot[] {
  const key = (f: FeedSnapshot) => [f.symbol, f.broker, f.terminal];
  return [...feeds].sort((a, b) => {
    const [ka, kb] = [key(a), key(b)];
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    }
    return 0;
  });
}
