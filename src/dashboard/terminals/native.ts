// The Electron-only bridge (ADR 2) the app window's preload exposes; absent in a normal browser.

export type AboutApp = { version: string; installFolder: string | null; dataFolder: string };

type QuoteBridgeNative = {
  pickFolder(title?: string): Promise<string | null>;
  about(): Promise<AboutApp | null>;
  openDataFolder(): Promise<void>;
};

/** The native bridge, or undefined in a browser (the page then offers a typed path instead). */
export function native(): QuoteBridgeNative | undefined {
  const bridge = (globalThis as { quoteBridgeNative?: Partial<QuoteBridgeNative> }).quoteBridgeNative;
  return typeof bridge?.pickFolder === "function" ? (bridge as QuoteBridgeNative) : undefined;
}
