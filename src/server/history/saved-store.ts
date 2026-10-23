// Saved history in the app's database (schema version 4): a market's HST bars, per period, in UTC seconds with the
// original broker seconds (ADR 11), keyed by (market, period, broker seconds). The store has its own connection, so
// its writes never share a transaction with the recorder's, and runs one job at a time on it.
import type { DuckDBConnection } from "@duckdb/node-api";
import type { ClockRule } from "../../shared/clock.js";
import type { Period } from "../../shared/periods.js";
import type { Market } from "../bridge/index.js";
import { offsetMinutesSql } from "../recording/index.js";
import type { HstBar } from "./hst-file.js";

/** A saved bar: `time` is broker seconds, as in HST files, and `utc` UTC seconds. */
export type SavedBar = HstBar & { utc: number };

/** What a market's period holds: a bar count and the first and last bar's start in UTC and broker seconds. */
export type SavedSpan = Market & { period: Period; bars: number; first: number; last: number; firstBroker: number; lastBroker: number };

/** Bars read at a time while paging through a download. */
const PAGE_BARS = 4096;

const COLUMNS = "utc_seconds, broker_seconds, open, high, low, close, tick_volume, spread, real_volume";

export class SavedBarStore {
  /** Database work, one job at a time, in order. */
  private work: Promise<unknown> = Promise.resolve();
  private staging: Promise<void> | undefined;

  constructor(private readonly connection: DuckDBConnection) {}

  async spans(): Promise<SavedSpan[]> {
    const rows = await this.read(
      `SELECT m.broker_server, m.symbol, s.period, count(*) AS n, min(s.utc_seconds) AS first, max(s.utc_seconds) AS last,
        min(s.broker_seconds) AS first_broker, max(s.broker_seconds) AS last_broker
      FROM saved_bars s JOIN markets m ON m.id = s.market_id GROUP BY m.broker_server, m.symbol, s.period`,
    );
    return rows.map((row) => ({
      brokerServer: String(row.broker_server),
      symbol: String(row.symbol),
      period: String(row.period) as Period,
      bars: Number(row.n),
      first: Number(row.first),
      last: Number(row.last),
      firstBroker: Number(row.first_broker),
      lastBroker: Number(row.last_broker),
    }));
  }

  /** The first and last saved bar's start of a market's period, in broker seconds; null when none is saved. */
  async span(marketId: number, period: Period): Promise<{ first: number; last: number } | null> {
    const [row] = await this.read("SELECT min(broker_seconds) AS first, max(broker_seconds) AS last FROM saved_bars WHERE market_id = $1 AND period = $2", [marketId, period]);
    return row?.first === null || row?.first === undefined ? null : { first: Number(row.first), last: Number(row.last) };
  }

  /**
   * Adds bars of a market's period. A bar whose key is saved already replaces it: only the newest saved bar can be
   * sent again (the saver sends bars older than the first saved one or from the last saved one on), and that one may
   * have been saved while it was still forming.
   */
  insert(marketId: number, period: Period, bars: readonly SavedBar[]): Promise<void> {
    if (!bars.length) return Promise.resolve();
    return this.serial(async () => {
      // A temporary table is this connection's own: the bars go in with the appender, then across in one statement.
      this.staging ??= this.connection.run(`CREATE TEMP TABLE saved_staging AS SELECT * FROM saved_bars LIMIT 0`).then(
        () => {},
        (e) => {
          this.staging = undefined;
          throw e;
        },
      );
      await this.staging;
      const appender = await this.connection.createAppender("saved_staging", "main", "temp");
      try {
        for (const bar of bars) {
          appender.appendInteger(marketId);
          appender.appendVarchar(period);
          appender.appendBigInt(BigInt(bar.utc));
          appender.appendBigInt(BigInt(bar.time));
          appender.appendDouble(bar.open);
          appender.appendDouble(bar.high);
          appender.appendDouble(bar.low);
          appender.appendDouble(bar.close);
          appender.appendBigInt(BigInt(Math.round(bar.tickVolume)));
          appender.appendInteger(bar.spread);
          appender.appendBigInt(BigInt(Math.round(bar.realVolume)));
          appender.endRow();
        }
        appender.flushSync();
      } finally {
        appender.closeSync();
      }
      try {
        await this.connection.run("INSERT OR REPLACE INTO saved_bars SELECT * FROM saved_staging");
      } finally {
        await this.connection.run("DELETE FROM saved_staging");
      }
    });
  }

  /** The start times of the saved bars of a market's period from `from` to `to` (broker seconds, both included). */
  async times(marketId: number, period: Period, from: number, to: number): Promise<Set<number>> {
    const rows = await this.read("SELECT broker_seconds FROM saved_bars WHERE market_id = $1 AND period = $2 AND broker_seconds BETWEEN $3 AND $4", [
      marketId,
      period,
      BigInt(from),
      BigInt(to),
    ]);
    return new Set(rows.map((row) => Number(row.broker_seconds)));
  }

  /** Up to `limit` bars of a market's period older than `before` (broker seconds; the newest when undefined), oldest first. */
  async before(market: Market, period: Period, before: number | undefined, limit: number): Promise<{ bars: HstBar[]; complete: boolean }> {
    const rows = await this.read(
      `SELECT ${COLUMNS} FROM saved_bars WHERE market_id = (SELECT id FROM markets WHERE broker_server = $1 AND symbol = $2) AND period = $3
        AND broker_seconds < $4 ORDER BY broker_seconds DESC LIMIT $5`,
      [market.brokerServer, market.symbol, period, BigInt(before ?? Number.MAX_SAFE_INTEGER), limit + 1],
    );
    return { bars: rows.slice(0, limit).reverse().map(bar), complete: rows.length <= limit };
  }

  /** Up to `limit` bars of a market's period from `from` to `to` (broker seconds, both included), oldest first. */
  async between(market: Market, period: Period, from: number, to: number, limit: number): Promise<HstBar[]> {
    const rows = await this.read(
      `SELECT ${COLUMNS} FROM saved_bars WHERE market_id = (SELECT id FROM markets WHERE broker_server = $1 AND symbol = $2) AND period = $3
        AND broker_seconds BETWEEN $4 AND $5 ORDER BY broker_seconds LIMIT $6`,
      [market.brokerServer, market.symbol, period, BigInt(from), BigInt(to), limit],
    );
    return rows.map(bar);
  }

  /**
   * How many bars of a market's period are saved older than `before` and from `from` on (broker seconds; no bound when
   * undefined), and the first and last of them.
   */
  async count(market: Market, period: Period, before?: number, from?: number): Promise<{ bars: number; first: number; last: number } | null> {
    const [row] = await this.read(
      `SELECT count(*) AS n, min(broker_seconds) AS first, max(broker_seconds) AS last FROM saved_bars
        WHERE market_id = (SELECT id FROM markets WHERE broker_server = $1 AND symbol = $2) AND period = $3 AND broker_seconds < $4 AND broker_seconds >= $5`,
      [market.brokerServer, market.symbol, period, BigInt(before ?? Number.MAX_SAFE_INTEGER), BigInt(from ?? -1)],
    );
    return Number(row?.n ?? 0) ? { bars: Number(row.n), first: Number(row.first), last: Number(row.last) } : null;
  }

  /** Every bar of a market's period older than `before` and from `from` on (broker seconds; no bound when undefined), oldest first, a page at a time. */
  async *pages(market: Market, period: Period, before?: number, from?: number): AsyncGenerator<HstBar[]> {
    let after = from === undefined ? -1 : from - 1;
    for (;;) {
      const rows = await this.read(
        `SELECT ${COLUMNS} FROM saved_bars WHERE market_id = (SELECT id FROM markets WHERE broker_server = $1 AND symbol = $2) AND period = $3
          AND broker_seconds > $4 AND broker_seconds < $5 ORDER BY broker_seconds LIMIT ${PAGE_BARS}`,
        [market.brokerServer, market.symbol, period, BigInt(after), BigInt(before ?? Number.MAX_SAFE_INTEGER)],
      );
      if (!rows.length) return;
      const page = rows.map(bar);
      yield page;
      if (page.length < PAGE_BARS) return;
      after = page.at(-1)!.time;
    }
  }

  /** Recomputes the UTC times of every saved bar on a broker server from its broker seconds, in one transaction. */
  recomputeUtc(brokerServer: string, rule: ClockRule): Promise<void> {
    return this.serial(async () => {
      const span = (
        await this.connection.runAndReadAll(
          "SELECT min(broker_seconds) AS first, max(broker_seconds) AS last FROM saved_bars WHERE market_id IN (SELECT id FROM markets WHERE broker_server = $1)",
          [brokerServer],
        )
      ).getRowObjectsJS()[0];
      if (span?.first === null || span?.first === undefined) return;
      const offset = offsetMinutesSql(rule, Number(span.first), Number(span.last));
      await this.connection.run("BEGIN TRANSACTION");
      try {
        await this.connection.run(
          `UPDATE saved_bars SET utc_seconds = broker_seconds - (${offset}) * 60 WHERE market_id IN (SELECT id FROM markets WHERE broker_server = $1)`,
          [brokerServer],
        );
        await this.connection.run("COMMIT");
      } catch (e) {
        await this.connection.run("ROLLBACK");
        throw e;
      }
    });
  }

  /** Resolves once the pending jobs are done. */
  async settled(): Promise<void> {
    await this.work;
  }

  close() {
    this.connection.closeSync();
  }

  private read(sql: string, values?: (string | number | bigint)[]) {
    return this.serial(async () => (await this.connection.runAndReadAll(sql, values)).getRowObjectsJS());
  }

  private serial<T>(job: () => Promise<T>): Promise<T> {
    const next = this.work.then(job);
    this.work = next.catch(() => {});
    return next;
  }
}

function bar(row: Record<string, unknown>): HstBar {
  return {
    time: Number(row.broker_seconds),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    tickVolume: Number(row.tick_volume),
    spread: Number(row.spread),
    realVolume: Number(row.real_volume),
  };
}
