#!/usr/bin/env bash
#
# A fresh server, into a shop's till, in one command.
#
#     sudo ./deploy/bootstrap.sh pos.myshop.com you@example.com
#
# On a new Ubuntu or Debian machine. The second argument is only used to tell
# Let's Encrypt where to write if a certificate is about to expire; leave it out
# and the certificate step is skipped, which is what you want while you are
# still testing on an IP address with no domain pointed at it yet.
#
# Everything the README's "First time" section does by hand, in the same order,
# and safe to run twice: it installs what is missing, leaves alone what is
# there, and — this is the one that matters — never touches the two secrets or
# the database once they exist.

set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
REPO_DIR="${POS_DIR:-/srv/pos}"
REPO_URL="${POS_REPO:-https://github.com/walidframa/your_first_code}"
DATA_DIR=/var/lib/pos
BACKUP_DIR=/var/backups/pos
ENV_FILE=/etc/pos.env

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
note() { printf '    %s\n' "$1"; }
die()  { printf '\n\033[1;31m!! %s\033[0m\n' "$1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run this with sudo."
[ -n "$DOMAIN" ] || die "Usage: sudo ./deploy/bootstrap.sh <domain-or-ip> [email-for-https]"

# ------------------------------------------------------------ the machine

say "Installing what the server needs"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx git curl ca-certificates >/dev/null

# Node 24 or newer: the server reads its database through node:sqlite, which
# does not exist in the version Debian ships.
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
  note "Installing Node 24"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
note "node $(node -v)"

# ------------------------------------------------------------- the places

id -u pos >/dev/null 2>&1 || adduser --system --group --home "$REPO_DIR" pos
mkdir -p "$DATA_DIR" "$BACKUP_DIR"
chown pos:pos "$DATA_DIR" "$BACKUP_DIR"

say "Fetching the app into $REPO_DIR"
if [ -d "$REPO_DIR/.git" ]; then
  note "already a checkout, leaving it to deploy.sh to update"
else
  git clone --quiet "$REPO_URL" "$REPO_DIR"
fi
chown -R pos:pos "$REPO_DIR"
git config --global --add safe.directory "$REPO_DIR"

# ------------------------------------------------------------ the secrets

#
# Written once, and never again.
#
# JWT_SECRET being replaced logs everybody out, which is merely annoying.
# ACCOUNT_SECRET being replaced makes every customer password and repair
# passcode the shop is holding permanently unreadable — so a bootstrap script
# that "helpfully" refreshed the file on a second run would quietly destroy the
# most sensitive thing in the database.
#
if [ -f "$ENV_FILE" ]; then
  say "Keeping the existing $ENV_FILE"
  note "secrets already set; not touching them"
else
  say "Writing $ENV_FILE with fresh secrets"
  key() { node -e 'console.log(require("crypto").randomBytes(48).toString("hex"))'; }
  sed \
    -e "s|^JWT_SECRET=.*|JWT_SECRET=$(key)|" \
    -e "s|^ACCOUNT_SECRET=.*|ACCOUNT_SECRET=$(key)|" \
    "$REPO_DIR/deploy/pos.env.example" > "$ENV_FILE"
  chown pos:pos "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  note "ACCOUNT_SECRET is in there — copy it somewhere off this machine today"
fi

# --------------------------------------------------------------- the app

say "Installing and building"
#
# Without the production environment loaded, deliberately. NODE_ENV=production
# tells npm to skip devDependencies, and the client is built by tools that live
# there — so sourcing the env file here would leave the build with no Vite.
#
sudo -u pos --preserve-env=PATH bash -lc "cd '$REPO_DIR' && npm run setup && npm run build" \
  || die "The build failed. Nothing has been started; fix it and run this again."

#
# And then the shop's own database, which is a different file.
#
# `npm run setup` seeds the development one next to the code. The books live in
# /var/lib/pos, and a brand-new file there has no users in it at all — so
# without this the whole thing comes up perfectly and nobody on earth can sign
# in. The seed skips anything already present, so this is safe on every re-run.
#
say "Making sure there is an owner to sign in as"
DB_PATH="$(sed -n 's/^DB_PATH=//p' "$ENV_FILE" | tail -1)"
[ -n "$DB_PATH" ] || die "No DB_PATH in $ENV_FILE"
sudo -u pos --preserve-env=PATH bash -lc "cd '$REPO_DIR' && DB_PATH='$DB_PATH' npm run seed"

say "Starting it as a service"
install -m 644 "$REPO_DIR/deploy/pos.service" /etc/systemd/system/pos.service
systemctl daemon-reload
systemctl enable --now pos >/dev/null

# --------------------------------------------------------------- the front

#
# `www.` too, but only if it is actually pointed here.
#
# Asking for a certificate covering a name that does not resolve fails the whole
# request, not just that name — so a helpful default of "always include www"
# would break the certificate for people who never set one up.
#
NAMES="$DOMAIN"
if [ "$DOMAIN" != "www.$DOMAIN" ] && getent ahostsv4 "www.$DOMAIN" >/dev/null 2>&1; then
  NAMES="$DOMAIN www.$DOMAIN"
fi

say "Putting nginx in front of it for $NAMES"
sed "s/server_name pos.example.com;/server_name $NAMES;/; s/pos.example.com/$DOMAIN/g" \
  "$REPO_DIR/deploy/nginx.conf" > /etc/nginx/sites-available/pos
ln -sf /etc/nginx/sites-available/pos /etc/nginx/sites-enabled/pos
rm -f /etc/nginx/sites-enabled/default
nginx -t >/dev/null 2>&1 || die "nginx did not accept the config; run 'nginx -t' to see why."
systemctl reload nginx

#
# The firewall, before anything tries to reach port 80 from outside.
#
# A cloud image with ufw switched on and only SSH allowed is the commonest
# reason a brand-new server answers perfectly to `curl localhost` and not at all
# to a browser — and the same closed port makes Let's Encrypt's check fail with
# a message about the domain rather than about the firewall.
#
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  say "Opening the firewall for web traffic"
  ufw allow 'Nginx Full' >/dev/null 2>&1 || ufw allow 80,443/tcp >/dev/null 2>&1 || true
fi

#
# HTTPS, if there is a real name pointed at this machine.
#
# Not optional in the long run: an installed app, a service worker and a saved
# password all need https, and a till on a plain http address cannot be
# installed on anybody's desktop.
#
# A bare IP address has no letters in it, and Let's Encrypt will not issue for
# one — so that is the first test, rather than trying to parse what a domain is.
#
if [ -z "$EMAIL" ]; then
  note "No email given, so no certificate. Re-run with one once DNS points here."
elif [[ "$DOMAIN" != *[a-zA-Z]* ]]; then
  note "$DOMAIN is an IP address, and there is no such thing as a certificate for one."
else
  #
  # Check the name arrives here before asking, rather than after.
  #
  # A failed Let's Encrypt validation counts against an hourly limit for that
  # hostname, so a script that cheerfully tries anyway can lock you out of
  # retrying for an hour over a DNS record that simply has not propagated. The
  # answer is to look first and say exactly what is wrong.
  #
  RESOLVED="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1 {print $1}')"
  PUBLIC="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"

  if [ -z "$RESOLVED" ]; then
    note "$DOMAIN does not resolve to anything yet."
    note "Add an A record for it pointing at this machine, wait a few minutes,"
    note "and run this same command again — it will pick up where it left off."
  elif [ -n "$PUBLIC" ] && [ "$RESOLVED" != "$PUBLIC" ]; then
    note "$DOMAIN currently points at $RESOLVED, and this machine is $PUBLIC."
    note "Fix the A record, wait for it to propagate, then run this again."
    note "Skipping the certificate rather than burning an attempt on a name that"
    note "would fail the check."
  else
    say "Getting an HTTPS certificate for $NAMES"
    apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
    CERT_ARGS=()
    for name in $NAMES; do CERT_ARGS+=(-d "$name"); done
    certbot --nginx "${CERT_ARGS[@]}" --non-interactive --agree-tos -m "$EMAIL" --redirect \
      || note "certbot did not finish. Run 'certbot --nginx -d $DOMAIN' to see why."
  fi
fi

# ------------------------------------------------------------ nightly copy

if ! crontab -u pos -l 2>/dev/null | grep -q backup.sh; then
  say "Scheduling a nightly backup"
  ( crontab -u pos -l 2>/dev/null; echo "0 2 * * * $REPO_DIR/deploy/backup.sh" ) | crontab -u pos -
fi

# ----------------------------------------------------------------- proof

say "Waiting for it to answer"
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:4000/api/health >/dev/null 2>&1; then
    printf '\n\033[1;32m==> The shop is live at https://%s\033[0m\n\n' "$DOMAIN"
    cat <<EOF
Three things to do now, in this order:

  1. Sign in as admin / admin123 and change both passwords.
     Demo credentials on a public address is an open shop.

  2. Copy ACCOUNT_SECRET out of $ENV_FILE to somewhere that is
     not this machine. A backup restored without it is a backup with every
     customer password gone for good.

  3. Set BACKUP_SYNC in $ENV_FILE so the nightly copy lands
     somewhere else. A backup on this disk is a second copy of this disk.

To take an update later:   cd $REPO_DIR && sudo ./deploy/deploy.sh
EOF
    exit 0
  fi
  sleep 1
done

systemctl status pos --no-pager --lines 30 || true
die "It did not come up. The log is above."
