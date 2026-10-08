#!/usr/bin/env bash
# One-time: send the server's nightly backups to your Google Drive.
# Run it on your own computer (it opens a browser for the Google sign-in):
#
#   bash deploy/connect-gdrive.sh root@178.238.234.113
#
# Access is limited to files rclone itself creates (Drive scope "drive.file"): the backups
# land in a "bluepeau-backups" folder and nothing else in your Drive is visible to the server.
set -euo pipefail
SERVER="${1:?usage: bash deploy/connect-gdrive.sh root@<server>}"
command -v rclone >/dev/null || { echo "rclone is needed here first:  brew install rclone" >&2; exit 1; }

echo "A browser window will open: sign in to Google and press Allow."
# rclone prints the token as one JSON line between "--->" and "<---End paste"
token="$(rclone authorize drive "$(printf '{"scope":"drive.file"}' | base64)" 2>/dev/null | grep -E '^\{.*\}$' | tail -1)"
[[ -n $token ]] || { echo "Didn't get a token from Google — try again." >&2; exit 1; }

# the token goes over ssh on stdin (never on a command line)
printf '%s\n' "$token" | ssh "$SERVER" 'set -e
  command -v rclone >/dev/null || { apt-get update -qq && apt-get install -y -qq rclone; }
  IFS= read -r tok
  rclone config create gdrive drive scope=drive.file token="$tok" --non-interactive >/dev/null
  echo "Connected. Making a first backup to check:"
  /opt/mafia/deploy/backup.sh'
