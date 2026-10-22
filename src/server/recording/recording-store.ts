// Recorded samples in the app's database (schema version 3): markets, and their samples in UTC milliseconds with the
// original broker seconds (ADR 11). Samples have no key: order and dedupe come from the recorder's merge rule.
import type { DuckDBConnection } from "@duckdb/node-api";
import { brokerSummers, type ClockRule } from "../../shared/clock.js";

/** A market as stored; `recordingSince` is UTC epoch milliseconds, null while it is not recorded. */
export type StoredMarket = { id: number; brokerServer: string; symbol: string; digits: number | null; recording: boolean; recordingSince: number | null };

/** A sample as stored. */
export type SampleRow = { marketId: number; utcMs: number; brokerSeconds: number; bid: number; ask: number; receivedMs: number };

export type SampleSummary = { marketId: number; samples: number; first: number; last: number };

const YEAR_MS = 365.25 * 86400_000;

/**
 * SQL for the broker clock's offset from UTC in minutes at the row's `broker_seconds`, for rows between broker seconds
 * `first` and `last`: stored UTC times are recomputed from it when a rule changes.
 */
export function offsetMinutesSql(rule: ClockRule, first: number, last: number): string {
  const fromYear = new Date(first * 1000 - YEAR_MS).getUTCFullYear();
  const toYear = new Date(last * 1000 + YEAR_MS).getUTCFullYear();
  // The summers are whole numbers computed here, not user input.
  const summer = brokerSummers(rule, fromYear, toYear).map(([from, to]) => `(broker_seconds * 1000 >= ${from} AND broker_seconds * 1000 < ${to})`);
  return summer.length ? `CASE WHEN ${summer.join(" OR ")} THEN ${rule.winterOffsetMinutes + 60} ELSE ${rule.winterOffsetMinutes} END` : String(rule.winterOffsetMinutes);
}

export class RecordingStore {
  constructor(private readonly connection: DuckDBConnection) {}

  async markets(): Promise<StoredMarket[]> {
    const rows = (await this.connection.runAndReadAll("SELECT id, broker_server, symbol, digits, recording, recording_since FROM markets ORDER BY id")).getRowObjectsJS();
    return rows.map((row) => ({
      id: Number(row.id),
      brokerServer: String(row.broker_server),
      symbol: String(row.symbol),
      digits: row.digits === null ? null : Number(row.digits),
      recording: row.recording === true,
      recordingSince: row.recording_since === null ? null : Number(row.recording_since),
    }));
  }

  /** The market's ID, adding it when new. */
  async addMarket(brokerServer: string, symbol: string, digits: number | null): Promise<number> {
    const rows = (
      await this.connection.runAndReadAll(
        "INSERT INTO markets (broker_server, symbol, digits, recording) VALUES ($1, $2, $3, false) ON CONFLICT (broker_server, symbol) DO UPDATE SET digits = coalesce(excluded.digits, markets.digits) RETURNING id",
        [brokerServer, symbol, digits],
      )
    ).getRowObjectsJS();
    return Number(rows[0].id);
  }

  async setRecording(id: number, recording: boolean, since: number | null): Promise<void> {
    await this.connection.run("UPDATE markets SET recording = $1, recording_since = $2 WHERE id = $3", [recording, since === null ? null : BigInt(since), id]);
  }

  /** Each market's last stored sample: the newest broker time, the latest received among equals. */
  async lastSamples(): Promise<Map<number, Pick<SampleRow, "brokerSeconds" | "bid" | "ask">>> {
    const rows = (
      await this.connection.runAndReadAll(
        "SELECT market_id, broker_seconds, bid, ask FROM samples QUALIFY row_number() OVER (PARTITION BY market_id ORDER BY broker_seconds DESC, received_ms DESC) = 1",
      )
    ).getRowObjectsJS();
    return new Map(rows.map((row) => [Number(row.market_id), { brokerSeconds: Number(row.broker_seconds), bid: Number(row.bid), ask: Number(row.ask) }]));
  }

  /** Appends with DuckDB's appender. */
  async append(rows: readonly SampleRow[]): Promise<void> {
    const appender = await this.connection.createAppender("samples");
    try {
      for (const row of rows) {
        appender.appendInteger(row.marketId);
        appender.appendBigInt(BigInt(row.utcMs));
        appender.appendBigInt(BigInt(row.brokerSeconds));
        appender.appendDouble(row.bid);
        appender.appendDouble(row.ask);
        appender.appendBigInt(BigInt(row.receivedMs));
        appender.endRow();
      }
      appender.flushSync();
    } finally {
      appender.closeSync();
    }
  }

  /** Up to `limit` of a market's samples from `fromMs` to `toMs` (UTC ms, both included), oldest first, or newest first when `newest`. */
  async samples(marketId: number, fromMs: number, toMs: number, limit: number, newest = false): Promise<SampleRow[]> {
    const order = newest ? "DESC" : "ASC";
    const rows = (
      await this.connection.runAndReadAll(
        `SELECT utc_ms, broker_seconds, bid, ask, received_ms FROM samples WHERE market_id = $1 AND utc_ms BETWEEN $2 AND $3
          ORDER BY utc_ms ${order}, received_ms ${order} LIMIT $4`,
        [marketId, BigInt(fromMs), BigInt(toMs), limit],
      )
    ).getRowObjectsJS();
    return rows.map((row) => ({
      marketId,
      utcMs: Number(row.utc_ms),
      brokerSeconds: Number(row.broker_seconds),
      bid: Number(row.bid),
      ask: Number(row.ask),
      receivedMs: Number(row.received_ms),
    }));
  }

  async summaries(): Promise<SampleSummary[]> {
    const rows = (await this.connection.runAndReadAll("SELECT market_id, count(*) AS n, min(utc_ms) AS first, max(utc_ms) AS last FROM samples GROUP BY market_id")).getRowObjectsJS();
    return rows.map((row) => ({ marketId: Number(row.market_id), samples: Number(row.n), first: Number(row.first), last: Number(row.last) }));
  }

  /** Deletes a market's samples, then CHECKPOINTs so the space is given back. */
  async deleteSamples(marketId: number): Promise<void> {
    await this.connection.run("DELETE FROM samples WHERE market_id = $1", [marketId]);
    await this.connection.run("CHECKPOINT");
  }

  /** Recomputes the UTC times of every sample on a broker server from its broker seconds, in one transaction. */
  async recomputeUtc(brokerServer: string, rule: ClockRule): Promise<void> {
    const span = (
      await this.connection.runAndReadAll(
        "SELECT min(broker_seconds) AS first, max(broker_seconds) AS last FROM samples WHERE market_id IN (SELECT id FROM markets WHERE broker_server = $1)",
        [brokerServer],
      )
    ).getRowObjectsJS()[0];
    if (span?.first === null || span?.first === undefined) return;
    const offset = offsetMinutesSql(rule, Number(span.first), Number(span.last));
    await this.connection.run("BEGIN TRANSACTION");
    try {
      await this.connection.run(
        `UPDATE samples SET utc_ms = broker_seconds * 1000 - (${offset}) * 60000 WHERE market_id IN (SELECT id FROM markets WHERE broker_server = $1)`,
        [brokerServer],
      );
      await this.connection.run("COMMIT");
    } catch (e) {
      await this.connection.run("ROLLBACK");
      throw e;
    }
  }
}
