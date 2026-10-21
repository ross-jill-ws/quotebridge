// Compile-log parser: pure. Reads the log MetaEditor writes with `/log:`.

export interface CompileMessage {
  severity: "error" | "warning";
  file: string;
  line: number;
  column: number;
  code: number;
  text: string;
}

export interface CompileLog {
  /** The log as text, decoded from UTF-16 or UTF-8. */
  text: string;
  /** Counts from the `Result:` line; undefined when the log has none. */
  result?: { errors: number; warnings: number };
  /** Error and warning lines, in log order. */
  messages: CompileMessage[];
}

const RESULT_LINE = /^Result:\s*(\d+)\s+errors?,\s*(\d+)\s+warnings?/im;
// `<file>(<line>,<column>) : error <code>: <text>`
const MESSAGE_LINE = /^(.+?)\((\d+),(\d+)\)\s*:\s*(error|warning)\s+(\d+):\s*(.*)$/i;

export function parseCompileLog(bytes: Uint8Array): CompileLog {
  const text = decodeLog(bytes);
  const match = RESULT_LINE.exec(text);
  const messages: CompileMessage[] = [];
  for (const line of text.split(/\r?\n/)) {
    const message = MESSAGE_LINE.exec(line.trim());
    if (!message) continue;
    messages.push({
      severity: message[4].toLowerCase() as CompileMessage["severity"],
      file: message[1].trim(),
      line: Number(message[2]),
      column: Number(message[3]),
      code: Number(message[5]),
      text: message[6].trim(),
    });
  }
  return {
    text,
    result: match ? { errors: Number(match[1]), warnings: Number(match[2]) } : undefined,
    messages,
  };
}

function decodeLog(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return buffer.subarray(3).toString("utf8");
  if (looksLikeUtf16le(buffer)) return buffer.toString("utf16le");
  return buffer.toString("utf8");
}

/** No byte-order mark: UTF-16LE text of ASCII paths and messages has zeros in most odd bytes. */
function looksLikeUtf16le(buffer: Buffer): boolean {
  const pairs = Math.floor(Math.min(buffer.length, 512) / 2);
  if (pairs === 0) return false;
  let oddZeros = 0;
  for (let i = 0; i < pairs; i++) if (buffer[2 * i + 1] === 0) oddZeros++;
  return oddZeros / pairs > 0.5;
}
