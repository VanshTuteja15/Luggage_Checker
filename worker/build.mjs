#!/usr/bin/env node
/* ------------------------------------------------------------------ */
/*  Bundle the worker (and the shared engine in ../src/lib/engine)     */
/*  into dist/main.mjs. pg and pg-boss stay external (node_modules).   */
/* ------------------------------------------------------------------ */

import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

await build({
  entryPoints: [here("./src/main.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: here("./dist/main.mjs"),
  alias: { "@": here("../src") },
  external: ["pg", "pg-boss", "pg-native"],
  banner: { js: "import { createRequire as __lwCreateRequire } from 'node:module'; const require = __lwCreateRequire(import.meta.url);" },
  sourcemap: true,
  logLevel: "warning",
});

console.log("worker bundled → dist/main.mjs");
