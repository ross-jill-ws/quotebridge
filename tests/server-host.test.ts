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
import { FakeClock, FakeEA } from "./fake-ea.js";
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
  assert.equal(ready.schemaVersion, 6);

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
  assert.equal(reopened.schemaVersion, 6);
});

test("status reflects feeds and terminal presence as EAs say hello", { timeout: 30000 }, async (t) => {
  const config = await startConfig(t);
  const host = hostInProcess(t);
  host.send({ type: "start", config });
  await host.next("ready");

  host.send({ type: "get-status" });
  const empty = await host.next("status");
  assert.deepEqual(empty.status, {
    feeds: { total: 0, online: 0, offline: 0, stale: 0, noQuote: 0, duplicateCharts: 0, dropped: 0 },
    terminals: [],
    terminalsNeedingAttention: [],
    invalidMessages: 0,
  });

  const ea = new FakeEA({ terminal: "mt4-aaaaaaaaaaaa", symbol: "EURUSD", eaVersion: "1.08" }).connect(`tcp://127.0.0.1:${config.eaPort}`);
  t.after(() => ea.close());
  assert.equal(await ea.request(ea.helloWire()), `C|1|${ea.session}|1`);

  const status = await host.next("status", (m) => m.status.feeds.total === 1);
  assert.deepEqual(status.status.feeds, { total: 1, online: 1, offline: 0, stale: 0, noQuote: 0, duplicateCharts: 0, dropped: 0 });
  assert.equal(status.status.terminals.length, 1);
  assert.equal(status.status.terminals[0].terminalId, "mt4-aaaaaaaaaaaa");
  assert.equal(status.status.terminals[0].eaVersion, "1.08");
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

test("status follows a feed going offline after the heartbeat gap, with no EA message", { timeout: 30000 }, async (t) => {
  const clock = new FakeClock();
  const config = await startConfig(t);
  const host = hostInProcess(t, { now: clock.now, statusIntervalMs: 50 });
  host.send({ type: "start", config });
  await host.next("ready");

  const ea = new FakeEA().connect(`tcp://127.0.0.1:${config.eaPort}`);
  t.after(() => ea.close());
  await ea.request(ea.helloWire());
  await host.next("status", (m) => m.status.feeds.online === 1);

  clock.advance(8000);
  const offline = await host.next("status", (m) => m.status.feeds.offline === 1);
  assert.equal(offline.status.feeds.online, 0);
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
  assert.equal(ready.schemaVersion, 6, "the database closed by the failed start opens again");
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
