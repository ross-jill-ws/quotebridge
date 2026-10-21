// The app's DuckDB database in the data folder. Milestone 1 holds only the schema-version table,
// which proves native-module packaging and the stop path (ADR 10). The WAL is never deleted or rewritten:
// if CHECKPOINT does not happen, DuckDB replays the WAL on the next open.
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export const DATABASE_FILE_NAME = "quotebridge.duckdb";
export const SCHEMA_VERSION = 1;

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
      await connection.run("INSERT INTO schema_version (version) VALUES ($1)", [SCHEMA_VERSION]);
      schemaVersion = SCHEMA_VERSION;
    }
    const conn = connection;
    const inst = instance;
    return {
      file,
      schemaVersion,
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
