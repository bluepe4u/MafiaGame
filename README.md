# Mafia

A web app for playing Mafia (Werewolf) with 4–12 players, each on their own computer (desktop-first; narrow screens still work). The app acts as the narrator; voice is handled outside the app (same room or a call).

## Run

```sh
npm install
npm start        # http://localhost:3000  (PORT / HOST env vars to change)
npm test
```

One player creates a room and shares the 4-letter code; others join with it. The creator is the host.

## Deploy on an Ubuntu VPS

On a fresh Ubuntu 22.04/24.04 server:

```sh
git clone https://github.com/bluepe4u/MafiaGame.git && cd MafiaGame
sudo ./deploy/install.sh mafia.example.com   # with your domain: HTTPS via Caddy (auto Let's Encrypt)
sudo ./deploy/install.sh example.com www.example.com   # several domains at once
# or
sudo ./deploy/install.sh                     # no domain: plain http://<server-ip>:3000
```

For the domain option, first point the domain's DNS A record at the server and make sure ports 80 and 443 are open.

The script installs Node.js 22 (if needed), copies the app to `/opt/mafia`, runs it as an unprivileged `mafia` user under systemd (auto-start on boot, restart on crash), and with a domain sets up Caddy as an HTTPS reverse proxy (WebSockets included) while the app itself only listens on localhost. It opens the ports in `ufw` if the firewall is active.

**Update:** `git pull && sudo ./deploy/install.sh <same args>`.
**Logs:** `journalctl -u mafia -f` · **Restart:** `sudo systemctl restart mafia`

Rooms are saved to disk (`/var/lib/mafia`, or `DATA_DIR`) about once a second and on shutdown, so a restart or update doesn't end games in progress: players' pages reconnect on their own and the game picks up where it was. Run a single instance — the app can't be load-balanced across processes.

**Backups:** the installer schedules a nightly backup (04:00) of `/var/lib/mafia` — accounts,
photos and saved rooms — as dated archives in `/var/backups/mafia`, kept 14 days. To also keep them
on Google Drive, run once from your own computer (needs `brew install rclone`; a browser opens for the
Google sign-in, and the server only gets access to the files it creates):

```sh
bash deploy/connect-gdrive.sh root@<server>
```

Back up now: `sudo /opt/mafia/deploy/backup.sh` · list / restore: `sudo /opt/mafia/deploy/restore.sh [latest | <file>]`
(the current data is moved aside, not deleted).

**Accounts are by invite.** On a fresh install (no accounts yet) the server writes a one-time
admin invite code to `/var/lib/mafia/admin-invite.txt`; register with it to become the admin, then
create invites for everyone else in the admin panel (Приглашения / Invites) — each is a link that
opens registration with the code filled in, optionally seating the newcomer at a table.

**Tables:** a group's permanent place (one link that never changes). Whoever starts the next game
from the table — Mafia or Monopoly — takes everyone at the table into the new room.

**Security:** the app sends standard browser protections (Content-Security-Policy, no framing,
nosniff, a strict referrer policy, HSTS over HTTPS) and rate-limits socket events per connection.

**Docker alternative:** `docker compose up -d --build` serves on port 3000 (put your own HTTPS proxy in front).

## Monopoly

The site also hosts Monopoly at `/monopoly/` (switch games from the menu on the logo). It shares
accounts, photos and decency status with Mafia, and keeps its own stats and leaderboard.

- Official rules for 2–8 players: the 40 squares in order with official prices and rents (street
  names from the Russian edition, amounts in ₽), 16 Chance and 16 Community Chest cards, salary on GO,
  doubles and three-doubles-to-jail, jail (bail, card, or doubles within three turns), buying or
  auctioning, colour sets with double rent, even building with the bank's 32 houses and 12 hotels,
  mortgages (+10% to lift), trades (10% interest on mortgaged property), debts and bankruptcy.
- Lobby settings: starting cash, turn timer (idle turns play themselves), double salary on GO,
  auctions, Free Parking jackpot, no rent in jail.
- `src/monopoly/` holds the board, the rules engine (no I/O, tested in `test/monopoly.test.js`,
  including a random-play test) and its Socket.IO namespace; rooms are saved to
  `monopoly-rooms.json` in the data directory.

## Rules as implemented

**Roles:** Citizen, Mafia, Cop, Doctor, Hooker (Cop/Doctor/Hooker are on the town side).
Default counts by player count (host can override in the lobby):

| Players | Mafia | Cop | Doctor | Hooker |
|---|---|---|---|---|
| 4 | 1 | 1 | – | – |
| 5 | 1 | 1 | 1 | – |
| 6–8 | 2 | 1 | 1 | – |
| 9–11 | 3 | 1 | 1 | 1 |
| 12 | 4 | 1 | 1 | 1 |

**Night** (game starts with Night 1; the host can turn off the Mafia kill on Night 1 so the Mafia only meet — other roles still act). All night roles pick a target at the same time; the night resolves once all have picked (or the host forces it):
1. **Hooker** visits a player — that player's night action is cancelled. Visiting any Mafia member cancels the Mafia kill for that night, even when several Mafia are alive.
2. **Mafia** each pick a target or "nobody" (they see each other's picks). Most votes wins; a tie or a "nobody" majority means no kill.
3. **Doctor** protects a player or nobody: never the same player two nights in a row, and themself only once per game (a blocked attempt still counts).
4. **Cop** learns whether their target is Mafia (private note).

**Day:**
- **Speeches** go in seat order. Each day starts with the next living player after the previous day's opener (Day 1 opener is random). Each speaker gets a timer; the speaker or host can end early, host can skip straight to voting.
- **Vote** is open (everyone sees votes). The player with the most votes is eliminated if they have strictly more than anyone else and more than the "skip" votes; otherwise nobody leaves.

**Host:** plays like everyone else. Host-only actions (start, remove player, force end night, end someone else's speech, skip to vote, close voting, back to lobby) sit in a separate panel and each needs a confirmation dialog plus a 1.5 s press-and-hold. Cancel is focused by default, Esc cancels, and the dialog closes itself if the game moves on.

**Win:** Town wins when no Mafia remain; Mafia wins when they are at least as many as the town.

## Structure

- `src/game.js` — game rules and state (no I/O), unit-tested in `test/`
- `server.js` — Express + Socket.IO; rooms are kept in memory
- `public/` — static client (vanilla JS, no build step); `public/common.js` holds what both games
  share: login, avatars and cosmetics, sounds and turn alerts, the profile window (stats for both
  games, wardrobe, account), the admin panel (who's online, rooms, decency, gifts, renames,
  password resets), gifts and the "back to my game" banner
- `public/i18n.js` — English and Russian translations. The server never sends display text: log entries and errors are `{ key, params }`, rendered in each player's chosen language (auto-detected from the browser, switchable in the top bar). To add a language, add a dictionary to `DICT` and an entry to `LANGS`.

Players reconnect automatically after a refresh (session token in `localStorage`).
