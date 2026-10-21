'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { PokerRoom } = require('../src/poker/game');
const PH = require('../src/poker/hand');

function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// A started session with no real timers; seats in join order (Ann, Bob, ...), Ann has the button.
function setup(n = 3, settings = {}, rng = seeded(1)) {
  const results = [];
  const archived = [];
  const room = new PokerRoom({
    code: 'TEST', rng, setTimer: () => 1, clearTimer: () => {},
    onGameEnd: r => results.push(...r), onArchive: r => archived.push(r),
  });
  const names = ['Ann', 'Bob', 'Cid', 'Dan', 'Eve', 'Fay', 'Gus', 'Hal', 'Ivy'].slice(0, n);
  const ps = names.map(nm => room.join(nm, { userId: 'u' + nm }));
  room.updateSettings(ps[0].id, { turnSeconds: 0, ...settings });
  room.start(ps[0].id);
  const by = Object.fromEntries(names.map((nm, i) => [nm, ps[i].id]));
  // seats in join order, and a fresh hand with Ann on the button
  room.g.order = ps.map(p => p.id);
  room.g.button = ps[n - 1].id;
  room.g.handN = 0;
  for (const p of room.g.order) room.g.seats[p] = room.newSeat();
  room.startHand();
  return { room, by, results, archived };
}
const h = room => room.g.hand;
const stack = (room, pid) => room.g.seats[pid].stack;
const total = room => Object.values(room.g.seats).reduce((s, x) => s + x.stack, 0) + (room.g.hand && room.g.hand.stage !== 'done' ? Object.values(room.g.hand.total).reduce((a, b) => a + b, 0) : 0);
// give the hand chosen cards: hole cards per player and the board to come (in dealing order)
function rig(room, holes, board) {
  const hand = h(room);
  const used = new Set([...Object.values(holes).flat(), ...board]);
  const rest = PH.DECK.filter(c => !used.has(c));
  for (const [p, c] of Object.entries(holes)) hand.hole[p] = c;
  // the deck is dealt from the end: burn, flop, burn, turn, burn, river
  const order = [rest[0], board[0], board[1], board[2], rest[1], board[3], rest[2], board[4]];
  hand.deck = [...rest.slice(3), ...order.reverse()];
}

test('hands: the categories, kickers and the wheel', () => {
  const b = s => PH.best(s.split(' '));
  assert.strictEqual(b('As Ks Qs Js Ts 2h 3d').name.key, 'pk.h.royal');
  assert.strictEqual(b('5s 4h 3d 2c Ah Kd 9c').name.key, 'pk.h.straight');
  assert.deepStrictEqual(b('5s 4h 3d 2c Ah Kd 9c').name.params, { a: '5' });
  assert.strictEqual(b('Ah Ad Ac Ks Kd Kc 2s').name.key, 'pk.h.full');
  assert.deepStrictEqual(b('Ah Ad Ac Ks Kd Kc 2s').name.params, { a: 'A', b: 'K' });
  assert.strictEqual(b('7h 7d Kc Ks 2s 2d 9h').cards.join(' '), 'Kc Ks 7h 7d 9h');
  assert.strictEqual(b('Ah 3h 7h 9h Jh Kh 2c').name.key, 'pk.h.flush');
  assert.strictEqual(b('Ah 2h 3h 4h 5h Kd Kc').name.key, 'pk.h.straightFlush');
  assert.strictEqual(b('Qc Qd Qh Qs 2c 3c 9d').cards.length, 5);
  // the combination itself, without the kickers
  assert.deepStrictEqual(b('Qc Qd 5s 6h 8d Tc 2s').core, ['Qc', 'Qd']);
  assert.strictEqual(b('7h 7d Kc Ks 2s 2d 9h').core.length, 4);
  assert.strictEqual(b('Ac Kd 9s 7h 5c 3d 2h').core.join(), 'Ac');
  assert.strictEqual(b('Ah 3h 7h 9h Jh Kh 2c').core.length, 5);
  // the kicker decides; the board plays for both
  assert.ok(PH.compare('Ah Kh 2c 3d 9s 9c 4h'.split(' '), 'As Qh 2c 3d 9s 9c 4h'.split(' ')) > 0);
  assert.strictEqual(PH.compare('2h 3h As Ks Qs Js Ts'.split(' '), '4c 5c As Ks Qs Js Ts'.split(' ')), 0);
  // two pair: the best two pairs of three, the fifth card the kicker
  assert.strictEqual(b('Ah Ad Kc Ks 2s 2d 9h').name.params.b, 'K');
  assert.ok(PH.compare('Ah Ad Kc Ks 2s 2d 9h'.split(' '), 'Ah Ad Kc Ks 2s 2d 3h'.split(' ')) > 0);
});

test('equity: aces against kings, and outs on the turn', () => {
  const pre = PH.equity([['As', 'Ad'], ['Ks', 'Kd']], []);
  assert.ok(Math.abs(pre.eq[0] - 0.82) < 0.02, String(pre.eq[0]));
  const turn = PH.equity([['Ah', 'Kh'], ['Qs', 'Qd']], ['2h', '7h', 'Qc', '3s']);
  assert.deepStrictEqual(turn.outs, [7, 37]); // nine hearts minus the two that pair the board for a full house
  assert.ok(turn.exact);
  const tie = PH.equity([['2c', '3d'], ['2d', '3c']], ['As', 'Ks', 'Qh', 'Jh', 'Td']);
  assert.deepStrictEqual(tie.eq, [0.5, 0.5]);
});

test('blinds: the button, the small and the big blind; heads up the button is the small blind', () => {
  const { room, by } = setup(3);
  const hand = h(room);
  assert.strictEqual(hand.button, by.Ann);
  assert.strictEqual(hand.sbPid, by.Bob);
  assert.strictEqual(hand.bbPid, by.Cid);
  assert.strictEqual(hand.toAct, by.Ann); // first to act preflop: after the big blind
  assert.strictEqual(stack(room, by.Bob), 495);
  assert.strictEqual(stack(room, by.Cid), 490);

  const hu = setup(2).room;
  const hh = h(hu);
  assert.strictEqual(hh.sbPid, hh.button);
  assert.strictEqual(hh.toAct, hh.button);
  hu.act(hh.button, 'call');
  hu.act(hh.bbPid, 'check');
  assert.strictEqual(hh.street, 'flop');
  assert.strictEqual(hh.toAct, hh.bbPid); // after the flop the big blind acts first
});

test('betting: the big blind gets the option; raises at least the last raise', () => {
  const { room, by } = setup(3);
  room.act(by.Ann, 'call');
  room.act(by.Bob, 'call');
  assert.strictEqual(h(room).toAct, by.Cid);
  assert.ok(room.options(by.Cid).canCheck && room.options(by.Cid).canRaise);
  room.act(by.Cid, 'raise', 30); // raise of 20
  assert.throws(() => room.act(by.Ann, 'raise', 40), /raiseRange/);
  room.act(by.Ann, 'raise', 50);
  assert.strictEqual(h(room).minRaise, 20);
  room.act(by.Bob, 'fold');
  room.act(by.Cid, 'call');
  assert.strictEqual(h(room).street, 'flop');
  assert.strictEqual(h(room).board.length, 3);
  assert.strictEqual(h(room).toAct, by.Cid);
  assert.throws(() => room.act(by.Cid, 'call'), /nothingToCall/);
  assert.throws(() => room.act(by.Ann, 'check'), /notYourTurn/);
});

test('a short all-in raise does not reopen the betting', () => {
  const { room, by } = setup(3);
  room.g.seats[by.Cid].stack = 40; // big blind already in: 10 + 40 behind
  room.act(by.Ann, 'raise', 30);
  room.act(by.Bob, 'call');
  room.act(by.Cid, 'allin'); // to 50: a raise of 20, as big as the last one — a full raise
  assert.ok(room.options(by.Ann).canRaise);
  // a short one: all-in for 5 more than the bet
  const r2 = setup(3).room;
  const b2 = Object.fromEntries(['Ann', 'Bob', 'Cid'].map((n, i) => [n, r2.g.order[i]]));
  r2.g.seats[b2.Cid].stack = 25; // 35 in all with the blind
  r2.act(b2.Ann, 'raise', 30);
  r2.act(b2.Bob, 'call');
  r2.act(b2.Cid, 'allin'); // to 35: a raise of 5, short
  assert.strictEqual(h(r2).toAct, b2.Ann);
  const o = r2.options(b2.Ann);
  assert.strictEqual(o.toCall, 5);
  assert.ok(!o.canRaise);
});

test('everyone folds: the pot goes to the last player, the uncalled bet comes back', () => {
  const { room, by } = setup(3);
  room.act(by.Ann, 'raise', 100);
  room.act(by.Bob, 'fold');
  room.act(by.Cid, 'fold');
  const r = h(room).result;
  assert.ok(r.uncontested);
  assert.strictEqual(r.pots[0].amount, 25); // the blinds and Ann's 10 that the big blind matched
  assert.strictEqual(stack(room, by.Ann), 515);
  assert.strictEqual(h(room).stage, 'done');
  // rabbit hunt: the board that would have come
  room.rabbit(by.Bob);
  assert.strictEqual(h(room).rabbit.cards.length, 5);
  assert.ok(h(room).rabbit.cards.every(c => !Object.values(h(room).hole).flat().includes(c)));
});

test('side pots: the short stack can only win what it covered', () => {
  const { room, by } = setup(3);
  room.g.seats[by.Bob].stack = 95; // 100 in all with the small blind
  rig(room, { [by.Ann]: ['Ks', 'Kd'], [by.Bob]: ['As', 'Ad'], [by.Cid]: ['Qs', 'Qd'] }, ['2c', '7h', '9d', '3s', '4h']);
  room.act(by.Ann, 'raise', 300);
  room.act(by.Bob, 'allin');
  room.act(by.Cid, 'call');
  // Bob is all-in, Ann and Cid can still bet
  assert.strictEqual(h(room).street, 'flop');
  room.act(by.Cid, 'check');
  room.act(by.Ann, 'raise', 100);
  room.act(by.Cid, 'fold');
  // Ann's bet comes back; Bob is all-in, so the board runs out between the two of them
  assert.strictEqual(h(room).stage, 'runout');
  while (h(room).stage === 'runout') room.onDeadline();
  const r = h(room).result;
  assert.strictEqual(r.pots.length, 2);
  assert.strictEqual(r.pots[0].amount, 300);
  assert.deepStrictEqual(r.pots[0].winners, [by.Bob]);
  assert.strictEqual(r.pots[1].amount, 400); // 200 each from Ann and Cid above Bob's 100; Ann's flop bet came back
  assert.deepStrictEqual(r.pots[1].winners, [by.Ann]);
  assert.strictEqual(stack(room, by.Bob), 300);
  assert.strictEqual(stack(room, by.Ann), 500 - 300 + 400);
  assert.strictEqual(stack(room, by.Cid), 200);
});

test('all in: the board runs out with equity each street, and the story of the hand', () => {
  const { room, by } = setup(2, { showEquity: true });
  const btn = h(room).button;
  const other = btn === by.Ann ? by.Bob : by.Ann;
  // the button's kings get there with a runner-runner flush against aces
  rig(room, { [btn]: ['Kh', 'Qh'], [other]: ['As', 'Ad'] }, ['2c', '7h', 'Ac', '9h', '3h']);
  room.act(btn, 'allin');
  room.act(other, 'call');
  const hand = h(room);
  assert.strictEqual(hand.stage, 'runout');
  assert.ok(hand.shown[btn] && hand.shown[other]);
  assert.strictEqual(hand.equity[0].street, 'preflop');
  room.onDeadline(); // flop
  assert.strictEqual(hand.board.length, 3);
  room.onDeadline(); // turn
  assert.ok(hand.squeeze);
  assert.ok(hand.equity.find(e => e.street === 'turn').outs[btn] > 0);
  room.onDeadline(); // river and the showdown
  assert.strictEqual(hand.stage, 'done');
  const r = hand.result;
  assert.deepStrictEqual(r.pots[0].winners, [btn]);
  assert.strictEqual(r.best[btn].name.key, 'pk.h.flush');
  assert.strictEqual(r.decisive, 'river');
  const keys = r.labels.map(l => l.key);
  assert.ok(keys.includes('pk.lbl.runnerRunner'), keys.join());
  assert.ok(keys.includes('pk.lbl.badBeat'), keys.join());
  assert.strictEqual(stack(room, btn), 1000);
  // a session without rebuys is over now
  assert.strictEqual(stack(room, other), 0);
});

test('the session: no rebuys ends with one player; rebuys keep it going until the host ends it', () => {
  const { room, by, results, archived } = setup(2, { rebuy: false });
  const btn = h(room).button;
  const other = btn === by.Ann ? by.Bob : by.Ann;
  rig(room, { [btn]: ['As', 'Ad'], [other]: ['Ks', 'Kd'] }, ['2c', '7h', '9d', '3s', '4h']);
  room.act(btn, 'allin');
  room.act(other, 'call');
  while (h(room).stage === 'runout') room.onDeadline();
  room.onDeadline(); // the next hand: nobody to play
  assert.strictEqual(room.phase, 'ended');
  assert.deepStrictEqual(room.g.winners, [btn]);
  assert.strictEqual(results.length, 2);
  assert.strictEqual(results.find(r => r.won).net, 500);
  assert.strictEqual(archived[0].game, 'poker');

  const s2 = setup(2, { rebuy: true });
  const r2 = s2.room;
  const b2 = h(r2).button;
  const o2 = r2.g.order.find(p => p !== b2);
  rig(r2, { [b2]: ['As', 'Ad'], [o2]: ['Ks', 'Kd'] }, ['2c', '7h', '9d', '3s', '4h']);
  r2.act(b2, 'allin');
  r2.act(o2, 'call');
  while (h(r2).stage === 'runout') r2.onDeadline();
  r2.onDeadline();
  assert.strictEqual(r2.phase, 'playing');
  assert.strictEqual(r2.g.hand, null); // waiting for a rebuy
  r2.rebuy(o2);
  assert.ok(r2.g.hand && r2.g.hand.stage === 'betting');
  assert.strictEqual(r2.g.seats[o2].buyins, 2);
  r2.finish(r2.hostId);
  assert.ok(r2.g.ending);
});

test('views: hole cards are secret until shown', () => {
  const { room, by } = setup(3);
  const v = room.viewFor(by.Bob);
  assert.deepStrictEqual(Object.keys(v.game.hand.hole), [by.Bob]);
  assert.strictEqual(v.game.hand.deck, undefined);
  assert.ok(v.game.hand.options === null);
  assert.ok(room.viewFor(by.Ann).game.hand.options.canRaise);
  room.act(by.Ann, 'fold');
  room.act(by.Bob, 'fold');
  room.show(by.Ann);
  assert.ok(room.viewFor(by.Cid).game.hand.hole[by.Ann]);
  assert.ok(!room.viewFor(by.Cid).game.hand.hole[by.Bob]);
  assert.ok(room.viewFor(by.Cid).game.history[0].hole[by.Ann]);
});

test('the clock: a player who runs out of time checks or folds and sits out', () => {
  const { room, by } = setup(3, { turnSeconds: 15 });
  assert.ok(h(room).actEndsAt);
  room.onDeadline();
  assert.ok(h(room).folded[by.Ann]);
  assert.ok(room.g.seats[by.Ann].sitOut);
  room.act(by.Bob, 'call');
  room.onDeadline(); // the big blind's option: a check
  assert.strictEqual(h(room).street, 'flop');
  room.sitOut(by.Ann, false);
  assert.ok(!room.g.seats[by.Ann].sitOut);
});

test('random sessions: the chips add up, and the session ends', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const rng = seeded(seed);
    const n = 2 + (seed % 7);
    const { room } = setup(n, { rebuy: false, levelHands: 5 }, rng);
    const chips = 500 * n;
    for (let step = 0; step < 20000 && room.phase === 'playing'; step++) {
      const hand = room.g.hand;
      assert.strictEqual(total(room), chips, `seed ${seed} step ${step}`);
      if (!hand || hand.stage !== 'betting') { room.onDeadline(); continue; }
      const pid = hand.toAct;
      const o = room.options(pid);
      const x = rng();
      if (x < 0.15 && !o.canCheck) room.act(pid, 'fold');
      else if (x < 0.35 && o.canRaise) room.act(pid, 'raise', o.minTo + Math.floor(rng() * (o.maxTo - o.minTo + 1)));
      else if (x < 0.4 && o.canRaise) room.act(pid, 'allin');
      else room.act(pid, o.canCheck ? 'check' : 'call');
      for (const p of hand.seats) assert.ok(room.g.seats[p].stack >= 0);
    }
    assert.strictEqual(room.phase, 'ended', `seed ${seed} didn't finish`);
    assert.strictEqual(Object.values(room.g.seats).reduce((s, x) => s + x.stack, 0), chips);
  }
});

test('restore: a saved session picks up where it was', () => {
  const { room, by } = setup(3);
  room.act(by.Ann, 'call');
  const data = JSON.parse(JSON.stringify(room));
  const back = PokerRoom.restore(data, { setTimer: () => 1, clearTimer: () => {} });
  assert.strictEqual(back.g.hand.toAct, by.Bob);
  back.act(by.Bob, 'call');
  back.act(by.Cid, 'check');
  assert.strictEqual(back.g.hand.street, 'flop');
});

test('no rebuy while the all-in is still running', () => {
  const { room } = setup(2, { rebuy: true });
  const btn = h(room).button;
  const other = room.g.order.find(p => p !== btn);
  rig(room, { [btn]: ['As', 'Ad'], [other]: ['Ks', 'Kd'] }, ['2c', '7h', '9d', '3s', '4h']);
  room.act(btn, 'allin');
  room.act(other, 'call');
  assert.throws(() => room.rebuy(other), /notNow/);
  assert.throws(() => room.rebuy(btn), /notNow|stillHaveChips/);
  while (h(room).stage === 'runout') room.onDeadline();
  room.rebuy(other);
  assert.strictEqual(room.g.seats[other].stack, 500);
});

test('the rabbit hunt and showing cards still work while the next hand is played', () => {
  const { room, by } = setup(3);
  room.act(by.Ann, 'fold');
  room.act(by.Bob, 'fold');
  room.onDeadline(); // the next hand
  assert.strictEqual(h(room).n, 2);
  room.rabbit(by.Ann);
  room.show(by.Ann);
  const v = room.viewFor(by.Cid).game.history[0];
  assert.strictEqual(v.rabbit.cards.length, 5);
  assert.ok(v.hole[by.Ann]);
  assert.strictEqual(v.rabbitCards, undefined);
  assert.throws(() => room.rabbit(by.Bob), /notNow/);
});

// a wallet of site chips for the tests
function fakeWallet(start = {}) {
  const bal = { ...start };
  return { bal, balance: u => bal[u] || 0, take: (u, n) => ((bal[u] || 0) >= n ? ((bal[u] -= n), true) : false), give: (u, n) => { bal[u] = (bal[u] || 0) + n; } };
}

test('site chips: buy-ins come from the wallets and the stacks go back', () => {
  const w = fakeWallet({ uAnn: 1000, uBob: 600, uCid: 499 });
  const room = new PokerRoom({ code: 'T', rng: seeded(3), setTimer: () => 1, clearTimer: () => {}, wallet: w });
  const ps = ['Ann', 'Bob', 'Cid'].map(n => room.join(n, { userId: 'u' + n }));
  const [A, B, C] = ps.map(p => p.id);
  room.updateSettings(A, { turnSeconds: 0 });
  assert.throws(() => room.start(A), /noChips/); // Cid has 499
  w.bal.uCid = 500;
  room.start(A);
  assert.deepStrictEqual(w.bal, { uAnn: 500, uBob: 100, uCid: 0 });
  const g = room.g;
  g.hand = null;
  g.seats[A].stack = 1000; g.seats[B].stack = 500; g.seats[C].stack = 0;
  g.seats[C].bustedAt = 1;
  assert.throws(() => room.rebuy(C), /noChipsMe/); // nothing left in the wallet
  room.finish(A);
  assert.deepStrictEqual(w.bal, { uAnn: 1500, uBob: 600, uCid: 0 });
  assert.deepStrictEqual(g.final.map(x => x.net), [500, 0, -500]);
});

test('USDT: everyone ready with an address; the fewest transfers settle it, to the cent', () => {
  const settled = [];
  const room = new PokerRoom({ code: 'T', rng: seeded(5), setTimer: () => 1, clearTimer: () => {}, usdtOk: u => u !== 'uDan', onSettle: x => settled.push(x) });
  const ps = ['Ann', 'Bob', 'Cid', 'Dan'].map(n => room.join(n, { userId: 'u' + n }));
  const [A, B, C, D] = ps.map(p => p.id);
  room.updateSettings(A, { turnSeconds: 0, bank: 'usdt', usdtBuyIn: 10 });
  assert.throws(() => room.start(A), /usdtNoAddress/);
  room.usdtOk = () => true;
  assert.throws(() => room.start(A), /usdtNotReady/);
  for (const p of ps) room.setReady(p.id, true);
  room.start(A);
  const g = room.g;
  g.hand = null;
  // 2000 chips in play = 40 USDT
  g.seats[A].stack = 1100; g.seats[B].stack = 650; g.seats[C].stack = 250; g.seats[D].stack = 0;
  room.finish(A);
  assert.deepStrictEqual(g.usdt, { [A]: 1200, [B]: 300, [C]: -500, [D]: -1000 });
  const sum = g.settlement.reduce((a, x) => a + x.cents, 0);
  assert.strictEqual(sum, 1500);
  assert.ok(g.settlement.length <= 3);
  assert.deepStrictEqual(settled[0].transfers, [{ from: 'uDan', to: 'uAnn', cents: 1000 }, { from: 'uCid', to: 'uAnn', cents: 200 }, { from: 'uCid', to: 'uBob', cents: 300 }]);
});

test('a room closed mid-hand: the hand is called off and the chips go back', () => {
  const w = fakeWallet({ uA: 500, uB: 500 });
  const room = new PokerRoom({ code: 'T', rng: seeded(2), setTimer: () => 1, clearTimer: () => {}, wallet: w });
  const ps = ['A', 'B'].map(n => room.join(n, { userId: 'u' + n }));
  room.updateSettings(ps[0].id, { turnSeconds: 0 });
  room.start(ps[0].id);
  room.abandon();
  assert.strictEqual(room.phase, 'ended');
  assert.deepStrictEqual(w.bal, { uA: 500, uB: 500 });
});
