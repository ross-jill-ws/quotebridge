// The shell's launch environment: where the app keeps its data, which ports it uses, and how a
// dev run points both elsewhere so it never touches the user's real `%APPDATA%\QuoteBridge` or ports.
import { isAbsolute, join } from "node:path";
import type { Settings } from "../../shared/settings-store.js";

/** The name of the app's per-user data folder under `%APPDATA%` (ADR 7). */
export const APP_DATA_FOLDER_NAME = "QuoteBridge";

/** The argument the Start with Windows login item passes: start hidden in the tray (ADR 6). */
export const HIDDEN_ARG = "--hidden";

/** Dev-run overrides from environment variables; settings are never changed by them. */
export type DevOverrides = {
  /** `QUOTEBRIDGE_DATA_FOLDER`: an absolute folder used instead of `%APPDATA%\QuoteBridge`. */
  dataFolder?: string;
  /** `QUOTEBRIDGE_EA_PORT` and `QUOTEBRIDGE_HTTP_PORT`: used instead of the ports in settings. */
  eaPort?: number;
  httpPort?: number;
};

export function readDevOverrides(env: Record<string, string | undefined>): DevOverrides {
  const overrides: DevOverrides = {};
  const dataFolder = env.QUOTEBRIDGE_DATA_FOLDER?.trim();
  if (dataFolder) {
    if (!isAbsolute(dataFolder)) throw Error(`QUOTEBRIDGE_DATA_FOLDER must be an absolute folder, not "${dataFolder}".`);
    overrides.dataFolder = dataFolder;
  }
  const eaPort = portVariable(env, "QUOTEBRIDGE_EA_PORT");
  if (eaPort !== undefined) overrides.eaPort = eaPort;
  const httpPort = portVariable(env, "QUOTEBRIDGE_HTTP_PORT");
  if (httpPort !== undefined) overrides.httpPort = httpPort;
  return overrides;
}

function portVariable(env: Record<string, string | undefined>, name: string): number | undefined {
  const text = env[name]?.trim();
  if (!text) return undefined;
  const port = Number(text);
  if (!/^\d+$/.test(text) || port < 1 || port > 65535) throw Error(`${name} must be a port from 1 to 65535, not "${text}".`);
  return port;
}

/** `%APPDATA%\QuoteBridge`, or the dev override. `appData` is Electron's `app.getPath("appData")`. */
export function appDataFolder(appData: string, overrides: DevOverrides): string {
  return overrides.dataFolder ?? join(appData, APP_DATA_FOLDER_NAME);
}

/** The ports the server binds: from settings, with dev overrides on top. */
export function effectivePorts(ports: Settings["ports"], overrides: DevOverrides): Settings["ports"] {
  const effective = { ea: overrides.eaPort ?? ports.ea, http: overrides.httpPort ?? ports.http };
  if (effective.ea === effective.http) throw Error(`The EA port and the HTTP port must differ (both are ${effective.ea}).`);
  return effective;
}
