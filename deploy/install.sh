#!/usr/bin/env bash
# Install or update the Mafia game on an Ubuntu VPS (22.04 / 24.04).
#
#   sudo ./deploy/install.sh                  # serve on http://<server-ip>:3000
#   sudo ./deploy/install.sh mafia.example.com  # serve on https://mafia.example.com (auto TLS via Caddy)
#   sudo ./deploy/install.sh example.com www.example.com  # several domains: the first is the main one
#
# Run it from a checkout of the repo. Re-running after `git pull` updates the app in place.
# Env overrides: PORT (default 3000), APP_DIR (default /opt/mafia), NODE_MAJOR (default 22).
set -euo pipefail

DOMAINS=("$@")
DOMAIN="${1:-}"
PORT="${PORT:-3000}"
APP_DIR="${APP_DIR:-/opt/mafia}"
APP_USER="mafia"
SERVICE="mafia"
NODE_MAJOR="${NODE_MAJOR:-22}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mError: %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root (sudo $0 $*)"
[[ -f "$SRC_DIR/server.js" ]] || die "can't find server.js in $SRC_DIR — run this from the repo checkout"
command -v apt-get >/dev/null || die "this script expects Ubuntu/Debian (apt-get)"
for d in "${DOMAINS[@]}"; do [[ "$d" =~ ^[A-Za-z0-9.-]+$ ]] || die "invalid domain: $d"; done
SITE_ADDRESSES="$(IFS=,; echo "${DOMAINS[*]}" | sed 's/,/, /g')"

export DEBIAN_FRONTEND=noninteractive

# --- Node.js -----------------------------------------------------------------
current_major() { command -v node >/dev/null && node -p 'process.versions.node.split(".")[0]' || echo 0; }
if (( $(current_major) < 20 )); then
  log "Installing Node.js ${NODE_MAJOR}.x (NodeSource)"
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
else
  log "Node.js $(node -v) already installed"
fi
NODE_BIN="$(command -v node)"
NPM_BIN="$(command -v npm)"

# --- App files ---------------------------------------------------------------
log "Installing app to $APP_DIR"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR"
if [[ "$SRC_DIR" != "$APP_DIR" ]]; then
  # copy only what the app needs at runtime
  rm -rf "$APP_DIR/public" "$APP_DIR/src" "$APP_DIR/deploy"
  cp -r "$SRC_DIR/public" "$SRC_DIR/src" "$SRC_DIR/deploy" "$APP_DIR/"
  cp "$SRC_DIR/server.js" "$SRC_DIR/package.json" "$SRC_DIR/package-lock.json" "$APP_DIR/"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
( cd "$APP_DIR" && runuser -u "$APP_USER" -- env HOME="$APP_DIR" "$NPM_BIN" ci --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error )

# --- Secrets (not in git): /etc/mafia.env --------------------------------------
# TURN_SECRET / TURN_HOST: the voice relay. Add ANTHROPIC_API_KEY=... here yourself to turn on
# the AI read of Mafia games with voice transcripts (then: systemctl restart mafia).
ENV_FILE="/etc/${SERVICE}.env"
if [[ ! -f $ENV_FILE ]]; then
  ( umask 077; printf '# Secrets for the %s service (kept out of git)\n' "$SERVICE" > "$ENV_FILE" )
fi
grep -q '^TURN_SECRET=' "$ENV_FILE" || echo "TURN_SECRET=$(openssl rand -hex 32)" >> "$ENV_FILE"
if [[ -n "$DOMAIN" ]] && ! grep -q '^TURN_HOST=' "$ENV_FILE"; then echo "TURN_HOST=$DOMAIN" >> "$ENV_FILE"; fi
chmod 600 "$ENV_FILE"

# --- systemd service ---------------------------------------------------------
# Behind Caddy the app only listens on localhost; without a domain it is exposed directly.
if [[ -n "$DOMAIN" ]]; then BIND=127.0.0.1; else BIND=0.0.0.0; fi
log "Writing systemd service ($SERVICE) on $BIND:$PORT"
cat > "/etc/systemd/system/${SERVICE}.service" <<EOF
[Unit]
Description=Mafia game server
After=network.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=HOST=$BIND
Environment=DATA_DIR=/var/lib/$SERVICE
EnvironmentFile=-$ENV_FILE
StateDirectory=$SERVICE
ExecStart=$NODE_BIN $APP_DIR/server.js
Restart=on-failure
RestartSec=2
# hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"

# --- Nightly backup ------------------------------------------------------------
# A dated archive of /var/lib/$SERVICE every night at 04:00, kept 14 days, and copied to
# Google Drive once connected (deploy/connect-gdrive.sh, run from your own computer).
log "Scheduling the nightly backup"
command -v rclone >/dev/null || apt-get install -y -qq rclone >/dev/null || echo "(rclone not installed: backups stay on this server)"
cat > "/etc/systemd/system/${SERVICE}-backup.service" <<EOF
[Unit]
Description=Back up the $SERVICE game data

[Service]
Type=oneshot
Environment=DATA_DIR=/var/lib/$SERVICE
ExecStart=$APP_DIR/deploy/backup.sh
EOF
cat > "/etc/systemd/system/${SERVICE}-backup.timer" <<EOF
[Unit]
Description=Nightly backup of the $SERVICE game data

[Timer]
OnCalendar=*-*-* 04:00
RandomizedDelaySec=10min
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now "${SERVICE}-backup.timer" >/dev/null

# --- Caddy (HTTPS) -----------------------------------------------------------
if [[ -n "$DOMAIN" ]]; then
  if ! command -v caddy >/dev/null; then
    log "Installing Caddy"
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg
    curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
    apt-get install -y -qq caddy
  fi
  log "Configuring Caddy for https://$SITE_ADDRESSES"
  install -d /etc/caddy/conf.d
  cat > /etc/caddy/conf.d/mafia.caddy <<EOF
$SITE_ADDRESSES {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
}
EOF
  CADDYFILE=/etc/caddy/Caddyfile
  if [[ ! -f $CADDYFILE ]] || grep -q '/usr/share/caddy' "$CADDYFILE"; then
    # stock Caddyfile (placeholder page on :80) — replace it so it doesn't grab port 80
    [[ -f $CADDYFILE ]] && cp "$CADDYFILE" "$CADDYFILE.orig"
    echo 'import /etc/caddy/conf.d/*.caddy' > "$CADDYFILE"
  elif ! grep -q 'import /etc/caddy/conf.d/\*.caddy' "$CADDYFILE"; then
    # existing custom config: keep it and add our site alongside
    printf '\nimport /etc/caddy/conf.d/*.caddy\n' >> "$CADDYFILE"
  fi
  if ! out="$(caddy validate --config "$CADDYFILE" --adapter caddyfile 2>&1)"; then
    echo "$out" >&2
    die "Caddy config is invalid — see above"
  fi
  systemctl enable caddy >/dev/null
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
fi

# --- Voice relay (TURN) ---------------------------------------------------------
# Voice chat is browser to browser; some home and mobile networks need a relay in between.
if [[ -n "$DOMAIN" ]]; then
  log "Configuring the voice relay (coturn)"
  command -v turnserver >/dev/null || apt-get install -y -qq coturn >/dev/null
  TURN_SECRET="$(grep '^TURN_SECRET=' "$ENV_FILE" | cut -d= -f2)"
  cat > /etc/turnserver.conf <<EOF
# Written by deploy/install.sh: a TURN relay for the game's voice chat only
listening-port=3478
fingerprint
use-auth-secret
static-auth-secret=$TURN_SECRET
realm=$DOMAIN
min-port=49160
max-port=49260
total-quota=200
user-quota=12
no-multicast-peers
no-cli
no-tlsv1
no-tlsv1_1
# never relay into private networks (or this server itself)
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
syslog
EOF
  chmod 640 /etc/turnserver.conf
  chgrp turnserver /etc/turnserver.conf 2>/dev/null || true
  [[ -f /etc/default/coturn ]] && sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
  systemctl enable coturn >/dev/null 2>&1
  systemctl restart coturn
fi

# --- Firewall ----------------------------------------------------------------
if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
  log "Opening firewall ports (ufw)"
  if [[ -n "$DOMAIN" ]]; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
    ufw allow 3478/udp >/dev/null; ufw allow 3478/tcp >/dev/null; ufw allow 49160:49260/udp >/dev/null
  else ufw allow "$PORT/tcp" >/dev/null; fi
fi

# --- Check -------------------------------------------------------------------
log "Waiting for the app to come up"
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    if [[ -n "$DOMAIN" ]]; then
      URL="https://$DOMAIN"
      echo "Make sure the DNS A records for $SITE_ADDRESSES point to this server; Caddy fetches certificates on first request."
    else
      URL="http://$(hostname -I | awk '{print $1}'):$PORT"
    fi
    log "Done. Mafia is running at $URL"
    echo "Logs:    journalctl -u $SERVICE -f"
    echo "Restart: systemctl restart $SERVICE   (games in progress are saved and resume)"
    echo "Backups: $APP_DIR/deploy/backup.sh (now) · deploy/restore.sh (put one back) · nightly at 04:00"
    exit 0
  fi
  sleep 0.5
done
systemctl status "$SERVICE" --no-pager || true
die "the app did not answer on port $PORT — see: journalctl -u $SERVICE -n 50"
