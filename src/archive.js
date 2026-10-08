'use strict';

// The game night archive: every finished game (both games), grouped into "nights" — games at
// the same table with less than a few hours between them. Saved to archive.json.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KEEP = 5000; // games; the oldest drop off
const NIGHT_GAP_MS = 5 * 60 * 60 * 1000; // a longer break starts a new night

class Archive {
  constructor(dir) {
    this.file = path.join(dir, 'archive.json');
    this.games = []; // oldest first
    this.saveTimer = null;
    try {
      this.games = JSON.parse(fs.readFileSync(this.file, 'utf8')).games || [];
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('Could not read the archive:', e.message);
    }
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ games: this.games }));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('Saving the archive failed:', e.message);
    }
  }

  save() {
    if (!this.saveTimer) this.saveTimer = setTimeout(() => this.saveNow(), 1000);
  }

  add(record) {
    // a game nobody with an account played isn't worth keeping
    if (!record.players.some(p => p.userId)) return null;
    const game = { id: crypto.randomBytes(6).toString('hex'), ...record };
    this.games.push(game);
    if (this.games.length > KEEP) this.games.splice(0, this.games.length - KEEP);
    this.save();
    return game;
  }

  // Games into nights, newest night first. Games are split by table (or "no table") and by gaps.
  static nights(games, limit = 30) {
    const nights = [];
    const open = new Map(); // table key -> the night being filled
    for (const g of [...games].sort((a, b) => (a.startedAt || a.endedAt) - (b.startedAt || b.endedAt))) {
      const key = g.tableId || '-';
      const start = g.startedAt || g.endedAt;
      let night = open.get(key);
      if (!night || start - night.end > NIGHT_GAP_MS) {
        night = { tableId: g.tableId || null, start, end: g.endedAt, games: [] };
        nights.push(night);
        open.set(key, night);
      }
      night.games.push(g);
      night.end = Math.max(night.end, g.endedAt);
    }
    return nights.reverse().slice(0, limit);
  }

  forTable(tableId, limit) {
    return Archive.nights(this.games.filter(g => g.tableId === tableId), limit);
  }

  forUser(userId, limit) {
    return Archive.nights(this.games.filter(g => g.players.some(p => p.userId === userId)), limit);
  }

  setInsights(id, insights) {
    const game = this.games.find(g => g.id === id);
    if (!game) return;
    game.insights = insights;
    this.save();
  }

  // Forget accounts that no longer exist (their games stay, without the link to the account).
  prune(userIds) {
    const alive = new Set(userIds);
    for (const g of this.games) for (const p of g.players) if (p.userId && !alive.has(p.userId)) p.userId = null;
    this.save();
  }
}

module.exports = { Archive, NIGHT_GAP_MS };
