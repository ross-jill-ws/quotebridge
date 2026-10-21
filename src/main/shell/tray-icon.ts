// Tray icon bitmaps drawn in code (a filled disc), until the app has designed icons.

/** A BGRA bitmap of a filled disc for `nativeImage.createFromBitmap`. */
export function discBitmap(size: number, [red, green, blue]: [number, number, number]): Buffer {
  const pixels = Buffer.alloc(size * size * 4);
  const centre = (size - 1) / 2;
  const radius = size / 2 - 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Soft edge: coverage from the distance to the rim.
      const coverage = Math.max(0, Math.min(1, radius - Math.hypot(x - centre, y - centre) + 0.5));
      const offset = (y * size + x) * 4;
      pixels[offset] = blue;
      pixels[offset + 1] = green;
      pixels[offset + 2] = red;
      pixels[offset + 3] = Math.round(coverage * 255);
    }
  }
  return pixels;
}

export const TRAY_COLOURS = {
  normal: [38, 132, 255] as [number, number, number],
  warning: [245, 158, 11] as [number, number, number],
};
