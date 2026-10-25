// Fake terminals for `npm run dev`: a folder laid out like a MetaTrader user's machine (kept in the dev
// data folder, so installs survive server restarts), a bridge bundle with a dummy DLL and a fake
// MetaEditor (one broker fails to compile, one has MetaEditor open). Nothing here touches a real
// terminal, MetaEditor or %APPDATA%.
import { join } from "node:path";
import type { RunningServer } from "../../src/server/index.js";
import type { TerminalManagerOptions } from "../../src/server/terminals/index.js";
import type { MetaEditorProcesses } from "../../src/shared/metaeditor/index.js";
import { FakeEA } from "../../tests/fake-ea.js";
import { writeHst, type FixtureBar } from "../../tests/hst-fixtures.js";
import { brokerNow, localNow } from "./fake-feeds.js";
import { InstallerFixture, SUCCESSFUL_COMPILE } from "../../tests/installer-fixtures.js";
import { FAILED_LOG, FakeMetaEditor } from "../../tests/metaeditor-fixtures.js";
import { MachineFixture } from "../../tests/terminal-fixtures.js";
import { terminalIdFor } from "../../src/shared/terminal-catalog/index.js";

const COMPILE_DELAY_MS = 1500;
const QUIET = "Quiet Broker MetaTrader 4";

/** The same catalog-backed installation supplies the dev Feeds and Terminals views, even before bridge setup. */
export async function fakeFeedIdentity(root: string) {
  const machine = await MachineFixture.at(join(root, "machine"));
  const installationFolder = await machine.installationFolder("CMC Markets MetaTrader 4", "mt4");
  const dataFolder = await machine.dataFolder(installationFolder, { mql: "MQL4" });
  return { terminal: terminalIdFor(dataFolder), installationFolder, dataFolder };
}

/** Two more catalog-backed installations for the dev run's simulated trading accounts: another demo account and a real one. */
export async function fakeAccountIdentities(root: string) {
  const machine = await MachineFixture.at(join(root, "machine"));
  const identity = async (name: string) => {
    const installationFolder = await machine.installationFolder(name, "mt4");
    const dataFolder = await machine.dataFolder(installationFolder, { mql: "MQL4" });
    return { terminal: terminalIdFor(dataFolder), installationFolder, dataFolder };
  };
  return { secondDemo: await identity("Second Demo MetaTrader 4"), real: await identity("Real Broker MetaTrader 4") };
}

/** The terminal manager's options with fake terminals under `root` in place of this machine's. */
export async function fakeTerminalOptions(root: string, options: TerminalManagerOptions): Promise<TerminalManagerOptions> {
  const machine = await MachineFixture.at(join(root, "machine"));
  const brokers = ["CMC Markets MetaTrader 4", "Broken Broker MetaTrader 4", "Editor Open MetaTrader 4", QUIET];
  const folders: string[] = [];
  for (const name of brokers) {
    const folder = await machine.installationFolder(name, "mt4");
    await machine.dataFolder(folder, { mql: "MQL4" });
    folders.push(folder);
  }
  const mt5 = await machine.installationFolder("easyMarkets MetaTrader 5", "mt5");
  await machine.dataFolder(mt5, { mql: "MQL5" });

  const ok = new FakeMetaEditor(SUCCESSFUL_COMPILE);
  const broken = new FakeMetaEditor({ log: { text: FAILED_LOG, encoding: "utf16le" }, exitCode: 1 });
  const metaEditor: MetaEditorProcesses = {
    start(executable, args) {
      const started = (executable.includes("Broken") ? broken : ok).start(executable, args);
      // Slow enough to see the progress.
      return { exited: started.exited.then((code) => new Promise((resolve) => setTimeout(() => resolve(code), COMPILE_DELAY_MS))), kill: started.kill };
    },
    runningMetaEditors: async () => [join(folders[2], "metaeditor.exe")],
  };

  console.log(`[dev] fake terminals in ${machine.root}`);
  return {
    ...options,
    // The repo's mt4/ sources with a dummy DLL (the real DLL may not be built locally).
    bundle: await (await InstallerFixture.at(root)).bundle(),
    sources: async (userAddedFolders) => ({ dataRoot: machine.dataRoot, installationRoots: [machine.programFiles], userAddedFolders }),
    metaEditor,
    hintAfterMs: 20_000,
  };
}

/**
 * After an install, a fake EA in each installed terminal (except Quiet Broker) says hello and sends an EURUSD sample
 * every 2 s, on a GMT+2/+3 broker clock, so the Terminals panel shows an inferred clock rule; the terminal gets EURUSD
 * history files for the chart.
 */
export function fakeTerminalEAs(server: RunningServer, endpoint: string): () => void {
  const eas = new Map<string, FakeEA>();
  let seq = 0;
  const timer = setInterval(async () => {
    const state = await server.terminals?.state().catch(() => undefined);
    for (const t of state?.terminals ?? []) {
      if (!t.terminalId || !t.installationFolder || !t.dataFolder || t.name === QUIET || t.state !== "installed" || !t.managed) continue;
      let ea = eas.get(t.terminalId);
      if (!ea) {
        const broker = t.name.startsWith("CMC ") ? "Demo-Broker" : t.name.split(" ")[0];
        if (t.dataFolder) void writeFakeHistory(t.dataFolder, broker).catch((e) => console.error(`[dev] fake history for ${t.name} failed`, e));
        eas.set(t.terminalId, (ea = new FakeEA({ terminal: t.terminalId, identity: { installationFolder: t.installationFolder, dataFolder: t.dataFolder }, symbol: "EURUSD", broker }).connect(endpoint)));
      }
      void ea.hello().catch(() => {});
      void ea.ticks([{ seq: ++seq, bid: 1.0842, ask: 1.0844, quoteTime: brokerNow(), sampledTime: localNow() }]).catch(() => {});
    }
  }, 2000);
  return () => {
    clearInterval(timer);
    eas.forEach((ea) => ea.close());
  };
}

/**
 * EURUSD history files in a fake terminal's data folder, as MetaTrader keeps them: 2,000 H1 bars (v401) and three
 * days of M1 bars (v400, which the other periods roll up from), a random walk ending at the fake EA's price.
 */
async function writeFakeHistory(dataFolder: string, broker: string) {
  const now = brokerNow();
  const walk = (count: number, step: number) => {
    const out: FixtureBar[] = [];
    let price = 1.0842;
    let seed = count;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
    for (let i = 0; i < count; i++) {
      const close = price;
      const open = close - random() * Math.sqrt(step) * 6e-5;
      const high = Math.max(open, close) + Math.abs(random()) * Math.sqrt(step) * 3e-5;
      const low = Math.min(open, close) - Math.abs(random()) * Math.sqrt(step) * 3e-5;
      out.unshift({ time: 0, open: round(open), high: round(high), low: round(low), close: round(close) });
      price = open;
    }
    const last = now - (now % step) - step;
    return out.map((bar, i) => ({ ...bar, time: last - (count - 1 - i) * step }));
  };
  await writeHst(dataFolder, broker, { version: 401, symbol: "EURUSD", minutes: 60, digits: 5, bars: walk(2000, 3600) });
  await writeHst(dataFolder, broker, { version: 400, symbol: "EURUSD", minutes: 1, digits: 5, bars: walk(3 * 1440, 60) });
}

const round = (price: number) => Math.round(price * 1e5) / 1e5;
