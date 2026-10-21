// Seam 3: the supervisor driven through the server host protocol, with fake server processes and a manual clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Supervisor, type StopReason, type SupervisorEvent } from "../src/main/supervisor/index.js";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ipcTransport } from "../src/shared/host-transport.js";
import type { HostMessage, ServerMessage } from "../src/shared/server-host-protocol.js";
import { freePort } from "./free-port.js";
import { FakeLauncher, ManualClock, PORT_IN_USE } from "./fake-server-process.js";

const ENTRY = fileURLToPath(new URL("../src/server/entry.ts", import.meta.url));
const CONFIG = { eaPort: 6555, httpPort: 6580, dataFolder: "C:\\data" };

function setup(launcher = new FakeLauncher()) {
  const clock = new ManualClock();
  let tokens = 0;
  const supervisor = new Supervisor({
    launch: launcher.launch,
    config: () => CONFIG,
    clock,
    createToken: () => `token-${++tokens}-0123456789abcdef`,
  });
  const events: SupervisorEvent[] = [];
  supervisor.onEvent((e) => events.push(e));
  const windowUrls = () => events.flatMap((e) => (e.type === "window-url" ? [e.url] : []));
  return { supervisor, launcher, clock, events, windowUrls };
}

test("start launches the server with config and a window token, then runs on ready", () => {
  const { supervisor, launcher, windowUrls } = setup();
  supervisor.start();

  assert.equal(launcher.processes.length, 1);
  assert.deepEqual(launcher.last.received, [{ type: "start", config: { ...CONFIG, windowToken: "token-1-0123456789abcdef" } }]);
  assert.equal(supervisor.status().state, "running");
  assert.equal(supervisor.status().warning, null);
  assert.deepEqual(supervisor.status().server, { eaPort: 6555, httpPort: 6580, httpOrigin: "http://127.0.0.1:6580" });
  assert.deepEqual(windowUrls(), ["http://127.0.0.1:6580/session?token=token-1-0123456789abcdef"]);
});

test("a crash restarts the server with exponential backoff and a fresh window token", () => {
  const { supervisor, launcher, clock, windowUrls } = setup();
  supervisor.start();

  launcher.last.exit(1);
  assert.equal(supervisor.status().state, "restarting");
  assert.equal(supervisor.status().failures, 1);
  assert.equal(supervisor.status().nextLaunchAt, 1_000);
  clock.advance(999);
  assert.equal(launcher.processes.length, 1, "no restart before the backoff");
  clock.advance(1);
  assert.equal(launcher.processes.length, 2);
  assert.equal(supervisor.status().state, "running");
  assert.deepEqual(windowUrls(), [
    "http://127.0.0.1:6580/session?token=token-1-0123456789abcdef",
    "http://127.0.0.1:6580/session?token=token-2-0123456789abcdef",
  ]);

  // Consecutive failures double the delay: 1 s, 2 s, 4 s, ...
  launcher.last.exit(1);
  clock.advance(1_999);
  assert.equal(launcher.processes.length, 2);
  clock.advance(1);
  assert.equal(launcher.processes.length, 3);
  launcher.last.exit(1);
  clock.advance(3_999);
  assert.equal(launcher.processes.length, 3);
  clock.advance(1);
  assert.equal(launcher.processes.length, 4);
});

test("the backoff is capped at 30 seconds", () => {
  const { supervisor, launcher, clock } = setup();
  supervisor.start();
  for (let i = 0; i < 8; i++) {
    launcher.last.exit(1);
    clock.advance(30_000);
  }
  assert.equal(launcher.processes.length, 9);
  launcher.last.exit(1);
  assert.equal(supervisor.status().nextLaunchAt, clock.now() + 30_000);
});

test("repeated failures raise the warning; running stably clears it and resets the backoff", () => {
  const { supervisor, launcher, clock } = setup();
  supervisor.start();
  launcher.last.exit(1);
  clock.advance(1_000);
  launcher.last.exit(1);
  clock.advance(2_000);
  assert.equal(supervisor.status().warning, null, "two failures: no warning yet");
  launcher.last.exit(1);
  assert.deepEqual(supervisor.status().warning, {
    reason: "repeated-failures",
    failures: 3,
    message: "The QuoteBridge server keeps stopping unexpectedly (3 times in a row). It is being restarted.",
  });
  clock.advance(4_000);
  assert.equal(supervisor.status().state, "running");
  assert.equal(supervisor.status().warning?.reason, "repeated-failures", "still warned until it runs stably");

  clock.advance(60_000);
  assert.equal(supervisor.status().warning, null);
  assert.equal(supervisor.status().failures, 0);
  launcher.last.exit(1);
  assert.equal(supervisor.status().nextLaunchAt, clock.now() + 1_000, "backoff starts over");
});

test("a server that crashes or hangs while starting counts as a failure", () => {
  const launcher = new FakeLauncher().then({ onStart: "crash" }, { onStart: "hang" }, { onStart: { error: { code: "database", message: "locked" } } });
  const { supervisor, clock } = setup(launcher);
  supervisor.start();
  assert.equal(supervisor.status().state, "restarting");
  assert.equal(supervisor.status().failures, 1);

  clock.advance(1_000);
  assert.equal(supervisor.status().state, "starting");
  clock.advance(60_000);
  assert.equal(launcher.processes[1]!.killed, true, "a hung start is ended");
  assert.equal(supervisor.status().state, "restarting");
  assert.equal(supervisor.status().failures, 2);

  clock.advance(2_000);
  assert.equal(launcher.processes[2]!.killed, true, "a failed start's process is ended");
  assert.equal(supervisor.status().failures, 3);
  assert.deepEqual(supervisor.status().lastError, { code: "database", message: "locked" });
  assert.equal(supervisor.status().warning?.reason, "repeated-failures");
  clock.advance(4_000);
  assert.equal(supervisor.status().state, "running");
  assert.equal(launcher.processes.length, 4);
});

test("a port in use is reported and retried slowly, without crash-looping", () => {
  const launcher = new FakeLauncher().then({ onStart: { error: PORT_IN_USE } }, { onStart: { error: PORT_IN_USE } });
  const { supervisor, clock } = setup(launcher);
  supervisor.start();

  const status = supervisor.status();
  assert.equal(status.state, "port-in-use");
  assert.deepEqual(status.lastError, PORT_IN_USE);
  assert.deepEqual(status.warning, { reason: "port-in-use", message: "Port 6555 is in use." });
  assert.equal(status.failures, 0, "not counted as a crash");
  assert.equal(launcher.processes[0]!.killed, true);

  clock.advance(29_999);
  assert.equal(launcher.processes.length, 1, "no fast restarts");
  clock.advance(1);
  assert.equal(launcher.processes.length, 2);
  assert.equal(supervisor.status().state, "port-in-use");
  assert.equal(supervisor.status().nextLaunchAt, 60_000, "the retry interval does not grow");

  // The port is freed (e.g. the legacy server stopped): the next retry starts the server and clears the warning.
  clock.advance(30_000);
  assert.equal(supervisor.status().state, "running");
  assert.equal(supervisor.status().warning, null);
});

test("retry() tries again at once, e.g. after the user freed the port", () => {
  const launcher = new FakeLauncher().then({ onStart: { error: PORT_IN_USE } });
  const { supervisor, clock } = setup(launcher);
  supervisor.start();
  supervisor.retry();
  assert.equal(launcher.processes.length, 2);
  assert.equal(supervisor.status().state, "running");
  clock.advance(30_000);
  assert.equal(launcher.processes.length, 2, "the cancelled retry timer does not launch another server");
  supervisor.retry();
  assert.equal(launcher.processes.length, 2, "retry does nothing while running");
});

test("stop sends stop and resolves when the server reports stopped within the deadline", async () => {
  const { supervisor, launcher, clock } = setup();
  supervisor.start();
  const result = await supervisor.stop("quit");

  assert.deepEqual(result, { reason: "quit", outcome: "stopped", checkpoint: true });
  assert.deepEqual(launcher.last.sentTypes(), ["start", "stop"]);
  assert.equal(launcher.last.killed, false);
  assert.equal(supervisor.status().state, "stopped");
  clock.advance(120_000);
  assert.equal(launcher.processes.length, 1, "the exit after stopped is not a crash");
  assert.equal(clock.pendingTimers(), 0);
});

test("stop ends the server when the deadline passes without stopped", async () => {
  const launcher = new FakeLauncher().then({ onStop: "hang" });
  const { supervisor, clock } = setup(launcher);
  supervisor.start();
  let result: unknown;
  const done = supervisor.stop("quit").then((r) => (result = r));

  clock.advance(4_999);
  await Promise.resolve();
  assert.equal(result, undefined, "still waiting inside the deadline");
  assert.equal(launcher.last.killed, false);
  clock.advance(1);
  await done;
  assert.deepEqual(result, { reason: "quit", outcome: "deadline-missed", checkpoint: false });
  assert.equal(launcher.last.killed, true);
  assert.equal(supervisor.status().state, "stopped");
  assert.equal(launcher.processes.length, 1);
});

test("a server that exits during the stop path is not restarted", async () => {
  const launcher = new FakeLauncher().then({ onStop: "crash" });
  const { supervisor, clock } = setup(launcher);
  supervisor.start();
  assert.deepEqual(await supervisor.stop("quit"), { reason: "quit", outcome: "exited", checkpoint: false });
  clock.advance(120_000);
  assert.equal(launcher.processes.length, 1);
});

test("Quit, update, Windows shutdown and logoff run the same stop path", async () => {
  const runs = [];
  for (const reason of ["quit", "update", "shutdown", "logoff"] as StopReason[]) {
    const launcher = new FakeLauncher().then({}, { onStop: "hang" });
    const { supervisor, clock } = setup(launcher);
    supervisor.start();
    const met = await supervisor.stop(reason);

    const second = setup(new FakeLauncher().then({ onStop: "hang" }));
    second.supervisor.start();
    const missed = second.supervisor.stop(reason);
    second.clock.advance(5_000);
    runs.push({ met, missed: await missed, sent: launcher.last.sentTypes(), clockLeft: clock.pendingTimers() });
  }
  for (const [i, run] of runs.entries()) {
    const reason = ["quit", "update", "shutdown", "logoff"][i];
    assert.deepEqual(run, {
      met: { reason, outcome: "stopped", checkpoint: true },
      missed: { reason, outcome: "deadline-missed", checkpoint: false },
      sent: ["start", "stop"],
      clockLeft: 0,
    });
  }
});

test("a second stop while stopping (e.g. shutdown during Quit) joins the first", async () => {
  const launcher = new FakeLauncher().then({ onStop: "hang" });
  const { supervisor, clock } = setup(launcher);
  supervisor.start();
  const quit = supervisor.stop("quit");
  const shutdown = supervisor.stop("shutdown");
  assert.equal(quit, shutdown);
  assert.deepEqual(launcher.last.sentTypes(), ["start", "stop"], "stop is sent once");
  launcher.last.reply({ type: "stopped", checkpoint: true });
  assert.deepEqual(await shutdown, { reason: "quit", outcome: "stopped", checkpoint: true });
  clock.advance(10_000);
  assert.equal(launcher.last.killed, false);
  assert.deepEqual(await supervisor.stop("logoff"), { reason: "quit", outcome: "stopped", checkpoint: true }, "after stopping, stop returns the same result");
});

test("stop while starting waits for the server's own stop path", async () => {
  const launcher = new FakeLauncher().then({ onStart: "hang", onStop: "hang" });
  const { supervisor } = setup(launcher);
  supervisor.start();
  const stopping = supervisor.stop("shutdown");
  assert.equal(supervisor.status().state, "stopping");
  assert.deepEqual(launcher.last.sentTypes(), ["start", "stop"]);
  launcher.last.reply({ type: "stopped", checkpoint: false });
  assert.deepEqual(await stopping, { reason: "shutdown", outcome: "stopped", checkpoint: false });
});

test("stop with no server running (restarting, port in use, never started) ends at once and launches nothing more", async () => {
  {
    const { supervisor, launcher, clock } = setup();
    supervisor.start();
    launcher.last.exit(1);
    assert.deepEqual(await supervisor.stop("logoff"), { reason: "logoff", outcome: "not-running", checkpoint: false });
    clock.advance(120_000);
    assert.equal(launcher.processes.length, 1);
    assert.equal(supervisor.status().state, "stopped");
  }
  {
    const { supervisor, launcher, clock } = setup(new FakeLauncher().then({ onStart: { error: PORT_IN_USE } }));
    supervisor.start();
    assert.equal((await supervisor.stop("update")).outcome, "not-running");
    clock.advance(120_000);
    assert.equal(launcher.processes.length, 1);
  }
  {
    const { supervisor, launcher } = setup();
    assert.equal((await supervisor.stop("quit")).outcome, "not-running");
    supervisor.start();
    assert.equal(launcher.processes.length, 0, "a stopped supervisor never starts again");
  }
});

test("a recreated app window gets a fresh one-time token from the running server", async () => {
  const { supervisor, launcher } = setup();
  supervisor.start();
  const url = await supervisor.issueWindowToken();
  assert.equal(url, "http://127.0.0.1:6580/session?token=token-2-0123456789abcdef");
  assert.deepEqual(launcher.last.received.at(-1), { type: "issue-window-token", token: "token-2-0123456789abcdef" });
});

test("a window token cannot be issued while no server is running, and a pending one fails if the server crashes", async () => {
  const launcher = new FakeLauncher().then({ onStart: "hang" }, { onStart: "hang" });
  const { supervisor, clock } = setup(launcher);
  supervisor.start();
  await assert.rejects(supervisor.issueWindowToken(), /not running/);

  launcher.last.reply({ type: "ready", eaPort: 6555, httpPort: 6580, httpOrigin: "http://127.0.0.1:6580", databaseFile: "db", schemaVersion: 1 });
  // This fake answers the token only when told to.
  const silent = launcher.last;
  silent.transport.send = (m) => void silent.received.push(m);
  const pending = supervisor.issueWindowToken();
  silent.exit(1);
  await assert.rejects(pending, /stopped/);
  clock.advance(1_000);
  assert.equal(supervisor.status().state, "starting", "restarting as usual; the next ready brings a new window-url");
});

test("the server's status pushes are passed on", () => {
  const { supervisor, launcher, events } = setup();
  supervisor.start();
  const status = { feeds: { total: 1, online: 1, offline: 0, stale: 0, noQuote: 0, duplicateCharts: 0, dropped: 0 }, terminals: [], terminalsNeedingAttention: [], invalidMessages: 0 };
  launcher.last.reply({ type: "status", status });
  assert.deepEqual(events.at(-1), { type: "server-status", status });
  assert.deepEqual(supervisor.status().serverStatus, status);
});

test("supervises the real server entry point: start, window session, stop", async (t) => {
  const dataFolder = await mkdtemp(join(tmpdir(), "quotebridge-supervisor-"));
  t.after(() => rm(dataFolder, { recursive: true, force: true }));
  const config = { eaPort: await freePort(), httpPort: await freePort(), dataFolder };
  const children: ChildProcess[] = [];
  t.after(() => children.forEach((c) => c.exitCode === null && c.kill()));
  const supervisor = new Supervisor({
    config: () => config,
    launch: () => {
      const child = fork(ENTRY, [], { execArgv: ["--import", "tsx"], stdio: ["ignore", "inherit", "inherit", "ipc"] });
      children.push(child);
      return {
        transport: ipcTransport<ServerMessage, HostMessage>(child),
        onExit: (listener) => void child.once("exit", listener),
        kill: () => void child.kill(),
      };
    },
  });
  const url = new Promise<string>((resolve) => supervisor.onEvent((e) => e.type === "window-url" && resolve(e.url)));
  supervisor.start();

  const session = await fetch(await url, { redirect: "manual" });
  assert.equal(session.status, 303, "the window token opens a session");
  assert.equal(supervisor.status().state, "running");
  const again = await fetch(await supervisor.issueWindowToken(), { redirect: "manual" });
  assert.equal(again.status, 303, "a re-issued token opens a session too");

  assert.deepEqual(await supervisor.stop("quit"), { reason: "quit", outcome: "stopped", checkpoint: true });
  const child = children[0]!;
  if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(child.exitCode, 0);
  assert.equal(children.length, 1);
});

test("setting changes go to the running server, and its saved settings are passed on", () => {
  const { supervisor, launcher, events } = setup();
  supervisor.start();

  supervisor.updateSettings({ firstCloseNotificationShown: true });

  assert.deepEqual(launcher.last.received.at(-1), { type: "update-settings", change: { firstCloseNotificationShown: true } });
  const saved = events.flatMap((e) => (e.type === "settings" ? [e.settings] : []));
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.firstCloseNotificationShown, true);
});

test("setting changes made while no server runs are kept and sent, merged, once the next server is ready", () => {
  const { supervisor, launcher, clock } = setup(new FakeLauncher().then({ onStart: "ready" }, { onStart: "hang" }));
  supervisor.start();
  launcher.last.exit(1);
  assert.equal(supervisor.status().state, "restarting");

  supervisor.updateSettings({ startWithWindows: false });
  supervisor.updateSettings({ firstCloseNotificationShown: true });
  supervisor.updateSettings({ startWithWindows: true });
  clock.advance(1_000);
  assert.equal(supervisor.status().state, "starting");
  assert.deepEqual(launcher.last.sentTypes(), ["start"], "nothing before ready");

  launcher.last.reply({ type: "ready", eaPort: 6555, httpPort: 6580, httpOrigin: "http://127.0.0.1:6580", databaseFile: "db", schemaVersion: 1 });
  assert.deepEqual(launcher.last.received.slice(1), [{ type: "update-settings", change: { startWithWindows: true, firstCloseNotificationShown: true } }]);

  launcher.last.exit(1);
  clock.advance(2_000);
  assert.deepEqual(launcher.last.sentTypes(), ["start"], "a sent change is not sent again to the next server");
});

test("setting changes after stop are dropped", async () => {
  const { supervisor, launcher } = setup();
  supervisor.start();
  await supervisor.stop("quit");
  const sent = launcher.last.received.length;
  supervisor.updateSettings({ startWithWindows: false });
  assert.equal(launcher.last.received.length, sent);
  assert.equal(launcher.processes.length, 1);
});
