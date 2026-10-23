// What `npm run dev` runs: the options, the data folder and the ports. Pure, so it is unit-tested.
import { win32 } from "node:path";
import { APP_DATA_FOLDER_NAME, readDevOverrides } from "../../src/main/shell/environment.js";

export const USAGE = `Usage: npm run dev [-- --app] [-- --real]
  (no option)  server with fake terminals and fake EAs on ports 6655/6680, dashboard in the browser
  --app        the same inside the Electron window
  --real       real terminals on the ports from settings (5555/5580), with a dev data folder`;

/** Dev ports, away from the app's 5555/5580. */
export const DEV_PORTS = { ea: 6655, http: 6680 };
/** Where pages listen for the dev reload signal; a --real run has its own, so it can run beside a fake one. */
export const DEV_RELOAD_PORT = 6681;
export const REAL_RUN_RELOAD_PORT = 6682;

export type DevPlan = {
  /** Electron window (supervisor) instead of a browser tab. */
  app: boolean;
  /** Real terminals and MetaEditor; otherwise fake ones in the data folder, plus fake EAs. */
  real: boolean;
  dataFolder: string;
  /** Port overrides; a missing one comes from settings. Undefined: both from settings (--real). */
  ports: { ea: number | undefined; http: number | undefined } | undefined;
  reloadPort: number;
};

export function planDevRun(args: string[], env: Record<string, string | undefined>, places: { appData: string; temp: string }): DevPlan {
  const unknown = args.filter((a) => a !== "--app" && a !== "--real");
  if (unknown.length) throw Error(`Unknown option ${unknown.join(" ")}.\n${USAGE}`);
  const app = args.includes("--app");
  const real = args.includes("--real");
  const overrides = readDevOverrides(env);

  const dataFolder = overrides.dataFolder ?? (real ? win32.join(places.appData, `${APP_DATA_FOLDER_NAME}-dev`) : win32.join(places.temp, "quotebridge-dev"));
  if (sameFolder(dataFolder, win32.join(places.appData, APP_DATA_FOLDER_NAME))) {
    throw Error(`${dataFolder} is the installed app's data folder; a dev run never uses it. Choose another QUOTEBRIDGE_DATA_FOLDER.`);
  }

  let ports: DevPlan["ports"];
  if (!real) ports = { ea: overrides.eaPort ?? DEV_PORTS.ea, http: overrides.httpPort ?? DEV_PORTS.http };
  else if (overrides.eaPort !== undefined || overrides.httpPort !== undefined) ports = { ea: overrides.eaPort, http: overrides.httpPort };

  const reloadPort = env.QUOTEBRIDGE_DEV_RELOAD_PORT?.trim() ? Number(env.QUOTEBRIDGE_DEV_RELOAD_PORT) : real ? REAL_RUN_RELOAD_PORT : DEV_RELOAD_PORT;
  if (!Number.isInteger(reloadPort) || reloadPort < 1 || reloadPort > 65535) throw Error(`QUOTEBRIDGE_DEV_RELOAD_PORT must be a port from 1 to 65535.`);
  return { app, real, dataFolder, ports, reloadPort };
}

function sameFolder(a: string, b: string) {
  const norm = (p: string) => win32.resolve(p).replace(/\\+$/, "").toLowerCase();
  return norm(a) === norm(b);
}
