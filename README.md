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

Rooms are saved in the database (`/var/lib/mafia`, or `DATA_DIR`) about once a second and on shutdown, so a restart or update doesn't end games in progress: players' pages reconnect on their own and the game picks up where it was. Run a single instance — the app can't be load-balanced across processes.

**Backups:** the installer schedules a nightly backup (04:00) of `/var/lib/mafia` — accounts,
photos and saved rooms — as dated archives in `/var/backups/mafia`, kept 14 days. To also keep them
on Google Drive, run once from your own computer (needs `brew install rclone`; a browser opens for the
Google sign-in, and the server only gets access to the files it creates):

```sh
bash deploy/connect-gdrive.sh root@<server>
```

**Watchdog:** systemd restarts the app if it crashes; a timer also checks `/health` every two minutes
and restarts it if it hangs (`deploy/watchdog.sh`).

**Stats and errors:** the admin panel's Stats tab shows page views and distinct visitors per day,
where visitors came from, games started and script errors from the pages, all kept on the server
(`src/stats.js`): no cookies, no tracking script, no third parties; visitors are counted with a
daily-salted hash and IPs are never stored.

Old game addresses (`/monopoly/`, `/citadels/`, `/spyfall/`) redirect to the new ones.

**Blog and search:** articles live at `/blog/` (admin panel → Blog: Markdown, a language, a translation
key that links the English and Russian versions, the game the article leads to, pictures). Pages are
plain server-rendered HTML with canonical and hreflang links, Open Graph and BlogPosting data, and an
RSS feed at `/blog/rss.xml`. `/sitemap.xml` and `/llms.txt` (a summary for AI assistants) are built from
the pages and the published articles. Articles in `content/blog/*.md` (front matter + Markdown) are
added once on start and then edited in the admin panel like any other. Set `INDEXNOW_KEY` (any 8–128
letters/digits) in `/etc/mafia.env` to have Bing, Yandex and others notified the moment an article is
published. To see search traffic, verify the domain in Google Search Console and Yandex Webmaster
(a DNS TXT record) and submit `https://bluepeau.club/sitemap.xml` there.

**Fonts** are served from the site itself (`public/fonts`, SIL Open Font License), each with Latin
and Cyrillic: Geist and Geist Mono for text, Oranienbaum for headings (Cormorant for their italics),
Rubik Wet Paint for the Halloween theme. Nothing loads from Google.

Back up now: `sudo /opt/mafia/deploy/backup.sh` · list / restore: `sudo /opt/mafia/deploy/restore.sh [latest | <file>]`
(the current data is moved aside, not deleted).

**Accounts:** username, email and password. Anyone can sign up while "Open sign-up" is on in the
admin panel (Функции / Features); turned off, registration needs an invite again. Accounts made
before emails existed keep working without one and can add it in the profile. On a fresh install
(no accounts yet) the server writes a one-time admin invite code to `/var/lib/mafia/admin-invite.txt`;
register with it to become the admin (the email is optional for that one). Invites still work as
links that seat a newcomer at a table.

**Email** (confirming addresses, password reset links): add an SMTP account from any provider to
`/etc/mafia.env`, then `systemctl restart mafia`:

```sh
SMTP_URL=smtps://user:password@smtp.example.com:465
MAIL_FROM=bluepeau.club <hello@bluepeau.club>
```

Without `SMTP_URL` the messages are printed to the log instead (`journalctl -u mafia`). Reset links
work once, for 30 minutes; `PUBLIC_URL` (set by the installer) is the address the links point to.
Signing up, logging in and reset requests are rate-limited per address. Old recovery codes keep working.

**Storage:** everything lives in one SQLite database, `/var/lib/mafia/site.db` (Node's built-in
`node:sqlite`, `src/db.js`): each record is one row, and saving writes only what changed. On the
first start after the update the old JSON files are imported once and renamed to `*.json.migrated`.
**Redis** (installed by the script, localhost only, `REDIS_URL`) keeps rate limits and the one-time
email links, and backs the Socket.IO adapter; without it the app keeps them in memory. Games in
progress still live in the single app process.

**Tables:** a group's permanent place (one link that never changes). Private by default (only people
with the link); the owner can make a table public, and then it's listed for everyone to find and join. Whoever starts the next game
from the table — in any of the games — takes everyone at the table into the new room.

**Voice chat:** push-to-talk (or an open mic) straight between the browsers in a room (WebRTC).
In Mafia the Mafia hear each other at night, and players who are out talk only among themselves —
each phone simply doesn't send audio to anyone not allowed to hear it. The installer sets up a
TURN relay (coturn, ports 3478 and 49160–49260/udp) for networks that block direct connections;
its secret lives in `/etc/mafia.env`.

**Transcripts and AI notes (optional):** with "Voice transcripts" on in a Mafia lobby, each player's
browser records only its own push-to-talk speech; the server transcribes the clips with Groq's
Whisper (`GROQ_API_KEY`; the free tier is enough for a table: clips are merged and paced under its
limits) or OpenAI (`OPENAI_API_KEY`, also the backup), and drops the audio. `STT_URL` points at any
OpenAI-compatible endpoint instead (e.g. a self-hosted Whisper). Without a key, the browser's own
speech recognition is used. With `ANTHROPIC_API_KEY`, after each day's vote the AI writes a round
note from public speech only (no roles): who accused / defended whom, who seems to play together,
suspects, quotes — shown live in the Rounds tab. After the game it reads everything (roles, Mafia
night talk) for the final analysis: each round in hindsight, who really played together, MVP, best
bluff. "Voting together" pairs come straight from the votes. Keys go in `/etc/mafia.env`, then
`systemctl restart mafia` (Claude Haiku by default; `INSIGHTS_MODEL`, `INSIGHTS_LANG` override).

**Security:** the app sends standard browser protections (Content-Security-Policy, no framing,
nosniff, a strict referrer policy, HSTS over HTTPS) and rate-limits socket events per connection.

**Docker alternative:** `docker compose up -d --build` serves on port 3000 (put your own HTTPS proxy in front).

**Streamer mode (Mafia, gear menu):** the game window looks the same whatever your role — no role
card, no teammates, no night buttons or picks, no private results, no Mafia or graveyard chat, the
night blurred, no "your night move" alerts, room codes masked and kept out of the address bar.
Everything secret is in a separate "secret window" (role, night moves, results, secret chats, and
where the Mafia's night voices play) that you keep out of the stream capture.

## Магнат (Tycoon)

The site also hosts Tycoon, a property-trading board game, at `/tycoon/` (switch games from the menu on the logo). It shares
accounts, photos and decency status with Mafia, and keeps its own stats and leaderboard.

- Official rules for 2–8 players: the 40 squares in order with official prices and rents (street
  names from the Russian edition, amounts in ₽), 16 Chance and 16 Community Chest cards, salary on GO,
  doubles and three-doubles-to-jail, jail (bail, card, or doubles within three turns), buying or
  auctioning, colour sets with double rent, even building with the bank's 32 houses and 12 hotels,
  mortgages (+10% to lift), trades (10% interest on mortgaged property), debts and bankruptcy.
- Lobby settings: starting cash, turn timer (idle turns play themselves), double salary on GO,
  auctions, Free Parking jackpot, no rent in jail.
- `src/monopoly/` holds the board, the rules engine (no I/O, tested in `test/monopoly.test.js`,
  including a random-play test) and its Socket.IO namespace; rooms are saved in the database.

## Шпион (Find the spy)

`/spy/` («Шпион») — 3–12 players. Everyone but the spy gets the same location and one of its
6 roles; the spy sees only the list. 95 locations of our own in 5 sets (Classic 30, Russia 20,
Adventure 15, City 15, Travel 15), in Russian and English; the host picks the sets and how many
locations are in play (10–60, drawn at random for the whole game). The app keeps whose turn
it is to ask (no asking straight back), the round clock, accusations (once per player per round;
unanimous or majority, set in the lobby), the spy's guess, the final vote when time runs out, and
points over several rounds (spy 2/4, town 1, the successful accuser 2). Your card stays hidden until
you hold it. Same accounts, tables, voice chat, stats (profile tab), archive and admin tools as the
other games; `src/spyfall/` holds the locations, the engine (no I/O, tested) and its namespace.

## Королевства (Kingdoms)

`/kingdoms/` — a city-building card game with secret characters, 3–8 players, with the beginner set of nine characters from the
house rules sheet: Witch, Thief, Magician, King, Abbot, Merchant, Architect, Diplomat, Queen.

- The draft goes round from the crown, with face-up discards by player count (5 → 2, 6 → 1,
  7–8 → 0, never the King); the last chooser also sees the face-down card. With 3 players everyone
  plays two characters a round; the Queen needs 5+.
- A turn: gather first (2 gold, or draw 2 and keep 1), then the ability, income once (before or
  after building; added at the end of the turn if forgotten) and one build (Architect: three).
  The bewitched character only gathers, then the Witch plays its turn with her own cards, gold and
  city; a bewitched or killed King still gets the crown. The game ends after the round in which a
  city reaches 7 districts; ties go to the higher character of the last round.
- 54 ordinary districts and 29 unique (purple) ones with their 2016 abilities, 14 of them shuffled
  into each game by default.
- Lobby settings (remembered by a table like the other games' house rules): the classic Assassin,
  Bishop and Warlord instead of the Witch, Abbot and Diplomat, no 9th character, districts to end,
  starting gold and cards, gold and cards when gathering, the end-of-game bonuses, which unique
  districts can come up and how many, the King among the face-up discards, turn and draft timers
  (idle turns take gold and end), voice chat. A player who leaves keeps their city and the game
  plays their turns.
- Same accounts, tables, voice chat, stats (profile tab), leaderboard, archive and admin tools as
  the other games; `src/citadels/` holds the cards, the engine (no I/O, tested in
  `test/citadels.test.js`, including random games played to the end) and its namespace; rooms are
  saved in the database.

## Покер (Texas hold'em)

`/poker/` — no-limit hold'em for 2–9 players, for chips only (no money, no deposits).

- Everyone starts with 500 chips, blinds 5/10 (the lobby changes the stack, blinds, ante, blinds
  going up every N hands, the turn clock, rebuys, late seats, equity in all-ins, the rabbit hunt).
- Proper betting: the button and blinds (heads up the button is the small blind), the big blind's
  option, raises of at least the last raise, short all-ins that don't reopen the betting, uncalled
  bets returned, side pots, odd chips left of the button.
- The table highlights the combination itself (a pair is two cards, no kickers) and names it; the
  winner's at the showdown. No odds or hints during the hand — reading them is the game. A hand-ranks
  cheat sheet sits in the side panel (first tab for new players).
- The table is built once and changed in place, so cards are dealt one by one, flip in 3D, the
  flop spreads out, chips slide to the bets, the pot and the winner, and stacks count.
- All-in: the hands turn over and the board is dealt slowly (equity on the table only if the host
  turns it on); the river comes as a squeeze. Each hand's equity street by street is still worked
  out for the hand history and the story of the hand: the deciding card glows, suckout, saved by
  the river, runner-runner, bad beat, cooler, split pot. Hands that ended early can show what the
  board would have been; anyone may show their cards.
- Playing for (a table setting): **site chips** — the fun part: every account has a wallet of site
  chips (500 to start, a daily bonus for coming by that grows with the streak, achievements in poker
  and the other games); the buy-in comes from the wallet and the stack goes back to it. Or
  **USDT**: everyone agrees to the buy-in by pressing Ready and needs a USDT address (TRC-20,
  ERC-20 or BEP-20) in their wallet; after the session the site works out the fewest transfers that
  settle it, to the cent, and "Settlements" shows each payer the receiver's address; the payer pays
  wallet to wallet and pastes the transaction hash (linked to the explorer), the receiver confirms.
  The site never holds money, and site chips and USDT never convert into each other
  (`src/pledges.js`, `src/achievements.js`).
- Nothing about USDT is enforced: the site only shows who owes whom and lets players mark payments.
- GGPoker-style controls: presets (2.5/3/4 BB, ⅓ ½ ¾ pot, pot, max), a slider, pre-actions
  (check/fold, call, call any), F/C/R keys, amounts in chips or big blinds, a four-colour deck,
  drawn poker stickers instead of emoji, the hand history with each street's equity.
- The host pauses or ends the session; places go by chips won. Stats (VPIP, PFR, showdowns, biggest
  pot, best hand) in the profile, a leaderboard, the archive. `src/poker/hand.js` is the hand
  evaluator and equity calculator, shared with the browser; `src/poker/game.js` the engine (no I/O,
  tested in `test/poker.test.js`, including random sessions where the chips must add up).
- **Provably fair deck** (`src/poker/fair.js`): before every hand the table shows sha256 of a secret
  server seed (the first one already in the lobby). Each player's browser then sends a fresh random
  seed of its own, so the server can't have chosen the deck in advance. The deck is a Fisher-Yates
  shuffle fed by HMAC-SHA256(server seed, "client seeds:game:hand:counter"), with rejection sampling.
  When the session ends the server seeds are revealed: "Check the deal" recomputes every deck in the
  browser (`public/poker/fair.js`) and compares it with what that browser saw during the game
  (commitments, its own seed, its cards and the board); the log downloads as JSON and can be
  checked by anyone at `/poker/fair.html`. Seeds stay secret until the end, since they would
  reveal folded hands. Poker asks once per browser to confirm the player is 18+.

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
- `public/` — static client (vanilla JS, no build step); `public/common.js` holds what all the games
  share: login, avatars and cosmetics, sounds and turn alerts, the profile window (stats for every
  game, wardrobe, account), the admin panel (who's online, rooms, decency, gifts, renames,
  password resets), gifts and the "back to my game" banner
- `public/i18n.js` — English and Russian translations. The server never sends display text: log entries and errors are `{ key, params }`, rendered in each player's chosen language (auto-detected from the browser, switchable in the top bar). To add a language, add a dictionary to `DICT` and an entry to `LANGS`.

Players reconnect automatically after a refresh (session token in `localStorage`).
