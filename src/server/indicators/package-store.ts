// Installed indicator packages, kept in DuckDB: one version per id, with its hash, its four files, whether it is
// enabled and when it was installed. The bundled packages are not stored (only whether each is enabled, in settings).
import type { DuckDBConnection } from "@duckdb/node-api";
import type { PackageFiles } from "./packages.js";

export type StoredPackage = { id: string; version: string; hash: string; files: PackageFiles; enabled: boolean; installedAt: number };

export type InstalledPackageStore = {
  /** Oldest first. */
  list(): Promise<StoredPackage[]>;
  /** Installs the package, replacing any of its id. */
  put(p: StoredPackage): Promise<void>;
  delete(id: string): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
};

/** The store in DuckDB, on a connection of its own; one statement at a time. */
export class DuckDbPackageStore implements InstalledPackageStore {
  private work: Promise<unknown> = Promise.resolve();

  constructor(private readonly connection: DuckDBConnection) {}

  async list(): Promise<StoredPackage[]> {
    const rows = await this.serial(async () =>
      (await this.connection.runAndReadAll("SELECT id, version, hash, manifest, calculate, readme, licence, enabled, installed_at FROM indicator_packages ORDER BY installed_at, id")).getRowObjectsJS(),
    );
    return rows.map((row) => ({
      id: String(row.id),
      version: String(row.version),
      hash: String(row.hash),
      files: { "manifest.json": String(row.manifest), "calculate.js": String(row.calculate), "README.md": String(row.readme), LICENSE: String(row.licence) },
      enabled: row.enabled === true,
      installedAt: Number(row.installed_at),
    }));
  }

  put(p: StoredPackage): Promise<void> {
    return this.serial(async () => {
      await this.connection.run(
        `INSERT INTO indicator_packages (id, version, hash, manifest, calculate, readme, licence, enabled, installed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO UPDATE SET version = excluded.version, hash = excluded.hash, manifest = excluded.manifest, calculate = excluded.calculate,
           readme = excluded.readme, licence = excluded.licence, enabled = excluded.enabled, installed_at = excluded.installed_at`,
        [p.id, p.version, p.hash, p.files["manifest.json"], p.files["calculate.js"], p.files["README.md"], p.files.LICENSE, p.enabled, BigInt(p.installedAt)],
      );
    });
  }

  delete(id: string): Promise<void> {
    return this.serial(async () => void (await this.connection.run("DELETE FROM indicator_packages WHERE id = $1", [id])));
  }

  setEnabled(id: string, enabled: boolean): Promise<void> {
    return this.serial(async () => void (await this.connection.run("UPDATE indicator_packages SET enabled = $1 WHERE id = $2", [enabled, id])));
  }

  /** Resolves once the statements under way are done. */
  settled(): Promise<void> {
    return this.work.then(() => undefined);
  }

  close() {
    this.connection.closeSync();
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.work.then(run);
    this.work = next.catch(() => undefined);
    return next;
  }
}

/** The store in memory only: a server without a database. */
export function memoryPackageStore(): InstalledPackageStore {
  const rows = new Map<string, StoredPackage>();
  return {
    list: async () => [...rows.values()],
    put: async (p) => void rows.set(p.id, p),
    delete: async (id) => void rows.delete(id),
    setEnabled: async (id, enabled) => {
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, enabled });
    },
  };
}
