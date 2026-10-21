// Temp-folder fixtures laid out like a MetaTrader user's machine: a data root shaped like
// %APPDATA%\MetaQuotes\Terminal and installation folders shaped like Program Files.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataFolderNameFor } from "../src/main/terminal-catalog/index.js";

export const X86 = 0x014c;
export const X64 = 0x8664;

/** The smallest PE image header the catalog needs: `MZ`, e_lfanew, `PE\0\0`, machine type. */
export function fakeExecutable(machine: number): Buffer {
  const image = Buffer.alloc(0x100);
  image.write("MZ", 0, "latin1");
  image.writeUInt32LE(0x80, 0x3c);
  image.write("PE\0\0", 0x80, "latin1");
  image.writeUInt16LE(machine, 0x84);
  return image;
}

/** `origin.txt` as MetaTrader writes it: UTF-16LE with a byte-order mark. */
export function originText(installationFolder: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(installationFolder, "utf16le")]);
}

export class MachineFixture {
  private constructor(readonly root: string) {}

  static async create(): Promise<MachineFixture> {
    return new MachineFixture(await mkdtemp(join(tmpdir(), "quotebridge-catalog-")));
  }

  get dataRoot(): string {
    return join(this.root, "AppData", "MetaQuotes", "Terminal");
  }

  get programFiles(): string {
    return join(this.root, "Program Files");
  }

  async file(path: string, content: string | Buffer = ""): Promise<string> {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
    return path;
  }

  async folder(path: string): Promise<string> {
    await mkdir(path, { recursive: true });
    return path;
  }

  /** An installation folder with `terminal.exe` (x86, MT4) or `terminal64.exe` (x64, MT5). */
  async installationFolder(name: string, kind: "mt4" | "mt5", machine?: number): Promise<string> {
    const folder = join(this.programFiles, name);
    const exe = kind === "mt4" ? "terminal.exe" : "terminal64.exe";
    await this.file(join(folder, exe), fakeExecutable(machine ?? (kind === "mt4" ? X86 : X64)));
    await this.file(join(folder, kind === "mt4" ? "metaeditor.exe" : "metaeditor64.exe"), fakeExecutable(machine ?? (kind === "mt4" ? X86 : X64)));
    return folder;
  }

  /** The data folder MetaTrader would create for an installation folder, named by the hash rule. */
  async dataFolder(
    installationFolder: string,
    options: { mql: "MQL4" | "MQL5" | null; origin?: Buffer | null },
  ): Promise<string> {
    const folder = join(this.dataRoot, dataFolderNameFor(installationFolder));
    await this.folder(folder);
    const origin = options.origin === undefined ? originText(installationFolder) : options.origin;
    if (origin) await this.file(join(folder, "origin.txt"), origin);
    if (options.mql) await this.folder(join(folder, options.mql, "Experts"));
    await this.folder(join(folder, "templates"));
    return folder;
  }

  async dispose(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}

/**
 * The maintainer's machine as the detection spike found it: CMC (MT4), easy-forex (MT4, with a
 * stale `MQL4\` and an unrelated `libzmq.dll` in its installation folder), easyMarkets (MT5),
 * a 2022 leftover with only `logs\`, and the shared `Common`, `Community` and `Help` folders.
 */
export async function spikeMachine(fixture: MachineFixture) {
  const cmc = await fixture.installationFolder("CMC Markets MetaTrader 4", "mt4");
  const easyForex = await fixture.installationFolder("MT4 at easy-forex", "mt4");
  await fixture.folder(join(easyForex, "MQL4", "Experts"));
  await fixture.file(join(easyForex, "MQL4", "Libraries", "libzmq.dll"), "unrelated");
  const easyMarkets = await fixture.installationFolder("easyMarkets MetaTrader 5", "mt5");

  const cmcData = await fixture.dataFolder(cmc, { mql: "MQL4" });
  const easyForexData = await fixture.dataFolder(easyForex, { mql: "MQL4" });
  const easyMarketsData = await fixture.dataFolder(easyMarkets, { mql: "MQL5" });

  await fixture.file(join(fixture.dataRoot, "DE26D4E5B62C1A5D24E4651A805644E5", "logs", "20220301.log"), "old");
  for (const shared of ["Common", "Community", "Help"]) {
    await fixture.folder(join(fixture.dataRoot, shared, "Files"));
  }
  await fixture.folder(join(fixture.dataRoot, "Common", "MQL4"));

  return { cmc, easyForex, easyMarkets, cmcData, easyForexData, easyMarketsData };
}
