#!/usr/bin/env bash
# Nightly backup of everything the site keeps (accounts, avatars, saved rooms): a dated
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
# the app writes its files atomically (tmp + rename), so a live copy is consistent
tar --exclude='*.tmp' -czf "$file.part" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")"
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
