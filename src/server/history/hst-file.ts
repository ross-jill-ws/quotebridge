// MetaTrader's HST history files (v400 and v401), read in place: `<data folder>\history\<broker server>\<SYMBOL><minutes>.hst`.
// MetaTrader keeps writing them, so a file is opened read-only for each read (Node opens files with full sharing on
// Windows), its bar count comes from its size at that moment (a half-written last record is left out), and pages are
// read from the end backwards without loading the whole file. Bar times are broker seconds.
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

const HEADER_BYTES = 148;
/** Records read per probe while paging; also the most read at once. */
const READ_RECORDS = 4096;

export type HstBar = { time: number; open: number; high: number; low: number; close: number; tickVolume: number; spread: number; realVolume: number };

export type HstHeader = { version: 400 | 401; symbol: string; minutes: number; digits: number };

/** A page of bars, oldest first; `complete` when the file holds no older bars. */
export type HstPage = { bars: HstBar[]; complete: boolean };

/** The path of a symbol's file for a period, in minutes. */
export function hstPath(dataFolder: string, brokerServer: string, symbol: string, minutes: number): string {
  return join(dataFolder, "history", brokerServer, `${symbol}${minutes}.hst`);
}

export class HstFile {
  private constructor(
    readonly path: string,
    readonly header: HstHeader,
  ) {}

  /** The file, or null when it does not exist or is not an HST file this app reads. */
  static async open(path: string): Promise<HstFile | null> {
    let handle: FileHandle;
    try {
      handle = await open(path, "r");
    } catch {
      return null;
    }
    try {
      const buffer = Buffer.alloc(HEADER_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
      const header = bytesRead === HEADER_BYTES ? readHeader(buffer) : null;
      return header ? new HstFile(path, header) : null;
    } finally {
      await handle.close();
    }
  }

  private get recordBytes() {
    return this.header.version === 401 ? 60 : 44;
  }

  /** The newest bar, or null when the file holds none. */
  async last(): Promise<HstBar | null> {
    return this.read(async (file) => {
      const count = await this.count(file);
      return count ? (await this.records(file, count - 1, 1))[0] ?? null : null;
    });
  }

  /** Up to `limit` bars older than `before` (broker seconds; all when undefined), oldest first. */
  async before(before: number | undefined, limit: number): Promise<HstPage> {
    return this.read(async (file) => {
      const count = await this.count(file);
      // The first index at or after `before`: bars are in time order.
      let end = count;
      if (before !== undefined) {
        let low = 0;
        while (low < end) {
          const middle = (low + end) >> 1;
          if ((await this.time(file, middle)) < before) low = middle + 1;
          else end = middle;
        }
      }
      const start = Math.max(0, end - limit);
      const bars: HstBar[] = [];
      for (let at = start; at < end; at += READ_RECORDS) bars.push(...(await this.records(file, at, Math.min(READ_RECORDS, end - at))));
      return { bars, complete: start === 0 };
    });
  }

  private async read<T>(work: (file: FileHandle) => Promise<T>): Promise<T> {
    const file = await open(this.path, "r");
    try {
      return await work(file);
    } finally {
      await file.close();
    }
  }

  private async count(file: FileHandle): Promise<number> {
    const { size } = await file.stat();
    return Math.max(0, Math.floor((size - HEADER_BYTES) / this.recordBytes));
  }

  private async time(file: FileHandle, index: number): Promise<number> {
    const buffer = Buffer.alloc(8);
    await file.read(buffer, 0, 8, HEADER_BYTES + index * this.recordBytes);
    return this.header.version === 401 ? Number(buffer.readBigInt64LE(0)) : buffer.readUInt32LE(0);
  }

  /** Records from `index` on; a bar that cannot be right (prices out of order, a bad time) is left out. */
  private async records(file: FileHandle, index: number, count: number): Promise<HstBar[]> {
    const size = this.recordBytes;
    const buffer = Buffer.alloc(size * count);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, HEADER_BYTES + index * size);
    const bars: HstBar[] = [];
    for (let at = 0; at + size <= bytesRead; at += size) {
      const bar = this.header.version === 401 ? bar401(buffer, at) : bar400(buffer, at);
      if (valid(bar)) bars.push(bar);
    }
    return bars;
  }
}

function readHeader(buffer: Buffer): HstHeader | null {
  const version = buffer.readInt32LE(0);
  const symbol = buffer.toString("latin1", 68, 80).replace(/\0.*$/s, "");
  const minutes = buffer.readInt32LE(80);
  const digits = buffer.readInt32LE(84);
  if ((version !== 400 && version !== 401) || !symbol || minutes <= 0 || digits < 0 || digits > 10) return null;
  return { version, symbol, minutes, digits };
}

function bar401(b: Buffer, at: number): HstBar {
  return {
    time: Number(b.readBigInt64LE(at)),
    open: b.readDoubleLE(at + 8),
    high: b.readDoubleLE(at + 16),
    low: b.readDoubleLE(at + 24),
    close: b.readDoubleLE(at + 32),
    tickVolume: Number(b.readBigInt64LE(at + 40)),
    spread: b.readInt32LE(at + 48),
    realVolume: Number(b.readBigInt64LE(at + 52)),
  };
}

/** v400: time, open, low, high, close, volume. */
function bar400(b: Buffer, at: number): HstBar {
  return {
    time: b.readUInt32LE(at),
    open: b.readDoubleLE(at + 4),
    low: b.readDoubleLE(at + 12),
    high: b.readDoubleLE(at + 20),
    close: b.readDoubleLE(at + 28),
    tickVolume: b.readDoubleLE(at + 36),
    spread: 0,
    realVolume: 0,
  };
}

function valid(bar: HstBar): boolean {
  const { time, open, high, low, close } = bar;
  return (
    Number.isSafeInteger(time) && time > 0 && [open, high, low, close].every(Number.isFinite) && low <= Math.min(open, close) && high >= Math.max(open, close)
  );
}
