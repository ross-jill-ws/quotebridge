// The one order dialog for every trading action: a new order (its account chosen explicitly, never preselected), or a
// change, close or cancel of an existing trade (bound to its account and ticket). Preview first: the dialog shows what
// the app approved, its limits, warnings and expiry, and only the Send button executes that exact preview. Enter
// previews (again) and never sends. A change of the inputs, the account, its trading chart, the trading settings or the
// existing trade itself (in MetaTrader) discards the preview; a new quote does not. A new order shows its market's live Ask
// and Bid, as Feeds does.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { TimeShown } from "../../shared/settings-store.js";
import { ApiError, get, getAll, post, type Envelope } from "../api.js";
import { Price } from "../price.js";
import type { Live } from "../use-live.js";
import {
  actionBlock,
  currentTrade,
  describeIntent,
  enterKeyAction,
  marketQuote,
  newOrderForm,
  orderAccounts,
  previewKey,
  QUOTEBRIDGE_MAGIC,
  requestBody,
  requestStatus,
  secondsLeft,
  shownTime,
  TRADING_UNKNOWN,
  unresolvedByAccount,
  type AccountView,
  type ActionBlock,
  type DialogStage,
  type LossBy,
  type Market,
  type MarketQuote,
  type ModifyForm,
  type OrderForm,
  type PendingView,
  type PlaceForm,
  type PositionView,
  type PreviewView,
  type RequestView,
} from "./trading-model.js";
import type { TradingState } from "./use-trading.js";

type MarketView = { id: string; brokerServer: string; symbol: string; digits: number | null };

/** What the dialog is for. A chart's order fixes the market; the Trading page's lets the trader pick one on the account's broker. */
export type OrderTarget =
  | { kind: "place"; side: "buy" | "sell"; market?: Market }
  | { kind: "modify" | "close" | "cancel"; accountId: string; trade: PositionView | PendingView };

const LOSS_LABELS: Record<LossBy, string> = { amount: "Amount", balancePercent: "% of balance", points: "Points" };
const ACTION_TITLES = { modify: "Change", close: "Close", cancel: "Cancel" } as const;

/** An ISO time as a datetime-local input's value, in this PC's time zone. */
function localInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const isPending = (t: PositionView | PendingView): t is PendingView => "type" in t;

function initialForm(target: OrderTarget): OrderForm {
  if (target.kind === "place") return newOrderForm(target.side);
  if (target.kind !== "modify") return { kind: target.kind, accountId: target.accountId, ticket: target.trade.ticket };
  const t = target.trade;
  const fields = { price: isPending(t) ? t.price : "", stopLoss: t.stopLoss ?? "", takeProfit: t.takeProfit ?? "", expiry: isPending(t) ? localInput(t.expiry) : "" };
  return { kind: "modify", accountId: target.accountId, ticket: t.ticket, pending: isPending(t), original: fields, ...fields };
}

/**
 * The order dialog for `target`, over the trading state the page or chart already reads (accounts, settings and the
 * journal, so the dialog sees blocks and invalidations as they happen), and the live quotes. Times follow `timeShown`.
 */
export function OrderDialog(props: { target: OrderTarget; trading: TradingState; live: Live; timeShown: TimeShown; onClose: () => void }) {
  const { target, trading, live, timeShown, onClose } = props;
  const dialog = useRef<HTMLDialogElement>(null);
  const summary = useRef<HTMLDivElement>(null);
  const [form, setForm] = useState<OrderForm>(() => initialForm(target));
  const [stage, setStage] = useState<DialogStage>("editing");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{ view: PreviewView; key: string; receivedAt: number }>();
  const [sent, setSent] = useState<RequestView>();
  const [markets, setMarkets] = useState<MarketView[]>();
  const [now, setNow] = useState(Date.now());

  useEffect(() => dialog.current?.showModal(), []);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);

  const unresolved = useMemo(() => unresolvedByAccount(trading.requests), [trading.requests]);
  const settings = trading.settings ?? TRADING_UNKNOWN;
  const account = trading.accounts.find((a) => a.id === form.accountId);
  const place = form.kind === "place" ? form : undefined;
  const fixedMarket = target.kind === "place" ? target.market : undefined;
  const brokerServer = fixedMarket?.brokerServer ?? account?.brokerServer;
  const market: Market | undefined = fixedMarket ?? markets?.find((m) => place && m.id === place.marketId);
  // The server sends a snapshot only when something changes; the time keeps counting in between, as on Feeds.
  const snapshotTime = live.snapshot ? live.snapshot.time + Math.max(0, performance.now() - live.receivedAt) : 0;
  const quote = place && market ? marketQuote(live.snapshot?.feeds ?? [], market, place.side, live.status === "live" && !!live.snapshot, snapshotTime) : undefined;

  // The markets a new order may use: the account's own broker server's, exactly. Changing account resets the market.
  useEffect(() => {
    if (!place || !brokerServer) return setMarkets(undefined);
    let current = true;
    const query = new URLSearchParams({ brokerServer, ...(fixedMarket ? { symbol: fixedMarket.symbol } : {}) });
    getAll<MarketView>(`/api/v1/markets?${query}`).then(
      (list) => {
        if (!current) return;
        setMarkets(list);
        if (fixedMarket) setForm((f) => (f.kind === "place" ? { ...f, marketId: list[0]?.id ?? "" } : f));
      },
      (e: Error) => current && setError(e.message),
    );
    return () => void (current = false);
  }, [brokerServer, place === undefined]);

  // The accounts a new order may name: demo accounts (on the chart's broker server for a chart's order).
  const choices = orderAccounts(trading.accounts, settings, unresolved, fixedMarket?.brokerServer);

  const block: ActionBlock | undefined = account ? actionBlock(account, settings, unresolved) : undefined;
  const liveTrade = form.kind === "place" ? undefined : currentTrade(trading.positions, trading.orders, form.accountId, form.ticket);
  const key = account ? previewKey(form, account, settings, unresolved, liveTrade) : "";
  const left = preview ? secondsLeft(preview.view, preview.receivedAt, now) : 0;
  // A preview that no longer holds is discarded: changed inputs, account, chart, settings or trade, or expired.
  const stale = preview && (preview.key !== key || left === 0);
  useEffect(() => {
    if (stale && stage === "previewed") {
      setPreview(undefined);
      setStage("editing");
      setError(left === 0 ? "The preview expired. Preview again." : "Something changed since the preview. Preview again.");
    }
  }, [stale, stage]);

  const update = (change: Partial<PlaceForm> | Partial<ModifyForm>) => setForm((f) => ({ ...f, ...change }) as OrderForm);

  async function doPreview() {
    setError("");
    const built = requestBody(form);
    if ("error" in built) return setError(built.error);
    if (!account) return setError("Choose the account to trade on.");
    if (block) return setError(block.text);
    setBusy(true);
    try {
      const answer = await post<Envelope<PreviewView>>("/api/v1/requests/preview", built.body);
      setPreview({ view: answer.data, key, receivedAt: Date.now() });
      setStage("previewed");
      // Focus moves to the summary, not the Send button: a further Enter cannot send.
      setTimeout(() => summary.current?.focus(), 0);
    } catch (e) {
      setPreview(undefined);
      setStage("editing");
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function execute() {
    if (!preview || stale) return;
    setError("");
    setStage("executing");
    try {
      const answer = await post<Envelope<RequestView>>(`/api/v1/requests/${preview.view.requestId}/execute`, { confirm: true });
      setSent(answer.data);
      setStage("sent");
      trading.refresh();
    } catch (e) {
      // A refused execute sent nothing; a lost answer is found by its request ID, never by sending again.
      setPreview(undefined);
      setStage("editing");
      setError(e instanceof ApiError && e.status >= 500 && e.status !== 503 ? `${e.message} Nothing is resent: look the request up on the Trading page.` : e instanceof Error ? e.message : String(e));
    }
  }

  // After sending: follow the request until it has a definitive outcome (or becomes unknown).
  useEffect(() => {
    if (stage !== "sent" || !sent || sent.status !== "dispatching") return;
    const timer = setTimeout(() => {
      get<Envelope<RequestView>>(`/api/v1/requests/${sent.requestId}`).then((r) => setSent(r.data), () => {});
    }, 750);
    return () => clearTimeout(timer);
  }, [stage, sent]);

  const onSubmit = (e: Event) => {
    e.preventDefault();
    if (enterKeyAction(stage) === "preview" && !busy) void doPreview();
  };

  const trade = target.kind === "place" ? undefined : target.trade;
  const title = target.kind === "place" ? `New ${(place?.side ?? target.side) === "buy" ? "buy" : "sell"} order${fixedMarket ? ` · ${fixedMarket.symbol} · ${fixedMarket.brokerServer}` : ""}`
    : `${ACTION_TITLES[target.kind]} #${trade!.ticket} · ${trade!.symbol}`;
  const locked = stage === "executing" || stage === "sent";

  return (
    <dialog ref={dialog} class="order-dialog" onClose={onClose} aria-labelledby="order-title">
      <form onSubmit={onSubmit}>
        <header class="dialog-head">
          <h2 id="order-title">{title}</h2>
        </header>
        {!settings.enabled && (
          <div class="notice warn" role="status">
            Demo trading is off in the app window's Settings, so nothing can be sent. Switching it off never recalls a request already sent: for an emergency,
            act in MetaTrader.
          </div>
        )}

        <fieldset class="order-fields" disabled={locked}>
          {place ? (
            <>
              <label class="order-field wide">
                <span>Trading account</span>
                <select class="input" value={place.accountId ?? ""} onChange={(e) => update({ accountId: e.currentTarget.value || null, marketId: fixedMarket ? place.marketId : "" })}>
                  <option value="">Choose a trading account…</option>
                  {choices.options.map(({ account: a, block: b }) => (
                    <option key={a.id} value={a.id} disabled={!!b}>
                      {a.label}
                      {a.currency ? ` · ${a.currency}` : ""}
                      {b ? ` (${b.kind === "unresolved" ? "unresolved request" : b.kind === "off" ? "trading off" : b.kind === "offline" ? "offline" : "not ready"})` : ""}
                    </option>
                  ))}
                </select>
                {choices.note && <small class="muted">{choices.note}</small>}
              </label>
              <label class="order-field">
                <span>Market</span>
                {fixedMarket ? (
                  <output class="order-static">{fixedMarket.symbol}</output>
                ) : (
                  <select class="input" value={place.marketId} disabled={!account} onChange={(e) => update({ marketId: e.currentTarget.value })}>
                    <option value="">{account ? "Choose a symbol…" : "Account first"}</option>
                    {(markets ?? []).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.symbol}
                      </option>
                    ))}
                  </select>
                )}
              </label>
              <div class="order-field">
                <span>Side</span>
                <div class="segmented" role="radiogroup" aria-label="Side">
                  {(["buy", "sell"] as const).map((side) => (
                    <button key={side} type="button" role="radio" class="segment" aria-checked={place.side === side} onClick={() => update({ side })}>
                      {side === "buy" ? "Buy" : "Sell"}
                    </button>
                  ))}
                </div>
              </div>
              <div class="order-field">
                <span>Type</span>
                <div class="segmented" role="radiogroup" aria-label="Order type">
                  {(["market", "limit", "stop"] as const).map((type) => (
                    <button key={type} type="button" role="radio" class="segment" aria-checked={place.type === type} onClick={() => update({ type })}>
                      {type[0].toUpperCase() + type.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
              {quote && <QuoteView quote={quote} pendingOrder={place.type !== "market"} />}
              <label class="order-field">
                <span>Lots</span>
                <input class="input number" inputMode="decimal" value={place.lots} onInput={(e) => update({ lots: e.currentTarget.value })} />
              </label>
              {place.type !== "market" && (
                <>
                  <label class="order-field">
                    <span>Entry price</span>
                    <input class="input number" inputMode="decimal" value={place.price} onInput={(e) => update({ price: e.currentTarget.value })} />
                  </label>
                  <label class="order-field">
                    <span>Expiry, this computer's time (optional)</span>
                    <input class="input" type="datetime-local" value={place.expiry} onInput={(e) => update({ expiry: e.currentTarget.value })} />
                  </label>
                </>
              )}
              <div class="order-field wide">
                <span>Stops</span>
                <div class="segmented" role="radiogroup" aria-label="Stops">
                  <button type="button" role="radio" class="segment" aria-checked={place.stops === "prices"} onClick={() => update({ stops: "prices" })}>
                    Prices
                  </button>
                  <button type="button" role="radio" class="segment" aria-checked={place.stops === "risk"} onClick={() => update({ stops: "risk" })}>
                    Risk plan
                  </button>
                </div>
              </div>
              {place.stops === "prices" ? (
                <>
                  <label class="order-field">
                    <span>Stop loss (optional)</span>
                    <input class="input number" inputMode="decimal" value={place.stopLoss} onInput={(e) => update({ stopLoss: e.currentTarget.value })} />
                  </label>
                  <label class="order-field">
                    <span>Take profit (optional)</span>
                    <input class="input number" inputMode="decimal" value={place.takeProfit} onInput={(e) => update({ takeProfit: e.currentTarget.value })} />
                  </label>
                </>
              ) : (
                <>
                  <label class="order-field">
                    <span>Loss by</span>
                    <select class="input" value={place.lossBy} onChange={(e) => update({ lossBy: e.currentTarget.value as LossBy })}>
                      {(Object.keys(LOSS_LABELS) as LossBy[]).map((k) => (
                        <option key={k} value={k}>
                          {LOSS_LABELS[k]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label class="order-field">
                    <span>Loss{place.lossBy === "amount" && account?.currency ? ` (${account.currency})` : ""}</span>
                    <input class="input number" inputMode="decimal" value={place.loss} onInput={(e) => update({ loss: e.currentTarget.value })} />
                  </label>
                  <label class="order-field">
                    <span>Reward ratio</span>
                    <input class="input number" inputMode="decimal" value={place.rewardRatio} onInput={(e) => update({ rewardRatio: e.currentTarget.value })} />
                  </label>
                  <p class="order-hint wide">Stops are worked out from the lots, rounded toward the entry. A plan that cannot be met is refused, never widened.</p>
                </>
              )}
            </>
          ) : (
            <>
              <p class="order-bound wide">
                {account?.label ?? "Unknown account"} · ticket {trade!.ticket} · {trade!.side} {isPending(trade!) ? `${trade!.type} ` : ""}
                {trade!.lots} lots {trade!.symbol}
              </p>
              {trade!.magic !== QUOTEBRIDGE_MAGIC && <p class="order-hint wide">Placed outside QuoteBridge. The same checks apply.</p>}
              {form.kind === "modify" && (
                <>
                  {form.pending && (
                    <label class="order-field">
                      <span>Entry price</span>
                      <input class="input number" inputMode="decimal" value={form.price} onInput={(e) => update({ price: e.currentTarget.value })} />
                    </label>
                  )}
                  <label class="order-field">
                    <span>Stop loss</span>
                    <input class="input number" inputMode="decimal" value={form.stopLoss} placeholder="None" onInput={(e) => update({ stopLoss: e.currentTarget.value })} />
                  </label>
                  <label class="order-field">
                    <span>Take profit</span>
                    <input class="input number" inputMode="decimal" value={form.takeProfit} placeholder="None" onInput={(e) => update({ takeProfit: e.currentTarget.value })} />
                  </label>
                  {form.pending && (
                    <label class="order-field">
                      <span>Expiry, this computer's time</span>
                      <input class="input" type="datetime-local" value={form.expiry} onInput={(e) => update({ expiry: e.currentTarget.value })} />
                    </label>
                  )}
                  <p class="order-hint wide">{form.pending ? "Empty a stop or the expiry to remove it." : "Empty a stop to remove it."} Lots cannot be changed.</p>
                </>
              )}
            </>
          )}
        </fieldset>

        {account && block && stage === "editing" && (
          <div class="notice warn" role="status">
            {block.text}
          </div>
        )}
        {error && (
          <div class="notice bad" role="alert">
            {error}
          </div>
        )}

        {preview && !stale && stage !== "editing" && <PreviewSummary preview={preview.view} account={account} left={left} summaryRef={summary} sent={stage === "sent"} timeShown={timeShown} />}
        {sent && <SentStatus record={sent} />}

        <div class="confirm-actions order-actions">
          <button type="button" class="button" onClick={() => dialog.current?.close()}>
            {stage === "sent" ? "Close" : "Cancel"}
          </button>
          {stage !== "sent" && (
            <button type="submit" class={`button ${stage === "previewed" ? "" : "primary"}`} disabled={busy || locked || !trading.loaded}>
              {busy ? "Previewing…" : stage === "previewed" ? "Preview again" : "Preview"}
            </button>
          )}
          {stage === "previewed" && (
            <button type="button" class="button primary" onClick={() => void execute()} disabled={!!stale}>
              Send to MetaTrader
            </button>
          )}
          {stage === "executing" && (
            <button type="button" class="button primary" disabled>
              Sending…
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}

/** The market's live Bid and Ask, the side's price emphasised: a buy fills at Ask, a sell at Bid. Only a reference for limit and stop orders. */
function QuoteView({ quote, pendingOrder }: { quote: MarketQuote; pendingOrder: boolean }) {
  const cell = (side: "bid" | "ask") => (
    <div class={`order-quote-side${quote.emphasis === side ? " emphasis" : ""}`}>
      <span>{side === "bid" ? "Bid" : "Ask"}</span>
      <Price value={quote.quote?.[side]} digits={quote.quote?.digits ?? 0} />
    </div>
  );
  return (
    <div class="order-quote wide" role="group" aria-label={pendingOrder ? "Current price, for reference" : "Current price"} aria-live="off">
      {cell("bid")}
      {cell("ask")}
      <small class={quote.reason || quote.silence ? "caution-text" : "muted"}>
        {quote.reason ?? quote.silence ?? (pendingOrder ? "Current price, for reference." : `A ${quote.emphasis === "ask" ? "buy fills at Ask" : "sell fills at Bid"}, near this price.`)}
      </small>
    </div>
  );
}

/** What the preview approved, with its limits, estimates, warnings and the seconds it has left. */
function PreviewSummary(props: { preview: PreviewView; account?: AccountView; left: number; summaryRef: { current: HTMLDivElement | null }; sent: boolean; timeShown: TimeShown }) {
  const { preview, account, left, summaryRef, sent, timeShown } = props;
  const i = preview.normalizedIntent;
  const e = preview.estimates;
  return (
    <div class="order-preview" ref={summaryRef} tabIndex={-1} aria-label="Preview">
      <div class="order-preview-head">
        <strong>Preview</strong>
        {!sent && (
          <span class={left <= 5 ? "caution-text" : "muted"} aria-live="polite">
            Expires in {left} s
          </span>
        )}
      </div>
      <dl class="facts">
        <dt>Account</dt>
        <dd>{account?.label ?? preview.accountId}</dd>
        <dt>Order</dt>
        <dd>{describeIntent(i)}</dd>
        {i.price !== null && (
          <>
            <dt>{i.action === "close" ? "Exit price" : "Price"}</dt>
            <dd class="num">{i.price}</dd>
          </>
        )}
        <dt>Stop loss</dt>
        <dd class="num">{i.stopLoss ?? "None"}</dd>
        <dt>Take profit</dt>
        <dd class="num">{i.takeProfit ?? "None"}</dd>
        {i.expiry && (
          <>
            <dt>Expiry</dt>
            <dd>{shownTime(i.expiry, null, timeShown)}</dd>
          </>
        )}
        <dt>Slippage</dt>
        <dd>{i.slippage} points</dd>
        <dt>Lot limits</dt>
        <dd>
          Broker {preview.limits.broker} · EA {preview.limits.ea} · App {preview.limits.app}: new orders up to {preview.limits.maxLots} lots
        </dd>
        {(e.loss !== null || e.reward !== null) && (
          <>
            <dt>Estimate</dt>
            <dd>
              {e.loss !== null && `Loss at stop ${e.loss} ${e.currency ?? ""}`}
              {e.loss !== null && e.reward !== null && " · "}
              {e.reward !== null && `Reward at target ${e.reward} ${e.currency ?? ""}`}
            </dd>
          </>
        )}
        <dt>Terminal</dt>
        <dd class="mono">{preview.terminalId}</dd>
      </dl>
      {preview.warnings.length > 0 && (
        <ul class="order-warnings">
          {preview.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A sent request's status as it develops, and what to do when its outcome is unknown. */
function SentStatus({ record }: { record: RequestView }) {
  const status = requestStatus(record);
  return (
    <div class={`order-sent ${status.tone}`} role="status" aria-live="polite">
      <span class="dot" aria-hidden="true" />
      <div>
        <strong>{status.text}</strong>
        {record.result && ` · ${record.result.message}${record.result.ticket ? ` (ticket ${record.result.ticket})` : ""}${record.result.code ? `, code ${record.result.code}` : ""}`}
        {record.status === "dispatching" && <p>Sent to the account's trading chart. Waiting for MetaTrader's answer…</p>}
        {record.status === "unknown" && (
          <p>MetaTrader's answer did not arrive. Do not send it again: check MetaTrader's open orders and history, then review the request on the Trading page.</p>
        )}
        <p class="muted">Request {record.requestId}</p>
      </div>
    </div>
  );
}
