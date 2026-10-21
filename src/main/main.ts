import { app, BrowserWindow } from "electron";
import { APP_NAME } from "../shared/app-identity.js";

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    title: APP_NAME,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  window.removeMenu();
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => app.quit());
