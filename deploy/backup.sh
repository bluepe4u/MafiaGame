#!/usr/bin/env bash
# Nightly backup of everything the site keeps (the database, avatars): a dated
# .tar.gz in /var/backups/mafia, kept for 14 days, and a copy on Google Drive once the
# rclone remote "gdrive" is connected (see deploy/connect-gdrive.sh).
#
#   sudo /opt/mafia/deploy/backup.sh     # run one now (the systemd timer runs it every night)
set -euo pipefail

DATA_DIR="${DATA_DIR:-/var/lib/mafia}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/mafia}"
KEEP_DAYS="${KEEP_DAYS:-14}"
REMOTE="${REMOTE:-gdrive:bluepeau-backups}"

install -d -m 700 "$BACKUP_DIR"
file="$BACKUP_DIR/mafia-$(date +%F-%H%M).tar.gz"
# A copy of the data dir; the database is copied through SQLite itself (VACUUM INTO), which gives a
# consistent snapshot even while the app is writing. The live database files are left out.
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
name="$(basename "$DATA_DIR")"
mkdir -p "$stage/$name"
tar --exclude='*.tmp' --exclude='site.db' --exclude='site.db-*' -cf - -C "$DATA_DIR" . | tar -xf - -C "$stage/$name"
if [[ -f "$DATA_DIR/site.db" ]]; then
  node -e 'const { DatabaseSync } = require("node:sqlite"); new DatabaseSync(process.argv[1], { readOnly: true }).exec(`VACUUM INTO '"'"'${process.argv[2]}'"'"'`)' \
    "$DATA_DIR/site.db" "$stage/$name/site.db" 2>/dev/null
fi
tar -czf "$file.part" -C "$stage" "$name"
mv "$file.part" "$file"
chmod 600 "$file"
find "$BACKUP_DIR" -name 'mafia-*.tar.gz' -mtime +"$KEEP_DAYS" -delete
echo "saved $file ($(du -h "$file" | cut -f1))"

if command -v rclone >/dev/null && rclone listremotes 2>/dev/null | grep -qx "${REMOTE%%:*}:"; then
  rclone copy "$file" "$REMOTE"
  rclone delete "$REMOTE" --min-age "${KEEP_DAYS}d" --include 'mafia-*.tar.gz'
  echo "uploaded to $REMOTE"
else
  echo "Google Drive is not connected yet: the backup is kept on this server only"
fi
