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

#
# Uncommitted work here is almost always somebody having edited a file directly
# on the server. Pulling over it either fails or throws it away; both are worse
# than stopping and saying so.
#
# With one exception, and it is not a loophole: npm rewrites the lock files
# during its own install, so every deploy leaves them modified and the *next*
# one refuses to start. Reading that message, a person's only move is to
# discard exactly these files — so this does it for them, and says so, rather
# than sending them to look for an edit nobody made.
#
# Safe because the install below reads the lock files from the commit being
# deployed, not from whatever npm left behind.
#
CHANGED="$(git diff --name-only; git diff --cached --name-only)"
CHANGED="$(printf '%s\n' "$CHANGED" | grep -v '^$' | sort -u || true)"

if [ -n "$CHANGED" ]; then
  NOT_LOCKS="$(printf '%s\n' "$CHANGED" | grep -v 'package-lock\.json$' || true)"
  if [ -z "$NOT_LOCKS" ]; then
    say "Putting npm's changes to the lock files back"
    # shellcheck disable=SC2086
    printf '%s\n' "$CHANGED" | while read -r f; do git checkout -- "$f"; done
  else
    git status --short
    die "There are uncommitted changes on the server. Commit or discard them first."
  fi
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

#
# Everything else running this same checkout.
#
# One machine now serves the vendor's own shop, a process per renting shop, and
# the console — all from these files. Restarting only the first would leave every
# client on the old code with no sign anything was missed, and the next person to
# notice would be a shopkeeper whose bug was supposedly fixed last week.
#
# Only *shops* that are already running are touched. A shop taken off the air
# with `pos-tenant remove` stays off; a deploy is not the place to start it
# again.
RUNNING="$(systemctl list-units --state=running --no-legend --plain 'pos-tenant@*.service' 2>/dev/null | awk '{print $1}' || true)"

#
# The console is not a shop, and the rule above is wrong for it.
#
# It is one installation-wide service that should always be on, so "only if it
# is already running" turns a console that has crashed — or that is refusing to
# start against a database it cannot write — into one that silently keeps the
# old code through every future deploy. That is not hypothetical: a console
# stayed on a build from before the fix for its own bug, and the only clue was
# an unchanged PID in the log.
#
# Restarted whenever the unit is installed, running or not.
if systemctl list-unit-files --no-legend --plain 'pos-console.service' 2>/dev/null | grep -q .; then
  RUNNING="$(printf '%s\npos-console.service\n' "$RUNNING")"
fi

RUNNING="$(printf '%s\n' "$RUNNING" | grep -v '^$' || true)"

if [ -n "$RUNNING" ]; then
  say "Restarting everything else on this machine"
  printf '%s\n' "$RUNNING" | while read -r unit; do
    [ -n "$unit" ] || continue
    printf '    %s\n' "$unit"
    # One shop failing to come back must not stop the rest from being restarted,
    # and must not be silent either — the check below says which.
    sudo systemctl restart "$unit" || true
  done
fi

# ----------------------------------------------------------------- check

# A deploy that finished is not the same as a shop that is serving. Ask the
# thing itself, and fail loudly while you are still at the keyboard rather than
# leaving it to be discovered by a customer.
say "Waiting for it to answer"
PORT="${PORT:-4000}"
for attempt in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    # The main shop is answering. Now say plainly whether the others are, too:
    # a deploy that quietly left one client's till down is the failure this
    # whole section exists to catch, and it has to be visible before the person
    # who ran this walks away from the keyboard.
    FAILED=""
    if [ -n "$RUNNING" ]; then
      for unit in $RUNNING; do
        systemctl is-active --quiet "$unit" || FAILED="$FAILED $unit"
      done
    fi

    if [ -n "$FAILED" ]; then
      printf '\n\033[1;31m!! Live, but these did not come back:%s\033[0m\n' "$FAILED"
      printf '   Look at one with:  sudo journalctl -u <name> -n 50 --no-pager\n\n'
      exit 1
    fi

    printf '\n\033[1;32m==> Live at %s\033[0m\n\n' "$(git log --oneline -1)"
    exit 0
  fi
  sleep 1
done

printf '\n'
sudo systemctl status "$SERVICE" --no-pager --lines 30 || true
die "It did not come back up. The service log is above; the database was backed up before any of this."
