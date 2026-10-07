'use strict';

const crypto = require('crypto');

const ROLES = {
  CITIZEN: 'citizen',
  MAFIA: 'mafia',
  COP: 'cop',
  DOCTOR: 'doctor',
  HOOKER: 'hooker',
};

const ROLE_INFO = {
  citizen: { name: 'Citizen', team: 'town', blurb: 'Find the Mafia and vote them out during the day.' },
  mafia: { name: 'Mafia', team: 'mafia', blurb: 'Each night, agree with your fellow Mafia on someone to kill. Outnumber the town to win.' },
  cop: { name: 'Cop', team: 'town', blurb: 'Each night, check one player and learn whether they are Mafia.' },
  doctor: { name: 'Doctor', team: 'town', blurb: 'Each night, protect one player from being killed. You can protect yourself, but not the same player two nights in a row.' },
  hooker: { name: 'Hooker', team: 'town', blurb: 'Each night, visit one player. Their night action is blocked.' },
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
    hooker: n >= 7 ? 1 : 0,
  };
}

function validateRoleCounts(counts, n) {
  for (const k of ['mafia', 'cop', 'doctor', 'hooker']) {
    if (!Number.isInteger(counts[k]) || counts[k] < 0) return `Invalid count for ${k}`;
  }
  if (counts.cop > 1 || counts.doctor > 1 || counts.hooker > 1) return 'Cop, Doctor and Hooker are limited to one each';
  if (counts.mafia < 1) return 'Need at least one Mafia';
  const special = counts.mafia + counts.cop + counts.doctor + counts.hooker;
  if (special > n) return 'More roles than players';
  if (counts.mafia * 2 >= n) return 'Mafia must be fewer than half of the players';
  return null;
}

class GameError extends Error {}

class Room {
  constructor({ code, rng = Math.random, onChange = () => {}, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.code = code;
    this.rng = rng;
    this.onChange = onChange;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.players = []; // { id, token, name, seat, connected, alive, role }
    this.hostId = null;
    this.settings = { speechSeconds: 60, revealRoleOnDeath: true, roleCounts: null };
    this.resetGameState();
    this.lastActivity = Date.now();
  }

  resetGameState() {
    this.phase = PHASES.LOBBY;
    this.day = 0;
    this.nightActions = {}; // playerId -> targetId
    this.lastDoctorTarget = null;
    this.speech = null; // { order: [ids], index, endsAt }
    this.lastStarterSeat = null;
    this.votes = {}; // voterId -> targetId | 'skip'
    this.log = []; // public events { day, phase, text }
    this.privateLog = {}; // playerId -> [{ day, text }]
    this.winner = null;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  dispose() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  touch() {
    this.lastActivity = Date.now();
    this.onChange(this);
  }

  // ---------- helpers ----------
  player(pid) {
    return this.players.find(p => p.id === pid);
  }

  byToken(token) {
    return this.players.find(p => p.token === token);
  }

  alive() {
    return this.players.filter(p => p.alive).sort((a, b) => a.seat - b.seat);
  }

  assert(cond, msg) {
    if (!cond) throw new GameError(msg);
  }

  addPublic(text) {
    this.log.push({ day: this.day, phase: this.phase, text });
  }

  addPrivate(pid, text) {
    (this.privateLog[pid] ||= []).push({ day: this.day, text });
  }

  effectiveRoleCounts() {
    return this.settings.roleCounts || defaultRoleCounts(this.players.length);
  }

  // ---------- lobby ----------
  join(name) {
    name = String(name || '').trim().slice(0, 20);
    this.assert(name, 'Name is required');
    this.assert(this.phase === PHASES.LOBBY, 'Game already in progress');
    this.assert(this.players.length < MAX_PLAYERS, `Room is full (${MAX_PLAYERS} players max)`);
    this.assert(!this.players.some(p => p.name.toLowerCase() === name.toLowerCase()), 'Name already taken');
    const p = { id: id(), token: id(16), name, seat: this.players.length, connected: true, alive: true, role: null };
    this.players.push(p);
    if (!this.hostId) this.hostId = p.id;
    this.touch();
    return p;
  }

  leave(pid) {
    const p = this.player(pid);
    if (!p) return;
    if (this.phase === PHASES.LOBBY) {
      this.players = this.players.filter(x => x.id !== pid);
      this.players.forEach((x, i) => { x.seat = i; });
      if (this.hostId === pid) this.hostId = this.players[0]?.id || null;
      // a role setup made for a different player count is likely invalid now
      if (this.settings.roleCounts && validateRoleCounts(this.settings.roleCounts, this.players.length)) {
        this.settings.roleCounts = null;
      }
    } else {
      p.connected = false;
    }
    this.touch();
  }

  setConnected(pid, connected) {
    const p = this.player(pid);
    if (!p) return;
    p.connected = connected;
    if (!connected && this.phase === PHASES.LOBBY && this.hostId === pid) {
      const next = this.players.find(x => x.connected);
      if (next) this.hostId = next.id;
    }
    this.touch();
  }

  requireHost(pid) {
    this.assert(pid === this.hostId, 'Only the host can do that');
  }

  kick(pid, targetId) {
    this.requireHost(pid);
    this.assert(this.phase === PHASES.LOBBY, 'Can only kick in the lobby');
    this.assert(targetId !== pid, 'You cannot kick yourself');
    this.leave(targetId);
  }

  updateSettings(pid, s) {
    this.requireHost(pid);
    this.assert(this.phase === PHASES.LOBBY, 'Settings can only change in the lobby');
    if (s.speechSeconds !== undefined) {
      const v = Number(s.speechSeconds);
      this.assert(Number.isInteger(v) && v >= 10 && v <= 600, 'Speech time must be 10–600 seconds');
      this.settings.speechSeconds = v;
    }
    if (s.revealRoleOnDeath !== undefined) this.settings.revealRoleOnDeath = !!s.revealRoleOnDeath;
    if (s.roleCounts !== undefined) {
      if (s.roleCounts === null) {
        this.settings.roleCounts = null;
      } else {
        const c = {
          mafia: Number(s.roleCounts.mafia), cop: Number(s.roleCounts.cop),
          doctor: Number(s.roleCounts.doctor), hooker: Number(s.roleCounts.hooker),
        };
        // only validate player-count-dependent rules at start; here check shape
        for (const k of Object.keys(c)) this.assert(Number.isInteger(c[k]) && c[k] >= 0 && c[k] <= MAX_PLAYERS, `Invalid count for ${k}`);
        this.settings.roleCounts = c;
      }
    }
    this.touch();
  }

  start(pid) {
    this.requireHost(pid);
    this.assert(this.phase === PHASES.LOBBY, 'Game already started');
    const n = this.players.length;
    this.assert(n >= MIN_PLAYERS, `Need at least ${MIN_PLAYERS} players`);
    const counts = this.effectiveRoleCounts();
    const err = validateRoleCounts(counts, n);
    this.assert(!err, err);

    const deck = [];
    for (const [role, c] of Object.entries(counts)) for (let i = 0; i < c; i++) deck.push(role);
    while (deck.length < n) deck.push(ROLES.CITIZEN);
    const shuffled = shuffle(deck, this.rng);
    this.players.forEach((p, i) => { p.role = shuffled[i]; p.alive = true; });

    this.lastStarterSeat = null;
    this.addPublic('The game has begun. Roles have been dealt.');
    this.beginNight();
  }

  restart(pid) {
    this.requireHost(pid);
    this.assert(this.phase === PHASES.ENDED, 'Game is still running');
    this.players = this.players.filter(p => p.connected);
    this.players.forEach((p, i) => { p.seat = i; p.alive = true; p.role = null; });
    if (!this.player(this.hostId)) this.hostId = this.players[0]?.id || null;
    this.resetGameState();
    this.touch();
  }

  // ---------- night ----------
  actorsForNight() {
    return this.alive().filter(p => p.role !== ROLES.CITIZEN);
  }

  beginNight() {
    this.day += 1;
    this.phase = PHASES.NIGHT;
    this.nightActions = {};
    this.votes = {};
    this.speech = null;
    this.addPublic(`Night ${this.day} falls. The town sleeps.`);
    this.touch();
  }

  validNightTargets(p) {
    const alive = this.alive();
    switch (p.role) {
      case ROLES.MAFIA: return alive.filter(t => t.role !== ROLES.MAFIA).map(t => t.id);
      case ROLES.COP: return alive.filter(t => t.id !== p.id).map(t => t.id);
      case ROLES.HOOKER: return alive.filter(t => t.id !== p.id).map(t => t.id);
      case ROLES.DOCTOR: return alive.filter(t => t.id !== this.lastDoctorTarget).map(t => t.id);
      default: return [];
    }
  }

  nightAction(pid, targetId) {
    this.assert(this.phase === PHASES.NIGHT, 'It is not night');
    const p = this.player(pid);
    this.assert(p && p.alive, 'Dead players cannot act');
    this.assert(p.role !== ROLES.CITIZEN, 'Citizens have no night action');
    this.assert(this.validNightTargets(p).includes(targetId), 'Invalid target');
    this.nightActions[pid] = targetId;
    const pending = this.actorsForNight().filter(a => !(a.id in this.nightActions));
    if (pending.length === 0) this.resolveNight();
    else this.touch();
  }

  forceEndNight(pid) {
    this.requireHost(pid);
    this.assert(this.phase === PHASES.NIGHT, 'It is not night');
    this.resolveNight();
  }

  resolveNight() {
    const actors = this.actorsForNight();
    const actionOf = role => actors.filter(a => a.role === role && a.id in this.nightActions);

    // 1. Hooker blocks
    const blocked = new Set();
    for (const h of actionOf(ROLES.HOOKER)) {
      const t = this.nightActions[h.id];
      blocked.add(t);
      this.addPrivate(t, 'You were visited by the Hooker last night. Any night action you took had no effect.');
    }

    // 2. Mafia kill: plurality of unblocked mafia votes, tie = no kill
    const tally = {};
    for (const m of actionOf(ROLES.MAFIA)) {
      if (blocked.has(m.id)) continue;
      const t = this.nightActions[m.id];
      tally[t] = (tally[t] || 0) + 1;
    }
    let killTarget = null;
    const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    if (ranked.length && (ranked.length === 1 || ranked[0][1] > ranked[1][1])) killTarget = ranked[0][0];

    // 3. Doctor heals
    let healed = null;
    const docs = actionOf(ROLES.DOCTOR);
    for (const d of docs) {
      if (!blocked.has(d.id)) healed = this.nightActions[d.id];
    }
    // the restriction tracks who the doctor chose, even if blocked
    this.lastDoctorTarget = docs.length ? this.nightActions[docs[0].id] : null;

    // 4. Cop checks
    for (const c of actionOf(ROLES.COP)) {
      if (blocked.has(c.id)) continue;
      const t = this.player(this.nightActions[c.id]);
      this.addPrivate(c.id, `Your investigation: ${t.name} is ${t.role === ROLES.MAFIA ? 'MAFIA' : 'NOT Mafia'}.`);
    }

    // 5. Apply
    const killed = killTarget && killTarget !== healed ? this.player(killTarget) : null;
    if (killed) {
      killed.alive = false;
      this.addPublic(`Morning ${this.day}: ${killed.name} was killed during the night${this.roleSuffix(killed)}.`);
    } else {
      this.addPublic(`Morning ${this.day}: nobody died last night.`);
    }

    if (this.checkWin()) return;
    this.beginSpeeches();
  }

  roleSuffix(p) {
    return this.settings.revealRoleOnDeath ? ` — they were ${ROLE_INFO[p.role].name}` : '';
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
    this.addPublic(`Day ${this.day}: discussion opens with ${this.player(order[0]).name}.`);
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
    const ms = this.settings.speechSeconds * 1000;
    this.speech.endsAt = Date.now() + ms;
    const expectedIndex = this.speech.index;
    this.timer = this.setTimer(() => {
      if (this.phase === PHASES.SPEECH && this.speech.index === expectedIndex) this.nextSpeaker();
    }, ms);
    this.touch();
  }

  endSpeech(pid) {
    this.assert(this.phase === PHASES.SPEECH, 'No speech in progress');
    const current = this.speech.order[this.speech.index];
    this.assert(pid === current || pid === this.hostId, 'Only the speaker or host can end this speech');
    this.nextSpeaker();
  }

  skipToVote(pid) {
    this.requireHost(pid);
    this.assert(this.phase === PHASES.SPEECH, 'No discussion in progress');
    this.speech.index = this.speech.order.length - 1;
    this.nextSpeaker();
  }

  // ---------- day: vote ----------
  beginVote() {
    this.phase = PHASES.VOTE;
    this.votes = {};
    if (this.speech) this.speech.endsAt = null;
    this.addPublic(`Day ${this.day}: voting is open.`);
    this.touch();
  }

  vote(pid, targetId) {
    this.assert(this.phase === PHASES.VOTE, 'Voting is not open');
    const p = this.player(pid);
    this.assert(p && p.alive, 'Dead players cannot vote');
    if (targetId !== 'skip') {
      const t = this.player(targetId);
      this.assert(t && t.alive && t.id !== pid, 'Invalid vote target');
    }
    this.votes[pid] = targetId;
    if (this.alive().every(a => a.id in this.votes)) this.resolveVote();
    else this.touch();
  }

  forceEndVote(pid) {
    this.requireHost(pid);
    this.assert(this.phase === PHASES.VOTE, 'Voting is not open');
    this.resolveVote();
  }

  resolveVote() {
    const tally = {};
    let skips = 0;
    for (const t of Object.values(this.votes)) {
      if (t === 'skip') skips++;
      else tally[t] = (tally[t] || 0) + 1;
    }
    const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    const summary = ranked.map(([t, c]) => `${this.player(t).name} ${c}`).concat(skips ? [`skip ${skips}`] : []).join(', ') || 'no votes';
    const top = ranked[0];
    const clear = top && top[1] > skips && (ranked.length === 1 || top[1] > ranked[1][1]);
    if (clear) {
      const out = this.player(top[0]);
      out.alive = false;
      this.addPublic(`The town voted out ${out.name}${this.roleSuffix(out)}. (${summary})`);
    } else {
      this.addPublic(`No one was voted out. (${summary})`);
    }
    if (this.checkWin()) return;
    this.beginNight();
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
    this.addPublic(winner === 'town' ? 'All Mafia are gone. The Town wins!' : 'The Mafia have taken over the town. The Mafia wins!');
    this.touch();
    return true;
  }

  // ---------- per-player view ----------
  viewFor(pid) {
    const me = this.player(pid);
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
      hostId: this.hostId,
      serverNow: Date.now(),
      settings: { ...this.settings },
      roleCounts: this.effectiveRoleCounts(),
      roleCountsError: this.phase === PHASES.LOBBY ? validateRoleCounts(this.effectiveRoleCounts(), this.players.length) : null,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      players: this.players.map(p => ({
        id: p.id, name: p.name, seat: p.seat, alive: p.alive, connected: p.connected,
        role: roleVisible(p) ? p.role : null,
      })),
      me: me ? { id: me.id, name: me.name, role: me.role, alive: me.alive } : null,
      roleInfo: ROLE_INFO,
      log: this.log,
      privateLog: this.privateLog[pid] || [],
      winner: this.winner,
    };

    if (this.phase === PHASES.NIGHT && me) {
      view.night = {
        myTarget: this.nightActions[pid] || null,
        validTargets: me.alive ? this.validNightTargets(me) : [],
        pendingCount: this.actorsForNight().filter(a => !(a.id in this.nightActions)).length,
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
    if (this.phase === PHASES.VOTE) view.votes = { ...this.votes };
    return view;
  }
}

module.exports = { Room, GameError, ROLES, ROLE_INFO, PHASES, defaultRoleCounts, validateRoleCounts, MIN_PLAYERS, MAX_PLAYERS };
