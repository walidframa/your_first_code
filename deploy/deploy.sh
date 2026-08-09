#!/usr/bin/env bash
#
# Put the latest code live.
#
# Run this on the server, from the checkout, whenever you want the shop to take
# an update:
#
#     cd /srv/pos && ./deploy/deploy.sh
#
# It is deliberately one command you choose to run rather than something that
# happens on every push. A restart drops whoever is mid-sale back to a loading
# screen, and the person who should decide when that is acceptable is the person
# standing at the counter — not whoever merged something on a Friday afternoon.
#
# Safe to run twice. Refuses rather than half-finishes.

set -euo pipefail

cd "$(dirname "$0")/.."
REPO="$(pwd)"
SERVICE="${POS_SERVICE:-pos}"
BRANCH="${POS_BRANCH:-main}"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
die() { printf '\n\033[1;31m!! %s\033[0m\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------- checks

[ -f "$REPO/package.json" ] || die "This does not look like the POS checkout: $REPO"

# Uncommitted work here is almost always somebody having edited a file directly
# on the server. Pulling over it either fails or throws it away; both are worse
# than stopping and saying so.
if ! git diff --quiet || ! git diff --cached --quiet; then
  git status --short
  die "There are uncommitted changes on the server. Commit or discard them first."
fi

# ------------------------------------------------------------- the backup

# Before anything else, because the whole shop is in this one file and the
# moment you want yesterday's copy is the moment you cannot make one.
if [ -x "$REPO/deploy/backup.sh" ]; then
  say "Backing up the database"
  "$REPO/deploy/backup.sh"
fi

# ---------------------------------------------------------------- update

say "Fetching $BRANCH"
BEFORE="$(git rev-parse HEAD)"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git merge --ff-only "origin/$BRANCH" || die "Cannot fast-forward — the server is on a branch that has diverged."
AFTER="$(git rev-parse HEAD)"

if [ "$BEFORE" = "$AFTER" ]; then
  say "Already up to date at $(git log --oneline -1)"
else
  say "Updating $(git log --oneline -1 "$BEFORE") -> $(git log --oneline -1)"
fi

say "Installing dependencies"
npm ci --omit=dev --no-audit --fund=false
npm --prefix server ci --omit=dev --no-audit --fund=false
# The client's build tools are devDependencies, so this one needs them all.
npm --prefix client ci --no-audit --fund=false

say "Building the app"
npm run build

# --------------------------------------------------------------- restart

# The database migrates itself on boot, so there is no separate migration step —
# but that also means the new code and the old file meet for the first time here.
say "Restarting $SERVICE"
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files | grep -q "^${SERVICE}.service"; then
  sudo systemctl restart "$SERVICE"
else
  die "No systemd service called '$SERVICE' — install deploy/pos.service first (see the README)."
fi

# ----------------------------------------------------------------- check

# A deploy that finished is not the same as a shop that is serving. Ask the
# thing itself, and fail loudly while you are still at the keyboard rather than
# leaving it to be discovered by a customer.
say "Waiting for it to answer"
PORT="${PORT:-4000}"
for attempt in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    printf '\n\033[1;32m==> Live at %s\033[0m\n\n' "$(git log --oneline -1)"
    exit 0
  fi
  sleep 1
done

printf '\n'
sudo systemctl status "$SERVICE" --no-pager --lines 30 || true
die "It did not come back up. The service log is above; the database was backed up before any of this."
