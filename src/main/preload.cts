// Preload of the app window (ADR 2): the small Electron-only bridge the dashboard detects at runtime.
// Sandboxed, so CommonJS and only `electron`. The dashboard falls back to plain web features without it.
import electron = require("electron");

const PICK_FOLDER_CHANNEL = "quotebridge:pick-folder";
const ABOUT_CHANNEL = "quotebridge:about";
const OPEN_DATA_FOLDER_CHANNEL = "quotebridge:open-data-folder";

electron.contextBridge.exposeInMainWorld("quoteBridgeNative", {
  /** Opens the native folder picker; resolves with the chosen folder, or null when cancelled. */
  pickFolder: (title?: string): Promise<string | null> => electron.ipcRenderer.invoke(PICK_FOLDER_CHANNEL, typeof title === "string" ? title : undefined),
  /** The app version, its install folder (null in a development run) and its data folder. */
  about: (): Promise<{ version: string; installFolder: string | null; dataFolder: string } | null> => electron.ipcRenderer.invoke(ABOUT_CHANNEL),
  /** Opens the app's data folder in File Explorer. */
  openDataFolder: (): Promise<void> => electron.ipcRenderer.invoke(OPEN_DATA_FOLDER_CHANNEL),
});
