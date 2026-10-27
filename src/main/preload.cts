// Preload of the app window (ADR 2): the small Electron-only bridge the dashboard detects at runtime.
// Sandboxed, so CommonJS and only `electron`. The dashboard falls back to plain web features without it.
import electron = require("electron");

const PICK_FOLDER_CHANNEL = "quotebridge:pick-folder";
const ABOUT_CHANNEL = "quotebridge:about";
const OPEN_DATA_FOLDER_CHANNEL = "quotebridge:open-data-folder";
const SCREENSHOT_CHANNEL = "quotebridge:screenshot";
const SCREENSHOT_REPLY_CHANNEL = "quotebridge:screenshot-reply";

type ScreenshotReady = { ready: true; live: string } | { busy: string } | { unavailable: string };
/** The dashboard's answer to a screenshot: switch to the view and say when it has drawn, or which dialog is open. */
let screenshotHandler: ((view: string) => Promise<ScreenshotReady>) | undefined;

electron.ipcRenderer.on(SCREENSHOT_CHANNEL, async (_event, request: { id: number; view: string }) => {
  let ready: ScreenshotReady;
  try {
    ready = screenshotHandler ? await screenshotHandler(request.view) : { unavailable: "The app window is still loading." };
  } catch (e) {
    ready = { unavailable: `The app window could not show the view: ${(e as Error)?.message ?? e}` };
  }
  electron.ipcRenderer.send(SCREENSHOT_REPLY_CHANNEL, { id: request.id, ready });
});

electron.contextBridge.exposeInMainWorld("quoteBridgeNative", {
  /** Opens the native folder picker; resolves with the chosen folder, or null when cancelled. */
  pickFolder: (title?: string): Promise<string | null> => electron.ipcRenderer.invoke(PICK_FOLDER_CHANNEL, typeof title === "string" ? title : undefined),
  /** The app version, its install folder (null in a development run) and its data folder. */
  about: (): Promise<{ version: string; installFolder: string | null; dataFolder: string } | null> => electron.ipcRenderer.invoke(ABOUT_CHANNEL),
  /** Opens the app's data folder in File Explorer. */
  openDataFolder: (): Promise<void> => electron.ipcRenderer.invoke(OPEN_DATA_FOLDER_CHANNEL),
  /** Answers main's screenshot requests (one handler; a later one replaces it). */
  onScreenshot: (handler: (view: string) => Promise<ScreenshotReady>): void => {
    screenshotHandler = typeof handler === "function" ? handler : undefined;
  },
});
