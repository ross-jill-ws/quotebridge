// Clock rules in the app's database: one row per broker server (schema version 2).
import type { DuckDBConnection } from "@duckdb/node-api";
import type { DaylightSaving } from "../../shared/clock.js";
import type { ClockRuleSource, ClockRuleStore, StoredClockRule } from "./clock-rules.js";

export function duckDbClockRuleStore(connection: DuckDBConnection): ClockRuleStore {
  return {
    async load() {
      const result = await connection.runAndReadAll(
        "SELECT broker_server, winter_offset_minutes, dst, source, last_observed_offset, last_observed_at FROM clock_rules",
      );
      return result.getRowObjectsJS().map(
        (row): StoredClockRule => ({
          brokerServer: String(row.broker_server),
          winterOffsetMinutes: Number(row.winter_offset_minutes),
          dst: row.dst as DaylightSaving,
          source: row.source as ClockRuleSource,
          lastObservedOffset: row.last_observed_offset === null ? null : Number(row.last_observed_offset),
          lastObservedAt: row.last_observed_at === null ? null : Number(row.last_observed_at),
        }),
      );
    },
    async save(rule) {
      await connection.run(
        "INSERT OR REPLACE INTO clock_rules (broker_server, winter_offset_minutes, dst, source, last_observed_offset, last_observed_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [rule.brokerServer, rule.winterOffsetMinutes, rule.dst, rule.source, rule.lastObservedOffset, rule.lastObservedAt === null ? null : BigInt(rule.lastObservedAt)],
      );
    },
  };
}
