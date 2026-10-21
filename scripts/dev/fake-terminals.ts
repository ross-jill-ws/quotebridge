// Fake terminals for `npm run dev`: a folder laid out like a MetaTrader user's machine (kept in the dev
// data folder, so installs survive server restarts), a bridge bundle with a dummy DLL and a fake
// MetaEditor (one broker fails to compile, one has MetaEditor open). Nothing here touches a real
// terminal, MetaEditor or %APPDATA%.
import { join } from "node:path";
import type { RunningServer } from "../../src/server/index.js";
import type { TerminalManagerOptions } from "../../src/server/terminals/index.js";
import type { MetaEditorProcesses } from "../../src/shared/metaeditor/index.js";
import { FakeEA } from "../../tests/fake-ea.js";
import { InstallerFixture, SUCCESSFUL_COMPILE } from "../../tests/installer-fixtures.js";
import { FAILED_LOG, FakeMetaEditor } from "../../tests/metaeditor-fixtures.js";
import { MachineFixture } from "../../tests/terminal-fixtures.js";

const COMPILE_DELAY_MS = 1500;
const QUIET = "Quiet Broker MetaTrader 4";

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

/** After an install, a fake EA in each installed terminal (except Quiet Broker) says hello every 2 s. */
export function fakeTerminalEAs(server: RunningServer, endpoint: string): () => void {
  const eas = new Map<string, FakeEA>();
  const timer = setInterval(async () => {
    const state = await server.terminals?.state().catch(() => undefined);
    for (const t of state?.terminals ?? []) {
      if (!t.terminalId || t.name === QUIET || t.state !== "installed" || !t.managed) continue;
      let ea = eas.get(t.terminalId);
      if (!ea) eas.set(t.terminalId, (ea = new FakeEA({ terminal: t.terminalId, symbol: "EURUSD", broker: t.name.split(" ")[0] }).connect(endpoint)));
      void ea.hello().catch(() => {});
    }
  }, 2000);
  return () => {
    clearInterval(timer);
    eas.forEach((ea) => ea.close());
  };
}
