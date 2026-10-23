// The bundled indicator packages (src/server/indicators/bundled) are plain files tsc does not copy: they go beside
// the built indicators module, in dist/ (`npm run build`) or in the dev run's .dev-build.
import { cpSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
export const BUNDLED_SOURCE = join(root, "src", "server", "indicators", "bundled");

/** Copies the bundled packages into `folder`/bundled. */
export function copyBundledPackages(folder: string) {
  cpSync(BUNDLED_SOURCE, join(folder, "bundled"), { recursive: true });
}
