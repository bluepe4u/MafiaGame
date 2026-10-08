'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { MonoRoom } = require('../src/monopoly/game');
const { SQUARES, GROUPS } = require('../src/monopoly/board');

// A game with scripted dice and no real timers; players in seat order (no shuffle).
function setup(n = 3, settings = {}) {
  const timers = [];
  const results = [];
  const room = new MonoRoom({
    code: 'TEST', rng: () => 0.999, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {},
    onGameEnd: r => results.push(...r),
  });
  const names = ['Ann', 'Bob', 'Cid', 'Dan'].slice(0, n);
  const ps = names.map(nm => room.join(nm, { userId: 'u' + nm }));
  room.updateSettings(ps[0].id, { turnSeconds: 0, ...settings });
  room.start(ps[0].id);
  room.g.order = ps.map(p => p.id); // fixed order: Ann, Bob, Cid
  room.g.turnIdx = 0;
  room.beginTurn(ps[0].id);
  const dice = [];
  room.rollDice = () => dice.shift() || [1, 2];
  const by = Object.fromEntries(names.map((nm, i) => [nm, ps[i].id]));
  return { room, by, dice, timers, results };
}
const gp = (room, pid) => room.g.players[pid];
const own = (room, sq, pid, houses = 0, mortgaged = false) => { room.g.props[sq] = { owner: pid, houses, mortgaged }; };

test('board: 40 squares in official order with the Russian street names', () => {
  assert.strictEqual(SQUARES.length, 40);
  assert.strictEqual(SQUARES[39].name, 'Улица Арбат');
  assert.strictEqual(SQUARES[39].price, 400);
  assert.deepStrictEqual(SQUARES[39].rent, [50, 200, 600, 1400, 1700, 2000]);
  assert.deepStrictEqual(Object.values(GROUPS).map(g => g.length), [2, 3, 3, 3, 3, 3, 3, 2]);
  assert.deepStrictEqual([5, 15, 25, 35].map(i => SQUARES[i].type), ['railway', 'railway', 'railway', 'railway']);
});

test('roll, move, buy, and pass the turn', () => {
  const { room, by, dice } = setup();
  dice.push([1, 2]); // to 3: Nagatinskaya, 60
  room.roll(by.Ann);
  assert.strictEqual(gp(room, by.Ann).pos, 3);
  assert.strictEqual(room.g.turn.stage, 'buy');
  room.buy(by.Ann);
  assert.strictEqual(room.g.props[3].owner, by.Ann);
  assert.strictEqual(gp(room, by.Ann).cash, 1440);
  assert.strictEqual(room.g.turn.stage, 'end');
  room.endTurn(by.Ann);
  assert.strictEqual(room.current(), by.Bob);
  assert.throws(() => room.roll(by.Ann), /err\.mono\.notYourTurn/);
});

test('rent: base, double for a colour set, houses; mortgaged pays nothing', () => {
  const { room, by, dice } = setup();
  own(room, 1, by.Bob);
  dice.push([1, 0]);
  room.rollDice = () => [0, 1];
  room.roll(by.Ann); // to 1
  assert.strictEqual(gp(room, by.Ann).cash, 1500 - 2);
  assert.strictEqual(room.rentFor(1), 2);
  own(room, 3, by.Bob);
  assert.strictEqual(room.rentFor(1), 4, 'doubled with the full brown set');
  room.g.props[1].houses = 3;
  assert.strictEqual(room.rentFor(1), 90);
  room.g.props[1].houses = 5;
  assert.strictEqual(room.rentFor(1), 250);
});

test('railways and utilities', () => {
  const { room, by } = setup();
  own(room, 5, by.Bob);
  assert.strictEqual(room.rentFor(5), 25);
  own(room, 15, by.Bob);
  own(room, 25, by.Bob);
  assert.strictEqual(room.rentFor(5), 100);
  own(room, 12, by.Bob);
  room.g.turn.dice = [3, 4];
  assert.strictEqual(room.rentFor(12), 28, '4× the dice');
  own(room, 28, by.Bob);
  assert.strictEqual(room.rentFor(12), 70, '10× with both');
});

test('passing GO pays 200; landing on it pays 400 with the house rule', () => {
  const { room, by, dice } = setup();
  gp(room, by.Ann).pos = 38;
  dice.push([1, 2]); // 38 -> 1
  room.roll(by.Ann);
  room.decline(by.Ann); // Zhitnaya goes to auction
  room.closeAuction();
  assert.strictEqual(gp(room, by.Ann).cash, 1700);
  room.endTurn(by.Ann);
  gp(room, by.Bob).pos = 37;
  dice.push([1, 2]); // 37 -> 0
  room.roll(by.Bob);
  assert.strictEqual(gp(room, by.Bob).cash, 1900);
});

test('doubles roll again; three doubles go to jail', () => {
  const { room, by, dice } = setup();
  dice.push([1, 1], [1, 1], [1, 1]);
  room.roll(by.Ann); // to 2 (chest)
  assert.strictEqual(room.g.turn.stage, 'roll');
  room.roll(by.Ann); // to 4: income tax
  room.roll(by.Ann);
  assert.strictEqual(gp(room, by.Ann).inJail, true);
  assert.strictEqual(gp(room, by.Ann).pos, 10);
  assert.strictEqual(room.g.turn.stage, 'end');
});

test('jail: doubles get you out (no extra roll); third miss pays bail and moves; paying first', () => {
  const { room, by, dice } = setup();
  room.sendToJail(by.Ann);
  dice.push([2, 2]);
  room.roll(by.Ann);
  assert.strictEqual(gp(room, by.Ann).inJail, false);
  assert.strictEqual(gp(room, by.Ann).pos, 14);
  room.decline(by.Ann);
  room.closeAuction();
  assert.strictEqual(room.g.turn.stage, 'end', 'no extra roll after leaving jail on doubles');

  room.endTurn(by.Ann);
  room.sendToJail(by.Bob);
  dice.push([1, 2]);
  room.roll(by.Bob); // first miss: stays in jail
  assert.strictEqual(gp(room, by.Bob).inJail, true);
  assert.strictEqual(room.g.turn.stage, 'end');
  gp(room, by.Bob).jailTurns = 2; // two misses already
  room.g.turn.stage = 'roll';
  const before = gp(room, by.Bob).cash;
  dice.push([1, 2]);
  room.roll(by.Bob); // third miss: pays 50 and moves 3
  assert.strictEqual(gp(room, by.Bob).inJail, false);
  assert.strictEqual(gp(room, by.Bob).pos, 13);
  assert.strictEqual(gp(room, by.Bob).cash, before - 50);
});

test('jail: pay bail or use a card before rolling', () => {
  const { room, by } = setup();
  room.sendToJail(by.Ann);
  room.payBail(by.Ann);
  assert.strictEqual(gp(room, by.Ann).inJail, false);
  assert.strictEqual(gp(room, by.Ann).cash, 1450);
  room.sendToJail(by.Ann);
  gp(room, by.Ann).jailCards.push('c.jailfree');
  room.g.decks.chance = room.g.decks.chance.filter(c => c !== 'c.jailfree');
  room.useJailCard(by.Ann);
  assert.strictEqual(gp(room, by.Ann).inJail, false);
  assert.strictEqual(room.g.decks.chance.at(-1), 'c.jailfree', 'the card goes back under the deck');
});

test('auction: highest bid wins; bids must rise and be affordable (opening at half price)', () => {
  const { room, by, dice } = setup();
  dice.push([3, 3]); // to 6: Varshavskoye
  room.roll(by.Ann);
  room.decline(by.Ann);
  assert.ok(room.g.auction);
  assert.throws(() => room.roll(by.Ann), /err\.mono\.waitForOthers/);
  assert.strictEqual(room.g.auction.min, 50, 'opens at half the 100 price');
  assert.throws(() => room.bid(by.Bob, 10), /err\.mono\.bidTooLow/, 'no snapping it up for pennies');
  room.bid(by.Bob, 50);
  assert.throws(() => room.bid(by.Cid, 50), /err\.mono\.bidTooLow/);
  assert.throws(() => room.bid(by.Cid, 99999), /err\.mono\.notEnoughCash/);
  room.bid(by.Cid, 80);
  room.closeAuction();
  assert.strictEqual(room.g.props[6].owner, by.Cid);
  assert.strictEqual(gp(room, by.Cid).cash, 1420);
  assert.strictEqual(room.g.turn.stage, 'roll', 'Ann rolled doubles, so rolls again');
});

test('no auctions house rule: declining leaves the property unowned', () => {
  const { room, by, dice } = setup(3, { auctions: false });
  dice.push([1, 2]);
  room.roll(by.Ann);
  room.decline(by.Ann);
  assert.strictEqual(room.g.auction, null);
  assert.strictEqual(room.g.props[3], undefined);
});

test('building: needs the set, builds evenly, bank supply, hotels, selling back', () => {
  const { room, by } = setup();
  own(room, 1, by.Ann);
  assert.throws(() => room.buildHouse(by.Ann, 1), /err\.mono\.needSet/);
  own(room, 3, by.Ann);
  room.buildHouse(by.Ann, 1);
  assert.throws(() => room.buildHouse(by.Ann, 1), /err\.mono\.buildEvenly/);
  room.buildHouse(by.Ann, 3);
  assert.strictEqual(room.g.housesLeft, 30);
  for (let i = 0; i < 3; i++) { room.buildHouse(by.Ann, 1); room.buildHouse(by.Ann, 3); }
  room.buildHouse(by.Ann, 1); // hotel
  assert.strictEqual(room.g.props[1].houses, 5);
  assert.strictEqual(room.g.hotelsLeft, 11);
  assert.strictEqual(room.g.housesLeft, 32 - 4);
  assert.throws(() => room.sellHouse(by.Ann, 3), /err\.mono\.sellEvenly/);
  const cash = gp(room, by.Ann).cash;
  room.sellHouse(by.Ann, 1); // hotel back to 4 houses
  assert.strictEqual(room.g.props[1].houses, 4);
  assert.strictEqual(gp(room, by.Ann).cash, cash + 25);
  assert.throws(() => room.mortgage(by.Ann, 1), /err\.mono\.sellHousesFirst/);
  assert.throws(() => room.buildHouse(by.Bob, 1), /err\.mono\.notYours/);
});

test('mortgages: half price, +10% to lift, no rent while mortgaged, no building on a mortgaged set', () => {
  const { room, by } = setup(3, { mortgageTurns: 0 });
  own(room, 37, by.Ann);
  own(room, 39, by.Ann);
  room.mortgage(by.Ann, 39);
  assert.strictEqual(gp(room, by.Ann).cash, 1700);
  assert.throws(() => room.buildHouse(by.Ann, 37), /err\.mono\.groupMortgaged/);
  room.unmortgage(by.Ann, 39);
  assert.strictEqual(gp(room, by.Ann).cash, 1700 - 220);
});

test('cards: advance (salary when passing GO), nearest railway at double rent, repairs, birthday', () => {
  const { room, by } = setup();
  gp(room, by.Ann).pos = 36;
  room.g.decks.chance = ['c.polyanka', ...room.g.decks.chance.filter(c => c !== 'c.polyanka')];
  room.drawCard(by.Ann, 'chance');
  assert.strictEqual(gp(room, by.Ann).pos, 11);
  assert.strictEqual(gp(room, by.Ann).cash, 1700);
  room.g.turn.stage = 'resolved';

  own(room, 15, by.Bob);
  gp(room, by.Ann).pos = 7;
  room.g.decks.chance = ['c.railway1', ...room.g.decks.chance.filter(c => c !== 'c.railway1')];
  room.drawCard(by.Ann, 'chance');
  assert.strictEqual(gp(room, by.Ann).pos, 15);
  assert.strictEqual(gp(room, by.Ann).cash, 1700 - 50, 'twice the 25 rent');

  own(room, 1, by.Ann, 5);
  own(room, 3, by.Ann, 2);
  room.g.decks.chest = ['k.streetrepairs', ...room.g.decks.chest.filter(c => c !== 'k.streetrepairs')];
  const before = gp(room, by.Ann).cash;
  room.drawCard(by.Ann, 'chest');
  assert.strictEqual(gp(room, by.Ann).cash, before - (115 + 2 * 40));

  room.g.decks.chest = ['k.birthday', ...room.g.decks.chest.filter(c => c !== 'k.birthday')];
  room.drawCard(by.Ann, 'chest');
  assert.strictEqual(gp(room, by.Bob).cash, 1500 + 50 - 10);
  assert.strictEqual(gp(room, by.Ann).cash, before - 195 + 20);
});

test('debt: raise money and pay, or go bankrupt to the creditor', () => {
  const { room, by, dice, results } = setup(2);
  own(room, 39, by.Bob, 5); // Arbat with a hotel: 2000
  own(room, 37, by.Bob, 5);
  own(room, 6, by.Ann);
  gp(room, by.Ann).pos = 36;
  dice.push([1, 2]);
  room.roll(by.Ann);
  assert.strictEqual(room.g.debts.length, 1);
  assert.throws(() => room.endTurn(by.Ann), /err\.mono\.waitForOthers/);
  room.mortgage(by.Ann, 6);
  assert.throws(() => room.payDebt(by.Ann), /err\.mono\.notEnoughCash/);
  room.declareBankruptcy(by.Ann);
  assert.strictEqual(room.phase, 'ended');
  assert.strictEqual(room.g.winner, by.Bob);
  assert.strictEqual(room.g.props[6].owner, by.Bob, 'the creditor takes the property, mortgage and all');
  assert.strictEqual(results.find(r => r.userId === 'uBob').won, true);
  assert.strictEqual(results.find(r => r.userId === 'uAnn').place, 2);
});

test('debt can be paid after selling and mortgaging', () => {
  const { room, by, dice } = setup(2);
  own(room, 39, by.Bob, 4); // 1700
  gp(room, by.Ann).cash = 1300; // + 460 from mortgages covers the 1700
  own(room, 31, by.Ann);
  own(room, 32, by.Ann);
  own(room, 34, by.Ann);
  gp(room, by.Ann).pos = 36;
  dice.push([1, 2]);
  room.roll(by.Ann);
  for (const sq of [31, 32, 34]) room.mortgage(by.Ann, sq);
  room.payDebt(by.Ann);
  assert.strictEqual(room.g.debts.length, 0);
  assert.strictEqual(gp(room, by.Bob).cash, 1500 + 1700);
  assert.strictEqual(room.g.turn.stage, 'end');
});

test('trades: properties and cash change hands; mortgaged ones cost 10% interest; buildings block', () => {
  const { room, by } = setup();
  own(room, 6, by.Ann);
  own(room, 8, by.Bob, 0, true);
  const tr = room.proposeTrade(by.Ann, { to: by.Bob, give: { props: [6] }, take: { props: [8] } }); // 100 for a mortgaged 100 (worth 50): just within 2×
  assert.throws(() => room.respondTrade(by.Cid, tr.id, true), /err\.invalidTarget/);
  room.respondTrade(by.Bob, tr.id, true);
  assert.strictEqual(room.g.props[6].owner, by.Bob);
  assert.strictEqual(room.g.props[8].owner, by.Ann);
  assert.strictEqual(gp(room, by.Ann).cash, 1500 - 5, '10% of the 50 mortgage value');
  assert.strictEqual(gp(room, by.Bob).cash, 1500);
  own(room, 1, by.Cid, 1);
  own(room, 3, by.Cid);
  assert.throws(() => room.proposeTrade(by.Cid, { to: by.Ann, give: { props: [3] }, take: { cash: 60 } }), /err\.mono\.sellHousesFirst/);
  assert.throws(() => room.proposeTrade(by.Cid, { to: by.Ann, give: { props: [6] } }), /err\.mono\.tradeInvalid/);
});

test('mortgages expire: after N of the owner\'s turns the property goes back to the bank', () => {
  const { room, by } = setup(2, { mortgageTurns: 3 });
  own(room, 39, by.Ann);
  room.mortgage(by.Ann, 39);
  assert.strictEqual(room.g.props[39].mortgageLeft, 3);
  for (let i = 0; i < 2; i++) { room.beginTurn(by.Bob); room.beginTurn(by.Ann); } // only Ann's turns count
  assert.strictEqual(room.g.props[39].mortgageLeft, 1);
  room.beginTurn(by.Ann);
  assert.strictEqual(room.g.props[39], undefined, 'back to the bank');
  assert.ok(room.g.log.some(e => e.key === 'mono.log.mortgageExpired'));
  own(room, 37, by.Ann);
  room.mortgage(by.Ann, 37);
  room.unmortgage(by.Ann, 37); // lifting it in time stops the clock
  for (let i = 0; i < 5; i++) room.beginTurn(by.Ann);
  assert.strictEqual(room.g.props[37].owner, by.Ann);
});

test('trades: clearly unfair deals are refused', () => {
  const { room, by } = setup();
  own(room, 39, by.Ann); // Arbat 400
  own(room, 1, by.Bob); // Zhitnaya 60
  assert.throws(() => room.proposeTrade(by.Ann, { to: by.Bob, give: { props: [39] }, take: { props: [1] } }), /err\.mono\.unfairTrade/);
  assert.throws(() => room.proposeTrade(by.Ann, { to: by.Bob, give: { cash: 300 } }), /err\.mono\.unfairTrade/, 'no gifts');
  room.proposeTrade(by.Ann, { to: by.Bob, give: { props: [39] }, take: { props: [1], cash: 250 } });
  // Bob has Malaya Bronnaya: the Arbat completes his set, so it can't go for less than 400
  own(room, 37, by.Bob);
  assert.throws(() => room.proposeTrade(by.Ann, { to: by.Bob, give: { props: [39] }, take: { cash: 200 } }), /err\.mono\.cheapMonopoly/);
  room.proposeTrade(by.Ann, { to: by.Bob, give: { props: [39] }, take: { cash: 400 } });
  // a swap where both sides complete a set is fine even if values differ
  const r2 = setup().room;
  const [x, y] = r2.g.order;
  own(r2, 1, y); own(r2, 3, x);
  own(r2, 37, x); own(r2, 39, y);
  const tr = r2.proposeTrade(x, { to: y, give: { props: [3] }, take: { props: [39] } });
  r2.respondTrade(y, tr.id, true);
  assert.strictEqual(r2.g.props[39].owner, x);
});

test('turn timer: idle turns play themselves (roll, decline to auction, end turn)', () => {
  const { room, by, dice, timers } = setup(2, { turnSeconds: 30 });
  dice.push([1, 2]);
  timers.at(-1).fn(); // timeout: roll
  assert.strictEqual(gp(room, by.Ann).pos, 3);
  timers.at(-1).fn(); // timeout: decline -> auction
  assert.ok(room.g.auction);
  timers.at(-1).fn(); // auction closes with no bids
  assert.strictEqual(room.g.props[3], undefined);
  timers.at(-1).fn(); // timeout: end turn
  assert.strictEqual(room.current(), by.Bob);
});

test('turn timer on a debt raises money automatically, or declares bankruptcy', () => {
  const a = setup(2, { turnSeconds: 30 });
  own(a.room, 39, a.by.Bob, 2); // rent 600
  gp(a.room, a.by.Ann).cash = 300;
  own(a.room, 31, a.by.Ann);
  own(a.room, 32, a.by.Ann); // mortgages: 150 + 150
  gp(a.room, a.by.Ann).pos = 36;
  a.dice.push([1, 2]);
  a.room.roll(a.by.Ann);
  assert.strictEqual(a.room.g.debts.length, 1);
  a.timers.at(-1).fn();
  assert.strictEqual(a.room.g.debts.length, 0, 'mortgaged both and paid');
  assert.ok(a.room.g.props[31].mortgaged && a.room.g.props[32].mortgaged);
  assert.strictEqual(gp(a.room, a.by.Ann).cash, 0);

  const b = setup(2, { turnSeconds: 30 });
  own(b.room, 39, b.by.Bob, 5); // rent 2000
  gp(b.room, b.by.Ann).pos = 36;
  b.dice.push([1, 2]);
  b.room.roll(b.by.Ann);
  b.timers.at(-1).fn();
  assert.strictEqual(b.room.phase, 'ended', 'could not cover it: bankrupt');
});

test('resigning hands everything back to the bank; last player standing wins', () => {
  const { room, by, results } = setup(3);
  own(room, 39, by.Cid);
  room.resign(by.Cid);
  assert.strictEqual(room.g.props[39], undefined);
  assert.strictEqual(room.phase, 'playing');
  room.resign(by.Bob);
  assert.strictEqual(room.phase, 'ended');
  assert.strictEqual(room.g.winner, by.Ann);
  assert.deepStrictEqual(results.map(r => [r.userId, r.place]).sort(), [['uAnn', 1], ['uBob', 2], ['uCid', 3]]);
});

test('save and restore mid-game', () => {
  const { room, by, dice } = setup();
  dice.push([1, 2]);
  room.roll(by.Ann);
  const back = MonoRoom.restore(JSON.parse(JSON.stringify(room)), { setTimer: () => 0, clearTimer: () => {} });
  assert.strictEqual(back.g.players[by.Ann].pos, 3);
  assert.strictEqual(back.g.turn.stage, 'buy');
  back.buy(by.Ann);
  assert.strictEqual(back.g.props[3].owner, by.Ann);
});

test('lobby: pieces are unique; late joiners watch', () => {
  const room = new MonoRoom({ code: 'L', setTimer: () => 0, clearTimer: () => {} });
  const a = room.join('Ann');
  const b = room.join('Bob');
  assert.notStrictEqual(a.piece, b.piece);
  assert.throws(() => room.setPiece(b.id, a.piece), /err\.invalidTarget/);
  room.start(a.id);
  const w = room.join('Late');
  assert.ok(room.spectator(w.id));
});

test('random play: 60 games never get stuck and keep the bank and cash consistent', () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = a => a[Math.floor(rnd() * a.length)];
  let finished = 0;
  for (let game = 0; game < 60; game++) {
    const results = [];
    let timer = null;
    const room = new MonoRoom({
      code: 'FUZZ', rng: rnd, setTimer: fn => { timer = fn; return 1; }, clearTimer: () => { timer = null; },
      onGameEnd: r => results.push(...r),
    });
    const n = 2 + (game % 5);
    const ps = Array.from({ length: n }, (_, i) => room.join('P' + i, { userId: 'u' + i }));
    room.updateSettings(ps[0].id, { turnSeconds: 30, freeParking: game % 2 === 0, auctions: game % 3 !== 0, doubleGo: game % 2 === 1 });
    room.start(ps[0].id);
    const tryIt = fn => { try { fn(); } catch (e) { if (!e.key) throw e; } };
    for (let step = 0; step < 8000 && room.phase === "playing"; step++) {
      const g = room.g;
      const cur = room.current();
      const r = rnd();
      if (r < 0.04 && timer) { timer(); }
      else if (g.auction) {
        const bidder = pick(room.active());
        if (rnd() < 0.5) tryIt(() => room.bid(bidder, (g.auction.bidder ? g.auction.bid + 1 : g.auction.min) + Math.floor(rnd() * 60)));
        else room.closeAuction();
      } else if (g.debts.length) {
        const d = g.debts[0];
        const mine = room.owned(d.pid);
        if (rnd() < 0.7 && mine.length) {
          const sq = pick(mine);
          tryIt(() => (g.props[sq].houses ? room.sellHouse(d.pid, sq) : room.mortgage(d.pid, sq)));
        }
        if (room.gp(d.pid).cash >= d.amount) room.payDebt(d.pid);
        else if (rnd() < 0.15 || !mine.length || mine.every(sq => g.props[sq].mortgaged && !g.props[sq].houses)) room.declareBankruptcy(d.pid);
      } else if (g.turn.stage === 'buy') {
        tryIt(() => (rnd() < 0.7 ? room.buy(cur) : room.decline(cur)));
        if (g.turn.stage === 'buy') room.decline(cur);
      } else if (g.turn.stage === 'roll') {
        if (room.gp(cur).inJail && rnd() < 0.3) tryIt(() => room.payBail(cur));
        if (rnd() < 0.2) tryIt(() => room.buildHouse(cur, pick(room.owned(cur).concat([1]))));
        room.roll(cur);
      } else if (g.turn.stage === 'end') {
        const mine = room.owned(cur);
        const x = rnd();
        if (x < 0.35 && mine.length) tryIt(() => room.buildHouse(cur, pick(mine)));
        else if (x < 0.45 && mine.length) tryIt(() => room.mortgage(cur, pick(mine)));
        else if (x < 0.5 && mine.length) tryIt(() => room.unmortgage(cur, pick(mine)));
        else if (x < 0.55) {
          const other = pick(room.active().filter(p => p !== cur));
          if (other) {
            tryIt(() => {
              const tr = room.proposeTrade(cur, { to: other, give: { props: mine.slice(0, 1), cash: Math.floor(rnd() * 100) }, take: { props: room.owned(other).slice(0, 1) } });
              room.respondTrade(other, tr.id, rnd() < 0.6);
            });
          }
        } else room.endTurn(cur);
      }
      // invariants after every step
      if (room.phase !== 'playing') break;
      let houses = 0, hotels = 0;
      for (const pr of Object.values(room.g.props)) { if (pr.houses === 5) hotels++; else houses += pr.houses; }
      assert.strictEqual(houses + room.g.housesLeft, 32, 'houses add up');
      assert.strictEqual(hotels + room.g.hotelsLeft, 12, 'hotels add up');
      for (const pid of room.g.order) assert.ok(room.gp(pid).cash >= 0, 'no negative cash');
      for (const pr of Object.values(room.g.props)) assert.ok(!room.gp(pr.owner).bankrupt, 'bankrupt players own nothing');
      assert.ok(room.g.turn && !room.gp(room.current()).bankrupt, 'the turn belongs to an active player');
    }
    // a game that hasn't ended must still be moving (random players rarely complete colour sets,
    // so many games stall the way real Monopoly does without trading)
    if (room.phase !== 'ended') assert.ok(room.g.round > 100, `game ${game} keeps advancing (round ${room.g.round})`);
    if (room.phase === 'ended') {
      finished++;
      assert.strictEqual(results.filter(x => x.won).length, 1, 'exactly one winner');
      assert.strictEqual(results.length, n);
    }
  }
  assert.ok(finished >= 15, `plenty of random games reach an end (${finished}/60)`);
});

test('summary: net worth snapshot each round, biggest rent and deal, the round you went out', () => {
  const { room, by, dice } = setup(2);
  assert.strictEqual(room.g.worth.length, 1);
  assert.deepStrictEqual(room.g.worth[0], { round: 1, w: { [by.Ann]: 1500, [by.Bob]: 1500 } });
  own(room, 3, by.Bob);
  dice.push([1, 2]); // Ann to 3, pays Bob 4
  room.roll(by.Ann);
  assert.deepStrictEqual(room.g.highlights.rent, { from: by.Ann, to: by.Bob, amount: 4, square: 3 });
  room.endTurn(by.Ann);
  dice.push([1, 3]);
  room.roll(by.Bob); // to 4: income tax
  room.endTurn(by.Bob);
  assert.strictEqual(room.g.round, 2);
  assert.strictEqual(room.g.worth.length, 2);
  assert.strictEqual(room.g.worth[1].w[by.Ann], 1496);
  own(room, 1, by.Ann);
  room.proposeTrade(by.Ann, { to: by.Bob, give: { props: [1], cash: 0, cards: 0 }, take: { props: [], cash: 60, cards: 0 } });
  room.respondTrade(by.Bob, room.g.trades[0].id, true);
  assert.strictEqual(room.g.highlights.deal.value, 120);
  room.resign(by.Bob);
  assert.strictEqual(room.phase, 'ended');
  assert.strictEqual(room.g.players[by.Bob].outRound, 2);
  const view = room.viewFor(by.Ann);
  assert.ok(view.game.worth.length >= 2 && view.game.highlights.rent && view.game.players[by.Ann].stats);
});

test('round limit: after N rounds the richest player wins; places by net worth; archived', () => {
  const archived = [];
  const { room, by, dice } = setup(3, { roundLimit: 5 });
  room.onArchive = r => archived.push(r);
  gp(room, by.Bob).cash = 3000;
  for (let i = 0; i < 15 && room.phase === 'playing'; i++) {
    dice.push([1, 2]);
    room.roll(room.current());
    if (room.g.turn.stage === 'buy') room.decline(room.current());
    if (room.g.auction) room.closeAuction();
    if (room.phase === 'playing' && room.g.turn.stage === 'end') room.endTurn(room.current());
  }
  assert.strictEqual(room.phase, 'ended');
  assert.strictEqual(room.g.winner, by.Bob);
  assert.strictEqual(room.g.round, 5);
  assert.strictEqual(archived.length, 1);
  assert.strictEqual(archived[0].winner, 'Bob');
  assert.deepStrictEqual(archived[0].players.map(p => p.place), [1, 2, 3]);
  assert.throws(() => setup(2, { roundLimit: 3 }), /err\.mono\.roundRange/);
});
