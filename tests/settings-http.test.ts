// The Settings view's endpoints on the real server: GET and POST /api/settings with a settings store
// in a temp folder. The server stays the single writer; each save is handed on (to main) like Setup's.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerConfig } from "../src/server/index.js";
import type { SettingsView } from "../src/server/settings/index.js";
import { SettingsStore, type Settings } from "../src/shared/settings-store.js";
import { freePort } from "./free-port.js";

const TOKEN = "window-token-0123456789";

async function start(t: TestContext, options: { withSettings?: boolean } = {}) {
  const folder = await mkdtemp(join(tmpdir(), "quotebridge-settings-http-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const store = new SettingsStore(folder);
  const saved: Settings[] = [];
  const cfg: ServerConfig = {
    eaPort: await freePort(),
    httpPort: await freePort(),
    windowToken: TOKEN,
    ...(options.withSettings === false ? {} : { settings: { store, onSaved: (s: Settings) => void saved.push(s) } }),
  };
  // The saved ports are the ones this server runs on, as in the app.
  await store.update((s) => void (s.ports = { ea: cfg.eaPort, http: cfg.httpPort }));
  const server = await startServer(cfg);
  t.after(() => server.close());
  const origin = server.httpOrigin;
  const res = await fetch(`${origin}/session?token=${TOKEN}`, { redirect: "manual" });
  const cookie = res.headers.get("set-cookie")!.split(";")[0];
  const get = async () => {
    const r = await fetch(`${origin}/api/settings`, { headers: { cookie } });
    return { status: r.status, body: (await r.json()) as SettingsView & { error?: string } };
  };
  const post = async (body: unknown) => {
    const r = await fetch(`${origin}/api/settings`, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as SettingsView & { error?: string } };
  };
  return { cfg, store, saved, get, post };
}

test("GET /api/settings answers the saved settings the view shows and the ports this server runs on", async (t) => {
  const { cfg, get } = await start(t);

  const { status, body } = await get();

  assert.equal(status, 200);
  assert.deepEqual(body, {
    startWithWindows: true,
    openWindowAtStartup: false,
    theme: "system",
    ports: { ea: cfg.eaPort, http: cfg.httpPort },
    portsInUse: { ea: cfg.eaPort, http: cfg.httpPort },
  });
});

test("a change is saved by the server, answered with the new view and handed on so main applies it", async (t) => {
  const { store, saved, post } = await start(t);

  const { status, body } = await post({ openWindowAtStartup: true, theme: "dark", startWithWindows: false });

  assert.equal(status, 200);
  assert.equal(body.openWindowAtStartup, true);
  assert.equal(body.theme, "dark");
  assert.equal(body.startWithWindows, false);
  const stored = await store.read();
  assert.equal(stored.theme, "dark");
  assert.equal(stored.openWindowAtStartup, true);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].theme, "dark");
});

test("a new port is saved for the next start; the server keeps running on the old one until main restarts it", async (t) => {
  const { cfg, store, saved, post } = await start(t);
  const ea = await freePort();

  const { status, body } = await post({ ports: { ea } });

  assert.equal(status, 200);
  assert.deepEqual(body.ports, { ea, http: cfg.httpPort });
  assert.deepEqual(body.portsInUse, { ea: cfg.eaPort, http: cfg.httpPort });
  assert.deepEqual((await store.read()).ports, { ea, http: cfg.httpPort });
  assert.deepEqual(saved.at(-1)?.ports, { ea, http: cfg.httpPort });
});

test("a port that cannot work is refused with a plain reason and nothing is saved", async (t) => {
  const { cfg, store, saved, post } = await start(t);
  const busy = createServer();
  await new Promise<void>((resolve) => busy.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => busy.close(() => resolve())));
  const busyPort = (busy.address() as { port: number }).port;

  const cases: [unknown, RegExp][] = [
    [{ ports: { ea: 80 } }, /1024 to 65535/],
    [{ ports: { http: 70000 } }, /1024 to 65535/],
    [{ ports: { ea: "6000" } }, /1024 to 65535/],
    [{ ports: { ea: cfg.httpPort } }, /differ/],
    [{ ports: { http: busyPort } }, new RegExp(`${busyPort} is in use`)],
  ];
  for (const [change, reason] of cases) {
    const { status, body } = await post(change);
    assert.equal(status, 400, JSON.stringify(change));
    assert.match(body.error ?? "", reason, JSON.stringify(change));
  }
  assert.deepEqual((await store.read()).ports, { ea: cfg.eaPort, http: cfg.httpPort });
  assert.equal(saved.length, 0);
});

test("only the Settings view's own settings can be changed, with values of the right kind", async (t) => {
  const { store, saved, post } = await start(t);

  for (const change of [{ setupCompleted: false }, { managedTerminals: [] }, { theme: "purple" }, { startWithWindows: "yes" }, [], null]) {
    const { status } = await post(change);
    assert.equal(status, 400, JSON.stringify(change));
  }
  assert.equal((await store.read()).theme, "system");
  assert.equal(saved.length, 0);
});

test("without a settings store the endpoints are not there", async (t) => {
  const { get } = await start(t, { withSettings: false });
  assert.equal((await get()).status, 404);
});
