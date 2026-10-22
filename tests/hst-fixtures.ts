// Generated MetaTrader HST files (v400 and v401), laid out as in a terminal's data folder:
// `<data folder>\history\<broker server>\<SYMBOL><minutes>.hst`. Synthetic fixtures: no MetaTrader involved.
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** `time` is broker seconds. */
export type FixtureBar = { time: number; open: number; high: number; low: number; close: number; volume?: number; spread?: number; realVolume?: number };

export type HstFixture = { version: 400 | 401; symbol: string; minutes: number; digits: number; bars: readonly FixtureBar[] };

export const HEADER_BYTES = 148;

export function hstHeader({ version, symbol, minutes, digits }: Omit<HstFixture, "bars">): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeInt32LE(version, 0);
  header.write("(C)opyright 2003, MetaQuotes Software Corp.", 4, 64, "latin1");
  header.write(symbol, 68, 12, "latin1");
  header.writeInt32LE(minutes, 80);
  header.writeInt32LE(digits, 84);
  return header;
}

export function hstRecords(version: 400 | 401, bars: readonly FixtureBar[]): Buffer {
  const size = version === 401 ? 60 : 44;
  const out = Buffer.alloc(size * bars.length);
  bars.forEach((bar, i) => {
    const at = i * size;
    if (version === 401) {
      out.writeBigInt64LE(BigInt(bar.time), at);
      out.writeDoubleLE(bar.open, at + 8);
      out.writeDoubleLE(bar.high, at + 16);
      out.writeDoubleLE(bar.low, at + 24);
      out.writeDoubleLE(bar.close, at + 32);
      out.writeBigInt64LE(BigInt(bar.volume ?? 1), at + 40);
      out.writeInt32LE(bar.spread ?? 0, at + 48);
      out.writeBigInt64LE(BigInt(bar.realVolume ?? 0), at + 52);
    } else {
      // v400: time, open, low, high, close, volume.
      out.writeUInt32LE(bar.time, at);
      out.writeDoubleLE(bar.open, at + 4);
      out.writeDoubleLE(bar.low, at + 12);
      out.writeDoubleLE(bar.high, at + 20);
      out.writeDoubleLE(bar.close, at + 28);
      out.writeDoubleLE(bar.volume ?? 1, at + 36);
    }
  });
  return out;
}

/** The file's path in `dataFolder`. */
export function hstPath(dataFolder: string, brokerServer: string, symbol: string, minutes: number): string {
  return join(dataFolder, "history", brokerServer, `${symbol}${minutes}.hst`);
}

/** Writes the file and returns its path. */
export async function writeHst(dataFolder: string, brokerServer: string, fixture: HstFixture): Promise<string> {
  const path = hstPath(dataFolder, brokerServer, fixture.symbol, fixture.minutes);
  await mkdir(join(dataFolder, "history", brokerServer), { recursive: true });
  await writeFile(path, Buffer.concat([hstHeader(fixture), hstRecords(fixture.version, fixture.bars)]));
  return path;
}

/** Appends records as MetaTrader does while the file is being read; `partialBytes` of one more record, half-written. */
export async function appendHst(path: string, version: 400 | 401, bars: readonly FixtureBar[], partialBytes = 0): Promise<void> {
  const more = hstRecords(version, bars);
  await appendFile(path, partialBytes ? Buffer.concat([more, Buffer.alloc(partialBytes, 1)]) : more);
}

/** `count` bars `step` seconds apart from `start`, a gentle zigzag around `price`. */
export function bars(start: number, step: number, count: number, price = 1.1): FixtureBar[] {
  return Array.from({ length: count }, (_, i) => {
    const open = price + (i % 7) / 10_000;
    const close = price + ((i + 3) % 7) / 10_000;
    return { time: start + i * step, open, high: Math.max(open, close) + 0.0002, low: Math.min(open, close) - 0.0002, close, volume: 10 + i };
  });
}
