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
  restarts = 0;
  finishStop: (result: StopResult) => void = () => {};
  private listeners = new Set<(e: SupervisorEvent) => void>();
  start() {
    this.started = true;
  }
  stop(reason: StopReason) {
    this.stops.push(reason);
    return new Promise<StopResult>((resolve) => (this.finishStop = resolve));
  }
  restart() {
    this.restarts++;
    return Promise.resolve();
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
  const window = { visible: false, minimized: false, url: null as string | null, titleBar: null as { color: string; symbolColor: string } | null };
  /** Windows' own colour mode, which the System theme follows. */
  const system = { dark: false };
  const tray = { warning: null as string | null, startWithWindows: null as boolean | null };
  const notifications: { title: string; body: string }[] = [];
  const loginItems: LoginItem[] = [];
  const exits: number[] = [];
  const themes: string[] = [];
  const supervisor = new FakeSupervisor();
  const ports: ShellPorts = {
    window: {
      show: () => void ((window.visible = true), log.push("show")),
      hide: () => void ((window.visible = false), log.push("hide")),
      focus: () => void log.push("focus"),
      restore: () => void ((window.minimized = false), log.push("restore")),
      isMinimized: () => window.minimized,
      loadURL: (url) => void (window.url = url),
      setTitleBarColours: (colours) => void (window.titleBar = colours),
    },
    tray: {
      setWarning: (message) => void (tray.warning = message),
      setStartWithWindows: (on) => void (tray.startWithWindows = on),
    },
    supervisor,
    notify: (title, body) => void notifications.push({ title, body }),
    setLoginItem: packaged ? (item) => void loginItems.push(item) : null,
    exit: (code) => void exits.push(code),
    setTheme: (theme) => void themes.push(theme),
    systemUsesDarkColours: () => system.dark,
  };
  const shell = new Shell(ports, { settings, argv });
  return { shell, window, tray, notifications, loginItems, exits, supervisor, log, themes, system };
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

test("Quit warns once with unresolved requests, survives crash state, and still joins one stop path", async () => {
  const { shell, supervisor, notifications, exits } = setup();
  shell.start();
  supervisor.emit({ type: "server-status", status: {
    feeds: { total: 0, online: 0, offline: 0, stale: 0, noQuote: 0, duplicateCharts: 0, dropped: 0 },
    terminals: [], terminalsNeedingAttention: [], invalidMessages: 0, unresolvedRequests: 2,
  } });
  supervisor.emit({ type: "state", status: { ...status(null), serverStatus: {
    feeds: { total: 0, online: 0, offline: 0, stale: 0, noQuote: 0, duplicateCharts: 0, dropped: 0 },
    terminals: [], terminalsNeedingAttention: [], invalidMessages: 0, unresolvedRequests: 0,
  } } });
  const quit = shell.quit("quit");
  const shutdown = shell.quit("shutdown");
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].body, /2 unresolved/i);
  assert.match(notifications[0].body, /MetaTrader/i);
  assert.deepEqual(supervisor.stops, ["quit"]);
  assert.deepEqual(exits, []);
  supervisor.finishStop({ reason: "quit", outcome: "stopped", checkpoint: true });
  await Promise.all([quit, shutdown]);
  assert.deepEqual(exits, [0]);
});

test("Quit warns once when final status reveals unresolved work before stopped", async () => {
  const { shell, supervisor, notifications, exits } = setup();
  const summary = {
    feeds: { total: 0, online: 0, offline: 0, stale: 0, noQuote: 0, duplicateCharts: 0, dropped: 0 },
    terminals: [], terminalsNeedingAttention: [], invalidMessages: 0,
  };
  supervisor.emit({ type: "server-status", status: { ...summary, unresolvedRequests: 0 } });
  const quit = shell.quit("quit");
  assert.equal(notifications.length, 0);
  supervisor.emit({ type: "server-status", status: { ...summary, unresolvedRequests: 1 } });
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].body, /1 unresolved/i);
  assert.deepEqual(exits, [], "warning precedes exit");
  supervisor.emit({ type: "server-status", status: { ...summary, unresolvedRequests: 1 } });
  const shutdown = shell.quit("shutdown");
  assert.equal(notifications.length, 1);
  assert.deepEqual(supervisor.stops, ["quit"]);
  supervisor.finishStop({ reason: "quit", outcome: "stopped", checkpoint: true });
  await Promise.all([quit, shutdown]);
  assert.deepEqual(exits, [0]);
});

test("fresh recovered status can clear unresolved work; absent counts do not erase it", async () => {
  for (const recovered of [false, true]) {
    const { shell, supervisor, notifications } = setup();
    const summary = {
      feeds: { total: 0, online: 0, offline: 0, stale: 0, noQuote: 0, duplicateCharts: 0, dropped: 0 },
      terminals: [], terminalsNeedingAttention: [], invalidMessages: 0,
    };
    supervisor.emit({ type: "server-status", status: { ...summary, unresolvedRequests: 1 } });
    supervisor.emit({ type: "server-status", status: summary });
    if (recovered) supervisor.emit({ type: "server-status", status: { ...summary, unresolvedRequests: 0 } });
    const quitting = shell.quit("quit");
    assert.equal(notifications.length, recovered ? 0 : 1);
    supervisor.finishStop({ reason: "quit", outcome: "stopped", checkpoint: true });
    await quitting;
  }
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

test("the tray warns while a managed terminal needs attention; a server warning takes precedence", () => {
  const { shell, supervisor, tray } = setup();
  shell.start();
  const serverStatus = (attention: { terminalId: string; name: string; message: string }[]) => ({
    feeds: { total: 0, online: 0, offline: 0, stale: 0, noQuote: 0, duplicateCharts: 0, dropped: 0 },
    terminals: [],
    terminalsNeedingAttention: attention,
    invalidMessages: 0,
  });
  const failed = { terminalId: "mt4-0123456789ab", name: "CMC Markets MetaTrader 4", message: "MetaEditor reported errors." };

  supervisor.emit({ type: "server-status", status: serverStatus([failed]) });
  assert.equal(tray.warning, "CMC Markets MetaTrader 4 needs attention: MetaEditor reported errors.");

  supervisor.emit({ type: "state", status: status({ reason: "repeated-failures", failures: 3, message: "The server keeps stopping." }) });
  assert.equal(tray.warning, "The server keeps stopping.");
  supervisor.emit({ type: "state", status: status(null) });
  assert.equal(tray.warning, "CMC Markets MetaTrader 4 needs attention: MetaEditor reported errors.");

  supervisor.emit({ type: "server-status", status: serverStatus([failed, { ...failed, terminalId: "mt4-ba9876543210", name: "Other MT4" }]) });
  assert.equal(tray.warning, "2 terminals need attention. Open the Terminals view.");

  supervisor.emit({ type: "server-status", status: serverStatus([]) });
  assert.equal(tray.warning, null);
});

test("Open the window at startup: a sign-in start shows the window instead of staying in the tray", () => {
  const { shell, window } = setup({ settings: { ...AFTER_SETUP, openWindowAtStartup: true }, argv: ["--hidden"] });
  shell.start();
  assert.equal(window.visible, true);
});

test("a second launch by the login item still leaves the app where it is, whatever Open the window at startup says", () => {
  const { shell, window } = setup({ settings: { ...AFTER_SETUP, openWindowAtStartup: true }, argv: ["--hidden"] });
  shell.start();
  window.visible = false;
  shell.secondInstance(["QuoteBridge.exe", "--hidden"]);
  assert.equal(window.visible, false);
});

test("the theme reaches Electron at start and whenever the server saved a new one", () => {
  const { shell, supervisor, themes } = setup({ settings: { ...AFTER_SETUP, theme: "dark" } });
  shell.start();
  assert.deepEqual(themes, ["dark"]);
  supervisor.emit({ type: "settings", settings: { ...AFTER_SETUP, theme: "light" } });
  assert.deepEqual(themes, ["dark", "light"]);
});

test("the title bar takes the rail colour of the theme at start, after a saved change and when Windows switches", () => {
  const LIGHT = { color: "#161d45", symbolColor: "#c3cbe0" };
  const DARK = { color: "#060b17", symbolColor: "#c3cbe0" };
  const { shell, supervisor, window, system } = setup({ settings: { ...AFTER_SETUP, theme: "dark" } });
  shell.start();
  assert.deepEqual(window.titleBar, DARK);

  supervisor.emit({ type: "settings", settings: { ...AFTER_SETUP, theme: "light" } });
  assert.deepEqual(window.titleBar, LIGHT);

  // System follows Windows, at the saved change and whenever Windows switches.
  system.dark = true;
  supervisor.emit({ type: "settings", settings: { ...AFTER_SETUP, theme: "system" } });
  assert.deepEqual(window.titleBar, DARK);
  system.dark = false;
  shell.systemThemeChanged();
  assert.deepEqual(window.titleBar, LIGHT);

  // A forced theme ignores Windows switching.
  supervisor.emit({ type: "settings", settings: { ...AFTER_SETUP, theme: "dark" } });
  shell.systemThemeChanged();
  assert.deepEqual(window.titleBar, DARK);
});

test("a saved port change restarts the server through the stop path, so it binds the new ports; other changes do not", () => {
  const { shell, supervisor } = setup();
  shell.start();

  supervisor.emit({ type: "settings", settings: { ...AFTER_SETUP, startWithWindows: false } });
  assert.equal(supervisor.restarts, 0);

  supervisor.emit({ type: "settings", settings: { ...AFTER_SETUP, startWithWindows: false, ports: { ea: 5556, http: 5580 } } });
  assert.equal(supervisor.restarts, 1);

  supervisor.emit({ type: "settings", settings: { ...AFTER_SETUP, theme: "dark", ports: { ea: 5556, http: 5580 } } });
  assert.equal(supervisor.restarts, 1, "the same ports again: no restart");
});
