# Mafia

A web app for playing Mafia (Werewolf) with 4–12 players, each on their own computer (desktop-first; narrow screens still work). The app acts as the narrator; voice is handled outside the app (same room or a call).

## Run

```sh
npm install
npm start        # http://localhost:3000  (PORT env var to change)
npm test
```

One player creates a room and shares the 4-letter code; others join with it. The creator is the host.

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
1. **Hooker** visits a player — that player's night action is cancelled.
2. **Mafia** each pick a target (they see each other's picks). Most votes wins; a tie means no kill.
3. **Doctor** protects a player: never the same player two nights in a row, and themself only once per game (a blocked attempt still counts).
4. **Cop** learns whether their target is Mafia (private note).

**Day:**
- **Speeches** go in seat order. Each day starts with the next living player after the previous day's opener (Day 1 opener is random). Each speaker gets a timer; the speaker or host can end early, host can skip straight to voting.
- **Vote** is open (everyone sees votes). The player with the most votes is eliminated if they have strictly more than anyone else and more than the "skip" votes; otherwise nobody leaves.

**Host:** plays like everyone else. Host-only actions (start, remove player, force end night, end someone else's speech, skip to vote, close voting, back to lobby) sit in a separate panel and each needs a confirmation dialog plus a 1.5 s press-and-hold. Cancel is focused by default, Esc cancels, and the dialog closes itself if the game moves on.

**Win:** Town wins when no Mafia remain; Mafia wins when they are at least as many as the town.

## Structure

- `src/game.js` — game rules and state (no I/O), unit-tested in `test/`
- `server.js` — Express + Socket.IO; rooms are kept in memory
- `public/` — static client (vanilla JS, no build step)

Players reconnect automatically after a refresh (session token in `localStorage`).
