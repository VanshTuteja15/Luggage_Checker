/* ------------------------------------------------------------------ */
/*  npm run api:new-key -- <name>                                      */
/*                                                                     */
/*  Makes a new Price Data API key (v4 A7). Prints the key ONCE, for   */
/*  the person who will use it, and the entry to add to PRICE_API_KEYS */
/*  on the server, which keeps only the key's SHA-256 hash.            */
/* ------------------------------------------------------------------ */

import { randomBytes } from "node:crypto";
import { hashKey } from "../../src/lib/engine/api-v1/core";

const name = (process.argv[2] ?? "").trim();
if (!/^[a-z0-9_-]{1,40}$/i.test(name)) {
  console.error("usage: npm run api:new-key -- <name>   (letters, digits, - or _)");
  process.exit(1);
}
const key = `lt_${randomBytes(32).toString("base64url")}`;
console.log(`key for ${name} (shown once; give it to its user, keep it out of git):`);
console.log(`  ${key}`);
console.log("add to PRICE_API_KEYS on the server (comma-separated with any others):");
console.log(`  ${name}:${hashKey(key).toString("hex")}`);
