// Production build: the bundled indicator packages beside the compiled indicators module (`npm run build`).
import { fileURLToPath } from "node:url";
import { copyBundledPackages } from "./indicators-build.js";

copyBundledPackages(fileURLToPath(new URL("../dist/server/indicators/", import.meta.url)));
