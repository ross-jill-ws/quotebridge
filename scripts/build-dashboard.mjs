// Bundles the dashboard (src/dashboard) into dist/dashboard: app.js plus the static files.
// `--watch` rebuilds on change (used by `npm run dev:dashboard`).
import { context } from "esbuild";
import { cpSync, mkdirSync, watch as watchFile } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = `${root}src/dashboard/`;
const out = `${root}dist/dashboard/`;
const watch = process.argv.includes("--watch");

const STATIC_FILES = ["index.html", "app.css"];

function copyStatic() {
  mkdirSync(out, { recursive: true });
  for (const file of STATIC_FILES) cpSync(source + file, out + file);
}

const copyStaticPlugin = {
  name: "copy-static",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length === 0) copyStatic();
    });
  },
};

const ctx = await context({
  entryPoints: [`${source}main.tsx`],
  outfile: `${out}app.js`,
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: !watch,
  sourcemap: true,
  jsx: "automatic",
  jsxImportSource: "preact",
  logLevel: "info",
  plugins: [copyStaticPlugin],
});

if (watch) {
  await ctx.watch();
  // esbuild watches only what the bundle imports; copy the static files again when they change.
  for (const file of STATIC_FILES) watchFile(source + file, () => copyStatic());
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
