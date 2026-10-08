'use strict';

// "Find the spy" (Spyfall). Everyone but the spy gets the same location and a role there; the
// spy only knows the list of possible locations. Players question each other (in voice); the app
// keeps whose turn it is to ask, the round clock, accusations and votes, the spy's guess and the
// score over several rounds. No I/O: timers and randomness are injected, like the other games.

const crypto = require('crypto');
const { GameError } = require('../game');
const { LOCATIONS, byId } = require('./locations');

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 12;
const MAX_SPECTATORS = 20;
const HOST_GRACE_MS = 30 * 1000;
const ACCUSE_MS = 60 * 1000; // to vote on an accusation (missing votes count as "no")
const FINAL_MS = 90 * 1000; // the vote when the round clock runs out
const VERDICTS = ['unanimous', 'majority'];
// points, as in the original rules
const POINTS = { spyTime: 2, spyWrongAccuse: 4, spyGuessed: 4, town: 1, accuser: 2 };

const SAVED_FIELDS = ['code', 'players', 'spectators', 'hostId', 'settings', 'phase', 'g', 'gameId', 'lastActivity', 'tableId'];
const id = (bytes = 6) => crypto.randomBytes(bytes).toString('hex');

class SpyRoom {
  constructor({
    code, rng = Math.random, onChange = () => {}, setTimer = setTimeout, clearTimer = clearTimeout,
    profileOf = () => null, onGameEnd = () => {}, onStart = () => {}, onArchive = () => {}, tableId = null,
    features = () => ({ family: true, voice: true, transcripts: true }),
  } = {}) {
    this.code = code;
    this.rng = rng;
    this.onChange = onChange;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.profileOf = profileOf;
    this.onGameEnd = onGameEnd;
    this.onStart = onStart;
    this.onArchive = onArchive;
    this.tableId = tableId;
    this.features = features;
    this.players = []; // { id, token, userId, name, connected, ready }
    this.spectators = [];
    this.hostId = null;
    this.settings = { rounds: 5, roundMinutes: 8, verdict: 'unanimous', voice: true };
    this.phase = 'lobby';
    this.g = null;
    this.gameId = null;
    this.timer = null;
    this.lastActivity = Date.now();
  }

  toJSON() { return Object.fromEntries(SAVED_FIELDS.map(k => [k, this[k]])); }

  static restore(data, opts = {}) {
    const room = new SpyRoom({ ...opts, code: data.code });
    const defaults = room.settings;
    for (const k of SAVED_FIELDS) if (data[k] !== undefined) room[k] = data[k];
    room.settings = { ...defaults, ...room.settings };
    for (const p of [...room.players, ...room.spectators]) p.connected = false;
    // a fresh clock for whatever was running when the server went down
    const r = room.g && room.g.round;
    if (room.phase === 'playing' && r) {
      if (r.stage === 'talk') r.endsAt = Math.max(r.endsAt, Date.now() + 60 * 1000);
      if (r.stage === 'accuse') r.accusation.endsAt = Date.now() + ACCUSE_MS;
      if (r.stage === 'final') r.final.endsAt = Date.now() + FINAL_MS;
      room.armTimer();
    }
    return room;
  }

  dispose() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    if (this.hostTimer) this.clearTimer(this.hostTimer.handle);
    this.hostTimer = null;
  }

  touch() {
    this.lastActivity = Date.now();
    this.armTimer();
    this.onChange(this);
  }

  assert(cond, key, params) { if (!cond) throw new GameError(key, params); }

  // ---------- members (as in the other games) ----------
  player(pid) { return this.players.find(p => p.id === pid); }
  spectator(pid) { return this.spectators.find(p => p.id === pid); }
  member(pid) { return this.player(pid) || this.spectator(pid); }
  byToken(token) { return [...this.players, ...this.spectators].find(p => p.token === token); }
  byUser(userId) { return userId ? [...this.players, ...this.spectators].find(p => p.userId === userId) : null; }
  nameOf(pid) { return this.member(pid)?.name || '?'; }
  requireHost(pid) { this.assert(pid === this.hostId, 'err.hostOnly'); }

  join(name, { userId = null, spectate = false } = {}) {
    name = String(name || '').trim().slice(0, 20);
    this.assert(name, 'err.nameRequired');
    this.assert(![...this.players, ...this.spectators].some(p => p.name.toLowerCase() === name.toLowerCase()), 'err.nameTaken');
    if (spectate || this.phase !== 'lobby' || this.players.length >= MAX_PLAYERS) {
      this.assert(this.spectators.length < MAX_SPECTATORS, 'err.roomFull', { max: MAX_SPECTATORS });
      const sp = { id: id(), token: id(16), userId, name, connected: true };
      this.spectators.push(sp);
      if (!this.hostId) this.hostId = sp.id;
      this.touch();
      return sp;
    }
    const p = { id: id(), token: id(16), userId, name, connected: true, ready: false };
    this.players.push(p);
    if (!this.hostId) this.hostId = p.id;
    this.touch();
    return p;
  }

  leave(pid) {
    if (this.spectator(pid)) this.spectators = this.spectators.filter(x => x.id !== pid);
    else if (this.player(pid)) {
      if (this.phase === 'lobby') this.players = this.players.filter(x => x.id !== pid);
      else this.player(pid).connected = false; // stays in the game: votes wait for the clock
    }
    if (this.hostId === pid && (!this.member(pid) || this.phase === 'lobby')) {
      this.hostId = (this.players.find(p => p.id !== pid) || this.spectators.find(p => p.id !== pid))?.id || null;
    }
    this.touch();
  }

  setConnected(pid, connected) {
    const p = this.member(pid);
    if (!p) return;
    p.connected = connected;
    if (this.hostTimer && this.hostTimer.pid === pid) { this.clearTimer(this.hostTimer.handle); this.hostTimer = null; }
    if (!connected && this.phase === 'lobby' && this.hostId === pid) {
      this.hostTimer = { pid, handle: this.setTimer(() => {
        this.hostTimer = null;
        const host = this.member(pid);
        if (this.hostId !== pid || (host && host.connected) || this.phase !== 'lobby') return;
        const next = [...this.players, ...this.spectators].find(x => x.connected);
        if (next) { this.hostId = next.id; this.touch(); }
      }, HOST_GRACE_MS) };
    }
    this.touch();
  }

  kick(pid, targetId) {
    this.requireHost(pid);
    this.assert(this.phase === 'lobby', 'err.kickLobbyOnly');
    this.assert(targetId !== pid && this.member(targetId), 'err.invalidTarget');
    this.leave(targetId);
  }

  setSpectating(pid, watch) {
    this.assert(this.phase === 'lobby', 'err.settingsLobbyOnly');
    const p = this.member(pid);
    this.assert(p, 'err.notInRoom');
    if (watch && this.player(pid)) {
      this.players = this.players.filter(x => x.id !== pid);
      this.spectators.push({ id: p.id, token: p.token, userId: p.userId, name: p.name, connected: p.connected });
    } else if (!watch && this.spectator(pid)) {
      this.assert(this.players.length < MAX_PLAYERS, 'err.roomFull', { max: MAX_PLAYERS });
      this.spectators = this.spectators.filter(x => x.id !== pid);
      this.players.push({ ...p, ready: false });
    }
    this.touch();
  }

  setReady(pid, ready) {
    this.assert(this.phase === 'lobby' && this.player(pid), 'err.notInRoom');
    this.player(pid).ready = !!ready;
    this.touch();
  }

  rename(pid, targetId, name) {
    this.requireHost(pid);
    this.assert(this.phase === 'lobby', 'err.settingsLobbyOnly');
    const target = this.member(targetId);
    this.assert(target, 'err.invalidTarget');
    name = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 20);
    this.assert(name, 'err.nameRequired');
    this.assert(![...this.players, ...this.spectators].some(p => p.id !== targetId && p.name.toLowerCase() === name.toLowerCase()), 'err.nameTaken');
    target.name = name;
    this.touch();
  }

  updateSettings(pid, s) {
    this.requireHost(pid);
    this.assert(this.phase === 'lobby', 'err.settingsLobbyOnly');
    if (s.rounds !== undefined) {
      const v = Number(s.rounds);
      this.assert(Number.isInteger(v) && v >= 1 && v <= 10, 'err.spy.roundsRange', { min: 1, max: 10 });
      this.settings.rounds = v;
    }
    if (s.roundMinutes !== undefined) {
      const v = Number(s.roundMinutes);
      this.assert(Number.isInteger(v) && v >= 3 && v <= 15, 'err.spy.minutesRange', { min: 3, max: 15 });
      this.settings.roundMinutes = v;
    }
    if (s.verdict !== undefined) {
      this.assert(VERDICTS.includes(s.verdict), 'err.invalidTarget');
      this.settings.verdict = s.verdict;
    }
    if (s.voice !== undefined) {
      this.assert(!s.voice || this.features().voice, 'err.featureOff');
      this.settings.voice = !!s.voice;
    }
    this.touch();
  }

  // ---------- the game ----------
  start(pid) {
    this.requireHost(pid);
    this.assert(this.phase === 'lobby', 'err.gameStarted');
    this.assert(this.players.length >= MIN_PLAYERS, 'err.needPlayers', { min: MIN_PLAYERS });
    const order = this.shuffle(this.players.map(p => p.id));
    this.gameId = id();
    this.g = {
      order,
      scores: Object.fromEntries(order.map(p => [p, 0])),
      roundN: 0,
      dealer: 0, // index into order: who asks first this round
      used: [], // locations already played in this game
      round: null,
      history: [], // finished rounds: { n, location, spy, result, points }
      startedAt: Date.now(),
    };
    for (const p of this.players) p.ready = false;
    this.phase = 'playing';
    this.onStart(this);
    this.startRound();
  }

  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  startRound() {
    const g = this.g;
    g.roundN += 1;
    if (g.used.length >= LOCATIONS.length) g.used = [];
    const pool = LOCATIONS.filter(l => !g.used.includes(l.id));
    const loc = pool[Math.floor(this.rng() * pool.length)];
    g.used.push(loc.id);
    const spy = g.order[Math.floor(this.rng() * g.order.length)];
    const roleOrder = this.shuffle(loc.roles.map((_, i) => i));
    const roles = {};
    let k = 0;
    for (const pid of g.order) if (pid !== spy) roles[pid] = roleOrder[k++ % roleOrder.length];
    const dealer = g.order[(g.dealer + g.roundN - 1) % g.order.length];
    g.round = {
      n: g.roundN, location: loc.id, spy, roles, dealer,
      endsAt: Date.now() + this.settings.roundMinutes * 60 * 1000,
      asker: dealer, lastAsker: null, asks: 0,
      stage: 'talk', // talk | accuse | final | reveal
      accusation: null, // { by, target, votes: { pid: true | false }, endsAt }
      accusers: [], // each player may accuse once per round
      final: null, // { votes: { pid: targetId }, endsAt }
      result: null,
    };
    this.touch();
  }

  get round() { return this.g && this.g.round; }

  requireStage(...stages) {
    this.assert(this.phase === 'playing' && this.round && stages.includes(this.round.stage), 'err.spy.notNow');
  }

  requirePlayer(pid) { this.assert(this.player(pid), 'err.notInRoom'); }

  // The asker questions someone; whoever was asked asks next (but not straight back).
  ask(pid, targetId) {
    this.requireStage('talk');
    const r = this.round;
    this.assert(r.asker === pid, 'err.spy.notYourQuestion');
    this.assert(targetId !== pid && this.player(targetId), 'err.invalidTarget');
    this.assert(targetId !== r.lastAsker || this.players.length <= 2, 'err.spy.noAskBack');
    r.lastAsker = pid;
    r.asker = targetId;
    r.asks += 1;
    this.touch();
  }

  // ---------- accusations: once per player per round; everyone else votes ----------
  accuse(pid, targetId) {
    this.requireStage('talk');
    this.requirePlayer(pid);
    const r = this.round;
    this.assert(!r.accusers.includes(pid), 'err.spy.accusedAlready');
    this.assert(targetId !== pid && this.player(targetId), 'err.invalidTarget');
    r.accusers.push(pid);
    r.accusation = { by: pid, target: targetId, votes: { [pid]: true }, endsAt: Date.now() + ACCUSE_MS };
    r.stage = 'accuse';
    this.touch();
    this.maybeResolveAccusation();
  }

  voteAccusation(pid, yes) {
    this.requireStage('accuse');
    this.requirePlayer(pid);
    const a = this.round.accusation;
    this.assert(pid !== a.target, 'err.spy.cantVoteOnYourself');
    a.votes[pid] = !!yes;
    this.touch();
    this.maybeResolveAccusation();
  }

  maybeResolveAccusation(force = false) {
    const r = this.round;
    const a = r.accusation;
    const voters = this.players.filter(p => p.id !== a.target).map(p => p.id);
    if (!force && voters.some(v => a.votes[v] === undefined)) return;
    const yes = voters.filter(v => a.votes[v] === true).length;
    const passed = this.settings.verdict === 'unanimous' ? yes === voters.length : yes * 2 > voters.length;
    if (passed) {
      return this.endRound(a.target === r.spy
        ? { winner: 'town', reason: 'caught', accused: a.target, by: a.by }
        : { winner: 'spy', reason: 'wrongAccuse', accused: a.target, by: a.by });
    }
    r.lastAccusation = { ...a, passed: false };
    r.accusation = null;
    // the clock may have run out meanwhile
    if (Date.now() >= r.endsAt) return this.startFinal();
    r.stage = 'talk';
    this.touch();
  }

  // ---------- the spy names the location (any time while talking or in the final vote) ----------
  spyGuess(pid, locationId) {
    this.requireStage('talk', 'final');
    const r = this.round;
    this.assert(pid === r.spy, 'err.spy.notTheSpy');
    this.assert(byId[locationId], 'err.invalidTarget');
    this.endRound(locationId === r.location
      ? { winner: 'spy', reason: 'guessed', guess: locationId }
      : { winner: 'town', reason: 'spyMissed', guess: locationId });
  }

  // ---------- time's up: everyone votes for who they think the spy is ----------
  startFinal() {
    const r = this.round;
    r.stage = 'final';
    r.accusation = null;
    r.final = { votes: {}, endsAt: Date.now() + FINAL_MS };
    this.touch();
  }

  finalVote(pid, targetId) {
    this.requireStage('final');
    this.requirePlayer(pid);
    this.assert(targetId !== pid && this.player(targetId), 'err.invalidTarget');
    this.round.final.votes[pid] = targetId;
    this.touch();
    if (this.players.every(p => this.round.final.votes[p.id])) this.resolveFinal();
  }

  resolveFinal() {
    const r = this.round;
    const tally = {};
    for (const t of Object.values(r.final.votes)) tally[t] = (tally[t] || 0) + 1;
    const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    const top = ranked[0];
    const tie = ranked[1] && ranked[1][1] === top[1];
    const others = this.players.length - 1; // everyone but the suspect may vote for them
    const passed = top && !tie && (this.settings.verdict === 'unanimous' ? top[1] === others : top[1] * 2 > others);
    this.endRound(passed && top[0] === r.spy
      ? { winner: 'town', reason: 'finalCaught', accused: top[0] }
      : { winner: 'spy', reason: passed ? 'finalWrong' : 'finalMissed', accused: passed ? top[0] : null });
  }

  endRound(result) {
    const g = this.g;
    const r = g.round;
    const points = {};
    if (result.winner === 'spy') {
      points[r.spy] = result.reason === 'guessed' ? POINTS.spyGuessed : result.reason === 'wrongAccuse' ? POINTS.spyWrongAccuse : POINTS.spyTime;
    } else {
      for (const pid of g.order) if (pid !== r.spy) points[pid] = POINTS.town;
      if (result.reason === 'caught') points[result.by] = POINTS.accuser;
    }
    for (const [pid, n] of Object.entries(points)) g.scores[pid] += n;
    r.result = result;
    r.points = points;
    r.stage = 'reveal';
    r.accusation = null;
    g.history.push({ n: r.n, location: r.location, spy: r.spy, result, points });
    this.dispose();
    this.touch();
  }

  // the host moves on: the next round, or the final scores after the last one
  next(pid) {
    this.requireHost(pid);
    this.requireStage('reveal');
    if (this.g.roundN >= this.settings.rounds) return this.endGame();
    this.startRound();
  }

  endGame() {
    this.phase = 'ended';
    this.dispose();
    const g = this.g;
    const best = Math.max(...Object.values(g.scores));
    g.winners = g.order.filter(pid => g.scores[pid] === best);
    this.onGameEnd(this.gameResults());
    this.onArchive(this.archiveRecord());
    this.touch();
  }

  restart(pid) {
    this.requireHost(pid);
    this.assert(this.phase === 'ended', 'err.gameRunning');
    this.players = this.players.filter(p => p.connected);
    this.spectators = this.spectators.filter(p => p.connected);
    if (!this.member(this.hostId)) this.hostId = (this.players[0] || this.spectators[0])?.id || null;
    this.phase = 'lobby';
    this.g = null;
    this.dispose();
    this.touch();
  }

  // ---------- one timer for whatever is running ----------
  armTimer() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    const r = this.round;
    if (this.phase !== 'playing' || !r) return;
    const at = r.stage === 'talk' ? r.endsAt : r.stage === 'accuse' ? r.accusation.endsAt : r.stage === 'final' ? r.final.endsAt : null;
    if (!at) return;
    const stage = r.stage;
    const n = r.n;
    this.timer = this.setTimer(() => {
      this.timer = null;
      const cur = this.round;
      if (this.phase !== 'playing' || !cur || cur.n !== n || cur.stage !== stage) return;
      if (stage === 'talk') this.startFinal();
      else if (stage === 'accuse') this.maybeResolveAccusation(true);
      else this.resolveFinal();
    }, Math.max(0, at - Date.now()));
  }

  // ---------- results ----------
  gameResults() {
    const g = this.g;
    return g.order.map(pid => {
      const p = this.player(pid);
      if (!p || !p.userId) return null;
      const spyRounds = g.history.filter(h => h.spy === pid);
      return {
        userId: p.userId,
        won: g.winners.includes(pid),
        points: g.scores[pid],
        rounds: g.history.length,
        spyRounds: spyRounds.length,
        spyWins: spyRounds.filter(h => h.result.winner === 'spy').length,
        guessed: spyRounds.filter(h => h.result.reason === 'guessed').length,
        townWins: g.history.filter(h => h.spy !== pid && h.result.winner === 'town').length,
        caught: g.history.filter(h => h.result.reason === 'caught' && h.result.by === pid).length,
        players: g.order.length,
        at: Date.now(),
      };
    }).filter(Boolean);
  }

  archiveRecord() {
    const g = this.g;
    const name = pid => this.nameOf(pid);
    return {
      game: 'spy', code: this.code, tableId: this.tableId, startedAt: g.startedAt, endedAt: Date.now(),
      winner: g.winners.map(name).join(', '),
      players: g.order.map(pid => ({ userId: this.player(pid)?.userId || null, name: name(pid), points: g.scores[pid], won: g.winners.includes(pid) }))
        .sort((a, b) => b.points - a.points),
      rounds: g.history.map(h => ({ n: h.n, location: h.location, spy: name(h.spy), winner: h.result.winner, reason: h.result.reason, accused: h.result.accused ? name(h.result.accused) : null })),
    };
  }

  // ---------- view: your own card is the only secret ----------
  viewFor(pid) {
    const me = this.member(pid);
    const decorate = p => {
      const profile = p.userId ? this.profileOf(p.userId) : null;
      return {
        id: p.id, userId: p.userId, name: p.name, connected: p.connected, ready: !!p.ready,
        avatar: profile?.avatar || null, score: profile ? profile.score : null, cos: profile?.equipped || {}, title: profile?.title || null,
      };
    };
    const view = {
      code: this.code,
      phase: this.phase,
      hostId: this.hostId,
      serverNow: Date.now(),
      settings: { ...this.settings },
      features: this.features(),
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      players: this.players.map(decorate),
      spectators: this.spectators.map(decorate),
      me: me ? { id: me.id, name: me.name, spectator: !!this.spectator(pid) } : null,
      gameId: this.gameId,
    };
    if (this.g) {
      const g = this.g;
      const r = g.round;
      const open = r && r.stage === 'reveal'; // the round's secrets once it's over
      view.game = {
        order: g.order, scores: g.scores, roundN: g.roundN, rounds: this.settings.rounds, winners: g.winners || null,
        history: g.history,
        round: r && {
          n: r.n, dealer: r.dealer, endsAt: r.endsAt, asker: r.asker, lastAsker: r.lastAsker, asks: r.asks, stage: r.stage,
          accusation: r.accusation, lastAccusation: r.lastAccusation || null, accusers: r.accusers,
          // the final vote is secret until it's counted: who has voted, not for whom
          final: r.final && { endsAt: r.final.endsAt, voted: Object.keys(r.final.votes), mine: r.final.votes[pid] || null, votes: open ? r.final.votes : undefined },
          result: r.result, points: r.points || null,
          spy: open ? r.spy : undefined,
          location: open ? r.location : undefined,
          roles: open ? r.roles : undefined,
        },
        // my card: the location and my role there, or that I'm the spy
        card: r && this.player(pid) ? (r.spy === pid ? { spy: true } : { location: r.location, role: r.roles[pid] }) : null,
      };
    }
    return view;
  }
}

module.exports = { SpyRoom, MIN_PLAYERS, MAX_PLAYERS, ACCUSE_MS, FINAL_MS, POINTS };
