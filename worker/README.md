# LuggageTracker worker

The price engine runs here: research sessions, discovery/indexing, daily verification of tracked products, and source health checks. The Vercel app only orchestrates: it creates sessions and sends **signed** requests here.

```
Vercel (Next.js)  ──signed HTTPS──▶  worker  ──polite HTTP──▶  registry stores / official APIs
       │                               │
       └──── Supabase (Postgres, Auth, Realtime) ◀────┘   (pg-boss queue lives in schema "pgboss")
```

- **Node 22 LTS** (Node 20 reached end-of-life in April 2026; pg-boss 12 needs Node ≥ 22.12).
- **Job queue:** pg-boss on the same Postgres (schema `pgboss`, created automatically on first start).
- **Health:** `GET /health` → JSON (version, uptime, queue depth, what's configured; never secrets).
- **Logs:** one JSON object per line on stdout/stderr; keys that look like secrets are redacted.
- **Politeness:** every request goes through the engine's `PoliteFetcher` (registry hosts only, robots.txt, crawl delays, circuit breaker, honest User-Agent with a contact).

## Environment

| Variable | Required | What |
|---|---|---|
| `WORKER_SHARED_SECRET` | yes | ≥ 32 random characters, identical to the Vercel app's. `openssl rand -hex 32` |
| `DATABASE_URL` | yes in production | Supabase Postgres **session pooler** URL (Settings → Database → Connection string → Session pooler). Without it: in-memory mode, nothing persists. |
| `DATABASE_SSL_CA` | recommended | Supabase CA certificate (PEM; `\n` escapes allowed). Without it the certificate is verified against public roots; if that fails, set `DATABASE_SSL=no-verify` (encrypted, but not identity-checked). |
| `CRAWLER_CONTACT` | recommended | Email or URL store operators can reach us at; goes in the User-Agent. Defaults to the project's public issue tracker. |
| `UCP_AGENT_PROFILE_URL` | for Shopify UCP | Public URL of our agent profile (see `docs/HUMAN_ACTIONS.md` §1). |
| `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET` | for eBay | Free Browse API keys. |
| `PORT` | no | Default 8787. |
| `WORKER_MAX_SESSIONS` | no | Concurrent research sessions (default 4). |
| `ENGINE_FLAGS` | no | Operator overrides, e.g. `discovery.tavily=off`. |
| `LOG_LEVEL` | no | `debug` / `info` (default) / `warn` / `error`. |

## Build, test, run

```bash
cd worker
npm ci
npm run build        # typecheck + bundle → dist/main.mjs
npm test             # unit tests (the e2e test runs from the repo root: npm run test:worker:e2e)
node --env-file=.env dist/main.mjs
```

From the repo root: `npm run test:worker:e2e` starts a throwaway Postgres in Docker, applies the migrations, and runs the worker tests including a real pg-boss round trip.

## Option A (recommended, $0): the office PC + Cloudflare Tunnel

The P0 probe ran from this network, so its results (which stores answer, which block) apply directly. A Cloudflare Tunnel gives the worker a public HTTPS address without opening ports, on Cloudflare's free plan.

1. Install Docker Desktop (or Node 22) on an always-on office PC.
2. Create `worker/.env` with the variables above (never commit it).
3. Build and run (from the repo root):
   ```powershell
   docker build -f worker/Dockerfile -t luggage-tracker-worker .
   docker run -d --restart unless-stopped --name lt-worker --env-file worker/.env -p 8787:8787 luggage-tracker-worker
   ```
4. Cloudflare dashboard → Zero Trust → Networks → Tunnels → Create tunnel (cloudflared) → install the connector on the PC → Public hostname `worker.<your-domain>` → service `http://localhost:8787`.
5. In Vercel set `WORKER_URL=https://worker.<your-domain>` and the same `WORKER_SHARED_SECRET`.
6. **Check:** `curl https://worker.<your-domain>/health` returns `"ok":true`.

If the PC sleeps or reboots, research falls back to inline mode on Vercel (slower, but it still works) and the daily jobs run on the next cron.

## Option B ($0): Oracle Cloud Always Free VM

1. Create an Always Free Ampere A1 VM (Ubuntu 24.04), open port 443 only.
2. Install Docker; copy the repo; build and run as in Option A (`-p 127.0.0.1:8787:8787`).
3. Put Caddy in front for HTTPS (`caddy reverse-proxy --from worker.<your-domain> --to 127.0.0.1:8787`).
4. **Re-run the probe from the VM** (`npm run probe:sources`): data-centre IPs are often treated more strictly than the office network.

Choosing the host is a human decision (`docs/HUMAN_ACTIONS.md`). Nothing here requires a paid plan.

## Security

- Every endpoint except `/health` requires an HMAC signature over method, path, timestamp, nonce and body (5-minute window, single-use nonce).
- The worker contacts only hosts listed in the registry's `fetchHosts` (SSRF guard, DNS-checked against private ranges, redirects re-checked).
- The container runs as the unprivileged `node` user; secrets come only from the environment.
