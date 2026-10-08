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
const MAX_TITLE = 32;
const MAX_BADGES = 12;
const THEMES = ['ocean', 'violet', 'sunset', 'forest', 'rose', 'mono'];
// "MM-DD" of today, in the server's time zone
const todayMD = () => { const d = new Date(); return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

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
const emptyMonoStats = () => ({
  games: 0, wins: 0, bankruptcies: 0, placeSum: 0, netWorthSum: 0, bestNetWorth: 0, peakNetWorth: 0,
  rentCollected: 0, rentPaid: 0, bought: 0, housesBuilt: 0, hotelsBuilt: 0, auctionsWon: 0, trades: 0,
  jailed: 0, doubles: 0, passedGo: 0, cardsDrawn: 0, rounds: 0, groups: {}, streak: 0, bestStreak: 0, recent: [],
});
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
    this.invites = {}; // code -> { createdBy, createdAt, maxUses, uses, usedBy, tableId, admin }
    this.failures = new Map(); // username (lowercase) -> [timestamps]
    this.saveTimer = null;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.users = data.users || {};
      this.sessions = data.sessions || {};
      this.ratingLog = data.ratingLog || [];
      this.invites = data.invites || {};
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
      fs.writeFileSync(tmp, JSON.stringify({ users: this.users, sessions: this.sessions, ratingLog: this.ratingLog, invites: this.invites }));
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

  // Registration needs an invite code (from the admin); it may also seat the newcomer at a table.
  register(username, password, inviteCode) {
    username = String(username || '').trim().replace(/\s+/g, ' ');
    password = String(password || '');
    const code = String(inviteCode || '').trim().toUpperCase();
    const invite = this.invites[code];
    if (!code) throw new GameError('err.inviteRequired');
    if (!invite || invite.uses >= invite.maxUses) throw new GameError('err.inviteInvalid');
    if (!USERNAME_RE.test(username)) throw new GameError('err.usernameInvalid', { min: 2, max: 20 });
    if (password.length < MIN_PASSWORD) throw new GameError('err.passwordShort', { min: MIN_PASSWORD });
    if (this.byName(username)) throw new GameError('err.usernameTaken');
    const user = { id: crypto.randomBytes(8).toString('hex'), username, ...hashPassword(password), avatar: null, likes: 0, dislikes: 0, createdAt: Date.now() };
    if (invite.admin) user.admin = true;
    this.users[user.id] = user;
    invite.uses += 1;
    invite.usedBy.push(user.id);
    const recoveryCode = this.newRecoveryCode(user);
    return { user, token: this.newSession(user), invite, recoveryCode };
  }

  // ---------- self-service password reset (no email): a recovery code shown once ----------
  newRecoveryCode(user) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const raw = Array.from(crypto.randomBytes(12), b => alphabet[b % alphabet.length]).join('');
    user.recovery = hashPassword(raw);
    this.save();
    return raw.match(/.{4}/g).join('-');
  }

  recover(username, code, newPassword) {
    const key = String(username || '').trim().toLowerCase();
    const now = Date.now();
    const recent = (this.failures.get(key) || []).filter(t => now - t < LOGIN_WINDOW_MS);
    if (recent.length >= LOGIN_MAX_FAILURES) throw new GameError('err.tooManyLogins');
    const user = this.byName(key);
    const clean = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!user || !user.recovery || !passwordMatches(clean, user.recovery)) {
      this.failures.set(key, [...recent, now]);
      throw new GameError('err.badRecovery');
    }
    if (String(newPassword || '').length < MIN_PASSWORD) throw new GameError('err.passwordShort', { min: MIN_PASSWORD });
    this.failures.delete(key);
    Object.assign(user, hashPassword(String(newPassword)));
    for (const [h, id] of Object.entries(this.sessions)) if (id === user.id) delete this.sessions[h];
    return { user, token: this.newSession(user), recoveryCode: this.newRecoveryCode(user) };
  }

  // ---------- invites ----------
  createInvite(byUserId, { maxUses = 1, tableId = null, admin = false } = {}) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do code = Array.from(crypto.randomBytes(8), b => alphabet[b % alphabet.length]).join('');
    while (this.invites[code]);
    maxUses = Math.max(1, Math.min(100, Math.round(Number(maxUses) || 1)));
    this.invites[code] = { createdBy: byUserId, createdAt: Date.now(), maxUses, uses: 0, usedBy: [], tableId, admin: !!admin };
    this.save();
    return code;
  }

  revokeInvite(code) {
    delete this.invites[code];
    this.save();
  }

  inviteList() {
    return Object.entries(this.invites).map(([code, inv]) => ({
      code, maxUses: inv.maxUses, uses: inv.uses, createdAt: inv.createdAt, tableId: inv.tableId, admin: inv.admin,
      createdBy: this.users[inv.createdBy]?.username || null,
      usedBy: inv.usedBy.map(id => this.users[id]?.username).filter(Boolean),
    })).sort((a, b) => b.createdAt - a.createdAt);
  }

  // A brand-new site has no accounts: make one admin invite and leave it in a file for the owner.
  bootstrapInvite(dir) {
    if (Object.keys(this.users).length) return null;
    const existing = Object.entries(this.invites).find(([, inv]) => inv.admin && inv.uses < inv.maxUses);
    const code = existing ? existing[0] : this.createInvite(null, { admin: true });
    const file = path.join(dir, 'admin-invite.txt');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, code + '\n', { mode: 0o600 });
    this.saveNow();
    return { code, file };
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

  // ---------- admin: account fixes ----------
  rename(user, username) {
    username = String(username || '').trim().replace(/\s+/g, ' ');
    if (!USERNAME_RE.test(username)) throw new GameError('err.usernameInvalid', { min: 2, max: 20 });
    const other = this.byName(username);
    if (other && other.id !== user.id) throw new GameError('err.usernameTaken');
    user.username = username;
    this.save();
  }

  // A fresh temporary password (the admin passes it on); every device gets logged out.
  resetPassword(user) {
    const words = 'abcdefghjkmnpqrstuvwxyz23456789';
    const password = Array.from(crypto.randomBytes(8), b => words[b % words.length]).join('');
    Object.assign(user, hashPassword(password));
    for (const [h, id] of Object.entries(this.sessions)) if (id === user.id) delete this.sessions[h];
    this.failures.delete(user.username.toLowerCase());
    this.save();
    return password;
  }

  // ---------- personal touches ----------
  // Titles and badges come from the admin (inside jokes); birthday and theme are your own.
  setTitle(user, title) {
    user.title = String(title || '').trim().replace(/\s+/g, ' ').slice(0, MAX_TITLE) || null;
    this.save();
  }

  addBadge(user, emoji, label, byId) {
    emoji = String(emoji || '').trim().slice(0, 8);
    label = String(label || '').trim().replace(/\s+/g, ' ').slice(0, MAX_TITLE);
    if (!emoji || !label) throw new GameError('err.badgeRequired');
    user.badges ||= [];
    if (user.badges.length >= MAX_BADGES) throw new GameError('err.tooManyBadges', { n: MAX_BADGES });
    user.badges.push({ id: crypto.randomBytes(4).toString('hex'), emoji, label, by: byId, at: Date.now() });
    this.save();
  }

  removeBadge(user, badgeId) {
    user.badges = (user.badges || []).filter(b => b.id !== badgeId);
    this.save();
  }

  setPersonal(user, { birthday, theme }) {
    if (birthday !== undefined) {
      const m = /^(\d{2})-(\d{2})$/.exec(String(birthday || ''));
      if (birthday && (!m || +m[1] < 1 || +m[1] > 12 || +m[2] < 1 || +m[2] > 31)) throw new GameError('err.birthdayInvalid');
      user.birthday = birthday ? String(birthday) : null; // "MM-DD", no year
    }
    if (theme !== undefined) {
      if (theme && !THEMES.includes(theme)) throw new GameError('err.invalidTarget');
      user.theme = theme || null;
    }
    this.save();
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

  // One finished Monopoly game: results from MonoRoom.onGameEnd.
  recordMonoGame(results) {
    for (const r of results) {
      const u = this.users[r.userId];
      if (!u) continue;
      const s = (u.monoStats = { ...emptyMonoStats(), ...u.monoStats });
      s.games += 1;
      s.wins += r.won ? 1 : 0;
      s.bankruptcies += r.bankrupt ? 1 : 0;
      s.placeSum += r.place;
      s.netWorthSum += r.netWorth;
      s.bestNetWorth = Math.max(s.bestNetWorth, r.netWorth);
      s.peakNetWorth = Math.max(s.peakNetWorth, r.peakNetWorth || 0);
      for (const k of ['rentCollected', 'rentPaid', 'bought', 'housesBuilt', 'hotelsBuilt', 'auctionsWon', 'trades', 'jailed', 'doubles', 'passedGo', 'cardsDrawn', 'rounds']) s[k] += r[k] || 0;
      if (r.topGroup) s.groups[r.topGroup] = (s.groups[r.topGroup] || 0) + 1;
      s.streak = r.won ? s.streak + 1 : 0;
      s.bestStreak = Math.max(s.bestStreak, s.streak);
      s.recent = [{ at: r.at || Date.now(), won: r.won, place: r.place, players: r.players, netWorth: r.netWorth }, ...s.recent].slice(0, RECENT_KEEP);
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
      monoStats: { ...emptyMonoStats(), ...user.monoStats },
      admin: !!user.admin,
      hasRecovery: !!user.recovery,
      inventory,
      // on your birthday everyone sees you in a birthday hat
      equipped: { ...Object.fromEntries(Object.entries(user.equipped || {}).filter(([, i]) => inventory.includes(i))), ...(user.birthday === todayMD() ? { hat: 'hat.birthday' } : {}) },
      title: user.title || null,
      badges: user.badges || [],
      birthday: user.birthday || null,
      birthdayToday: !!user.birthday && user.birthday === todayMD(),
      theme: user.theme || null,
      reactions: inventory.filter(i => ITEMS[i].slot === 'reaction').map(i => ITEMS[i].emoji),
      gifts: (user.gifts || []).filter(i => inventory.includes(i)),
    };
  }
}

module.exports = { UserStore, imageType, THEMES };
