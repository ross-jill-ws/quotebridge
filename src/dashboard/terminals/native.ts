// The Electron-only bridge (ADR 2) the app window's preload exposes; absent in a normal browser.
import type { LiveLinkState, ScreenshotView } from "../../shared/server-host-protocol.js";

export type AboutApp = { version: string; installFolder: string | null; dataFolder: string };

type QuoteBridgeNative = {
  pickFolder(title?: string): Promise<string | null>;
  about(): Promise<AboutApp | null>;
  openDataFolder(): Promise<void>;
  /** Absent in an app built before screenshots. */
  onScreenshot?(handler: (view: ScreenshotView) => Promise<ScreenshotReady>): void;
};

/** The page's answer to main's screenshot request (src/main/shell/window-capture.ts, PageReady). */
export type ScreenshotReady = { ready: true; live: LiveLinkState } | { busy: string } | { unavailable: string };

/** The native bridge, or undefined in a browser (the page then offers a typed path instead). */
export function native(): QuoteBridgeNative | undefined {
  const bridge = (globalThis as { quoteBridgeNative?: Partial<QuoteBridgeNative> }).quoteBridgeNative;
  return typeof bridge?.pickFolder === "function" ? (bridge as QuoteBridgeNative) : undefined;
}
