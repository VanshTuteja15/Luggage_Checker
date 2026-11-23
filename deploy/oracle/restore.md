# Restore a LuggageTracker backup (v4 A8)

`deploy/oracle/backup.sh` writes `luggagetracker-<UTC time>.sql.gz`: a plain `pg_dump` of the `public` schema (the app's and the engine's tables), on the VM in `/var/backups/luggagetracker` (the 7 newest) and, when `OCI_BUCKET` is set, in that Object Storage bucket.

## 1. Pick the dump

- On the VM: `ls -lt /var/backups/luggagetracker/`
- From the bucket: `oci os object list --bucket-name <bucket> --query 'data[].name'`, then `oci os object get --bucket-name <bucket> --name <file> --file /tmp/<file>`

## 2. Try it on a scratch database first (always)

```bash
docker run -d --name lt-restore-test -e POSTGRES_PASSWORD=test postgres:17-alpine
sleep 5
gunzip -c /tmp/<file> | docker exec -i lt-restore-test psql -U postgres -v ON_ERROR_STOP=1 -q
docker exec lt-restore-test psql -U postgres -c "SELECT count(*) FROM listings;"
docker rm -f lt-restore-test
```

Supabase's own objects (the `auth` schema, roles) are not in the dump, so a few `GRANT`/policy lines may name roles a plain Postgres lacks. That's expected on the scratch test; the counts are what matter.

## 3. Restore for real (only after step 2)

- **Into Supabase:** stop the worker first (`docker compose -f deploy/oracle/compose.yml stop worker`). In the Supabase SQL editor, rename the damaged tables or restore into a new project, then `gunzip -c <file> | psql "<Supabase connection string>" -v ON_ERROR_STOP=1`. Re-run `supabase/migrations/007_own_engine.sql` afterwards (idempotent), and start the worker.
- **Into the local `localdb` profile:** `docker compose -f deploy/oracle/compose.yml --profile localdb up -d db`, then `gunzip -c <file> | docker compose -f deploy/oracle/compose.yml exec -T db psql -U luggagetracker luggagetracker`.

## 4. Check

`docker compose -f deploy/oracle/compose.yml logs --tail=50 worker` shows jobs running; the app's search returns prices; Store status shows each store's last read.

A restore you haven't tried is not a backup: run step 2 once a month.
