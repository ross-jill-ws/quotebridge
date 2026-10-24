// Test-only indicator package ZIPs: a package's files, deflated (or stored) into a ZIP as a trader would make one.
import { crc32, deflateRawSync } from "node:zlib";

/** `claimedSize` and `badCrc` make a damaged entry: its headers say another size or checksum than its data has. */
export type ZipEntry = { name: string; text: string | Buffer; store?: boolean; symlink?: boolean; encrypted?: boolean; claimedSize?: number; badCrc?: boolean };

/** A ZIP of these entries, in order. */
export function zip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.isBuffer(e.text) ? e.text : Buffer.from(e.text, "utf8");
    const packed = e.store ? data : deflateRawSync(data);
    const name = Buffer.from(e.name, "utf8");
    const crc = e.badCrc ? (crc32(data) ^ 1) >>> 0 : crc32(data);
    const size = e.claimedSize ?? data.length;
    const flags = (e.encrypted ? 1 : 0) | 0x800;
    const method = e.store ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((e.symlink ? 0xa1ff : 0x81a4) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** A package's four files as a ZIP, with `extra` entries after them. */
export function packageZip(files: Record<string, string>, extra: readonly ZipEntry[] = []): Buffer {
  return zip([...Object.entries(files).map(([name, text]) => ({ name, text })), ...extra]);
}

/**
 * A third-party package: the close times `factor` (a parameter), and a second parameter `offset` from version 2 on.
 * `version`, `offset` and `licence` make the upgrades and conflicts the tests need.
 */
export function scaledPackage(version = "1.0.0", options: { offset?: boolean; licence?: string; name?: string } = {}): Record<string, string> {
  const parameters: unknown[] = [{ id: "factor", label: "Factor", type: "number", default: 2, min: 0, max: 10 }];
  if (options.offset) parameters.push({ id: "offset", label: "Offset", type: "number", default: 1, min: -100, max: 100 });
  return {
    "manifest.json": JSON.stringify({
      apiVersion: 1,
      id: "acme.scaled",
      version,
      name: options.name ?? "Scaled close",
      description: "The close times a factor.",
      license: "MIT",
      entry: "calculate.js",
      inputs: [{ id: "source", label: "Close", kind: "numeric", alignment: "exact", field: "close", history: { bars: 1 } }],
      parameters,
      outputs: [{ id: "scaled", label: "Scaled", kind: "numeric", render: "line", placement: "pane", color: "#ffffff", unit: { input: "source" } }],
    }),
    "calculate.js": `exports.calculate = function ({ inputs, parameters, timeline }) {
      const points = inputs.source.points;
      const offset = parameters.offset === undefined ? 0 : parameters.offset;
      return { outputs: { scaled: timeline.map((time, i) => ({ time, value: points[i].value * parameters.factor + offset })) } };
    };`,
    "README.md": "# Scaled close\n\nThe close times a factor.",
    LICENSE: options.licence ?? "MIT License\n\nCopyright (c) 2026 Acme",
  };
}
