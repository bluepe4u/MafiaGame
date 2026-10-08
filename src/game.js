'use strict';

const HOST_GRACE_MS = 30 * 1000; // how long a disconnected host keeps the lobby
const crypto = require('crypto');

const ROLES = {
  CITIZEN: 'citizen',
  MAFIA: 'mafia',
  COP: 'cop',
  DOCTOR: 'doctor',
  HOOKER: 'hooker',
};

// Display names and descriptions live in the client's translations (public/i18n.js).
const ROLE_INFO = {
  citizen: { team: 'town' },
  mafia: { team: 'mafia' },
  cop: { team: 'town' },
  doctor: { team: 'town' },
  hooker: { team: 'town' },
};

const PHASES = {
  LOBBY: 'lobby',
  NIGHT: 'night',
  SPEECH: 'speech',
  VOTE: 'vote',
  ENDED: 'ended',
};

const MIN_PLAYERS = 4;
const MAX_PLAYERS = 12;
const EXTEND_MS = 30 * 1000;
const NOBODY = 'none'; // night choice for the Mafia (kill nobody) and the Doctor (heal nobody)
const CAN_PICK_NOBODY = ['mafia', 'doctor'];
const CHAT_MAX_LEN = 300;
const CHAT_KEEP = 150; // messages kept per channel
const CHAT_MIN_GAP_MS = 400; // per player, against accidental floods
const MAX_SPECTATORS = 20;
const COUNTDOWN_MS = 5000;
const REACTIONS = ['👍', '👎', '😂', '🤔', '😱', '🤥', '🔥', '💀', '❤️', '👀'];
const REACT_MIN_GAP_MS = 600;

// Everything that makes up a room's state, for saving to disk and restoring after a restart.
const SAVED_FIELDS = [
  'code', 'players', 'spectators', 'hostId', 'settings', 'phase', 'day', 'gameId', 'nightActions', 'lastDoctorTarget',
  'doctorSelfHealUsed', 'speech', 'lastStarterSeat', 'votes', 'voteEndsAt', 'nightEndsAt', 'log', 'privateLog', 'history', 'chat',
  'revealedRoles', 'ratings', 'winner', 'lastActivity', 'tableId', 'startedAt', 'transcript', 'insights',
];
const TRANSCRIPT_KEEP = 3000; // lines per game
const TRANSCRIPT_MAX_CHARS = 600; // per line

const id = (bytes = 6) => crypto.randomBytes(bytes).toString('hex');

function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function defaultRoleCounts(n) {
  return {
    mafia: n >= 6 ? Math.floor(n / 3) : 1,
    cop: n >= 4 ? 1 : 0,
    doctor: n >= 5 ? 1 : 0,
    hooker: n > 8 ? 1 : 0,
  };
}

// Returns null when valid, otherwise an error { key, params } for the client to translate.
function validateRoleCounts(counts, n) {
  for (const k of ['mafia', 'cop', 'doctor', 'hooker']) {
    if (!Number.isInteger(counts[k]) || counts[k] < 0) return { key: 'err.invalidCount', params: { role: k } };
  }
  if (counts.cop > 1 || counts.doctor > 1 || counts.hooker > 1) return { key: 'err.singleRoles', params: {} };
  if (counts.mafia < 1) return { key: 'err.needMafia', params: {} };
  const special = counts.mafia + counts.cop + counts.doctor + counts.hooker;
  if (special > n) return { key: 'err.tooManyRoles', params: {} };
  if (counts.mafia * 2 >= n) return { key: 'err.mafiaTooMany', params: {} };
  return null;
}

// The day-vote rule: the top target leaves only with strictly more votes than anyone else and
// than "skip"; otherwise nobody does. Returns the eliminated player's id, or null.
function voteOutcome(votes) {
  const tally = {};
  let skips = 0;
  for (const t of Object.values(votes)) {
    if (t === 'skip') skips++;
    else tally[t] = (tally[t] || 0) + 1;
  }
  const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  return top && top[1] > skips && (ranked.length === 1 || top[1] > ranked[1][1]) ? top[0] : null;
}

// Errors carry a translation key (also used as the message) and its parameters.
class GameError extends Error {
  constructor(key, params = {}) {
    super(key);
    this.key = key;
    this.params = params;
  }
}

class Room {
  // profileOf(userId) -> { avatar, score } for display; onRate(targetUserId, oldValue, newValue) records ratings
  constructor({
    code, rng = Math.random, onChange = () => {}, setTimer = setTimeout, clearTimer = clearTimeout,
    profileOf = () => null, onRate = () => {}, onGameEnd = () => {}, onStart = () => {}, onArchive = () => {}, tableId = null,
  } = {}) {
    this.code = code;
    this.tableId = tableId; // the table that started this room, if any
    this.onStart = onStart; // (room) when a game starts: the table remembers its settings
    this.onArchive = onArchive; // (record) a finished game, for the game night archive
    this.profileOf = profileOf;
    this.onRate = onRate;
    this.onGameEnd = onGameEnd; // ([{ userId, role, team, won, survived }]) for profile stats
    this.rng = rng;
    this.onChange = onChange;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.players = []; // { id, token, userId, name, seat, connected, alive, role, ready }
    this.spectators = []; // { id, token, userId, name, connected }: watch the game, see only public info
    this.lastReactAt = {};
    this.hostId = null;
    // voteSeconds / nightSeconds: 0 means no time limit
    this.settings = {
      speechSeconds: 60, voteSeconds: 360, nightSeconds: 240, revealRoleOnDeath: true, firstNightKill: true, roleCounts: null,
      family: false, // gentler words, no likes/dislikes
      transcripts: false, // speech-to-text of the voice chat (everyone is told), shown after the game
    };
    this.resetGameState();
    this.lastActivity = Date.now();
  }

  resetGameState() {
    this.phase = PHASES.LOBBY;
    this.day = 0;
    this.gameId = null;
    this.nightActions = {}; // playerId -> targetId
    this.lastDoctorTarget = null; // the Doctor can't protect the same player two nights in a row
    this.doctorSelfHealUsed = false;
    this.speech = null; // { order: [ids], index, endsAt }
    this.lastStarterSeat = null;
    this.votes = {}; // voterId -> targetId | 'skip'
    this.voteEndsAt = null;
    this.nightEndsAt = null;
    this.countdownEndsAt = null; // the host pressed Start: the game begins unless someone cancels
    // town: everyone (lobby, day, after the game); mafia: the Mafia, at night; dead: players who are out
    this.chat = { town: [], mafia: [], dead: [] };
    this.lastChatAt = {};
    this.revealedRoles = {}; // playerId -> true once they've shown their role in the graveyard chat
    this.ratings = {}; // raterPlayerId -> { targetPlayerId: 1 | -1 }, after the game
    this.log = []; // public events { day, phase, text }
    this.privateLog = {}; // playerId -> [{ day, text }]
    // what happened each night and vote: [{ type: 'night', day, actions, killed, saved } | { type: 'vote', day, votes, out }]
    // night entries stay secret until the game ends; votes are open anyway
    this.history = [];
    // speech-to-text lines from the voice chat (when the host turned transcripts on): secret until the end
    this.transcript = []; // [{ pid, name, text, at, phase, day, channel }]
    this.insights = null; // the AI's read of the game, added after it ends
    this.winner = null;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  dispose() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    if (this.hostTimer) this.clearTimer(this.hostTimer.handle);
    this.hostTimer = null;
  }

  toJSON() {
    return Object.fromEntries(SAVED_FIELDS.map(k => [k, this[k]]));
  }

  // Rebuild a room saved with toJSON(). Everyone starts offline until their client reconnects.
  static restore(data, opts = {}) {
    const room = new Room({ ...opts, code: data.code });
    const defaults = room.settings;
    for (const k of SAVED_FIELDS) if (data[k] !== undefined) room[k] = data[k];
    room.settings = { ...defaults, ...room.settings }; // settings added since the room was saved
    room.chat = { town: [], mafia: [], dead: [], ...room.chat };
    for (const p of [...room.players, ...room.spectators]) p.connected = false;
    // the server was down for a while: give the current speaker / the vote at least a few seconds back
    const atLeast = Date.now() + 15 * 1000;
    if (room.phase === PHASES.SPEECH && room.speech?.endsAt) {
      room.speech.endsAt = Math.max(room.speech.endsAt, atLeast);
      room.scheduleSpeechTimer();
    } else if (room.phase === PHASES.VOTE && room.voteEndsAt) {
      room.voteEndsAt = Math.max(room.voteEndsAt, atLeast);
      room.scheduleVoteTimer();
    } else if (room.phase === PHASES.NIGHT && room.nightEndsAt) {
      room.nightEndsAt = Math.max(room.nightEndsAt, atLeast);
      room.scheduleNightTimer();
    }
    return room;
  }

  touch() {
    this.lastActivity = Date.now();
    this.onChange(this);
  }

  // ---------- helpers ----------
  player(pid) {
    return this.players.find(p => p.id === pid);
  }

  spectator(pid) {
    return this.spectators.find(p => p.id === pid);
  }

  // a player or a spectator
  member(pid) {
    return this.player(pid) || this.spectator(pid);
  }

  byToken(token) {
    return [...this.players, ...this.spectators].find(p => p.token === token);
  }

  byUser(userId) {
    return userId ? [...this.players, ...this.spectators].find(p => p.userId === userId) : null;
  }

  alive() {
    return this.players.filter(p => p.alive).sort((a, b) => a.seat - b.seat);
  }

  assert(cond, key, params) {
    if (!cond) throw new GameError(key, params);
  }

  // Log entries are { key, params }; the client renders them in the viewer's language.
  addPublic(key, params = {}) {
    this.log.push({ day: this.day, phase: this.phase, key, params });
  }

  addPrivate(pid, key, params = {}) {
    (this.privateLog[pid] ||= []).push({ day: this.day, key, params });
  }

  effectiveRoleCounts() {
    return this.settings.roleCounts || defaultRoleCounts(this.players.length);
  }

  // ---------- lobby ----------
  // Join to play, or to watch: anyone arriving while a game is running (or a full room) watches.
  join(name, { userId = null, spectate = false } = {}) {
    name = String(name || '').trim().slice(0, 20);
    this.assert(name, 'err.nameRequired');
    this.assert(![...this.players, ...this.spectators].some(p => p.name.toLowerCase() === name.toLowerCase()), 'err.nameTaken');
    const watch = spectate || this.phase !== PHASES.LOBBY || this.players.length >= MAX_PLAYERS;
    if (watch) {
      this.assert(this.spectators.length < MAX_SPECTATORS, 'err.roomFull', { max: MAX_SPECTATORS });
      const sp = { id: id(), token: id(16), userId, name, connected: true };
      this.spectators.push(sp);
      if (!this.hostId) this.hostId = sp.id;
      this.touch();
      return sp;
    }
    const p = { id: id(), token: id(16), userId, name, seat: this.players.length, connected: true, alive: true, role: null, ready: false };
    this.players.push(p);
    if (!this.hostId) this.hostId = p.id;
    this.cancelCountdown();
    this.touch();
    return p;
  }

  // In the lobby, move between playing and watching.
  setSpectating(pid, watch) {
    this.assert(this.phase === PHASES.LOBBY, 'err.settingsLobbyOnly');
    const p = this.member(pid);
    this.assert(p, 'err.notInRoom');
    if (watch && this.player(pid)) {
      this.assert(this.spectators.length < MAX_SPECTATORS, 'err.roomFull', { max: MAX_SPECTATORS });
      this.removePlayer(pid);
      this.spectators.push({ id: p.id, token: p.token, userId: p.userId, name: p.name, connected: p.connected });
    } else if (!watch && this.spectator(pid)) {
      this.assert(this.players.length < MAX_PLAYERS, 'err.roomFull', { max: MAX_PLAYERS });
      this.spectators = this.spectators.filter(x => x.id !== pid);
      this.players.push({ ...p, seat: this.players.length, alive: true, role: null, ready: false });
    }
    this.cancelCountdown();
    this.touch();
  }

  // lobby only: take a player out and close up the seats
  removePlayer(pid) {
    this.players = this.players.filter(x => x.id !== pid);
    this.players.forEach((x, i) => { x.seat = i; });
    // a role setup made for a different player count is likely invalid now
    if (this.settings.roleCounts && validateRoleCounts(this.settings.roleCounts, this.players.length)) {
      this.settings.roleCounts = null;
    }
  }

  setReady(pid, ready) {
    this.assert(this.phase === PHASES.LOBBY, 'err.settingsLobbyOnly');
    const p = this.player(pid);
    this.assert(p, 'err.notInRoom');
    p.ready = !!ready;
    this.touch();
  }

  // ---------- start countdown ----------
  startCountdown(pid) {
    this.requireHost(pid);
    this.assert(this.phase === PHASES.LOBBY, 'err.gameStarted');
    this.assert(this.players.length >= MIN_PLAYERS, 'err.needPlayers', { min: MIN_PLAYERS });
    const err = validateRoleCounts(this.effectiveRoleCounts(), this.players.length);
    this.assert(!err, err?.key, err?.params);
    this.countdownEndsAt = Date.now() + COUNTDOWN_MS;
    this.scheduleTimer(PHASES.LOBBY, this.countdownEndsAt, () => {
      this.countdownEndsAt = null;
      try {
        this.start(this.hostId);
      } catch {
        this.touch(); // e.g. someone left at the last second: just stay in the lobby
      }
    });
    this.touch();
  }

  // anyone in the room can call "wait!"; joining, leaving and settings changes cancel it too
  cancelCountdown(pid) {
    if (pid !== undefined) this.assert(this.member(pid), 'err.notInRoom');
    if (!this.countdownEndsAt) return;
    this.countdownEndsAt = null;
    this.cancelTimer();
    if (pid !== undefined) {
      this.addPublic('log.countdownCancelled', { name: this.member(pid).name });
      this.touch();
    }
  }

  leave(pid) {
    if (this.spectator(pid)) {
      this.spectators = this.spectators.filter(x => x.id !== pid);
    } else {
      const p = this.player(pid);
      if (!p) return;
      if (this.phase === PHASES.LOBBY) {
        this.removePlayer(pid);
        this.cancelCountdown();
      } else {
        p.connected = false;
      }
    }
    if (this.hostId === pid && !this.member(pid)) this.hostId = (this.players[0] || this.spectators[0])?.id || null;
    this.touch();
  }

  setConnected(pid, connected) {
    const p = this.member(pid);
    if (!p) return;
    p.connected = connected;
    // a host who drops out of the lobby keeps the role for a while (a refresh, a flaky phone)
    if (this.hostTimer && this.hostTimer.pid === pid) { this.clearTimer(this.hostTimer.handle); this.hostTimer = null; }
    if (!connected && this.phase === PHASES.LOBBY && this.hostId === pid) {
      this.hostTimer = { pid, handle: this.setTimer(() => {
        this.hostTimer = null;
        const host = this.member(pid);
        if (this.hostId !== pid || (host && host.connected) || this.phase !== PHASES.LOBBY) return;
        const next = [...this.players, ...this.spectators].find(x => x.connected);
        if (next) { this.hostId = next.id; this.touch(); }
      }, HOST_GRACE_MS) };
    }
    this.touch();
  }

  requireHost(pid) {
    this.assert(pid === this.hostId, 'err.hostOnly');
  }

  kick(pid, targetId) {
    this.requireHost(pid);
    this.assert(this.phase === PHASES.LOBBY, 'err.kickLobbyOnly');
    this.assert(targetId !== pid, 'err.kickSelf');
    this.assert(this.member(targetId), 'err.invalidTarget');
    this.leave(targetId);
  }

  updateSettings(pid, s) {
    this.requireHost(pid);
    this.assert(this.phase === PHASES.LOBBY, 'err.settingsLobbyOnly');
    this.cancelCountdown();
    if (s.speechSeconds !== undefined) {
      const v = Number(s.speechSeconds);
      this.assert(Number.isInteger(v) && v >= 10 && v <= 600, 'err.speechRange', { min: 10, max: 600 });
      this.settings.speechSeconds = v;
    }
    if (s.voteSeconds !== undefined) {
      const v = Number(s.voteSeconds);
      this.assert(Number.isInteger(v) && (v === 0 || (v >= 30 && v <= 900)), 'err.voteRange', { min: 30, max: 900 });
      this.settings.voteSeconds = v;
    }
    if (s.nightSeconds !== undefined) {
      const v = Number(s.nightSeconds);
      this.assert(Number.isInteger(v) && (v === 0 || (v >= 30 && v <= 900)), 'err.nightRange', { min: 30, max: 900 });
      this.settings.nightSeconds = v;
    }
    if (s.revealRoleOnDeath !== undefined) this.settings.revealRoleOnDeath = !!s.revealRoleOnDeath;
    if (s.firstNightKill !== undefined) this.settings.firstNightKill = !!s.firstNightKill;
    if (s.family !== undefined) this.settings.family = !!s.family;
    if (s.transcripts !== undefined) this.settings.transcripts = !!s.transcripts;
    if (s.roleCounts !== undefined) {
      if (s.roleCounts === null) {
        this.settings.roleCounts = null;
      } else {
        const c = {
          mafia: Number(s.roleCounts.mafia), cop: Number(s.roleCounts.cop),
          doctor: Number(s.roleCounts.doctor), hooker: Number(s.roleCounts.hooker),
        };
        // only validate player-count-dependent rules at start; here check shape
        for (const k of Object.keys(c)) this.assert(Number.isInteger(c[k]) && c[k] >= 0 && c[k] <= MAX_PLAYERS, 'err.invalidCount', { role: k });
        this.settings.roleCounts = c;
      }
    }
    this.touch();
  }

  start(pid) {
    this.requireHost(pid);
    this.assert(this.phase === PHASES.LOBBY, 'err.gameStarted');
    const n = this.players.length;
    this.assert(n >= MIN_PLAYERS, 'err.needPlayers', { min: MIN_PLAYERS });
    const counts = this.effectiveRoleCounts();
    const err = validateRoleCounts(counts, n);
    this.assert(!err, err?.key, err?.params);

    const deck = [];
    for (const [role, c] of Object.entries(counts)) for (let i = 0; i < c; i++) deck.push(role);
    while (deck.length < n) deck.push(ROLES.CITIZEN);
    const shuffled = shuffle(deck, this.rng);
    this.players.forEach((p, i) => { p.role = shuffled[i]; p.alive = true; });

    this.cancelCountdown();
    this.gameId = id();
    this.lastStarterSeat = null;
    this.startedAt = Date.now();
    this.addPublic('log.gameBegun');
    this.onStart(this);
    this.beginNight();
  }

  restart(pid) {
    this.requireHost(pid);
    this.assert(this.phase === PHASES.ENDED, 'err.gameRunning');
    this.players = this.players.filter(p => p.connected);
    this.spectators = this.spectators.filter(p => p.connected);
    this.players.forEach((p, i) => { p.seat = i; p.alive = true; p.role = null; p.ready = false; });
    if (!this.member(this.hostId)) this.hostId = (this.players[0] || this.spectators[0])?.id || null;
    this.resetGameState();
    this.touch();
  }

  // ---------- night ----------
  mafiaKillsTonight() {
    return this.day > 1 || this.settings.firstNightKill;
  }

  hasNightAction(p) {
    if (p.role === ROLES.CITIZEN) return false;
    if (p.role === ROLES.MAFIA) return this.mafiaKillsTonight();
    return true;
  }

  actorsForNight() {
    return this.alive().filter(p => this.hasNightAction(p));
  }

  beginNight() {
    this.day += 1;
    this.phase = PHASES.NIGHT;
    this.nightActions = {};
    this.votes = {};
    this.speech = null;
    this.cancelTimer();
    this.nightEndsAt = this.settings.nightSeconds ? Date.now() + this.settings.nightSeconds * 1000 : null;
    if (this.nightEndsAt) this.scheduleNightTimer();
    this.addPublic(this.mafiaKillsTonight() ? 'log.nightFalls' : 'log.nightFallsNoKill', { n: this.day });
    this.touch();
  }

  scheduleNightTimer() {
    this.scheduleTimer(PHASES.NIGHT, this.nightEndsAt, () => {
      this.addPublic('log.nightTimeUp');
      this.resolveNight();
    });
  }

  validNightTargets(p) {
    const alive = this.alive();
    switch (p.role) {
      case ROLES.MAFIA: return alive.filter(t => t.role !== ROLES.MAFIA).map(t => t.id);
      case ROLES.COP: return alive.filter(t => t.id !== p.id).map(t => t.id);
      case ROLES.HOOKER: return alive.filter(t => t.id !== p.id).map(t => t.id);
      case ROLES.DOCTOR: return alive
        .filter(t => t.id !== this.lastDoctorTarget && !(t.id === p.id && this.doctorSelfHealUsed))
        .map(t => t.id);
      default: return [];
    }
  }

  nightAction(pid, targetId) {
    this.assert(this.phase === PHASES.NIGHT, 'err.notNight');
    const p = this.player(pid);
    this.assert(p && p.alive, 'err.deadCannotAct');
    this.assert(this.hasNightAction(p), 'err.noActionTonight');
    const nobody = targetId === NOBODY && CAN_PICK_NOBODY.includes(p.role);
    this.assert(nobody || this.validNightTargets(p).includes(targetId), 'err.invalidTarget');
    this.nightActions[pid] = targetId;
    const pending = this.actorsForNight().filter(a => !(a.id in this.nightActions));
    if (pending.length === 0) this.resolveNight();
    else this.touch();
  }

  forceEndNight(pid) {
    this.requireHost(pid);
    this.assert(this.phase === PHASES.NIGHT, 'err.notNight');
    this.resolveNight();
  }

  resolveNight() {
    this.cancelTimer();
    this.nightEndsAt = null;
    const actors = this.actorsForNight();
    const actionOf = role => actors.filter(a => a.role === role && a.id in this.nightActions);

    // 1. Hooker blocks
    const blocked = new Set();
    for (const h of actionOf(ROLES.HOOKER)) {
      const t = this.nightActions[h.id];
      blocked.add(t);
      this.addPrivate(t, 'log.hookerVisited');
    }

    // 2. Mafia kill: plurality of mafia votes, tie = no kill.
    // The Hooker visiting any Mafia member cancels the whole kill, however many Mafia are alive.
    const tally = {};
    const mafiaBlocked = this.alive().some(p => p.role === ROLES.MAFIA && blocked.has(p.id));
    for (const m of actionOf(ROLES.MAFIA)) {
      if (mafiaBlocked) break;
      const t = this.nightActions[m.id];
      tally[t] = (tally[t] || 0) + 1;
    }
    let killTarget = null;
    const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    if (ranked.length && (ranked.length === 1 || ranked[0][1] > ranked[1][1])) killTarget = ranked[0][0];
    if (killTarget === NOBODY) killTarget = null; // most Mafia chose to kill nobody

    // 3. Doctor heals
    let healed = null;
    const docs = actionOf(ROLES.DOCTOR);
    for (const d of docs) {
      if (!blocked.has(d.id) && this.nightActions[d.id] !== NOBODY) healed = this.nightActions[d.id];
    }
    // restrictions track who the Doctor chose, even if the Hooker blocked it; choosing nobody frees everyone
    const docChoice = docs.length ? this.nightActions[docs[0].id] : NOBODY;
    this.lastDoctorTarget = docChoice === NOBODY ? null : docChoice;
    if (docs.some(d => this.nightActions[d.id] === d.id)) this.doctorSelfHealUsed = true;

    // 4. Cop checks
    for (const c of actionOf(ROLES.COP)) {
      if (blocked.has(c.id)) continue;
      const t = this.player(this.nightActions[c.id]);
      this.addPrivate(c.id, 'log.copResult', { name: t.name, mafia: t.role === ROLES.MAFIA });
    }

    // 5. Apply
    const killed = killTarget && killTarget !== healed ? this.player(killTarget) : null;
    this.history.push({
      type: 'night',
      day: this.day,
      actions: actors.filter(a => a.id in this.nightActions)
        .map(a => ({ actor: a.id, role: a.role, target: this.nightActions[a.id], blocked: blocked.has(a.id) })),
      killed: killed ? killed.id : null,
      saved: killTarget && killTarget === healed ? killTarget : null,
    });
    if (killed) {
      killed.alive = false;
      this.addPublic('log.morningKilled', { n: this.day, name: killed.name, role: this.revealedRole(killed) });
    } else {
      this.addPublic('log.morningNobody', { n: this.day });
    }

    if (this.checkWin()) return;
    this.beginSpeeches();
  }

  revealedRole(p) {
    return this.settings.revealRoleOnDeath ? p.role : null;
  }

  // ---------- day: speeches ----------
  beginSpeeches() {
    const alive = this.alive();
    // rotate: start from the first living player seated after the previous day's starter
    let startIdx;
    if (this.lastStarterSeat === null) {
      startIdx = Math.floor(this.rng() * alive.length);
    } else {
      startIdx = alive.findIndex(p => p.seat > this.lastStarterSeat);
      if (startIdx === -1) startIdx = 0;
    }
    const order = alive.slice(startIdx).concat(alive.slice(0, startIdx)).map(p => p.id);
    this.lastStarterSeat = this.player(order[0]).seat;
    this.phase = PHASES.SPEECH;
    this.speech = { order, index: -1, endsAt: null };
    this.addPublic('log.discussionOpens', { n: this.day, name: this.player(order[0]).name });
    this.nextSpeaker();
  }

  nextSpeaker() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.speech.index += 1;
    // skip anyone who died mid-day (not currently possible, but cheap to guard)
    while (this.speech.index < this.speech.order.length && !this.player(this.speech.order[this.speech.index]).alive) {
      this.speech.index += 1;
    }
    if (this.speech.index >= this.speech.order.length) {
      this.beginVote();
      return;
    }
    this.speech.endsAt = Date.now() + this.settings.speechSeconds * 1000;
    this.speech.extended = false;
    this.scheduleSpeechTimer();
    this.touch();
  }

  // One phase timer at a time; a timer that was replaced or outlived its phase does nothing.
  scheduleTimer(phase, endsAt, fn) {
    if (this.timer) this.clearTimer(this.timer);
    const seq = this.timerSeq = (this.timerSeq || 0) + 1;
    this.timer = this.setTimer(() => {
      if (this.phase === phase && this.timerSeq === seq) fn();
    }, Math.max(0, endsAt - Date.now()));
  }

  cancelTimer() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.timerSeq = (this.timerSeq || 0) + 1;
  }

  scheduleSpeechTimer() {
    this.scheduleTimer(PHASES.SPEECH, this.speech.endsAt, () => this.nextSpeaker());
  }

  scheduleVoteTimer() {
    this.scheduleTimer(PHASES.VOTE, this.voteEndsAt, () => {
      this.addPublic('log.voteTimeUp');
      this.resolveVote();
    });
  }

  // +30 s: the speaker can ask once per speech, the host as often as needed
  extendSpeech(pid) {
    this.assert(this.phase === PHASES.SPEECH, 'err.noSpeech');
    const current = this.speech.order[this.speech.index];
    this.assert(pid === current || pid === this.hostId, 'err.speakerOrHost');
    if (pid !== this.hostId) {
      this.assert(!this.speech.extended, 'err.alreadyExtended');
      this.speech.extended = true;
    }
    this.speech.endsAt += EXTEND_MS;
    this.scheduleSpeechTimer();
    this.addPublic('log.speechExtended', { name: this.player(current).name });
    this.touch();
  }

  endSpeech(pid) {
    this.assert(this.phase === PHASES.SPEECH, 'err.noSpeech');
    const current = this.speech.order[this.speech.index];
    this.assert(pid === current || pid === this.hostId, 'err.speakerOrHost');
    this.nextSpeaker();
  }

  skipToVote(pid) {
    this.requireHost(pid);
    this.assert(this.phase === PHASES.SPEECH, 'err.noDiscussion');
    this.speech.index = this.speech.order.length - 1;
    this.nextSpeaker();
  }

  // ---------- day: vote ----------
  beginVote() {
    this.phase = PHASES.VOTE;
    this.votes = {};
    if (this.speech) this.speech.endsAt = null;
    this.cancelTimer();
    this.voteEndsAt = this.settings.voteSeconds ? Date.now() + this.settings.voteSeconds * 1000 : null;
    if (this.voteEndsAt) this.scheduleVoteTimer();
    this.addPublic('log.votingOpen', { n: this.day });
    this.touch();
  }

  vote(pid, targetId) {
    this.assert(this.phase === PHASES.VOTE, 'err.votingClosed');
    const p = this.player(pid);
    this.assert(p && p.alive, 'err.deadCannotVote');
    if (targetId !== 'skip') {
      const t = this.player(targetId);
      this.assert(t && t.alive && t.id !== pid, 'err.invalidVoteTarget');
    }
    this.votes[pid] = targetId;
    if (this.alive().every(a => a.id in this.votes)) this.resolveVote();
    else this.touch();
  }

  forceEndVote(pid) {
    this.requireHost(pid);
    this.assert(this.phase === PHASES.VOTE, 'err.votingClosed');
    this.resolveVote();
  }

  resolveVote() {
    this.cancelTimer();
    this.voteEndsAt = null;
    const tally = {};
    let skips = 0;
    for (const t of Object.values(this.votes)) {
      if (t === 'skip') skips++;
      else tally[t] = (tally[t] || 0) + 1;
    }
    const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    const tallyParam = ranked.map(([t, c]) => [this.player(t).name, c]);
    const outId = voteOutcome(this.votes);
    this.history.push({ type: 'vote', day: this.day, votes: { ...this.votes }, out: outId });
    if (outId) {
      const out = this.player(outId);
      out.alive = false;
      this.addPublic('log.votedOut', { name: out.name, role: this.revealedRole(out), tally: tallyParam, skips });
    } else {
      this.addPublic('log.noneVotedOut', { tally: tallyParam, skips });
    }
    if (this.checkWin()) return;
    this.beginNight();
  }

  // ---------- chat ----------
  inGame() {
    return this.phase === PHASES.NIGHT || this.phase === PHASES.SPEECH || this.phase === PHASES.VOTE;
  }

  canChat(p, channel) {
    if (!p) return false;
    if (channel === 'mafia') return p.role === ROLES.MAFIA && p.alive && this.phase === PHASES.NIGHT;
    // the graveyard: dead players and spectators, who can't influence the living
    if (channel === 'dead') return !p.alive && this.inGame();
    if (channel !== 'town') return false;
    if (this.phase === PHASES.LOBBY || this.phase === PHASES.ENDED) return true;
    return this.phase !== PHASES.NIGHT && p.alive;
  }

  sendChat(pid, channel, text) {
    const p = this.member(pid); // spectators talk in the lobby, after the game, and in the graveyard
    this.assert(this.canChat(p, channel), 'err.chatClosed');
    text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX_LEN);
    this.assert(text, 'err.chatEmpty');
    const now = Date.now();
    this.assert(now - (this.lastChatAt[pid] || 0) >= CHAT_MIN_GAP_MS, 'err.chatTooFast');
    this.lastChatAt[pid] = now;
    const list = this.chat[channel];
    // names are stored too: lobby players can leave, and their messages should still read right
    list.push({ id: id(4), from: pid, name: p.name, text, at: now, day: this.day, phase: this.phase });
    if (list.length > CHAT_KEEP) list.splice(0, list.length - CHAT_KEEP);
    this.touch();
  }

  // A player who is out shows their role to the others in the graveyard chat.
  revealRole(pid) {
    const p = this.player(pid);
    this.assert(this.canChat(p, 'dead'), 'err.chatClosed');
    this.assert(!this.revealedRoles[pid], 'err.alreadyRevealed');
    this.revealedRoles[pid] = true;
    this.chat.dead.push({ id: id(4), from: pid, name: p.name, kind: 'reveal', role: p.role, at: Date.now(), day: this.day, phase: this.phase });
    this.touch();
  }

  // ---------- decency ratings, after the game ----------
  rate(pid, targetId, value) {
    this.assert(this.phase === PHASES.ENDED, 'err.rateAfterGame');
    this.assert(!this.settings.family, 'err.familyNoRatings');
    const p = this.player(pid);
    const target = this.player(targetId);
    this.assert(p && target && pid !== targetId && p.role && target.role, 'err.invalidTarget');
    this.assert(p.userId && target.userId, 'err.rateAccounts');
    this.assert([1, -1, 0].includes(value), 'err.invalidTarget');
    const mine = (this.ratings[pid] ||= {});
    const old = mine[targetId] || 0;
    if (old === value) return;
    if (value) mine[targetId] = value; else delete mine[targetId];
    this.onRate(target.userId, old, value, p.userId);
    this.touch();
  }

  // ---------- emoji reactions ----------
  // Not stored: the server just relays them. Dead players and spectators can't react during
  // a game (they could hint at roles), and nobody reacts at night.
  react(pid, emoji) {
    const p = this.member(pid);
    // the base set, plus any reaction items this player owns
    const owned = (p && p.userId && this.profileOf(p.userId)?.reactions) || [];
    this.assert(p && (REACTIONS.includes(emoji) || owned.includes(emoji)), 'err.invalidTarget');
    const open = this.phase === PHASES.LOBBY || this.phase === PHASES.ENDED
      || ((this.phase === PHASES.SPEECH || this.phase === PHASES.VOTE) && p.alive === true);
    this.assert(open, 'err.reactClosed');
    const now = Date.now();
    this.assert(now - (this.lastReactAt[pid] || 0) >= REACT_MIN_GAP_MS, 'err.chatTooFast');
    this.lastReactAt[pid] = now;
    return { from: pid, emoji, id: id(4) };
  }

  // ---------- win ----------
  checkWin() {
    const alive = this.alive();
    const mafia = alive.filter(p => p.role === ROLES.MAFIA).length;
    const town = alive.length - mafia;
    let winner = null;
    if (mafia === 0) winner = 'town';
    else if (mafia >= town) winner = 'mafia';
    if (!winner) return false;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.winner = winner;
    this.phase = PHASES.ENDED;
    this.speech = null;
    this.addPublic(winner === 'town' ? 'log.townWins' : 'log.mafiaWins');
    this.onGameEnd(this.gameResults(winner));
    this.onArchive(this.archiveRecord(winner));
    this.touch();
    return true;
  }

  // What each account holder did this game, for lifetime stats and the playstyle pentagon.
  gameResults(winner) {
    const roleOf = id => this.player(id)?.role;
    const at = Date.now();
    return this.players.filter(p => p.userId && p.role).map(p => {
      const r = {
        userId: p.userId, role: p.role, team: ROLE_INFO[p.role].team, won: ROLE_INFO[p.role].team === winner, survived: p.alive,
        votes: 0, votesOnMafia: 0, votesMatched: 0, ballots: 0, decisive: 0, mafiaVotedOut: 0,
        kills: 0, saves: 0, copHits: 0, players: this.players.length, at,
      };
      for (const h of this.history) {
        if (h.type === 'vote') {
          // Only the final vote counts, so simultaneous voting and changed minds don't matter.
          const target = h.votes[p.id];
          if (!target) continue;
          r.ballots += 1;
          // decisive: without this vote the result would have been different
          const without = { ...h.votes };
          delete without[p.id];
          if (voteOutcome(without) !== h.out) r.decisive += 1;
          if (target === 'skip') continue;
          r.votes += 1;
          if (roleOf(target) === ROLES.MAFIA) r.votesOnMafia += 1; // only counted for Town players' intuition
          if (target === h.out) r.votesMatched += 1;
          if (target === h.out && roleOf(target) === ROLES.MAFIA && r.team === 'town') r.mafiaVotedOut += 1;
        } else {
          for (const a of h.actions) {
            if (a.actor !== p.id || a.blocked) continue;
            if (a.role === ROLES.MAFIA && h.killed && a.target === h.killed) r.kills += 1;
            if (a.role === ROLES.DOCTOR && h.saved && a.target === h.saved) r.saves += 1;
            if (a.role === ROLES.COP && roleOf(a.target) === ROLES.MAFIA) r.copHits += 1;
          }
        }
      }
      return r;
    });
  }

  // A line of speech recognised on a player's own device (each phone transcribes only its owner).
  addTranscript(pid, text) {
    this.assert(this.settings.transcripts, 'err.transcriptsOff');
    this.assert(this.phase !== PHASES.LOBBY, 'err.gameNotRunning');
    const m = this.member(pid);
    this.assert(m, 'err.notInRoom');
    text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, TRANSCRIPT_MAX_CHARS);
    if (!text) return;
    const p = this.player(pid);
    const channel = !p || !p.alive ? 'dead' : this.phase === PHASES.NIGHT ? (p.role === ROLES.MAFIA ? 'mafia' : 'night') : 'town';
    this.transcript.push({ pid, name: m.name, text, at: Date.now(), phase: this.phase, day: this.day, channel });
    if (this.transcript.length > TRANSCRIPT_KEEP) this.transcript.splice(0, this.transcript.length - TRANSCRIPT_KEEP);
    this.lastActivity = Date.now(); // no broadcast: nobody sees it until the game ends
  }

  setInsights(gameId, insights) {
    if (this.gameId !== gameId) return;
    this.insights = insights;
    this.touch();
  }

  // A finished game for the archive: who played what, and how the days went.
  archiveRecord(winner) {
    const name = id => this.player(id)?.name || '?';
    return {
      game: 'mafia', code: this.code, tableId: this.tableId, startedAt: this.startedAt || null, endedAt: Date.now(),
      days: this.day, winner, family: !!this.settings.family,
      players: this.players.filter(p => p.role).map(p => ({
        userId: p.userId || null, name: p.name, role: p.role, team: ROLE_INFO[p.role].team, survived: p.alive, won: ROLE_INFO[p.role].team === winner,
      })),
      gameId: this.gameId,
      transcript: this.transcript.map(({ name, text, at, phase, day, channel }) => ({ name, text, at, phase, day, channel })),
      timeline: this.history.map(h => (h.type === 'vote'
        ? { type: 'vote', day: h.day, out: h.out ? name(h.out) : null }
        : { type: 'night', day: h.day, killed: h.killed ? name(h.killed) : null, saved: !!h.saved })),
    };
  }

  // ---------- host renames, in the lobby ----------
  // Only the name shown in this room changes; the account keeps its username.
  rename(pid, targetId, name) {
    this.requireHost(pid);
    this.assert(this.phase === PHASES.LOBBY, 'err.settingsLobbyOnly');
    const target = this.member(targetId);
    this.assert(target, 'err.invalidTarget');
    name = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 20);
    this.assert(name, 'err.nameRequired');
    this.assert(![...this.players, ...this.spectators].some(p => p.id !== targetId && p.name.toLowerCase() === name.toLowerCase()), 'err.nameTaken');
    target.name = name;
    this.touch();
  }

  // ---------- per-player view ----------
  viewFor(pid) {
    const me = this.member(pid);
    const watching = !!this.spectator(pid);
    const ended = this.phase === PHASES.ENDED;
    const iAmMafia = me?.role === ROLES.MAFIA;
    const roleVisible = p =>
      ended || p.id === pid ||
      (iAmMafia && p.role === ROLES.MAFIA) ||
      (!p.alive && this.settings.revealRoleOnDeath && this.phase !== PHASES.LOBBY);

    const view = {
      code: this.code,
      phase: this.phase,
      day: this.day,
      gameId: this.gameId,
      hostId: this.hostId,
      serverNow: Date.now(),
      settings: { ...this.settings },
      roleCounts: this.effectiveRoleCounts(),
      roleCountsError: this.phase === PHASES.LOBBY ? validateRoleCounts(this.effectiveRoleCounts(), this.players.length) : null,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      players: this.players.map(p => {
        const profile = p.userId ? this.profileOf(p.userId) : null;
        return {
          id: p.id, userId: p.userId, name: p.name, seat: p.seat, alive: p.alive, connected: p.connected,
          role: roleVisible(p) ? p.role : null,
          avatar: profile?.avatar || null,
          score: profile ? profile.score : null,
          cos: profile?.equipped || {},
          title: profile?.title || null,
          rateable: !!p.userId,
          ready: !!p.ready,
        };
      }),
      spectators: this.spectators.map(p => {
        const profile = p.userId ? this.profileOf(p.userId) : null;
        return { id: p.id, userId: p.userId, name: p.name, connected: p.connected, avatar: profile?.avatar || null, score: profile ? profile.score : null, cos: profile?.equipped || {}, title: profile?.title || null };
      }),
      countdownEndsAt: this.countdownEndsAt,
      nightEndsAt: this.phase === PHASES.NIGHT ? this.nightEndsAt : null,
      me: me ? {
        id: me.id, name: me.name, role: watching ? null : me.role, alive: watching ? false : me.alive, spectator: watching,
        revealed: !!this.revealedRoles[pid], rateable: !watching && !!me.userId,
      } : null,
      myRatings: (me && this.ratings[pid]) || {},
      roleInfo: ROLE_INFO,
      log: this.log,
      privateLog: this.privateLog[pid] || [],
      winner: this.winner,
      transcript: ended ? this.transcript : undefined,
      insights: ended ? this.insights : undefined,
      history: ended ? this.history : this.history.filter(h => h.type === 'vote'),
      // the Mafia's chat is theirs alone until the game ends
      chat: {
        town: this.chat.town,
        mafia: iAmMafia || ended ? this.chat.mafia : null,
        dead: (me && !me.alive && this.phase !== PHASES.LOBBY) || ended ? this.chat.dead : null,
        canPost: { town: this.canChat(me, 'town'), mafia: this.canChat(me, 'mafia'), dead: this.canChat(me, 'dead') },
      },
    };

    if (this.phase === PHASES.NIGHT && me && !watching) {
      view.night = {
        myTarget: this.nightActions[pid] || null,
        validTargets: me.alive && this.hasNightAction(me) ? this.validNightTargets(me) : [],
        hasAction: me.alive && this.hasNightAction(me),
        mafiaKills: this.mafiaKillsTonight(),
      };
      if (iAmMafia) {
        view.night.mafiaVotes = Object.fromEntries(
          this.players.filter(p => p.role === ROLES.MAFIA && p.id in this.nightActions).map(p => [p.id, this.nightActions[p.id]]),
        );
      }
    }
    if (this.speech && this.phase === PHASES.SPEECH) {
      view.speech = { ...this.speech, current: this.speech.order[this.speech.index] };
    }
    if (this.phase === PHASES.VOTE) {
      view.votes = { ...this.votes };
      view.voteEndsAt = this.voteEndsAt;
    }
    // who has voted is public; who acted at night is not (it would reveal who has a role)
    return view;
  }
}

module.exports = { voteOutcome, REACTIONS, NOBODY, Room, GameError, ROLES, ROLE_INFO, PHASES, defaultRoleCounts, validateRoleCounts, MIN_PLAYERS, MAX_PLAYERS, EXTEND_MS };
