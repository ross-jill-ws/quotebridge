// API keys over HTTP: created and revoked in Settings › API keys (window session only, ADR 5), and sent by the CLI as
// `Authorization: Bearer qbk_…` to /api/v1 and /api/auth/session. A missing, unknown or revoked key gets 401, a wrong
// scope 403; HTTP Basic is refused; a key reaches nothing else. Real server and database in a temp folder, a fake clock.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, startServer, type ServerConfig } from "../src/server/index.js";
import { FakeClock } from "./fake-ea.js";
import { freePort } from "./free-port.js";

const TOKEN = "window-token-0123456789";
const NOW = Date.UTC(2027, 0, 15, 8);

type ApiKey = { id: string; name: string; scope: "read" | "trade"; prefix: string; createdAt: number; lastUsedAt: number | null };

async function tempFolder(t: TestContext) {
  const folder = await mkdtemp(join(tmpdir(), "quotebridge-keys-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
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
  const create = async (name: string, scope: "read" | "trade") => {
    const res = await window.post("/api/api-keys", { name, scope });
    assert.equal(res.status, 201, await res.clone().text());
    return (await res.json()) as { key: string; apiKey: ApiKey };
  };
  const keys = async () => {
    const res = await window.get("/api/api-keys");
    assert.equal(res.status, 200, await res.clone().text());
    return ((await res.json()) as { keys: ApiKey[] }).keys;
  };
  return { origin, window, cli, create, keys, stop };
}

test("a key is shown once, works as a Bearer key, is listed with its last use, and once revoked gets 401", { timeout: 20000 }, async (t) => {
  const folder = await tempFolder(t);
  const clock = new FakeClock(NOW);
  const app = await start(t, folder, clock);

  const { key, apiKey } = await app.create("Laptop CLI", "read");
  assert.match(key, /^qbk_[0-9a-f]{64}$/);
  assert.deepEqual({ ...apiKey, id: "" }, { id: "", name: "Laptop CLI", scope: "read", prefix: key.slice(0, 12), createdAt: NOW, lastUsedAt: null });
  const listed = await app.window.get("/api/api-keys");
  assert.ok(!(await listed.clone().text()).includes(key.slice(12)), "the key is never shown again");
  assert.deepEqual(await app.keys(), [apiKey]);

  clock.advance(60_000);
  const session = await app.cli(key, "/api/auth/session");
  assert.equal(session.status, 200, await session.clone().text());
  const body = (await session.json()) as { username: unknown; key: unknown; expires: unknown };
  assert.equal(typeof body.username, "string");
  assert.deepEqual(body.key, { name: "Laptop CLI", prefix: key.slice(0, 12), scope: "read" });
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
  const { key } = await app.create("Trading bot", "trade");
  assert.equal((await app.cli(key, "/api/api-keys")).status, 403);
  const create = await app.cli(key, "/api/api-keys", { method: "POST", headers: { origin: app.origin, "content-type": "application/json" }, body: JSON.stringify({ name: "x", scope: "trade" }) });
  assert.equal(create.status, 403);
  assert.equal((await app.cli(key, "/api/state")).status, 403);
  assert.equal((await app.cli(key, "/")).status, 403);
  assert.deepEqual((await app.keys()).map((k) => k.name), ["Trading bot"], "no key was made");
});

test("a read key only reads; a trade key may also send changes; a wrong scope gets 403", { timeout: 15000 }, async (t) => {
  const app = await start(t, await tempFolder(t));
  const read = (await app.create("Reader", "read")).key;
  const trade = (await app.create("Trader", "trade")).key;
  const order = (key: string) => app.cli(key, "/api/v1/orders/preview", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal((await order(read)).status, 403);
  assert.equal((await order(trade)).status, 404, "past the scope check, nothing answers yet");
  assert.equal((await app.cli(trade, "/api/v1/nothing-here")).status, 404, "trade implies read");
});

test("key requests that cannot work are refused", { timeout: 15000 }, async (t) => {
  const app = await start(t, await tempFolder(t));
  assert.equal((await app.window.post("/api/api-keys", { name: "CLI", scope: "admin" })).status, 400);
  assert.equal((await app.window.post("/api/api-keys", { name: "  ", scope: "read" })).status, 400);
  assert.equal((await app.window.post("/api/api-keys", { name: "x".repeat(61), scope: "read" })).status, 400);
  assert.equal((await app.window.post("/api/api-keys/revoke", { id: "nope" })).status, 404);
  const { apiKey } = await app.create("  Spaced  ", "read");
  assert.equal(apiKey.name, "Spaced");
});
