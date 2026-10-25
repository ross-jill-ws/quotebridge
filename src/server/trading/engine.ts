import { randomBytes } from "node:crypto";
import type { ClockRule } from "../../shared/clock.js";
import type { BridgeServer } from "../bridge/index.js";
import { marketId } from "../identity/index.js";
import { isUnresolved, type JournalRecord, type JournalStore } from "./journal.js";
import { revalidateTrade, validateTrade, validateTradeInput } from "./numeric.js";
import { TradingError, type TradeInput, type TradingPreview, type TradingSettings, type ValidationContext } from "./types.js";

export type RequestEngineOptions<Credential> = {
  bridge: BridgeServer; journal: JournalStore;
  /** Must consult current credentials/scopes on EVERY call; never cache an authorization decision. */
  authorize: (credential: Credential, write: boolean) => JournalRecord["origin"] | undefined;
  settings: () => Promise<TradingSettings>;
  clockRule: (brokerServer: string) => ClockRule | null;
  now?: () => number;
  terminalAvailable?: (terminalId: string) => boolean;
};

export class RequestEngine<Credential> {
  private previews = new Map<string, TradingPreview>();
  private records = new Map<string, JournalRecord>();
  private executions = new Map<string, Promise<{ record: JournalRecord; admitted: boolean }>>();
  private accountsExecuting = new Map<string, string>();
  private reservedTerminals = new Map<string, string>();
  private listeners = new Set<() => void>();
  private closed = false;
  private settingsEpoch = 0;
  private stopResults = () => {};
  private stopChanges = () => {};
  private sweep?: NodeJS.Timeout;
  private readonly now: () => number;
  private constructor(private readonly options: RequestEngineOptions<Credential>) { this.now = options.now ?? Date.now; }
  static async open<C>(options: RequestEngineOptions<C>): Promise<RequestEngine<C>> {
    const engine = new RequestEngine(options);
    await options.journal.recover(engine.now());
    for (const record of await options.journal.list()) {
      engine.records.set(record.id, record);
      options.bridge.accounts.restoreResult(record.id, record.preview.source);
    }
    engine.stopResults = options.bridge.accounts.onResult(async (result) => {
      const record = await options.journal.result(result.request, result, engine.now());
      engine.remember(record);
    });
    engine.stopChanges = options.bridge.onChange(() => engine.invalidateSources());
    engine.sweep = setInterval(() => engine.expire().catch(() => console.error("Trading timeout evidence could not be saved")), 250);
    engine.sweep.unref();
    return engine;
  }
  private authorize(credential: Credential, write: boolean) {
    const origin = this.options.authorize(credential, write);
    if (!origin) throw new TradingError("not-authorized", 403);
    return origin;
  }
  private async context(accountId: string, symbol?: string, ticket?: string): Promise<ValidationContext> {
    const accounts = this.options.bridge.accounts;
    const executor = accounts.executor(accountId);
    if (executor.state !== "ready" || !executor.source) throw new TradingError(`executor-${executor.state}`);
    if (this.options.terminalAvailable?.(executor.source.terminalId) === false) throw new TradingError("terminal-updating");
    const started = this.now();
    const source = executor.source;
    const reading = async () => {
      const accountRead = accounts.read(accountId, true);
      // Existing targets must be located in a FRESH executor snapshot, not a cached winner.
      let account;
      if (!symbol) {
        account = await accountRead;
        symbol = account.positions.concat(account.orders).find((o) => o.ticket === ticket)?.symbol;
      }
      if (!symbol) throw new TradingError("target-unavailable");
      const [snapshot, contract, settings] = await Promise.all([
        account ?? accountRead, accounts.conditions(accountId, { brokerServer: source.brokerServer, symbol }, true), this.options.settings(),
      ]);
      return { account: snapshot, contract, settings };
    };
    let timer: NodeJS.Timeout | undefined;
    const { account, contract, settings } = await Promise.race([reading(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TradingError("read-timeout", 504)), 5000);
    })]).finally(() => clearTimeout(timer));
    if (this.now() - started >= 5000) throw new TradingError("read-timeout", 504);
    const current = accounts.executor(accountId);
    if (current.state !== "ready" || current.source?.session !== executor.source.session || current.source.maxLots !== executor.source.maxLots) throw new TradingError("executor-changed");
    return { account, contract, settings, eaMaxLots: executor.source.maxLots!, now: this.now(), clockRule: this.options.clockRule(executor.source.brokerServer) };
  }
  async preview(credential: Credential, input: TradeInput): Promise<TradingPreview> {
    this.authorize(credential, true);
    this.assertOpen();
    validateTradeInput(input);
    const copied = structuredClone(input);
    if (!copied || typeof copied.accountId !== "string") throw new TradingError("invalid-input", 400);
    if (!(await this.options.settings()).enabled) throw new TradingError("trading-disabled", 403);
    const epoch = this.settingsEpoch;
    const context = await this.context(copied.accountId, copied.action === "new" ? copied.symbol : undefined, copied.action === "new" ? undefined : copied.ticket);
    const symbol = context.contract.market.symbol;
    this.authorize(credential, true);
    this.assertOpen();
    if (epoch !== this.settingsEpoch) throw new TradingError("settings-changed");
    const validated = validateTrade(copied, context);
    const createdAt = this.now();
    const preview: TradingPreview = { ...validated, id: randomBytes(16).toString("hex"), createdAt, expiresAt: createdAt + 30_000,
      source: { accountId: context.account.id, session: context.account.source!.session, terminalId: context.account.source!.terminalId, brokerServer: context.account.brokerServer, login: context.account.login },
      marketId: marketId(context.account.brokerServer, symbol), settings: structuredClone(context.settings) };
    this.previews.set(preview.id, structuredClone(preview));
    return structuredClone(preview);
  }
  async execute(credential: Credential, id: string, confirm: boolean): Promise<JournalRecord> {
    return (await this.executeRequest(credential, id, confirm)).record;
  }
  /** As `execute`; `admitted` is true only for the one call whose execution admitted the dispatch, not a duplicate joining or repeating it. */
  async executeRequest(credential: Credential, id: string, confirm: boolean): Promise<{ record: JournalRecord; admitted: boolean }> {
    this.authorize(credential, true);
    if (confirm !== true) throw new TradingError("confirmation-required", 400);
    this.assertOpen();
    let work = this.executions.get(id);
    const joined = !!work;
    if (!work) {
      work = this.executeOnce(credential, id);
      this.executions.set(id, work);
    }
    try { const { record, admitted } = await work; this.authorize(credential, true); return { record: structuredClone(record), admitted: admitted && !joined }; }
    finally { if (this.executions.get(id) === work) this.executions.delete(id); }
  }
  private async executeOnce(credential: Credential, id: string): Promise<{ record: JournalRecord; admitted: boolean }> {
    const existing = await this.options.journal.get(id);
    if (existing) return { record: existing, admitted: false };
    const preview = this.previews.get(id);
    if (!preview) throw new TradingError("preview-unavailable");
    const accountId = preview.intent.accountId;
    if (this.accountsExecuting.has(accountId) || [...this.records.values()].some((r) => r.accountId === accountId && isUnresolved(r))) throw new TradingError("account-unresolved");
    this.accountsExecuting.set(accountId, id);
    this.reservedTerminals.set(id, preview.source.terminalId);
    const epoch = this.settingsEpoch;
    try {
      const context = await this.context(accountId, preview.intent.symbol);
      const origin = this.authorize(credential, true);
      this.checkApproval(preview, context, epoch);
      // Admission itself enforces the account lock durably; no send precedes its COMMIT.
      const record = await this.options.journal.admit(preview, origin, this.now());
      this.remember(record);
      try {
        // Authorization/settings/source can change while COMMIT is pending. Fail closed, without retry.
        context.settings = await this.options.settings();
        context.now = this.now();
        this.authorize(credential, true);
        this.checkApproval(preview, context, epoch);
        this.options.bridge.accounts.expectResult(id, preview.source);
        await this.options.bridge.accounts.dispatch(id, preview.source, command(preview));
      } catch {
        const unknown = await this.options.journal.markUnknown(id, this.now(), "dispatch-interrupted");
        this.remember(unknown);
      }
      return { record: await this.options.journal.get(id) ?? record, admitted: true };
    } finally {
      this.previews.delete(id);
      this.accountsExecuting.delete(accountId);
      this.reservedTerminals.delete(id);
      this.emit();
    }
  }
  private checkApproval(preview: TradingPreview, context: ValidationContext, epoch: number) {
    this.assertOpen();
    context.now = this.now();
    context.clockRule = this.options.clockRule(preview.source.brokerServer);
    const executor = this.options.bridge.accounts.executor(preview.intent.accountId);
    if (epoch !== this.settingsEpoch || !this.previews.has(preview.id)) throw new TradingError("preview-invalidated");
    if (executor.state !== "ready" || executor.source?.session !== preview.source.session || executor.source.maxLots !== context.eaMaxLots) throw new TradingError("executor-changed");
    if (this.options.terminalAvailable?.(preview.source.terminalId) === false) throw new TradingError("terminal-updating");
    revalidateTrade(preview, context);
  }
  async get(credential: Credential, id: string) {
    this.authorize(credential, false); await this.expire();
    const record = await this.options.journal.get(id);
    if (!record) throw new TradingError("request-not-found", 404);
    this.authorize(credential, false); return record;
  }
  /** An unexecuted preview while it is still valid (memory only), detached; undefined once expired, invalidated or executed. */
  async previewOf(credential: Credential, id: string): Promise<TradingPreview | undefined> {
    this.authorize(credential, false); await this.expire();
    const preview = this.previews.get(id);
    this.authorize(credential, false); return preview && structuredClone(preview);
  }
  async list(credential: Credential) { this.authorize(credential, false); await this.expire(); const result = await this.options.journal.list(); this.authorize(credential, false); return result; }
  async review(credential: Credential, id: string, note: string, acknowledged: boolean) {
    this.authorize(credential, true); this.assertOpen(); await this.expire(); this.authorize(credential, true);
    const record = await this.options.journal.review(id, note, acknowledged, this.now());
    this.remember(record); return structuredClone(record);
  }
  private remember(record: JournalRecord) { this.records.set(record.id, record); this.emit(); }
  private emit() { for (const listener of this.listeners) { try { listener(); } catch { console.error("Trading change listener failed"); } } }
  onChange(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  unresolvedCount() { return [...this.records.values()].filter(isUnresolved).length; }
  hasUnresolvedTerminal(terminalId: string) { return [...this.reservedTerminals.values()].includes(terminalId) || [...this.records.values()].some((r) => r.preview.source.terminalId === terminalId && isUnresolved(r)); }
  private async expire() {
    for (const [id, preview] of this.previews) if (this.now() >= preview.expiresAt) this.previews.delete(id);
    for (const record of this.records.values()) if (record.outcome === "dispatching" && this.now() - record.createdAt >= 20_000) {
      this.remember(await this.options.journal.markUnknown(record.id, this.now(), "result-timeout"));
    }
  }
  private invalidateSources() {
    for (const [id, preview] of this.previews) {
      const e = this.options.bridge.accounts.executor(preview.intent.accountId);
      if (e.state !== "ready" || e.source?.session !== preview.source.session || canonical(e.source.maxLots!) !== canonical(preview.limits.ea)) this.previews.delete(id);
    }
  }
  private assertOpen() { if (this.closed) throw new TradingError("trading-stopped", 503); }
  settingsChanged() { this.settingsEpoch++; this.previews.clear(); }
  /** Freeze new work, but keep accepting evidence until the transport has drained. */
  async stopAdmissions() {
    this.closed = true; clearInterval(this.sweep); this.previews.clear();
    await Promise.allSettled([...this.executions.values()]);
  }
  async close() {
    await this.stopAdmissions();
    this.stopResults(); this.stopChanges(); this.listeners.clear();
  }
}

const canonical = (value: string) => value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;

function command(preview: TradingPreview): string {
  const i = preview.intent, t = preview.target;
  return ["X", "1", preview.source.session, preview.id, preview.source.login, preview.source.brokerServer,
    { new: "N", modify: "M", close: "C", cancel: "D" }[i.action], i.kind, i.symbol, i.ticket, i.lots,
    i.price, i.stopLoss, i.takeProfit, i.brokerExpiry, i.slippage, preview.limits.maxLots,
    t?.openTime ?? 0, t?.openPrice ?? "0", t?.lots ?? "0", t?.stopLoss ?? "0", t?.takeProfit ?? "0", t?.expiration ?? 0,
    Math.floor(preview.expiresAt / 1000)].join("|");
}
