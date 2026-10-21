import { createHash } from "node:crypto";

/** Upper-cases a folder path and drops any trailing separator, as MetaTrader does. */
export function normaliseFolderPath(folder: string): string {
  return folder.replace(/[\\/]+$/, "").toUpperCase();
}

/**
 * The name MetaTrader gives a terminal's data folder under `%APPDATA%\MetaQuotes\Terminal`:
 * upper-case hex MD5 of the normalised installation path, encoded UTF-16LE.
 */
export function dataFolderNameFor(installationFolder: string): string {
  const bytes = Buffer.from(normaliseFolderPath(installationFolder), "utf16le");
  return createHash("md5").update(bytes).digest("hex").toUpperCase();
}
