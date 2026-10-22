// esbuild options for the dashboard (src/dashboard → dist/dashboard: app.js plus the static files).
// `npm run build` makes the production bundle; `npm run dev` makes a dev bundle that also listens for
// the dev reload signal. Only a dev bundle carries that code: it is appended as a footer, never imported.
import type { BuildOptions, Plugin } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LICENCE_TEXTS } from "../src/shared/licences.js";

const root = fileURLToPath(new URL("..", import.meta.url));
export const DASHBOARD_SOURCE = `${root}src/dashboard/`;
export const DASHBOARD_OUT = `${root}dist/dashboard/`;
export const STATIC_FILES = ["index.html", "app.css"];

/** Archivo, bundled so the dashboard never loads a font from the network: the variable font with its
 *  width axis (Latin and Latin Extended, picked by unicode-range in app.css). */
const ARCHIVO = `${root}node_modules/@fontsource-variable/archivo/`;
/** The licence texts About › Licences shows (src/shared/licences.ts), from where each work keeps it.
 *  Lightweight Charts' npm package has no NOTICE: the file in src/dashboard/licences is upstream's, unchanged (v5.2.1). */
const LICENCE_SOURCES: Record<string, string> = {
  "licences/QuoteBridge-LICENSE.txt": `${root}LICENSE`,
  "licences/Preact-LICENSE.txt": `${root}node_modules/preact/LICENSE`,
  "licences/Archivo-OFL.txt": `${ARCHIVO}LICENSE`,
  "licences/lightweight-charts-LICENSE.txt": `${root}node_modules/lightweight-charts/LICENSE`,
  "licences/lightweight-charts-NOTICE.txt": `${DASHBOARD_SOURCE}licences/lightweight-charts-NOTICE.txt`,
};
const FONT_FILES: Record<string, string> = {
  "fonts/archivo-latin-wdth-normal.woff2": `${ARCHIVO}files/archivo-latin-wdth-normal.woff2`,
  "fonts/archivo-latin-ext-wdth-normal.woff2": `${ARCHIVO}files/archivo-latin-ext-wdth-normal.woff2`,
};

export function copyStatic() {
  mkdirSync(`${DASHBOARD_OUT}fonts`, { recursive: true });
  mkdirSync(`${DASHBOARD_OUT}licences`, { recursive: true });
  for (const file of STATIC_FILES) cpSync(DASHBOARD_SOURCE + file, DASHBOARD_OUT + file);
  for (const [file, source] of Object.entries(FONT_FILES)) cpSync(source, DASHBOARD_OUT + file);
  for (const file of LICENCE_TEXTS) {
    const source = LICENCE_SOURCES[file];
    if (!source) throw new Error(`No source for the licence text ${file}`);
    cpSync(source, DASHBOARD_OUT + file);
  }
}

const copyStaticPlugin: Plugin = {
  name: "copy-static",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length === 0 && build.initialOptions.write !== false) copyStatic();
    });
  },
};

/** The page reloads itself on `reload`, and follows `navigate` (a new sign-in link after a server restart). */
function reloadClient(reloadUrl: string) {
  return `;(() => { /* quotebridge-dev-reload */
  const events = new EventSource(${JSON.stringify(reloadUrl)});
  events.addEventListener("reload", () => location.reload());
  events.addEventListener("navigate", (event) => { location.href = event.data; });
})();`;
}

/** `reloadUrl`: a dev build that listens there for the reload signal. Without it, the production build. */
export function dashboardBuildOptions(options: { reloadUrl?: string; plugins?: Plugin[] }): BuildOptions {
  const dev = options.reloadUrl !== undefined;
  return {
    entryPoints: [`${DASHBOARD_SOURCE}main.tsx`],
    outfile: `${DASHBOARD_OUT}app.js`,
    bundle: true,
    format: "esm",
    target: "es2022",
    minify: !dev,
    sourcemap: true,
    jsx: "automatic",
    jsxImportSource: "preact",
    logLevel: "info",
    plugins: [copyStaticPlugin, ...(options.plugins ?? [])],
    ...(dev ? { footer: { js: reloadClient(options.reloadUrl!) } } : {}),
  };
}
