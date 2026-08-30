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

#
# Everything running this same checkout.
#
# One machine may serve the vendor's own shop, a process per renting shop, and
# the console — all from these files. Restarting only the first would leave every
# client on the old code with no sign anything was missed, and the next person to
# notice would be a shopkeeper whose bug was supposedly fixed last week.
#
# Only *shops* that are already running are touched. A shop taken off the air
# with `pos-tenant remove` stays off; a deploy is not the place to start it
# again.
#
# Gathered before anything is restarted, because on a machine with no shop of
# its own this list is the only thing there is to restart — see below.
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

#
# Installed but not matched.
#
# The list above only picks up shops systemd calls *running*. A shop that is
# installed and enabled but currently down — crashed, stopped by hand, stuck
# behind its start limit — is not in it, and used to be skipped in silence. It
# keeps the old code, comes back on its own, and serves it.
#
# Named rather than restarted: starting a shop somebody deliberately took off
# the air is not a deploy's decision. But it must be said out loud, because
# "nothing happened" is indistinguishable from "there was nothing to do".
#
INSTALLED="$(systemctl list-unit-files --no-legend --plain 'pos-tenant@*.service' 2>/dev/null | awk '{print $1}' | grep -v '@\.service$' || true)"
SKIPPED=""
for unit in $INSTALLED; do
  case " $RUNNING " in
    *" $unit "*) ;;
    *) SKIPPED="$SKIPPED $unit" ;;
  esac
done

#
# Whether this machine keeps a shop of its own.
#
# It usually does — the vendor's own — and then `pos.service` is the thing to
# restart and the thing to ask for a health check. But a machine can be purely
# a landlord: every shop on it is a `pos-tenant@` unit on its own port, and
# there is no `pos.service` and nothing listening on $PORT.
#
# This used to be fatal. The script built the new code, reached this line,
# announced that pos.service did not exist and stopped — *before* restarting a
# single tenant. So the deploy looked like it had failed, and its real effect
# was to leave the new build on disk with every shop still running the old one.
# The person at the keyboard had no reason to think anything had been restarted,
# because nothing had.
#
# So a missing pos.service is only an error when there is nothing else either.
OWN_SHOP=no
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files | grep -q "^${SERVICE}.service"; then
  OWN_SHOP=yes
elif [ -z "$RUNNING" ]; then
  die "Nothing to restart: no '$SERVICE' service and no shops running on this machine. Install deploy/pos.service, or start a shop with 'pos-tenant add' (see the README)."
fi

#
# The shop's own port, read where the shop itself reads it.
#
# This was `${PORT:-4000}`, which trusts whatever the person at the keyboard
# happens to have exported — and that is how this deploy learned to lie.
# Somebody debugging a tenant sets PORT=4100 in their shell, runs a deploy, and
# every check below asks the tenant's door about pos.service. The tenant did
# restart, so it answers with the new commit, so the script prints "up to date"
# and a green "Live at" for a shop that was never asked and is still serving
# code from a fortnight ago. The one check whose entire purpose is to catch a
# restart that did not happen was pointed at a process that did.
#
# A tenant's port has always been read out of its own env file. So is this one
# now, and an inherited PORT is ignored outright rather than merely defaulted —
# there is no reading of it that is more trustworthy than the file.
OWN_PORT="$(sudo sed -n 's/^PORT=//p' /etc/pos/pos.env 2>/dev/null | tail -1 || true)"
OWN_PORT="${OWN_PORT:-4000}"

if [ "$OWN_SHOP" = yes ]; then
  say "Restarting $SERVICE"
  sudo systemctl restart "$SERVICE"
fi

if [ -n "$RUNNING" ]; then
  say "$([ "$OWN_SHOP" = yes ] && echo 'Restarting everything else on this machine' || echo 'Restarting the shops on this machine')"
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

#
# Every unit that was restarted has to be back. A deploy that quietly left one
# client's till down is the failure this whole section exists to catch, and it
# has to be visible before the person who ran this walks away from the keyboard.
#
# systemd is given a moment: `restart` returns when the unit is *started*, and a
# process that boots, opens its database and then dies would be reported active
# by a check made in the same instant.
sleep 2
FAILED=""
for unit in $RUNNING; do
  systemctl is-active --quiet "$unit" || FAILED="$FAILED $unit"
done

if [ "$OWN_SHOP" = yes ]; then
  #
  # The shop this machine keeps for itself answers on $PORT, and being asked is
  # better than being assumed: a unit can be "active" while the app inside it is
  # failing every request.
  #
  # Only for `pos.service`. A tenant listens on a port of its own, held in its
  # env file rather than here, so asking $PORT for one would be asking the wrong
  # door and calling the shop dead when it is serving.
  say "Waiting for it to answer"
  ANSWERED=no
  for attempt in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:${OWN_PORT}/api/health" >/dev/null 2>&1; then
      ANSWERED=yes
      break
    fi
    sleep 1
  done

  if [ "$ANSWERED" = no ]; then
    printf '\n'
    sudo systemctl status "$SERVICE" --no-pager --lines 30 || true
    die "It did not come back up. The service log is above; the database was backed up before any of this."
  fi
fi

if [ -n "$FAILED" ]; then
  printf '\n\033[1;31m!! These did not come back:%s\033[0m\n' "$FAILED"
  printf '   Look at one with:  sudo journalctl -u <name> -n 50 --no-pager\n\n'
  exit 1
fi

# ------------------------------------------------- what is actually running

#
# Ask each shop which commit it is serving, and refuse to call this a success
# unless every one of them says the commit that was just deployed.
#
# This exists because a deploy used to report success on having *run* the
# restarts, which is not the same claim at all. Everything above can succeed
# while a shop is left on old code: a unit named something the pattern did not
# match, a shop that was down and so never appeared in the list, a `systemctl
# restart` that returned fine for a process that then died and was brought back
# by an older copy. Nothing in the script noticed, because nothing in the script
# ever asked.
#
# And the failure that follows is deeply confusing, because half of it works.
# The client is static files served off disk, so every till picks up the new
# screens the moment the build finishes. The routes those screens call are in
# memory in a process that did not restart. So the shop gets the new app talking
# to last week's server: the layout changes, and the screens that need anything
# new hang or 404. Somebody looking at that has no reason to suspect a deploy
# that printed "Live at" in green.
#
# `build` comes from server/src/lib/build.js and is read at startup, so it is
# the process's own answer rather than a second look at the same files on disk
# — which would agree with itself no matter what went wrong.
#
say "Checking what each shop is actually serving"

WRONG=""
UNSURE=""

# The commit this deploy put in place, in the form /api/health reports.
WANT="$(git rev-parse HEAD)"

#
# Ask one port, and say what came back.
#
# A shop that has just been restarted may still be opening its database, so it
# is given the same grace the health check above gives: a few tries, not one.
#
serving() {
  for _ in $(seq 1 15); do
    got="$(curl -fsS "http://127.0.0.1:$1/api/health" 2>/dev/null \
           | sed -n 's/.*"build" *: *"\([0-9a-f]*\)".*/\1/p')"
    [ -n "$got" ] && { printf '%s' "$got"; return 0; }
    sleep 1
  done
  return 1
}

check() {
  name="$1"
  port="$2"

  if [ -z "$port" ]; then
    UNSURE="$UNSURE $name(no port)"
    printf '    %-28s %s\n' "$name" "port unknown — not checked"
    return
  fi

  if ! got="$(serving "$port")"; then
    UNSURE="$UNSURE $name(no answer)"
    printf '    %-28s %s\n' "$name" "did not answer on $port"
    return
  fi

  # The port is printed, not just used. A check aimed at the wrong door reads
  # exactly like a check that passed, and the only thing that tells the two
  # apart on the terminal is which door was knocked on.
  if [ "$got" = "$WANT" ]; then
    printf '    %-28s :%-6s %s\n' "$name" "$port" "$(printf '%.7s' "$got") — up to date"
  else
    WRONG="$WRONG $name"
    printf '    %-28s :%-6s \033[1;31m%s\033[0m\n' "$name" "$port" "$(printf '%.7s' "$got") — STILL ON OLD CODE"
  fi
}

if [ "$OWN_SHOP" = yes ]; then
  check "$SERVICE" "$OWN_PORT"
fi

#
# A tenant's port lives in its own env file, written by `pos-tenant add`, mode
# 600 because the shop's secrets are in it — so this needs the same sudo the
# restarts above needed.
#
for unit in $RUNNING; do
  case "$unit" in
    pos-tenant@*)
      slug="${unit#pos-tenant@}"
      slug="${slug%.service}"
      tport="$(sudo sed -n 's/^PORT=//p' "/etc/pos/tenants/$slug.env" 2>/dev/null | tail -1 || true)"
      check "$unit" "$tport"
      ;;
    pos-console.service)
      # The console keeps its port in its own env file, the same way.
      cport="$(sudo sed -n 's/^PORT=//p' /etc/pos-console.env 2>/dev/null | tail -1 || true)"
      check "$unit" "$cport"
      ;;
  esac
done

if [ -n "$SKIPPED" ]; then
  printf '\n\033[1;33m!! Installed but not running, so left on the old code:%s\033[0m\n' "$SKIPPED"
  printf '   A shop that comes back on its own will serve it. Start one with:\n'
  printf '     sudo systemctl start <name>\n'
fi

if [ -n "$UNSURE" ]; then
  printf '\n\033[1;33m!! Could not confirm:%s\033[0m\n' "$UNSURE"
  printf '   Not necessarily broken — but nothing here has checked it.\n'
fi

if [ -n "$WRONG" ]; then
  printf '\n\033[1;31m!! Still serving old code after being restarted:%s\033[0m\n' "$WRONG"
  printf '   The files are new and the process is not. Its screens will be newer\n'
  printf '   than its routes, which shows up as pages that will not load.\n'
  printf '   Look at one with:  sudo journalctl -u <name> -n 50 --no-pager\n\n'
  exit 1
fi

printf '\n\033[1;32m==> Live at %s\033[0m\n\n' "$(git log --oneline -1)"
