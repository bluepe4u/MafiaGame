'use strict';

// Accounts: username + password, and an email (optional for older accounts) for password resets.
// Saved in the site database (src/db.js); avatars are image files next to it.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { GameError } = require('./game');
const { ITEMS, EQUIP_SLOTS } = require('./items');
const { ACHIEVEMENTS, dailyBonus } = require('./achievements');
const { Saved } = require('./db');

const USERNAME_RE = /^[\p{L}\p{N} _.-]{2,20}$/u;
const MIN_PASSWORD = 4;
const MAX_AVATAR_BYTES = 1024 * 1024;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const RATING_LOG_KEEP = 5000;
const LOWEST_SCORE = -10; // the bottom decency status starts here
// signup: anyone may create an account (off: only with an invite from the admin)
const DEFAULT_FEATURES = { family: false, voice: true, transcripts: true, signup: true };
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const normEmail = e => String(e || '').trim().toLowerCase();
const MAX_TITLE = 32;
const MAX_BADGES = 12;
const THEMES = ['ocean', 'violet', 'sunset', 'forest', 'rose', 'mono'];
// "MM-DD" of today, in the server's time zone
const todayMD = () => { const d = new Date(); return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// "YYYY-MM-DD" of a day, in the server's time zone
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const CHIP_LOG_KEEP = 60;
// USDT addresses by network: TRON (TRC-20) or an EVM chain (ERC-20, BEP-20)
const USDT_NETWORKS = { trc20: /^T[1-9A-HJ-NP-Za-km-z]{33}$/, erc20: /^0x[0-9a-fA-F]{40}$/, bep20: /^0x[0-9a-fA-F]{40}$/ };

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}

function passwordMatches(password, user) {
  if (!user || !user.salt || !user.hash) return false; // a guest has no password
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
const emptySpyStats = () => ({
  games: 0, wins: 0, points: 0, rounds: 0, spyRounds: 0, spyWins: 0, guessed: 0, townWins: 0, caught: 0,
  streak: 0, bestStreak: 0, recent: [],
});
const emptyCitStats = () => ({
  games: 0, wins: 0, placeSum: 0, scoreSum: 0, bestScore: 0, built: 0, destroyed: 0, lost: 0, stolen: 0, swaps: 0, kills: 0,
  firstComplete: 0, completed: 0, rounds: 0, chars: {}, charWins: {}, streak: 0, bestStreak: 0, recent: [],
});
const emptyPokerStats = () => ({
  games: 0, wins: 0, placeSum: 0, net: 0, hands: 0, vpip: 0, pfr: 0, handsWon: 0, showdowns: 0, sdWon: 0,
  allIns: 0, allInsWon: 0, biggestPot: 0, rebuys: 0, bestHand: null, streak: 0, bestStreak: 0, recent: [],
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
    this.store = new Saved(dir, 'users', { users: 'map', sessions: 'map', invites: 'map', ratingLog: 'value', features: 'value' }, 'users.json');
    this.avatarDir = path.join(dir, 'avatars');
    this.users = {}; // id -> { id, username, salt, hash, avatar, likes, dislikes, createdAt }
    this.sessions = {}; // sha256(token) -> userId
    this.ratingLog = []; // [{ from, to, value, at }]: who rated whom, for the admin
    this.invites = {}; // code -> { createdBy, createdAt, maxUses, uses, usedBy, tableId, admin }
    // site-wide switches from the admin panel; a feature that's off is hidden in every lobby
    this.features = { ...DEFAULT_FEATURES };
    this.failures = new Map(); // username (lowercase) -> [timestamps]
    this.saveTimer = null;
    const data = this.store.load();
    this.users = data.users || {};
    this.sessions = data.sessions || {};
    this.ratingLog = data.ratingLog || [];
    this.invites = data.invites || {};
    this.features = { ...DEFAULT_FEATURES, ...data.features };
    // USDT poker is private: everyone who had an account before it went private keeps access
    // (once); everyone else only gets it from the admin panel
    if (!this.store.db.meta('grant:usdtAccess')) {
      for (const u of Object.values(this.users)) u.usdtAccess = true;
      this.store.db.meta('grant:usdtAccess', Date.now());
      if (Object.keys(this.users).length) this.saveNow();
    }
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      this.store.save({ users: this.users, sessions: this.sessions, ratingLog: this.ratingLog, invites: this.invites, features: this.features });
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

  byEmail(email) {
    const e = normEmail(email);
    return e ? Object.values(this.users).find(u => u.email === e) : undefined;
  }

  cleanEmail(email, user = null) {
    const e = normEmail(email);
    if (!EMAIL_RE.test(e)) throw new GameError('err.emailInvalid');
    const other = this.byEmail(e);
    if (other && other !== user) throw new GameError('err.emailTaken');
    return e;
  }

  // A new account: username, email and password. An invite is optional while sign-up is open (it
  // may seat the newcomer at a table, or make the first admin); with sign-up closed it's required.
  // Accounts made before emails existed keep working without one.
  register(username, password, inviteCode, { email } = {}) {
    username = String(username || '').trim().replace(/\s+/g, ' ');
    password = String(password || '');
    const code = String(inviteCode || '').trim().toUpperCase();
    const invite = code ? this.invites[code] : null;
    if (code && (!invite || invite.uses >= invite.maxUses)) throw new GameError('err.inviteInvalid');
    if (!invite && !this.features.signup) throw new GameError('err.inviteRequired');
    if (!USERNAME_RE.test(username)) throw new GameError('err.usernameInvalid', { min: 2, max: 20 });
    // the first admin (the invite from the data dir) may skip the email
    const mail = invite?.admin && !email ? null : this.cleanEmail(email);
    if (password.length < MIN_PASSWORD) throw new GameError('err.passwordShort', { min: MIN_PASSWORD });
    if (this.byName(username)) throw new GameError('err.usernameTaken');
    const user = { id: crypto.randomBytes(8).toString('hex'), username, email: mail, emailVerified: false, ...hashPassword(password), avatar: null, likes: 0, dislikes: 0, createdAt: Date.now() };
    if (invite?.admin) user.admin = true;
    this.users[user.id] = user;
    if (invite) {
      invite.uses += 1;
      invite.usedBy.push(user.id);
    }
    const recoveryCode = this.newRecoveryCode(user);
    return { user, token: this.newSession(user), invite, recoveryCode };
  }

  // ---------- guests: a name is enough to play ----------
  // Someone who opens an invite gets a light account with just a name: their stats, chips and
  // achievements work at once, and register() isn't needed to play. saveGuest() turns it into a
  // full account (username, email, password) with everything kept; unsaved guests are removed
  // after a month (pruneGuests). Guests can't log in elsewhere, rate or be rated, or show on the
  // leaderboard.
  createGuest(name) {
    let base = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 18);
    if (!USERNAME_RE.test(base)) throw new GameError('err.usernameInvalid', { min: 2, max: 20 });
    let username = base;
    for (let n = 2; this.byName(username); n++) username = `${base} ${n}`;
    const user = { id: crypto.randomBytes(8).toString('hex'), username, guest: true, avatar: null, likes: 0, dislikes: 0, createdAt: Date.now(), lastSeen: Date.now() };
    this.users[user.id] = user;
    this.claimDaily(user); // the welcome chips (and today's bonus), so a poker buy-in works at once
    return { user, token: this.newSession(user) };
  }

  saveGuest(user, { username, email, password }) {
    if (!user.guest) throw new GameError('err.invalidTarget');
    username = String(username || '').trim().replace(/\s+/g, ' ');
    if (!USERNAME_RE.test(username)) throw new GameError('err.usernameInvalid', { min: 2, max: 20 });
    const other = this.byName(username);
    if (other && other !== user) throw new GameError('err.usernameTaken');
    const mail = this.cleanEmail(email, user);
    if (String(password || '').length < MIN_PASSWORD) throw new GameError('err.passwordShort', { min: MIN_PASSWORD });
    Object.assign(user, { username, email: mail, emailVerified: false, ...hashPassword(String(password)) });
    delete user.guest;
    delete user.lastSeen;
    const recoveryCode = this.newRecoveryCode(user);
    this.save();
    return { user, recoveryCode };
  }

  seen(user) {
    if (user.guest) { user.lastSeen = Date.now(); this.save(); }
  }

  // guests nobody saved, gone quiet for a month (keepIds: still at a table or in a room)
  pruneGuests(keepIds = new Set(), now = Date.now()) {
    const cutoff = now - 30 * 24 * 60 * 60 * 1000;
    const gone = Object.values(this.users).filter(u => u.guest && (u.lastSeen || u.createdAt) < cutoff && !keepIds.has(u.id)).map(u => u.id);
    for (const id of gone) delete this.users[id];
    if (gone.length) {
      const g = new Set(gone);
      for (const [h, id] of Object.entries(this.sessions)) if (g.has(id)) delete this.sessions[h];
      this.save();
    }
    return gone;
  }

  // ---------- email: optional for older accounts, needs the password to change ----------
  setEmail(user, email, password) {
    if (!passwordMatches(String(password || ''), user)) throw new GameError('err.badPassword');
    if (!String(email || '').trim()) {
      delete user.email;
      delete user.emailVerified;
    } else {
      const e = this.cleanEmail(email, user);
      if (e !== user.email) { user.email = e; user.emailVerified = false; }
    }
    this.save();
  }

  // the link from the confirmation email (only for the address it was sent to)
  confirmEmail(userId, email) {
    const user = this.users[userId];
    if (!user || !user.email || user.email !== email) return null;
    user.emailVerified = true;
    this.save();
    return user;
  }

  // the link from the reset email: a new password, every device logged out, the email proven
  resetByEmail(userId, newPassword) {
    const user = this.users[userId];
    if (!user) throw new GameError('err.badResetLink');
    if (String(newPassword || '').length < MIN_PASSWORD) throw new GameError('err.passwordShort', { min: MIN_PASSWORD });
    Object.assign(user, hashPassword(String(newPassword)));
    if (user.email) user.emailVerified = true;
    for (const [h, id] of Object.entries(this.sessions)) if (id === user.id) delete this.sessions[h];
    this.failures.delete(user.username.toLowerCase());
    return { user, token: this.newSession(user) };
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
    // the username or the email
    const user = this.byName(key) || this.byEmail(key);
    if (!user || user.guest || !passwordMatches(String(password || ''), user)) {
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

  setFeatures(changes) {
    for (const k of Object.keys(DEFAULT_FEATURES)) if (changes[k] !== undefined) this.features[k] = !!changes[k];
    this.save();
    return this.features;
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
      email: user.email || null, emailVerified: !!user.emailVerified, usdtAccess: !!user.usdtAccess,
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
      if (r.won) this.award(u, 'mafia.win');
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
      if (r.won) this.award(u, 'mono.win');
    }
    this.save();
  }

  // One finished game of "Find the spy": results from SpyRoom.onGameEnd.
  recordSpyGame(results) {
    for (const r of results) {
      const u = this.users[r.userId];
      if (!u) continue;
      const s = (u.spyStats = { ...emptySpyStats(), ...u.spyStats });
      s.games += 1;
      s.wins += r.won ? 1 : 0;
      for (const k of ['points', 'rounds', 'spyRounds', 'spyWins', 'guessed', 'townWins', 'caught']) s[k] += r[k] || 0;
      s.streak = r.won ? s.streak + 1 : 0;
      s.bestStreak = Math.max(s.bestStreak, s.streak);
      s.recent = [{ at: r.at || Date.now(), won: r.won, points: r.points, players: r.players }, ...s.recent].slice(0, RECENT_KEEP);
      if (r.won) this.award(u, 'spy.win');
    }
    this.save();
  }

  // One finished Citadels game: results from CitRoom.onGameEnd.
  recordCitGame(results) {
    for (const r of results) {
      const u = this.users[r.userId];
      if (!u) continue;
      const s = (u.citStats = { ...emptyCitStats(), ...u.citStats });
      s.games += 1;
      s.wins += r.won ? 1 : 0;
      s.placeSum += r.place;
      s.scoreSum += r.score;
      s.bestScore = Math.max(s.bestScore, r.score);
      for (const k of ['built', 'destroyed', 'lost', 'stolen', 'swaps', 'kills', 'rounds']) s[k] += r[k] || 0;
      s.firstComplete += r.firstComplete ? 1 : 0;
      s.completed += r.completed ? 1 : 0;
      for (const [c, n] of Object.entries(r.chars || {})) s.chars[c] = (s.chars[c] || 0) + n;
      if (r.won) for (const c of r.lastChars || []) s.charWins[c] = (s.charWins[c] || 0) + 1;
      s.streak = r.won ? s.streak + 1 : 0;
      s.bestStreak = Math.max(s.bestStreak, s.streak);
      s.recent = [{ at: r.at || Date.now(), won: r.won, place: r.place, players: r.players, score: r.score }, ...s.recent].slice(0, RECENT_KEEP);
      if (r.won) this.award(u, 'cit.win');
    }
    this.save();
  }

  // One finished poker session: results from PokerRoom.onGameEnd.
  recordPokerGame(results) {
    for (const r of results) {
      const u = this.users[r.userId];
      if (!u) continue;
      const s = (u.pokerStats = { ...emptyPokerStats(), ...u.pokerStats });
      s.games += 1;
      s.wins += r.won ? 1 : 0;
      s.placeSum += r.place;
      s.net += r.net;
      for (const k of ['hands', 'vpip', 'pfr', 'handsWon', 'showdowns', 'sdWon', 'allIns', 'allInsWon']) s[k] += r[k] || 0;
      s.rebuys += Math.max(0, (r.buyins || 1) - 1);
      s.biggestPot = Math.max(s.biggestPot, r.biggestPot || 0);
      if (r.best && (!s.bestHand || r.best.score > s.bestHand.score)) s.bestHand = r.best;
      s.streak = r.won ? s.streak + 1 : 0;
      s.bestStreak = Math.max(s.bestStreak, s.streak);
      s.recent = [{ at: r.at || Date.now(), won: r.won, place: r.place, players: r.players, net: r.net }, ...s.recent].slice(0, RECENT_KEEP);
      s.allInsWon = s.allInsWon || 0;
      const award = id => this.award(u, id);
      award('pk.first');
      if (r.won) award('pk.win');
      if (s.hands >= 100) award('pk.hands100');
      if (s.hands >= 1000) award('pk.hands1000');
      if (s.allInsWon >= 10) award('pk.allIns10');
      const cat = r.best ? Math.floor(r.best.score / 1048576) : -1;
      if (cat >= 7) award('pk.quads');
      if (cat >= 8) award('pk.straightFlush');
      if (r.best && r.best.name && r.best.name.key === 'pk.h.royal') award('pk.royal');
      if (r.won72) award('pk.72');
      if (r.runnerRunner) award('pk.runnerRunner');
    }
    this.save();
  }

  // ---------- site chips: a wallet that lives across games and tables ----------
  // Chips come from the welcome gift, the daily bonus and achievements, and from poker sessions
  // played for site chips. They never turn into money and money never turns into them.
  wallet(user) {
    if (typeof user.chips !== 'number') {
      user.chips = 0;
      user.chipLog = [];
      user.achievements = user.achievements || [];
      this.award(user, 'welcome');
    }
    return user;
  }

  addChips(user, n, reason, extra = {}) {
    this.wallet(user);
    user.chips += n;
    user.chipLog = [{ at: Date.now(), n, reason, ...extra }, ...(user.chipLog || [])].slice(0, CHIP_LOG_KEEP);
    this.save();
  }

  // false when there aren't enough
  takeChips(user, n, reason, extra = {}) {
    this.wallet(user);
    if (user.chips < n) return false;
    this.addChips(user, -n, reason, extra);
    return true;
  }

  // once per achievement; returns the reward (0 if already had)
  award(user, id) {
    const a = ACHIEVEMENTS[id];
    user.achievements = user.achievements || [];
    if (!a || user.achievements.some(x => x.id === id)) return 0;
    user.achievements.push({ id, at: Date.now() });
    if (typeof user.chips !== 'number') { user.chips = 0; user.chipLog = []; }
    this.addChips(user, a.reward, 'ach', { id });
    return a.reward;
  }

  // the first visit of the day pays the daily bonus; returns { n, streak } or null
  claimDaily(user) {
    this.wallet(user);
    const today = dayKey();
    const d = user.daily || {};
    if (d.last === today) return null;
    const yesterday = dayKey(new Date(Date.now() - 24 * 60 * 60 * 1000));
    const streak = d.last === yesterday ? (d.streak || 0) + 1 : 1;
    user.daily = { last: today, streak };
    const n = dailyBonus(streak);
    this.addChips(user, n, 'daily', { streak });
    if (streak >= 7) this.award(user, 'streak7');
    return { n, streak };
  }

  setUsdt(user, { network, address }) {
    address = String(address || '').trim();
    if (!address) { delete user.usdt; this.save(); return; }
    if (!USDT_NETWORKS[network] || !USDT_NETWORKS[network].test(address)) throw new GameError('err.usdt.address');
    user.usdt = { network, address };
    this.save();
  }

  // the owner's own view of the wallet
  walletView(user) {
    this.wallet(user);
    return {
      chips: user.chips,
      log: user.chipLog || [],
      achievements: Object.entries(ACHIEVEMENTS).map(([id, a]) => ({ id, reward: a.reward, game: a.game || null, at: (user.achievements.find(x => x.id === id) || {}).at || null })),
      daily: user.daily || null,
      usdt: user.usdt || null,
    };
  }

  // The user's own view: the public profile and the email (never shown to anyone else).
  selfProfile(user) {
    if (!user) return null;
    return { ...this.publicProfile(user), email: user.email || null, emailVerified: !!user.emailVerified, usdtAccess: !!user.usdtAccess, guest: !!user.guest };
  }

  setUsdtAccess(user, on) {
    user.usdtAccess = !!on;
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
      // guests aren't rated: no score, no decency status
      score: user.guest ? null : likes - user.dislikes + (user.bonus || 0),
      guest: !!user.guest,
      stats: { ...emptyStats(), ...user.stats },
      monoStats: { ...emptyMonoStats(), ...user.monoStats },
      spyStats: { ...emptySpyStats(), ...user.spyStats },
      citStats: { ...emptyCitStats(), ...user.citStats },
      pokerStats: { ...emptyPokerStats(), ...user.pokerStats },
      chips: typeof user.chips === 'number' ? user.chips : null,
      usdtSet: !!user.usdt,
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
