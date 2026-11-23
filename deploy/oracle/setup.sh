#!/usr/bin/env bash
# ------------------------------------------------------------------
# LuggageTracker on an Oracle Cloud Always Free Arm VM (v4 A8).
#
#   bash deploy/oracle/setup.sh --check   dry run: checks only, changes nothing
#   bash deploy/oracle/setup.sh --yes     install and start
#
# Run it from a checkout of the repository, as a normal user with sudo.
# It never creates cloud resources or accounts and never prints the
# values in deploy/oracle/.env. Runbook: docs/DEPLOY_ORACLE.md.
# ------------------------------------------------------------------
set -euo pipefail

MODE=""
for arg in "$@"; do
  case "$arg" in
    --check) MODE="check" ;;
    --yes) MODE="install" ;;
    -h | --help)
      sed -n '2,11p' "$0"
      exit 0
      ;;
    *)
      echo "unknown option: $arg (use --check or --yes)" >&2
      exit 2
      ;;
  esac
done
if [ -z "$MODE" ]; then
  echo "Choose --check (a dry run) or --yes (install)." >&2
  exit 2
fi

# root only on purpose: a normal user with sudo is the safe default.
if [ "$(id -u)" -eq 0 ] && [ "$MODE" != "install" ]; then
  echo "Refusing to run as root without --yes. Run it as a normal user with sudo." >&2
  exit 1
fi
SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
ENV_FILE="$HERE/.env"
problems=0
ok() { printf '  ok    %s\n' "$1"; }
warn() { printf '  note  %s\n' "$1"; }
fail() {
  printf '  FAIL  %s\n' "$1"
  problems=$((problems + 1))
}

echo "Checks"
arch="$(uname -m)"
if [ "$arch" = "aarch64" ]; then ok "Arm (aarch64)"; else warn "not an Arm VM ($arch); this kit is for the A1 Flex shape"; fi
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  if [ "${ID:-}" = "ubuntu" ]; then ok "Ubuntu ${VERSION_ID:-}"; else warn "not Ubuntu (${ID:-unknown}); the steps assume Ubuntu 24.04"; fi
fi
mem_gb="$(awk '/MemTotal/ {printf "%d", $2 / 1048576}' /proc/meminfo 2>/dev/null || echo 0)"
if [ "${mem_gb:-0}" -ge 8 ]; then ok "memory ${mem_gb} GB"; else warn "memory ${mem_gb} GB (A1 Flex 2 OCPU has 12 GB)"; fi
free_gb="$(df -Pk "$REPO" | awk 'NR == 2 {printf "%d", $4 / 1048576}')"
if [ "${free_gb:-0}" -ge 15 ]; then ok "disk: ${free_gb} GB free"; else fail "disk: ${free_gb} GB free; 15 GB needed (images, one model, backups)"; fi
if [ -f "$REPO/worker/Dockerfile" ]; then ok "repository checkout at $REPO"; else fail "run this from a checkout of the repository"; fi
if [ -f "$ENV_FILE" ]; then
  ok "deploy/oracle/.env is there"
  for v in DATABASE_URL WORKER_SHARED_SECRET CRAWLER_CONTACT; do
    if grep -Eq "^${v}=.+" "$ENV_FILE"; then ok "$v is set"; else fail "$v is empty in deploy/oracle/.env"; fi
  done
else
  fail "deploy/oracle/.env is missing: cp deploy/oracle/env.example deploy/oracle/.env, then fill it in"
fi
if command -v docker > /dev/null 2>&1; then ok "Docker is installed"; else warn "Docker isn't installed yet (--yes installs it)"; fi

if [ "$MODE" = "check" ]; then
  echo
  if [ "$problems" -eq 0 ]; then
    echo "Dry run: nothing was changed. Ready for --yes."
    exit 0
  fi
  echo "Dry run: $problems problem(s) above; nothing was changed."
  exit 1
fi
if [ "$problems" -ne 0 ]; then
  echo "Fix the problems above first (nothing was changed)." >&2
  exit 1
fi

echo "1/6 System updates; security updates install themselves from now on"
$SUDO apt-get update -y
$SUDO env DEBIAN_FRONTEND=noninteractive apt-get upgrade -y
$SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg ufw unattended-upgrades
$SUDO dpkg-reconfigure -f noninteractive unattended-upgrades

echo "2/6 Firewall: SSH in, nothing else (the worker and Ollama listen on 127.0.0.1 only)"
$SUDO ufw default deny incoming
$SUDO ufw default allow outgoing
$SUDO ufw allow OpenSSH
$SUDO ufw --force enable

echo "3/6 Docker Engine and the compose plugin, from Docker's own apt repository"
if ! command -v docker > /dev/null 2>&1; then
  $SUDO install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | $SUDO gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  $SUDO chmod a+r /etc/apt/keyrings/docker.gpg
  codename="$(. /etc/os-release && echo "$VERSION_CODENAME")"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $codename stable" |
    $SUDO tee /etc/apt/sources.list.d/docker.list > /dev/null
  $SUDO apt-get update -y
  $SUDO apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
if [ -n "$SUDO" ]; then $SUDO usermod -aG docker "$USER"; fi

echo "4/6 Start the worker and Ollama, then load the model"
chmod 600 "$ENV_FILE"
$SUDO docker compose -f "$HERE/compose.yml" up -d --build
model="$(grep -E '^OLLAMA_MODEL=' "$ENV_FILE" | tail -1 | cut -d= -f2-)"
$SUDO docker compose -f "$HERE/compose.yml" exec -T ollama ollama pull "${model:-qwen2.5:3b}"

echo "5/6 Nightly database backup at 03:15 (deploy/oracle/backup.sh)"
echo "15 3 * * * $USER cd $REPO && bash deploy/oracle/backup.sh >> /var/log/luggagetracker-backup.log 2>&1" |
  $SUDO tee /etc/cron.d/luggagetracker-backup > /dev/null
$SUDO touch /var/log/luggagetracker-backup.log
$SUDO chown "$USER" /var/log/luggagetracker-backup.log

echo "6/6 Checks"
sleep 15
if curl -fsS http://127.0.0.1:8787/health > /dev/null; then ok "the worker answers on 127.0.0.1:8787"; else fail "the worker didn't answer: docker compose -f deploy/oracle/compose.yml logs worker"; fi
if curl -fsS http://127.0.0.1:11434/api/tags > /dev/null; then ok "Ollama answers on 127.0.0.1:11434"; else fail "Ollama didn't answer: docker compose -f deploy/oracle/compose.yml logs ollama"; fi
if $SUDO ufw status | grep -q "Status: active"; then ok "firewall on (SSH only)"; else fail "the firewall isn't on"; fi
echo
if [ "$problems" -ne 0 ]; then
  echo "$problems check(s) failed (see above)."
  exit 1
fi
echo "Done. Log out and back in once (Docker group), then follow docs/DEPLOY_ORACLE.md, 'After setup'."
