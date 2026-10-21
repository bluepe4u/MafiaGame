'use strict';

// Texas hold'em (no limit) for a home game: chips only, no money. Blinds and antes, the
// betting with full and short all-in raises, side pots, the all-in runout with each hand's
// equity street by street, the showdown and the story of the hand (suckouts, runner-runner,
// coolers), the "rabbit hunt" (what the board would have been) and a session that ends when
// the host says so or one player has all the chips. No I/O: timers and randomness are injected.

const crypto = require('crypto');
const { GameError } = require('../game');
const PH = require('./hand');

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 9;
const MAX_SPECTATORS = 20;
const HOST_GRACE_MS = 30 * 1000;
const HISTORY_KEEP = 30;
const AUTO_MS = 700; // a player who left or sits out: folded (or checked) at once
const OFFLINE_MS = 30 * 1000; // no turn clock and the player's offline: wait this long
// pauses for the table to see what happened
const PAUSE = { fold: 6000, showdown: 9000, runout: { flop: 1800, turn: 2400, river: 3600 } };
// blind levels as multiples of the starting blinds
const LEVELS = [1, 1.5, 2, 3, 4, 5, 6, 8, 10, 15, 20, 30, 40, 50, 60, 80, 100, 150, 200];
const STREETS = ['preflop', 'flop', 'turn', 'river'];

const INT_SETTINGS = {
  startStack: [100, 100000],
  smallBlind: [1, 5000],
  bigBlind: [2, 10000],
  ante: [0, 5000],
  levelHands: [0, 100], // 0: the blinds never go up
  turnSeconds: [10, 120], // 0: no clock
};
const BOOL_SETTINGS = ['rebuy', 'rabbit', 'showEquity', 'lateJoin', 'voice'];
// what the chips are: site chips from the players' wallets (the fun part), or USDT settled
// player to player after the session (the site only works out who pays whom and records it)
const BANKS = ['chips', 'usdt'];
const USDT_MIN = 1;
const USDT_MAX = 10000;
// a wallet that never runs out (tests, rooms made without one)
const OPEN_WALLET = { balance: () => Infinity, take: () => true, give: () => {} };
const defaultSettings = () => ({
  startStack: 500, smallBlind: 5, bigBlind: 10, ante: 0, levelHands: 0, turnSeconds: 30,
  rebuy: true, rabbit: true, showEquity: false, lateJoin: true, voice: true,
  bank: 'chips', usdtBuyIn: 10,
});

const SAVED_FIELDS = ['code', 'players', 'spectators', 'hostId', 'settings', 'phase', 'g', 'gameId', 'lastActivity', 'tableId', 'fairNext'];
const id = (bytes = 6) => crypto.randomBytes(bytes).toString('hex');
const emptySeatStats = () => ({ hands: 0, vpip: 0, pfr: 0, won: 0, showdowns: 0, sdWon: 0, allIns: 0, allInsWon: 0, biggestPot: 0, best: null });

class PokerRoom {
  constructor({
    code, rng = Math.random, onChange = () => {}, setTimer = setTimeout, clearTimer = clearTimeout,
    profileOf = () => null, onGameEnd = () => {}, onStart = () => {}, onArchive = () => {}, onSettle = () => {}, tableId = null,
    wallet = OPEN_WALLET, usdtOk = () => true, fair = null,
    features = () => ({ family: true, voice: true, transcripts: true }),
  } = {}) {
    this.onSettle = onSettle;
    this.fair = fair; // provably fair decks (src/poker/fair.js); without it the deck comes from rng
    this.wallet = wallet; // site chips: { balance(userId), take(userId, n, reason, extra) -> bool, give(userId, n, reason, extra) }
    this.usdtOk = usdtOk; // userId -> has a USDT address to be paid at
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
    this.settings = defaultSettings();
    this.phase = 'lobby';
    this.g = null;
    this.gameId = null;
    this.timer = null;
    this.timerSeq = 0;
    this.lastActivity = Date.now();
    this.fairNext = null; // { seed, commit } of the next hand: the commitment is public, the seed is not
    this.armFair();
  }

  // a seed for the next hand, committed to before the players' seeds for it are in
  armFair() {
    if (this.fair && !this.fairNext) {
      const seed = this.fair.newSeed();
      this.fairNext = { seed, commit: this.fair.commit(seed) };
    }
  }

  // each browser sends a fresh seed of its own whenever it sees a new commitment
  setClientSeed(pid, seed) {
    const p = this.player(pid);
    if (!p) return; // spectators aren't dealt in
    p.clientSeed = this.fair ? this.fair.cleanClientSeed(seed) : '';
  }

  // after the session: every hand's seeds, to recompute the decks
  fairLog() {
    this.assert(this.phase === 'ended' && this.g && this.g.fairLog, 'err.pk.notNow');
    return { hands: this.g.fairLog };
  }

  toJSON() { return Object.fromEntries(SAVED_FIELDS.map(k => [k, this[k]])); }

  static restore(data, opts = {}) {
    const room = new PokerRoom({ ...opts, code: data.code });
    const defaults = room.settings;
    for (const k of SAVED_FIELDS) if (data[k] !== undefined) room[k] = data[k];
    room.settings = { ...defaults, ...room.settings };
    for (const p of [...room.players, ...room.spectators]) p.connected = false;
    room.armFair();
    // a fresh clock for whatever was running when the server went down
    const h = room.g && room.g.hand;
    if (room.phase === 'playing' && h) {
      if (h.stage === 'betting') h.actEndsAt = room.actDeadline();
      else h.nextAt = Date.now() + 3000;
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

  // In a game a player who leaves keeps their seat's result (their chips), and is folded from now on.
  leave(pid) {
    if (this.spectator(pid)) this.spectators = this.spectators.filter(x => x.id !== pid);
    else if (this.player(pid)) {
      if (this.phase === 'lobby') this.players = this.players.filter(x => x.id !== pid);
      else {
        this.player(pid).connected = false;
        const seat = this.g && this.g.seats[pid];
        if (seat) seat.left = true;
      }
    }
    if (this.hostId === pid) {
      this.hostId = (this.players.find(p => p.id !== pid && p.connected && !this.g?.seats[p.id]?.left) || this.spectators.find(p => p.id !== pid) || this.players.find(p => p.id !== pid))?.id || null;
    }
    this.touch();
    if (this.phase === 'playing') this.maybeStartHand();
  }

  setConnected(pid, connected) {
    const p = this.member(pid);
    if (!p) return;
    p.connected = connected;
    if (connected && this.g && this.g.seats[pid]) this.g.seats[pid].left = false;
    if (this.hostTimer && this.hostTimer.pid === pid) { this.clearTimer(this.hostTimer.handle); this.hostTimer = null; }
    if (!connected && this.hostId === pid) {
      this.hostTimer = { pid, handle: this.setTimer(() => {
        this.hostTimer = null;
        const host = this.member(pid);
        if (this.hostId !== pid || (host && host.connected)) return;
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
    const next = { ...this.settings };
    for (const [k, [min, max]] of Object.entries(INT_SETTINGS)) {
      if (s[k] === undefined) continue;
      const v = Number(s[k]);
      const zeroOk = k === 'turnSeconds' || k === 'levelHands' || k === 'ante';
      this.assert(Number.isInteger(v) && ((zeroOk && v === 0) || (v >= min && v <= max)), zeroOk && min > 0 ? 'err.pk.rangeOrZero' : 'err.pk.range', { min, max });
      next[k] = v;
    }
    for (const k of BOOL_SETTINGS) if (s[k] !== undefined) next[k] = !!s[k];
    if (s.bank !== undefined) {
      this.assert(BANKS.includes(s.bank), 'err.invalidTarget');
      next.bank = s.bank;
    }
    if (s.usdtBuyIn !== undefined) {
      const v = Math.round(Number(s.usdtBuyIn) * 100) / 100;
      this.assert(Number.isFinite(v) && v >= USDT_MIN && v <= USDT_MAX, 'err.pk.range', { min: USDT_MIN, max: USDT_MAX });
      next.usdtBuyIn = v;
    }
    if (s.voice) this.assert(this.features().voice, 'err.featureOff');
    // the big blind is at least the small one; changing one moves the other along if needed
    if (next.bigBlind < next.smallBlind) {
      if (s.bigBlind !== undefined) next.smallBlind = next.bigBlind; else next.bigBlind = next.smallBlind;
    }
    this.assert(next.startStack >= next.bigBlind * 2, 'err.pk.stackTooSmall');
    this.settings = next;
    this.touch();
  }

  // ---------- money: site chips from wallets, or USDT settled player to player ----------
  uidOf(pid) { return this.player(pid)?.userId || null; }

  // take a buy-in from a player's wallet (site chips)
  buyIn(pid, reason) {
    if (this.settings.bank !== 'chips') return;
    const uid = this.uidOf(pid);
    this.assert(uid && this.wallet.take(uid, this.settings.startStack, reason, { code: this.code }), 'err.pk.noChipsMe', { n: this.settings.startStack });
  }

  // USDT: each player's result in cents, then the fewest transfers that settle it
  settlement(st) {
    const rate = Math.round(this.settings.usdtBuyIn * 100) / this.settings.startStack; // cents per chip
    const rows = st.map(x => ({ pid: x.pid, c: Math.round(x.net * rate) }));
    // rounding: the biggest winner takes up the odd cents so it adds up to zero
    const drift = rows.reduce((a, x) => a + x.c, 0);
    if (drift && rows.length) rows.slice().sort((a, b) => b.c - a.c)[0].c -= drift;
    const credit = rows.filter(x => x.c > 0).map(x => ({ ...x })).sort((a, b) => b.c - a.c);
    const debit = rows.filter(x => x.c < 0).map(x => ({ pid: x.pid, c: -x.c })).sort((a, b) => b.c - a.c);
    const out = [];
    for (const d of debit) {
      while (d.c > 0 && credit.length) {
        const cr = credit[0];
        const n = Math.min(d.c, cr.c);
        out.push({ from: d.pid, to: cr.pid, cents: n });
        d.c -= n;
        cr.c -= n;
        if (!cr.c) credit.shift();
      }
    }
    return { rows, transfers: out };
  }

  // ---------- the session ----------
  start(pid) {
    this.requireHost(pid);
    this.assert(this.phase === 'lobby', 'err.gameStarted');
    this.assert(this.players.length >= MIN_PLAYERS, 'err.needPlayers', { min: MIN_PLAYERS });
    const names = list => list.map(p => p.name).join(', ');
    if (this.settings.bank === 'chips') {
      const short = this.players.filter(p => !p.userId || this.wallet.balance(p.userId) < this.settings.startStack);
      this.assert(!short.length, 'err.pk.noChips', { names: names(short), n: this.settings.startStack });
    } else {
      // real money: everyone agrees to the buy-in (ready) and has an address to be paid at
      const noAddr = this.players.filter(p => !p.userId || !this.usdtOk(p.userId));
      this.assert(!noAddr.length, 'err.pk.usdtNoAddress', { names: names(noAddr) });
      const notReady = this.players.filter(p => !p.ready);
      this.assert(!notReady.length, 'err.pk.usdtNotReady', { names: names(notReady) });
    }
    if (this.settings.bank === 'chips') for (const p of this.players) this.wallet.take(p.userId, this.settings.startStack, 'pk.buyin', { code: this.code });
    const order = this.shuffle(this.players.map(p => p.id));
    this.gameId = id();
    this.g = {
      order, // seats round the table
      seats: Object.fromEntries(order.map(p => [p, this.newSeat()])),
      handN: 0,
      button: null,
      level: 0,
      blinds: { sb: this.settings.smallBlind, bb: this.settings.bigBlind, ante: this.settings.ante },
      hand: null,
      history: [], // the last hands, for the hand history
      busted: [], // in order (sessions without rebuys)
      biggest: null, // { amount, pid, n }
      paused: false,
      ending: false,
      startedAt: Date.now(),
      fairLog: this.fair ? [] : null, // { n, commit, seed, clients, nonce, players }, revealed when the session ends
    };
    for (const p of this.players) p.ready = false;
    this.phase = 'playing';
    this.onStart(this);
    this.startHand();
  }

  newSeat() {
    return { stack: this.settings.startStack, buyins: 1, sitOut: false, left: false, bustedAt: null, stats: emptySeatStats() };
  }

  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  seat(pid) { return this.g && this.g.seats[pid]; }
  // dealt into the next hand
  canPlay(pid) { const s = this.seat(pid); return !!(s && s.stack > 0 && !s.sitOut && !s.left); }
  // the next seat round the table (from pid, not including it) that passes the test
  nextSeat(pid, test, list = this.g.order) {
    const n = list.length;
    const i = list.indexOf(pid);
    for (let k = 1; k <= n; k++) {
      const q = list[(i + k + n) % n];
      if (test(q)) return q;
    }
    return null;
  }

  // a session with no rebuys is over when one player has all the chips
  sessionOver() {
    const g = this.g;
    const withChips = g.order.filter(p => g.seats[p].stack > 0);
    return !this.settings.rebuy && withChips.length <= 1;
  }

  // start the next hand if there's no hand and enough players (after a rebuy, a return, a pause)
  maybeStartHand() {
    const g = this.g;
    if (this.phase !== 'playing' || !g || g.paused) return;
    if (!g.hand) this.startHand();
  }

  startHand() {
    const g = this.g;
    if (g.ending || this.sessionOver()) return this.endGame();
    const live = g.order.filter(p => this.canPlay(p));
    if (live.length < 2 || g.paused) {
      g.hand = null;
      return this.touch();
    }
    g.handN += 1;
    // the blinds go up every N hands
    const s = this.settings;
    if (s.levelHands) {
      g.level = Math.min(LEVELS.length - 1, Math.floor((g.handN - 1) / s.levelHands));
      const m = LEVELS[g.level];
      g.blinds = { sb: Math.max(1, Math.round(s.smallBlind * m)), bb: Math.max(2, Math.round(s.bigBlind * m)), ante: Math.round(s.ante * m) };
    }
    // the button moves to the next player dealt in; heads up, the button is the small blind
    g.button = g.button && live.length ? this.nextSeat(g.button, p => live.includes(p)) : live[Math.floor(this.rng() * live.length)];
    const sbPid = live.length === 2 ? g.button : this.nextSeat(g.button, p => live.includes(p));
    const bbPid = this.nextSeat(sbPid, p => live.includes(p));
    const seats = g.order.filter(p => live.includes(p));
    let deck;
    let fair = null;
    if (this.fair && g.fairLog) {
      this.armFair();
      const { seed, commit } = this.fairNext;
      const clients = seats.map(p => this.player(p)?.clientSeed || '');
      const nonce = `${this.gameId}:${g.handN}`;
      deck = this.fair.deckOf(seed, clients, nonce);
      const from = seats.indexOf(sbPid);
      const dealt = seats.map((_, k) => seats[(from + k) % seats.length]);
      g.fairLog.push({ n: g.handN, commit, seed, clients, nonce, players: dealt.map(p => this.player(p)?.name || '?') });
      fair = { commit, clients };
      this.fairNext = null;
      this.armFair();
    } else deck = this.shuffle(PH.DECK);
    const h = {
      n: g.handN, button: g.button, sbPid, bbPid, seats, deck, board: [], burned: 0,
      hole: {}, bets: {}, total: {}, folded: {}, allIn: {}, acted: {}, shown: {},
      start: Object.fromEntries(seats.map(p => [p, g.seats[p].stack])),
      blinds: { ...g.blinds },
      street: 'preflop', stage: 'betting',
      currentBet: 0, minRaise: g.blinds.bb, lastAggr: null, toAct: null, actEndsAt: null,
      actions: [], equity: [], nextAt: null, squeeze: false, result: null, rabbit: null, fair,
    };
    g.hand = h;
    // two cards each, one at a time from the small blind
    const from = seats.indexOf(sbPid);
    for (let round = 0; round < 2; round++) {
      for (let k = 0; k < seats.length; k++) {
        const p = seats[(from + k) % seats.length];
        (h.hole[p] = h.hole[p] || []).push(deck.pop());
      }
    }
    for (const p of seats) { h.bets[p] = 0; h.total[p] = 0; g.seats[p].stats.hands += 1; }
    if (g.blinds.ante) for (const p of seats) this.put(p, g.blinds.ante, { dead: true, type: 'ante' });
    this.put(sbPid, g.blinds.sb, { type: 'sb' });
    this.put(bbPid, g.blinds.bb, { type: 'bb' });
    h.currentBet = g.blinds.bb;
    h.toAct = this.nextToAct(bbPid);
    if (!h.toAct) return this.closeStreet();
    h.actEndsAt = this.actDeadline();
    this.touch();
  }

  // chips from a stack into the pot; dead money (antes) doesn't count towards the bet to call
  put(pid, amount, { dead = false, type = null } = {}) {
    const h = this.g.hand;
    const seat = this.g.seats[pid];
    const a = Math.min(amount, seat.stack);
    seat.stack -= a;
    h.total[pid] += a;
    if (!dead) h.bets[pid] += a;
    if (seat.stack === 0) h.allIn[pid] = true;
    if (type) h.actions.push({ s: h.street, pid, a: type, amt: a, to: h.bets[pid] });
    return a;
  }

  actDeadline() { return this.settings.turnSeconds ? Date.now() + this.settings.turnSeconds * 1000 : null; }

  // who acts next after pid: still in, not all-in, and hasn't acted since the last raise or is behind the bet
  nextToAct(pid) {
    const h = this.g.hand;
    return this.nextSeat(pid, p => !h.folded[p] && !h.allIn[p] && (!h.acted[p] || h.bets[p] < h.currentBet), h.seats);
  }

  // what the player to act may do
  options(pid) {
    const h = this.g.hand;
    if (!h || h.stage !== 'betting' || h.toAct !== pid) return null;
    const stack = this.g.seats[pid].stack;
    const toCall = Math.min(h.currentBet - h.bets[pid], stack);
    const maxTo = h.bets[pid] + stack;
    // a raise needs at least the last raise on top; less is only possible all-in. A short all-in
    // doesn't reopen the betting for those who've already acted.
    const canRaise = maxTo > h.currentBet && !h.acted[pid] && h.seats.some(p => p !== pid && !h.folded[p] && !h.allIn[p]);
    const minTo = Math.min(maxTo, h.currentBet + h.minRaise);
    return { toCall, canCheck: toCall === 0, canRaise, minTo, maxTo, currentBet: h.currentBet, isBet: h.currentBet === 0 };
  }

  act(pid, type, amount) {
    this.assert(this.phase === 'playing', 'err.pk.notNow');
    const h = this.g.hand;
    this.assert(h && h.stage === 'betting', 'err.pk.notNow');
    this.assert(h.toAct === pid, 'err.pk.notYourTurn');
    const o = this.options(pid);
    const seat = this.g.seats[pid];
    let entry;
    if (type === 'fold') {
      h.folded[pid] = true;
      entry = { a: 'fold' };
    } else if (type === 'check') {
      this.assert(o.canCheck, 'err.pk.cantCheck');
      entry = { a: 'check' };
    } else if (type === 'call') {
      this.assert(o.toCall > 0, 'err.pk.nothingToCall');
      const amt = this.put(pid, o.toCall);
      entry = { a: h.allIn[pid] ? 'allin' : 'call', amt };
    } else if (type === 'raise' || type === 'allin') {
      let to = type === 'allin' ? o.maxTo : Math.floor(Number(amount));
      if (type === 'allin' && !o.canRaise) {
        // all-in for no more than a call: it's a call
        this.assert(o.toCall > 0, 'err.pk.cantRaise');
        return this.act(pid, 'call');
      }
      this.assert(o.canRaise, 'err.pk.cantRaise');
      this.assert(Number.isInteger(to) && to <= o.maxTo && (to >= o.minTo || to === o.maxTo), 'err.pk.raiseRange', { min: o.minTo, max: o.maxTo });
      const wasBet = h.currentBet === 0;
      const amt = this.put(pid, to - h.bets[pid]);
      const raise = to - h.currentBet;
      if (raise >= h.minRaise) {
        // a full raise: everyone else gets to act again
        h.minRaise = raise;
        h.acted = {};
      }
      h.currentBet = Math.max(h.currentBet, to);
      h.lastAggr = pid;
      entry = { a: h.allIn[pid] ? 'allin' : wasBet ? 'bet' : 'raise', amt };
      if (h.street === 'preflop') seat.stats.pfr += h.actions.some(x => x.pid === pid && x.s === 'preflop' && (x.a === 'raise' || x.a === 'bet' || x.a === 'allin')) ? 0 : 1;
    } else {
      throw new GameError('err.invalidTarget');
    }
    // voluntarily put money in before the flop (once a hand)
    if (h.street === 'preflop' && entry.amt && !h.actions.some(x => x.pid === pid && x.s === 'preflop' && x.vol)) {
      seat.stats.vpip += 1;
      entry.vol = true;
    }
    h.acted[pid] = true;
    h.actions.push({ s: h.street, pid, ...entry, to: h.bets[pid] });
    this.afterAction(pid);
  }

  afterAction(pid) {
    const h = this.g.hand;
    const inHand = h.seats.filter(p => !h.folded[p]);
    if (inHand.length === 1) return this.winUncontested(inHand[0]);
    const next = this.nextToAct(pid);
    if (next) {
      h.toAct = next;
      h.actEndsAt = this.actDeadline();
      return this.touch();
    }
    this.closeStreet();
  }

  // a bet nobody matched goes back to whoever made it
  refundUncalled() {
    const h = this.g.hand;
    const sorted = h.seats.slice().sort((a, b) => h.bets[b] - h.bets[a]);
    const top = sorted[0];
    const second = sorted[1] ? h.bets[sorted[1]] : 0;
    const extra = h.bets[top] - second;
    if (extra > 0) {
      h.bets[top] -= extra;
      h.total[top] -= extra;
      this.g.seats[top].stack += extra;
      if (this.g.seats[top].stack > 0) delete h.allIn[top];
      h.actions.push({ s: h.street, pid: top, a: 'return', amt: extra });
    }
  }

  closeStreet() {
    const h = this.g.hand;
    this.refundUncalled();
    for (const p of h.seats) h.bets[p] = 0;
    h.toAct = null;
    h.actEndsAt = null;
    h.currentBet = 0;
    h.minRaise = h.blinds.bb;
    h.acted = {};
    if (h.street === 'river') return this.showdown();
    const canAct = h.seats.filter(p => !h.folded[p] && !h.allIn[p]);
    if (canAct.length <= 1) {
      // nobody can bet any more: the hands go face up and the board is dealt out slowly
      h.stage = 'runout';
      for (const p of h.seats) if (!h.folded[p]) h.shown[p] = true;
      this.liveEquity();
      this.scheduleRunout();
      return this.touch();
    }
    this.dealStreet();
    h.toAct = this.nextToAct(h.button);
    h.actEndsAt = this.actDeadline();
    this.touch();
  }

  dealStreet() {
    const h = this.g.hand;
    const i = STREETS.indexOf(h.street);
    h.street = STREETS[i + 1];
    h.deck.pop(); // burn
    h.burned += 1;
    const n = h.street === 'flop' ? 3 : 1;
    for (let k = 0; k < n; k++) h.board.push(h.deck.pop());
  }

  scheduleRunout() {
    const h = this.g.hand;
    const next = STREETS[STREETS.indexOf(h.street) + 1];
    h.nextAt = Date.now() + PAUSE.runout[next];
    // the last card in a hand that's still open: dealt slowly, like a squeeze
    h.squeeze = next === 'river';
  }

  // during a runout: everyone's chances from the current board
  liveEquity() {
    const h = this.g.hand;
    if (!this.settings.showEquity) return;
    const pids = h.seats.filter(p => !h.folded[p]);
    if (pids.length < 2 || h.equity.some(e => e.street === h.street)) return;
    const e = PH.equity(pids.map(p => h.hole[p]), h.board, { samples: 20000, seed: h.n * 7919 + h.board.length });
    h.equity.push({
      street: h.street,
      eq: Object.fromEntries(pids.map((p, i) => [p, e.eq[i]])),
      outs: e.outs ? Object.fromEntries(pids.map((p, i) => [p, e.outs[i]])) : null,
    });
  }

  // the timer of a runout: the next street, or the showdown after the river
  runoutStep() {
    const h = this.g.hand;
    this.dealStreet();
    if (h.street === 'river') return this.showdown();
    this.liveEquity();
    this.scheduleRunout();
    this.touch();
  }

  // ---------- the end of a hand ----------
  winUncontested(pid) {
    const h = this.g.hand;
    this.refundUncalled();
    for (const p of h.seats) h.bets[p] = 0;
    const pot = h.seats.reduce((s, p) => s + h.total[p], 0);
    this.g.seats[pid].stack += pot;
    h.result = { uncontested: true, pots: [{ amount: pot, winners: [pid], eligible: [pid] }], best: {}, labels: [] };
    this.finishHand(PAUSE.fold);
  }

  // The pots: a side pot for each all-in level of those still in. eligible: who can win it.
  pots() {
    const h = this.g.hand;
    const live = h.seats.filter(p => !h.folded[p]);
    // the all-in amounts of those still in, and the most anyone still in has put in
    const top = Math.max(...live.map(p => h.total[p]));
    const levels = [...new Set([...live.filter(p => h.allIn[p]).map(p => h.total[p]), top])].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const lvl of levels) {
      let amount = 0;
      for (const p of h.seats) amount += Math.max(0, Math.min(h.total[p], lvl) - prev);
      const eligible = live.filter(p => h.total[p] >= lvl);
      const last = pots[pots.length - 1];
      if (last && last.eligible.length === eligible.length) last.amount += amount;
      else if (amount > 0) pots.push({ amount, eligible });
      prev = lvl;
    }
    // chips above everyone still in (only folded players put them in) go to the last pot
    const rest = h.seats.reduce((s, p) => s + Math.max(0, h.total[p] - prev), 0);
    if (rest && pots.length) pots[pots.length - 1].amount += rest;
    return pots;
  }

  showdown() {
    const g = this.g;
    const h = g.hand;
    h.stage = 'showdown';
    const live = h.seats.filter(p => !h.folded[p]);
    for (const p of live) h.shown[p] = true;
    const best = Object.fromEntries(live.map(p => [p, PH.best([...h.hole[p], ...h.board])]));
    const pots = this.pots().map(pot => {
      const top = Math.max(...pot.eligible.map(p => best[p].score));
      const winners = pot.eligible.filter(p => best[p].score === top);
      // odd chips to the first winners left of the button
      const ordered = h.seats.slice(h.seats.indexOf(h.button) + 1).concat(h.seats.slice(0, h.seats.indexOf(h.button) + 1)).filter(p => winners.includes(p));
      const each = Math.floor(pot.amount / winners.length);
      let odd = pot.amount - each * winners.length;
      for (const p of ordered) { g.seats[p].stack += each + (odd > 0 ? 1 : 0); odd -= 1; }
      return { amount: pot.amount, winners: ordered, eligible: pot.eligible };
    });
    h.result = {
      uncontested: false,
      pots,
      best: Object.fromEntries(live.map(p => [p, { name: best[p].name, cards: best[p].cards, cat: best[p].cat }])),
      labels: [],
    };
    this.storyOf(best);
    for (const p of live) {
      const st = g.seats[p].stats;
      st.showdowns += 1;
      if (pots.some(x => x.winners.includes(p))) st.sdWon += 1;
      if (!st.best || best[p].score > st.best.score) st.best = { score: best[p].score, cards: best[p].cards, name: best[p].name };
    }
    this.finishHand(PAUSE.showdown);
  }

  // How the hand went for the winner of the main pot: each street's equity (worked out now if the
  // hands weren't face up yet), the card that decided it, suckouts, runner-runner, bad beats.
  storyOf(best) {
    const h = this.g.hand;
    const r = h.result;
    const main = r.pots[0];
    const pids = main.eligible;
    if (pids.length < 2) return;
    // equity before each street that was dealt with these players in
    const known = Object.fromEntries(h.equity.map(e => [e.street, e]));
    const hist = [];
    for (const [street, n] of [['preflop', 0], ['flop', 3], ['turn', 4]]) {
      const e = known[street];
      if (e && pids.every(p => e.eq[p] !== undefined)) { hist.push({ street, eq: e.eq }); continue; }
      if (pids.length > 6) continue;
      const x = PH.equity(pids.map(p => h.hole[p]), h.board.slice(0, n), { samples: 6000, seed: h.n * 31 + n });
      hist.push({ street, eq: Object.fromEntries(pids.map((p, i) => [p, x.eq[i]])) });
    }
    r.history = hist;
    if (main.winners.length > 1) { r.labels.push({ key: 'pk.lbl.chop', params: { n: main.winners.length } }); return; }
    const w = main.winners[0];
    const leader = e => pids.reduce((a, b) => (e.eq[b] > e.eq[a] ? b : a));
    // the last street the winner was behind going into
    let lastBehind = -1;
    hist.forEach((e, i) => { if (leader(e) !== w && e.eq[w] < 0.4) lastBehind = i; });
    const nextStreet = { preflop: 'flop', flop: 'turn', turn: 'river' };
    if (lastBehind >= 0) {
      const e = hist[lastBehind];
      const l = leader(e);
      r.decisive = nextStreet[e.street];
      const pct = Math.round(e.eq[w] * 100);
      if (e.eq[w] < 0.25) r.labels.push({ key: r.decisive === 'river' ? 'pk.lbl.river' : 'pk.lbl.suckout', params: { pid: w, pct, street: e.street } });
      if (e.eq[l] >= 0.8) r.labels.push({ key: 'pk.lbl.badBeat', params: { pid: l, pct: Math.round(e.eq[l] * 100) } });
      // behind on the flop and the turn, and the hand needs both the turn and the river
      const fl = hist.find(x => x.street === 'flop');
      const tu = hist.find(x => x.street === 'turn');
      if (fl && tu && leader(fl) !== w && leader(tu) !== w && best[w].cards.includes(h.board[3]) && best[w].cards.includes(h.board[4]) && fl.eq[w] < 0.25) {
        r.labels.unshift({ key: 'pk.lbl.runnerRunner', params: { pid: w, pct: Math.round(fl.eq[w] * 100) } });
        this.g.seats[w].stats.rr = (this.g.seats[w].stats.rr || 0) + 1;
      }
    } else {
      // ahead all the way, and the loser had a big hand too
      const others = pids.filter(p => p !== w).sort((a, b) => best[b].score - best[a].score);
      if (others[0] && best[others[0]].cat >= 5) r.labels.push({ key: 'pk.lbl.cooler', params: { pid: w, other: others[0] } });
    }
    if (best[w].cat >= 7) r.labels.push({ key: 'pk.lbl.monster', params: { pid: w } });
  }

  finishHand(pause) {
    const g = this.g;
    const h = g.hand;
    const r = h.result;
    h.stage = 'done';
    h.toAct = null;
    h.actEndsAt = null;
    h.squeeze = false;
    r.net = Object.fromEntries(h.seats.map(p => [p, g.seats[p].stack - h.start[p]]));
    const potTotal = r.pots.reduce((s, x) => s + x.amount, 0);
    for (const p of h.seats) {
      const st = g.seats[p].stats;
      const won = r.pots.filter(x => x.winners.includes(p));
      if (won.length) {
        st.won += 1;
        st.biggestPot = Math.max(st.biggestPot, potTotal);
        // won a pot with the worst hand there is
        if (h.hole[p] && h.hole[p].map(c => c[0]).sort().join('') === '27' && h.hole[p][0][1] !== h.hole[p][1][1]) st.w72 = (st.w72 || 0) + 1;
      }
      if (h.allIn[p] || h.actions.some(a => a.pid === p && a.a === 'allin')) {
        st.allIns += 1;
        if (r.net[p] > 0) st.allInsWon += 1;
      }
    }
    if (!g.biggest || potTotal > g.biggest.amount) g.biggest = { amount: potTotal, pid: r.pots[0].winners[0], n: h.n };
    // busted: out of the session without rebuys (the order decides the places)
    for (const p of h.seats) {
      const seat = g.seats[p];
      if (seat.stack === 0 && seat.bustedAt === null) { seat.bustedAt = h.n; g.busted.push(p); }
    }
    g.history.push(this.record(h));
    if (g.history.length > HISTORY_KEEP) g.history.shift();
    h.nextAt = Date.now() + pause;
    this.touch();
  }

  // a finished hand for the hand history
  record(h) {
    return {
      n: h.n, button: h.button, sbPid: h.sbPid, bbPid: h.bbPid, blinds: h.blinds, seats: h.seats, start: h.start,
      hole: h.hole, shown: { ...h.shown }, board: h.board, actions: h.actions, result: h.result, rabbit: null, at: Date.now(),
      rabbitCards: h.board.length < 5 ? this.rabbitOf(h) : null, fair: h.fair || null,
    };
  }

  // the cards that would have come, with the burns, as the dealer would have dealt them
  rabbitOf(h) {
    const deck = h.deck.slice();
    const out = [];
    let len = h.board.length;
    while (len < 5) {
      deck.pop();
      const n = len === 0 ? 3 : 1;
      for (let k = 0; k < n; k++) out.push(deck.pop());
      len += n;
    }
    return out;
  }

  // the last finished hand (still the one on the table, or the one before the hand being played)
  lastHand() { return this.g && this.g.history[this.g.history.length - 1]; }

  // after a hand that ended before the river: the cards that would have come
  rabbit(pid) {
    const rec = this.lastHand();
    this.assert(this.settings.rabbit, 'err.featureOff');
    this.assert(rec && rec.rabbitCards && !rec.rabbit, 'err.pk.notNow');
    this.assert(this.member(pid), 'err.notInRoom');
    rec.rabbit = { cards: rec.rabbitCards, by: pid };
    const h = this.g.hand;
    if (h && h.n === rec.n) h.rabbit = rec.rabbit;
    this.touch();
  }

  // after the hand (also while the next one is played): show your cards to the table
  show(pid) {
    const rec = this.lastHand();
    this.assert(rec && rec.hole[pid] && !rec.shown[pid], 'err.pk.notNow');
    rec.shown = { ...rec.shown, [pid]: true };
    const h = this.g.hand;
    if (h && h.n === rec.n) h.shown[pid] = true;
    this.touch();
  }

  sitOut(pid, on) {
    const seat = this.seat(pid);
    this.assert(this.phase === 'playing' && seat, 'err.notInRoom');
    seat.sitOut = !!on;
    this.touch();
    if (!on) this.maybeStartHand();
  }

  rebuy(pid) {
    const seat = this.seat(pid);
    this.assert(this.phase === 'playing' && seat, 'err.notInRoom');
    this.assert(this.settings.rebuy, 'err.featureOff');
    this.assert(seat.stack === 0, 'err.pk.stillHaveChips');
    // all-in in a hand that isn't over yet: wait for the result
    const h = this.g.hand;
    this.assert(!(h && h.stage !== 'done' && h.seats.includes(pid) && !h.folded[pid]), 'err.pk.notNow');
    this.buyIn(pid, 'pk.rebuy');
    seat.stack = this.settings.startStack;
    seat.buyins += 1;
    seat.bustedAt = null;
    this.g.busted = this.g.busted.filter(p => p !== pid);
    seat.sitOut = false;
    this.touch();
    this.maybeStartHand();
  }

  // a spectator takes a free seat in a running session (dealt in from the next hand)
  sit(pid) {
    const sp = this.spectator(pid);
    this.assert(this.phase === 'playing' && sp, 'err.notInRoom');
    this.assert(this.settings.lateJoin, 'err.featureOff');
    this.assert(this.g.order.length < MAX_PLAYERS, 'err.roomFull', { max: MAX_PLAYERS });
    // real money: no joining halfway (everyone agreed to the buy-in before the start)
    this.assert(this.settings.bank === 'chips', 'err.pk.usdtNoLate');
    this.assert(sp.userId && this.wallet.take(sp.userId, this.settings.startStack, 'pk.buyin', { code: this.code }), 'err.pk.noChipsMe', { n: this.settings.startStack });
    this.spectators = this.spectators.filter(x => x.id !== pid);
    this.players.push({ ...sp, ready: false });
    this.g.order.push(pid);
    this.g.seats[pid] = this.newSeat();
    this.touch();
    this.maybeStartHand();
  }

  // the host pauses between hands (the current hand is played out)
  pause(pid, on) {
    this.requireHost(pid);
    this.assert(this.phase === 'playing', 'err.pk.notNow');
    this.g.paused = !!on;
    this.touch();
    if (!on) this.maybeStartHand();
  }

  // the host ends the session: now between hands, or after the hand being played
  finish(pid) {
    this.requireHost(pid);
    this.assert(this.phase === 'playing', 'err.pk.notNow');
    const h = this.g.hand;
    if (h && h.stage !== 'done') { this.g.ending = true; return this.touch(); }
    this.endGame();
  }

  // the places: by chips won or lost; busted players by when they went out
  standings() {
    const g = this.g;
    const start = this.settings.startStack;
    return g.order.map(p => ({ pid: p, stack: g.seats[p].stack, net: g.seats[p].stack - g.seats[p].buyins * start, buyins: g.seats[p].buyins, bustedAt: g.seats[p].bustedAt }))
      .sort((a, b) => b.net - a.net || (b.bustedAt ?? Infinity) - (a.bustedAt ?? Infinity));
  }

  endGame() {
    const g = this.g;
    this.phase = 'ended';
    this.dispose();
    if (g.hand && g.hand.stage !== 'done') g.hand = null;
    const st = this.standings();
    g.final = st;
    g.winners = st.filter(x => x.net === st[0].net && x.net > 0).map(x => x.pid);
    if (!g.winners.length) g.winners = [st[0].pid];
    const uid = pid => this.uidOf(pid);
    if (this.settings.bank === 'chips') {
      // the stacks go back to the wallets
      for (const x of st) if (uid(x.pid) && x.stack > 0) this.wallet.give(uid(x.pid), x.stack, 'pk.cashout', { code: this.code });
    } else {
      const s2 = this.settlement(st);
      g.settlement = s2.transfers;
      g.usdt = Object.fromEntries(s2.rows.map(x => [x.pid, x.c]));
      if (s2.transfers.length) {
        this.onSettle({
          code: this.code, tableId: this.tableId, buyIn: this.settings.usdtBuyIn,
          transfers: s2.transfers.filter(x => uid(x.from) && uid(x.to)).map(x => ({ from: uid(x.from), to: uid(x.to), cents: x.cents })),
        });
      }
    }
    this.onGameEnd(this.gameResults());
    this.onArchive(this.archiveRecord());
    this.touch();
  }

  // the room is closed while playing (the admin, everyone gone): the hand being played is called
  // off (everyone gets back what they put in) and the session is settled as it stands
  abandon() {
    if (this.phase !== 'playing') return;
    const h = this.g.hand;
    if (h && h.stage !== 'done') {
      for (const p of h.seats) this.g.seats[p].stack += h.total[p];
      this.g.hand = null;
    }
    this.endGame();
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

  // ---------- one timer: the clock of the player to act, the runout, the next hand ----------
  armTimer() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    const g = this.g;
    const h = g && g.hand;
    if (this.phase !== 'playing' || !h) return;
    let at = null;
    if (h.stage === 'betting') {
      const seat = g.seats[h.toAct];
      const m = this.player(h.toAct);
      if (seat.left || seat.sitOut) at = Date.now() + AUTO_MS;
      else at = h.actEndsAt || (m && !m.connected ? this.lastActivity + OFFLINE_MS : null);
    } else if (h.stage === 'runout' || h.stage === 'done') at = h.nextAt;
    if (!at) return;
    const seq = ++this.timerSeq;
    this.timer = this.setTimer(() => { if (this.timerSeq === seq) this.onDeadline(); }, Math.max(0, at - Date.now()));
  }

  onDeadline() {
    if (this.phase !== 'playing') return;
    const g = this.g;
    const h = g.hand;
    if (!h) return;
    if (h.stage === 'betting') {
      const pid = h.toAct;
      const seat = g.seats[pid];
      // ran out of time: check if possible, else fold, and sit out until back
      if (!seat.left && !seat.sitOut) seat.sitOut = true;
      return this.act(pid, this.options(pid).canCheck ? 'check' : 'fold');
    }
    if (h.stage === 'runout') return this.runoutStep();
    if (h.stage === 'done') {
      if (g.paused) { g.hand = null; return this.touch(); }
      return this.startHand();
    }
  }

  // ---------- results ----------
  gameResults() {
    const g = this.g;
    const st = g.final || this.standings();
    return st.map((x, i) => {
      const p = this.player(x.pid);
      if (!p || !p.userId) return null;
      const s = g.seats[x.pid].stats;
      return {
        userId: p.userId, won: g.winners.includes(x.pid), place: i + 1, players: st.length, net: x.net, buyins: x.buyins,
        hands: s.hands, vpip: s.vpip, pfr: s.pfr, handsWon: s.won, showdowns: s.showdowns, sdWon: s.sdWon,
        allIns: s.allIns, allInsWon: s.allInsWon, biggestPot: s.biggestPot, best: s.best, at: Date.now(),
        runnerRunner: s.rr || 0, won72: s.w72 || 0, bank: this.settings.bank,
      };
    }).filter(Boolean);
  }

  archiveRecord() {
    const g = this.g;
    const st = g.final || this.standings();
    return {
      game: 'poker', code: this.code, tableId: this.tableId, startedAt: g.startedAt, endedAt: Date.now(),
      winner: g.winners.map(p => this.nameOf(p)).join(', '),
      hands: g.handN,
      biggest: g.biggest ? { amount: g.biggest.amount, name: this.nameOf(g.biggest.pid) } : null,
      players: st.map(x => ({ userId: this.player(x.pid)?.userId || null, name: this.nameOf(x.pid), net: x.net, stack: x.stack, buyins: x.buyins, won: g.winners.includes(x.pid) })),
    };
  }

  // ---------- view: hole cards are secret until shown ----------
  viewFor(pid) {
    const me = this.member(pid);
    const decorate = p => {
      const profile = p.userId ? this.profileOf(p.userId) : null;
      return {
        id: p.id, userId: p.userId, name: p.name, connected: p.connected, ready: !!p.ready,
        avatar: profile?.avatar || null, score: profile ? profile.score : null, cos: profile?.equipped || {}, title: profile?.title || null,
        chips: profile ? profile.chips : null, usdtSet: !!profile?.usdtSet,
      };
    };
    const view = {
      code: this.code,
      phase: this.phase,
      hostId: this.hostId,
      serverNow: Date.now(),
      settings: { ...this.settings },
      defaults: defaultSettings(),
      features: this.features(),
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      players: this.players.map(decorate),
      spectators: this.spectators.map(decorate),
      me: me ? { id: me.id, name: me.name, spectator: !!this.spectator(pid) } : null,
      gameId: this.gameId,
      tableId: this.tableId,
      fairNext: this.fairNext ? this.fairNext.commit : null,
    };
    const g = this.g;
    if (!g) return view;
    const holeFor = (hand, shownAll) => Object.fromEntries(Object.entries(hand.hole).filter(([p]) => p === pid || hand.shown[p] || shownAll).map(([p, c]) => [p, c]));
    const h = g.hand;
    const s = this.settings;
    view.game = {
      order: g.order,
      seats: Object.fromEntries(Object.entries(g.seats).map(([p, x]) => [p, { stack: x.stack, buyins: x.buyins, sitOut: x.sitOut, left: x.left, bustedAt: x.bustedAt }])),
      handN: g.handN, button: g.button, level: g.level, blinds: g.blinds,
      nextLevelIn: s.levelHands && g.level < LEVELS.length - 1 ? s.levelHands - ((g.handN - 1) % s.levelHands) - 1 : null,
      paused: g.paused, ending: g.ending, biggest: g.biggest,
      winners: g.winners || null, final: g.final || null, settlement: g.settlement || null, usdt: g.usdt || null,
      history: g.history.map(({ rabbitCards, ...x }) => ({ ...x, hole: holeFor(x, false), canRabbit: !!rabbitCards && !x.rabbit })),
      hand: h && {
        n: h.n, button: h.button, sbPid: h.sbPid, bbPid: h.bbPid, seats: h.seats, board: h.board, blinds: h.blinds,
        bets: h.bets, total: h.total, folded: h.folded, allIn: h.allIn, shown: h.shown, street: h.street, stage: h.stage,
        currentBet: h.currentBet, minRaise: h.minRaise, toAct: h.toAct, actEndsAt: h.actEndsAt, actions: h.actions,
        pot: h.seats.reduce((a, p) => a + h.total[p], 0),
        pots: h.stage === 'betting' || h.stage === 'runout' ? this.pots() : null,
        equity: h.equity, nextAt: h.nextAt, squeeze: h.squeeze, result: h.result, rabbit: h.rabbit, fair: h.fair || null,
        hole: holeFor(h, false),
        options: this.options(pid),
      },
    };
    return view;
  }
}

module.exports = { PokerRoom, MIN_PLAYERS, MAX_PLAYERS, LEVELS, PAUSE, defaultSettings };
