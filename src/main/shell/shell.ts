// The shell (ADR 6, ADR 10): the rules for the app window, the tray, close-to-tray, single instance,
// Start with Windows and Quit. Electron comes in as ports, so these rules are tested without it.
import type { StopReason, StopResult, SupervisorEvent } from "../supervisor/index.js";
import type { HostSettingsChange } from "../../shared/server-host-protocol.js";
import type { Settings, Theme } from "../../shared/settings-store.js";
import { APP_NAME } from "../../shared/app-identity.js";
import { HIDDEN_ARG } from "./environment.js";

/** The title bar overlay takes the rail colour (dev/design/visual-design.md), with the caption symbols in rail ink. */
export const TITLE_BAR_COLOURS = {
  light: { color: "#161d45", symbolColor: "#c3cbe0" },
  dark: { color: "#060b17", symbolColor: "#c3cbe0" },
} as const;

export type TitleBarColours = { color: string; symbolColor: string };

export const CLOSE_NOTIFICATION_BODY = "The app is still running in the tray, so your quotes keep flowing. To stop it, choose Quit in the tray menu.";

export interface ShellWindow {
  show(): void;
  hide(): void;
  focus(): void;
  restore(): void;
  isMinimized(): boolean;
  loadURL(url: string): void;
  /** The hidden title bar's overlay (Electron `setTitleBarOverlay`). */
  setTitleBarColours(colours: TitleBarColours): void;
}

export interface ShellTray {
  /** Non-null puts the tray in its warning state with this message. */
  setWarning(message: string | null): void;
  setStartWithWindows(on: boolean): void;
}

/** The part of the supervisor the shell drives. */
export interface ShellSupervisor {
  start(): void;
  stop(reason: StopReason): Promise<StopResult>;
  issueWindowToken(): Promise<string>;
  /** Stops the server through the stop path and launches it again (with the ports saved by then). */
  restart(): Promise<void>;
  updateSettings(change: HostSettingsChange): void;
  onEvent(listener: (event: SupervisorEvent) => void): () => void;
}

/** The OS login item (Electron's `app.setLoginItemSettings`). */
export type LoginItem = { openAtLogin: boolean; args: string[] };

export type ShellPorts = {
  window: ShellWindow;
  tray: ShellTray;
  supervisor: ShellSupervisor;
  notify(title: string, body: string): void;
  /** Null in a dev run: the OS login item is left alone (it would start the dev Electron at login). */
  setLoginItem: ((item: LoginItem) => void) | null;
  exit(code: number): void;
  /** Electron's own colours (dialogs, title bar): `nativeTheme.themeSource`. */
  setTheme(theme: Theme): void;
  /** Whether the colours in effect are dark (`nativeTheme.shouldUseDarkColors`); read only while the theme is System. */
  systemUsesDarkColours(): boolean;
};

export type ShellOptions = {
  /** Settings read at boot (main reads; the server is the only writer). */
  settings: Settings;
  /** This process's command line; the login item adds `--hidden`. */
  argv: readonly string[];
};

export class Shell {
  private settings: Settings;
  /** Shown this run (the saved flag may still be on its way to the server). */
  private closeNotificationShown: boolean;
  private quitting: Promise<void> | null = null;
  /** Retained across crashes until a fresh server status supplies a recovered count. */
  private unresolvedRequests = 0;
  private quitWarningShown = false;
  /** The tray warning has two sources: the supervisor (server failing) and managed terminals needing attention. */
  private serverWarning: string | null = null;
  private terminalWarning: string | null = null;

  constructor(
    private readonly ports: ShellPorts,
    private readonly options: ShellOptions,
  ) {
    this.settings = structuredClone(options.settings);
    this.closeNotificationShown = this.settings.firstCloseNotificationShown;
    ports.supervisor.onEvent((event) => this.onSupervisorEvent(event));
  }

  /** Starts the server and shows the window, unless started hidden at login after setup (and not asked to open then). */
  start() {
    this.applySettings(this.settings);
    this.ports.supervisor.start();
    const firstRun = !this.settings.setupCompleted;
    if (firstRun || this.settings.openWindowAtStartup || !this.options.argv.includes(HIDDEN_ARG)) this.ports.window.show();
  }

  /** The user closed the app window: hide to the tray (ADR 6), with a one-time notification. */
  closeRequested(): "hide" | "close" {
    if (this.quitting) return "close";
    this.ports.window.hide();
    if (!this.closeNotificationShown) {
      this.closeNotificationShown = true;
      this.ports.notify(APP_NAME, CLOSE_NOTIFICATION_BODY);
      this.ports.supervisor.updateSettings({ firstCloseNotificationShown: true });
    }
    return "hide";
  }

  /** Tray "Open" (and a click on the tray icon). */
  openFromTray() {
    this.reveal();
  }

  /** Another copy was launched (the single-instance lock is ours): show this one instead. */
  secondInstance(argv: readonly string[]) {
    // The login item launching while the app already runs keeps it where it is.
    if (argv.includes(HIDDEN_ARG)) return;
    this.reveal();
  }

  /**
   * Quit, update, Windows shutdown or logoff: the one stop path (ADR 10), then exit. A second call
   * (e.g. shutdown during Quit) joins the first.
   */
  quit(reason: StopReason): Promise<void> {
    if (!this.quitting) {
      this.quitting = this.ports.supervisor.stop(reason).then(
        () => this.ports.exit(0),
        () => this.ports.exit(1),
      );
      this.warnUnresolvedOnQuit();
    }
    return this.quitting;
  }

  private warnUnresolvedOnQuit() {
    if (!this.quitting || this.quitWarningShown || this.unresolvedRequests <= 0) return;
    this.quitWarningShown = true;
    this.ports.notify(APP_NAME, `${this.unresolvedRequests} unresolved trading request(s). Quitting cannot recall orders already sent. Check open orders and account history in MetaTrader before taking further action; results will be recovered on restart.`);
  }

  /** The tray's Start with Windows checkbox. Saved by the server; the login item follows the saved value. */
  setStartWithWindows(on: boolean) {
    this.ports.supervisor.updateSettings({ startWithWindows: on });
  }

  /** The window's renderer crashed: sessions are one-time, so get a fresh token and reload. */
  async rendererGone() {
    await this.reloadWindow();
  }

  /**
   * F5 or Ctrl+R in the window: the way out when the dashboard gets stuck. A fresh token rather than a plain reload,
   * so it also works after the server restarted and the window's session went with it.
   */
  async reloadRequested() {
    await this.reloadWindow();
  }

  private async reloadWindow() {
    try {
      this.ports.window.loadURL(await this.ports.supervisor.issueWindowToken());
    } catch {
      // No server running: the next `ready` brings a window-url anyway.
    }
  }

  /** Windows switched between light and dark (`nativeTheme` updated): the System theme follows it. */
  systemThemeChanged() {
    this.applyTitleBar();
  }

  private applyTitleBar() {
    const { theme } = this.settings;
    const dark = theme === "dark" || (theme === "system" && this.ports.systemUsesDarkColours());
    this.ports.window.setTitleBarColours(dark ? TITLE_BAR_COLOURS.dark : TITLE_BAR_COLOURS.light);
  }

  /** Settings at boot and every time the server saved a change. */
  private applySettings(settings: Settings) {
    // The server binds its ports at start: new ones take a restart (the Settings view's Change…).
    const portsChanged = settings.ports.ea !== this.settings.ports.ea || settings.ports.http !== this.settings.ports.http;
    this.settings = structuredClone(settings);
    this.ports.setTheme(settings.theme);
    this.applyTitleBar();
    if (portsChanged) void this.ports.supervisor.restart();
    if (settings.firstCloseNotificationShown) this.closeNotificationShown = true;
    this.ports.tray.setStartWithWindows(settings.startWithWindows);
    this.ports.setLoginItem?.(loginItemFor(settings));
  }

  private showWarning() {
    this.ports.tray.setWarning(this.serverWarning ?? this.terminalWarning);
  }

  private reveal() {
    const { window } = this.ports;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  private onSupervisorEvent(event: SupervisorEvent) {
    switch (event.type) {
      case "window-url":
        return this.ports.window.loadURL(event.url);
      case "state":
        this.serverWarning = event.status.warning?.message ?? null;
        return this.showWarning();
      case "server-status": {
        // State events may contain stale pre-crash summaries; only fresh status updates this count.
        if (event.status.unresolvedRequests !== undefined) this.unresolvedRequests = event.status.unresolvedRequests;
        this.warnUnresolvedOnQuit();
        const attention = event.status.terminalsNeedingAttention ?? [];
        this.terminalWarning =
          attention.length === 0
            ? null
            : attention.length === 1
              ? `${attention[0].name} needs attention: ${attention[0].message}`
              : `${attention.length} terminals need attention. Open the Terminals view.`;
        return this.showWarning();
      }
      case "settings":
        return this.applySettings(event.settings);
    }
  }
}

/**
 * Start with Windows (ADR 6) as the OS login item: starts hidden in the tray. Only once setup is
 * completed, where the user confirms the pre-ticked choice.
 */
/** The keys that reload the window (Electron's `before-input-event` input): F5 and Ctrl+R, on key down. */
export function isReloadKey(input: { type: string; key: string; control: boolean; alt: boolean; meta: boolean; shift: boolean }): boolean {
  if (input.type !== "keyDown" || input.alt || input.meta) return false;
  if (input.key === "F5") return !input.control && !input.shift;
  return input.control && !input.shift && input.key.toLowerCase() === "r";
}

export function loginItemFor(settings: Settings): LoginItem {
  return { openAtLogin: settings.setupCompleted && settings.startWithWindows, args: [HIDDEN_ARG] };
}
