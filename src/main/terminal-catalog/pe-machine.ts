/** PE machine types the catalog cares about. */
export const PE_MACHINE_X86 = 0x014c;
export const PE_MACHINE_X64 = 0x8664;

/** Bytes to read from an executable to find its PE header. */
export const PE_HEADER_PROBE_BYTES = 4096;

/**
 * The machine type from the start of a Windows executable (`MZ` header, `e_lfanew`, `PE\0\0`),
 * or undefined when the bytes are not a PE image.
 */
export function peMachineType(start: Uint8Array): number | undefined {
  const bytes = Buffer.from(start.buffer, start.byteOffset, start.byteLength);
  if (bytes.length < 0x40 || bytes.toString("latin1", 0, 2) !== "MZ") return undefined;
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset + 6 > bytes.length) return undefined;
  if (bytes.toString("latin1", peOffset, peOffset + 4) !== "PE\0\0") return undefined;
  return bytes.readUInt16LE(peOffset + 4);
}
