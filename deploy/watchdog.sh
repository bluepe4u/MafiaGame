#!/usr/bin/env bash
# Every two minutes (systemd timer): if the app stops answering /health — hung, not just crashed,
# which systemd already restarts — restart it. Two misses in a row, so a slow moment doesn't count.
set -uo pipefail

PORT="${PORT:-3000}"
SERVICE="${SERVICE:-mafia}"
check() { curl -fsS --max-time 5 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; }

check && exit 0
sleep 10
check && exit 0
echo "$SERVICE did not answer /health twice: restarting"
systemctl restart "$SERVICE"
