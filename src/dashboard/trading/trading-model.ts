// The trading model for the Trading page, the order dialogs and the charts' trade lines. Pure: the views fetch REST v1
// (`/api/v1`, with the window session) and render what these functions answer. There is no active account: every
// action carries its own account, and filters only change what is shown.
import type { SettingsView } from "../../server/settings/index.js";
import type { TimeShown } from "../../shared/settings-store.js";
import { browserOffsetMinutes } from "../display-clock.js";
import { minuteStamp } from "../format.js";

export type ExecutorState = "ready" | "zero" | "multiple" | "not-ready" | "real-account";
/** An account as `GET /api/v1/accounts` lists it. */
export type AccountView = {
  id: string;
  brokerServer: string;
  login: string;
  label: string;
  demo: boolean | null;
  connected: boolean;
  state: "fresh" | "stale" | "unavailable";
  currency: string | null;
  executor: { state: ExecutorState; terminalId: string | null };
  sources: { terminalId: string; connected: boolean; executorEnabled: boolean; ready: boolean; maxLots: string | null }[];
};
export type FundsView = {
  accountId: string; currency: string | null; balance: string | null; equity: string | null; margin: string | null; freeMargin: string | null;
  marginLevel: string | null; profit: string | null; leverage: number | null; state: "fresh" | "stale" | "unavailable"; capturedAt: string | null;
  receivedAt: string | null; terminalId: string | null;
};
type TradeCommon = { ticket: string; accountId: string; marketId: string; symbol: string; side: "buy" | "sell"; lots: string; stopLoss: string | null; takeProfit: string | null; magic: number; currentPrice: string | null };
export type PositionView = TradeCommon & { openPrice: string; openTime: string; openBrokerTime: string | null; profit: string; swap: string; commission: string };
export type PendingView = TradeCommon & { type: "limit" | "stop"; price: string; placedAt: string; placedBrokerTime: string | null; expiry: string | null; expiryBrokerTime: string | null };
export type Intent = {
  action: "place" | "modify" | "close" | "cancel"; ticket: string | null; symbol: string; side: "buy" | "sell"; type: "market" | "limit" | "stop";
  lots: string; price: string | null; stopLoss: string | null; takeProfit: string | null; expiry: string | null; slippage: number;
};
export type Approval = {
  requestId: string; createdAt: string; accountId: string; marketId: string; terminalId: string; normalizedIntent: Intent;
  target: { ticket: string; symbol: string; side: "buy" | "sell"; type: "market" | "limit" | "stop"; lots: string; openPrice: string; stopLoss: string | null; takeProfit: string | null; expiry: string | null } | null;
  limits: { broker: string; ea: string; app: string; maxLots: string };
  estimates: { loss: string | null; reward: string | null; currency: string | null };
  warnings: string[];
};
export type PreviewView = Approval & { status: "preview"; expiresAt: string };
export type TradeResult = { status: string; ticket: string | null; code: number; message: string };
export type RequestView = Approval & {
  status: "dispatching" | "succeeded" | "failed" | "unknown";
  reviewed: boolean;
  origin: string;
  updatedAt: string;
  result: TradeResult | null;
  events: ({ type: "result"; at: string; result: TradeResult } | { type: "unknown"; at: string; reason: string } | { type: "review"; at: string; note: string })[];
};
/** The app window's trading settings (Settings › Trading). */
export type TradingSettings = SettingsView["trading"];
/** Until the settings are read: trading off, so nothing can be previewed. */
export const TRADING_UNKNOWN: TradingSettings = { enabled: false, maxLots: "", slippage: 0 };

/** QuoteBridge's EA stamps this magic number on the trades it places; any other trade was placed outside QuoteBridge. */
export const QUOTEBRIDGE_MAGIC = 27012026;

export type Market = { brokerServer: string; symbol: string };
export type LineKind = "entry" | "pending" | "stop-loss" | "take-profit";
export type ChartLine = { accountId: string; ticket: string; kind: LineKind; price: number; label: string };

/**
 * The read-only trade lines a chart of `market` shows: every account's positions and pending orders on exactly that
 * broker server and symbol (never another broker's, whatever the symbol), less the accounts the trader hid.
 */
export function chartLines(market: Market, accounts: AccountView[], trades: { positions: PositionView[]; orders: PendingView[] }, hidden: ReadonlySet<string>): ChartLine[] {
  const onMarket = new Map(accounts.filter((a) => a.brokerServer === market.brokerServer && !hidden.has(a.id)).map((a) => [a.id, a]));
  const lines: ChartLine[] = [];
  const add = (t: TradeCommon, kind: "entry" | "pending", price: string, what: string) => {
    const account = onMarket.get(t.accountId);
    if (!account || t.symbol !== market.symbol) return;
    const name = `${account.login} #${t.ticket}`;
    lines.push({ accountId: t.accountId, ticket: t.ticket, kind, price: Number(price), label: `${name} ${what} ${t.lots}` });
    if (t.stopLoss !== null) lines.push({ accountId: t.accountId, ticket: t.ticket, kind: "stop-loss", price: Number(t.stopLoss), label: `${name} SL` });
    if (t.takeProfit !== null) lines.push({ accountId: t.accountId, ticket: t.ticket, kind: "take-profit", price: Number(t.takeProfit), label: `${name} TP` });
  };
  for (const p of trades.positions) add(p, "entry", p.openPrice, p.side);
  for (const o of trades.orders) add(o, "pending", o.price, `${o.side} ${o.type}`);
  return lines;
}

/** Whether a journal record still blocks its account: dispatching, or unknown and not yet reviewed (as the engine decides). */
export const isUnresolved = (r: Pick<RequestView, "status" | "reviewed">) => r.status === "dispatching" || (r.status === "unknown" && !r.reviewed);

/** Each account's request without a definitive result. At most one per account can exist; the newest wins if not. */
export function unresolvedByAccount(requests: RequestView[]): Map<string, RequestView> {
  return new Map(requests.filter(isUnresolved).map((r) => [r.accountId, r]));
}

/** A real account (or one whose terminal says so): readable, never traded by QuoteBridge. */
export const isReal = (a: AccountView) => a.demo === false || a.executor.state === "real-account";

/** The account's trading chart (its executor) among its sources, if it has one. */
const executorSource = (a: AccountView) => a.sources.find((s) => s.terminalId === a.executor.terminalId);

export type ActionBlock = { kind: "real" | "unknown-demo" | "off" | "offline" | "executor" | "unresolved"; text: string; requestId?: string };

const EXECUTOR_BLOCKS: Record<Exclude<ExecutorState, "ready" | "real-account">, string> = {
  zero: "No chart of this account has demo trading enabled. See Set up trading below.",
  multiple: "More than one chart of this account has demo trading enabled. Leave it on in exactly one.",
  "not-ready": "The account's trading chart is not ready: check AutoTrading and the EA's permissions in MetaTrader.",
};

/**
 * Why an account cannot preview a trade now, or undefined when it can. Each account stands alone: another account's
 * unresolved request or offline terminal never blocks this one.
 */
export function actionBlock(account: AccountView, settings: TradingSettings, unresolved: ReadonlyMap<string, RequestView>): ActionBlock | undefined {
  if (isReal(account)) return { kind: "real", text: "Real accounts are read-only in QuoteBridge. Trade them in MetaTrader." };
  if (account.demo !== true) return { kind: "unknown-demo", text: "It is not known yet whether this is a demo account: its terminal has not reported it." };
  if (!settings.enabled) return { kind: "off", text: "Demo trading is off. Switch it on in the app window's Settings › Trading." };
  if (!account.connected) return { kind: "offline", text: "This account's terminal is offline." };
  const executor = account.executor.state;
  if (executor !== "ready" && executor !== "real-account") return { kind: "executor", text: EXECUTOR_BLOCKS[executor] };
  const open = unresolved.get(account.id);
  if (open) return { kind: "unresolved", text: "This account has a request without a definitive result. Check it before sending another.", requestId: open.requestId };
  return undefined;
}

/**
 * The accounts a new order may name, each with what blocks it now: demo accounts only, and for a chart's Buy or Sell
 * (`brokerServer` given) only those on the chart's own broker server; a symbol of the same name at another broker is
 * another market. `note` explains an empty list and the real accounts left out.
 */
export function orderAccounts(accounts: AccountView[], settings: TradingSettings, unresolved: ReadonlyMap<string, RequestView>, brokerServer?: string) {
  const here = accounts.filter((a) => brokerServer === undefined || a.brokerServer === brokerServer);
  const demo = here.filter((a) => a.demo === true && !isReal(a));
  const real = here.filter(isReal).length;
  const where = brokerServer ? ` on ${brokerServer}` : "";
  const notes = [!demo.length && `No demo account${where} can trade here.`, real > 0 && `Real accounts${where} are read-only in QuoteBridge (${real}).`].filter(Boolean);
  return { options: demo.map((account) => ({ account, block: actionBlock(account, settings, unresolved) })), note: notes.length ? notes.join(" ") : undefined };
}

export type LossBy = "amount" | "balancePercent" | "points";
/** A new order as the dialog holds it; text fields as typed. `accountId` is null until the trader chooses one. */
export type PlaceForm = {
  kind: "place"; accountId: string | null; marketId: string; side: "buy" | "sell"; type: "market" | "limit" | "stop"; lots: string;
  /** Entry of a limit or stop; `expiry` is the local date and time the input gives (YYYY-MM-DDTHH:MM), or empty. */
  price: string; expiry: string;
  stops: "prices" | "risk"; stopLoss: string; takeProfit: string; lossBy: LossBy; loss: string; rewardRatio: string;
};
type ModifyFields = { price: string; stopLoss: string; takeProfit: string; expiry: string };
/** A change to an existing trade, bound to its account and ticket; `original` is the trade as the dialog opened it. */
export type ModifyForm = { kind: "modify"; accountId: string; ticket: string; pending: boolean; original: ModifyFields } & ModifyFields;
export type OrderForm = PlaceForm | ModifyForm | { kind: "close" | "cancel"; accountId: string; ticket: string };

/** A new order's form as the dialog opens: no account chosen, even when only one could be; the trader picks it. */
export function newOrderForm(side: "buy" | "sell", marketId = ""): PlaceForm {
  return { kind: "place", accountId: null, marketId, side, type: "market", lots: "", price: "", expiry: "", stops: "prices", stopLoss: "", takeProfit: "", lossBy: "amount", loss: "", rewardRatio: "" };
}

/** A local date and time from a datetime-local input, as the API's UTC time in whole seconds. */
const utc = (local: string) => new Date(local).toISOString().replace(/\.\d{3}Z$/, "Z");

/** The `POST /api/v1/requests/preview` body for a form, or what is missing. */
export function requestBody(form: OrderForm): { body: Record<string, unknown> } | { error: string } {
  if (form.kind === "modify") {
    const body: Record<string, unknown> = { accountId: form.accountId, action: "modify", ticket: form.ticket };
    const fields = form.pending ? (["price", "stopLoss", "takeProfit", "expiry"] as const) : (["stopLoss", "takeProfit"] as const);
    for (const field of fields) {
      const value = form[field].trim();
      if (value === form.original[field].trim()) continue;
      if (field === "price" && !value) return { error: "A pending order keeps an entry price." };
      body[field] = !value ? null : field === "expiry" ? utc(value) : value;
    }
    return Object.keys(body).length > 3 ? { body } : { error: "Change a value first." };
  }
  if (form.kind !== "place") return { body: { accountId: form.accountId, action: form.kind, ticket: form.ticket } };
  if (!form.accountId) return { error: "Choose the account to trade on." };
  const lots = form.lots.trim();
  if (!form.marketId) return { error: "Choose the symbol." };
  if (!lots) return { error: "Enter the lots." };
  const body: Record<string, unknown> = { accountId: form.accountId, action: "place", marketId: form.marketId, side: form.side, type: form.type, lots };
  if (form.type !== "market") {
    if (!form.price.trim()) return { error: `A ${form.type} order needs its price.` };
    body.price = form.price.trim();
    if (form.expiry) body.expiry = utc(form.expiry);
  }
  if (form.stops === "risk") {
    if (!form.loss.trim() || !form.rewardRatio.trim()) return { error: "Enter the loss and the reward ratio of the risk plan." };
    body.risk = { loss: { [form.lossBy]: form.loss.trim() }, rewardRatio: form.rewardRatio.trim() };
  } else {
    if (form.stopLoss.trim()) body.stopLoss = form.stopLoss.trim();
    if (form.takeProfit.trim()) body.takeProfit = form.takeProfit.trim();
  }
  return { body };
}

/**
 * What a preview was made for: the inputs, the account (connected, its trading chart and EA cap, and whether a request
 * of its own is unresolved) and the trading settings. The dialog discards a preview once this changes; the server
 * would refuse its execute anyway.
 */
export function previewKey(form: OrderForm, account: AccountView, settings: TradingSettings, unresolved: ReadonlyMap<string, RequestView>): string {
  return JSON.stringify([form, account.id, account.connected, account.executor, executorSource(account)?.maxLots ?? null, unresolved.get(account.id)?.requestId ?? null,
    settings.enabled, settings.maxLots, settings.slippage]);
}

/** Seconds left of a preview's 30, counted on this PC's clock from when its answer arrived (`receivedAt`, ms). */
export function secondsLeft(preview: Pick<PreviewView, "createdAt" | "expiresAt">, receivedAt: number, now: number): number {
  const lifetime = Date.parse(preview.expiresAt) - Date.parse(preview.createdAt);
  return Math.max(0, Math.ceil((lifetime - (now - receivedAt)) / 1000));
}

export type DialogStage = "editing" | "previewed" | "executing" | "sent";
/**
 * Enter in the order dialog (the form's submit) asks for a preview, or a fresh one; it never executes. Execute is its
 * own button, which must be pressed for that preview.
 */
export function enterKeyAction(stage: DialogStage): "preview" | "none" {
  return stage === "editing" || stage === "previewed" ? "preview" : "none";
}

export type GuideState = "ready" | "zero" | "not-ready" | "multiple" | "real" | "offline";
const GUIDE_TITLES: Record<GuideState, string> = {
  ready: "Ready to trade on demo.",
  zero: "No chart has demo trading enabled.",
  "not-ready": "The trading chart is not ready.",
  multiple: "More than one chart has demo trading enabled.",
  real: "Real account: read-only.",
  offline: "No chart of this account is connected.",
};

/**
 * Set up trading for one account, as a checklist: exactly one chart of the account trades (the executor). The steps
 * are the trader's to do in MetaTrader; QuoteBridge only detects them, and never edits MetaTrader's settings.
 */
export function executorGuide(account: AccountView, settings: TradingSettings) {
  const connected = account.sources.filter((s) => s.connected);
  const enabled = connected.filter((s) => s.executorEnabled);
  const executor = account.executor.state;
  const state: GuideState = isReal(account) ? "real" : !connected.length ? "offline" : executor === "real-account" ? "real" : executor;
  const steps = [
    { done: connected.length > 0, text: "Open a chart of this account with the QuoteBridge EA running." },
    { done: enabled.length === 1, text: "In exactly one of its charts, set the EA's input EnableDemoTrading to true (F7 › Inputs). Leave it false in the others." },
    { done: executor === "ready", text: "Switch on AutoTrading in MetaTrader, and allow live trading in that EA's Common tab." },
    { done: settings.enabled, text: "Switch on Demo trading in the app window's Settings › Trading." },
  ];
  const ea = (executorSource(account) ?? enabled[0] ?? account.sources[0])?.maxLots ?? null;
  const caps = (ea === null
    ? "The EA does not report its lot cap (MaxDemoOrderLots): upgrade the EA before trading."
    : `New orders are capped at the smallest of the broker's maximum, the EA's cap (${ea} lots) and the app's cap (${settings.maxLots} lots).`)
    + " QuoteBridge never changes the EA's inputs or MetaTrader's settings: those changes are yours.";
  return { state, title: GUIDE_TITLES[state], steps, caps };
}

/** A journal record's status for people. A review acknowledges an unknown outcome; it does not settle it. */
export function requestStatus(r: Pick<RequestView, "status" | "reviewed">): { text: string; tone: "good" | "bad" | "warn" | "neutral" } {
  if (r.status === "succeeded") return { text: "Succeeded", tone: "good" };
  if (r.status === "failed") return { text: "Failed", tone: "bad" };
  if (r.status === "dispatching") return { text: "Sending", tone: "neutral" };
  return r.reviewed ? { text: "Reviewed (outcome unknown)", tone: "neutral" } : { text: "Unknown", tone: "warn" };
}

/** What stops a review being sent, or undefined. The server checks the same. */
export function reviewError(note: string, acknowledged: boolean): string | undefined {
  if (!acknowledged) return "Confirm that you checked MetaTrader's open orders and account history.";
  const length = note.trim().length;
  if (length < 8) return "Write a note of at least 8 characters: what you found in MetaTrader.";
  if (length > 500) return "Keep the note to 500 characters.";
  return undefined;
}

/** The Trading page's filter: which accounts it shows. It never chooses where a trade goes. */
export type AccountFilter = { brokerServer: string | "all"; accountId: string | "all" };

/** The shown accounts, grouped by broker server, both in a stable order. */
export function accountGroups(accounts: AccountView[], filter: AccountFilter): { brokerServer: string; accounts: AccountView[] }[] {
  const shown = accounts
    .filter((a) => (filter.brokerServer === "all" || a.brokerServer === filter.brokerServer) && (filter.accountId === "all" || a.id === filter.accountId))
    .sort((a, b) => compare(a.brokerServer, b.brokerServer) || compare(a.login, b.login) || compare(a.id, b.id));
  const groups = new Map<string, AccountView[]>();
  for (const a of shown) groups.set(a.brokerServer, [...(groups.get(a.brokerServer) ?? []), a]);
  return [...groups].map(([brokerServer, list]) => ({ brokerServer, accounts: list }));
}

/**
 * A banner for every account blocked by an unresolved request, whatever the filter shows, and even for an account the
 * account list does not have (named by the start of its ID).
 */
export function unresolvedBanners(accounts: AccountView[], unresolved: ReadonlyMap<string, RequestView>) {
  return [...unresolved.values()].map((request) => ({
    accountId: request.accountId,
    label: accounts.find((a) => a.id === request.accountId)?.label ?? `Account ${request.accountId.slice(0, 8)}…`,
    request,
  }));
}

/** An intent in a few words, the same in the preview, the journal and the review: "Buy at market 0.1 lots EURUSD". */
export function describeIntent(i: Intent): string {
  const what = i.action === "place" ? `${i.side} ${i.type === "market" ? "at market" : i.type} ${i.lots} lots ${i.symbol}` : `${i.action} #${i.ticket} ${i.symbol}`;
  return what[0].toUpperCase() + what.slice(1);
}

/**
 * A time as the Time shown setting has it (ADR 11), to the minute: the broker server's wall clock where MetaTrader
 * stamped one (`brokerTime`), else UTC marked as such; this computer's clock; or UTC. A dash when there is none.
 */
export function shownTime(utc: string | null, brokerTime: string | null, shown: TimeShown): string {
  if (!utc) return "—";
  const ms = Date.parse(utc);
  if (shown === "broker") return brokerTime ? minuteStamp(Date.parse(`${brokerTime}Z`) / 1000) : `${minuteStamp(ms / 1000)} UTC`;
  return minuteStamp(ms / 1000 + (shown === "local" ? browserOffsetMinutes(ms) * 60 : 0));
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * An account's money for display: two decimals, half away from zero, decided on the decimal string (the terminal sends
 * up to ten decimals), with the currency. Unavailable is a dash, never zero.
 */
export function money(value: string | null | undefined, currency: string | null | undefined): string {
  if (value === null || value === undefined || !/^-?\d+(\.\d+)?$/.test(value)) return "—";
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  const cents = (BigInt(whole + fraction.padEnd(3, "0").slice(0, 3)) + 5n) / 10n;
  const text = `${negative && cents !== 0n ? "-" : ""}${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
  return currency ? `${text} ${currency}` : text;
}
