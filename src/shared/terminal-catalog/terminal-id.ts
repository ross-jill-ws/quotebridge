import { createHash } from "node:crypto";
import { normaliseFolderPath } from "./paths.js";

/**
 * The Terminal ID the bridge gives a terminal: `mt4-` plus the first 12 hex characters of the
 * SHA-256 of its normalised (upper-cased, no trailing separator) data-folder path, UTF-8 encoded.
 * A bridge label only; it never carries a broker or account number.
 */
export function terminalIdFor(dataFolder: string): string {
  const digest = createHash("sha256").update(normaliseFolderPath(dataFolder), "utf8").digest("hex");
  return `mt4-${digest.slice(0, 12)}`;
}
