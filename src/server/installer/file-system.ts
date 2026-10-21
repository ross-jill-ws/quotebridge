// Filesystem port of the bridge installer. Every read and write of the installer (terminal data
// folder and app data folder) goes through it, so tests can inject faults.
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface InstallerFileSystem {
  /** Rejects with code `ENOENT` when the file does not exist. */
  readFile(path: string): Promise<Buffer>;
  /** Creates parent folders. `exclusive` = create-new: rejects with `EEXIST` if the file exists. */
  writeFile(path: string, data: Uint8Array, options?: { exclusive?: boolean }): Promise<void>;
  /** Replaces `to` if it exists. */
  rename(from: string, to: string): Promise<void>;
  /** A missing file is not an error. */
  removeFile(path: string): Promise<void>;
  /** Removes a folder the app owns (staging, run folders) with everything in it. */
  removeFolder(path: string): Promise<void>;
  /** Names of the entries of a folder; empty when it does not exist. */
  listFolder(path: string): Promise<{ name: string; isFile: boolean }[]>;
}

export const nodeInstallerFileSystem: InstallerFileSystem = {
  readFile: (path) => readFile(path),
  async writeFile(path, data, options) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data, { flag: options?.exclusive ? "wx" : "w" });
  },
  rename: (from, to) => rename(from, to),
  removeFile: (path) => rm(path, { force: true }),
  removeFolder: (path) => rm(path, { recursive: true, force: true, maxRetries: 3 }),
  async listFolder(path) {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.map((entry) => ({ name: entry.name, isFile: entry.isFile() }));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }
  },
};

export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

/** The file's bytes, or undefined when it does not exist. */
export async function readIfPresent(fs: InstallerFileSystem, path: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

/** Writes a sibling `.tmp` file, then renames it over the target, so readers never see half a file. */
export async function writeFileAtomic(fs: InstallerFileSystem, path: string, data: Uint8Array): Promise<void> {
  const temporary = `${path}.tmp`;
  await fs.writeFile(temporary, data);
  // Windows can refuse a rename for a moment while another program (an indexer, antivirus) has
  // the target open.
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(temporary, path);
      return;
    } catch (error) {
      if (attempt >= 4 || !["EPERM", "EACCES", "EBUSY"].includes(errorCode(error) ?? "")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}
