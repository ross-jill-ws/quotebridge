// API keys for the CLI and scripts: `qbk_` + 64 hex characters (32 random bytes), shown once when created. Only the
// SHA-256 is stored (schema version 5): the keys are random, so a fast hash is safe, and legacy keys import unchanged
// in milestone 6 (ADR 5's scrypt is for the low-entropy password). Scope `read` reads; `trade` also sends changes.
// Keys are created and revoked from the app window only; the HTTP server checks the Bearer header against them.
import type { DuckDBConnection } from "@duckdb/node-api";
import { createHash, randomBytes } from "node:crypto";

export type ApiKeyScope = "read" | "trade";

/** A key as listed: never the key itself. Times are UTC epoch milliseconds. */
export type ApiKeyView = { id: string; name: string; scope: ApiKeyScope; prefix: string; createdAt: number; lastUsedAt: number | null };

/** A key's check: valid, or why not. */
export type KeyCheck = { ok: true; key: ApiKeyView } | { ok: false; status: 401 | 403; error: string };

export const KEY_PATTERN = /^qbk_[0-9a-f]{64}$/;
export const MAX_KEY_NAME = 60;
/** The listed prefix: `qbk_` and 8 hex characters, as the legacy app shows it. */
const PREFIX_LENGTH = 12;
/** A key's last use is written at most this often; the list shows it from memory. */
const LAST_USED_WRITE_MS = 60_000;

/** A request the user can fix; `status` is the HTTP status to answer with. */
export class ApiKeyRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A key as stored. */
export type StoredApiKey = ApiKeyView & { hash: string };

type Cached = StoredApiKey & { written: number | null };

const sha256 = (key: string) => createHash("sha256").update(key).digest("hex");

/** The keys in the database, on a connection of their own, one job at a time. */
export class ApiKeyStore {
  private work: Promise<unknown> = Promise.resolve();

  constructor(private readonly connection: DuckDBConnection) {}

  /** The keys not revoked, oldest first. */
  async active(): Promise<StoredApiKey[]> {
    const rows = await this.serial(async () =>
      (
        await this.connection.runAndReadAll("SELECT id, name, scope, prefix, hash, created_at, last_used_at FROM api_keys WHERE revoked_at IS NULL ORDER BY created_at, id")
      ).getRowObjectsJS(),
    );
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      scope: row.scope === "trade" ? "trade" : "read",
      prefix: String(row.prefix),
      hash: String(row.hash),
      createdAt: Number(row.created_at),
      lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
    }));
  }

  add(k: StoredApiKey): Promise<void> {
    return this.serial(async () => {
      await this.connection.run("INSERT INTO api_keys (id, name, scope, prefix, hash, created_at) VALUES ($1, $2, $3, $4, $5, $6)", [k.id, k.name, k.scope, k.prefix, k.hash, BigInt(k.createdAt)]);
    });
  }

  revoke(id: string, at: number): Promise<void> {
    return this.serial(async () => {
      await this.connection.run("UPDATE api_keys SET revoked_at = $1 WHERE id = $2", [BigInt(at), id]);
    });
  }

  used(id: string, at: number): Promise<void> {
    return this.serial(async () => {
      await this.connection.run("UPDATE api_keys SET last_used_at = $1 WHERE id = $2", [BigInt(at), id]);
    });
  }

  /** Resolves once the pending writes are done. */
  async settled(): Promise<void> {
    await this.work;
  }

  close() {
    this.connection.closeSync();
  }

  private serial<T>(job: () => Promise<T>): Promise<T> {
    const next = this.work.then(job);
    this.work = next.catch(() => {});
    return next;
  }
}

export class ApiKeys {
  /** The keys not revoked, by hash. */
  private readonly keys = new Map<string, Cached>();

  private constructor(
    private readonly store: ApiKeyStore,
    private readonly now: () => number,
  ) {}

  static async open(store: ApiKeyStore, now: () => number = Date.now): Promise<ApiKeys> {
    const keys = new ApiKeys(store, now);
    for (const k of await store.active()) keys.keys.set(k.hash, { ...k, written: k.lastUsedAt });
    return keys;
  }

  /** The keys not revoked, oldest first. */
  list(): ApiKeyView[] {
    return [...this.keys.values()].map(view);
  }

  /** Makes a key; the answer is the only time the key itself is handed out. */
  async create(request: unknown): Promise<{ key: string; apiKey: ApiKeyView }> {
    const { name, scope } = (request ?? {}) as { name?: unknown; scope?: unknown };
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!trimmed || trimmed.length > MAX_KEY_NAME) throw new ApiKeyRequestError(400, `Name the key (up to ${MAX_KEY_NAME} characters).`);
    if (scope !== "read" && scope !== "trade") throw new ApiKeyRequestError(400, 'The scope must be "read" or "trade".');
    const key = `qbk_${randomBytes(32).toString("hex")}`;
    const stored: Cached = {
      id: randomBytes(8).toString("hex"),
      name: trimmed,
      scope,
      prefix: key.slice(0, PREFIX_LENGTH),
      hash: sha256(key),
      createdAt: this.now(),
      lastUsedAt: null,
      written: null,
    };
    await this.store.add(stored);
    this.keys.set(stored.hash, stored);
    return { key, apiKey: view(stored) };
  }

  /** Revokes a key at once and answers the list. */
  async revoke(request: unknown): Promise<ApiKeyView[]> {
    const id = ((request ?? {}) as { id?: unknown }).id;
    const stored = [...this.keys.values()].find((k) => k.id === id);
    if (!stored) throw new ApiKeyRequestError(404, "No such key. It may have been revoked already.");
    this.keys.delete(stored.hash);
    await this.store.revoke(stored.id, this.now());
    return this.list();
  }

  /** Checks a Bearer key for a request that `writes` (anything but GET and HEAD), noting its use. */
  check(key: string, writes: boolean): KeyCheck {
    const stored = KEY_PATTERN.test(key) ? this.keys.get(sha256(key)) : undefined;
    if (!stored) return { ok: false, status: 401, error: "This API key is not known or has been revoked. Create one in Settings › API keys." };
    if (writes && stored.scope !== "trade") return { ok: false, status: 403, error: "This API key may only read. Create a key with the trade scope to send changes." };
    const now = this.now();
    stored.lastUsedAt = now;
    if (stored.written === null || now - stored.written >= LAST_USED_WRITE_MS) {
      stored.written = now;
      this.store.used(stored.id, now).catch((e) => console.error("An API key's last use could not be written", e));
    }
    return { ok: true, key: view(stored) };
  }
}

function view({ id, name, scope, prefix, createdAt, lastUsedAt }: Cached): ApiKeyView {
  return { id, name, scope, prefix, createdAt, lastUsedAt };
}
