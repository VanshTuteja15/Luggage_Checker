#!/usr/bin/env bash
# ------------------------------------------------------------------
# Nightly database backup (v4 A8): pg_dump → gzip → OCI Object Storage.
#
#   bash deploy/oracle/backup.sh            back up now (cron runs it nightly)
#   bash deploy/oracle/backup.sh --dry-run  say what it would do
#
# Reads deploy/oracle/.env: BACKUP_DATABASE_URL (else DATABASE_URL),
# OCI_BUCKET (optional), BACKUP_DIR (default /var/backups/luggagetracker).
# Dumps the public schema (the app's and the engine's tables). Keeps
# the 7 newest dumps on the VM; the bucket keeps them per its lifecycle
# rule (30 days, set once in the console). Never prints the connection
# string. Restoring: deploy/oracle/restore.md.
# ------------------------------------------------------------------
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$HERE/.env"
DRY=0
if [ "${1:-}" = "--dry-run" ]; then DRY=1; fi
if [ ! -f "$ENV_FILE" ]; then
  echo "deploy/oracle/.env is missing" >&2
  exit 1
fi
get() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2-; }

DB_URL="$(get BACKUP_DATABASE_URL)"
if [ -z "$DB_URL" ]; then DB_URL="$(get DATABASE_URL)"; fi
if [ -z "$DB_URL" ]; then
  echo "DATABASE_URL is empty in deploy/oracle/.env" >&2
  exit 1
fi
BUCKET="$(get OCI_BUCKET)"
DIR="$(get BACKUP_DIR)"
DIR="${DIR:-/var/backups/luggagetracker}"
FILE="$DIR/luggagetracker-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"

if [ "$DRY" -eq 1 ]; then
  echo "would dump the public schema to $FILE"
  if [ -n "$BUCKET" ]; then echo "would upload it to the bucket $BUCKET"; else echo "no OCI_BUCKET: would keep it on the VM only"; fi
  echo "would keep the 7 newest dumps in $DIR"
  exit 0
fi

umask 077
mkdir -p "$DIR"
# pg_dump from the official image: nothing to install, and version 17 reads Supabase and the
# localdb profile alike. The URL goes in through the environment, not the docker command line.
DATABASE_URL="$DB_URL" docker run --rm --network host --env DATABASE_URL postgres:17-alpine \
  sh -c 'exec pg_dump --no-owner --no-privileges --schema=public "$DATABASE_URL"' |
  gzip -9 > "$FILE"
if [ ! -s "$FILE" ]; then
  echo "the dump is empty; nothing uploaded" >&2
  rm -f "$FILE"
  exit 1
fi
echo "$(date -u +%FT%TZ) dumped $(du -h "$FILE" | cut -f1) to $FILE"

status=0
if [ -n "$BUCKET" ]; then
  if command -v oci > /dev/null 2>&1; then
    if oci os object put --bucket-name "$BUCKET" --file "$FILE" --name "$(basename "$FILE")" --force > /dev/null; then
      echo "uploaded to the bucket $BUCKET"
    else
      echo "the upload failed; the dump stays on the VM" >&2
      status=1
    fi
  else
    echo "OCI_BUCKET is set but the oci CLI isn't installed; the dump stays on the VM" >&2
    status=1
  fi
fi

# Our own old dumps only (this script's file name pattern, in its own folder).
find "$DIR" -maxdepth 1 -name 'luggagetracker-*.sql.gz' -type f -printf '%T@ %p\n' |
  sort -rn | tail -n +8 | cut -d' ' -f2- | xargs -r rm -f --
exit "$status"
