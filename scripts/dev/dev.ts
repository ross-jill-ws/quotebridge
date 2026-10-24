// `npm run dev`: the app for development, with live reload. See USAGE in dev-plan.ts.
// - The dashboard is rebuilt on change and every open page (browser tab or app window) reloads itself.
// - The server is rebuilt on change (src/server, src/shared, the fakes) and restarted through the
//   supervisor's stop path; fake EAs reconnect and open pages follow the new sign-in link.
// - With --app, a change to the main process (src/main, src/shared) relaunches Electron.
import { fork, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, watch } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { context, type Plugin } from "esbuild";
import { DEV_SIGN_IN_FILE_NAME, DevSignInFile } from "../../src/main/shell/dev-sign-in-file.js";
import { bridgeBundleFolders } from "../../src/main/shell/environment.js";
import { Supervisor, type ServerProcess } from "../../src/main/supervisor/supervisor.js";
import { ipcTransport } from "../../src/shared/host-transport.js";
import type { HostMessage, ServerMessage } from "../../src/shared/server-host-protocol.js";
import { SettingsStore } from "../../src/shared/settings-store.js";
import { copyStatic, DASHBOARD_OUT, DASHBOARD_SOURCE, dashboardBuildOptions, STATIC_FILES } from "../dashboard-build.js";
import { copyBundledPackages } from "../indicators-build.js";
import { planDevRun, type DevPlan } from "./dev-plan.js";
import { fakeFeeds } from "./fake-feeds.js";
import { fakeFeedIdentity } from "./fake-terminals.js";
import { realPortsRefusal } from "./port-check.js";
import { seedRealRunSettings } from "./real-run.js";
import { startReloadServer } from "./reload-server.js";
import { RestartScheduler } from "./restart-scheduler.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const DEV_BUILD = join(root, ".dev-build");
const SERVER_BUNDLE = join(DEV_BUILD, "server-entry.mjs");
const QUIET_MS = 300;
const log = (message: string) => console.log(`[dev] ${message}`);
let stopping = false;

let plan: DevPlan;
try {
  plan = planDevRun(process.argv.slice(2), process.env, { appData: process.env.APPDATA ?? join(tmpdir(), "AppData"), temp: tmpdir() });
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
const { app, real, dataFolder, reloadPort } = plan;
mkdirSync(dataFolder, { recursive: true });
// Scripts and agents read the current sign-in link from this file, never from the console (docs/development.md).
const signInFile = new DevSignInFile(join(dataFolder, DEV_SIGN_IN_FILE_NAME));
await signInFile.remove();
// A fresh --real data folder skips setup with no managed terminals: nothing is installed until Install is clicked.
if (real && (await seedRealRunSettings(dataFolder))) log(`new dev settings in ${dataFolder}: setup done, no managed terminals`);
const settingsPorts = (await new SettingsStore(dataFolder).read()).ports;
const ports = { ea: plan.ports?.ea ?? settingsPorts.ea, http: plan.ports?.http ?? settingsPorts.http };
if (real) {
  const refusal = await realPortsRefusal(ports);
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }
}
log(`${real ? "real terminals" : "fake terminals and fake EAs"}${app ? " in the app window" : ""}; data folder ${dataFolder}; EA port ${ports.ea}, HTTP port ${ports.http}`);

const reload = await startReloadServer(reloadPort).catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
const serverEnv = {
  QUOTEBRIDGE_DEV_DASHBOARD_FOLDER: DASHBOARD_OUT,
  QUOTEBRIDGE_DEV_FAKES: real ? "0" : "1",
  QUOTEBRIDGE_DEV_REAL: real ? "1" : "0",
};

/** Calls `first` after the first successful build and `again` after each later one. */
function onBuilt(name: string, first: () => void, again: () => void): Plugin {
  return {
    name: `dev-${name}`,
    setup(build) {
      let built = false;
      build.onEnd((result) => {
        if (result.errors.length) return log(`${name} build failed; nothing reloaded`);
        if (built) return again();
        built = true;
        first();
      });
    },
  };
}

// Dashboard: rebuilt on change; open pages reload.
const pageReload = new RestartScheduler(async () => reload.reload(), { quietMs: QUIET_MS });
let dashboardBuilt!: () => void;
const dashboardReady = new Promise<void>((resolve) => (dashboardBuilt = resolve));
const dashboard = await context(dashboardBuildOptions({ reloadUrl: reload.url, plugins: [onBuilt("dashboard", () => dashboardBuilt(), () => pageReload.changed())] }));
await dashboard.watch();
// esbuild watches only what the bundle imports; the static files are copied again when they change.
const staticWatchers = STATIC_FILES.map((file) =>
  watch(DASHBOARD_SOURCE + file, () => {
    copyStatic();
    pageReload.changed();
  }),
);

// Server: rebuilt on change into .dev-build, then restarted. The indicator engine's worker is bundled beside it, and the
// bundled indicator packages are copied there (src/server/indicators finds both beside its own module).
const serverRestart = new RestartScheduler(async () => runner.restartServer(), { quietMs: QUIET_MS });
let serverBuilt!: () => void;
const serverReady = new Promise<void>((resolve) => (serverBuilt = resolve));
const serverBuild = await context({
  entryPoints: { "server-entry": join(root, "scripts", "dev", "server-entry.ts"), "sandbox-worker": join(root, "src", "server", "indicators", "sandbox-worker.ts") },
  outdir: DEV_BUILD,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap: true,
  logLevel: "info",
  plugins: [{ name: "dev-indicators", setup: (build) => build.onEnd(() => copyBundledPackages(DEV_BUILD)) }, onBuilt("server", () => serverBuilt(), () => serverRestart.changed())],
});
await serverBuild.watch();
await Promise.all([dashboardReady, serverReady]);

const stopFeeds = real ? () => {} : fakeFeeds(`tcp://127.0.0.1:${ports.ea}`, await fakeFeedIdentity(join(dataFolder, "fake-terminals")));
const runner = app ? await runApp() : runBrowser();

async function stop() {
  if (stopping) return;
  stopping = true;
  log("stopping");
  serverRestart.close();
  pageReload.close();
  staticWatchers.forEach((w) => w.close());
  input.close();
  await runner.stop();
  await signInFile.remove();
  stopFeeds();
  await Promise.all([dashboard.dispose(), serverBuild.dispose()]);
  await reload.close();
  process.exit(0);
}
process.on("SIGINT", () => void stop());
const input = createInterface({ input: process.stdin });
input.on("line", (line) => (line.trim() === "q" ? void stop() : runner.onEnter()));
process.on("SIGTERM", () => void stop());

/** The server under a supervisor in this process; the dashboard in a browser tab. */
function runBrowser() {
  const bridgeBundle = bridgeBundleFolders({ isPackaged: false, appPath: root, resourcesPath: "" }, process.env);
  const supervisor = new Supervisor({
    launch: (): ServerProcess => {
      const child = fork(SERVER_BUNDLE, [], { env: { ...process.env, ...serverEnv, QUOTEBRIDGE_DEV_OPEN_DASHBOARD: "1" }, stdio: ["ignore", "inherit", "inherit", "ipc"] });
      return {
        transport: ipcTransport<ServerMessage, HostMessage>(child),
        onExit: (listener) => void child.once("exit", listener),
        kill: () => void child.kill(),
      };
    },
    config: () => ({ eaPort: ports.ea, httpPort: ports.http, dataFolder, bridgeBundle }),
  });
  // The dev server opens the dashboard to a browser tab without a sign-in (QUOTEBRIDGE_DEV_OPEN_DASHBOARD).
  let dashboardUrl: string | undefined;
  const showUrl = () => dashboardUrl && log(`dashboard: ${dashboardUrl}\n      (no sign-in needed; q and Enter or Ctrl+C to stop)`);
  supervisor.onEvent((event) => {
    if (event.type === "state") {
      const { state, lastError } = event.status;
      log(`server ${state}${lastError && state !== "running" ? ` (${lastError.message})` : ""}`);
    } else if (event.type === "window-url") {
      // The window token in the event's link is not needed. After a restart, open pages reload to reach the new server.
      const url = `${new URL(event.url).origin}/`;
      if (url === dashboardUrl) return reload.reload();
      // First start, or a new HTTP port: open pages follow.
      if (dashboardUrl) reload.navigate(url);
      dashboardUrl = url;
      showUrl();
    }
  });
  supervisor.start();
  return {
    onEnter: showUrl,
    restartServer: async () => {
      log("server rebuilt; restarting it");
      await supervisor.restart();
    },
    stop: async () => {
      const result = await supervisor.stop("quit");
      log(`server stop path: ${result.outcome}, checkpoint ${result.checkpoint}`);
    },
  };
}

/** The app in Electron (supervisor, utility process, window); main is rebuilt by tsc --watch and relaunched. */
async function runApp() {
  const require = createRequire(import.meta.url);
  const electron = require("electron") as string;
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  const built = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], { cwd: root, stdio: "inherit" });
  if (built.status !== 0) log("main build failed; starting with the last build");
  const tscWatch = spawn(process.execPath, [tsc, "-p", "tsconfig.build.json", "--watch", "--preserveWatchOutput"], { cwd: root, stdio: ["ignore", "inherit", "inherit"] });

  // tsc rewrites unchanged files too: relaunch only when a main-process file's content changed.
  const hashes = new Map<string, string>();
  const hash = (path: string) => {
    try {
      return createHash("sha256").update(readFileSync(path)).digest("hex");
    } catch {
      return "";
    }
  };
  const mainFolders = ["main", "shared"].map((f) => join(root, "dist", f));
  const relaunch = new RestartScheduler(async () => relaunchElectron(), { quietMs: QUIET_MS });
  const watchers = mainFolders.map((folder) =>
    watch(folder, { recursive: true }, (_event, file) => {
      if (!file || !/\.c?js$/.test(file)) return;
      const path = join(folder, file);
      const now = hash(path);
      if (hashes.get(path) === now) return;
      hashes.set(path, now);
      relaunch.changed();
    }),
  );
  // Record the current contents first, so the watch build's first pass relaunches nothing.
  for (const folder of mainFolders) for (const file of readdirSync(folder, { recursive: true }) as string[]) if (/\.c?js$/.test(file)) hashes.set(join(folder, file), hash(join(folder, file)));

  let electronProcess: ChildProcess | null = null;
  let exited: Promise<void> = Promise.resolve();
  let relaunching = false;
  const launch = () => {
    const child = spawn(electron, [root], {
      cwd: root,
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...withoutElectronRunAsNode(process.env),
        ...serverEnv,
        QUOTEBRIDGE_DATA_FOLDER: dataFolder,
        ...(plan.ports?.ea !== undefined ? { QUOTEBRIDGE_EA_PORT: String(plan.ports.ea) } : {}),
        ...(plan.ports?.http !== undefined ? { QUOTEBRIDGE_HTTP_PORT: String(plan.ports.http) } : {}),
        QUOTEBRIDGE_DEV_SERVER_ENTRY: SERVER_BUNDLE,
        QUOTEBRIDGE_DEV_CONTROL: reload.controlUrl,
        QUOTEBRIDGE_DEV_SIGN_IN_FILE: signInFile.path,
      },
    });
    electronProcess = child;
    exited = new Promise((resolve) =>
      child.once("exit", (code) => {
        electronProcess = null;
        log(`app exited (code ${code})`);
        resolve();
        // Quit from the tray ends the dev run too.
        if (!relaunching && !stopping) void stop();
      }),
    );
  };
  const quitElectron = async () => {
    const child = electronProcess;
    if (!child) return;
    reload.control("quit");
    const timeout = setTimeout(() => child.kill(), 15_000);
    await exited;
    clearTimeout(timeout);
  };
  async function relaunchElectron() {
    if (stopping) return;
    log("main process rebuilt; relaunching the app");
    relaunching = true;
    await quitElectron();
    relaunching = false;
    if (!stopping) launch();
  }
  launch();
  log(`a one-time sign-in link for a browser is in ${signInFile.path} (Enter for another); q and Enter or Ctrl+C to stop`);
  return {
    onEnter: () => reload.control("sign-in-link"),
    restartServer: async () => {
      log("server rebuilt; restarting it in the app");
      reload.control("restart-server");
    },
    stop: async () => {
      relaunch.close();
      watchers.forEach((w) => w.close());
      tscWatch.kill();
      await quitElectron();
    },
  };
}

function withoutElectronRunAsNode(env: NodeJS.ProcessEnv) {
  const copy = { ...env };
  delete copy.ELECTRON_RUN_AS_NODE;
  return copy;
}
