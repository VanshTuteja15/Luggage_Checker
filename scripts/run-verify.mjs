#!/usr/bin/env node
/* ------------------------------------------------------------------ */
/*  npm run verify:search                                              */
/*                                                                     */
/*  Bundles scripts/verify-search.ts (resolving the "@/" alias the way */
/*  Next.js does) and runs it. Offline, free, no API calls.            */
/* ------------------------------------------------------------------ */

import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const out = join(mkdtempSync(join(tmpdir(), "lw-verify-")), "verify.mjs");

await build({
  entryPoints: [resolve("scripts/verify-search.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: out,
  // Not exercised by the verification run; keeps the bundle small.
  external: ["@supabase/supabase-js"],
  alias: { "@": resolve("src") },
  logLevel: "warning",
});

await import(pathToFileURL(out).href);
