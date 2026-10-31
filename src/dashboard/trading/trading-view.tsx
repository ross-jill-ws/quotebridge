// The Trading view: every known trading account, grouped by broker server, each with its Funds, open positions,
// pending orders and setup checklist, and the request journal. There is no active account: New order asks which
// account, and each trade's actions are bound to its own account and ticket. The filter only changes what shows.
// Money is never added up across accounts: each account shows its own currency.
import { useMemo, useState } from "preact/hooks";
import type { TimeShown } from "../../shared/settings-store.js";
import { AccountKind } from "../account-kind.js";
import type { Live } from "../use-live.js";
import { OrderDialog, type OrderTarget } from "./order-dialog.js";
import { ReviewDialog } from "./review-dialog.js";
import {
  accountGroups,
  actionBlock,
  describeIntent,
  executorGuide,
  isReal,
  money,
  QUOTEBRIDGE_MAGIC,
  requestStatus,
  shownTime,
  TRADING_UNKNOWN,
  unresolvedBanners,
  unresolvedByAccount,
  type AccountFilter,
  type AccountView,
  type FundsView,
  type PendingView,
  type PositionView,
  type RequestView,
} from "./trading-model.js";
import { useTrading, type TradingState } from "./use-trading.js";

/** The journal shows this many of the newest requests until asked for all. */
const RECENT_REQUESTS = 20;

const EXECUTOR_TEXT: Record<AccountView["executor"]["state"], string> = {
  ready: "Trading chart ready",
  zero: "EA too old to trade",
  multiple: "Several trading charts",
  "not-ready": "Trading chart not ready",
  "real-account": "No EnableRealTrading chart",
};

/** The Trading view; times follow `timeShown`. */
export function TradingView({ live, timeShown }: { live: Live; timeShown: TimeShown }) {
  const trading = useTrading(true);
  const [filter, setFilter] = useState<AccountFilter>({ brokerServer: "all", accountId: "all" });
  const [dialog, setDialog] = useState<OrderTarget>();
  const [reviewing, setReviewing] = useState<RequestView>();
  const [allRequests, setAllRequests] = useState(false);
  const unresolved = useMemo(() => unresolvedByAccount(trading.requests), [trading.requests]);
  const groups = accountGroups(trading.accounts, filter);
  const brokers = [...new Set(trading.accounts.map((a) => a.brokerServer))].sort();
  const settings = trading.settings;
  const banners = unresolvedBanners(trading.accounts, unresolved);
  const accountOf = (id: string) => trading.accounts.find((a) => a.id === id);

  const shownIds = new Set(groups.flatMap((g) => g.accounts.map((a) => a.id)));
  const listed = new Set(trading.accounts.map((a) => a.id));
  // A request of an account the list does not have (yet) shows whatever the filter; the newest first.
  const journal = trading.requests.filter((r) => shownIds.has(r.accountId) || !listed.has(r.accountId)).reverse();
  const shownRequests = allRequests ? journal : journal.slice(0, RECENT_REQUESTS);
  const showRequest = (id: string) => {
    setAllRequests(true);
    setTimeout(() => document.getElementById(`request-${id}`)?.scrollIntoView({ block: "center" }), 0);
  };

  return (
    <section class="view trading" aria-labelledby="trading-title">
      <div class="view-heading">
        <h1 id="trading-title">Trading</h1>
        <div class="heading-actions">
          <button class="button primary" onClick={() => setDialog({ kind: "place", side: "buy" })} disabled={!trading.loaded}>
            New order…
          </button>
        </div>
      </div>
      <p class="lead">{summary(trading)}</p>
      {trading.error && (
        <div class="notice bad" role="alert">
          {trading.error}
        </div>
      )}
      {settings?.realAccounts && (
        <div class="notice warn real-money" role="status">
          <span>
            <strong>Real-account trading is on.</strong> Orders on real accounts use real money. Switch it off in Settings › Trading to make every real account
            read-only again; that never recalls a request already sent.
          </span>
        </div>
      )}
      {settings && !settings.enabled && !settings.realAccounts && (
        <div class="notice warn" role="status">
          <span>
            <strong>Demo trading is off.</strong> Nothing can be previewed or sent{trading.manage ? "; switch it on in Settings › Trading" : "; only the app window can switch it on"}. Switching it off never
            recalls a request already sent: for an emergency, close or cancel in MetaTrader. Requests already sent are still followed and can be reviewed.
          </span>
        </div>
      )}
      {banners.map(({ label, request }) => (
        <div key={request.requestId} class="notice warn" role="alert">
          <span>
            <strong>{label}:</strong> {request.status === "dispatching" ? "a request is waiting for MetaTrader's answer." : "a request's outcome is unknown."} New requests on this
            account wait until it is settled or reviewed; other accounts are not affected.
          </span>
          <button class="link" onClick={() => showRequest(request.requestId)}>
            Show request
          </button>
        </div>
      ))}

      {trading.accounts.length > 0 && (
        <div class="trading-filters" role="group" aria-label="Show">
          <label>
            <span>Broker server</span>
            <select class="input" value={filter.brokerServer} onChange={(e) => setFilter({ brokerServer: e.currentTarget.value, accountId: "all" })}>
              <option value="all">All</option>
              {brokers.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Trading account</span>
            <select class="input" value={filter.accountId} onChange={(e) => setFilter({ ...filter, accountId: e.currentTarget.value })}>
              <option value="all">All</option>
              {trading.accounts
                .filter((a) => filter.brokerServer === "all" || a.brokerServer === filter.brokerServer)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
            </select>
          </label>
          <span class="muted">Only changes what shows: every order names its own trading account.</span>
        </div>
      )}

      {trading.loaded && !trading.accounts.length && !trading.error && (
        <div class="empty">
          <p>
            <strong>No trading account yet.</strong> Accounts appear here once a chart with the QuoteBridge EA (1.12 or later) is connected.
          </p>
        </div>
      )}

      {groups.map((group) => (
        <section key={group.brokerServer} class="broker-group" aria-label={group.brokerServer}>
          <h2 class="section-title">{group.brokerServer}</h2>
          {group.accounts.map((account) => (
            <AccountPanel
              key={account.id}
              account={account}
              trading={trading}
              funds={trading.funds.get(account.id)}
              positions={trading.positions.get(account.id) ?? []}
              orders={trading.orders.get(account.id) ?? []}
              readError={trading.readErrors.get(account.id)}
              unresolved={unresolved}
              timeShown={timeShown}
              onAction={setDialog}
              onShowRequest={showRequest}
            />
          ))}
        </section>
      ))}

      {journal.length > 0 && (
        <section class="broker-group" aria-labelledby="requests-title">
          <h2 id="requests-title" class="section-title">
            Requests
          </h2>
          <div class="table-scroll">
            <table class="trades">
              <thead>
                <tr>
                  <th>Sent</th>
                  <th>Account</th>
                  <th>Request</th>
                  <th>Status</th>
                  <th>Result</th>
                  <th>
                    <span class="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shownRequests.map((r) => {
                  const status = requestStatus(r);
                  const i = r.normalizedIntent;
                  return (
                    <tr key={r.requestId} id={`request-${r.requestId}`}>
                      <td title={r.requestId}>{shownTime(r.createdAt, null, timeShown)}</td>
                      <td>{accountOf(r.accountId)?.label ?? r.accountId}</td>
                      <td>
                        {describeIntent(i)}
                        <span class="muted"> · {r.origin}</span>
                      </td>
                      <td>
                        <span class={`flag ${status.tone === "warn" ? "caution" : status.tone === "bad" ? "fault" : "plain"}`}>{status.text}</span>
                      </td>
                      <td>{r.result ? `${r.result.message}${r.result.ticket ? ` · #${r.result.ticket}` : ""}${r.result.code ? ` · code ${r.result.code}` : ""}` : r.status === "dispatching" ? "Waiting for MetaTrader" : "No answer"}</td>
                      <td class="actions">
                        {r.status === "unknown" && !r.reviewed && (
                          <button class="button small" onClick={() => setReviewing(r)}>
                            Review…
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!allRequests && journal.length > RECENT_REQUESTS && (
            <button class="button quiet" onClick={() => setAllRequests(true)}>
              Show all {journal.length} requests
            </button>
          )}
        </section>
      )}

      {dialog && <OrderDialog target={dialog} trading={trading} live={live} timeShown={timeShown} onClose={() => setDialog(undefined)} />}
      {reviewing && <ReviewDialog record={reviewing} account={accountOf(reviewing.accountId)} timeShown={timeShown} onClose={() => setReviewing(undefined)} onReviewed={trading.refresh} />}
    </section>
  );
}

function summary(t: TradingState): string {
  if (!t.loaded) return "Loading…";
  const brokers = new Set(t.accounts.map((a) => a.brokerServer)).size;
  const connected = t.accounts.filter((a) => a.connected).length;
  const accounts = `${t.accounts.length} trading account${t.accounts.length === 1 ? "" : "s"} on ${brokers} broker server${brokers === 1 ? "" : "s"}, ${connected} connected.`;
  return `${accounts} ${t.settings?.enabled ? "Demo trading is on." : "Demo trading is off."}${t.settings?.realAccounts ? " Real-account trading is on." : ""}`;
}

type PanelProps = {
  account: AccountView;
  trading: TradingState;
  funds?: FundsView;
  positions: PositionView[];
  orders: PendingView[];
  readError?: string;
  unresolved: ReadonlyMap<string, RequestView>;
  timeShown: TimeShown;
  onAction: (target: OrderTarget) => void;
  onShowRequest: (requestId: string) => void;
};

/** One account: its state, Funds, positions, pending orders and setup checklist; every action bound to it. */
function AccountPanel({ account, trading, funds, positions, orders, readError, unresolved, timeShown, onAction, onShowRequest }: PanelProps) {
  const settings = trading.settings ?? TRADING_UNKNOWN;
  const block = actionBlock(account, settings, unresolved);
  const real = block?.kind === "real";
  const guide = executorGuide(account, settings);
  const currency = funds?.currency ?? account.currency ?? "";
  const action = (kind: "modify" | "close" | "cancel", trade: PositionView | PendingView, label: string) => (
    <button class="button small quiet" disabled={!!block} title={block?.text} aria-label={`${label} ticket ${trade.ticket} on ${account.label}`} onClick={() => onAction({ kind, accountId: account.id, trade })}>
      {label}…
    </button>
  );
  const state = !account.connected ? "Offline" : funds?.state === "stale" ? "Stale" : "Connected";

  return (
    <article class="account" aria-label={account.label}>
      <header class="account-head">
        <h3>{account.label}</h3>
        <AccountKind demo={account.demo} showUnknown />
        {currency && <span class="chip">{currency}</span>}
        <span class={`group-state ${account.connected ? "" : "muted"}`}>
          <span class={`dot ${account.connected && funds?.state !== "stale" ? "good" : "off"}`} aria-hidden="true" />
          {state}
          {funds?.receivedAt && ` · read ${shownTime(funds.receivedAt, null, timeShown)}`}
        </span>
        <span class={`account-executor ${account.executor.state === "ready" ? "" : "caution-text"}`}>{EXECUTOR_TEXT[account.executor.state]}</span>
      </header>
      {readError && <div class="notice warn">Could not read this account just now: {readError}</div>}
      {real && <p class="account-note">Real accounts are read-only while Real-account trading is off: their Funds and trades show here, but every change is made in MetaTrader.</p>}
      {block?.kind === "unresolved" && (
        <div class="notice warn">
          <span>{block.text}</span>
          <button class="link" onClick={() => onShowRequest(block.requestId!)}>
            Show request
          </button>
        </div>
      )}

      <dl class="funds">
        <div>
          <dt>Balance</dt>
          <dd>{money(funds?.balance, currency)}</dd>
        </div>
        <div>
          <dt>Equity</dt>
          <dd>{money(funds?.equity, currency)}</dd>
        </div>
        <div>
          <dt>Margin</dt>
          <dd>{money(funds?.margin, currency)}</dd>
        </div>
        <div>
          <dt>Free margin</dt>
          <dd>{money(funds?.freeMargin, currency)}</dd>
        </div>
        <div>
          <dt>Margin level</dt>
          <dd>{funds?.marginLevel ? `${Number(funds.marginLevel).toFixed(2)}%` : "—"}</dd>
        </div>
        <div>
          <dt>Profit</dt>
          <dd class={profitClass(funds?.profit)}>{money(funds?.profit, currency)}</dd>
        </div>
        <div>
          <dt>Leverage</dt>
          <dd>{funds?.leverage ? `1:${funds.leverage}` : "—"}</dd>
        </div>
      </dl>

      <h4 class="trades-title">Positions</h4>
      {positions.length ? (
        <div class="table-scroll">
          <table class="trades">
            <thead>
              <tr>
                <th>Ticket</th>
                <th>Symbol</th>
                <th>Side</th>
                <th class="num">Lots</th>
                <th class="num">Open</th>
                <th class="num">Current</th>
                <th class="num">Stop loss</th>
                <th class="num">Take profit</th>
                <th class="num">Profit ({currency})</th>
                <th>
                  <span class="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => (
                <tr key={p.ticket}>
                  <td>
                    {p.ticket}
                    {p.magic !== QUOTEBRIDGE_MAGIC && (
                      <span class="flag plain" title="Placed outside QuoteBridge">
                        Outside
                      </span>
                    )}
                  </td>
                  <td>{p.symbol}</td>
                  <td>{p.side}</td>
                  <td class="num">{p.lots}</td>
                  <td class="num">{p.openPrice}</td>
                  <td class="num">{p.currentPrice ?? "—"}</td>
                  <td class="num">{p.stopLoss ?? "—"}</td>
                  <td class="num">{p.takeProfit ?? "—"}</td>
                  <td class={`num ${profitClass(p.profit)}`}>{money(p.profit, null)}</td>
                  <td class="actions">
                    {!real && (
                      <>
                        {action("modify", p, "Change")}
                        {action("close", p, "Close")}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p class="muted trades-empty">{funds || account.connected ? "No open positions." : "Not known while the account is offline."}</p>
      )}

      <h4 class="trades-title">Pending orders</h4>
      {orders.length ? (
        <div class="table-scroll">
          <table class="trades">
            <thead>
              <tr>
                <th>Ticket</th>
                <th>Symbol</th>
                <th>Type</th>
                <th class="num">Lots</th>
                <th class="num">Entry</th>
                <th class="num">Current</th>
                <th class="num">Stop loss</th>
                <th class="num">Take profit</th>
                <th>Expiry</th>
                <th>
                  <span class="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.ticket}>
                  <td>
                    {o.ticket}
                    {o.magic !== QUOTEBRIDGE_MAGIC && (
                      <span class="flag plain" title="Placed outside QuoteBridge">
                        Outside
                      </span>
                    )}
                  </td>
                  <td>{o.symbol}</td>
                  <td>
                    {o.side} {o.type}
                  </td>
                  <td class="num">{o.lots}</td>
                  <td class="num">{o.price}</td>
                  <td class="num">{o.currentPrice ?? "—"}</td>
                  <td class="num">{o.stopLoss ?? "—"}</td>
                  <td class="num">{o.takeProfit ?? "—"}</td>
                  <td>{o.expiry ? shownTime(o.expiry, o.expiryBrokerTime, timeShown) : "None"}</td>
                  <td class="actions">
                    {!real && (
                      <>
                        {action("modify", o, "Change")}
                        {action("cancel", o, "Cancel")}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p class="muted trades-empty">{funds || account.connected ? "No pending orders." : "Not known while the account is offline."}</p>
      )}

      {!real && (
        <details class="account-setup" open={guide.state !== "ready"}>
          <summary>
            Set up trading · <span class={guide.state === "ready" ? "" : "caution-text"}>{guide.title}</span>
          </summary>
          <ol class="setup-checklist">
            {guide.steps.map((step) => (
              <li key={step.text} class={step.done ? "done" : ""}>
                <span class={`dot ${step.done ? "good" : "off"}`} aria-hidden="true" />
                <span>
                  {step.text}
                  <span class="visually-hidden">{step.done ? " (done)" : " (to do)"}</span>
                </span>
              </li>
            ))}
          </ol>
          <p class="muted">{guide.caps}</p>
        </details>
      )}
    </article>
  );
}

const profitClass = (value: string | null | undefined) => (!value || Number(value) === 0 ? "" : Number(value) > 0 ? "up-text" : "down-text");
