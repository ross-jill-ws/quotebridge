// A package ZIP as the legacy server took it: at most 2 MiB, holding exactly manifest.json, calculate.js, README.md and
// LICENSE at its root, each at most 256 KB of UTF-8 text; no folders, links, encryption or ZIP64. Read from the
// central directory, each file inflated with a cap on its size.
import { crc32, inflateRawSync } from "node:zlib";
import { PACKAGE_FILES, type PackageFiles } from "./packages.js";

export const MAX_ZIP_BYTES = 2 * 1024 * 1024;
export const MAX_FILE_BYTES = 256_000;

/** A ZIP that is not a package; the message says why, for the trader. */
export class PackageZipError extends Error {}

const fail = (message: string): never => {
  throw new PackageZipError(message);
};

const NOT_A_ZIP = "This file is not a ZIP, or it is damaged.";
const FILES = "A package ZIP holds only manifest.json, calculate.js, README.md and LICENSE, at its root.";

/** The four files' text; throws PackageZipError otherwise. */
export function readPackageZip(bytes: Buffer): PackageFiles {
  if (bytes.length > MAX_ZIP_BYTES) fail("The ZIP is larger than 2 MiB.");
  // The end of central directory record, after which only a comment (up to 64 KiB) comes.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) fail(NOT_A_ZIP);
  const count = bytes.readUInt16LE(end + 10);
  const size = bytes.readUInt32LE(end + 12);
  let at = bytes.readUInt32LE(end + 16);
  if (at + size > end) fail(NOT_A_ZIP);
  const files: Partial<Record<string, string>> = {};
  for (let n = 0; n < count; n++) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) fail(NOT_A_ZIP);
    const flags = bytes.readUInt16LE(at + 8);
    const method = bytes.readUInt16LE(at + 10);
    const crc = bytes.readUInt32LE(at + 16);
    const packed = bytes.readUInt32LE(at + 20);
    const length = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const mode = bytes.readUInt32LE(at + 38) >>> 16;
    const local = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    at += 46 + nameLength + extraLength + commentLength;
    if (at > end) fail(NOT_A_ZIP);

    if (!(PACKAGE_FILES as readonly string[]).includes(name)) fail(`The ZIP has ${JSON.stringify(name.slice(0, 100))}. ${FILES}`);
    if (Object.hasOwn(files, name)) fail(`The ZIP has ${name} twice.`);
    if ((mode & 0xf000) === 0xa000) fail(`${name} is a link. ${FILES}`);
    if (flags & 1) fail("The ZIP is encrypted.");
    if (length > MAX_FILE_BYTES) fail(`${name} is larger than 256 KB.`);
    if (packed === 0xffffffff || local === 0xffffffff) fail(NOT_A_ZIP);
    if (method !== 0 && method !== 8) fail(`${name} is compressed in a way the app cannot read. Use a plain ZIP (deflate).`);

    if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) fail(NOT_A_ZIP);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (start + packed > bytes.length) fail(NOT_A_ZIP);
    const raw = bytes.subarray(start, start + packed);
    let data: Buffer;
    try {
      data = method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: MAX_FILE_BYTES });
    } catch {
      // Its size said otherwise, or the data is damaged.
      return fail(`${name} is damaged, or larger than 256 KB.`);
    }
    if (data.length !== length || crc32(data) !== crc) fail(`${name} is damaged.`);
    try {
      files[name] = new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      fail(`${name} is not UTF-8 text.`);
    }
  }
  const missing = PACKAGE_FILES.filter((name) => files[name] === undefined);
  if (missing.length) fail(`The ZIP lacks ${missing.join(", ")}. ${FILES}`);
  return files as PackageFiles;
}
