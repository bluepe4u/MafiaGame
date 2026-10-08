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
echo "(If it doesn't, open the http://127.0.0.1:53682/... link printed below.)"
# rclone wants the options as unpadded URL-safe base64; its messages (and the sign-in link)
# stay on screen, and the token comes on stdout as one JSON line
opts="$(printf '{"scope":"drive.file"}' | base64 | tr -d '=\n' | tr '+/' '-_')"
token="$(rclone authorize drive "$opts" | grep -E '^\{.*\}$' | tail -1)"
[[ -n $token ]] || { echo "Didn't get a token from Google — try again." >&2; exit 1; }

# the token goes over ssh on stdin (never on a command line)
printf '%s\n' "$token" | ssh "$SERVER" 'set -e
  command -v rclone >/dev/null || { apt-get update -qq && apt-get install -y -qq rclone; }
  IFS= read -r tok
  rclone config create gdrive drive scope=drive.file token="$tok" --non-interactive >/dev/null
  echo "Connected. Making a first backup to check:"
  /opt/mafia/deploy/backup.sh'
