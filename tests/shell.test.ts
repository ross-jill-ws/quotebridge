// The shell's rules (tray, window, close-to-tray, single instance, Start with Windows, Quit) driven
// through fake Electron ports and a fake supervisor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Shell, type ShellPorts, type LoginItem } from "../src/main/shell/index.js";
import type { StopReason, StopResult, SupervisorEvent, SupervisorStatus } from "../src/main/supervisor/index.js";
import type { HostSettingsChange } from "../src/shared/server-host-protocol.js";
import { DEFAULT_SETTINGS, type Settings } from "../src/shared/settings-store.js";

const AFTER_SETUP: Settings = { ...(structuredClone(DEFAULT_SETTINGS) as Settings), setupCompleted: true };
const FIRST_RUN: Settings = structuredClone(DEFAULT_SETTINGS) as Settings;

class FakeSupervisor {
  started = false;
  stops: StopReason[] = [];
  changes: HostSettingsChange[] = [];
  tokenRequests = 0;
  finishStop: (result: StopResult) => void = () => {};
  private listeners = new Set<(e: SupervisorEvent) => void>();
  start() {
    this.started = true;
  }
  stop(reason: StopReason) {
    this.stops.push(reason);
    return new Promise<StopResult>((resolve) => (this.finishStop = resolve));
  }
  issueWindowToken() {
    this.tokenRequests++;
    return Promise.resolve(`http://127.0.0.1:6580/session?token=reissued-${this.tokenRequests}`);
  }
  updateSettings(change: HostSettingsChange) {
    this.changes.push(change);
  }
  onEvent(listener: (e: SupervisorEvent) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  emit(event: SupervisorEvent) {
    for (const l of this.listeners) l(event);
  }
}

function setup({ settings = AFTER_SETUP, argv = [] as string[], packaged = true } = {}) {
  const log: string[] = [];
  const window = { visible: false, minimized: false, url: null as string | null };
  const tray = { warning: null as string | null, startWithWindows: null as boolean | null };
  const notifications: { title: string; body: string }[] = [];
  const loginItems: LoginItem[] = [];
  const exits: number[] = [];
  const supervisor = new FakeSupervisor();
  const ports: ShellPorts = {
    window: {
      show: () => void ((window.visible = true), log.push("show")),
      hide: () => void ((window.visible = false), log.push("hide")),
      focus: () => void log.push("focus"),
      restore: () => void ((window.minimized = false), log.push("restore")),
      isMinimized: () => window.minimized,
      loadURL: (url) => void (window.url = url),
    },
    tray: {
      setWarning: (message) => void (tray.warning = message),
      setStartWithWindows: (on) => void (tray.startWithWindows = on),
    },
    supervisor,
    notify: (title, body) => void notifications.push({ title, body }),
    setLoginItem: packaged ? (item) => void loginItems.push(item) : null,
    exit: (code) => void exits.push(code),
  };
  const shell = new Shell(ports, { settings, argv });
  return { shell, window, tray, notifications, loginItems, exits, supervisor, log };
}

test("a normal start shows the window and starts the server; a login start stays hidden in the tray", () => {
  const normal = setup();
  normal.shell.start();
  assert.equal(normal.supervisor.started, true);
  assert.equal(normal.window.visible, true);

  const atLogin = setup({ argv: ["QuoteBridge.exe", "--hidden"] });
  atLogin.shell.start();
  assert.equal(atLogin.supervisor.started, true);
  assert.equal(atLogin.window.visible, false);
});

test("first run shows the window (the setup screen) even when started hidden", () => {
  const { shell, window } = setup({ settings: FIRST_RUN, argv: ["QuoteBridge.exe", "--hidden"] });
  shell.start();
  assert.equal(window.visible, true);
});

test("the window loads each session URL the supervisor hands out", () => {
  const { shell, window, supervisor } = setup();
  shell.start();
  supervisor.emit({ type: "window-url", url: "http://127.0.0.1:6580/session?token=one" });
  assert.equal(window.url, "http://127.0.0.1:6580/session?token=one");
  supervisor.emit({ type: "window-url", url: "http://127.0.0.1:6580/session?token=two" });
  assert.equal(window.url, "http://127.0.0.1:6580/session?token=two", "after a server restart the window reloads");
});

test("closing the window hides it to the tray; the first time only, a notification says the app is still running", () => {
  const { shell, window, notifications, supervisor } = setup();
  shell.start();

  assert.equal(shell.closeRequested(), "hide");
  assert.equal(window.visible, false);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0]!.body, /still running/i);
  assert.match(notifications[0]!.body, /Quit/);
  assert.deepEqual(supervisor.changes, [{ firstCloseNotificationShown: true }], "saved through the server");

  shell.openFromTray();
  assert.equal(shell.closeRequested(), "hide");
  assert.equal(notifications.length, 1, "not shown a second time");
  assert.equal(supervisor.changes.length, 1);
});

test("once the notification was shown in an earlier run, closing never shows it again", () => {
  const { shell, notifications, supervisor } = setup({ settings: { ...AFTER_SETUP, firstCloseNotificationShown: true } });
  shell.start();
  assert.equal(shell.closeRequested(), "hide");
  assert.equal(notifications.length, 0);
  assert.deepEqual(supervisor.changes, []);
});

test("a second launch brings the existing window to the front, restoring it if minimized", () => {
  const { shell, window, log } = setup({ argv: ["QuoteBridge.exe", "--hidden"] });
  shell.start();
  window.minimized = true;

  shell.secondInstance(["QuoteBridge.exe"]);

  assert.equal(window.visible, true);
  assert.equal(window.minimized, false);
  assert.deepEqual(log.slice(-3), ["restore", "show", "focus"]);
});

test("a second launch by the login item (hidden) leaves a hidden app hidden", () => {
  const { shell, window } = setup({ argv: ["QuoteBridge.exe", "--hidden"] });
  shell.start();
  shell.secondInstance(["QuoteBridge.exe", "--hidden"]);
  assert.equal(window.visible, false);
});

test("Quit runs the server's stop path and exits only after it finishes; closing the window then really closes", async () => {
  const { shell, supervisor, exits } = setup();
  shell.start();

  const quitting = shell.quit("quit");
  assert.deepEqual(supervisor.stops, ["quit"]);
  assert.equal(shell.closeRequested(), "close", "the window is not kept while quitting");
  assert.deepEqual(exits, [], "waits for the server");

  supervisor.finishStop({ reason: "quit", outcome: "stopped", checkpoint: true });
  await quitting;
  assert.deepEqual(exits, [0]);
});

test("Windows shutdown or logoff during Quit joins the same stop path and exits once", async () => {
  const { shell, supervisor, exits } = setup();
  shell.start();
  const quit = shell.quit("quit");
  const shutdown = shell.quit("shutdown");
  supervisor.finishStop({ reason: "quit", outcome: "deadline-missed", checkpoint: false });
  await Promise.all([quit, shutdown]);
  assert.deepEqual(supervisor.stops, ["quit"]);
  assert.deepEqual(exits, [0]);
});

test("after setup, Start with Windows registers the login item starting hidden; off removes it", () => {
  const on = setup();
  on.shell.start();
  assert.deepEqual(on.loginItems, [{ openAtLogin: true, args: ["--hidden"] }]);
  assert.equal(on.tray.startWithWindows, true);

  const off = setup({ settings: { ...AFTER_SETUP, startWithWindows: false } });
  off.shell.start();
  assert.deepEqual(off.loginItems, [{ openAtLogin: false, args: ["--hidden"] }]);
  assert.equal(off.tray.startWithWindows, false);
});

test("before setup is completed no login item is registered, although Start with Windows is pre-ticked", () => {
  const { shell, loginItems, tray } = setup({ settings: FIRST_RUN });
  shell.start();
  assert.deepEqual(loginItems, [{ openAtLogin: false, args: ["--hidden"] }]);
  assert.equal(tray.startWithWindows, true);
});

test("a dev run never touches the OS login item", () => {
  const { shell, supervisor, loginItems } = setup({ packaged: false });
  shell.start();
  shell.setStartWithWindows(false);
  supervisor.emit({ type: "settings", settings: { ...AFTER_SETUP, startWithWindows: false } });
  assert.deepEqual(loginItems, []);
});

test("toggling Start with Windows saves it through the server, and the login item follows the saved settings", () => {
  const { shell, supervisor, loginItems, tray } = setup();
  shell.start();

  shell.setStartWithWindows(false);
  assert.deepEqual(supervisor.changes, [{ startWithWindows: false }]);
  assert.equal(loginItems.length, 1, "nothing changes until the server saved it");

  supervisor.emit({ type: "settings", settings: { ...AFTER_SETUP, startWithWindows: false } });
  assert.deepEqual(loginItems.at(-1), { openAtLogin: false, args: ["--hidden"] });
  assert.equal(tray.startWithWindows, false);

  supervisor.emit({ type: "settings", settings: { ...AFTER_SETUP, startWithWindows: true } });
  assert.deepEqual(loginItems.at(-1), { openAtLogin: true, args: ["--hidden"] });
  assert.equal(tray.startWithWindows, true);
});

function status(warning: SupervisorStatus["warning"]): SupervisorStatus {
  return { state: "restarting", warning, failures: 3, nextLaunchAt: null, lastError: null, server: null, serverStatus: null };
}

test("the tray shows the supervisor's warning and clears it when the warning goes", () => {
  const { shell, supervisor, tray } = setup();
  shell.start();
  supervisor.emit({ type: "state", status: status({ reason: "repeated-failures", failures: 3, message: "The server keeps stopping." }) });
  assert.equal(tray.warning, "The server keeps stopping.");
  supervisor.emit({ type: "state", status: status(null) });
  assert.equal(tray.warning, null);
});

test("a crashed window renderer gets a fresh one-time token and reloads", async () => {
  const { shell, supervisor, window } = setup();
  shell.start();
  await shell.rendererGone();
  assert.equal(supervisor.tokenRequests, 1);
  assert.equal(window.url, "http://127.0.0.1:6580/session?token=reissued-1");
});
