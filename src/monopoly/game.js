'use strict';

// Monopoly rules and state (no I/O). Official rules: 2–8 players, salary on GO, doubles and
// three-doubles-to-jail, jail (bail, card or doubles within three turns), buying or auctioning,
// colour sets and even building with the bank's 32 houses / 12 hotels, mortgages, trades,
// Chance / Community Chest, debts and bankruptcy. House rules are lobby settings.

const crypto = require('crypto');
const { SCALE, SQUARES, JAIL, GO_TO_JAIL, RAILWAY_RENT, GROUPS, CHANCE, CHEST, isProperty } = require('./board');
const { GameError } = require('../game');

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 8;
const MAX_SPECTATORS = 20;
const SALARY = 200 * SCALE;
const BAIL = 50 * SCALE;
const JAIL_CARD_VALUE = 50 * SCALE; // what a "Get out of jail" card counts for when judging a trade
const UNFAIR_RATIO = 2; // giving more than twice what you get (without completing a set) is refused
const HOUSES = 32;
const HOTELS = 12;
const AUCTION_MS = 10000; // the auction ends this long after the last bid
const TRADE_TTL_MS = 2 * 60 * 1000;
const LOG_KEEP = 300;
// player colours: each player's piece on the board is a ring in their colour
const TOKENS = ['#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#ec4899', '#14b8a6', '#f97316', '#eab308', '#64748b'];

const id = (bytes = 6) => crypto.randomBytes(bytes).toString('hex');

const SAVED_FIELDS = ['code', 'players', 'spectators', 'hostId', 'settings', 'phase', 'g', 'gameId', 'lastActivity'];

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

class MonoRoom {
  // profileOf(userId) -> { avatar, score, equipped } for display; onGameEnd(results) for stats
  constructor({
    code, rng = Math.random, onChange = () => {}, setTimer = setTimeout, clearTimer = clearTimeout,
    profileOf = () => null, onGameEnd = () => {},
  } = {}) {
    this.code = code;
    this.rng = rng;
    this.onChange = onChange;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.profileOf = profileOf;
    this.onGameEnd = onGameEnd;
    this.players = []; // { id, token, userId, name, connected, ready, piece }
    this.spectators = []; // { id, token, userId, name, connected }
    this.hostId = null;
    // mortgageTurns: a mortgaged property goes back to the bank after this many of its owner's turns (0 = never)
    this.settings = {
      startingCash: 1500 * SCALE, doubleGo: true, freeParking: false, auctions: true, noRentInJail: false, turnSeconds: 90, mortgageTurns: 15,
    };
    this.phase = 'lobby';
    this.g = null; // the running game, see start()
    this.gameId = null;
    this.timer = null;
    this.timerSeq = 0;
    this.lastActivity = Date.now();
  }

  toJSON() {
    return Object.fromEntries(SAVED_FIELDS.map(k => [k, this[k]]));
  }

  static restore(data, opts = {}) {
    const room = new MonoRoom({ ...opts, code: data.code });
    const defaults = room.settings;
    for (const k of SAVED_FIELDS) if (data[k] !== undefined) room[k] = data[k];
    room.settings = { ...defaults, ...room.settings };
    for (const p of [...room.players, ...room.spectators]) p.connected = false;
    // give whoever was acting a fresh turn clock after the downtime
    if (room.g && room.phase === 'playing') {
      if (room.g.turn) room.g.turn.endsAt = room.turnDeadline();
      if (room.g.auction) room.g.auction.endsAt = Date.now() + AUCTION_MS;
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
    const taken = new Set(this.players.map(p => p.piece));
    const p = { id: id(), token: id(16), userId, name, connected: true, ready: false, piece: TOKENS.find(t => !taken.has(t)) };
    this.players.push(p);
    if (!this.hostId) this.hostId = p.id;
    this.touch();
    return p;
  }

  leave(pid) {
    if (this.spectator(pid)) this.spectators = this.spectators.filter(x => x.id !== pid);
    else if (this.player(pid)) {
      if (this.phase === 'lobby') this.players = this.players.filter(x => x.id !== pid);
      else {
        this.player(pid).connected = false;
        if (this.phase === 'playing' && !this.g.players[pid].bankrupt) this.resign(pid);
      }
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
      const taken = new Set(this.players.map(x => x.piece));
      this.players.push({ ...p, ready: false, piece: TOKENS.find(t => !taken.has(t)) });
    }
    this.touch();
  }

  setReady(pid, ready) {
    this.assert(this.phase === 'lobby' && this.player(pid), 'err.notInRoom');
    this.player(pid).ready = !!ready;
    this.touch();
  }

  setPiece(pid, piece) {
    this.assert(this.phase === 'lobby' && this.player(pid), 'err.notInRoom');
    this.assert(TOKENS.includes(piece) && !this.players.some(p => p.id !== pid && p.piece === piece), 'err.invalidTarget');
    this.player(pid).piece = piece;
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
    if (s.startingCash !== undefined) {
      const v = Number(s.startingCash);
      this.assert(Number.isInteger(v) && v >= 500 * SCALE && v <= 5000 * SCALE, 'err.mono.cashRange', { min: 500 * SCALE, max: 5000 * SCALE });
      this.settings.startingCash = v;
    }
    if (s.turnSeconds !== undefined) {
      const v = Number(s.turnSeconds);
      this.assert(Number.isInteger(v) && (v === 0 || (v >= 30 && v <= 600)), 'err.mono.turnRange', { min: 30, max: 600 });
      this.settings.turnSeconds = v;
    }
    if (s.mortgageTurns !== undefined) {
      const v = Number(s.mortgageTurns);
      this.assert(Number.isInteger(v) && (v === 0 || (v >= 3 && v <= 50)), 'err.mono.mortgageRange', { min: 3, max: 50 });
      this.settings.mortgageTurns = v;
    }
    for (const k of ['doubleGo', 'freeParking', 'auctions', 'noRentInJail']) if (s[k] !== undefined) this.settings[k] = !!s[k];
    this.touch();
  }

  // ---------- game setup ----------
  start(pid) {
    this.requireHost(pid);
    this.assert(this.phase === 'lobby', 'err.gameStarted');
    this.assert(this.players.length >= MIN_PLAYERS, 'err.needPlayers', { min: MIN_PLAYERS });
    const order = shuffle(this.players.map(p => p.id), this.rng);
    const blank = () => ({
      rentCollected: 0, rentPaid: 0, bought: 0, housesBuilt: 0, hotelsBuilt: 0, auctionsWon: 0, trades: 0,
      jailed: 0, doubles: 0, passedGo: 0, peakNetWorth: this.settings.startingCash, cardsDrawn: 0,
    });
    this.gameId = id();
    this.g = {
      order,
      turnIdx: 0,
      players: Object.fromEntries(order.map(pid => [pid, {
        cash: this.settings.startingCash, pos: 0, inJail: false, jailTurns: 0, jailCards: [], bankrupt: false, bankruptAt: null, stats: blank(),
      }])),
      props: {}, // square -> { owner, houses (5 = hotel), mortgaged }
      housesLeft: HOUSES,
      hotelsLeft: HOTELS,
      decks: { chance: shuffle(CHANCE.map(c => c.id), this.rng), chest: shuffle(CHEST.map(c => c.id), this.rng) },
      pot: 0,
      turn: null,
      debts: [], // [{ pid, amount, to (pid | null = bank) }], the first one is being settled
      auction: null, // { square, bid, bidder, endsAt }
      trades: [], // [{ id, from, to, give: { props, cash, cards }, take: { props, cash, cards }, at }]
      lastCard: null,
      lastDice: null,
      log: [],
      winner: null,
      ended: false,
      round: 1,
      startedAt: Date.now(),
    };
    for (const p of this.players) p.ready = false;
    this.phase = 'playing';
    this.addLog('mono.log.started');
    this.beginTurn(order[0]);
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

  addLog(key, params = {}) {
    this.g.log.push({ key, params, at: Date.now() });
    if (this.g.log.length > LOG_KEEP) this.g.log.splice(0, this.g.log.length - LOG_KEEP);
  }

  // ---------- helpers ----------
  gp(pid) { return this.g.players[pid]; }
  active() { return this.g.order.filter(pid => !this.gp(pid).bankrupt); }
  current() { return this.g.turn?.pid; }
  prop(sq) { return this.g.props[sq]; }
  owned(pid) { return Object.entries(this.g.props).filter(([, p]) => p.owner === pid).map(([sq]) => Number(sq)); }
  ownsGroup(pid, group) { return GROUPS[group].every(sq => this.prop(sq)?.owner === pid); }
  groupHasBuildings(group) { return GROUPS[group].some(sq => (this.prop(sq)?.houses || 0) > 0); }
  isBlocked() { return this.g.debts.length > 0 || !!this.g.auction; }

  turnDeadline() {
    return this.settings.turnSeconds ? Date.now() + this.settings.turnSeconds * 1000 : null;
  }

  netWorth(pid) {
    let total = this.gp(pid).cash;
    for (const sq of this.owned(pid)) {
      const pr = this.prop(sq);
      const sqr = SQUARES[sq];
      total += pr.mortgaged ? sqr.price / 2 : sqr.price;
      if (pr.houses) total += pr.houses * sqr.house;
    }
    return total;
  }

  // what a player could raise by selling all buildings and mortgaging everything
  liquidValue(pid) {
    let total = this.gp(pid).cash;
    for (const sq of this.owned(pid)) {
      const pr = this.prop(sq);
      const sqr = SQUARES[sq];
      if (pr.houses) total += (pr.houses * sqr.house) / 2;
      if (!pr.mortgaged) total += sqr.price / 2;
    }
    return total;
  }

  setStage(stage) {
    this.g.turn.stage = stage;
    this.g.turn.endsAt = this.turnDeadline();
  }

  // ---------- timer: one at a time, for whichever deadline comes first ----------
  armTimer() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    if (this.phase !== 'playing' || !this.g) return;
    const deadline = this.g.auction ? this.g.auction.endsAt : this.g.debts.length ? this.g.debts[0].endsAt : this.g.turn?.endsAt;
    if (!deadline) return;
    const seq = ++this.timerSeq;
    this.timer = this.setTimer(() => { if (this.timerSeq === seq) this.onDeadline(); }, Math.max(0, deadline - Date.now()));
  }

  // The clock ran out: play the move for whoever is idle.
  onDeadline() {
    if (this.phase !== 'playing') return;
    const g = this.g;
    if (g.auction) return this.closeAuction();
    if (g.debts.length) {
      const d = g.debts[0];
      this.autoRaise(d.pid, d.amount);
      if (this.gp(d.pid).cash >= d.amount) return this.payDebt(d.pid);
      return this.bankrupt(d.pid);
    }
    const t = g.turn;
    if (!t) return;
    this.addLog('mono.log.timeout', { name: this.nameOf(t.pid) });
    if (t.stage === 'roll') return this.roll(t.pid);
    if (t.stage === 'buy') return this.decline(t.pid);
    if (t.stage === 'end') return this.endTurn(t.pid);
  }

  // sell buildings and mortgage, cheapest first, until `amount` is covered (used when time runs out)
  autoRaise(pid, amount) {
    const gp = this.gp(pid);
    const mine = () => this.owned(pid).sort((a, b) => SQUARES[a].price - SQUARES[b].price);
    let guard = 200;
    while (gp.cash < amount && guard-- > 0) {
      const withHouses = mine().filter(sq => this.prop(sq).houses > 0);
      if (withHouses.length) {
        // respect even selling: take from the most built-up lot in its group
        const sq = withHouses.sort((a, b) => this.prop(b).houses - this.prop(a).houses)[0];
        this.sellHouseRaw(pid, sq);
        continue;
      }
      const sq = mine().find(s => !this.prop(s).mortgaged);
      if (sq === undefined) break;
      this.mortgageRaw(pid, sq);
    }
  }

  // ---------- turns ----------
  beginTurn(pid) {
    this.g.turn = { pid, stage: 'roll', dice: null, doublesCount: 0, extraRoll: false, endsAt: this.turnDeadline() };
    this.tickMortgages(pid);
    this.touch();
  }

  // Each of the owner's turns counts down their mortgages; at zero the property goes back to the bank.
  tickMortgages(pid) {
    for (const sq of this.owned(pid)) {
      const pr = this.prop(sq);
      if (!pr.mortgaged || !pr.mortgageLeft) continue;
      pr.mortgageLeft -= 1;
      if (pr.mortgageLeft <= 0) {
        delete this.g.props[sq];
        this.addLog('mono.log.mortgageExpired', { name: this.nameOf(pid), square: sq });
      }
    }
  }

  requireTurn(pid, stage) {
    this.assert(this.phase === 'playing', 'err.gameNotRunning');
    this.assert(this.current() === pid, 'err.mono.notYourTurn');
    this.assert(!this.isBlocked(), 'err.mono.waitForOthers');
    if (stage) this.assert(this.g.turn.stage === stage, 'err.mono.wrongStage');
  }

  rollDice() {
    return [1 + Math.floor(this.rng() * 6), 1 + Math.floor(this.rng() * 6)];
  }

  roll(pid) {
    this.requireTurn(pid, 'roll');
    const g = this.g;
    const gp = this.gp(pid);
    const t = g.turn;
    const dice = this.rollDice();
    const doubles = dice[0] === dice[1];
    t.dice = dice;
    g.lastDice = { dice, pid, at: Date.now() };
    if (doubles) gp.stats.doubles += 1;
    this.addLog('mono.log.rolled', { name: this.nameOf(pid), a: dice[0], b: dice[1] });

    if (gp.inJail) {
      if (doubles) {
        gp.inJail = false;
        gp.jailTurns = 0;
        this.addLog('mono.log.jailDoubles', { name: this.nameOf(pid) });
        t.extraRoll = false; // leaving jail on doubles doesn't give another roll
        this.move(pid, dice[0] + dice[1]);
      } else {
        gp.jailTurns += 1;
        if (gp.jailTurns >= 3) {
          // third failed attempt: pay the bail and move
          gp.inJail = false;
          gp.jailTurns = 0;
          this.addLog('mono.log.bailForced', { name: this.nameOf(pid), amount: BAIL });
          t.extraRoll = false;
          t.pendingMove = dice[0] + dice[1];
          this.charge(pid, BAIL, null, 'bail');
          if (!g.debts.length) { const steps = t.pendingMove; t.pendingMove = null; this.move(pid, steps); }
        } else {
          t.extraRoll = false;
        }
      }
      return this.afterAction();
    }

    if (doubles) {
      t.doublesCount += 1;
      if (t.doublesCount >= 3) {
        this.addLog('mono.log.threeDoubles', { name: this.nameOf(pid) });
        this.sendToJail(pid);
        return this.afterAction();
      }
    }
    t.extraRoll = doubles;
    this.move(pid, dice[0] + dice[1]);
    return this.afterAction();
  }

  move(pid, steps) {
    const gp = this.gp(pid);
    const from = gp.pos;
    gp.pos = (from + steps + 40) % 40;
    if (steps > 0 && gp.pos < from) this.passGo(pid, gp.pos === 0);
    this.land(pid);
  }

  // move forward to a square (cards), collecting salary when passing GO
  advanceTo(pid, sq) {
    const gp = this.gp(pid);
    if (sq <= gp.pos && sq !== gp.pos) this.passGo(pid, sq === 0);
    else if (sq === 0 && gp.pos !== 0) this.passGo(pid, true);
    gp.pos = sq;
    this.land(pid);
  }

  passGo(pid, landedOnGo) {
    const amount = landedOnGo && this.settings.doubleGo ? SALARY * 2 : SALARY;
    this.gp(pid).cash += amount;
    this.gp(pid).stats.passedGo += 1;
    this.addLog('mono.log.salary', { name: this.nameOf(pid), amount });
  }

  sendToJail(pid) {
    const gp = this.gp(pid);
    gp.pos = JAIL;
    gp.inJail = true;
    gp.jailTurns = 0;
    gp.stats.jailed += 1;
    if (this.g.turn && this.g.turn.pid === pid) this.g.turn.extraRoll = false;
    this.addLog('mono.log.jailed', { name: this.nameOf(pid) });
  }

  land(pid, { rentMultiplier = 1, utilityTimes = null } = {}) {
    const g = this.g;
    const gp = this.gp(pid);
    const sq = SQUARES[gp.pos];
    switch (sq.type) {
      case 'street': case 'railway': case 'utility': {
        const pr = this.prop(gp.pos);
        if (!pr) {
          g.turn.offer = gp.pos;
          this.setStage('buy');
          return;
        }
        if (pr.owner === pid || pr.mortgaged) return;
        if (this.settings.noRentInJail && this.gp(pr.owner).inJail) {
          this.addLog('mono.log.noRentJail', { name: this.nameOf(pr.owner) });
          return;
        }
        const rent = this.rentFor(gp.pos, { multiplier: rentMultiplier, utilityTimes });
        this.addLog('mono.log.rent', { name: this.nameOf(pid), owner: this.nameOf(pr.owner), amount: rent, square: gp.pos });
        this.charge(pid, rent, pr.owner, 'rent');
        return;
      }
      case 'tax':
        this.addLog('mono.log.tax', { name: this.nameOf(pid), amount: sq.amount, square: gp.pos });
        this.charge(pid, sq.amount, null, 'tax');
        return;
      case 'chance': case 'chest':
        return this.drawCard(pid, sq.type);
      case 'gotojail':
        return this.sendToJail(pid);
      case 'parking':
        if (this.settings.freeParking && g.pot > 0) {
          this.addLog('mono.log.pot', { name: this.nameOf(pid), amount: g.pot });
          gp.cash += g.pot;
          g.pot = 0;
        }
        return;
      default:
    }
  }

  rentFor(sq, { multiplier = 1, utilityTimes = null } = {}) {
    const pr = this.prop(sq);
    const sqr = SQUARES[sq];
    if (sqr.type === 'street') {
      if (pr.houses > 0) return sqr.rent[pr.houses];
      return sqr.rent[0] * (this.ownsGroup(pr.owner, sqr.group) ? 2 : 1);
    }
    if (sqr.type === 'railway') {
      const n = this.owned(pr.owner).filter(s => SQUARES[s].type === 'railway').length;
      return RAILWAY_RENT[n - 1] * multiplier;
    }
    // utilities: 4× the dice, 10× with both (or when a card says so)
    const both = this.owned(pr.owner).filter(s => SQUARES[s].type === 'utility').length === 2;
    const times = utilityTimes || (both ? 10 : 4);
    const dice = this.g.turn?.dice || [0, 0];
    return times * (dice[0] + dice[1]);
  }

  // Pay `amount` to a player (or the bank when `to` is null). Short of cash: a debt to settle.
  charge(pid, amount, to, reason) {
    if (amount <= 0) return;
    const gp = this.gp(pid);
    if (gp.cash >= amount) {
      this.transfer(pid, amount, to, reason);
      return;
    }
    this.g.debts.push({ pid, amount, to, reason, endsAt: this.turnDeadline() });
    this.addLog('mono.log.debt', { name: this.nameOf(pid), amount });
  }

  transfer(pid, amount, to, reason) {
    this.gp(pid).cash -= amount;
    if (to) {
      this.gp(to).cash += amount;
      if (reason === 'rent') {
        this.gp(to).stats.rentCollected += amount;
        this.gp(pid).stats.rentPaid += amount;
      }
    } else if (this.settings.freeParking && (reason === 'tax' || reason === 'card' || reason === 'bail')) {
      this.g.pot += amount;
    }
  }

  // After any action: decide what the current player does next.
  afterAction() {
    const g = this.g;
    if (this.phase !== 'playing') return;
    this.trackPeaks();
    if (g.debts.length || g.auction || g.turn.stage === 'buy') { this.touch(); return; }
    if (this.gp(g.turn.pid).bankrupt) { this.nextTurn(); return; }
    // a jailed third-try roll waits for the bail to be paid before moving
    if (g.turn.pendingMove) {
      const steps = g.turn.pendingMove;
      g.turn.pendingMove = null;
      this.move(g.turn.pid, steps);
      this.afterAction();
      return;
    }
    this.setStage(g.turn.extraRoll && !this.gp(g.turn.pid).inJail ? 'roll' : 'end');
    this.touch();
  }

  trackPeaks() {
    for (const pid of this.active()) {
      const st = this.gp(pid).stats;
      st.peakNetWorth = Math.max(st.peakNetWorth, this.netWorth(pid));
    }
  }

  endTurn(pid) {
    this.requireTurn(pid, 'end');
    this.nextTurn();
  }

  nextTurn() {
    const g = this.g;
    if (this.checkWin()) return;
    const order = g.order;
    let idx = g.turnIdx;
    for (let i = 0; i < order.length; i++) {
      idx = (idx + 1) % order.length;
      if (idx === 0) g.round += 1;
      if (!this.gp(order[idx]).bankrupt) break;
    }
    g.turnIdx = idx;
    g.lastCard = null;
    this.beginTurn(order[idx]);
  }

  // ---------- jail ----------
  payBail(pid) {
    this.requireTurn(pid, 'roll');
    const gp = this.gp(pid);
    this.assert(gp.inJail, 'err.mono.notInJail');
    this.assert(gp.cash >= BAIL, 'err.mono.notEnoughCash');
    this.transfer(pid, BAIL, null, 'bail');
    gp.inJail = false;
    gp.jailTurns = 0;
    this.addLog('mono.log.bail', { name: this.nameOf(pid), amount: BAIL });
    this.touch();
  }

  useJailCard(pid) {
    this.requireTurn(pid, 'roll');
    const gp = this.gp(pid);
    this.assert(gp.inJail && gp.jailCards.length, 'err.mono.noJailCard');
    const card = gp.jailCards.shift();
    this.g.decks[card.startsWith('c.') ? 'chance' : 'chest'].push(card); // back to the bottom of its deck
    gp.inJail = false;
    gp.jailTurns = 0;
    this.addLog('mono.log.jailCard', { name: this.nameOf(pid) });
    this.touch();
  }

  // ---------- buying and auctions ----------
  buy(pid) {
    this.requireTurn(pid, 'buy');
    const g = this.g;
    const sq = g.turn.offer;
    const price = SQUARES[sq].price;
    this.assert(this.gp(pid).cash >= price, 'err.mono.notEnoughCash');
    this.gp(pid).cash -= price;
    g.props[sq] = { owner: pid, houses: 0, mortgaged: false };
    this.gp(pid).stats.bought += 1;
    g.turn.offer = null;
    this.addLog('mono.log.bought', { name: this.nameOf(pid), square: sq, amount: price });
    g.turn.stage = 'resolved';
    this.afterAction();
  }

  decline(pid) {
    this.requireTurn(pid, 'buy');
    const g = this.g;
    const sq = g.turn.offer;
    g.turn.offer = null;
    g.turn.stage = 'resolved';
    if (this.settings.auctions && this.active().length > 1) {
      // bidding opens at half the price, so nobody snaps it up for pennies
      g.auction = { square: sq, bid: 0, bidder: null, min: Math.ceil(SQUARES[sq].price / 2), endsAt: Date.now() + AUCTION_MS };
      this.addLog('mono.log.auction', { square: sq });
    } else {
      this.addLog('mono.log.declined', { name: this.nameOf(pid), square: sq });
    }
    this.afterAction();
  }

  bid(pid, amount) {
    const a = this.g?.auction;
    this.assert(this.phase === 'playing' && a, 'err.mono.noAuction');
    this.assert(this.player(pid) && !this.gp(pid).bankrupt, 'err.notInRoom');
    this.assert(!this.g.debts.length, 'err.mono.waitForOthers');
    amount = Math.floor(Number(amount));
    const min = a.bidder ? a.bid + 1 : a.min || 1;
    this.assert(Number.isInteger(amount) && amount >= min, 'err.mono.bidTooLow', { min });
    this.assert(amount <= this.gp(pid).cash, 'err.mono.notEnoughCash');
    a.bid = amount;
    a.bidder = pid;
    a.endsAt = Date.now() + AUCTION_MS;
    this.touch();
  }

  closeAuction() {
    const g = this.g;
    const a = g.auction;
    g.auction = null;
    if (a.bidder && this.gp(a.bidder).cash >= a.bid && !this.gp(a.bidder).bankrupt) {
      this.gp(a.bidder).cash -= a.bid;
      g.props[a.square] = { owner: a.bidder, houses: 0, mortgaged: false };
      this.gp(a.bidder).stats.auctionsWon += 1;
      this.gp(a.bidder).stats.bought += 1;
      this.addLog('mono.log.auctionWon', { name: this.nameOf(a.bidder), square: a.square, amount: a.bid });
    } else {
      this.addLog('mono.log.auctionNone', { square: a.square });
    }
    this.afterAction();
  }

  // ---------- cards ----------
  drawCard(pid, deckName) {
    const g = this.g;
    const deck = g.decks[deckName];
    const cardId = deck.shift();
    const card = (deckName === 'chance' ? CHANCE : CHEST).find(c => c.id === cardId);
    g.lastCard = { deck: deckName, id: cardId, pid, at: Date.now() };
    this.gp(pid).stats.cardsDrawn += 1;
    this.addLog('mono.log.card', { name: this.nameOf(pid), deck: deckName, card: cardId });
    if (card.jailFree) { this.gp(pid).jailCards.push(cardId); return; } // kept until used
    deck.push(cardId);
    const gp = this.gp(pid);
    if (card.advance !== undefined) return this.advanceTo(pid, card.advance);
    if (card.back) { gp.pos = (gp.pos - card.back + 40) % 40; return this.land(pid); }
    if (card.jail) return this.sendToJail(pid);
    if (card.money > 0) { gp.cash += card.money; return; }
    if (card.money < 0) return this.charge(pid, -card.money, null, 'card');
    if (card.repairs) {
      let cost = 0;
      for (const sq of this.owned(pid)) {
        const h = this.prop(sq).houses;
        cost += h === 5 ? card.repairs[1] : h * card.repairs[0];
      }
      return this.charge(pid, cost, null, 'card');
    }
    if (card.eachPlayer) {
      for (const other of this.active()) {
        if (other === pid) continue;
        if (card.eachPlayer > 0) this.charge(other, card.eachPlayer, pid, 'card');
        else this.charge(pid, -card.eachPlayer, other, 'card');
      }
      return;
    }
    if (card.nearest) {
      let sq = gp.pos;
      do sq = (sq + 1) % 40; while (SQUARES[sq].type !== card.nearest);
      if (sq < gp.pos) this.passGo(pid, false);
      gp.pos = sq;
      const pr = this.prop(sq);
      if (pr && pr.owner !== pid && !pr.mortgaged) {
        if (card.nearest === 'railway') return this.land(pid, { rentMultiplier: 2 });
        // the utility card: roll again and pay ten times the roll
        const dice = this.rollDice();
        this.g.turn.dice = dice;
        this.g.lastDice = { dice, pid, at: Date.now() };
        this.addLog('mono.log.rolled', { name: this.nameOf(pid), a: dice[0], b: dice[1] });
        return this.land(pid, { utilityTimes: 10 });
      }
      return this.land(pid);
    }
  }

  // ---------- building and mortgages ----------
  manageCheck(pid, sq) {
    this.assert(this.phase === 'playing', 'err.gameNotRunning');
    this.assert(!this.g.auction, 'err.mono.waitForOthers');
    this.assert(this.player(pid) && !this.gp(pid).bankrupt, 'err.notInRoom');
    const pr = this.prop(sq);
    this.assert(pr && pr.owner === pid, 'err.mono.notYours');
    // while someone settles a debt, only they can sell and mortgage
    if (this.g.debts.length) this.assert(this.g.debts[0].pid === pid, 'err.mono.waitForOthers');
    return pr;
  }

  buildHouse(pid, sq) {
    const pr = this.manageCheck(pid, sq);
    this.assert(this.current() === pid && !this.g.debts.length, 'err.mono.buildOnYourTurn');
    const sqr = SQUARES[sq];
    this.assert(sqr.type === 'street', 'err.mono.cantBuild');
    this.assert(this.ownsGroup(pid, sqr.group), 'err.mono.needSet');
    this.assert(!GROUPS[sqr.group].some(s => this.prop(s).mortgaged), 'err.mono.groupMortgaged');
    this.assert(pr.houses < 5, 'err.mono.maxBuilt');
    const min = Math.min(...GROUPS[sqr.group].map(s => this.prop(s).houses));
    this.assert(pr.houses === min, 'err.mono.buildEvenly');
    this.assert(this.gp(pid).cash >= sqr.house, 'err.mono.notEnoughCash');
    if (pr.houses === 4) {
      this.assert(this.g.hotelsLeft > 0, 'err.mono.noHotels');
      this.g.hotelsLeft -= 1;
      this.g.housesLeft += 4;
      this.gp(pid).stats.hotelsBuilt += 1;
    } else {
      this.assert(this.g.housesLeft > 0, 'err.mono.noHouses');
      this.g.housesLeft -= 1;
      this.gp(pid).stats.housesBuilt += 1;
    }
    this.gp(pid).cash -= sqr.house;
    pr.houses += 1;
    this.addLog(pr.houses === 5 ? 'mono.log.hotel' : 'mono.log.house', { name: this.nameOf(pid), square: sq });
    this.trackPeaks();
    this.touch();
  }

  sellHouse(pid, sq) {
    const pr = this.manageCheck(pid, sq);
    const sqr = SQUARES[sq];
    this.assert(pr.houses > 0, 'err.mono.nothingToSell');
    const max = Math.max(...GROUPS[sqr.group].map(s => this.prop(s).houses));
    this.assert(pr.houses === max, 'err.mono.sellEvenly');
    this.sellHouseRaw(pid, sq);
    this.addLog('mono.log.sold', { name: this.nameOf(pid), square: sq });
    this.touch();
  }

  sellHouseRaw(pid, sq) {
    const pr = this.prop(sq);
    const sqr = SQUARES[sq];
    if (pr.houses === 5) {
      // a hotel goes back as four houses, or all the way down if the bank is out of houses
      this.g.hotelsLeft += 1;
      if (this.g.housesLeft >= 4) {
        this.g.housesLeft -= 4;
        pr.houses = 4;
        this.gp(pid).cash += sqr.house / 2;
      } else {
        pr.houses = 0;
        this.gp(pid).cash += (5 * sqr.house) / 2;
      }
      return;
    }
    pr.houses -= 1;
    this.g.housesLeft += 1;
    this.gp(pid).cash += sqr.house / 2;
  }

  mortgage(pid, sq) {
    const pr = this.manageCheck(pid, sq);
    this.assert(!pr.mortgaged, 'err.mono.alreadyMortgaged');
    if (SQUARES[sq].group) this.assert(!this.groupHasBuildings(SQUARES[sq].group), 'err.mono.sellHousesFirst');
    this.mortgageRaw(pid, sq);
    this.addLog('mono.log.mortgaged', { name: this.nameOf(pid), square: sq });
    this.touch();
  }

  mortgageRaw(pid, sq) {
    this.prop(sq).mortgaged = true;
    if (this.settings.mortgageTurns) this.prop(sq).mortgageLeft = this.settings.mortgageTurns;
    this.gp(pid).cash += SQUARES[sq].price / 2;
  }

  unmortgageCost(sq) {
    return Math.ceil((SQUARES[sq].price * 11) / 20); // mortgage value + 10%, in whole roubles
  }

  unmortgage(pid, sq) {
    const pr = this.manageCheck(pid, sq);
    this.assert(pr.mortgaged, 'err.mono.notMortgaged');
    const cost = this.unmortgageCost(sq);
    this.assert(this.gp(pid).cash >= cost, 'err.mono.notEnoughCash');
    this.gp(pid).cash -= cost;
    pr.mortgaged = false;
    delete pr.mortgageLeft;
    this.addLog('mono.log.unmortgaged', { name: this.nameOf(pid), square: sq });
    this.touch();
  }

  // ---------- debts and bankruptcy ----------
  payDebt(pid) {
    const d = this.g.debts[0];
    this.assert(d && d.pid === pid, 'err.mono.noDebt');
    this.assert(this.gp(pid).cash >= d.amount, 'err.mono.notEnoughCash');
    this.g.debts.shift();
    this.transfer(pid, d.amount, d.to && !this.gp(d.to).bankrupt ? d.to : null, d.reason);
    this.addLog('mono.log.debtPaid', { name: this.nameOf(pid), amount: d.amount });
    if (this.g.debts[0]) this.g.debts[0].endsAt = this.turnDeadline();
    this.afterAction();
  }

  declareBankruptcy(pid) {
    const d = this.g.debts[0];
    this.assert(d && d.pid === pid, 'err.mono.noDebt');
    this.bankrupt(pid);
  }

  // Leave a running game: everything goes back to the bank.
  resign(pid) {
    this.assert(this.phase === 'playing' && this.player(pid) && !this.gp(pid).bankrupt, 'err.notInRoom');
    this.g.debts = this.g.debts.filter(x => x.pid !== pid);
    this.goBankrupt(pid, null);
    this.addLog('mono.log.resigned', { name: this.nameOf(pid) });
    this.afterBankruptcy(pid);
  }

  bankrupt(pid) {
    const d = this.g.debts.find(x => x.pid === pid);
    const creditor = d && d.to && !this.gp(d.to).bankrupt ? d.to : null;
    this.g.debts = this.g.debts.filter(x => x.pid !== pid);
    this.goBankrupt(pid, creditor);
    this.addLog('mono.log.bankrupt', { name: this.nameOf(pid), to: creditor ? this.nameOf(creditor) : null });
    this.afterBankruptcy(pid);
  }

  goBankrupt(pid, creditor) {
    const g = this.g;
    const gp = this.gp(pid);
    // buildings go back to the bank at half price first
    for (const sq of this.owned(pid)) {
      const pr = this.prop(sq);
      while (pr.houses > 0) this.sellHouseRaw(pid, sq);
    }
    for (const sq of this.owned(pid)) {
      if (creditor) this.prop(sq).owner = creditor; // the creditor takes them, mortgages and all
      else delete g.props[sq]; // back to the bank, free and clear
    }
    if (creditor) {
      this.gp(creditor).cash += Math.max(0, gp.cash);
      this.gp(creditor).jailCards.push(...gp.jailCards);
    } else {
      for (const card of gp.jailCards) g.decks[card.startsWith('c.') ? 'chance' : 'chest'].push(card);
    }
    gp.cash = 0;
    gp.jailCards = [];
    gp.bankrupt = true;
    gp.bankruptAt = this.active().length; // finishing place: the last one standing is 1st
    g.trades = g.trades.filter(tr => tr.from !== pid && tr.to !== pid);
  }

  afterBankruptcy(pid) {
    if (this.checkWin()) return;
    if (this.g.auction && this.g.auction.bidder === pid) { this.g.auction.bidder = null; this.g.auction.bid = 0; }
    if (this.current() === pid) {
      this.g.turn.extraRoll = false;
      if (!this.g.debts.length && !this.g.auction) return this.nextTurn();
    }
    this.afterAction();
  }

  checkWin() {
    const g = this.g;
    const left = this.active();
    if (left.length > 1) return false;
    g.winner = left[0] || null;
    g.ended = true;
    g.auction = null;
    g.debts = [];
    this.phase = 'ended';
    this.dispose();
    if (g.winner) this.addLog('mono.log.winner', { name: this.nameOf(g.winner) });
    this.onGameEnd(this.gameResults());
    this.touch();
    return true;
  }

  // ---------- trades ----------
  // offer: { to, give: { props, cash, cards }, take: { props, cash, cards } }
  proposeTrade(pid, offer) {
    this.assert(this.phase === 'playing' && this.player(pid) && !this.gp(pid).bankrupt, 'err.notInRoom');
    const to = offer?.to;
    this.assert(to && to !== pid && this.g.players[to] && !this.gp(to).bankrupt, 'err.invalidTarget');
    const clean = side => ({
      props: [...new Set((side?.props || []).map(Number))],
      cash: Math.max(0, Math.floor(Number(side?.cash) || 0)),
      cards: Math.max(0, Math.floor(Number(side?.cards) || 0)),
    });
    const tr = { id: id(4), from: pid, to, give: clean(offer.give), take: clean(offer.take), at: Date.now() };
    this.assert(tr.give.props.length || tr.give.cash || tr.give.cards || tr.take.props.length || tr.take.cash || tr.take.cards, 'err.mono.emptyTrade');
    this.validateTrade(tr);
    this.g.trades = this.g.trades.filter(x => x.from !== pid); // one open offer per player
    this.g.trades.push(tr);
    this.addLog('mono.log.tradeOffered', { name: this.nameOf(pid), to: this.nameOf(to) });
    this.touch();
    return tr;
  }

  validateTrade(tr) {
    const side = (owner, s) => {
      for (const sq of s.props) {
        const pr = this.prop(sq);
        this.assert(isProperty(sq) && pr && pr.owner === owner, 'err.mono.tradeInvalid');
        if (SQUARES[sq].group) this.assert(!this.groupHasBuildings(SQUARES[sq].group), 'err.mono.sellHousesFirst');
      }
      this.assert(this.gp(owner).cash >= s.cash, 'err.mono.notEnoughCash');
      this.assert(this.gp(owner).jailCards.length >= s.cards, 'err.mono.tradeInvalid');
    };
    side(tr.from, tr.give);
    side(tr.to, tr.take);
    this.checkFairness(tr);
  }

  // Refuse deals that are clearly unfair (gifts, a colour set sold off cheap) — the usual way to fix a game.
  checkFairness(tr) {
    const propValue = sq => (this.prop(sq).mortgaged ? SQUARES[sq].price / 2 : SQUARES[sq].price);
    const value = s => s.props.reduce((t, sq) => t + propValue(sq), 0) + s.cash + s.cards * JAIL_CARD_VALUE;
    // the properties among `props` that complete a colour set for `pid` once the trade is done
    const completing = (pid, props, givingAway) => props.filter(sq => {
      const group = SQUARES[sq].group;
      if (!group) return false;
      return GROUPS[group].every(x => props.includes(x) || (this.prop(x)?.owner === pid && !givingAway.includes(x)));
    });
    const fromSet = completing(tr.from, tr.take.props, tr.give.props); // what `from` completes
    const toSet = completing(tr.to, tr.give.props, tr.take.props);
    const fromGives = value(tr.give), toGives = value(tr.take);
    // 1) one side hands over more than twice what it gets back, with no colour set to show for it
    if (fromGives > 0 && toGives * UNFAIR_RATIO < fromGives && !fromSet.length) throw new GameError('err.mono.unfairTrade');
    if (toGives > 0 && fromGives * UNFAIR_RATIO < toGives && !toSet.length) throw new GameError('err.mono.unfairTrade');
    // 2) a property that completes someone's colour set must go for at least its full price
    //    (fine when both sides complete a set)
    const fullPrice = props => props.reduce((t, sq) => t + SQUARES[sq].price, 0);
    if (toSet.length && !fromSet.length && toGives < fullPrice(toSet)) throw new GameError('err.mono.cheapMonopoly', { min: fullPrice(toSet) });
    if (fromSet.length && !toSet.length && fromGives < fullPrice(fromSet)) throw new GameError('err.mono.cheapMonopoly', { min: fullPrice(fromSet) });
  }

  respondTrade(pid, tradeId, accept) {
    this.assert(this.phase === 'playing', 'err.gameNotRunning');
    const tr = this.g.trades.find(x => x.id === tradeId);
    this.assert(tr, 'err.mono.tradeGone');
    if (!accept) {
      this.assert(pid === tr.to || pid === tr.from, 'err.invalidTarget');
      this.g.trades = this.g.trades.filter(x => x !== tr);
      this.addLog(pid === tr.from ? 'mono.log.tradeCancelled' : 'mono.log.tradeDeclined', { name: this.nameOf(pid) });
      this.touch();
      return;
    }
    this.assert(pid === tr.to, 'err.invalidTarget');
    this.assert(!this.g.auction, 'err.mono.waitForOthers');
    this.validateTrade(tr);
    // taking over a mortgaged property costs 10% interest right away
    const interest = props => props.filter(sq => this.prop(sq).mortgaged).reduce((s, sq) => s + Math.ceil(SQUARES[sq].price / 20), 0);
    const toPays = interest(tr.give.props) + tr.take.cash;
    const fromPays = interest(tr.take.props) + tr.give.cash;
    this.assert(this.gp(tr.to).cash + tr.give.cash >= toPays, 'err.mono.notEnoughCash');
    this.assert(this.gp(tr.from).cash + tr.take.cash >= fromPays, 'err.mono.notEnoughCash');
    const a = this.gp(tr.from);
    const b = this.gp(tr.to);
    a.cash += tr.take.cash - tr.give.cash - interest(tr.take.props);
    b.cash += tr.give.cash - tr.take.cash - interest(tr.give.props);
    for (const sq of tr.give.props) this.prop(sq).owner = tr.to;
    for (const sq of tr.take.props) this.prop(sq).owner = tr.from;
    b.jailCards.push(...a.jailCards.splice(0, tr.give.cards));
    a.jailCards.push(...b.jailCards.splice(0, tr.take.cards));
    a.stats.trades += 1;
    b.stats.trades += 1;
    this.g.trades = this.g.trades.filter(x => x !== tr);
    this.addLog('mono.log.tradeDone', { name: this.nameOf(tr.from), to: this.nameOf(tr.to) });
    this.trackPeaks();
    this.touch();
  }

  expireTrades() {
    const now = Date.now();
    const before = this.g?.trades.length || 0;
    if (this.g) this.g.trades = this.g.trades.filter(tr => now - tr.at < TRADE_TTL_MS);
    if (this.g && this.g.trades.length !== before) this.touch();
  }

  // ---------- end of game ----------
  gameResults() {
    const g = this.g;
    const n = g.order.length;
    return g.order.map(pid => {
      const p = this.player(pid);
      if (!p || !p.userId) return null;
      const gp = this.gp(pid);
      const groups = {};
      for (const sq of this.owned(pid)) if (SQUARES[sq].group) groups[SQUARES[sq].group] = (groups[SQUARES[sq].group] || 0) + 1;
      return {
        userId: p.userId,
        won: pid === g.winner,
        place: pid === g.winner ? 1 : gp.bankruptAt ? gp.bankruptAt + 1 : 2,
        players: n,
        bankrupt: gp.bankrupt,
        netWorth: gp.bankrupt ? 0 : this.netWorth(pid),
        ...gp.stats,
        topGroup: Object.entries(groups).sort((x, y) => y[1] - x[1])[0]?.[0] || null,
        rounds: g.round,
        at: Date.now(),
      };
    }).filter(Boolean);
  }

  // ---------- view: in Monopoly everything is public ----------
  viewFor(pid) {
    const me = this.member(pid);
    const decorate = p => {
      const profile = p.userId ? this.profileOf(p.userId) : null;
      return {
        id: p.id, userId: p.userId, name: p.name, connected: p.connected, ready: !!p.ready, piece: p.piece,
        avatar: profile?.avatar || null, score: profile ? profile.score : null, cos: profile?.equipped || {},
      };
    };
    const view = {
      code: this.code,
      phase: this.phase,
      hostId: this.hostId,
      serverNow: Date.now(),
      settings: { ...this.settings },
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      tokens: TOKENS,
      players: this.players.map(decorate),
      spectators: this.spectators.map(decorate),
      me: me ? { id: me.id, name: me.name, spectator: !!this.spectator(pid) } : null,
      gameId: this.gameId,
    };
    if (this.g) {
      const g = this.g;
      view.game = {
        order: g.order,
        players: Object.fromEntries(Object.entries(g.players).map(([k, v]) => [k, {
          cash: v.cash, pos: v.pos, inJail: v.inJail, jailTurns: v.jailTurns, jailCards: v.jailCards.length,
          bankrupt: v.bankrupt, bankruptAt: v.bankruptAt, netWorth: v.bankrupt ? 0 : this.netWorth(k),
        }])),
        props: g.props,
        housesLeft: g.housesLeft,
        hotelsLeft: g.hotelsLeft,
        pot: g.pot,
        turn: g.turn,
        debts: g.debts,
        auction: g.auction,
        trades: g.trades,
        lastCard: g.lastCard,
        lastDice: g.lastDice,
        log: g.log.slice(-80),
        winner: g.winner,
        round: g.round,
        unmortgageCosts: Object.fromEntries(Object.keys(g.props).map(sq => [sq, this.unmortgageCost(Number(sq))])),
      };
    }
    return view;
  }
}

module.exports = { MonoRoom, TOKENS, MIN_PLAYERS, MAX_PLAYERS, AUCTION_MS, BAIL, SALARY, SCALE };
