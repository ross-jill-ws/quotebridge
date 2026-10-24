// Stable public identities, independent of terminal installations and of the recording database's numeric keys.
import { createHash } from "node:crypto";
import type { DuckDBConnection } from "@duckdb/node-api";

/** Human labels are display metadata only: never compare, trim or case-fold them to establish identity. */
export type AccountIdentity = { id: string; brokerServer: string; login: string; label: string };
export type AccountRegistration = { brokerServer: string; login: string; label?: string };

/** Known accounts only. No funds, orders, terminal binding or current connection state belongs in this store.
 * A journal reader can register an account even when no terminal has announced it in this process.
 */
export interface IdentityStore {
  /** Register/reopen an exact broker+login; an omitted label preserves the existing display label. */
  put(account: AccountRegistration): Promise<AccountIdentity>;
  /** Stable ID order; full logins are private data for authenticated surfaces/journal use, not diagnostics. */
  list(): Promise<AccountIdentity[]>;
}

/** Static diagnostics deliberately omit input, database errors and causes (which can contain full logins). */
export class IdentityError extends Error {
  readonly code = "identity";
  constructor() {
    super("Account identity could not be read or stored");
    this.name = "IdentityError";
  }
}

// Versioned, domain-separated, unambiguous tuple encoding. Do not change: these IDs survive a fresh database too.
const opaqueId = (kind: "market" | "account", brokerServer: string, key: string) =>
  `${kind}-${createHash("sha256").update(JSON.stringify(["quotebridge-identity-v1", kind, brokerServer, key]), "utf8").digest("hex")}`;

/** Exact broker server + symbol: casing, suffixes and whitespace are significant. */
export const marketId = (brokerServer: string, symbol: string): string => opaqueId("market", brokerServer, symbol);
/** Exact broker server + canonical decimal login string; never tied to a terminal or a display label. */
export const accountId = (brokerServer: string, login: string): string => opaqueId("account", brokerServer, login);

function registration(account: AccountRegistration): AccountRegistration {
  if (typeof account?.brokerServer !== "string" || !account.brokerServer.length || account.brokerServer.length > 120 || /[\x00-\x1f\x7f-\x9f\ufffd]/.test(account.brokerServer) ||
      typeof account.login !== "string" || !/^[1-9]\d{0,9}$/.test(account.login) || Number(account.login) > 2147483647 ||
      (account.label !== undefined && (typeof account.label !== "string" || account.label.length > 240 || /[\x00-\x1f\x7f-\x9f\ufffd]/.test(account.label)))) throw new IdentityError();
  // Copy an allowlist, never caller-supplied finances or connection metadata.
  return { brokerServer: account.brokerServer, login: account.login, label: account.label };
}

/** One dedicated connection, serialized with shutdown so acknowledged registrations survive restart. */
export class DuckDbIdentityStore implements IdentityStore {
  private work: Promise<unknown> = Promise.resolve();
  constructor(private readonly connection: DuckDBConnection) {}

  async put(account: AccountRegistration): Promise<AccountIdentity> {
    const a = registration(account);
    return this.serial(async () => {
      const id = accountId(a.brokerServer, a.login);
      const rows = (await this.connection.runAndReadAll(
        `INSERT INTO account_identities (id, broker_server, login, label) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET label = coalesce($5, account_identities.label)
         RETURNING id, broker_server, login, label`,
        [id, a.brokerServer, a.login, a.label ?? "", a.label ?? null],
      )).getRowObjectsJS();
      return fromRow(rows[0]);
    });
  }

  list(): Promise<AccountIdentity[]> {
    return this.serial(async () => (await this.connection.runAndReadAll(
      "SELECT id, broker_server, login, label FROM account_identities ORDER BY id",
    )).getRowObjectsJS().map(fromRow));
  }

  settled(): Promise<void> { return this.work.then(() => undefined); }
  close(): void { this.connection.closeSync(); }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.work.then(run).catch(() => { throw new IdentityError(); });
    this.work = next.catch(() => undefined);
    return next;
  }
}

const fromRow = (row: Record<string, unknown>): AccountIdentity => ({
  id: String(row.id), brokerServer: String(row.broker_server), login: String(row.login), label: String(row.label),
});

/** Standalone hosts without a database use the same allowlist, identity and label rules. */
export function memoryIdentityStore(): IdentityStore {
  const accounts = new Map<string, AccountIdentity>();
  return {
    async put(account) {
      const a = registration(account);
      const id = accountId(a.brokerServer, a.login);
      const value = { id, brokerServer: a.brokerServer, login: a.login, label: a.label ?? accounts.get(id)?.label ?? "" };
      accounts.set(id, value);
      return { ...value };
    },
    async list() { return [...accounts.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map((a) => ({ ...a })); },
  };
}
