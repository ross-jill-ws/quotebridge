// Account reads are bound before sending; only a complete, single-source answer can replace live state.
import { randomBytes } from "node:crypto";
import { accountId, memoryIdentityStore, type AccountIdentity, type IdentityStore } from "../identity/index.js";
import type { AccountHello, AccountMessage, AccountOrder, AccountPage, Conditions, TradeResult } from "./account-protocol.js";
import type { Market } from "./protocol.js";

export const ACCOUNT_READ_MS = 5000;
const MAX_READS = 1000;

export class AccountReadError extends Error {
  constructor(readonly code: "unavailable-source" | "read-timeout" | "account-changed" | "invalid-response" | "read-failed" | "executor-unavailable" | "cross-broker-market", readonly status: number, readonly reason?: string) {
    super(code);
  }
}

export type AccountBinding = { accountId: string; session: string; terminalId: string; brokerServer: string; login: string };
type Announcement = AccountBinding & AccountHello;
export type AccountSource = AccountBinding & { enabled: boolean; ready: boolean; maxLots: string | null; connected: boolean };
export type Funds = { balance: string | null; equity: string | null; margin: string | null; freeMargin: string | null; profit: string | null; marginLevel: string | null; currency: string | null; leverage: number | null };
export type AccountSnapshot = AccountIdentity & {
  connected: boolean; demo: boolean | null; state: "fresh" | "stale" | "unavailable";
  /** Execution readiness at snapshot capture, not a substitute for current executor authorization. */
  ready: boolean | null;
  funds: Funds; positions: AccountOrder[]; orders: AccountOrder[];
  source: (AccountBinding & { capturedBrokerTime: number; receivedAt: number }) | null;
  sources: AccountSource[];
};
export type ConditionSnapshot = { accountId: string; market: Market; conditions: Conditions; source: AccountBinding & { receivedAt: number } };
type Complete = { page: AccountPage; orders: AccountOrder[]; binding: AccountBinding; receivedAt: number };
type Pending = {
  request: string; binding: AccountBinding; kind: "account" | "conditions"; market?: Market;
  deadline: number; timer: NodeJS.Timeout; pages: Map<number, AccountPage>;
  resolve: (value: AccountSnapshot | ConditionSnapshot) => void; reject: (error: AccountReadError) => void;
  answer: Promise<AccountSnapshot | ConditionSnapshot>;
  requireExecutor: boolean;
};
type Transport = {
  peer: (session: string) => { terminalId: string; brokerServer: string; lastSeen: number } | undefined;
  send: (session: string, wire: string) => Promise<void>;
  retire: (session: string) => void;
};

export class AccountState {
  private identities = new Map<string, AccountIdentity>();
  private announcements = new Map<string, Announcement>();
  private complete = new Map<string, Complete>();
  private pending = new Map<string, Pending>();
  private dispatched = new Map<string, AccountBinding>();
  private resultListeners = new Set<(result: TradeResult, binding: AccountBinding) => void | Promise<void>>();

  constructor(private readonly transport: Transport, private readonly now: () => number, private readonly store: IdentityStore = memoryIdentityStore()) {}

  async open() { for (const identity of await this.store.list()) this.identities.set(identity.id, identity); }

  /** Called only after route and verified terminal checks. Full logins stay out of bridge diagnostics. */
  async accept(message: AccountMessage) {
    if (message.type === "account-hello") return this.announce(message);
    if (message.type === "trade-result") {
      const binding = this.dispatched.get(message.request);
      // Dispatched bindings deliberately survive source retirement and login changes.
      if (!binding || binding.session !== message.session || binding.login !== message.login) throw new AccountReadError("invalid-response", 409);
      for (const listener of this.resultListeners) {
        try { await listener(structuredClone(message), { ...binding }); }
        catch { console.error("Account result listener failed"); }
      }
      return;
    }
    this.expire();
    const pending = this.pending.get(message.request);
    if (!pending || pending.binding.session !== message.session) throw new AccountReadError("invalid-response", 409);
    if (!this.current(pending.binding) || pending.binding.login !== message.login) {
      this.fail(pending, "account-changed", 409);
      throw new AccountReadError("account-changed", 409);
    }
    if (message.type === "read-error") { this.fail(pending, "read-failed", 503, message.message); return; }
    try {
      if (pending.kind === "conditions" && message.type === "conditions") {
        if (message.symbol !== pending.market!.symbol) throw new AccountReadError("invalid-response", 409);
        this.finish(pending, { accountId: pending.binding.accountId, market: { ...pending.market! }, conditions: message, source: { ...pending.binding, receivedAt: this.now() } });
      } else if (pending.kind === "account" && message.type === "account-page") {
        this.page(pending, message);
      } else throw new AccountReadError("invalid-response", 409);
    } catch (error) {
      const failure = error instanceof AccountReadError ? error : new AccountReadError("invalid-response", 409);
      this.fail(pending, failure.code, failure.status);
      throw failure;
    }
  }

  private async announce(message: AccountHello) {
    const peer = this.transport.peer(message.session);
    if (!peer) throw new AccountReadError("unavailable-source", 503);
    const id = accountId(peer.brokerServer, message.login);
    const previous = this.announcements.get(message.session);
    if (previous && previous.accountId !== id) {
      this.transport.retire(message.session);
      throw new AccountReadError("account-changed", 409);
    }
    // One terminal has one current login. Retire siblings rather than allowing a late old announcement to flip it back.
    for (const other of this.announcements.values()) {
      if (other.terminalId === peer.terminalId && other.accountId !== id) this.transport.retire(other.session);
    }
    const identity = this.identities.get(id) ?? await this.store.put({ brokerServer: peer.brokerServer, login: message.login, label: `${peer.brokerServer} · ${message.login}` });
    this.identities.set(id, identity);
    this.announcements.set(message.session, { ...message, accountId: id, terminalId: peer.terminalId, brokerServer: peer.brokerServer });
    this.expire();
  }

  /** Revocation preserves dispatched evidence but cancels every unused read/partial assembly. */
  invalidate(session: string) {
    for (const pending of this.pending.values()) if (pending.binding.session === session) this.fail(pending, "account-changed", 409);
  }

  forget(session: string) { this.invalidate(session); this.announcements.delete(session); }

  rejectResponse(session: string, request: string) {
    const pending = this.pending.get(request);
    if (pending?.binding.session === session) this.fail(pending, "invalid-response", 409);
  }

  private current(binding: AccountBinding): boolean {
    const p = this.transport.peer(binding.session);
    const a = this.announcements.get(binding.session);
    return !!p && !!a && a.accountId === binding.accountId && a.login === binding.login && p.terminalId === binding.terminalId && p.brokerServer === binding.brokerServer && this.now() - p.lastSeen < ACCOUNT_READ_MS;
  }

  sources(id: string): AccountSource[] {
    return [...this.announcements.values()].filter((a) => a.accountId === id).map((a) => ({ ...bindingOf(a), enabled: a.enabled, ready: a.ready, maxLots: a.maxLots, connected: this.current(a) }))
      .sort((a, b) => lexical(a.terminalId, b.terminalId) || lexical(a.session, b.session));
  }

  executor(id: string): { state: "zero" | "multiple" | "not-ready" | "real-account" | "ready"; source: AccountSource | null } {
    const enabled = this.sources(id).filter((s) => s.connected && s.enabled);
    if (enabled.length !== 1) return { state: enabled.length ? "multiple" : "zero", source: null };
    const source = enabled[0];
    const announcement = this.announcements.get(source.session)!;
    return { state: !announcement.demo ? "real-account" : !source.ready || source.maxLots === null || Number(source.maxLots) <= 0 ? "not-ready" : "ready", source };
  }

  list(): AccountSnapshot[] {
    this.expire();
    return [...this.identities.values()].sort((a, b) => lexical(a.id, b.id)).map((identity) => this.snapshot(identity));
  }

  get(id: string): AccountSnapshot | undefined { return this.list().find((a) => a.id === id); }

  private snapshot(identity: AccountIdentity, selected?: Complete): AccountSnapshot {
    const sources = this.sources(identity.id);
    const latest = selected ?? [...this.complete.values()].filter((c) => c.binding.accountId === identity.id)
      .sort((a, b) => b.receivedAt - a.receivedAt || lexical(a.binding.terminalId, b.binding.terminalId) || lexical(a.binding.session, b.binding.session))[0];
    const page = latest?.page;
    const announcement = [...this.announcements.values()].find((a) => a.accountId === identity.id && this.current(a));
    return structuredClone({
      ...identity, connected: sources.some((s) => s.connected), demo: announcement?.demo ?? page?.demo ?? null,
      ready: page?.ready ?? null,
      state: latest ? this.current(latest.binding) && this.now() - latest.receivedAt < ACCOUNT_READ_MS ? "fresh" : "stale" : "unavailable",
      funds: {
        balance: page?.balance ?? null, equity: page?.equity ?? null, margin: page?.margin ?? null,
        freeMargin: page?.freeMargin ?? null, profit: page?.profit ?? null,
        marginLevel: page ? marginLevel(page.equity, page.margin) : null,
        currency: page?.currency ?? announcement?.currency ?? null, leverage: page?.leverage ?? null,
      },
      positions: latest?.orders.filter((o) => o.kind < 2) ?? [], orders: latest?.orders.filter((o) => o.kind >= 2) ?? [],
      source: latest ? { ...latest.binding, capturedBrokerTime: latest.page.capturedAt, receivedAt: latest.receivedAt } : null,
      sources,
    });
  }

  async read(id: string, requireExecutor = false): Promise<AccountSnapshot> {
    return structuredClone(await this.request(id, "account", undefined, requireExecutor)) as AccountSnapshot;
  }

  async conditions(id: string, market: Market, requireExecutor = false): Promise<ConditionSnapshot> {
    market = { brokerServer: market.brokerServer, symbol: market.symbol };
    const identity = this.identities.get(id);
    if (identity && identity.brokerServer !== market.brokerServer) throw new AccountReadError("cross-broker-market", 409);
    if (!market.symbol || market.symbol.length > 120 || /[|\x00-\x1f]/.test(market.symbol)) throw new AccountReadError("invalid-response", 400);
    return structuredClone(await this.request(id, "conditions", market, requireExecutor)) as ConditionSnapshot;
  }

  private request(id: string, kind: Pending["kind"], market: Market | undefined, requireExecutor: boolean): Promise<AccountSnapshot | ConditionSnapshot> {
    this.expire();
    const executor = this.executor(id);
    const source = requireExecutor ? executor.state === "ready" ? executor.source : null
      : executor.source ?? this.sources(id).find((s) => s.connected);
    if (!source || !source.connected || this.pending.size >= MAX_READS) return Promise.reject(new AccountReadError(requireExecutor ? "executor-unavailable" : "unavailable-source", 503));
    // The EA owns one frozen V page stream: a second V command would overwrite it.
    const existing = kind === "account" && [...this.pending.values()].find((p) => p.kind === kind && p.binding.session === source.session);
    if (existing) { existing.requireExecutor ||= requireExecutor; return existing.answer; }
    const request = randomBytes(16).toString("hex");
    let resolve!: Pending["resolve"], reject!: Pending["reject"];
    const answer: Pending["answer"] = new Promise((yes, no) => { resolve = yes; reject = no; });
    const pending: Pending = { request, binding: bindingOf(source), kind, market, deadline: this.now() + ACCOUNT_READ_MS, pages: new Map(), resolve, reject, answer, requireExecutor,
      timer: setTimeout(() => this.fail(pending, "read-timeout", 504), ACCOUNT_READ_MS) };
    this.pending.set(request, pending);
    const wire = `${kind === "account" ? "V" : "P"}|1|${source.session}|${request}|${source.login}|${source.brokerServer}${market ? `|${market.symbol}` : ""}`;
    this.transport.send(source.session, wire).catch(() => this.fail(pending, "unavailable-source", 503));
    return answer;
  }

  private page(pending: Pending, page: AccountPage) {
    const announcement = this.announcements.get(page.session)!;
    if (pending.requireExecutor && !page.ready) throw new AccountReadError("executor-unavailable", 503);
    if (page.broker !== pending.binding.brokerServer || page.currency !== announcement.currency || page.demo !== announcement.demo || pending.pages.has(page.offset)) throw new AccountReadError("invalid-response", 409);
    const first = pending.pages.values().next().value;
    const header = (p: AccountPage) => JSON.stringify({ ...p, offset: 0, orders: [] });
    if (first && header(first) !== header(page)) throw new AccountReadError("invalid-response", 409);
    pending.pages.set(page.offset, page);
    const orders = [...pending.pages.values()].sort((a, b) => a.offset - b.offset).flatMap((p) => p.orders);
    if (new Set(orders.map((o) => o.ticket)).size !== orders.length) throw new AccountReadError("invalid-response", 409);
    if (orders.length !== page.total) return;
    const complete = { page, orders, binding: { ...pending.binding }, receivedAt: this.now() };
    this.complete.set(JSON.stringify([pending.binding.accountId, pending.binding.terminalId]), complete);
    this.finish(pending, this.snapshot(this.identities.get(pending.binding.accountId)!, pending.requireExecutor ? complete : undefined));
  }

  /** Future request engine registers immutable dispatch identity before sending. No mutation is sent here. */
  expectResult(request: string, binding: AccountBinding) {
    if (!this.current(binding) || this.dispatched.has(request)) throw new AccountReadError("invalid-response", 409);
    this.restoreResult(request, binding);
  }
  /** Trusted durable journal bindings survive restart; this registers evidence, never sends a command. */
  restoreResult(request: string, binding: AccountBinding) {
    const existing = this.dispatched.get(request);
    if (!/^[0-9a-f]{32}$/.test(request) || (existing && !sameAccountBinding(existing, binding))) throw new AccountReadError("invalid-response", 409);
    this.dispatched.set(request, { ...binding });
  }
  /** The engine calls only after durable admission. A changed source can never reroute this send. */
  async dispatch(request: string, binding: AccountBinding, wire: string) {
    const executor = this.executor(binding.accountId);
    const original = this.dispatched.get(request);
    if (!original || !sameAccountBinding(original, binding) || !this.current(binding) || executor.state !== "ready" || executor.source?.session !== binding.session) throw new AccountReadError("account-changed", 409);
    await this.transport.send(binding.session, wire);
  }
  onResult(listener: (result: TradeResult, binding: AccountBinding) => void | Promise<void>): () => void {
    this.resultListeners.add(listener);
    return () => this.resultListeners.delete(listener);
  }

  private expire() {
    for (const p of this.pending.values()) {
      if (this.now() >= p.deadline) this.fail(p, "read-timeout", 504);
      else if (!this.current(p.binding)) this.fail(p, "account-changed", 409);
      else if (p.requireExecutor) {
        const executor = this.executor(p.binding.accountId);
        if (executor.state !== "ready" || executor.source?.session !== p.binding.session) this.fail(p, "executor-unavailable", 503);
      }
    }
  }
  private finish(p: Pending, value: AccountSnapshot | ConditionSnapshot) {
    this.pending.delete(p.request); clearTimeout(p.timer); p.resolve(structuredClone(value));
  }
  private fail(p: Pending, code: AccountReadError["code"], status: number, reason?: string) {
    if (!this.pending.delete(p.request)) return;
    clearTimeout(p.timer); p.pages.clear(); p.reject(new AccountReadError(code, status, reason));
  }
  close() { for (const p of this.pending.values()) this.fail(p, "unavailable-source", 503); }
}

const bindingOf = (a: AccountBinding): AccountBinding => ({ accountId: a.accountId, session: a.session, terminalId: a.terminalId, brokerServer: a.brokerServer, login: a.login });
const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export const sameAccountBinding = (a: AccountBinding, b: AccountBinding) => a.accountId === b.accountId && a.session === b.session && a.terminalId === b.terminalId && a.brokerServer === b.brokerServer && a.login === b.login;

/** Percent, rounded half away from zero to the wire's ten decimal places, without binary floating point. */
function marginLevel(equity: string, margin: string): string | null {
  const scale = 10000000000n;
  const units = (text: string) => {
    const [whole, fraction = ""] = text.replace(/^-/, "").split(".");
    const value = BigInt(whole) * scale + BigInt(fraction.padEnd(10, "0"));
    return text.startsWith("-") ? -value : value;
  };
  const denominator = units(margin);
  if (denominator <= 0n) return null;
  const numerator = units(equity) * 100n * scale;
  const absolute = numerator < 0n ? -numerator : numerator;
  const rounded = (absolute * 2n + denominator) / (denominator * 2n);
  return `${numerator < 0n && rounded ? "-" : ""}${rounded / scale}.${String(rounded % scale).padStart(10, "0")}`;
}
