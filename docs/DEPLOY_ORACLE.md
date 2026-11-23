# Deploy on Oracle Cloud Always Free (Arm): runbook (v4 A8)

**Status: scripts only.** Nothing here has been run against a real account; the decision is the owner's (`docs/HUMAN_ACTIONS.md` V4-5: Oracle, which asks for a card for identity at sign-up, or the GitHub Actions route). The kit is `deploy/oracle/`: `compose.yml`, `setup.sh`, `backup.sh`, `restore.md`, `env.example`.

**What it gives:** an always-on worker for $0, which handles catalogue reads, discovery, the morning email's fallback tick and the small-model lane (decision D3 in `planning/v4/review/04_DECISIONS.md`). The app stays on Vercel and its data stays in Supabase; the worker connects to the same database.

**What it doesn't:** it doesn't run searches' AI (no AI on the 8-second path), it doesn't price anything with a model, and it opens no inbound port except SSH.

## 0. Costs to avoid (read first)

- Use **Always Free-eligible** resources only. The console marks them; the A1 Flex shape is free up to the current monthly limit (2 OCPU / 12 GB as checked on 2026-10-30: 1,500 OCPU-hours and 9,000 GB-hours a month). One VM of 2 OCPU / 12 GB stays inside it.
- **Never upgrade the account to Pay As You Go.** That is what makes charges possible.
- Billing → Budgets: a **$1 budget alert** to your email the day the account opens.
- Stay in the **home region**. Keep block storage ≤ 200 GB in total and Object Storage ≤ 20 GB (the backups use well under 1 GB).
- **Idle reclaim:** Oracle may reclaim an Always Free VM whose CPU (95th percentile), network and memory all stay under 20% for 7 days. Ollama keeps one 3 B model loaded (`keep_alive -1`, about 2–3 GB of the 12 GB). After setup, check `free -m` shows ≥ 20% used. If it doesn't, the instance is at risk: say so before relying on it.

## 1. The account (owner)

Sign up at oracle.com/cloud/free with the business email. Choose the home region nearest Calgary (e.g. Canada Southeast (Toronto) or Canada Southeast (Montreal)); it can't be changed later. Add the $1 budget alert (§0).

## 2. The VM (console, about 10 minutes)

1. Compute → Instances → Create instance.
2. Image: **Canonical Ubuntu 24.04** (aarch64). Shape: **Ampere A1 Flex, 2 OCPU, 12 GB**.
3. Networking: a new VCN with a public subnet (the default wizard is fine); assign a public IPv4 for SSH.
4. SSH: paste your public key (`ssh-keygen -t ed25519` on your laptop if you have none).
5. Boot volume: the default (about 47 GB) is enough.
6. Create. If the console says "out of capacity" for A1, try again later or another availability domain; never pick a paid shape instead.
7. VCN → Security List: keep **only port 22 inbound**, ideally from your own IP. No 80/443 is needed.

## 3. Set up (SSH, about 20 minutes)

```bash
ssh ubuntu@<public IP>
sudo apt-get update && sudo apt-get install -y git
git clone <this repository's URL> luggage-tracker && cd luggage-tracker
git switch feat/own-engine            # or main, once it's merged
cp deploy/oracle/env.example deploy/oracle/.env
nano deploy/oracle/.env               # fill in; never paste these values anywhere else
bash deploy/oracle/setup.sh --check   # dry run: changes nothing
bash deploy/oracle/setup.sh --yes     # updates, firewall, Docker, start, model, nightly backup
```

`setup.sh` refuses to run as root without `--yes`, never prints `.env` values, and stops before changing anything if a check fails.

## 4. After setup: checks

- `docker compose -f deploy/oracle/compose.yml ps`: `worker` and `ollama` running.
- `curl -s http://127.0.0.1:8787/health`: `{"ok":true,…}` with no secrets.
- `docker compose -f deploy/oracle/compose.yml exec ollama ollama ps`: the model is loaded.
- `sudo ufw status`: active, OpenSSH only. `ss -tlnp`: 8787 and 11434 on 127.0.0.1 only.
- `bash deploy/oracle/backup.sh --dry-run`, then `bash deploy/oracle/backup.sh` once by hand.
- `free -m`: memory ≥ 20% used (§0).

What runs by itself today: the morning email's fallback tick every 15 minutes (Supabase's pg_cron stays the primary trigger). Scheduled catalogue reads every 6–12 h are phase A9 (planned, not built). Until then, a catalogue read is a `discover.source` job (`{"sourceId":"canadaluggagedepot"}`) sent through the worker's signed HTTP API, or `npm run engine:discover -- --source=canadaluggagedepot` from a machine with `DATABASE_URL`.

**Optional, research sessions on this worker:** the app reaches a worker through `WORKER_URL`. To keep inbound ports closed, use a Cloudflare Tunnel (free): create a tunnel in Cloudflare Zero Trust that points a hostname at `http://worker:8787`, put its token in `CLOUDFLARE_TUNNEL_TOKEN`, then run `docker compose -f deploy/oracle/compose.yml --profile tunnel up -d`. On Vercel, set `WORKER_URL=https://<that hostname>` and the same `WORKER_SHARED_SECRET`. Every request to the worker is signed; unsigned ones are refused.

## 5. Backups

- `backup.sh` runs nightly at 03:15 (cron, set by `setup.sh`): `pg_dump` of the `public` schema → gzip → `/var/backups/luggagetracker` (the 7 newest kept).
- **Off the VM (recommended):** create an Object Storage bucket (private), add a lifecycle rule "delete after 30 days", install the OCI CLI (`bash -c "$(curl -L https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh)"`), and run `oci setup config` with an API key for a user whose policy allows only `manage objects` in that bucket's compartment. Then set `OCI_BUCKET` in `.env`.
- **Restore:** `deploy/oracle/restore.md`. Try a restore on a scratch database once a month.

## 6. Updates

```bash
cd ~/luggage-tracker && git pull
docker compose -f deploy/oracle/compose.yml up -d --build
docker image prune -f                 # old image layers only
```

Security updates install themselves (unattended-upgrades). Reboot when `/var/run/reboot-required` exists.

## 7. Undo

`docker compose -f deploy/oracle/compose.yml down` stops everything (data in Supabase is untouched). To leave Oracle, terminate the instance and delete its boot volume and the bucket in the console. Nothing else was created.

## Checks run on the laptop (2026-10-30, no cloud account)

DEPLOY-1 and DEPLOY-2 from `planning/v4/review/06_TEST_PLAN.md`: `docker compose -f deploy/oracle/compose.yml config` parses, with Ollama and the worker published on 127.0.0.1 only and Postgres published nowhere. `bash -n` passes on both scripts, `setup.sh --check` changes nothing, and `setup.sh` refuses to run as root without `--yes`. `tests/app/deploy-kit.test.ts` checks the same rules and that no secret is in `deploy/oracle/`. shellcheck wasn't installed, so it wasn't run.
