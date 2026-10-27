// Main process: thin Electron wiring for the shell (src/main/shell) and the supervisor (ADR 10).
// The rules live in `Shell` and `Supervisor` and are tested there; this file only connects Electron.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerMonitor, screen, shell as electronShell, Tray, utilityProcess } from "electron";
import { dirname, join } from "node:path";
import { get } from "node:http";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { aboutText, APP_NAME, APP_USER_MODEL_ID, SOURCE_URL } from "../shared/app-identity.js";
import { TRADINGVIEW_URL } from "../shared/licences.js";
import { SettingsStore, type Settings } from "../shared/settings-store.js";
import { Supervisor, utilityProcessLauncher, type SupervisorEvent } from "./supervisor/index.js";
import { appDataFolder, bridgeBundleFolders, devRunControls, effectivePorts, readDevOverrides, Shell, TITLE_BAR_COLOURS, type ShellPorts } from "./shell/index.js";
import { DevSignInFile } from "./shell/dev-sign-in-file.js";
import { discBitmap, TRAY_COLOURS } from "./shell/tray-icon.js";
import { WindowCapturer, type PageReady } from "./shell/window-capture.js";
import type { ScreenshotView } from "../shared/server-host-protocol.js";

const devRun = devRunControls(app.isPackaged, process.env);
const SERVER_ENTRY = devRun.serverEntry ?? fileURLToPath(new URL("../server/entry.js", import.meta.url));
const PRELOAD = fileURLToPath(new URL("./preload.cjs", import.meta.url));
/** Must match src/main/preload.cts. */
const PICK_FOLDER_CHANNEL = "quotebridge:pick-folder";
const ABOUT_CHANNEL = "quotebridge:about";
const OPEN_DATA_FOLDER_CHANNEL = "quotebridge:open-data-folder";
const SCREENSHOT_CHANNEL = "quotebridge:screenshot";
const SCREENSHOT_REPLY_CHANNEL = "quotebridge:screenshot-reply";
/** The title bar overlay's height; the dashboard reserves it with the titlebar-area environment variables. */
const TITLE_BAR_HEIGHT = 32;
/** Space between the title bar and the starting page's text. */
const STARTING_PAGE_MARGIN = 32;
/** Windows cuts tray tooltips at 127 characters. */
const TOOLTIP_MAX = 127;
/** The only pages the window opens, in the default browser: the source and the attribution Lightweight Charts asks for. */
const EXTERNAL_LINKS = new Set([SOURCE_URL, TRADINGVIEW_URL]);
const STARTING_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(
  `<!doctype html><title>${APP_NAME}</title><body style="font-family:Segoe UI,sans-serif;margin:0;padding:${TITLE_BAR_HEIGHT + STARTING_PAGE_MARGIN}px 2rem;color:#444;app-region:drag">Starting ${APP_NAME}…</body>`,
)}`;

const overrides = readDevOverrides(process.env);
const dataFolder = appDataFolder(app.getPath("appData"), overrides);
// Before the single-instance lock: Electron keys the lock on this folder, so a dev run with its own
// data folder never collides with the installed app.
app.setPath("userData", dataFolder);
// Chromium's caches and storage in a subfolder, beside the app's own files rather than among them.
app.setPath("sessionData", join(dataFolder, "Browser"));
app.setAppUserModelId(APP_USER_MODEL_ID);

if (!app.requestSingleInstanceLock()) {
  // Another copy runs; it receives `second-instance` and shows its window.
  app.exit(0);
} else {
  // The app lives in the tray (ADR 6): closing every window must not quit.
  app.on("window-all-closed", () => {});
  app.whenReady().then(boot, (e) => {
    console.error(e);
    app.exit(1);
  });
}

async function boot() {
  // Main only reads settings; the server process is the single writer (update-settings).
  let settings: Settings = await new SettingsStore(dataFolder).read();
  if (overrides.dataFolder || overrides.eaPort || overrides.httpPort) {
    // Ports that cannot work are reported by the supervisor (it reads them again before every launch).
    let ports: string;
    try {
      ports = JSON.stringify(effectivePorts(settings.ports, overrides));
    } catch (e) {
      ports = `unusable (${(e as Error).message})`;
    }
    console.log(`[QuoteBridge] dev overrides: data folder ${dataFolder}, ports ${ports}`);
  }

  // Set once the window exists; the server may ask for a screenshot before then.
  let capturer: WindowCapturer | undefined;
  const bridgeBundle = bridgeBundleFolders({ isPackaged: app.isPackaged, appPath: app.getAppPath(), resourcesPath: process.resourcesPath }, process.env);
  const supervisor = new Supervisor({
    launch: utilityProcessLauncher(utilityProcess.fork, SERVER_ENTRY),
    config: () => {
      const ports = effectivePorts(settings.ports, overrides);
      return { eaPort: ports.ea, httpPort: ports.http, dataFolder, bridgeBundle };
    },
    captureWindow: (view) => (capturer ? capturer.capture(view) : Promise.reject(Error("The app window is still starting."))),
  });
  supervisor.onEvent((event) => {
    if (event.type === "settings") settings = event.settings;
    logEvent(event);
  });
  // `npm run dev -- --app`: a sign-in link for a browser, besides the window's own, after every server start.
  const signInFile = devRun.signInFile ? new DevSignInFile(devRun.signInFile) : null;
  const newSignInLink = async () => {
    if (!signInFile) return;
    try {
      await signInFile.set(await supervisor.issueWindowToken());
    } catch (e) {
      console.error(`[QuoteBridge] dev sign-in link: ${(e as Error).message}`);
    }
  };
  supervisor.onEvent((event) => {
    if (event.type === "window-url") void newSignInLink();
  });

  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    title: APP_NAME,
    // Hidden title bar: the dashboard draws the rail colour up into it and Windows draws the caption buttons over it.
    // The shell sets the overlay's colours from the theme before the window first shows.
    titleBarStyle: "hidden",
    titleBarOverlay: { ...TITLE_BAR_COLOURS.light, height: TITLE_BAR_HEIGHT },
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: PRELOAD },
  });
  // The dashboard's Add folder (ADR 2: Electron-only, with a typed-path fallback in the page).
  ipcMain.handle(PICK_FOLDER_CHANNEL, async (event, title: unknown) => {
    if (event.sender !== window.webContents) return null;
    const result = await dialog.showOpenDialog(window, {
      title: typeof title === "string" ? title.slice(0, 200) : "Choose the MetaTrader folder",
      properties: ["openDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  // The Settings view's About section: facts only main knows, and the data folder in Explorer.
  ipcMain.handle(ABOUT_CHANNEL, (event) => {
    if (event.sender !== window.webContents) return null;
    return { version: app.getVersion(), installFolder: app.isPackaged ? dirname(app.getPath("exe")) : null, dataFolder };
  });
  ipcMain.handle(OPEN_DATA_FOLDER_CHANNEL, async (event) => {
    if (event.sender !== window.webContents) return;
    await electronShell.openPath(dataFolder);
  });
  // Screenshots through the REST API: the page switches the view and says when it has drawn (or which dialog is open).
  const pageAnswers = new Map<number, (ready: PageReady) => void>();
  let nextPageRequest = 1;
  ipcMain.on(SCREENSHOT_REPLY_CHANNEL, (event, reply: { id?: unknown; ready?: PageReady }) => {
    if (event.sender !== window.webContents || typeof reply?.id !== "number" || !reply.ready) return;
    pageAnswers.get(reply.id)?.(reply.ready);
    pageAnswers.delete(reply.id);
  });
  const displayScale = () => screen.getDisplayMatching(window.getBounds()).scaleFactor;
  capturer = new WindowCapturer({
    unavailable: () => {
      if (window.isDestroyed()) return "The app window is closed.";
      if (window.webContents.isCrashed()) return "The app window is being recreated after a crash.";
      const origin = supervisor.status().server?.httpOrigin;
      if (!origin || !window.webContents.getURL().startsWith(origin)) return "The app window is still starting.";
      return null;
    },
    // Minimised first: Windows reports a minimised window as not visible.
    state: () => (window.isMinimized() ? "minimised" : window.isVisible() ? "visible" : "hidden"),
    getOpacity: () => window.getOpacity(),
    setOpacity: (value) => window.setOpacity(value),
    showInactive: () => window.showInactive(),
    hide: () => window.hide(),
    scale: displayScale,
    prepare: (view: ScreenshotView) =>
      new Promise<PageReady>((resolve) => {
        const id = nextPageRequest++;
        pageAnswers.set(id, resolve);
        window.webContents.send(SCREENSHOT_CHANNEL, { id, view });
      }),
    capture: async () => {
      const image = await window.webContents.capturePage();
      // The bitmap at the window's display scale: its own physical pixels.
      return image.isEmpty() ? new Uint8Array() : image.toPNG({ scaleFactor: displayScale() });
    },
  });
  // A crashed page never answers: those captures fail at once instead of at their deadline.
  window.webContents.on("render-process-gone", () => {
    for (const answer of pageAnswers.values()) answer({ unavailable: "The app window's page stopped; it is being recreated." });
    pageAnswers.clear();
  });
  window.removeMenu();
  void window.loadURL(STARTING_PAGE);
  // The window shows only the app's own dashboard; the About links open in the default browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (EXTERNAL_LINKS.has(url)) void electronShell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    const origin = supervisor.status().server?.httpOrigin;
    if (!origin || new URL(url).origin !== origin) event.preventDefault();
  });

  const icons = {
    normal: nativeImage.createFromBitmap(discBitmap(16, TRAY_COLOURS.normal), { width: 16, height: 16 }),
    warning: nativeImage.createFromBitmap(discBitmap(16, TRAY_COLOURS.warning), { width: 16, height: 16 }),
  };
  const tray = new Tray(icons.normal);
  tray.setToolTip(APP_NAME);
  let startWithWindows = settings.startWithWindows;
  const buildMenu = () =>
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open", click: () => shell.openFromTray() },
        { label: "Start with Windows", type: "checkbox", checked: startWithWindows, click: (item) => shell.setStartWithWindows(item.checked) },
        { label: "About", click: () => showAbout() },
        { type: "separator" },
        { label: "Quit", click: () => void shell.quit("quit") },
      ]),
    );

  const showAbout = () => {
    // The installer lets the user choose the folder; a development build has none to show.
    const about = aboutText(app.getVersion(), app.isPackaged ? dirname(app.getPath("exe")) : undefined);
    const options = { type: "info" as const, buttons: ["OK"], ...about };
    void (window.isVisible() ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options));
  };

  const ports: ShellPorts = {
    window: {
      show: () => window.show(),
      hide: () => window.hide(),
      focus: () => window.focus(),
      restore: () => window.restore(),
      isMinimized: () => window.isMinimized(),
      loadURL: (url) => void window.loadURL(url).catch((e) => console.error(`[QuoteBridge] window load failed: ${e.message}`)),
      setTitleBarColours: (colours) => window.setTitleBarOverlay({ ...colours, height: TITLE_BAR_HEIGHT }),
    },
    tray: {
      setWarning: (message) => {
        tray.setImage(message ? icons.warning : icons.normal);
        tray.setToolTip(message ? `${APP_NAME}: ${message}`.slice(0, TOOLTIP_MAX) : APP_NAME);
      },
      setStartWithWindows: (on) => {
        startWithWindows = on;
        buildMenu();
      },
    },
    supervisor: {
      start: () => supervisor.start(),
      stop: async (reason) => {
        const result = await supervisor.stop(reason);
        console.log(`[QuoteBridge] stop path (${reason}): ${result.outcome}, checkpoint ${result.checkpoint}`);
        return result;
      },
      issueWindowToken: () => supervisor.issueWindowToken(),
      restart: () => supervisor.restart(),
      updateSettings: (change) => supervisor.updateSettings(change),
      onEvent: (listener) => supervisor.onEvent(listener),
    },
    notify: (title, body) => {
      if (Notification.isSupported()) new Notification({ title, body }).show();
    },
    // A dev run leaves the OS login item alone: it would start the dev Electron at every login.
    setLoginItem: app.isPackaged ? (item) => app.setLoginItemSettings(item) : null,
    exit: (code) => app.exit(code),
    setTheme: (theme) => {
      nativeTheme.themeSource = theme;
    },
    systemUsesDarkColours: () => nativeTheme.shouldUseDarkColors,
  };
  const shell = new Shell(ports, { settings, argv: process.argv });

  tray.on("click", () => shell.openFromTray());
  nativeTheme.on("updated", () => shell.systemThemeChanged());
  window.on("close", (event) => {
    if (shell.closeRequested() === "hide") event.preventDefault();
  });
  window.webContents.on("render-process-gone", () => void shell.rendererGone());
  app.on("second-instance", (_event, argv) => shell.secondInstance(argv));
  // Any other way of quitting (e.g. an update installer) goes through the same stop path.
  app.on("before-quit", (event) => {
    event.preventDefault();
    void shell.quit("quit");
  });
  // Windows shutdown or logoff (Electron cannot tell them apart here); powerMonitor covers other systems.
  window.on("session-end", () => void shell.quit("shutdown"));
  powerMonitor.on("shutdown", () => void shell.quit("shutdown"));

  shell.start();

  if (devRun.controlUrl) {
    // `npm run dev -- --app`: the runner restarts the server after a rebuild, quits main before relaunching it,
    // and asks for a new sign-in link when Enter is pressed.
    get(devRun.controlUrl, (response) => {
      createInterface({ input: response }).on("line", (line) => {
        if (line === "event: restart-server") void supervisor.restart();
        else if (line === "event: quit") void shell.quit("quit");
        else if (line === "event: sign-in-link") void newSignInLink();
      });
    }).on("error", (e) => console.error(`[QuoteBridge] dev control stream: ${e.message}`));
    // Ctrl+C in the runner's console reaches this process too; the runner quits it through the stop path.
    process.on("SIGINT", () => {});
  }
}

function logEvent(event: SupervisorEvent) {
  if (event.type === "state") {
    const { state, warning, lastError } = event.status;
    console.log(`[QuoteBridge] server ${state}${warning ? ` (warning: ${warning.message})` : ""}${lastError && state !== "running" ? ` (last error: ${lastError.message})` : ""}`);
  } else if (event.type === "settings") {
    console.log("[QuoteBridge] settings saved by the server");
  }
}
