'use strict';

// Citadels rules and state (no I/O). The base is the 2016 edition with the beginner set of
// nine characters (Witch, Thief, Magician, King, Abbot, Merchant, Architect, Diplomat, Queen),
// as on the house rules sheet. The classic Assassin, Bishop and Warlord can stand in for their
// rank, and everything else the lobby can tune lives in settings. 3–8 players; with 3 everyone
// plays two characters a round.

const crypto = require('crypto');
const { CHARACTERS, RANK_CHOICES, BASIC, UNIQUE, DISTRICTS, kindOf, info } = require('./cards');
const { GameError } = require('../game');

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 8;
const MAX_SPECTATORS = 20;
const LOG_KEEP = 300;
const BOT_DELAY_MS = 900; // a player who left plays on by themselves, this fast
const UNIQUE_KINDS = Object.keys(UNIQUE);

const id = (bytes = 6) => crypto.randomBytes(bytes).toString('hex');

const SAVED_FIELDS = ['code', 'players', 'spectators', 'hostId', 'settings', 'phase', 'g', 'gameId', 'lastActivity', 'tableId'];

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const rankOf = c => CHARACTERS[c].rank;

// Integer settings: [min, max, allowZero]
const INT_SETTINGS = {
  districtsToEnd: [5, 12],
  startGold: [0, 10],
  startCards: [0, 10],
  takeGold: [1, 5],
  drawCards: [1, 5],
  firstBonus: [0, 10],
  completeBonus: [0, 10],
  colorsBonus: [0, 10],
  uniqueCount: [0, UNIQUE_KINDS.length],
  turnSeconds: [30, 600, true],
  pickSeconds: [15, 300, true],
};

// The rules as on the house rules sheet; the lobby can change any of them.
function defaultSettings() {
  return {
    chars: { 1: 'witch', 5: 'abbot', 8: 'diplomat', 9: 'queen' }, // the pick for each rank with a choice
    districtsToEnd: 7, // a city this big ends the game after the round
    startGold: 2,
    startCards: 4,
    takeGold: 2, // "take gold" when gathering
    drawCards: 2, // "draw cards" when gathering: draw this many, keep one
    firstBonus: 4, // the first completed city
    completeBonus: 2, // other cities completed by the end
    colorsBonus: 3, // all five district types
    uniqueCount: 14, // unique districts shuffled into the deck, drawn from `uniques`
    uniques: UNIQUE_KINDS.slice(),
    kingFaceUp: false, // the King may be among the face-up discards
    turnSeconds: 120, // 0 = no limit; idle turns take gold and end
    pickSeconds: 60, // choosing a character; idle players get a random one
    voice: true, // voice chat in the room (when the site has it switched on)
  };
}

class CitRoom {
  // profileOf(userId) -> { avatar, score, equipped } for display; onGameEnd(results) for stats,
  // onArchive(record) for the game night archive, onStart(room) to remember a table's house rules
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
    this.players = []; // { id, token, userId, name, connected, ready, left }
    this.spectators = []; // { id, token, userId, name, connected }
    this.hostId = null;
    this.settings = defaultSettings();
    this.phase = 'lobby';
    this.g = null;
    this.gameId = null;
    this.timer = null;
    this.timerSeq = 0;
    this.lastActivity = Date.now();
  }

  toJSON() {
    return Object.fromEntries(SAVED_FIELDS.map(k => [k, this[k]]));
  }

  static restore(data, opts = {}) {
    const room = new CitRoom({ ...opts, code: data.code });
    const defaults = room.settings;
    for (const k of SAVED_FIELDS) if (data[k] !== undefined) room[k] = data[k];
    room.settings = { ...defaults, ...room.settings, chars: { ...defaults.chars, ...room.settings.chars } };
    for (const p of [...room.players, ...room.spectators]) p.connected = false;
    // whoever was acting gets a fresh clock after the downtime
    if (room.g && room.phase === 'playing') {
      if (room.g.sel) room.g.sel.endsAt = room.deadline(room.settings.pickSeconds);
      if (room.g.turn) room.g.turn.endsAt = room.deadline(room.settings.turnSeconds);
      room.armTimer();
    }
    return room;
  }

  dispose() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  touch() {
    this.lastActivity = Date.now();
    this.armTimer();
    this.onChange(this);
  }

  assert(cond, key, params) {
    if (!cond) throw new GameError(key, params);
  }

  // ---------- members ----------
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
    const p = { id: id(), token: id(16), userId, name, connected: true, ready: false, left: false };
    this.players.push(p);
    if (!this.hostId) this.hostId = p.id;
    this.touch();
    return p;
  }

  // In a running game a player who leaves keeps their seat and city; the game plays for them.
  leave(pid) {
    if (this.spectator(pid)) this.spectators = this.spectators.filter(x => x.id !== pid);
    else if (this.player(pid)) {
      if (this.phase === 'lobby') this.players = this.players.filter(x => x.id !== pid);
      else {
        const p = this.player(pid);
        p.connected = false;
        if (this.phase === 'playing' && !p.left) {
          p.left = true;
          this.addLog('cit.log.left', { name: p.name });
        }
      }
    }
    if (this.hostId === pid) {
      const others = [...this.players, ...this.spectators].filter(p => p.id !== pid);
      this.hostId = (others.find(p => p.connected && !p.left) || others.find(p => !p.left))?.id || null;
    }
    this.touch();
  }

  setConnected(pid, connected) {
    const p = this.member(pid);
    if (!p) return;
    p.connected = connected;
    if (!connected && this.phase === 'lobby' && this.hostId === pid) {
      const next = [...this.players, ...this.spectators].find(x => x.connected);
      if (next) this.hostId = next.id;
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
      this.players.push({ ...p, ready: false, left: false });
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
    for (const [k, [min, max, zero]] of Object.entries(INT_SETTINGS)) {
      if (s[k] === undefined) continue;
      const v = Number(s[k]);
      this.assert(Number.isInteger(v) && ((zero && v === 0) || (v >= min && v <= max)), zero ? 'err.cit.rangeOrZero' : 'err.cit.range', { setting: k, min, max });
      this.settings[k] = v;
    }
    if (s.chars && typeof s.chars === 'object') {
      for (const [rank, c] of Object.entries(s.chars)) {
        this.assert(RANK_CHOICES[rank] && RANK_CHOICES[rank].length > 1 && RANK_CHOICES[rank].includes(c), 'err.invalidTarget');
        this.settings.chars = { ...this.settings.chars, [rank]: c }; // a new object: a table's saved rules may share the old one
      }
    }
    if (Array.isArray(s.uniques)) {
      this.assert(s.uniques.every(k => UNIQUE[k]), 'err.invalidTarget');
      this.settings.uniques = UNIQUE_KINDS.filter(k => s.uniques.includes(k));
    }
    if (s.kingFaceUp !== undefined) this.settings.kingFaceUp = !!s.kingFaceUp;
    if (s.voice !== undefined) {
      this.assert(!s.voice || this.features().voice, 'err.featureOff');
      this.settings.voice = !!s.voice;
    }
    this.touch();
  }

  // ---------- game setup ----------
  // The characters in this game, in rank order.
  charactersFor(n) {
    const list = [];
    for (let rank = 1; rank <= 9; rank++) {
      const choices = RANK_CHOICES[rank];
      const c = choices.length > 1 ? this.settings.chars[rank] || choices[0] : choices[0];
      if (c === 'none' || (rank === 9 && n < 5)) continue;
      list.push(c);
    }
    return list;
  }

  start(pid) {
    this.requireHost(pid);
    this.assert(this.phase === 'lobby', 'err.gameStarted');
    this.assert(this.players.length >= MIN_PLAYERS, 'err.needPlayers', { min: MIN_PLAYERS });
    const s = this.settings;
    const order = shuffle(this.players.map(p => p.id), this.rng);
    const basic = Object.entries(BASIC).flatMap(([k, v]) => Array.from({ length: v.count }, (_, i) => `${k}.${i}`));
    const uniques = shuffle(s.uniques, this.rng).slice(0, s.uniqueCount).map(k => `${k}.0`);
    const blank = () => ({ built: 0, destroyed: 0, lost: 0, stolen: 0, robbedOf: 0, swaps: 0, kills: 0, chars: {}, goldGained: 0, cardsDrawn: 0 });
    this.gameId = id();
    this.g = {
      order,
      chars: this.charactersFor(order.length),
      perPlayer: order.length <= 3 ? 2 : 1, // characters each player picks a round
      deck: shuffle([...basic, ...uniques], this.rng), // top = index 0, bottom = the end
      players: Object.fromEntries(order.map(p => [p, { gold: s.startGold, hand: [], city: [], museum: [], stats: blank() }])),
      crown: order[Math.floor(this.rng() * order.length)],
      round: 0,
      stage: 'select', // 'select' | 'turns'
      sel: null,
      who: {}, // character -> pid this round (secret until called)
      lastWho: {},
      revealed: [],
      called: 0,
      killed: null,
      robbed: null,
      robbedBy: null,
      bewitched: null,
      witchPid: null,
      turn: null,
      firstComplete: null,
      lastRound: false,
      log: [],
      scores: null,
      winner: null,
      startedAt: Date.now(),
    };
    for (const pid2 of order) this.gp(pid2).hand = this.draw(s.startCards);
    for (const p of this.players) p.ready = false;
    this.phase = 'playing';
    this.onStart(this);
    this.addLog('cit.log.started', { name: this.nameOf(this.g.crown) });
    this.startRound();
  }

  restart(pid) {
    this.requireHost(pid);
    this.assert(this.phase === 'ended', 'err.gameRunning');
    this.players = this.players.filter(p => p.connected && !p.left);
    this.spectators = this.spectators.filter(p => p.connected);
    if (!this.member(this.hostId)) this.hostId = (this.players[0] || this.spectators[0])?.id || null;
    this.phase = 'lobby';
    this.g = null;
    this.dispose();
    this.touch();
  }

  addLog(key, params = {}) {
    this.g.log.push({ key, params, at: Date.now() });
    if (this.g.log.length > LOG_KEEP) this.g.log.splice(0, this.g.log.length - LOG_KEEP);
  }

  // ---------- helpers ----------
  gp(pid) { return this.g.players[pid]; }
  deadline(seconds) { return seconds ? Date.now() + seconds * 1000 : null; }
  has(pid, kind) { return this.gp(pid).city.some(c => kindOf(c) === kind); }
  // Monument counts as two districts toward a completed city
  citySize(pid) { return this.gp(pid).city.length + (this.has(pid, 'monument') ? 1 : 0); }
  isComplete(pid) { return this.citySize(pid) >= this.settings.districtsToEnd; }
  isLeft(pid) { return !!this.player(pid)?.left; }

  draw(n) {
    return this.g.deck.splice(0, Math.max(0, n));
  }

  toBottom(cards) {
    this.g.deck.push(...cards);
  }

  gainGold(pid, n) {
    this.gp(pid).gold += n;
    this.gp(pid).stats.goldGained += n;
  }

  drawTo(pid, n) {
    const cards = this.draw(n);
    this.gp(pid).hand.push(...cards);
    this.gp(pid).stats.cardsDrawn += cards.length;
    return cards;
  }

  removeFromCity(pid, card) {
    const gp = this.gp(pid);
    gp.city = gp.city.filter(c => c !== card);
    // the cards kept under the Museum leave with it
    if (kindOf(card) === 'museum') { this.toBottom(gp.museum); gp.museum = []; }
    this.toBottom([card]);
  }

  // ---------- timer: picking a character, or the current turn ----------
  actor() {
    const g = this.g;
    if (!g || this.phase !== 'playing') return null;
    if (g.stage === 'select') return g.sel.seq[g.sel.step];
    return g.turn?.pid || null;
  }

  armTimer() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    if (this.phase !== 'playing' || !this.g) return;
    if (this.players.every(p => p.left)) return; // everyone left: the game stops and the room expires
    const actor = this.actor();
    let deadline = this.g.stage === 'select' ? this.g.sel.endsAt : this.g.turn?.endsAt;
    if (actor && this.isLeft(actor)) deadline = Date.now() + BOT_DELAY_MS;
    if (!deadline) return;
    const seq = ++this.timerSeq;
    this.timer = this.setTimer(() => { if (this.timerSeq === seq) this.onDeadline(); }, Math.max(0, deadline - Date.now()));
  }

  // The clock ran out (or the player has left): make the move for them.
  onDeadline() {
    if (this.phase !== 'playing') return;
    const g = this.g;
    const pid = this.actor();
    if (!pid) return;
    const bot = this.isLeft(pid);
    if (g.stage === 'select') {
      const opts = this.pickOptions();
      if (!bot) this.addLog('cit.log.timeoutPick', { name: this.nameOf(pid) });
      return this.pick(pid, opts[Math.floor(this.rng() * opts.length)]);
    }
    const t = g.turn;
    if (!bot && t.stage !== 'draw') this.addLog('cit.log.timeout', { name: this.nameOf(pid) });
    if (t.stage === 'gather') {
      const gp = this.gp(pid);
      // someone who left takes cards only when their hand is empty
      return this.gather(pid, bot && !gp.hand.length && g.deck.length ? 'cards' : 'gold');
    }
    if (t.stage === 'draw') {
      const best = t.drawn.slice().sort((a, b) => info(b).cost - info(a).cost)[0];
      return this.keep(pid, best);
    }
    if (bot) this.botBuild(pid);
    if (this.g?.turn === t) this.finishTurn();
  }

  // a player who left builds the dearest districts they can afford, then ends the turn
  botBuild(pid) {
    for (let guard = 0; guard < 5; guard++) {
      const t = this.g.turn;
      if (!t || t.pid !== pid || t.built >= this.buildLimit(t)) return;
      const gp = this.gp(pid);
      const card = gp.hand.filter(c => !this.buildProblem(pid, c) && this.buildCost(pid, c) <= gp.gold)
        .sort((a, b) => info(b).cost - info(a).cost)[0];
      if (!card) return;
      this.build(pid, { card });
    }
  }

  // ---------- choosing characters ----------
  startRound() {
    const g = this.g;
    const n = g.order.length;
    g.round += 1;
    g.stage = 'select';
    g.lastWho = g.who;
    g.who = {};
    g.revealed = [];
    g.called = 0;
    g.killed = g.robbed = g.robbedBy = g.bewitched = g.witchPid = null;
    g.turn = null;
    const pool = shuffle(g.chars, this.rng);
    const faceDown = [pool.pop()];
    // as many face-up as leaves the last player a choice of two (the 8-player exception below)
    const faceUpCount = Math.max(0, g.chars.length - 2 - n * g.perPlayer);
    const faceUp = [];
    for (let i = 0; i < pool.length && faceUp.length < faceUpCount;) {
      if (pool[i] === 'king' && !this.settings.kingFaceUp) { i++; continue; }
      faceUp.push(...pool.splice(i, 1));
    }
    const start = g.order.indexOf(g.crown);
    const seq = Array.from({ length: n * g.perPlayer }, (_, i) => g.order[(start + i) % n]);
    g.sel = { faceUp, faceDown, pool, seq, step: 0, endsAt: this.deadline(this.settings.pickSeconds) };
    this.addLog('cit.log.round', { n: g.round, name: this.nameOf(g.crown) });
    if (faceUp.length) this.addLog('cit.log.faceUp', { chars: faceUp });
    this.touch();
  }

  // What the current picker may choose. The very last pick, with one card left, also gets the
  // face-down card (with 7 players and 8 characters, or 8 and 9).
  pickOptions() {
    const sel = this.g.sel;
    const last = sel.step === sel.seq.length - 1;
    return last && sel.pool.length === 1 ? [...sel.pool, ...sel.faceDown] : sel.pool.slice();
  }

  pick(pid, char) {
    this.assert(this.phase === 'playing' && this.g.stage === 'select', 'err.cit.notNow');
    const g = this.g;
    const sel = g.sel;
    this.assert(sel.seq[sel.step] === pid, 'err.cit.notYourPick');
    const opts = this.pickOptions();
    this.assert(opts.includes(char), 'err.invalidTarget');
    g.who[char] = pid;
    if (opts.length > sel.pool.length) {
      // the last pick, from the last card and the face-down one: the other goes face down
      sel.faceDown = opts.filter(c => c !== char);
      sel.pool = [];
    } else sel.pool = sel.pool.filter(c => c !== char);
    sel.step += 1;
    if (sel.step < sel.seq.length) {
      sel.endsAt = this.deadline(this.settings.pickSeconds);
      return this.touch();
    }
    // nobody took them: the rest stay face down
    sel.faceDown.push(...sel.pool);
    sel.pool = [];
    for (const [c, p] of Object.entries(g.who)) this.gp(p).stats.chars[c] = (this.gp(p).stats.chars[c] || 0) + 1;
    g.stage = 'turns';
    this.addLog('cit.log.picked');
    this.callNext();
  }

  // ---------- calling the characters in rank order ----------
  callNext() {
    const g = this.g;
    while (g.called < 9) {
      g.called += 1;
      const c = g.chars.find(x => rankOf(x) === g.called);
      if (!c) continue;
      const pid = g.who[c];
      if (!pid) {
        if (!g.sel.faceUp.includes(c)) this.addLog('cit.log.nobody', { char: c });
        continue;
      }
      g.revealed.push(c);
      if (g.killed === c) {
        this.addLog('cit.log.skipKilled', { name: this.nameOf(pid), char: c });
        continue;
      }
      this.addLog('cit.log.called', { name: this.nameOf(pid), char: c });
      // the King takes the crown when called, even when bewitched
      if (c === 'king' && g.crown !== pid) {
        g.crown = pid;
        this.addLog('cit.log.crown', { name: this.nameOf(pid) });
      }
      if (g.robbed === c && g.robbedBy && g.robbedBy !== pid) {
        const gold = this.gp(pid).gold;
        this.gp(pid).gold = 0;
        this.gainGold(g.robbedBy, gold);
        this.gp(g.robbedBy).stats.stolen += gold;
        this.gp(pid).stats.robbedOf += gold;
        this.addLog('cit.log.robbed', { name: this.nameOf(pid), thief: this.nameOf(g.robbedBy), gold });
      }
      const bewitchedOnly = g.bewitched === c && !!g.witchPid && g.witchPid !== pid;
      g.turn = this.newTurn(pid, c, { bewitchedOnly });
      return this.touch();
    }
    this.endRound();
  }

  newTurn(pid, char, extra = {}) {
    return { pid, char, stage: 'gather', drawn: null, built: 0, used: {}, witch: false, bewitchedOnly: false, endsAt: this.deadline(this.settings.turnSeconds), ...extra };
  }

  requireStage(pid, ...stages) {
    this.assert(this.phase === 'playing' && this.g.stage === 'turns' && this.g.turn, 'err.cit.notNow');
    const t = this.g.turn;
    this.assert(t.pid === pid, 'err.cit.notYourTurn');
    this.assert(stages.includes(t.stage), stages.includes('main') ? 'err.cit.gatherFirst' : 'err.cit.notNow');
    return t;
  }

  // ---------- gathering resources (first, and only once) ----------
  gather(pid, choice) {
    const t = this.requireStage(pid, 'gather');
    const s = this.settings;
    if (choice === 'gold') {
      const n = s.takeGold + (this.has(pid, 'goldMine') ? 1 : 0);
      this.gainGold(pid, n);
      this.addLog('cit.log.takeGold', { name: this.nameOf(pid), n });
      return this.afterGather();
    }
    this.assert(choice === 'cards', 'err.invalidTarget');
    this.assert(this.g.deck.length, 'err.cit.deckEmpty');
    const drawn = this.draw(s.drawCards + (this.has(pid, 'observatory') ? 1 : 0));
    if (this.has(pid, 'library') || drawn.length === 1) {
      this.gp(pid).hand.push(...drawn);
      this.gp(pid).stats.cardsDrawn += drawn.length;
      this.addLog('cit.log.takeCards', { name: this.nameOf(pid), n: drawn.length });
      return this.afterGather();
    }
    t.stage = 'draw';
    t.drawn = drawn;
    this.touch();
  }

  keep(pid, card) {
    const t = this.requireStage(pid, 'draw');
    this.assert(t.drawn.includes(card), 'err.invalidTarget');
    this.gp(pid).hand.push(card);
    this.gp(pid).stats.cardsDrawn += 1;
    this.toBottom(t.drawn.filter(c => c !== card));
    t.drawn = null;
    this.addLog('cit.log.takeCards', { name: this.nameOf(pid), n: 1 });
    this.afterGather();
  }

  afterGather() {
    const g = this.g;
    const t = g.turn;
    t.stage = 'main';
    if (t.bewitchedOnly) {
      // the bewitched player only gathers; the Witch plays the rest of the turn
      this.endOfTurnEffects(t.pid);
      this.addLog('cit.log.witchTakes', { name: this.nameOf(g.witchPid), char: t.char });
      g.turn = this.newTurn(g.witchPid, t.char, { stage: 'main', witch: true });
    }
    this.characterBonus(g.turn);
    this.touch();
  }

  // what the character gives right after gathering
  characterBonus(t) {
    const g = this.g;
    const pid = t.pid;
    if (t.char === 'merchant') {
      this.gainGold(pid, 1);
      this.addLog('cit.log.merchant', { name: this.nameOf(pid) });
    }
    if (t.char === 'architect') {
      const n = this.drawTo(pid, 2).length;
      this.addLog('cit.log.architect', { name: this.nameOf(pid), n });
    }
    if (t.char === 'queen') {
      const king = g.who.king;
      const i = g.order.indexOf(pid), n = g.order.length;
      const next = [g.order[(i + 1) % n], g.order[(i - 1 + n) % n]];
      if (king && king !== pid && next.includes(king)) {
        this.gainGold(pid, 3);
        this.addLog('cit.log.queen', { name: this.nameOf(pid), king: this.nameOf(king) });
      } else this.addLog('cit.log.queenNo', { name: this.nameOf(pid) });
    }
  }

  // the Witch, before bewitching, may not build
  buildLimit(t) {
    if (t.char === 'witch' && !t.witch) return 0;
    return t.char === 'architect' ? 3 : 1;
  }

  // ---------- income: 1 per district of the character's colour, once, before or after building ----------
  incomeCount(pid, char) {
    const color = CHARACTERS[char].color;
    if (!color) return 0;
    const city = this.gp(pid).city;
    // the School of Magic counts as whichever type the ability asks for
    return city.filter(c => info(c).color === color).length + (this.has(pid, 'schoolOfMagic') ? 1 : 0);
  }

  income(pid, { gold } = {}) {
    const t = this.requireStage(pid, 'main');
    this.assert(CHARACTERS[t.char].color, 'err.cit.noIncome');
    this.assert(!t.used.income, 'err.cit.usedAlready');
    const n = this.incomeCount(pid, t.char);
    // the Abbot chooses gold or a card for each blue district
    let g2 = n;
    if (t.char === 'abbot' && gold !== undefined) {
      g2 = Number(gold);
      this.assert(Number.isInteger(g2) && g2 >= 0 && g2 <= n, 'err.invalidTarget');
    }
    t.used.income = true;
    this.gainGold(pid, g2);
    const cards = n - g2 ? this.drawTo(pid, n - g2).length : 0;
    this.addLog(cards ? 'cit.log.incomeMixed' : 'cit.log.income', { name: this.nameOf(pid), gold: g2, cards, char: t.char });
    this.touch();
  }

  // ---------- character abilities ----------
  ability(pid, p = {}) {
    const t = this.requireStage(pid, 'main');
    const g = this.g;
    this.assert(!t.used.ability, 'err.cit.usedAlready');
    const named = () => {
      const c = p.target;
      this.assert(g.chars.includes(c) && rankOf(c) !== 1 && !g.sel.faceUp.includes(c), 'err.cit.badTarget');
      return c;
    };
    switch (t.char) {
      case 'assassin': {
        const c = named();
        g.killed = c;
        this.gp(pid).stats.kills += 1;
        this.addLog('cit.log.kill', { name: this.nameOf(pid), char: c });
        break;
      }
      case 'witch': {
        const c = named();
        g.bewitched = c;
        g.witchPid = pid;
        t.used.ability = true;
        this.addLog('cit.log.bewitch', { name: this.nameOf(pid), char: c });
        return this.finishTurn(); // her turn pauses until the bewitched character is called
      }
      case 'thief': {
        const c = named();
        this.assert(c !== g.killed && c !== g.bewitched && rankOf(c) > rankOf('thief'), 'err.cit.badTarget');
        g.robbed = c;
        g.robbedBy = pid;
        this.addLog('cit.log.rob', { name: this.nameOf(pid), char: c });
        break;
      }
      case 'magician': this.magic(pid, p); break;
      case 'abbot': this.tithe(pid, p); break;
      case 'diplomat': this.exchange(pid, p); break;
      case 'warlord': this.destroy(pid, p); break;
      default: throw new GameError('err.cit.noAbility');
    }
    t.used.ability = true;
    this.touch();
  }

  // Magician: swap the whole hand with a player, or put any cards under the deck and draw as many
  magic(pid, { mode, player, cards }) {
    const me = this.gp(pid);
    if (mode === 'swap') {
      this.assert(player && player !== pid && this.g.players[player], 'err.invalidTarget');
      const other = this.gp(player);
      [me.hand, other.hand] = [other.hand, me.hand];
      this.addLog('cit.log.swapHands', { name: this.nameOf(pid), other: this.nameOf(player), mine: other.hand.length, theirs: me.hand.length });
      return;
    }
    this.assert(mode === 'redraw' && Array.isArray(cards) && cards.length, 'err.invalidTarget');
    const set = [...new Set(cards)];
    this.assert(set.every(c => me.hand.includes(c)), 'err.invalidTarget');
    me.hand = me.hand.filter(c => !set.includes(c));
    this.toBottom(set);
    const n = this.drawTo(pid, set.length).length;
    this.addLog('cit.log.redraw', { name: this.nameOf(pid), n });
  }

  // Abbot: the richest player gives 1 gold (unless the Abbot is among the richest)
  tithe(pid, { from }) {
    const players = this.g.order;
    const max = Math.max(...players.map(p => this.gp(p).gold));
    this.assert(this.gp(pid).gold < max, 'err.cit.youAreRichest');
    const richest = players.filter(p => this.gp(p).gold === max);
    const giver = richest.length === 1 ? richest[0] : from;
    this.assert(richest.includes(giver), 'err.cit.badTarget');
    this.gp(giver).gold -= 1;
    this.gainGold(pid, 1);
    this.addLog('cit.log.tithe', { name: this.nameOf(pid), from: this.nameOf(giver) });
  }

  // Rank 8 can't touch completed cities, the Keep, or the (living) Bishop's city;
  // the Great Wall makes every other district of its city 1 gold dearer for them.
  rank8Problem(owner, card) {
    const g = this.g;
    if (!this.gp(owner).city.includes(card)) return 'err.invalidTarget';
    if (kindOf(card) === 'keep') return 'err.cit.keep';
    if (this.isComplete(owner)) return 'err.cit.completeCity';
    if (g.who.bishop === owner && g.killed !== 'bishop') return 'err.cit.bishop';
    return null;
  }

  wallFee(owner, card) {
    return this.has(owner, 'greatWall') && kindOf(card) !== 'greatWall' ? 1 : 0;
  }

  duplicates(pid, city) {
    if (city.some(c => kindOf(c) === 'quarry')) return false;
    const kinds = city.map(kindOf);
    return new Set(kinds).size !== kinds.length;
  }

  // Diplomat: swap one of your districts for one in another city, paying the difference
  exchange(pid, { mine, owner, theirs }) {
    this.assert(owner && owner !== pid && this.g.players[owner], 'err.invalidTarget');
    this.assert(this.gp(pid).city.includes(mine), 'err.invalidTarget');
    this.assert(kindOf(mine) !== 'keep', 'err.cit.keep');
    const problem = this.rank8Problem(owner, theirs);
    this.assert(!problem, problem);
    const diff = Math.max(0, info(theirs).cost - info(mine).cost);
    const fee = this.wallFee(owner, theirs);
    this.assert(this.gp(pid).gold >= diff + fee, 'err.cit.notEnoughGold');
    const a = this.gp(pid), b = this.gp(owner);
    const cityA = a.city.map(c => (c === mine ? theirs : c));
    const cityB = b.city.map(c => (c === theirs ? mine : c));
    this.assert(!this.duplicates(pid, cityA) && !this.duplicates(owner, cityB), 'err.cit.duplicate');
    a.city = cityA;
    b.city = cityB;
    a.gold -= diff + fee;
    b.gold += diff;
    // museum cards follow the Museum
    if (kindOf(mine) === 'museum') { b.museum = a.museum; a.museum = []; }
    if (kindOf(theirs) === 'museum') { a.museum = b.museum; b.museum = []; }
    a.stats.swaps += 1;
    this.addLog('cit.log.exchange', { name: this.nameOf(pid), other: this.nameOf(owner), mine: kindOf(mine), theirs: kindOf(theirs), gold: diff + fee });
  }

  // Warlord: destroy a district for 1 less than its cost
  destroy(pid, { owner, card }) {
    this.assert(owner && this.g.players[owner], 'err.invalidTarget');
    const problem = this.rank8Problem(owner, card);
    this.assert(!problem, problem);
    const cost = Math.max(0, info(card).cost - 1) + this.wallFee(owner, card);
    this.assert(this.gp(pid).gold >= cost, 'err.cit.notEnoughGold');
    this.gp(pid).gold -= cost;
    this.removeFromCity(owner, card);
    this.gp(pid).stats.destroyed += 1;
    this.gp(owner).stats.lost += 1;
    this.addLog('cit.log.destroy', { name: this.nameOf(pid), other: this.nameOf(owner), card: kindOf(card), gold: cost });
  }

  // ---------- building ----------
  buildCost(pid, card) {
    const d = info(card);
    return Math.max(0, d.cost - (d.color === 'unique' && kindOf(card) !== 'factory' && this.has(pid, 'factory') ? 1 : 0));
  }

  // why this card can't go into the city at all (money aside), or null
  buildProblem(pid, card) {
    const gp = this.gp(pid);
    const kind = kindOf(card);
    if (!gp.hand.includes(card)) return 'err.invalidTarget';
    if (info(card).unbuildable) return 'err.cit.unbuildable';
    if (!this.has(pid, 'quarry') && gp.city.some(c => kindOf(c) === kind)) return 'err.cit.duplicate';
    if (kind === 'monument' && gp.city.length >= 5) return 'err.cit.monument';
    return null;
  }

  // pay: default gold; { framework: true } destroys the Framework instead; { necropolis: card }
  // destroys that district for the Necropolis; { cards: [...] } pays part of the Thieves' Den in cards
  build(pid, { card, framework, necropolis, cards } = {}) {
    const t = this.requireStage(pid, 'main');
    const gp = this.gp(pid);
    const kind = kindOf(card);
    const free = kind === 'stables'; // the Stables don't count toward the limit
    this.assert(free || t.built < this.buildLimit(t), this.buildLimit(t) ? 'err.cit.buildLimit' : 'err.cit.noBuildNow');
    if (t.char === 'witch' && !t.witch) throw new GameError('err.cit.noBuildNow');
    const problem = this.buildProblem(pid, card);
    this.assert(!problem, problem);
    let cost = this.buildCost(pid, card);
    let paidCards = 0;
    if (framework) {
      const fw = gp.city.find(c => kindOf(c) === 'framework');
      this.assert(fw && kind !== 'framework', 'err.invalidTarget');
      this.removeFromCity(pid, fw);
      cost = 0;
    } else if (necropolis) {
      this.assert(kind === 'necropolis' && gp.city.includes(necropolis), 'err.invalidTarget');
      this.removeFromCity(pid, necropolis);
      cost = 0;
    } else if (cards && cards.length) {
      this.assert(kind === 'thievesDen', 'err.invalidTarget');
      const set = [...new Set(cards)];
      this.assert(set.length <= cost && set.every(c => c !== card && gp.hand.includes(c)), 'err.invalidTarget');
      paidCards = set.length;
      cost -= paidCards;
      this.assert(gp.gold >= cost, 'err.cit.notEnoughGold');
      gp.hand = gp.hand.filter(c => !set.includes(c));
      this.toBottom(set);
    }
    this.assert(gp.gold >= cost, 'err.cit.notEnoughGold');
    gp.gold -= cost;
    gp.hand = gp.hand.filter(c => c !== card);
    gp.city.push(card);
    if (!free) t.built += 1;
    gp.stats.built += 1;
    this.addLog('cit.log.build', { name: this.nameOf(pid), card: kind, gold: cost, cards: paidCards, framework: !!framework, necropolis: necropolis ? kindOf(necropolis) : null });
    this.trackComplete(pid);
    this.touch();
  }

  trackComplete(pid) {
    const g = this.g;
    if (!this.isComplete(pid)) return;
    if (!g.firstComplete) {
      g.firstComplete = pid;
      g.lastRound = true;
      this.addLog('cit.log.complete', { name: this.nameOf(pid), n: this.settings.districtsToEnd });
    }
  }

  // ---------- unique districts with an action ----------
  useDistrict(pid, { kind, card, owner, target } = {}) {
    const t = this.requireStage(pid, 'main');
    const gp = this.gp(pid);
    this.assert(this.has(pid, kind), 'err.invalidTarget');
    this.assert(!t.used[kind], 'err.cit.usedAlready');
    switch (kind) {
      case 'laboratory': // discard a card for 2 gold
        this.assert(gp.hand.includes(card), 'err.invalidTarget');
        gp.hand = gp.hand.filter(c => c !== card);
        this.toBottom([card]);
        this.gainGold(pid, 2);
        this.addLog('cit.log.laboratory', { name: this.nameOf(pid) });
        break;
      case 'smithy': // 2 gold for 3 cards
        this.assert(gp.gold >= 2, 'err.cit.notEnoughGold');
        this.assert(this.g.deck.length, 'err.cit.deckEmpty');
        gp.gold -= 2;
        this.addLog('cit.log.smithy', { name: this.nameOf(pid), n: this.drawTo(pid, 3).length });
        break;
      case 'museum': // a card kept face down under the Museum: 1 point each at the end
        this.assert(gp.hand.includes(card), 'err.invalidTarget');
        gp.hand = gp.hand.filter(c => c !== card);
        gp.museum.push(card);
        this.addLog('cit.log.museum', { name: this.nameOf(pid) });
        break;
      case 'armory': { // destroy the Armory to destroy any other district
        this.assert(owner && this.g.players[owner] && this.gp(owner).city.includes(target) && kindOf(target) !== 'armory', 'err.invalidTarget');
        const armory = gp.city.find(c => kindOf(c) === 'armory');
        this.removeFromCity(pid, armory);
        this.removeFromCity(owner, target);
        if (owner !== pid) this.gp(owner).stats.lost += 1;
        gp.stats.destroyed += 1;
        this.addLog('cit.log.armory', { name: this.nameOf(pid), other: this.nameOf(owner), card: kindOf(target) });
        break;
      }
      default: throw new GameError('err.invalidTarget');
    }
    t.used[kind] = true;
    this.touch();
  }

  // ---------- ending a turn ----------
  endTurn(pid) {
    this.requireStage(pid, 'main');
    this.finishTurn();
  }

  finishTurn() {
    const g = this.g;
    const t = g.turn;
    // income nobody asked for is collected anyway (the Abbot takes it in gold)
    if (!t.used.income && CHARACTERS[t.char].color && !(t.char === 'witch' && !t.witch)) {
      const n = this.incomeCount(t.pid, t.char);
      if (n) {
        t.used.income = true;
        this.gainGold(t.pid, n);
        this.addLog('cit.log.income', { name: this.nameOf(t.pid), gold: n, cards: 0, char: t.char });
      }
    }
    this.endOfTurnEffects(t.pid);
    g.turn = null;
    this.callNext();
  }

  endOfTurnEffects(pid) {
    const gp = this.gp(pid);
    if (this.has(pid, 'poorHouse') && gp.gold === 0) {
      this.gainGold(pid, 1);
      this.addLog('cit.log.poorHouse', { name: this.nameOf(pid) });
    }
    if (this.has(pid, 'park') && !gp.hand.length && this.g.deck.length) {
      this.addLog('cit.log.park', { name: this.nameOf(pid), n: this.drawTo(pid, 2).length });
    }
  }

  endRound() {
    const g = this.g;
    // a killed King's player is the heir: the crown passes at the end of the round
    if (g.killed === 'king' && g.who.king && g.crown !== g.who.king) {
      g.crown = g.who.king;
      this.addLog('cit.log.heir', { name: this.nameOf(g.who.king) });
    }
    if (g.lastRound) return this.endGame();
    this.startRound();
  }

  // ---------- scoring ----------
  scoreOf(pid) {
    const g = this.g;
    const s = this.settings;
    const gp = this.gp(pid);
    const kinds = gp.city.map(kindOf);
    const districts = gp.city.reduce((sum, c) => sum + info(c).cost, 0);
    // all five types; the Haunted Quarter stands in for any one
    const others = new Set(gp.city.filter(c => kindOf(c) !== 'hauntedQuarter').map(c => info(c).color));
    const colors = Math.min(5, others.size + (kinds.includes('hauntedQuarter') ? 1 : 0)) === 5 ? s.colorsBonus : 0;
    const complete = this.isComplete(pid) ? (g.firstComplete === pid ? s.firstBonus : s.completeBonus) : 0;
    const uniques = gp.city.filter(c => info(c).color === 'unique').length;
    const byColor = {};
    for (const c of gp.city) byColor[info(c).color] = (byColor[info(c).color] || 0) + 1;
    const extras = {};
    const add = (k, v) => { if (v) extras[k] = v; };
    if (kinds.includes('dragonGate')) add('dragonGate', 2);
    if (kinds.includes('imperialTreasury')) add('imperialTreasury', gp.gold);
    if (kinds.includes('mapRoom')) add('mapRoom', gp.hand.length);
    if (kinds.includes('statue') && g.crown === pid) add('statue', 5);
    if (kinds.includes('wishingWell')) add('wishingWell', uniques);
    if (kinds.includes('capitol') && Object.values(byColor).some(n => n >= 3)) add('capitol', 3);
    if (kinds.includes('basilica')) add('basilica', gp.city.filter(c => info(c).cost % 2 === 1).length);
    if (kinds.includes('ivoryTower') && uniques === 1) add('ivoryTower', 5);
    if (kinds.includes('museum')) add('museum', gp.museum.length);
    add('secretVault', gp.hand.filter(c => kindOf(c) === 'secretVault').length * 3);
    const total = districts + colors + complete + Object.values(extras).reduce((a, b) => a + b, 0);
    return { districts, colors, complete, extras, total };
  }

  endGame() {
    const g = this.g;
    // ties go to whoever had the highest-ranked character in the last round
    const topRank = pid => Math.max(0, ...Object.entries(g.who).filter(([, p]) => p === pid).map(([c]) => rankOf(c)));
    const scores = g.order.map(pid => ({ pid, ...this.scoreOf(pid), rank: topRank(pid) }))
      .sort((a, b) => b.total - a.total || b.rank - a.rank);
    scores.forEach((s, i) => { s.place = i + 1; });
    g.scores = scores;
    g.winner = scores[0].pid;
    g.stage = 'ended';
    g.turn = null;
    this.phase = 'ended';
    this.dispose();
    this.addLog('cit.log.winner', { name: this.nameOf(g.winner), points: scores[0].total });
    this.onGameEnd(this.gameResults());
    this.onArchive(this.archiveRecord());
    this.touch();
  }

  // the game for the game night archive
  archiveRecord() {
    const g = this.g;
    return {
      game: 'cit', code: this.code, tableId: this.tableId, startedAt: g.startedAt, endedAt: Date.now(),
      winner: this.nameOf(g.winner),
      rounds: g.round,
      players: g.scores.map(s => ({
        userId: this.player(s.pid)?.userId || null, name: this.nameOf(s.pid), points: s.total, won: s.pid === g.winner,
        districts: this.gp(s.pid).city.map(kindOf),
      })),
    };
  }

  gameResults() {
    const g = this.g;
    return g.scores.map(s => {
      const p = this.player(s.pid);
      if (!p || !p.userId) return null;
      const gp = this.gp(s.pid);
      return {
        userId: p.userId,
        won: s.pid === g.winner,
        place: s.place,
        players: g.order.length,
        score: s.total,
        districts: gp.city.length,
        firstComplete: g.firstComplete === s.pid,
        completed: this.isComplete(s.pid),
        rounds: g.round,
        ...gp.stats,
        lastChars: Object.entries(g.who).filter(([, pid]) => pid === s.pid).map(([c]) => c),
        at: Date.now(),
      };
    }).filter(Boolean);
  }

  // ---------- view: hands, picks and the face-down cards are secret ----------
  viewFor(pid) {
    const me = this.member(pid);
    const decorate = p => {
      const profile = p.userId ? this.profileOf(p.userId) : null;
      return {
        id: p.id, userId: p.userId, name: p.name, connected: p.connected, ready: !!p.ready, left: !!p.left,
        avatar: profile?.avatar || null, score: profile ? profile.score : null, cos: profile?.equipped || {}, title: profile?.title || null,
      };
    };
    const view = {
      code: this.code,
      phase: this.phase,
      hostId: this.hostId,
      serverNow: Date.now(),
      settings: { ...this.settings, chars: { ...this.settings.chars }, uniques: this.settings.uniques.slice() },
      defaults: defaultSettings(),
      features: this.features(),
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      players: this.players.map(decorate),
      spectators: this.spectators.map(decorate),
      me: me ? { id: me.id, name: me.name, spectator: !!this.spectator(pid) } : null,
      gameId: this.gameId,
    };
    if (!this.g) return view;
    const g = this.g;
    const ended = this.phase === 'ended';
    const known = c => ended || g.revealed.includes(c) || g.who[c] === pid;
    const sel = g.sel;
    const picking = g.stage === 'select' && sel.seq[sel.step] === pid;
    view.game = {
      order: g.order,
      chars: g.chars,
      perPlayer: g.perPlayer,
      round: g.round,
      stage: g.stage,
      crown: g.crown,
      deck: g.deck.length,
      players: Object.fromEntries(g.order.map(p => {
        const x = this.gp(p);
        return [p, {
          gold: x.gold, hand: x.hand.length, city: x.city, museum: x.museum.length, size: this.citySize(p), complete: this.isComplete(p),
          // the characters this player is known to have this round
          chars: Object.entries(g.who).filter(([c, q]) => q === p && known(c)).map(([c]) => c),
          ...(ended ? { stats: x.stats, handCards: x.hand } : {}),
        }];
      })),
      sel: sel && {
        faceUp: sel.faceUp,
        faceDown: ended ? sel.faceDown : sel.faceDown.length,
        seq: sel.seq,
        step: sel.step,
        endsAt: sel.endsAt,
        options: picking ? this.pickOptions() : null,
        poolSize: sel.pool.length,
      },
      called: g.called,
      revealed: g.revealed,
      killed: g.killed,
      robbed: g.robbed,
      bewitched: g.bewitched,
      turn: g.turn && { ...g.turn, drawn: g.turn.pid === pid ? g.turn.drawn : g.turn.drawn ? g.turn.drawn.length : null, limit: this.buildLimit(g.turn) },
      firstComplete: g.firstComplete,
      lastRound: g.lastRound,
      log: g.log.slice(-80),
      scores: g.scores,
      winner: g.winner,
    };
    const mine = g.players[pid];
    if (mine) {
      view.game.me = {
        hand: mine.hand,
        museum: mine.museum,
        chars: Object.entries(g.who).filter(([, q]) => q === pid).map(([c]) => c),
        buildCosts: Object.fromEntries(mine.hand.map(c => [c, this.buildCost(pid, c)])),
        buildProblems: Object.fromEntries(mine.hand.map(c => [c, this.buildProblem(pid, c)])),
        income: g.turn && g.turn.pid === pid ? this.incomeCount(pid, g.turn.char) : 0,
      };
    }
    return view;
  }
}

module.exports = { CitRoom, MIN_PLAYERS, MAX_PLAYERS, UNIQUE_KINDS, DISTRICTS };
