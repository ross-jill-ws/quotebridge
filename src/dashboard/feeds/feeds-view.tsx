// Feeds view: every feed the QuoteBridge EAs send, grouped by terminal, with its live quote, warnings and the record
// switch of its market.
import { useMemo, useRef, useState } from "preact/hooks";
import type { FeedSnapshot } from "../../server/bridge/index.js";
import type { TimeShown } from "../../shared/settings-store.js";
import { post } from "../api.js";
import { clockLabel } from "../display-clock.js";
import type { Live } from "../use-live.js";
import { useTicker } from "../use-live.js";
import { Price } from "../price.js";
import { describeFeed, groupFeeds, nextFlash, type Flash, type FeedGroup } from "./feed-row.js";

type Props = {
  live: Live;
  /** Terminal IDs to the names the Terminals view shows. */
  terminalNames: ReadonlyMap<string, string>;
  /** The Flash prices setting; reduced motion turns the flash off in CSS whatever it says. */
  flashPrices: boolean;
  /** The clock quote times are shown in. */
  timeShown: TimeShown;
};

export function FeedsView({ live, terminalNames, flashPrices, timeShown }: Props) {
  const now = useTicker(1000);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState("");
  const { snapshot } = live;
  const connected = live.status === "live";
  const flashes = useFlashes(snapshot?.feeds, snapshot?.time ?? 0);

  /** Recording belongs to the market: every row of it follows the switch with the next snapshot. */
  async function record(feed: FeedSnapshot, on: boolean) {
    setBusy(feed.feed);
    setError("");
    try {
      await post("/api/markets/recording", { ...feed.market, on });
    } catch (e) {
      setError(`Could not ${on ? "start" : "stop"} recording ${feed.symbol}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(undefined);
    }
  }

  async function remove(feed: FeedSnapshot) {
    setBusy(feed.feed);
    setError("");
    try {
      await post("/api/feeds/remove", { feed: feed.feed });
    } catch (e) {
      setError(`Could not remove ${feed.symbol}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(undefined);
    }
  }

  if (!snapshot) {
    return (
      <section class="view">
        <h1>Feeds</h1>
        <div class="empty">
          <p>Connecting to the app…</p>
        </div>
      </section>
    );
  }

  // The server sends a snapshot only when something changes; let elapsed times keep counting in between
  // (but not while disconnected, when the values are no longer current).
  const time = connected ? snapshot.time + Math.max(0, now - live.receivedAt) : snapshot.time;
  const { groups, summary, attention } = groupFeeds(snapshot, terminalNames, time);

  return (
    <section class="view" aria-labelledby="feeds-title">
      <div class="view-heading">
        <div>
          <h1 id="feeds-title">Feeds</h1>
          {groups.length > 0 && (
            <p class="summary">
              {summary}
              {attention && <span class="attention-text"> {attention}</span>}
            </p>
          )}
        </div>
      </div>
      {error && (
        <div class="notice bad" role="alert">
          {error}
          <button class="link" onClick={() => setError("")}>
            Dismiss
          </button>
        </div>
      )}
      {groups.length === 0 ? (
        <div class="empty">
          <p>No feeds yet.</p>
          <p class="muted">A feed appears here as soon as a QuoteBridge EA on a MetaTrader chart connects to the app.</p>
        </div>
      ) : (
        <div class={`feed-groups${connected ? "" : " paused"}${flashPrices && connected ? " flashing" : ""}`}>
          {groups.map((group) => (
            <FeedGroupView key={group.terminal} group={group} time={time} timeShown={timeShown} flashes={flashes} connected={connected} busy={busy} onRecord={record} onRemove={remove} />
          ))}
        </div>
      )}
    </section>
  );
}

function FeedGroupView({
  group,
  time,
  timeShown,
  flashes,
  connected,
  busy,
  onRecord,
  onRemove,
}: {
  group: FeedGroup;
  time: number;
  timeShown: TimeShown;
  flashes: ReadonlyMap<string, Flash>;
  connected: boolean;
  busy?: string;
  onRecord: (feed: FeedSnapshot, on: boolean) => void;
  onRemove: (feed: FeedSnapshot) => void;
}) {
  const titleId = `group-${group.terminal}`;
  return (
    <section class="feed-group" aria-labelledby={titleId}>
      <header class="group-head">
        <h2 id={titleId}>{group.name}</h2>
        <span class="mono tid">{group.terminal}</span>
        <span class="group-state">
          <span class={`dot ${group.state.online ? "good" : "off"}`} aria-hidden="true" />
          {group.state.text}
        </span>
      </header>
      <div class="table-scroll">
        <table class="feeds">
          <thead>
            <tr>
              <th class="symbol-col">Symbol</th>
              <th class="num price-col">Bid</th>
              <th class="num price-col">Ask</th>
              <th class="num spread-col" title="Spread in points">
                Spread
              </th>
              <th class="num time-col" title={`${clockLabel(timeShown)} of the latest quote`}>
                Quote time
              </th>
              <th class="status-col">Status</th>
              <th class="record-col" title="Keep every sample of this market (symbol and broker server) until you delete it in Settings">
                Record
              </th>
              <th class="action-col">
                <span class="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {group.feeds.map((feed) => {
              const row = describeFeed(feed, time, timeShown);
              const flash = feed.online ? flashes.get(feed.feed) : undefined;
              return (
                <tr key={feed.feed} class={feed.online ? undefined : "offline"}>
                  <td class="symbol-col">
                    <a class="symbol-link" href={`#/charts?feed=${encodeURIComponent(feed.feed)}`} title={`Open the ${feed.symbol} chart (${feed.broker})`}>
                      <span class="symbol-name">{feed.symbol}</span>
                    </a>
                    <span class="chip" title="Period of the chart the EA runs on">
                      {row.timeframe}
                    </span>
                  </td>
                  <td class="num price-cell">
                    <Price value={feed.latest?.bid} digits={feed.digits} flash={flash} />
                  </td>
                  <td class="num price-cell">
                    <Price value={feed.latest?.ask} digits={feed.digits} flash={flash} />
                  </td>
                  <td class="num spread">{row.spread}</td>
                  <td class="num quote-time" title={row.quoteDate || undefined}>
                    {row.quoteTime}
                  </td>
                  <td class="status-col">
                    {!feed.online && <span class="flag plain">{row.status}</span>}
                    {row.warnings.map((w) => (
                      <span key={w.kind} class={`flag ${w.kind === "stale" ? "caution" : "fault"}`}>
                        {w.text}
                      </span>
                    ))}
                  </td>
                  <td class="record-col">
                    <input
                      type="checkbox"
                      role="switch"
                      class="switch small"
                      checked={feed.recording}
                      disabled={!connected || busy === feed.feed}
                      aria-label={`Record ${feed.symbol} on ${feed.broker}`}
                      title={feed.recording ? `Recording ${feed.symbol} on ${feed.broker}. Stop or delete it in Settings › Recording.` : `Record every sample of ${feed.symbol} on ${feed.broker}`}
                      onChange={(e) => onRecord(feed, (e.target as HTMLInputElement).checked)}
                    />
                  </td>
                  <td class="actions">
                    {row.removable && (
                      <button
                        class="button quiet small"
                        disabled={!connected || busy === feed.feed}
                        aria-label={`Remove offline ${feed.symbol} (${feed.broker}, ${feed.terminal})`}
                        title="Remove from the list. It comes back if its EA connects again."
                        onClick={() => onRemove(feed)}
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Each feed's flash, carried from snapshot to snapshot. */
function useFlashes(feeds: FeedSnapshot[] | undefined, time: number): ReadonlyMap<string, Flash> {
  const previous = useRef<ReadonlyMap<string, Flash>>(new Map());
  return useMemo(() => {
    const next = new Map<string, Flash>();
    for (const feed of feeds ?? []) next.set(feed.feed, nextFlash(previous.current.get(feed.feed), feed.latest?.bid, time));
    previous.current = next;
    return next;
  }, [feeds, time]);
}
