/**
 * Decodes `origin.txt`. MetaTrader writes UTF-16LE with a byte-order mark; UTF-16BE, UTF-8 (with
 * or without BOM) and BOM-less UTF-16LE are tolerated. Returns the trimmed installation path.
 */
export function decodeOriginText(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let text: string;
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    text = buffer.subarray(2).toString("utf16le");
  } else if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    // swap16 needs whole code units: a stray last byte (a truncated file) is dropped.
    const units = buffer.subarray(2, buffer.length - (buffer.length % 2));
    text = Buffer.from(units).swap16().toString("utf16le");
  } else if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    text = buffer.subarray(3).toString("utf8");
  } else if (buffer.length >= 2 && buffer.length % 2 === 0 && buffer[1] === 0 && buffer[0] !== 0) {
    text = buffer.toString("utf16le");
  } else {
    text = buffer.toString("utf8");
  }
  return text.replace(/\0/g, "").trim();
}
