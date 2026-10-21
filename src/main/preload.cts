// Preload of the app window (ADR 2): the small Electron-only bridge the dashboard detects at runtime.
// Sandboxed, so CommonJS and only `electron`. The dashboard falls back to plain web features without it.
import electron = require("electron");

const PICK_FOLDER_CHANNEL = "quotebridge:pick-folder";

electron.contextBridge.exposeInMainWorld("quoteBridgeNative", {
  /** Opens the native folder picker; resolves with the chosen folder, or null when cancelled. */
  pickFolder: (title?: string): Promise<string | null> => electron.ipcRenderer.invoke(PICK_FOLDER_CHANNEL, typeof title === "string" ? title : undefined),
});
