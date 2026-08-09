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
# Uses SQLite's own `.backup`, not `cp`. The database runs in WAL mode, so a
# plain copy taken while somebody is ringing up a sale can capture a file whose
# committed data is sitting in a journal that was not copied with it. `.backup`
# takes a consistent snapshot of a live database; `cp` takes a fast one that
# might not open.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DB="${DB_PATH:-/var/lib/pos/data.sqlite}"
DEST="${BACKUP_DIR:-/var/backups/pos}"
KEEP="${BACKUP_KEEP:-30}"

# Fall back to the development database so this can be tried out before the
# server exists.
[ -f "$DB" ] || DB="$REPO/server/data.sqlite"
[ -f "$DB" ] || { echo "No database found at $DB" >&2; exit 1; }

mkdir -p "$DEST"
STAMP="$(date +%Y-%m-%d-%H%M%S)"
OUT="$DEST/pos-$STAMP.sqlite"

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
echo "$(date '+%Y-%m-%d %H:%M:%S')  backed up to $OUT.gz ($(du -h "$OUT.gz" | cut -f1))"

# Keep the last N and no more, so a year of nightly copies cannot quietly fill
# the disk and take the shop down with it.
ls -1t "$DEST"/pos-*.sqlite.gz 2>/dev/null | tail -n "+$((KEEP + 1))" | xargs -r rm --

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
