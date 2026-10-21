import { open, readdir, readFile, stat } from "node:fs/promises";

/**
 * The filesystem view the terminal catalog needs. Read-only by design: detection never writes
 * into a terminal or into %APPDATA%\MetaQuotes.
 */
export interface TerminalFileSystem {
  /** Names of the sub-folders of `folder`; empty when it does not exist or cannot be read. */
  listFolders(folder: string): Promise<string[]>;
  isFolder(path: string): Promise<boolean>;
  isFile(path: string): Promise<boolean>;
  /** The whole file, or undefined when it does not exist or cannot be read. */
  readFile(file: string): Promise<Uint8Array | undefined>;
  /** Up to `length` bytes from the start of the file, or undefined when it cannot be read. */
  readStart(file: string, length: number): Promise<Uint8Array | undefined>;
}

export const nodeTerminalFileSystem: TerminalFileSystem = {
  async listFolders(folder) {
    try {
      const entries = await readdir(folder, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return [];
    }
  },
  async isFolder(path) {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  },
  async isFile(path) {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  },
  async readFile(file) {
    try {
      return await readFile(file);
    } catch {
      return undefined;
    }
  },
  async readStart(file, length) {
    let handle;
    try {
      handle = await open(file, "r");
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      return buffer.subarray(0, bytesRead);
    } catch {
      return undefined;
    } finally {
      await handle?.close();
    }
  },
};
