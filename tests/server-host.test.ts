// Seam 1: the server entry point driven over the server host protocol, as the supervisor will drive it.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inProcessTransportPair, ipcTransport, type HostTransport } from "../src/shared/host-transport.js";
import type { HostMessage, ServerMessage, ServerStartConfig } from "../src/shared/server-host-protocol.js";
import { runServerHost, type ServerHostOptions } from "../src/server/host.js";
import { openDatabase } from "../src/server/database.js";
import { ApiKeys } from "../src/server/auth/index.js";
import { SettingsStore } from "../src/shared/settings-store.js";
import { conditionsWire, deliver, LOGIN, pageWire } from "./account-fixtures.js";
import type { TradingPreview } from "../src/server/trading/types.js";
import { FakeClock, FakeEA } from "./fake-ea.js";
import { terminalIdFor } from "../src/shared/terminal-catalog/index.js";
import { MachineFixture } from "./terminal-fixtures.js";
import { InstallerFixture, SUCCESSFUL_COMPILE } from "./installer-fixtures.js";
import { FakeMetaEditor } from "./metaeditor-fixtures.js";
import { freePort } from "./free-port.js";
import { existsSync } from "node:fs";
import { createServer } from "node:net";

const ENTRY = fileURLToPath(new URL("../src/server/entry.ts", import.meta.url));
const TOKEN = "window-token-0123456789";

/** The host's end of the protocol: sends host messages and waits for server messages by type. */
class Host {
  private readonly inbox: ServerMessage[] = [];
  private waiters: { match: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];

  constructor(readonly transport: HostTransport<ServerMessage, HostMessage>) {
    transport.onMessage((message) => {
      const waiter = this.waiters.find((w) => w.match(message));
      if (waiter) {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        waiter.resolve(message);
      } else this.inbox.push(message);
    });
  }

  send(message: HostMessage) {
    this.transport.send(message);
  }

  /** The next server message of this type (and matching the predicate), received or still to come. */
  next<T extends ServerMessage["type"]>(type: T, predicate: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true, timeoutMs = 5000) {
    const match = (m: ServerMessage) => m.type === type && predicate(m as Extract<ServerMessage, { type: T }>);
    const index = this.inbox.findIndex(match);
    if (index >= 0) return Promise.resolve(this.inbox.splice(index, 1)[0] as Extract<ServerMessage, { type: T }>);
    return new Promise<Extract<ServerMessage, { type: T }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`No "${type}" message within ${timeoutMs} ms`)), timeoutMs);
      this.waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as Extract<ServerMessage, { type: T }>);
        },
      });
    });
  }
}

async function tempDataFolder(t: TestContext) {
  const folder = await mkdtemp(join(tmpdir(), "quotebridge-host-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

async function startConfig(t: TestContext, overrides: Partial<ServerStartConfig> = {}): Promise<ServerStartConfig> {
  return { eaPort: await freePort(), httpPort: await freePort(), windowToken: TOKEN, dataFolder: await tempDataFolder(t), ...overrides };
}

/** A catalog backed only by temporary fixture folders, never the user's MetaTrader installations. */
async function terminalCatalog(t: TestContext) {
  const machine = await MachineFixture.create();
  t.after(() => machine.dispose());
  const app = await InstallerFixture.create();
  t.after(() => app.cleanup());
  const installationFolder = await machine.installationFolder("Fixture MT4", "mt4");
  const dataFolder = await machine.dataFolder(installationFolder, { mql: "MQL4" });
  const bridgeBundle = await app.bundle();
  const terminals: ServerHostOptions["terminals"] = (options) => ({
    ...options,
    sources: async (userAddedFolders) => ({ dataRoot: machine.dataRoot, installationRoots: [machine.programFiles], userAddedFolders }),
    metaEditor: new FakeMetaEditor(SUCCESSFUL_COMPILE),
  });
  return { bridgeBundle, terminals, identity: { installationFolder, dataFolder }, terminalId: terminalIdFor(dataFolder) };
}

/** Forks the real server entry point as a child process, the way main runs it as a utility process. */
function forkServer(t: TestContext) {
  const child = fork(ENTRY, [], { execArgv: ["--import", "tsx"], stdio: ["ignore", "inherit", "inherit", "ipc"] });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  t.after(() => {
    if (child.exitCode === null) child.kill();
    return exited;
  });
  return { host: new Host(ipcTransport<ServerMessage, HostMessage>(child)), exited };
}

/** Runs the server host in this process over an in-process transport; stops it after the test if still running. */
function hostInProcess(t: TestContext, options: ServerHostOptions = {}) {
  const [hostEnd, serverEnd] = inProcessTransportPair<HostMessage, ServerMessage>();
  let stopped = false;
  runServerHost(serverEnd, { ...options, onStopped: () => (stopped = true) });
  const host = new Host(hostEnd);
  t.after(async () => {
    if (stopped) return;
    host.send({ type: "stop" });
    await host.next("stopped", undefined, 10000).catch(() => {});
  });
  return host;
}

async function stopHost(host: Host) {
  host.send({ type: "stop" });
  return host.next("stopped", undefined, 10000);
}

test("the server process answers start with ready and its bound ports, and stop with stopped, then exits", { timeout: 30000 }, async (t) => {
  const { host, exited } = forkServer(t);
  const config = await startConfig(t);

  host.send({ type: "start", config });
  const ready = await host.next("ready", undefined, 20000);
  assert.equal(ready.eaPort, config.eaPort);
  assert.equal(ready.httpPort, config.httpPort);
  assert.equal(ready.httpOrigin, `http://127.0.0.1:${config.httpPort}`);
  assert.equal(ready.databaseFile, join(config.dataFolder, "quotebridge.duckdb"));
  assert.equal(ready.schemaVersion, 9);

  host.send({ type: "stop" });
  const stopped = await host.next("stopped", undefined, 10000);
  assert.equal(stopped.checkpoint, true);
  assert.equal(await exited, 0);
});

test("after stop the database is checkpointed and reopens cleanly with its schema version", { timeout: 30000 }, async (t) => {
  const config = await startConfig(t);
  const first = hostInProcess(t);
  first.send({ type: "start", config });
  const ready = await first.next("ready");
  assert.ok(existsSync(ready.databaseFile));
  assert.equal((await stopHost(first)).checkpoint, true);
  assert.equal(existsSync(ready.databaseFile + ".wal"), false, "CHECKPOINT and close leave no WAL behind");

  const second = hostInProcess(t);
  second.send({ type: "start", config: { ...config, eaPort: await freePort(), httpPort: await freePort() } });
  const reopened = await second.next("ready");
  assert.equal(reopened.databaseFile, ready.databaseFile);
  assert.equal(reopened.schemaVersion, 9);
});

test("status reflects feeds and canonical terminal presence as verified EAs say hello", { timeout: 30000 }, async (t) => {
  const catalog = await terminalCatalog(t);
  const config = await startConfig(t, { bridgeBundle: catalog.bridgeBundle });
  const host = hostInProcess(t, { terminals: catalog.terminals });
  host.send({ type: "start", config });
  await host.next("ready");

  host.send({ type: "get-status" });
  const empty = await host.next("status");
  assert.deepEqual(empty.status, {
    feeds: { total: 0, online: 0, offline: 0, stale: 0, noQuote: 0, duplicateCharts: 0, dropped: 0 },
    terminals: [],
    terminalsNeedingAttention: [],
    invalidMessages: 0,
    unresolvedRequests: 0,
  });

  // The wire's legacy TerminalId is deliberately different: only the catalog's path pair supplies identity.
  const ea = new FakeEA({ terminal: "mt4-aaaaaaaaaaaa", identity: catalog.identity, symbol: "EURUSD" }).connect(`tcp://127.0.0.1:${config.eaPort}`);
  t.after(() => ea.close());
  assert.equal(await ea.request(ea.helloWire()), `C|1|${ea.session}|1`);

  const status = await host.next("status", (m) => m.status.feeds.total === 1);
  assert.deepEqual(status.status.feeds, { total: 1, online: 1, offline: 0, stale: 0, noQuote: 0, duplicateCharts: 0, dropped: 0 });
  assert.equal(status.status.terminals.length, 1);
  assert.equal(status.status.terminals[0].terminalId, catalog.terminalId);
  assert.equal(status.status.terminals[0].eaVersion, "1.11");
});

test("a (re)started server sends its first status right after ready, so main drops what the previous server reported", { timeout: 30000 }, async (t) => {
  const config = await startConfig(t);
  // Sweeps far apart: only a status sent because the server started can arrive in time.
  const host = hostInProcess(t, { statusIntervalMs: 60_000 });
  host.send({ type: "start", config });
  await host.next("ready");

  const first = await host.next("status", undefined, 2000);
  assert.deepEqual(first.status.terminalsNeedingAttention, []);
  assert.equal(first.status.feeds.total, 0);
});

test("initial and requested host status include recovered unresolved trading requests", { timeout: 30000 }, async (t) => {
  const config = await startConfig(t);
  const database = await openDatabase(config.dataFolder);
  const preview: TradingPreview = {
    id: "b".repeat(32), createdAt: 100, expiresAt: 30100,
    intent: { action: "new", accountId: "fixture-account", symbol: "EURUSD", kind: 0, ticket: "0", lots: "0.1", price: "1.1", stopLoss: "0", takeProfit: "0", expiry: null, brokerExpiry: 0, slippage: 20 },
    source: { accountId: "fixture-account", session: "fixture-session", terminalId: "fixture-terminal", brokerServer: "Fixture-Demo", login: "10000001" },
    marketId: "fixture-market", target: null,
    settings: { enabled: true, maxLots: "1", slippage: 20 },
    limits: { broker: "100", ea: "1", app: "1", maxLots: "1" },
    estimates: { loss: null, reward: null, currency: "USD" }, warnings: [],
  };
  try { await database.journal.admit(preview, "app-window", 200); }
  finally { await database.checkpointAndClose(); }
  const host = hostInProcess(t, { statusIntervalMs: 60_000 });
  host.send({ type: "start", config });
  await host.next("ready");
  assert.equal((await host.next("status")).status.unresolvedRequests, 1);
  host.send({ type: "get-status" });
  assert.equal((await host.next("status")).status.unresolvedRequests, 1);
});

test("stop publishes authoritative unresolved count before stopped despite throttled admission", { timeout: 30000 }, async (t) => {
  const clock = new FakeClock();
  const catalog = await terminalCatalog(t);
  const config = await startConfig(t, { bridgeBundle: catalog.bridgeBundle });
  await new SettingsStore(config.dataFolder).update((settings) => ({ ...settings, trading: { enabled: true, maxLots: "1", slippage: 20 } }));
  const db = await openDatabase(config.dataFolder);
  const keys = await ApiKeys.open(db.apiKeys, clock.now);
  const trader = await keys.create({ name: "Fixture trader", scope: "trader" });
  await db.checkpointAndClose();
  let server!: Parameters<NonNullable<ServerHostOptions["onRunning"]>>[0];
  const host = hostInProcess(t, {
    now: clock.now, terminals: catalog.terminals, statusIntervalMs: 60_000,
    onRunning: (running) => { server = running; },
  });
  const messages: ServerMessage[] = [];
  host.transport.onMessage((message) => messages.push(message));
  host.send({ type: "start", config });
  await host.next("ready");
  assert.equal((await host.next("status")).status.unresolvedRequests, 0);
  const ea = new FakeEA({ terminal: catalog.terminalId, identity: catalog.identity, symbol: "EURUSD" }).connect(`tcp://127.0.0.1:${config.eaPort}`);
  t.after(() => ea.close());
  await ea.request(ea.helloWire());
  await deliver(server.bridge, ea, `I|1|${ea.session}|${LOGIN}|USD|1|1|1|1`);
  const opened = await openWindow(server.httpOrigin, TOKEN);
  const rule = await fetch(`${server.httpOrigin}/api/clock-rules`, {
    method: "POST", headers: { cookie: opened.cookie!.split(";")[0], origin: server.httpOrigin, "content-type": "application/json" },
    body: JSON.stringify({ brokerServer: ea.broker, winterOffsetMinutes: 0, dst: "none" }),
  });
  assert.equal(rule.status, 200);
  const account = server.bridge.accounts.list()[0];
  assert.ok(account);
  const credential = { apiKey: trader.key };
  async function answer() {
    for (let n = 0; n < 2; n++) {
      const fields = (await ea.receive()).split("|");
      // Startup history/clock reads may share this EA socket with trading reads.
      if (fields[0] !== "V" && fields[0] !== "P") { n--; continue; }
      await deliver(server.bridge, ea, fields[0] === "V"
        ? pageWire(ea, fields[3], { capturedAt: Math.floor(clock.now() / 1000) })
        : conditionsWire(ea, fields[3], fields[6]).replace("|0|1700000002|", `|1|${Math.floor(clock.now() / 1000)}|`));
    }
  }
  const previewing = server.trading!.preview(credential, { action: "new", accountId: account.id, symbol: "EURUSD", side: "buy", type: "market", lots: "0.1" });
  await answer();
  const preview = await previewing;
  const executing = server.trading!.execute(credential, preview.id, true);
  await answer();
  assert.match(await ea.receive(), /^X\|/);
  await executing;
  assert.equal(messages.filter((m) => m.type === "status").length, 1, "admission status is still throttled");
  assert.equal((await stopHost(host)).checkpoint, true);
  const stoppedIndex = messages.findIndex((m) => m.type === "stopped");
  const final = messages[stoppedIndex - 1];
  assert.equal(final.type, "status", "final status precedes stopped");
  if (final.type === "status") assert.equal(final.status.unresolvedRequests, 1);
});

test("status follows a feed going offline after the heartbeat gap, with no EA message", { timeout: 30000 }, async (t) => {
  const clock = new FakeClock();
  const catalog = await terminalCatalog(t);
  const config = await startConfig(t, { bridgeBundle: catalog.bridgeBundle });
  const host = hostInProcess(t, { now: clock.now, statusIntervalMs: 50, terminals: catalog.terminals });
  host.send({ type: "start", config });
  await host.next("ready");

  const ea = new FakeEA({ terminal: catalog.terminalId, identity: catalog.identity }).connect(`tcp://127.0.0.1:${config.eaPort}`);
  t.after(() => ea.close());
  await ea.request(ea.helloWire());
  await host.next("status", (m) => m.status.feeds.online === 1);

  clock.advance(8000);
  const offline = await host.next("status", (m) => m.status.feeds.offline === 1);
  assert.equal(offline.status.feeds.online, 0);
});

test("without a terminal catalog even a modern hello is rejected and publishes no status presence", { timeout: 30000 }, async (t) => {
  const config = await startConfig(t);
  const host = hostInProcess(t, { statusIntervalMs: 50 });
  host.send({ type: "start", config });
  await host.next("ready");
  const ea = new FakeEA().connect(`tcp://127.0.0.1:${config.eaPort}`);
  t.after(() => ea.close());

  assert.equal(await ea.request(ea.helloWire()), `C|1|${ea.session}|0`);
  const rejected = await host.next("status", (m) => m.status.invalidMessages === 1);
  assert.equal(rejected.status.feeds.total, 0);
  assert.deepEqual(rejected.status.terminals, []);
});

test("a taken EA port fails start with a structured port-in-use error, and start can be retried", { timeout: 30000 }, async (t) => {
  const config = await startConfig(t);
  const holder = createServer();
  await new Promise<void>((resolve) => holder.listen(config.eaPort, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => holder.close(() => resolve())));

  const host = hostInProcess(t);
  host.send({ type: "start", config });
  const failed = await host.next("error");
  assert.equal(failed.during, "start");
  assert.equal(failed.error.code, "port-in-use");
  assert.equal(failed.error.which, "ea");
  assert.equal(failed.error.port, config.eaPort);
  assert.match(failed.error.message, /in use/);

  host.send({ type: "start", config: { ...config, eaPort: await freePort() } });
  const ready = await host.next("ready");
  assert.equal(ready.schemaVersion, 9, "the database closed by the failed start opens again");
});

test("a failing onRunning hook releases the server before reporting start failure and permits retry", { timeout: 30000 }, async (t) => {
  const config = await startConfig(t);
  let fail = true;
  let leaked: Parameters<NonNullable<ServerHostOptions["onRunning"]>>[0] | undefined;
  const host = hostInProcess(t, { onRunning: (server) => {
    if (fail) {
      leaked = server;
      throw new Error("fixture startup failure");
    }
  } });
  // Also cleans up the deliberately broken implementation during the RED run.
  t.after(async () => { await leaked?.close(); });
  host.send({ type: "start", config });
  const failed = await host.next("error");
  assert.equal(failed.during, "start");
  assert.match(failed.error.message, /fixture startup failure/);
  assert.equal(await canBind(config.eaPort), true, "failed start releases EA port");
  assert.equal(await canBind(config.httpPort), true, "failed start releases HTTP port");
  fail = false;
  host.send({ type: "start", config });
  await host.next("ready");
  assert.equal((await stopHost(host)).checkpoint, true);
});

test("a database held by another process fails start with a database error", { timeout: 30000 }, async (t) => {
  const config = await startConfig(t);
  const { host: owner } = forkServer(t);
  owner.send({ type: "start", config });
  await owner.next("ready", undefined, 20000);
  const host = hostInProcess(t);
  host.send({ type: "start", config: { ...config, eaPort: await freePort(), httpPort: await freePort() } });
  const failed = await host.next("error", undefined, 10000);
  assert.equal(failed.during, "start");
  assert.equal(failed.error.code, "database");
  assert.equal((await stopHost(owner)).checkpoint, true);
});

/** The app window opening /session?token=…: the HTTP status it gets (303 with a session cookie, or 401). */
async function openWindow(origin: string, token: string) {
  const res = await fetch(`${origin}/session?token=${encodeURIComponent(token)}`, { redirect: "manual" });
  return { status: res.status, cookie: res.headers.get("set-cookie") };
}

test("issue-window-token gives a recreated app window a fresh one-time token", { timeout: 30000 }, async (t) => {
  const config = await startConfig(t);
  const host = hostInProcess(t);
  host.send({ type: "start", config });
  const { httpOrigin } = await host.next("ready");
  assert.equal((await openWindow(httpOrigin, TOKEN)).status, 303);

  const fresh = "recreated-window-token-abcdef";
  assert.equal((await openWindow(httpOrigin, fresh)).status, 401, "not valid before it is issued");
  host.send({ type: "issue-window-token", token: fresh, requestId: 7 });
  assert.equal((await host.next("window-token-issued")).requestId, 7);
  const opened = await openWindow(httpOrigin, fresh);
  assert.equal(opened.status, 303);
  assert.match(opened.cookie ?? "", new RegExp(`^qb_session_${new URL(httpOrigin).port}=`));
  assert.equal((await openWindow(httpOrigin, fresh)).status, 401, "one-time");
});

test("a window token that is too short is refused with a bad-message error", { timeout: 30000 }, async (t) => {
  const config = await startConfig(t);
  const host = hostInProcess(t);
  host.send({ type: "start", config });
  await host.next("ready");
  host.send({ type: "issue-window-token", token: "short", requestId: 8 });
  const refused = await host.next("error");
  assert.equal(refused.during, "message");
  assert.equal(refused.requestId, 8, "the refusal names the request it answers");
  assert.equal(refused.error.code, "bad-message");
});

async function canBind(port: number) {
  const probe = createServer();
  return new Promise<boolean>((resolve) => {
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

test("stop sent right after start waits for the start, then releases both ports before stopped", { timeout: 30000 }, async (t) => {
  const config = await startConfig(t);
  const host = hostInProcess(t);
  host.send({ type: "start", config });
  host.send({ type: "stop" });
  await host.next("ready");
  const stopped = await host.next("stopped");
  assert.equal(stopped.checkpoint, true);
  assert.equal(await canBind(config.eaPort), true, "EA port released: no more EA messages are accepted");
  assert.equal(await canBind(config.httpPort), true, "HTTP port released");
});

test("stop before start answers stopped without a checkpoint", { timeout: 30000 }, async (t) => {
  const host = hostInProcess(t);
  host.send({ type: "stop" });
  assert.equal((await host.next("stopped")).checkpoint, false);
});

test("an unknown host message is answered with a bad-message error", { timeout: 30000 }, async (t) => {
  const host = hostInProcess(t);
  host.send({ type: "reboot" } as unknown as HostMessage);
  const refused = await host.next("error");
  assert.equal(refused.error.code, "bad-message");
});

test("update-settings: the server writes main's setting changes to the settings file and answers with the settings", { timeout: 30000 }, async (t) => {
  const config = await startConfig(t);
  const host = hostInProcess(t);
  host.send({ type: "start", config });
  await host.next("ready");

  host.send({ type: "update-settings", change: { firstCloseNotificationShown: true } });
  const first = await host.next("settings");
  assert.equal(first.settings.firstCloseNotificationShown, true);
  assert.equal(first.settings.startWithWindows, true, "other settings are kept");

  host.send({ type: "update-settings", change: { startWithWindows: false } });
  const second = await host.next("settings");
  assert.equal(second.settings.startWithWindows, false);
  assert.equal(second.settings.firstCloseNotificationShown, true);

  const saved = JSON.parse(await readFile(join(config.dataFolder, "settings.json"), "utf8"));
  assert.equal(saved.startWithWindows, false);
  assert.equal(saved.firstCloseNotificationShown, true);
});

test("update-settings is refused before start, and for settings main does not own, and nothing is written", { timeout: 30000 }, async (t) => {
  const config = await startConfig(t);
  const host = hostInProcess(t);
  host.send({ type: "update-settings", change: { startWithWindows: false } });
  assert.equal((await host.next("error")).error.code, "bad-message");

  host.send({ type: "start", config });
  await host.next("ready");
  for (const change of [{ ports: { ea: 1, http: 2 } }, { startWithWindows: "no" }, { setupCompleted: true }]) {
    host.send({ type: "update-settings", change } as unknown as HostMessage);
    const refused = await host.next("error");
    assert.equal(refused.during, "message");
    assert.equal(refused.error.code, "bad-message");
  }
  assert.equal(existsSync(join(config.dataFolder, "settings.json")), false);
});

/** A trader key made in the app window, for REST calls as the CLI makes them. */
async function traderKey(origin: string) {
  const cookie = (await openWindow(origin, TOKEN)).cookie!.split(";")[0];
  const res = await fetch(`${origin}/api/api-keys`, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify({ name: "Trader", scope: "trader" }) });
  return ((await res.json()) as { key: string }).key;
}

const screenshot = (origin: string, key: string) => fetch(`${origin}/api/v1/screenshots/feeds`, { headers: { authorization: `Bearer ${key}` } }).then(async (res) => ({ status: res.status, body: (await res.json()) as any }));

test("capture-window: a REST screenshot asks main for the window and answers what main captured or why it could not", { timeout: 30000 }, async (t) => {
  const config = await startConfig(t);
  const host = hostInProcess(t);
  host.send({ type: "start", config });
  const { httpOrigin } = await host.next("ready");
  const key = await traderKey(httpOrigin);

  const first = screenshot(httpOrigin, key);
  const asked = await host.next("capture-window");
  assert.equal(asked.view, "feeds");
  host.send({ type: "window-captured", requestId: asked.requestId, capture: { view: "feeds", window: "minimised", width: 800, height: 600, scale: 1, live: "live", capturedAt: Date.UTC(2027, 0, 15), png: "AAEC" } });
  const answer = await first;
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body.data, { view: "feeds", window: "minimised", width: 800, height: 600, scale: 1, live: "live", capturedAt: "2027-01-15T00:00:00.000Z", contentType: "image/png", png: "AAEC" });

  const second = screenshot(httpOrigin, key);
  const again = await host.next("capture-window");
  assert.notEqual(again.requestId, asked.requestId, "each request has its own id");
  host.send({ type: "window-captured", requestId: asked.requestId, capture: { view: "feeds", window: "visible", width: 1, height: 1, scale: 1, live: "live", capturedAt: 0, png: "" } });
  host.send({ type: "window-capture-failed", requestId: again.requestId, error: { code: "window-busy", message: 'The app window has a dialog open ("Close position 12345").' } });
  const busy = await second;
  assert.equal(busy.status, 409, "an answer to an earlier request is ignored");
  assert.deepEqual(busy.body.error, { code: "window-busy", message: 'The app window has a dialog open ("Close position 12345").', details: null });
});

test("a screenshot pending when the server stops is answered window-unavailable", { timeout: 30000 }, async (t) => {
  const config = await startConfig(t);
  const host = hostInProcess(t);
  host.send({ type: "start", config });
  const { httpOrigin } = await host.next("ready");
  const pending = screenshot(httpOrigin, await traderKey(httpOrigin));
  await host.next("capture-window");
  host.send({ type: "stop" });
  const answer = await pending;
  assert.equal(answer.status, 503);
  assert.equal(answer.body.error.code, "window-unavailable");
  await host.next("stopped", undefined, 10000);
});

test("a dev run in a browser tab has no app window: a screenshot answers window-unavailable without asking the host", { timeout: 30000 }, async (t) => {
  const config = await startConfig(t);
  const host = hostInProcess(t, { openDashboard: true });
  host.send({ type: "start", config });
  const { httpOrigin } = await host.next("ready");
  const answer = await screenshot(httpOrigin, await traderKey(httpOrigin));
  assert.equal(answer.status, 503);
  assert.equal(answer.body.error.code, "window-unavailable");
  await assert.rejects(host.next("capture-window", undefined, 200));
});
