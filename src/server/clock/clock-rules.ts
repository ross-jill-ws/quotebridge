// Broker clocks (ADR 11): infers each broker server's offset from live samples, keeps a clock rule per broker server,
// and flags an observed offset that contradicts the rule. No EA change: the offset is a sample's broker time minus
// this server's UTC clock at arrival.
import { describeRule, inferRule, isClockRule, MAX_OFFSET_MINUTES, MIN_OFFSET_MINUTES, offsetAtUtc, OFFSET_STEP_MINUTES, type ClockRule } from "../../shared/clock.js";
import type { BridgeServer, SampleEvent } from "../bridge/index.js";

/** A sample whose times are further than this from what a live sample would carry is not used for inference. */
const MAX_SAMPLE_AGE_MS = 60_000;
/** An observed offset must contradict the rule this long before it is flagged. */
const MISMATCH_AFTER_MS = 10 * 60_000;
/** Observations further apart than this (a closed or quiet market) start the mismatch time again. */
const MAX_OBSERVATION_GAP_MS = 5 * 60_000;
/** The last observation is written at least this often while the offset stays the same. */
const SAVE_OBSERVED_EVERY_MS = 60_000;
const MINUTE = 60_000;

export type ClockRuleSource = "inferred" | "set";

/** A broker server's clock rule as stored. */
export type StoredClockRule = ClockRule & {
  brokerServer: string;
  source: ClockRuleSource;
  lastObservedOffset: number | null;
  /** UTC epoch milliseconds. */
  lastObservedAt: number | null;
};

/** Where clock rules are kept: the database, or memory when the server runs without one. */
export interface ClockRuleStore {
  load(): Promise<StoredClockRule[]>;
  save(rule: StoredClockRule): Promise<void>;
}

/** What the Terminals panel shows about a broker server's clock. */
export type BrokerClock = {
  brokerServer: string;
  rule: ClockRule;
  source: ClockRuleSource;
  /** "GMT+2, GMT+3 in US summer time". */
  description: string;
  /** The latest offset seen in live samples; it stands while the market is closed. */
  lastObserved: { offsetMinutes: number; at: number } | null;
  /** Live samples have contradicted the rule for at least 10 minutes. */
  mismatch: { observedOffsetMinutes: number; since: number } | null;
};

/** A request the user can fix; `status` is the HTTP status to answer with. */
export class ClockRuleRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type ClockRulesOptions = {
  /** Clock in epoch milliseconds; injectable for tests. */
  now?: () => number;
  /** The PC's local time minus UTC at an instant, in minutes: reads the EA's sampled time (TimeLocal). Injectable for tests. */
  localOffsetMinutes?: (utcMs: number) => number;
};

type Entry = StoredClockRule & { savedAt: number; pending?: { offset: number; since: number }; flagged: boolean };

export function memoryClockRuleStore(): ClockRuleStore {
  const rows = new Map<string, StoredClockRule>();
  return {
    load: async () => [...rows.values()].map((r) => ({ ...r })),
    save: async (rule) => void rows.set(rule.brokerServer, { ...rule }),
  };
}

export class ClockRules {
  private readonly entries = new Map<string, Entry>();
  /** Per feed: the last quote time seen, so only a quote time that moves (not a frozen quote) counts. */
  private readonly lastQuoteTimes = new Map<string, number>();
  private readonly now: () => number;
  private readonly localOffsetMinutes: (utcMs: number) => number;
  private unsubscribe = () => {};
  private writes: Promise<void> = Promise.resolve();
  private readonly ruleListeners = new Set<(brokerServer: string, rule: ClockRule) => Promise<void> | void>();

  private constructor(
    private readonly store: ClockRuleStore,
    options: ClockRulesOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.localOffsetMinutes = options.localOffsetMinutes ?? ((utcMs) => -new Date(utcMs).getTimezoneOffset());
  }

  /** Loads the stored rules, then infers from the bridge's samples. */
  static async open(bridge: BridgeServer, store: ClockRuleStore, options: ClockRulesOptions = {}): Promise<ClockRules> {
    const rules = new ClockRules(store, options);
    for (const row of await store.load()) rules.entries.set(row.brokerServer, { ...row, savedAt: row.lastObservedAt ?? 0, flagged: false });
    rules.unsubscribe = bridge.onSamples((event) => rules.handle(event));
    return rules;
  }

  /**
   * Calls `listener` when a broker server's rule is first inferred or set to another rule (stored UTC times are then
   * recomputed). A set waits for it. Returns an unsubscribe function.
   */
  onRuleChange(listener: (brokerServer: string, rule: ClockRule) => Promise<void> | void): () => void {
    this.ruleListeners.add(listener);
    return () => this.ruleListeners.delete(listener);
  }

  private async ruleChanged(brokerServer: string, rule: ClockRule) {
    await Promise.all([...this.ruleListeners].map(async (listener) => listener(brokerServer, rule)));
  }

  /** A broker server's rule, or null before anything was observed or set. */
  rule(brokerServer: string): ClockRule | null {
    const entry = this.entries.get(brokerServer);
    return entry ? { winterOffsetMinutes: entry.winterOffsetMinutes, dst: entry.dst } : null;
  }

  /** Every broker server's clock, by name. */
  list(): BrokerClock[] {
    return [...this.entries.values()].sort((a, b) => a.brokerServer.localeCompare(b.brokerServer)).map(view);
  }

  get(brokerServer: string): BrokerClock | null {
    const entry = this.entries.get(brokerServer);
    return entry ? view(entry) : null;
  }

  /** Sets a broker server's rule as the user chose it; inference never replaces it. */
  async set(request: unknown): Promise<BrokerClock> {
    const { brokerServer, ...rule } = (request ?? {}) as { brokerServer?: unknown; winterOffsetMinutes?: unknown; dst?: unknown };
    if (typeof brokerServer !== "string" || !brokerServer.length || brokerServer.length > 120) throw new ClockRuleRequestError(400, "Expected a broker server.");
    if (!isClockRule(rule)) {
      throw new ClockRuleRequestError(
        400,
        `Expected a winter offset from ${MIN_OFFSET_MINUTES} to ${MAX_OFFSET_MINUTES} minutes in ${OFFSET_STEP_MINUTES}-minute steps, and daylight saving none, us or eu.`,
      );
    }
    const old = this.entries.get(brokerServer);
    const entry: Entry = {
      brokerServer,
      winterOffsetMinutes: rule.winterOffsetMinutes,
      dst: rule.dst,
      source: "set",
      lastObservedOffset: old?.lastObservedOffset ?? null,
      lastObservedAt: old?.lastObservedAt ?? null,
      savedAt: this.now(),
      flagged: false,
    };
    this.entries.set(brokerServer, entry);
    await this.save(entry);
    if (!old || old.winterOffsetMinutes !== entry.winterOffsetMinutes || old.dst !== entry.dst) await this.ruleChanged(brokerServer, rule);
    return view(entry);
  }

  private handle(event: SampleEvent) {
    if (event.type === "removed") {
      this.lastQuoteTimes.delete(event.feed);
      return;
    }
    const now = this.now();
    for (const sample of event.samples) {
      const last = this.lastQuoteTimes.get(event.feed);
      if (sample.quoteTime === last) continue;
      this.lastQuoteTimes.set(event.feed, sample.quoteTime);
      // A feed's first sample may be a frozen quote: its quote time has not been seen moving yet.
      if (last === undefined) continue;
      // Sampled long ago (replayed from the EA's buffer).
      const sampledUtc = (sample.sampledTime - this.localOffsetMinutes(now) * 60) * 1000;
      if (Math.abs(now - sampledUtc) > MAX_SAMPLE_AGE_MS) continue;
      const raw = sample.quoteTime * 1000 - now;
      const offset = Math.round(raw / (OFFSET_STEP_MINUTES * MINUTE)) * OFFSET_STEP_MINUTES;
      // An old quote: its broker time is off the 15-minute grid by more than a live quote can be.
      if (Math.abs(raw - offset * MINUTE) > MAX_SAMPLE_AGE_MS) continue;
      if (offset < MIN_OFFSET_MINUTES || offset > MAX_OFFSET_MINUTES) continue;
      this.observe(event.market.brokerServer, offset, now);
    }
  }

  private observe(brokerServer: string, offset: number, now: number) {
    let entry = this.entries.get(brokerServer);
    const changed = entry?.lastObservedOffset !== offset;
    const continuous = entry?.lastObservedAt != null && now - entry.lastObservedAt <= MAX_OBSERVATION_GAP_MS;
    if (!entry) {
      // The first observation sets the rule.
      entry = { brokerServer, ...inferRule(offset), source: "inferred", lastObservedOffset: null, lastObservedAt: null, savedAt: 0, flagged: false };
      this.entries.set(brokerServer, entry);
      void this.ruleChanged(brokerServer, inferRule(offset)).catch((e) => console.error("Stored times could not follow a new clock rule", e));
    }
    entry.lastObservedOffset = offset;
    entry.lastObservedAt = now;
    if (offset === offsetAtUtc(entry, now)) {
      entry.pending = undefined;
      entry.flagged = false;
    } else {
      if (entry.pending?.offset !== offset || !continuous) entry.pending = { offset, since: now };
      entry.flagged = now - entry.pending.since >= MISMATCH_AFTER_MS;
    }
    if (changed || now - entry.savedAt >= SAVE_OBSERVED_EVERY_MS) {
      entry.savedAt = now;
      void this.save(entry).catch((e) => console.error("A clock rule could not be saved", e));
    }
  }

  private save(entry: Entry): Promise<void> {
    const row: StoredClockRule = {
      brokerServer: entry.brokerServer,
      winterOffsetMinutes: entry.winterOffsetMinutes,
      dst: entry.dst,
      source: entry.source,
      lastObservedOffset: entry.lastObservedOffset,
      lastObservedAt: entry.lastObservedAt,
    };
    // One write at a time, in order.
    const next = this.writes.then(() => this.store.save(row));
    this.writes = next.catch(() => {});
    return next;
  }

  /** Stops inferring and waits for pending writes. */
  async close() {
    this.unsubscribe();
    await this.writes;
  }
}

function view(entry: Entry): BrokerClock {
  const rule: ClockRule = { winterOffsetMinutes: entry.winterOffsetMinutes, dst: entry.dst };
  return {
    brokerServer: entry.brokerServer,
    rule,
    source: entry.source,
    description: describeRule(rule),
    lastObserved: entry.lastObservedOffset !== null && entry.lastObservedAt !== null ? { offsetMinutes: entry.lastObservedOffset, at: entry.lastObservedAt } : null,
    mismatch: entry.flagged && entry.pending ? { observedOffsetMinutes: entry.pending.offset, since: entry.pending.since } : null,
  };
}
