// Durable execution evidence only: unused previews never enter this store. There is no delete operation.
import type { DuckDBConnection } from "@duckdb/node-api";
import type { TradeResult } from "../bridge/account-protocol.js";
import { TradingError, type TradingPreview } from "./types.js";

export type JournalEvent =
  | { type: "review"; at: number; note: string; acknowledged: true }
  | { type: "result"; at: number; result: TradeResult }
  | { type: "unknown"; at: number; reason: string };

export type JournalRecord = {
  id: string;
  accountId: string;
  preview: TradingPreview;
  origin: "app-window" | "remote-browser" | "api-key";
  outcome: "dispatching" | "succeeded" | "failed" | "unknown";
  createdAt: number;
  updatedAt: number;
  result: TradeResult | null;
  events: JournalEvent[];
};

export interface JournalStore {
  /** Stable oldest-first ordering, with ID as the timestamp tie-breaker; no truncation. */
  list(): Promise<JournalRecord[]>;
  get(id: string): Promise<JournalRecord | undefined>;
  admit(preview: TradingPreview, origin: JournalRecord["origin"], now: number): Promise<JournalRecord>;
  markUnknown(id: string, now: number, reason: string): Promise<JournalRecord>;
  result(id: string, result: TradeResult, now: number): Promise<JournalRecord>;
  review(id: string, note: string, acknowledged: boolean, now: number): Promise<JournalRecord>;
  recover(now: number): Promise<void>;
}

function sameResult(a: TradeResult, b: TradeResult): boolean {
  return a.type === b.type && a.session === b.session && a.request === b.request && a.login === b.login &&
    a.status === b.status && a.ticket === b.ticket && a.code === b.code && a.message === b.message;
}

export function isUnresolved(record: JournalRecord): boolean {
  return record.outcome === "dispatching" || (record.outcome === "unknown" && !record.events.some((event) => event.type === "review"));
}

/** One dedicated connection. A successful mutation returns only after COMMIT, never before dispatch is safe. */
export class DuckDbJournalStore implements JournalStore {
  private work: Promise<unknown> = Promise.resolve();
  constructor(private readonly connection: DuckDBConnection) {}

  list(): Promise<JournalRecord[]> {
    return this.serial(() => this.records("SELECT record FROM trading_journal ORDER BY created_at, id"));
  }

  get(id: string): Promise<JournalRecord | undefined> {
    return this.serial(async () => (await this.records("SELECT record FROM trading_journal WHERE id = $1", [id]))[0]);
  }

  admit(preview: TradingPreview, origin: JournalRecord["origin"], now: number): Promise<JournalRecord> {
    const approved = structuredClone(preview);
    return this.serial(() => this.transaction(async () => {
      const existing = (await this.records("SELECT record FROM trading_journal WHERE id = $1", [approved.id]))[0];
      if (existing) return existing;
      const account = await this.records("SELECT record FROM trading_journal WHERE account_id = $1", [approved.intent.accountId]);
      if (account.some(isUnresolved)) throw new TradingError("account-unresolved", 409);
      const record: JournalRecord = {
        id: approved.id, accountId: approved.intent.accountId, preview: approved, origin, outcome: "dispatching",
        createdAt: now, updatedAt: now, result: null, events: [],
      };
      await this.connection.run("INSERT INTO trading_journal (id, account_id, created_at, record) VALUES ($1, $2, $3, $4)",
        [record.id, record.accountId, BigInt(now), JSON.stringify(record)]);
      return record;
    }));
  }

  markUnknown(id: string, now: number, reason: string): Promise<JournalRecord> {
    return this.serial(() => this.transaction(async () => {
      const record = await this.required(id);
      if (record.outcome === "dispatching") {
        record.outcome = "unknown";
        record.updatedAt = now;
        record.events.push({ type: "unknown", at: now, reason });
        await this.save(record);
      }
      return record;
    }));
  }

  result(id: string, result: TradeResult, now: number): Promise<JournalRecord> {
    const evidence = structuredClone(result);
    return this.serial(() => this.transaction(async () => {
      const record = await this.required(id);
      const source = record.preview.source;
      if (evidence.request !== id || evidence.session !== source.session || evidence.login !== source.login) throw new TradingError("result-mismatch", 409);
      if (record.events.some((event) => event.type === "result" && sameResult(event.result, evidence))) return record;
      record.events.push({ type: "result", at: now, result: evidence });
      record.updatedAt = now;
      // Keep the first definitive outcome; later ambiguous or conflicting evidence is still retained above.
      if (record.outcome === "dispatching" || record.outcome === "unknown") {
        record.result = evidence;
        record.outcome = evidence.status === "succeeded" ? "succeeded" : evidence.status === "rejected" ? "failed" : "unknown";
      }
      await this.save(record);
      return record;
    }));
  }

  review(id: string, note: string, acknowledged: boolean, now: number): Promise<JournalRecord> {
    return this.serial(() => this.transaction(async () => {
      const record = await this.required(id);
      if (record.outcome !== "unknown") throw new TradingError("request-not-unknown", 409);
      if (typeof note !== "string" || note.trim().length < 8 || note.trim().length > 500 || acknowledged !== true) {
        throw new TradingError("invalid-review", 422);
      }
      record.events.push({ type: "review", at: now, note: note.trim(), acknowledged: true });
      record.updatedAt = now;
      await this.save(record);
      return record;
    }));
  }

  recover(now: number): Promise<void> {
    return this.serial(() => this.transaction(async () => {
      for (const record of await this.records("SELECT record FROM trading_journal ORDER BY created_at, id")) {
        if (record.outcome !== "dispatching") continue;
        record.outcome = "unknown";
        record.updatedAt = now;
        record.events.push({ type: "unknown", at: now, reason: "restart" });
        await this.save(record);
      }
    }));
  }

  settled(): Promise<void> { return this.work.then(() => undefined); }
  close(): void { this.connection.closeSync(); }

  private async records(sql: string, values?: string[]): Promise<JournalRecord[]> {
    return (await this.connection.runAndReadAll(sql, values)).getRowObjectsJS().map((row) => JSON.parse(String(row.record)) as JournalRecord);
  }

  private async required(id: string): Promise<JournalRecord> {
    const record = (await this.records("SELECT record FROM trading_journal WHERE id = $1", [id]))[0];
    if (!record) throw new TradingError("request-not-found", 404);
    return record;
  }

  private async save(record: JournalRecord): Promise<void> {
    await this.connection.run("UPDATE trading_journal SET record = $1 WHERE id = $2", [JSON.stringify(record), record.id]);
  }

  private async transaction<T>(run: () => Promise<T>): Promise<T> {
    await this.connection.run("BEGIN TRANSACTION");
    try {
      const value = await run();
      await this.connection.run("COMMIT");
      return value;
    } catch (error) {
      try { await this.connection.run("ROLLBACK"); } catch { /* Preserve only the safe public error below. */ }
      throw error;
    }
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.work.then(run).catch((error: unknown) => {
      if (error instanceof TradingError) throw error;
      throw new TradingError("journal-unavailable", 503);
    });
    this.work = next.catch(() => undefined);
    return next;
  }
}
