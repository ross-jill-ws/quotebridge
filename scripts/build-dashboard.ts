// Production build of the dashboard into dist/dashboard (`npm run build`). `npm run dev` watches instead.
import { build } from "esbuild";
import { dashboardBuildOptions } from "./dashboard-build.js";

await build(dashboardBuildOptions({}));
