// The app's DuckDB database in the data folder: the schema-version table, then each migration in order.
// Schema version 2 (milestone 3) adds clock rules per broker server (ADR 11). The WAL is never deleted or rewritten:
// if CHECKPOINT does not happen, DuckDB replays the WAL on the next open.
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { duckDbClockRuleStore, type ClockRuleStore } from "./clock/index.js";

export const DATABASE_FILE_NAME = "quotebridge.duckdb";

/** Migration n brings the schema from version n + 1 to n + 2; version 1 is the schema-version table alone. */
const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE clock_rules (
      broker_server VARCHAR PRIMARY KEY,
      winter_offset_minutes INTEGER NOT NULL,
      dst VARCHAR NOT NULL,
      source VARCHAR NOT NULL,
      last_observed_offset INTEGER,
      last_observed_at BIGINT
    )`,
  ],
];

export const SCHEMA_VERSION = 1 + MIGRATIONS.length;

export class DatabaseError extends Error {
  readonly code = "database";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DatabaseError";
  }
}

export type AppDatabase = {
  file: string;
  schemaVersion: number;
  /** Clock rules per broker server. */
  clockRules: ClockRuleStore;
  /** CHECKPOINT, then close. Closes even when CHECKPOINT fails (the WAL then stays for replay) and rethrows. */
  checkpointAndClose(): Promise<void>;
};

export async function openDatabase(dataFolder: string): Promise<AppDatabase> {
  const file = join(dataFolder, DATABASE_FILE_NAME);
  let instance: DuckDBInstance | undefined;
  let connection: DuckDBConnection | undefined;
  try {
    await mkdir(dataFolder, { recursive: true });
    instance = await DuckDBInstance.create(file);
    connection = await instance.connect();
    await connection.run("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL, applied_at TIMESTAMP NOT NULL DEFAULT current_timestamp)");
    const rows = (await connection.runAndReadAll("SELECT max(version) AS version FROM schema_version")).getRowObjectsJS();
    let schemaVersion = Number(rows[0]?.version ?? 0);
    if (schemaVersion === 0) {
      await connection.run("INSERT INTO schema_version (version) VALUES (1)");
      schemaVersion = 1;
    }
    if (schemaVersion > SCHEMA_VERSION) throw Error(`it has schema version ${schemaVersion}, newer than this app's ${SCHEMA_VERSION}. Update the app`);
    for (; schemaVersion < SCHEMA_VERSION; schemaVersion++) {
      // A migration and its version row in one transaction: a failed migration leaves the previous version.
      await connection.run("BEGIN TRANSACTION");
      try {
        for (const statement of MIGRATIONS[schemaVersion - 1]) await connection.run(statement);
        await connection.run("INSERT INTO schema_version (version) VALUES ($1)", [schemaVersion + 1]);
        await connection.run("COMMIT");
      } catch (e) {
        await connection.run("ROLLBACK");
        throw e;
      }
    }
    const conn = connection;
    const inst = instance;
    return {
      file,
      schemaVersion,
      clockRules: duckDbClockRuleStore(conn),
      async checkpointAndClose() {
        try {
          await conn.run("CHECKPOINT");
        } catch (e) {
          throw new DatabaseError(`The database could not be checkpointed: ${(e as Error).message}`, { cause: e });
        } finally {
          conn.closeSync();
          inst.closeSync();
        }
      },
    };
  } catch (e) {
    connection?.closeSync();
    instance?.closeSync();
    throw new DatabaseError(`The database ${file} could not be opened: ${(e as Error).message}`, { cause: e });
  }
}
