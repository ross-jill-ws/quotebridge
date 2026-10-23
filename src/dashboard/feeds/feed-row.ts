// What one row of the Feeds view shows: formatted quote cells and warnings, from a feed snapshot.
import type { BridgeSnapshot, FeedSnapshot, TerminalPresence } from "../../server/bridge/index.js";
import type { TimeShown } from "../../shared/settings-store.js";
import { browserOffsetMinutes, displaySeconds } from "../display-clock.js";
import { count, duration } from "../format.js";

export type FeedWarning = { kind: "no-quote" | "no-samples" | "stale" | "dropped" | "duplicate"; text: string };

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
  /** The quote's time on the clock Time shown chooses: "08:00:00". */
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

/** `shown` is the Time shown setting; `localOffsetMinutes` this computer's offset from UTC (injectable for tests). */
export function describeFeed(feed: FeedSnapshot, snapshotTime: number, shown: TimeShown = "broker", localOffsetMinutes = browserOffsetMinutes): FeedRow {
  const { latest, digits } = feed;
  // Seconds on the display clock, read as UTC fields so nothing shifts them again.
  const time = feed.quoteTimeUtc === null ? undefined : displaySeconds({ shown, rule: feed.clockRule, localOffsetMinutes }, feed.quoteTimeUtc / 1000);
  const stamp = latest && time !== undefined ? new Date(time * 1000).toISOString() : "";
  return {
    status: feed.online ? "Online" : `Offline, last heard ${duration(snapshotTime - feed.lastSeen)} ago`,
    removable: !feed.online,
    timeframe: timeframeLabel(feed.timeframe),
    bid: latest ? latest.bid.toFixed(digits) : NONE,
    ask: latest ? latest.ask.toFixed(digits) : NONE,
    spread: latest ? String(Math.round((latest.ask - latest.bid) * 10 ** digits)) : NONE,
    quoteTime: stamp ? stamp.slice(11, 19) : NONE,
    quoteDate: stamp.slice(0, 10),
    warnings: warnings(feed, snapshotTime),
  };
}

function warnings(feed: FeedSnapshot, snapshotTime: number): FeedWarning[] {
  const list: FeedWarning[] = [];
  // An EA without a valid quote sends no samples: its warning says so already.
  const noSamples = feed.samplesMissing && feed.quoteStatus !== "no-quote";
  if (feed.quoteStatus === "no-quote") list.push({ kind: "no-quote", text: "No valid quote" });
  if (noSamples) list.push({ kind: "no-samples", text: noSamplesText(feed, snapshotTime) });
  if (feed.instances > 1) list.push({ kind: "duplicate", text: `Duplicate EAs on ${feed.instances} charts` });
  // Without samples the quote cannot change: the missing samples are the warning.
  if (feed.stale && !noSamples) {
    const since = feed.quoteUnchangedSince ?? snapshotTime;
    list.push({ kind: "stale", text: `Quote unchanged for ${duration(snapshotTime - since)}` });
  }
  if (feed.dropped > 0) {
    list.push({ kind: "dropped", text: `${count(feed.dropped)} ${feed.dropped === 1 ? "sample" : "samples"} dropped` });
  }
  return list;
}

/** A rejection this recent, after the last accepted samples, is why none arrive (a stuck EA repeats it every second or so). */
const CURRENT_REJECTION_MS = 30000;

function noSamplesText(feed: FeedSnapshot, snapshotTime: number): string {
  const rejection = feed.lastRejection;
  const current =
    rejection && snapshotTime - rejection.time < CURRENT_REJECTION_MS && (feed.samplesAcceptedAt === null || rejection.time > feed.samplesAcceptedAt);
  return current ? `No quotes received: the app rejects its messages (${rejection.reason})` : "No quotes received";
}

/** A price as a dealing ticket sets it: the big figure small, the pips large, the pipette raised. */
export type PriceParts = { big: string; pips: string; pipette: string };

/**
 * With 3 or 5 digits the last digit is the pipette and the two before it the pips; with 2 or 4 digits
 * the last two digits are the pips. Other digit counts are the plain price (all in `big`).
 */
export function priceParts(price: number, digits: number): PriceParts {
  const text = price.toFixed(digits);
  if (digits === 3 || digits === 5) return { big: text.slice(0, -3), pips: text.slice(-3, -1), pipette: text.slice(-1) };
  if (digits === 2 || digits === 4) return { big: text.slice(0, -2), pips: text.slice(-2), pipette: "" };
  return { big: text, pips: "", pipette: "" };
}

/** Which way a feed's pips flash: the direction of the last bid change, and when it changed (restarts the fade). */
export type Flash = { bid: number | undefined; direction: "up" | "down" | "none"; changedAt: number };

/** The flash after a new snapshot of the feed's bid; the same object while the bid stays the same. */
export function nextFlash(previous: Flash | undefined, bid: number | undefined, now: number): Flash {
  if (previous && previous.bid === bid) return previous;
  if (previous?.bid === undefined || bid === undefined) return { bid, direction: "none", changedAt: now };
  return { bid, direction: bid > previous.bid ? "up" : "down", changedAt: now };
}

/** One terminal's feeds, with the terminal's state for the group's head. */
export type FeedGroup = {
  terminal: string;
  /** The terminal's name from the Terminals view, or its broker when the app does not manage it. */
  name: string;
  /** "EA 1.08 connected", or "Offline, last heard 2 h ago". */
  state: { text: string; online: boolean };
  /** By symbol. */
  feeds: FeedSnapshot[];
};

export type FeedGroups = {
  groups: FeedGroup[];
  /** "6 feeds from 2 terminals." */
  summary: string;
  /** "1 needs attention.": feeds with warnings; empty when none. */
  attention: string;
};

/** The Feeds view by terminal: `names` maps Terminal IDs to the names the Terminals view shows. */
export function groupFeeds(snapshot: Pick<BridgeSnapshot, "feeds" | "terminals">, names: ReadonlyMap<string, string>, snapshotTime: number): FeedGroups {
  const byTerminal = new Map<string, FeedSnapshot[]>();
  for (const feed of sortFeeds(snapshot.feeds)) {
    const list = byTerminal.get(feed.terminal) ?? [];
    list.push(feed);
    byTerminal.set(feed.terminal, list);
  }
  const presence = new Map(snapshot.terminals.map((p) => [p.terminalId, p]));
  const groups = [...byTerminal].map(([terminal, feeds]): FeedGroup => {
    const brokers = [...new Set(feeds.map((f) => f.broker))].join(", ");
    return { terminal, name: names.get(terminal) ?? brokers, state: terminalState(feeds, presence.get(terminal), snapshotTime), feeds };
  });
  groups.sort((a, b) => a.name.localeCompare(b.name) || (a.terminal < b.terminal ? -1 : 1));

  const feeds = snapshot.feeds.length;
  const warned = snapshot.feeds.filter((f) => warnings(f, snapshotTime).length > 0).length;
  return {
    groups,
    summary: `${feeds} ${feeds === 1 ? "feed" : "feeds"} from ${groups.length} ${groups.length === 1 ? "terminal" : "terminals"}.`,
    attention: warned === 0 ? "" : `${warned} ${warned === 1 ? "needs" : "need"} attention.`,
  };
}

function terminalState(feeds: FeedSnapshot[], presence: TerminalPresence | undefined, snapshotTime: number): FeedGroup["state"] {
  if (feeds.some((f) => f.online)) return { text: presence?.eaVersion ? `EA ${presence.eaVersion} connected` : "EA connected", online: true };
  const lastHeard = Math.max(...feeds.map((f) => f.lastSeen));
  return { text: `Offline, last heard ${duration(snapshotTime - lastHeard)} ago`, online: false };
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
