// The History page: a group per market with a row per period (what the HST file holds, what the app has saved) and the
// period's CSV and HST downloads, filtered by symbol or broker server.
import { useEffect, useState } from "preact/hooks";
import type { HistoryMarket } from "../../server/history/index.js";
import type { TimeShown } from "../../shared/settings-store.js";
import { get } from "../api.js";
import { browserOffsetMinutes } from "../display-clock.js";
import { historyGroups, type SpanText } from "./history-model.js";

/** HST files grow as MetaTrader writes them: the list is read again this often while the page is open. */
const HISTORY_REFRESH_MS = 30_000;

const TIMES_IN: Record<TimeShown, string> = { broker: "broker time", local: "local time", utc: "UTC" };

export function HistoryView({ timeShown }: { timeShown: TimeShown }) {
  const [markets, setMarkets] = useState<HistoryMarket[]>();
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    const load = () =>
      get<{ markets: HistoryMarket[] }>("/api/history").then(
        (answer) => {
          setMarkets(answer.markets);
          setError("");
        },
        (e: Error) => setError(e.message),
      );
    load();
    const timer = setInterval(load, HISTORY_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const groups = markets ? historyGroups(markets, { shown: timeShown, query, localOffsetMinutes: browserOffsetMinutes }) : [];
  return (
    <section class="view" aria-labelledby="history-title">
      <div class="view-heading">
        <div>
          <h1 id="history-title">History</h1>
          <p class="lead">What each market's HST files hold and what the app has saved. Times in {TIMES_IN[timeShown]}.</p>
        </div>
        {markets && markets.length > 0 && (
          <input
            class="input history-search"
            type="search"
            placeholder="Search symbol or broker server"
            aria-label="Search symbol or broker server"
            value={query}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
        )}
      </div>
      {error && (
        <div class="notice bad" role="alert">
          {error}
        </div>
      )}
      {!markets ? (
        !error && <p class="muted">Loading…</p>
      ) : markets.length === 0 ? (
        <div class="empty">
          <p>No history yet.</p>
          <p>Markets appear here once a terminal with the QuoteBridge EA connects, with the periods its HST files hold.</p>
        </div>
      ) : groups.length === 0 ? (
        <div class="empty">
          <p>No market matches “{query.trim()}”.</p>
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.key} class="feed-group" aria-labelledby={g.id}>
            <header class="group-head">
              <h2 id={g.id}>{g.symbol}</h2>
              <span class="tid">{g.where}</span>
              <span class="group-state">{g.state}</span>
            </header>
            {g.empty ? (
              <p class="history-empty muted">{g.empty}</p>
            ) : (
              <div class="table-scroll">
                <table class="history-table">
                  <thead>
                    <tr>
                      <th class="period-col">Period</th>
                      <th>In the HST file</th>
                      <th>Saved by the app</th>
                      <th class="download-col">
                        <span class="visually-hidden">Downloads</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.rows.map((row) => (
                      <tr key={row.period}>
                        <td class="period-col">{row.period}</td>
                        <SpanCell span={row.hst} />
                        <SpanCell span={row.saved} />
                        <td class="download-col">
                          <a class="button small quiet" href={row.csvUrl} download aria-label={`Download ${g.symbol} ${row.period} as CSV`}>
                            CSV
                          </a>
                          <a class="button small quiet" href={row.hstUrl} download aria-label={`Download ${g.symbol} ${row.period} as an HST file`}>
                            HST
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ))
      )}
    </section>
  );
}

/** Each part wraps as a whole, never inside a date. */
function SpanCell({ span }: { span: SpanText | null }) {
  if (!span) return <td class="muted">None</td>;
  return (
    <td>
      <span class="nowrap">{span.bars}</span> · <span class="nowrap">{span.range}</span>
    </td>
  );
}
