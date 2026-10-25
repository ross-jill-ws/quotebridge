// The app's DuckDB database in the data folder: the schema-version table, then each migration in order.
// Schema version 2 (milestone 3) adds clock rules per broker server (ADR 11); version 3 markets and their recorded
// samples; version 4 saved history; version 5 API keys; version 6 (milestone 4) installed indicator packages;
// version 7 renames API-key scopes without changing privileges; version 8 remembers account identities only;
// version 9 retains durable trading requests and their evidence indefinitely.
// The WAL is never deleted or rewritten:
// if CHECKPOINT does not happen, DuckDB replays the WAL on the next open.
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ApiKeyStore } from "./auth/index.js";
import { duckDbClockRuleStore, type ClockRuleStore } from "./clock/index.js";
import { SavedBarStore } from "./history/saved-store.js";
import { DuckDbPackageStore } from "./indicators/package-store.js";
import { RecordingStore } from "./recording/index.js";
import { DuckDbIdentityStore } from "./identity/index.js";
import { DuckDbJournalStore } from "./trading/journal.js";

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
  [
    "CREATE SEQUENCE market_ids START 1",
    `CREATE TABLE markets (
      id INTEGER PRIMARY KEY DEFAULT nextval('market_ids'),
      broker_server VARCHAR NOT NULL,
      symbol VARCHAR NOT NULL,
      digits INTEGER,
      recording BOOLEAN NOT NULL DEFAULT false,
      recording_since BIGINT,
      UNIQUE (broker_server, symbol)
    )`,
    `CREATE TABLE samples (
      market_id INTEGER NOT NULL,
      utc_ms BIGINT NOT NULL,
      broker_seconds BIGINT NOT NULL,
      bid DOUBLE NOT NULL,
      ask DOUBLE NOT NULL,
      received_ms BIGINT NOT NULL
    )`,
  ],
  [
    `CREATE TABLE saved_bars (
      market_id INTEGER NOT NULL,
      period VARCHAR NOT NULL,
      utc_seconds BIGINT NOT NULL,
      broker_seconds BIGINT NOT NULL,
      open DOUBLE NOT NULL,
      high DOUBLE NOT NULL,
      low DOUBLE NOT NULL,
      close DOUBLE NOT NULL,
      tick_volume BIGINT NOT NULL,
      spread INTEGER NOT NULL,
      real_volume BIGINT NOT NULL,
      PRIMARY KEY (market_id, period, broker_seconds)
    )`,
  ],
  [
    `CREATE TABLE api_keys (
      id VARCHAR PRIMARY KEY,
      name VARCHAR NOT NULL,
      scope VARCHAR NOT NULL,
      prefix VARCHAR NOT NULL,
      hash VARCHAR NOT NULL UNIQUE,
      created_at BIGINT NOT NULL,
      last_used_at BIGINT,
      revoked_at BIGINT
    )`,
  ],
  [
    `CREATE TABLE indicator_packages (
      id VARCHAR PRIMARY KEY,
      version VARCHAR NOT NULL,
      hash VARCHAR NOT NULL,
      manifest VARCHAR NOT NULL,
      calculate VARCHAR NOT NULL,
      readme VARCHAR NOT NULL,
      licence VARCHAR NOT NULL,
      enabled BOOLEAN NOT NULL,
      installed_at BIGINT NOT NULL
    )`,
  ],
  [
    // Rename only known legacy scopes, including revoked keys. Unknown scopes must never acquire privileges.
    "UPDATE api_keys SET scope = CASE scope WHEN 'read' THEN 'readonly' WHEN 'trade' THEN 'trader' END WHERE scope IN ('read', 'trade')",
  ],
  [
    `CREATE TABLE account_identities (
      id VARCHAR PRIMARY KEY,
      broker_server VARCHAR NOT NULL,
      login VARCHAR NOT NULL,
      label VARCHAR NOT NULL,
      UNIQUE (broker_server, login)
    )`,
  ],
  [
    `CREATE TABLE trading_journal (
      id VARCHAR PRIMARY KEY,
      account_id VARCHAR NOT NULL,
      created_at BIGINT NOT NULL,
      record VARCHAR NOT NULL
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
  /** Markets and their recorded samples. */
  recordings: RecordingStore;
  /** Saved history, on a connection of its own. */
  savedBars: SavedBarStore;
  /** API keys, on a connection of their own. */
  apiKeys: ApiKeyStore;
  /** Installed indicator packages, on a connection of their own. */
  indicatorPackages: DuckDbPackageStore;
  /** Known account identities only, on a connection of their own (no financial snapshots). */
  identities: DuckDbIdentityStore;
  /** Durable trading requests, on a dedicated serialized connection. No in-memory fallback. */
  journal: DuckDbJournalStore;
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
    const savedBars = new SavedBarStore(await inst.connect());
    const apiKeys = new ApiKeyStore(await inst.connect());
    const indicatorPackages = new DuckDbPackageStore(await inst.connect());
    const identities = new DuckDbIdentityStore(await inst.connect());
    const journal = new DuckDbJournalStore(await inst.connect());
    return {
      file,
      schemaVersion,
      clockRules: duckDbClockRuleStore(conn),
      recordings: new RecordingStore(conn),
      savedBars,
      apiKeys,
      indicatorPackages,
      identities,
      journal,
      async checkpointAndClose() {
        try {
          await journal.settled();
          await identities.settled();
          await apiKeys.settled();
          await indicatorPackages.settled();
          await savedBars.settled();
          await conn.run("CHECKPOINT");
        } catch (e) {
          throw new DatabaseError(`The database could not be checkpointed: ${(e as Error).message}`, { cause: e });
        } finally {
          journal.close();
          identities.close();
          apiKeys.close();
          indicatorPackages.close();
          savedBars.close();
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
