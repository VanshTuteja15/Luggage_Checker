#!/usr/bin/env node
/* ------------------------------------------------------------------ */
/*  node scripts/run-ts.mjs <entry.ts> [args…]                         */
/*                                                                     */
/*  Bundles a TypeScript script with the app's "@/" alias (the way     */
/*  Next.js resolves it) and runs it, passing the remaining args on.   */
/* ------------------------------------------------------------------ */

import { build } from "esbuild";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [entry, ...args] = process.argv.slice(2);
if (!entry) {
  console.error("usage: node scripts/run-ts.mjs <entry.ts> [args…]");
  process.exit(1);
}

// Inside the project, so packages left external (supabase-js) resolve from
// its node_modules.
const cache = resolve("node_modules/.cache");
mkdirSync(cache, { recursive: true });
const out = join(mkdtempSync(join(cache, "lw-run-")), "entry.mjs");

await build({
  entryPoints: [resolve(entry)],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: out,
  // pg-native is pg's optional native binding, never loaded by our scripts.
  external: ["@supabase/supabase-js", "pg-native"],
  // CommonJS dependencies (pg) call require() for Node built-ins; give the
  // ESM bundle a real require so those calls work.
  banner: { js: "import { createRequire as __lwCreateRequire } from 'node:module'; const require = __lwCreateRequire(import.meta.url);" },
  alias: { "@": resolve("src") },
  logLevel: "warning",
});

// Hand the script its own arguments, as if it had been run directly.
process.argv = [process.argv[0], resolve(entry), ...args];
await import(pathToFileURL(out).href);
