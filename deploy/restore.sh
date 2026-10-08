#!/usr/bin/env bash
# Put a backup back in place (the current data is moved aside first, not deleted).
#
#   sudo /opt/mafia/deploy/restore.sh                       # list the backups
#   sudo /opt/mafia/deploy/restore.sh latest                # newest one on this server
#   sudo /opt/mafia/deploy/restore.sh mafia-2026-10-08-0400.tar.gz
#   (a file that's only on Google Drive: rclone copy gdrive:bluepeau-backups/<name> /var/backups/mafia/)
set -euo pipefail

DATA_DIR="${DATA_DIR:-/var/lib/mafia}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/mafia}"
SERVICE=mafia

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
if [[ $# -eq 0 ]]; then ls -lh "$BACKUP_DIR"/mafia-*.tar.gz; exit 0; fi
if [[ $1 == latest ]]; then file="$(ls -1t "$BACKUP_DIR"/mafia-*.tar.gz | head -1)"
elif [[ -f $1 ]]; then file="$1"
else file="$BACKUP_DIR/$1"; fi
[[ -f $file ]] || { echo "no such backup: $file" >&2; exit 1; }

echo "Restoring $file"
systemctl stop "$SERVICE"
aside="${DATA_DIR}.before-restore-$(date +%F-%H%M%S)"
[[ -d $DATA_DIR ]] && mv "$DATA_DIR" "$aside" && echo "current data moved to $aside"
tar -xzf "$file" -C "$(dirname "$DATA_DIR")"
chown -R "$SERVICE:$SERVICE" "$DATA_DIR"
systemctl start "$SERVICE"
echo "Done."
