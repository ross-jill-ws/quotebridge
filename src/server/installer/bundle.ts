// The bridge bundle: what the app ships for every managed terminal (EA sources, template, the
// ZeroMQ DLL folder with its notices), loaded once and described by the EA version and source hash.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { nodeInstallerFileSystem, type InstallerFileSystem } from "./file-system.js";
import { checkTemplate } from "./template.js";

/** Where the bundled files are: the `mt4/` folder and the folder holding the DLL and its notices. */
export interface BridgeBundleFolders {
  /** Holds `Experts/QuoteBridge.mq4`, `Include/*.mqh` and `Templates/QuoteBridge.tpl`. */
  sourceFolder: string;
  /** Holds the versioned DLL the EA imports plus license notices and source pointer. */
  dllFolder: string;
}

export interface BundledFile {
  /** Path relative to the terminal's data folder, `\`-free (`MQL4/Experts/QuoteBridge.mq4`). */
  target: string;
  bytes: Buffer;
}

export interface BridgeBundle {
  /** `#property version` of the bundled QuoteBridge EA, e.g. `1.08`. */
  eaVersion: string;
  /** SHA-256 over the bundled EA sources (`.mq4` and `.mqh`); a change makes installs outdated. */
  sourceHash: string;
  /**
   * SHA-256 over what an install would change: the EA sources, the template (before substitution),
   * the notices and the DLL file name. Any change makes installs outdated, so a template- or
   * notice-only change in a newer app version reaches every managed terminal too. DLL bytes do not
   * count: the installer never overwrites a DLL of the same name (ADR 3), so a rebuilt DLL under
   * the same name would change nothing in a terminal. A new DLL version comes with a new name.
   */
  bundleHash: string;
  /** `QuoteBridge.mq4` → `MQL4/Experts/`, `.mqh` → `MQL4/Include/`. */
  sources: BundledFile[];
  /** The bundled `QuoteBridge.tpl`, before substitution. */
  template: string;
  /** The versioned DLL the EA imports, e.g. `libzmq-mt-4_3_5.dll`. */
  dllName: string;
  /** The DLL and every notice next to it → `MQL4/Libraries/`. */
  nativeFiles: BundledFile[];
}

export const EA_SOURCE_TARGET = "MQL4/Experts/QuoteBridge.mq4";
export const EA_TARGET = "MQL4/Experts/QuoteBridge.ex4";
export const TEMPLATE_TARGET = "templates/QuoteBridge.tpl";

export async function loadBridgeBundle(folders: BridgeBundleFolders, fs: InstallerFileSystem = nodeInstallerFileSystem): Promise<BridgeBundle> {
  const sources: BundledFile[] = [{ target: EA_SOURCE_TARGET, bytes: await fs.readFile(join(folders.sourceFolder, "Experts", "QuoteBridge.mq4")) }];
  const includes = (await fs.listFolder(join(folders.sourceFolder, "Include")))
    .filter((entry) => entry.isFile && /\.mqh$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const name of includes) sources.push({ target: `MQL4/Include/${name}`, bytes: await fs.readFile(join(folders.sourceFolder, "Include", name)) });

  const sourceText = sources.map((source) => source.bytes.toString("utf8")).join("\n");
  const eaVersion = sourceText.match(/^#property\s+version\s+"([^"]+)"/m)?.[1];
  if (!eaVersion) throw new Error("Bridge bundle: QuoteBridge.mq4 has no #property version");
  const dllName = sourceText.match(/^#import\s+"([^"]+\.dll)"/im)?.[1];
  if (!dllName) throw new Error("Bridge bundle: the EA sources import no DLL");

  const nativeEntries = (await fs.listFolder(folders.dllFolder)).filter((entry) => entry.isFile).map((entry) => entry.name).sort();
  if (!nativeEntries.some((name) => name.toLowerCase() === dllName.toLowerCase())) {
    throw new Error(`Bridge bundle: ${dllName}, which the EA imports, is not in the DLL folder`);
  }
  const nativeFiles: BundledFile[] = [];
  for (const name of nativeEntries) nativeFiles.push({ target: `MQL4/Libraries/${name}`, bytes: await fs.readFile(join(folders.dllFolder, name)) });

  const template = (await fs.readFile(join(folders.sourceFolder, "Templates", "QuoteBridge.tpl"))).toString("utf8");
  checkTemplate(template);

  const installable = nativeFiles.map((file) => (isDll(file.target) ? { target: file.target, bytes: Buffer.alloc(0) } : file));
  const bundleHash = hashOf([...sources, { target: TEMPLATE_TARGET, bytes: Buffer.from(template, "utf8") }, ...installable]);
  return { eaVersion, sourceHash: hashOf(sources), bundleHash, sources, template, dllName, nativeFiles };
}

function hashOf(files: BundledFile[]): string {
  const hash = createHash("sha256");
  for (const source of files) hash.update(`${source.target}\0${sha256(source.bytes)}\n`);
  return hash.digest("hex");
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** True for the versioned DLL files the installer never overwrites. */
export function isDll(target: string): boolean {
  return /\.dll$/i.test(target);
}
