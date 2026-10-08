'use strict';

// Accounts for a small group of friends: username + password, no email.
// Everything lives in one JSON file; avatars are image files next to it.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { GameError } = require('./game');
const { ITEMS, EQUIP_SLOTS } = require('./items');

const USERNAME_RE = /^[\p{L}\p{N} _.-]{2,20}$/u;
const MIN_PASSWORD = 4;
const MAX_AVATAR_BYTES = 1024 * 1024;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const RATING_LOG_KEEP = 5000;
const LOWEST_SCORE = -10; // the bottom decency status starts here

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}

function passwordMatches(password, user) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
}

// Accept only real JPEG / PNG / WebP data, recognised by their first bytes.
function imageType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

const RECENT_KEEP = 20;
const emptyStats = () => ({
  games: 0, wins: 0, survived: 0, mafiaGames: 0, mafiaWins: 0, townGames: 0, townWins: 0, roles: {}, roleWins: {},
  // detailed numbers, recorded since the player page was added (detailedGames counts those games)
  detailedGames: 0, votes: 0, townVotes: 0, votesOnMafia: 0, votesMatched: 0, kills: 0, saves: 0, copHits: 0, messages: 0,
  // ballots include "skip"; decisive = votes without which the day's result would have changed
  ballots: 0, decisive: 0, mafiaVotedOut: 0,
  streak: 0, bestStreak: 0, recent: [],
});

class UserStore {
  constructor(dir) {
    this.file = path.join(dir, 'users.json');
    this.avatarDir = path.join(dir, 'avatars');
    this.users = {}; // id -> { id, username, salt, hash, avatar, likes, dislikes, createdAt }
    this.sessions = {}; // sha256(token) -> userId
    this.ratingLog = []; // [{ from, to, value, at }]: who rated whom, for the admin
    this.failures = new Map(); // username (lowercase) -> [timestamps]
    this.saveTimer = null;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.users = data.users || {};
      this.sessions = data.sessions || {};
      this.ratingLog = data.ratingLog || [];
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('Could not read users:', e.message);
    }
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ users: this.users, sessions: this.sessions, ratingLog: this.ratingLog }));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('Saving users failed:', e.message);
    }
  }

  save() {
    if (!this.saveTimer) this.saveTimer = setTimeout(() => this.saveNow(), 500);
  }

  byName(username) {
    const lower = String(username).toLowerCase();
    return Object.values(this.users).find(u => u.username.toLowerCase() === lower);
  }

  newSession(user) {
    const token = crypto.randomBytes(32).toString('hex');
    this.sessions[sha256(token)] = user.id;
    this.save();
    return token;
  }

  register(username, password) {
    username = String(username || '').trim().replace(/\s+/g, ' ');
    password = String(password || '');
    if (!USERNAME_RE.test(username)) throw new GameError('err.usernameInvalid', { min: 2, max: 20 });
    if (password.length < MIN_PASSWORD) throw new GameError('err.passwordShort', { min: MIN_PASSWORD });
    if (this.byName(username)) throw new GameError('err.usernameTaken');
    const user = { id: crypto.randomBytes(8).toString('hex'), username, ...hashPassword(password), avatar: null, likes: 0, dislikes: 0, createdAt: Date.now() };
    this.users[user.id] = user;
    return { user, token: this.newSession(user) };
  }

  login(username, password) {
    const key = String(username || '').trim().toLowerCase();
    const now = Date.now();
    const recent = (this.failures.get(key) || []).filter(t => now - t < LOGIN_WINDOW_MS);
    if (recent.length >= LOGIN_MAX_FAILURES) throw new GameError('err.tooManyLogins');
    const user = this.byName(key);
    if (!user || !passwordMatches(String(password || ''), user)) {
      this.failures.set(key, [...recent, now]);
      throw new GameError('err.badLogin');
    }
    this.failures.delete(key);
    return { user, token: this.newSession(user) };
  }

  logout(token) {
    delete this.sessions[sha256(String(token || ''))];
    this.save();
  }

  byToken(token) {
    if (!token) return null;
    return this.users[this.sessions[sha256(String(token))]] || null;
  }

  changePassword(user, oldPassword, newPassword) {
    if (!passwordMatches(String(oldPassword || ''), user)) throw new GameError('err.badPassword');
    if (String(newPassword || '').length < MIN_PASSWORD) throw new GameError('err.passwordShort', { min: MIN_PASSWORD });
    Object.assign(user, hashPassword(String(newPassword)));
    // log out everywhere else
    for (const [h, id] of Object.entries(this.sessions)) if (id === user.id) delete this.sessions[h];
    return this.newSession(user);
  }

  setAvatar(user, buf) {
    if (buf.length > MAX_AVATAR_BYTES) throw new GameError('err.avatarTooBig');
    const ext = imageType(buf);
    if (!ext) throw new GameError('err.avatarType');
    fs.mkdirSync(this.avatarDir, { recursive: true });
    const file = `${user.id}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(this.avatarDir, file), buf);
    if (user.avatar) fs.rm(path.join(this.avatarDir, path.basename(user.avatar)), () => {});
    user.avatar = file;
    this.save();
  }

  // Apply a change of one player's rating of another: old/new are -1, 0 or 1.
  applyRating(targetId, oldValue, newValue, fromId = null) {
    const u = this.users[targetId];
    if (!u) return;
    u.likes += (newValue === 1) - (oldValue === 1);
    u.dislikes += (newValue === -1) - (oldValue === -1);
    if (fromId) {
      this.ratingLog.push({ from: fromId, to: targetId, value: newValue, at: Date.now() });
      if (this.ratingLog.length > RATING_LOG_KEEP) this.ratingLog.splice(0, this.ratingLog.length - RATING_LOG_KEEP);
    }
    this.save();
  }

  // Who currently dislikes this user: each rater's latest rating per game counts, as logged.
  dislikedBy(userId) {
    const latest = new Map();
    for (const r of this.ratingLog) if (r.to === userId) latest.set(r.from, r.value);
    return [...latest].filter(([, v]) => v === -1).map(([from]) => this.users[from]?.username).filter(Boolean);
  }

  // ---------- admin ----------
  adminView(user) {
    return {
      ...this.publicProfile(user),
      rawLikes: user.likes, rawDislikes: user.dislikes,
      bonus: user.bonus || 0, dislikeShield: !!user.dislikeShield, admin: !!user.admin,
      dislikedBy: this.dislikedBy(user.id),
    };
  }

  setKarma(user, { bonus, dislikeShield, lowest }) {
    if (bonus !== undefined) user.bonus = Math.max(-1000, Math.min(1000, Math.round(Number(bonus) || 0)));
    if (dislikeShield !== undefined) user.dislikeShield = !!dislikeShield;
    // put the user right at the start of the lowest status, whatever their ratings
    if (lowest) user.bonus = LOWEST_SCORE - (this.publicProfile({ ...user, bonus: 0 }).score);
    this.save();
  }

  gift(user, itemId) {
    if (!ITEMS[itemId]) throw new GameError('err.invalidTarget');
    user.inventory ||= [];
    if (user.inventory.includes(itemId)) return;
    user.inventory.push(itemId);
    (user.gifts ||= []).push(itemId); // shown with an unboxing the next time they look
    this.save();
  }

  takeBack(user, itemId) {
    user.inventory = (user.inventory || []).filter(i => i !== itemId);
    user.gifts = (user.gifts || []).filter(i => i !== itemId);
    for (const slot of EQUIP_SLOTS) if (user.equipped?.[slot] === itemId) delete user.equipped[slot];
    this.save();
  }

  equip(user, slot, itemId) {
    if (!EQUIP_SLOTS.includes(slot)) throw new GameError('err.invalidTarget');
    user.equipped ||= {};
    if (!itemId) delete user.equipped[slot];
    else {
      if (!(user.inventory || []).includes(itemId) || ITEMS[itemId]?.slot !== slot) throw new GameError('err.invalidTarget');
      user.equipped[slot] = itemId;
    }
    this.save();
  }

  giftsSeen(user) {
    user.gifts = [];
    this.save();
  }

  // One finished game: results from Room.onGameEnd.
  recordGame(results) {
    for (const r of results) {
      const u = this.users[r.userId];
      if (!u) continue;
      const s = (u.stats = { ...emptyStats(), ...u.stats });
      s.games += 1;
      s.wins += r.won ? 1 : 0;
      s.survived += r.survived ? 1 : 0;
      s[r.team + 'Games'] += 1;
      s[r.team + 'Wins'] += r.won ? 1 : 0;
      s.roles[r.role] = (s.roles[r.role] || 0) + 1;
      if (r.won) s.roleWins[r.role] = (s.roleWins[r.role] || 0) + 1;
      s.streak = r.won ? s.streak + 1 : 0;
      s.bestStreak = Math.max(s.bestStreak, s.streak);
      if (r.votes !== undefined) {
        s.detailedGames += 1;
        s.votes += r.votes;
        if (r.team === 'town') { s.townVotes += r.votes; s.votesOnMafia += r.votesOnMafia; }
        s.votesMatched += r.votesMatched;
        s.kills += r.kills;
        s.saves += r.saves;
        s.copHits += r.copHits;
        s.ballots += r.ballots || 0;
        s.decisive += r.decisive || 0;
        s.mafiaVotedOut += r.mafiaVotedOut || 0;
      }
      s.recent = [{ at: r.at || Date.now(), role: r.role, won: r.won, survived: r.survived, players: r.players }, ...s.recent].slice(0, RECENT_KEEP);
    }
    this.save();
  }

  // What other players (and the user) get to see.
  publicProfile(user) {
    if (!user) return null;
    // with the dislike shield, every dislike comes with a like, so dislikes never lower the score
    const likes = user.likes + (user.dislikeShield ? user.dislikes : 0);
    const inventory = (user.inventory || []).filter(i => ITEMS[i]);
    return {
      id: user.id,
      username: user.username,
      avatar: user.avatar ? `/avatars/${user.avatar}` : null,
      likes,
      dislikes: user.dislikes,
      score: likes - user.dislikes + (user.bonus || 0),
      stats: { ...emptyStats(), ...user.stats },
      admin: !!user.admin,
      inventory,
      equipped: Object.fromEntries(Object.entries(user.equipped || {}).filter(([, i]) => inventory.includes(i))),
      reactions: inventory.filter(i => ITEMS[i].slot === 'reaction').map(i => ITEMS[i].emoji),
      gifts: (user.gifts || []).filter(i => inventory.includes(i)),
    };
  }
}

module.exports = { UserStore, imageType };
