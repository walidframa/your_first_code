#!/usr/bin/env bash
#
# Copy the database somewhere safe.
#
# The entire shop — every sale, every customer, what the drawer counted, the
# passwords held on customers' behalf — is one SQLite file. Losing it is not
# losing an app, it is losing the books.
#
# Run it from deploy.sh (which does, before touching anything), and from cron
# nightly:
#
#     0 2 * * * /srv/pos/deploy/backup.sh >> /var/log/pos-backup.log 2>&1
#
# With no DB_PATH set it backs up every database on the machine — the shop this
# server keeps for itself, and each rented shop in /var/lib/pos/tenants. Name
# one with DB_PATH to back up only that one.
#
# Uses SQLite's own `.backup`, not `cp`. The database runs in WAL mode, so a
# plain copy taken while somebody is ringing up a sale can capture a file whose
# committed data is sitting in a journal that was not copied with it. `.backup`
# takes a consistent snapshot of a live database; `cp` takes a fast one that
# might not open.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${BACKUP_DIR:-/var/backups/pos}"
KEEP="${BACKUP_KEEP:-30}"
TENANTS="${POS_TENANT_DATA:-/var/lib/pos/tenants}"

#
# One shop, or every shop on the machine.
#
# `DB_PATH` names one and only that one, which is what a tenant's own cron
# entry wants. With nothing named, this backs up the machine's own database
# *and* every rented shop beside it.
#
# That last part is the whole point of this rewrite. deploy.sh runs this before
# it touches anything and prints "Backing up the database", and on a machine
# that only rents shops out there is no /var/lib/pos/data.sqlite — so it fell
# through to the development database in the checkout, backed *that* up, and
# announced success. Every client's books were untouched by a step whose entire
# job is to have a copy of them, and the line on screen said otherwise. False
# comfort before a migration is worse than no backup at all, because it is the
# reason somebody presses on.
#
DBS=()
if [ -n "${DB_PATH:-}" ]; then
  [ -f "$DB_PATH" ] || { echo "No database at $DB_PATH" >&2; exit 1; }
  DBS+=("$DB_PATH")
else
  [ -f /var/lib/pos/data.sqlite ] && DBS+=(/var/lib/pos/data.sqlite)
  for db in "$TENANTS"/*.sqlite; do
    [ -f "$db" ] && DBS+=("$db")
  done
  # Nothing installed yet: fall back to the development database so this can be
  # tried out before the server exists.
  [ ${#DBS[@]} -gt 0 ] || { [ -f "$REPO/server/data.sqlite" ] && DBS+=("$REPO/server/data.sqlite"); }
fi

#
# Refused rather than reported as a success with nothing in it. A backup step
# that finds no database has not backed anything up, and the one moment that
# matters is the one where somebody reads this line and carries on.
#
[ ${#DBS[@]} -gt 0 ] || { echo "No database found to back up" >&2; exit 1; }

mkdir -p "$DEST"
STAMP="$(date +%Y-%m-%d-%H%M%S)"

for DB in "${DBS[@]}"; do
  # Named after the file it came from, so a directory holding six shops' copies
  # says which is which rather than needing them opened to find out.
  LABEL="$(basename "$DB" .sqlite)"
  OUT="$DEST/$LABEL-$STAMP.sqlite"

  #
  # SQLite's own `.backup`, not `cp`. The database runs in WAL mode, so a plain
  # copy taken while somebody is ringing up a sale can capture a file whose
  # committed data is sitting in a journal that was not copied with it.
  #
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DB" ".backup '$OUT'"
  else
    # No sqlite3 binary — Node has one built in, and it is already a dependency
    # of running this app at all.
    node -e "
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1], { readOnly: true });
      db.exec(\`VACUUM INTO '\${process.argv[2].replace(/'/g, \"''\")}'\`);
      db.close();
    " "$DB" "$OUT"
  fi

  gzip -f "$OUT"
  echo "$(date '+%Y-%m-%d %H:%M:%S')  $LABEL -> $OUT.gz ($(du -h "$OUT.gz" | cut -f1))"

  # Keep the last N of *this* shop and no more, so a year of nightly copies
  # cannot quietly fill the disk and take every shop on it down together. Per
  # shop rather than per directory: a machine with six of them would otherwise
  # keep five nights instead of thirty.
  ls -1t "$DEST/$LABEL-"*.sqlite.gz 2>/dev/null | tail -n "+$((KEEP + 1))" | xargs -r rm --

  # A backup on the same disk as the database is not a backup — it is a second
  # copy of the same disk failure. Point BACKUP_SYNC at somewhere else and this
  # will send it there.
  if [ -n "${BACKUP_SYNC:-}" ]; then
    echo "Copying to $BACKUP_SYNC"
    if command -v rclone >/dev/null 2>&1 && [[ "$BACKUP_SYNC" == *:* ]]; then
      rclone copy "$OUT.gz" "$BACKUP_SYNC"
    else
      rsync -a "$OUT.gz" "$BACKUP_SYNC"
    fi
  fi
done
