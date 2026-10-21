// Temp-folder fixtures for the bridge installer: a terminal (installation folder with a fake
// metaeditor.exe, data folder with templates), an app data folder and a bridge bundle (the real
// mt4/ sources plus a dummy DLL folder). Nothing here touches a real terminal or MetaEditor.
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { InstallerFileSystem } from "../src/server/installer/index.js";
import { nodeInstallerFileSystem } from "../src/server/installer/index.js";
import { REAL_SUCCESS_LOG } from "./metaeditor-fixtures.js";
import type { FakeCompile } from "./metaeditor-fixtures.js";

export const REPO_MT4_FOLDER = fileURLToPath(new URL("../mt4/", import.meta.url));

export const EX4 = Buffer.from("EX4 compiled QuoteBridge, build 1");
export const DLL_4_3_5 = Buffer.from("MZ dummy libzmq 4.3.5 x86");
export const DEFAULT_TPL = "<chart>\r\nid=default\r\n</chart>\r\n";
export const OTHER_TPL = "<chart>\r\nid=my-scalping-setup\r\n</chart>\r\n";

export const NATIVE_NOTICES: Record<string, string> = {
  "QuoteBridgeNative-LICENSE.txt": "Mozilla Public License Version 2.0\r\n",
  "QuoteBridgeNative-WEPOLL-LICENSE.txt": "wepoll licence\r\n",
  "QuoteBridgeNative-PROVENANCE.json": '{"source":"https://github.com/zeromq/libzmq/releases/tag/v4.3.5"}\r\n',
  "QuoteBridgeNative-SOURCE.zip": "PK dummy source pointer",
};

/** A successful compile: MetaEditor exits 1, writes the .ex4 and a UTF-16LE log. */
export const SUCCESSFUL_COMPILE: FakeCompile = { ex4: EX4, log: { text: REAL_SUCCESS_LOG, encoding: "utf16le" }, exitCode: 1 };

export class InstallerFixture {
  private constructor(readonly root: string) {}

  static async create(): Promise<InstallerFixture> {
    return new InstallerFixture(await mkdtemp(join(tmpdir(), "quotebridge-installer-")));
  }

  cleanup(): Promise<void> {
    return rm(this.root, { recursive: true, force: true });
  }

  get appData(): string {
    return join(this.root, "AppData", "QuoteBridge");
  }

  /**
   * A terminal: installation folder (with `metaeditor.exe` unless `metaEditor: false`) and a data
   * folder with `default.tpl` and one user template.
   */
  async terminal(name = "CMC Markets MetaTrader 4", options: { metaEditor?: boolean } = {}): Promise<{ installationFolder: string; dataFolder: string }> {
    const installationFolder = join(this.root, "Program Files (x86)", name);
    await mkdir(installationFolder, { recursive: true });
    await writeFile(join(installationFolder, "terminal.exe"), "MZ terminal");
    if (options.metaEditor !== false) await writeFile(join(installationFolder, "metaeditor.exe"), "MZ metaeditor");
    const dataFolder = join(this.root, "AppData", "MetaQuotes", "Terminal", `DATA-${name.replace(/\W/g, "")}`);
    await mkdir(join(dataFolder, "MQL4", "Experts"), { recursive: true });
    await mkdir(join(dataFolder, "templates"), { recursive: true });
    await writeFile(join(dataFolder, "templates", "default.tpl"), DEFAULT_TPL);
    await writeFile(join(dataFolder, "templates", "my-scalping.tpl"), OTHER_TPL);
    return { installationFolder, dataFolder };
  }

  /**
   * A bridge bundle. By default the real mt4/ sources and a dummy 4.3.5 DLL folder. `changeEa`
   * edits the bundled QuoteBridge.mq4 (a new app version); `dll` swaps in another DLL version, and
   * the bundled EA then imports that file name. `changeTemplate` edits the bundled QuoteBridge.tpl
   * (a chart setting, kept valid); `changeNotice` edits the MPL-2.0 notice next to the DLL.
   */
  async bundle(name = "bundle", options: { changeEa?: string; changeTemplate?: string; changeNotice?: string; dll?: { file: string; bytes: Buffer } } = {}): Promise<{ sourceFolder: string; dllFolder: string }> {
    const sourceFolder = join(this.root, name, "mt4");
    await cp(REPO_MT4_FOLDER, sourceFolder, { recursive: true });
    const dll = options.dll ?? { file: "libzmq-mt-4_3_5.dll", bytes: DLL_4_3_5 };
    if (options.dll) {
      const mqh = join(sourceFolder, "Include", "QuoteBridgeZmq.mqh");
      await writeFile(mqh, (await readFile(mqh, "utf8")).replace('#import "libzmq-mt-4_3_5.dll"', `#import "${dll.file}"`));
    }
    if (options.changeEa) {
      const mq4 = join(sourceFolder, "Experts", "QuoteBridge.mq4");
      await writeFile(mq4, (await readFile(mq4, "utf8")) + `\r\n// ${options.changeEa}\r\n`);
    }
    if (options.changeTemplate) {
      const tpl = join(sourceFolder, "Templates", "QuoteBridge.tpl");
      const text = await readFile(tpl, "utf8");
      if (!text.includes("scale=8")) throw new Error("fixture: the bundled template has no scale=8 to change");
      await writeFile(tpl, text.replace("scale=8", "scale=4"));
    }
    const dllFolder = join(this.root, name, "native");
    await mkdir(dllFolder, { recursive: true });
    await writeFile(join(dllFolder, dll.file), dll.bytes);
    for (const [file, text] of Object.entries(NATIVE_NOTICES)) await writeFile(join(dllFolder, file), text);
    if (options.changeNotice) await writeFile(join(dllFolder, "QuoteBridgeNative-LICENSE.txt"), NATIVE_NOTICES["QuoteBridgeNative-LICENSE.txt"] + options.changeNotice + "\r\n");
    return { sourceFolder, dllFolder };
  }
}

/** Reads a file under a folder, or undefined when it does not exist. */
export async function readIfExists(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch {
    return undefined;
  }
}

/**
 * The node filesystem with one injected fault: the first write (create or replace) to a path
 * matching `failOn` throws, like a disk error or a file another program holds open.
 */
export function faultyFileSystem(failOn: (path: string, operation: "write" | "remove") => boolean, code = "EIO"): InstallerFileSystem & { faults: string[] } {
  const faults: string[] = [];
  const fail = (path: string, operation: "write" | "remove") => {
    if (!failOn(path, operation)) return;
    faults.push(path);
    throw Object.assign(new Error(`${code}: injected fault, ${operation} '${path}'`), { code });
  };
  return {
    ...nodeInstallerFileSystem,
    faults,
    async writeFile(path, data, options) {
      fail(path, "write");
      return nodeInstallerFileSystem.writeFile(path, data, options);
    },
    async removeFile(path) {
      fail(path, "remove");
      return nodeInstallerFileSystem.removeFile(path);
    },
  };
}
