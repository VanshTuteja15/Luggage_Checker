#!/usr/bin/env node
/* ------------------------------------------------------------------ */
/*  node scripts/run-ts.mjs <entry.ts> [args…]                         */
/*                                                                     */
/*  Bundles a TypeScript script with the app's "@/" alias (the way     */
/*  Next.js resolves it) and runs it, passing the remaining args on.   */
/* ------------------------------------------------------------------ */

import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [entry, ...args] = process.argv.slice(2);
if (!entry) {
  console.error("usage: node scripts/run-ts.mjs <entry.ts> [args…]");
  process.exit(1);
}

const out = join(mkdtempSync(join(tmpdir(), "lw-run-")), "entry.mjs");

await build({
  entryPoints: [resolve(entry)],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: out,
  external: ["@supabase/supabase-js"],
  alias: { "@": resolve("src") },
  logLevel: "warning",
});

// Hand the script its own arguments, as if it had been run directly.
process.argv = [process.argv[0], resolve(entry), ...args];
await import(pathToFileURL(out).href);
