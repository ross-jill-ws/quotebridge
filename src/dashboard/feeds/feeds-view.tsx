// Feeds view: every feed the QuoteBridge EAs send, with its live quote and warnings.
import { useState } from "preact/hooks";
import type { FeedSnapshot } from "../../server/bridge/index.js";
import { post } from "../api.js";
import type { Live } from "../use-live.js";
import { useTicker } from "../use-live.js";
import { describeFeed, sortFeeds } from "./feed-row.js";

export function FeedsView({ live }: { live: Live }) {
  const now = useTicker(1000);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState("");
  const { snapshot } = live;
  const connected = live.status === "live";

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
  const feeds = sortFeeds(snapshot.feeds);
  const rows = feeds.map((feed) => ({ feed, row: describeFeed(feed, time) }));
  const online = feeds.filter((f) => f.online).length;
  const warned = rows.filter((r) => r.row.warnings.length).length;

  return (
    <section class="view" aria-labelledby="feeds-title">
      <div class="view-heading">
        <h1 id="feeds-title">Feeds</h1>
        {feeds.length > 0 && (
          <p class="summary">
            {feeds.length} {feeds.length === 1 ? "feed" : "feeds"} · {online} online
            {warned > 0 && (
              <>
                {" · "}
                <span class="warn-text">
                  {warned} with {warned === 1 ? "a warning" : "warnings"}
                </span>
              </>
            )}
          </p>
        )}
      </div>
      {error && (
        <div class="notice bad" role="alert">
          {error}
          <button class="link" onClick={() => setError("")}>
            Dismiss
          </button>
        </div>
      )}
      {feeds.length === 0 ? (
        <div class="empty">
          <p>No feeds yet.</p>
          <p class="muted">A feed appears here as soon as a QuoteBridge EA on a MetaTrader chart connects to the app.</p>
        </div>
      ) : (
        <div class={connected ? "table-wrap" : "table-wrap paused"}>
          <table class="feeds">
            <thead>
              <tr>
                <th class="symbol-col">Symbol</th>
                <th>TF</th>
                <th class="num">Bid</th>
                <th class="num">Ask</th>
                <th class="num" title="Spread in points">
                  Spread
                </th>
                <th class="num" title="Broker server time of the latest quote">
                  Quote time
                </th>
                <th>Warnings</th>
                <th>
                  <span class="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ feed, row }) => (
                <tr key={feed.feed} class={feed.online ? undefined : "offline"}>
                  <td class="symbol-col">
                    <div class="symbol">
                      <span class={`dot ${feed.online ? "good" : "off"}`} role="img" aria-label={row.status} title={row.status} />
                      <span class="symbol-name">{feed.symbol}</span>
                    </div>
                    <div class="feed-source">
                      {feed.broker} · {feed.terminal}
                    </div>
                  </td>
                  <td>
                    <span class="chip">{row.timeframe}</span>
                  </td>
                  <td class="num price">{row.bid}</td>
                  <td class="num price">{row.ask}</td>
                  <td class="num">{row.spread}</td>
                  <td class="num" title={row.quoteDate || undefined}>
                    {row.quoteTime}
                  </td>
                  <td class="warnings">
                    {!feed.online && <span class="tag neutral">{row.status}</span>}
                    {row.warnings.map((w) => (
                      <span key={w.kind} class={`tag ${w.kind === "stale" ? "warn" : "bad"}`}>
                        {w.text}
                      </span>
                    ))}
                  </td>
                  <td class="actions">
                    {row.removable && (
                      <button
                        class="button quiet small"
                        disabled={!connected || busy === feed.feed}
                        aria-label={`Remove offline ${feed.symbol} (${feed.broker}, ${feed.terminal})`}
                        title="Remove from the list. It comes back if its EA connects again."
                        onClick={() => remove(feed)}
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
