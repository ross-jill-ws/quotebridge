// API keys over HTTP: created and revoked in Settings › API keys (window session only, ADR 5), and sent by the CLI as
// `Authorization: Bearer qbk_…` to /api/v1 and /api/auth/session. A missing, unknown or revoked key gets 401, a wrong
// scope 403; HTTP Basic is refused; a key reaches nothing else. Real server and database in a temp folder, a fake clock.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { DuckDBInstance } from "@duckdb/node-api";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, startServer, type ServerConfig } from "../src/server/index.js";
import { FakeClock } from "./fake-ea.js";
import { freePort } from "./free-port.js";
import { SettingsStore } from "../src/shared/settings-store.js";
import { InstallerFixture } from "./installer-fixtures.js";
import { MachineFixture } from "./terminal-fixtures.js";

const TOKEN = "window-token-0123456789";
const NOW = Date.UTC(2027, 0, 15, 8);

type ApiKey = { id: string; name: string; scope: "readonly" | "trader"; prefix: string; createdAt: number; lastUsedAt: number | null };

async function tempFolder(t: TestContext) {
  const folder = await mkdtemp(join(tmpdir(), "quotebridge-keys-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

/** Seed the real, pre-migration persistence boundary, not the current app's key-creation interface. */
async function legacyDatabase(folder: string, scopes: string[], revokedIndices: number[] = []) {
  const instance = await DuckDBInstance.create(join(folder, "quotebridge.duckdb"));
  const connection = await instance.connect();
  try {
    await connection.run(await readFile(new URL("./fixtures/api-keys-v6.sql", import.meta.url), "utf8"));
    const stored: { key: string; id: string }[] = [];
    for (const [i, scope] of scopes.entries()) {
      const key = `qbk_${String(i + 1).padStart(64, "0")}`;
      const id = `legacy-${i}`;
      const revokedAt = revokedIndices.includes(i) ? NOW - 1000 : null;
      await connection.run("INSERT INTO api_keys (id, name, scope, prefix, hash, created_at, last_used_at, revoked_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [id, `Stored ${i}`, scope, key.slice(0, 12), createHash("sha256").update(key).digest("hex"), BigInt(NOW - 10_000 + i), BigInt(NOW - 5000), revokedAt === null ? null : BigInt(revokedAt)]);
      stored.push({ key, id });
    }
    return stored;
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

async function start(t: TestContext, folder: string, clock = new FakeClock(NOW), overrides: Partial<ServerConfig> = {}) {
  const database = await openDatabase(folder);
  const cfg: ServerConfig = { eaPort: await freePort(), httpPort: await freePort(), windowToken: TOKEN, now: clock.now, localOffsetMinutes: () => 0, database, ...overrides };
  const server = await startServer(cfg);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await server.close();
    await database.checkpointAndClose();
  };
  t.after(stop);
  const origin = server.httpOrigin;
  const signIn = await fetch(`${origin}/session?token=${TOKEN}`, { redirect: "manual" });
  const cookie = signIn.headers.get("set-cookie")!.split(";")[0];
  /** As the app window. */
  const window = {
    get: (path: string) => fetch(`${origin}${path}`, { headers: { cookie } }),
    post: (path: string, body: unknown) =>
      fetch(`${origin}${path}`, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify(body) }),
  };
  /** As the CLI: no cookie, no origin. */
  const cli = (key: string, path: string, init: RequestInit = {}) =>
    fetch(`${origin}${path}`, { ...init, headers: { authorization: `Bearer ${key}`, ...(init.headers as Record<string, string>) } });
  const create = async (name: string, scope: ApiKey["scope"]) => {
    const res = await window.post("/api/api-keys", { name, scope });
    assert.equal(res.status, 201, await res.clone().text());
    return (await res.json()) as { key: string; apiKey: ApiKey };
  };
  const keys = async () => {
    const res = await window.get("/api/api-keys");
    assert.equal(res.status, 200, await res.clone().text());
    return ((await res.json()) as { keys: ApiKey[] }).keys;
  };
  const remote = async () => {
    const token = "remote-token-0123456789";
    server.addRemoteToken(token);
    const signIn = await fetch(`${origin}/session?token=${token}`, { redirect: "manual" });
    assert.equal(signIn.status, 303);
    const cookie = signIn.headers.get("set-cookie")!.split(";")[0];
    return {
      get: (path: string) => fetch(`${origin}${path}`, { headers: { cookie } }),
      post: (path: string, body: unknown) => fetch(`${origin}${path}`, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify(body) }),
    };
  };
  return { origin, window, remote, cli, create, keys, stop };
}

test("a key is shown once, works as a Bearer key, is listed with its last use, and once revoked gets 401", { timeout: 20000 }, async (t) => {
  const folder = await tempFolder(t);
  const clock = new FakeClock(NOW);
  const app = await start(t, folder, clock);

  const { key, apiKey } = await app.create("Laptop CLI", "readonly");
  assert.match(key, /^qbk_[0-9a-f]{64}$/);
  assert.deepEqual({ ...apiKey, id: "" }, { id: "", name: "Laptop CLI", scope: "readonly", prefix: key.slice(0, 12), createdAt: NOW, lastUsedAt: null });
  const listed = await app.window.get("/api/api-keys");
  assert.ok(!(await listed.clone().text()).includes(key.slice(12)), "the key is never shown again");
  assert.deepEqual(await app.keys(), [apiKey]);

  clock.advance(60_000);
  const session = await app.cli(key, "/api/auth/session");
  assert.equal(session.status, 200, await session.clone().text());
  const body = (await session.json()) as { username: unknown; key: unknown; expires: unknown };
  assert.equal(typeof body.username, "string");
  assert.deepEqual(body.key, { name: "Laptop CLI", prefix: key.slice(0, 12), scope: "readonly" });
  assert.equal(body.expires, null);
  assert.equal((await app.keys())[0].lastUsedAt, NOW + 60_000);
  assert.equal((await app.cli(key, "/api/v1/nothing-here")).status, 404, "past the key check, nothing answers yet");

  // Kept across a restart: only its hash is stored, and that is enough.
  await app.stop();
  const again = await start(t, folder, clock);
  assert.equal((await again.cli(key, "/api/auth/session")).status, 200);
  assert.deepEqual((await again.keys()).map((k) => k.name), ["Laptop CLI"]);

  const revoke = await again.window.post("/api/api-keys/revoke", { id: apiKey.id });
  assert.equal(revoke.status, 200, await revoke.clone().text());
  assert.deepEqual(((await revoke.json()) as { keys: ApiKey[] }).keys, []);
  assert.equal((await again.cli(key, "/api/auth/session")).status, 401);
  assert.equal((await again.cli(key, "/api/v1/nothing-here")).status, 401);
});

test("without a key or with a wrong one /api/v1 answers 401; HTTP Basic is refused", { timeout: 15000 }, async (t) => {
  const app = await start(t, await tempFolder(t));
  assert.equal((await fetch(`${app.origin}/api/v1/symbols`)).status, 401);
  assert.equal((await fetch(`${app.origin}/api/auth/session`)).status, 401);
  assert.equal((await app.cli(`qbk_${"0".repeat(64)}`, "/api/v1/symbols")).status, 401, "unknown key");
  assert.equal((await app.cli("qbk_short", "/api/v1/symbols")).status, 401, "not a key");
  const basic = await fetch(`${app.origin}/api/v1/symbols`, { headers: { authorization: `Basic ${Buffer.from("admin:secret").toString("base64")}` } });
  assert.equal(basic.status, 401);
  assert.match(((await basic.json()) as { error: string }).error, /Bearer/);
  assert.equal((await app.window.get("/api/v1/nothing-here")).status, 404, "the window session reaches /api/v1 too");
});

test("a Bearer key cannot reach the key endpoints, the dashboard or the other endpoints", { timeout: 15000 }, async (t) => {
  const app = await start(t, await tempFolder(t));
  const { key } = await app.create("Trading bot", "trader");
  assert.equal((await app.cli(key, "/api/api-keys")).status, 403);
  const create = await app.cli(key, "/api/api-keys", { method: "POST", headers: { origin: app.origin, "content-type": "application/json" }, body: JSON.stringify({ name: "x", scope: "trader" }) });
  assert.equal(create.status, 403);
  assert.equal((await app.cli(key, "/api/state")).status, 403);
  assert.equal((await app.cli(key, "/")).status, 403);
  assert.deepEqual((await app.keys()).map((k) => k.name), ["Trading bot"], "no key was made");
});

test("a remote browser can read but cannot list, create or revoke API keys", { timeout: 15000 }, async (t) => {
  const app = await start(t, await tempFolder(t));
  const { key, apiKey } = await app.create("Window-owned key", "trader");
  const remote = await app.remote();
  assert.equal((await remote.get("/api/state")).status, 200, "authenticated remote session");
  assert.equal((await remote.get("/api/api-keys")).status, 403);
  assert.equal((await remote.post("/api/api-keys", { name: "Remote-created key", scope: "trader" })).status, 403);
  assert.equal((await remote.post("/api/api-keys/revoke", { id: apiKey.id })).status, 403);
  assert.deepEqual(await app.keys(), [apiKey]);
  assert.equal((await app.cli(key, "/api/auth/session")).status, 200, "the key was not revoked");
});

test("administration remains app-window-only for remote browsers and trader keys", { timeout: 20000 }, async (t) => {
  const folder = await tempFolder(t);
  const settings = new SettingsStore(folder);
  const bundle = await InstallerFixture.create();
  t.after(() => bundle.cleanup());
  const machine = await MachineFixture.create();
  t.after(() => machine.dispose());
  await machine.folder(machine.dataRoot);
  await machine.folder(machine.programFiles);
  const app = await start(t, folder, new FakeClock(NOW), {
    settings: { store: settings, onSaved: () => {} },
    terminals: {
      appDataFolder: folder, settings, bundle: await bundle.bundle(),
      sources: async () => ({ dataRoot: machine.dataRoot, installationRoots: [machine.programFiles], userAddedFolders: [] }),
      onSettingsSaved: () => {},
    },
  });
  const remote = await app.remote();
  const { key } = await app.create("Trader", "trader");
  for (const path of ["/api/settings", "/api/terminals"]) {
    assert.equal((await remote.get(path)).status, 200, "remote diagnostics remain readable");
  }
  const before = await settings.read();
  for (const path of ["/api/settings", "/api/setup", "/api/terminals/rescan", "/api/terminals/add-folder", "/api/terminals/install", "/api/terminals/remove", "/api/terminals/decline", "/api/clock-rules", "/api/recordings/delete", "/api/markets/recording", "/api/history/save", "/api/feeds/remove"]) {
    assert.equal((await remote.post(path, { ports: { http: await freePort() } })).status, 403, `remote: ${path}`);
    assert.equal((await app.cli(key, path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 403, `trader: ${path}`);
  }
  assert.deepEqual(await settings.read(), before, "no administrative changes were saved");
});

test("readonly denies every mutation including preview, execute and review; trader includes reads and changes", { timeout: 15000 }, async (t) => {
  const app = await start(t, await tempFolder(t));
  const readonly = (await app.create("Reader", "readonly")).key;
  const trader = (await app.create("Trader", "trader")).key;
  const change = (key: string, path: string, method = "POST") => app.cli(key, path, { method, headers: { "content-type": "application/json" }, body: "{}" });
  for (const path of ["/api/v1/requests/preview", "/api/v1/requests/request-id/execute", "/api/v1/requests/request-id/review", "/api/v1/orders/preview"]) {
    assert.equal((await change(readonly, path)).status, 403, path);
  }
  for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS"]) {
    assert.equal((await change(readonly, "/api/v1/requests/request-id", method)).status, 403, method);
  }
  assert.equal((await change(trader, "/api/v1/orders/preview")).status, 501, "past authorization: the request engine is not implemented yet");
  for (const key of [readonly, trader]) {
    assert.equal((await app.cli(key, "/api/v1/symbols")).status, 200, "both scopes can read");
    assert.equal((await app.cli(key, "/api/v1/symbols", { method: "HEAD" })).status, 200, "HEAD is read-only");
  }
  const session = await app.cli(trader, "/api/auth/session");
  assert.equal(((await session.json()) as { key: { scope: string } }).key.scope, "trader");
});

test("stored legacy scopes migrate without changing secrets, metadata, revocation or privileges, and survive restart", { timeout: 20000 }, async (t) => {
  const folder = await tempFolder(t);
  const stored = await legacyDatabase(folder, ["read", "trade", "trade", "readonly", "trader"], [2]);
  const app = await start(t, folder);
  assert.deepEqual(await app.keys(), [
    { id: "legacy-0", name: "Stored 0", scope: "readonly", prefix: stored[0].key.slice(0, 12), createdAt: NOW - 10_000, lastUsedAt: NOW - 5000 },
    { id: "legacy-1", name: "Stored 1", scope: "trader", prefix: stored[1].key.slice(0, 12), createdAt: NOW - 9999, lastUsedAt: NOW - 5000 },
    { id: "legacy-3", name: "Stored 3", scope: "readonly", prefix: stored[3].key.slice(0, 12), createdAt: NOW - 9997, lastUsedAt: NOW - 5000 },
    { id: "legacy-4", name: "Stored 4", scope: "trader", prefix: stored[4].key.slice(0, 12), createdAt: NOW - 9996, lastUsedAt: NOW - 5000 },
  ]);
  const assertPermissions = async (active: typeof app) => {
    assert.equal((await active.cli(stored[0].key, "/api/auth/session")).status, 200, "the original reader secret still works");
    assert.equal((await active.cli(stored[0].key, "/api/v1/requests/preview", { method: "POST" })).status, 403, "read is not upgraded to trader");
    assert.equal((await active.cli(stored[1].key, "/api/v1/orders/preview", { method: "POST" })).status, 501, "the original trader secret retains mutation access");
    assert.equal((await active.cli(stored[2].key, "/api/auth/session")).status, 401, "a revoked key stays revoked");
    assert.deepEqual((await active.keys()).map(({ scope }) => scope), ["readonly", "trader", "readonly", "trader"]);
  };
  await assertPermissions(app);
  await app.stop();
  await assertPermissions(await start(t, folder));
});

test("unknown stored scopes fail closed for reads and mutations, rather than becoming readonly", { timeout: 20000 }, async (t) => {
  const folder = await tempFolder(t);
  const stored = await legacyDatabase(folder, ["admin", "READONLY", "readwrite", "", "readonly ", "trader ", "Trade", "READ"]);
  const app = await start(t, folder);
  for (const { key } of stored) {
    assert.equal((await app.cli(key, "/api/auth/session")).status, 401);
    assert.equal((await app.cli(key, "/api/v1/symbols")).status, 401);
    assert.equal((await app.cli(key, "/api/v1/requests/review", { method: "POST" })).status, 401);
  }
  assert.deepEqual(await app.keys(), [], "invalid scopes are not presented as usable keys");
});

test("key requests that cannot work are refused", { timeout: 15000 }, async (t) => {
  const app = await start(t, await tempFolder(t));
  for (const scope of ["read", "trade", "admin", "READONLY", "readonly ", "trader ", "", null, ["trader"]]) {
    const response = await app.window.post("/api/api-keys", { name: "CLI", scope });
    assert.equal(response.status, 400, `invalid creation scope: ${JSON.stringify(scope)}`);
    assert.match(((await response.json()) as { error: string }).error, /"readonly" or "trader"/);
  }
  assert.deepEqual(await app.keys(), [], "invalid creation scopes never create a key");
  assert.equal((await app.window.post("/api/api-keys", { name: "  ", scope: "readonly" })).status, 400);
  assert.equal((await app.window.post("/api/api-keys", { name: "x".repeat(61), scope: "readonly" })).status, 400);
  assert.equal((await app.window.post("/api/api-keys/revoke", { id: "nope" })).status, 404);
  const { apiKey } = await app.create("  Spaced  ", "readonly");
  assert.equal(apiKey.name, "Spaced");
});
