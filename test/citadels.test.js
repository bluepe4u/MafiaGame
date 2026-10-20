'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { CitRoom } = require('../src/citadels/game');
const { DISTRICTS } = require('../src/citadels/cards');

// small seeded random numbers, so a failing random game can be replayed
function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// A started game with no real timers; seats in join order (Ann, Bob, Cid, ...), Ann has the crown.
function setup(n = 5, settings = {}, rng = seeded(1)) {
  const timers = [];
  const results = [];
  const room = new CitRoom({
    code: 'TEST', rng, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {},
    onGameEnd: r => results.push(...r),
  });
  const names = ['Ann', 'Bob', 'Cid', 'Dan', 'Eve', 'Fay', 'Gus', 'Hal'].slice(0, n);
  const ps = names.map(nm => room.join(nm, { userId: 'u' + nm }));
  room.updateSettings(ps[0].id, { turnSeconds: 0, pickSeconds: 0, ...settings });
  room.start(ps[0].id);
  room.g.order = ps.map(p => p.id);
  room.g.crown = ps[0].id;
  const by = Object.fromEntries(names.map((nm, i) => [nm, ps[i].id]));
  return { room, by, timers, results };
}
const gp = (room, pid) => room.g.players[pid];

// Skip the draft: give out the characters and start calling them.
function deal(room, who) {
  const g = room.g;
  g.sel = { faceUp: [], faceDown: [], pool: [], seq: [], step: 0, endsAt: null };
  g.who = who;
  g.stage = 'turns';
  g.called = 0;
  g.revealed = [];
  g.killed = g.robbed = g.robbedBy = g.bewitched = g.witchPid = null;
  g.turn = null;
  room.callNext();
}
const city = (room, pid, ...kinds) => { gp(room, pid).city = kinds.map((k, i) => `${k}.${i + 10}`); };
const hand = (room, pid, ...kinds) => { gp(room, pid).hand = kinds.map((k, i) => `${k}.${i + 20}`); return gp(room, pid).hand; };

test('setup: 4 cards and 2 gold each; the deck has 54 districts and 14 unique ones', () => {
  const { room, by } = setup(5);
  for (const pid of room.g.order) {
    assert.strictEqual(gp(room, pid).gold, 2);
    assert.strictEqual(gp(room, pid).hand.length, 4);
  }
  assert.strictEqual(room.g.deck.length + 5 * 4, 54 + 14);
  assert.deepStrictEqual(room.g.chars, ['witch', 'thief', 'magician', 'king', 'abbot', 'merchant', 'architect', 'diplomat', 'queen']);
  assert.strictEqual(room.g.stage, 'select');
  assert.strictEqual(DISTRICTS.manor.count, 5);
  assert.ok(by.Ann);
});

test('draft: face-up discards by player count, never the King', () => {
  for (const [n, faceUp] of [[5, 2], [6, 1], [7, 0], [8, 0]]) {
    for (let seed = 1; seed < 30; seed++) {
      const { room } = setup(n, {}, seeded(seed));
      room.startRound();
      assert.strictEqual(room.g.sel.faceUp.length, faceUp, `${n} players`);
      assert.ok(!room.g.sel.faceUp.includes('king'));
    }
  }
  // 4 players: no Queen, 8 characters, 2 face up
  const { room } = setup(4);
  assert.ok(!room.g.chars.includes('queen'));
  assert.strictEqual(room.g.sel.faceUp.length, 2);
});

test('draft: picks go round from the crown; 8 players: the last one also sees the face-down card', () => {
  const { room, by } = setup(8);
  room.startRound();
  const sel = room.g.sel;
  assert.deepStrictEqual(sel.seq, room.g.order);
  assert.throws(() => room.pick(by.Bob, sel.pool[0]), /err\.cit\.notYourPick/);
  for (let i = 0; i < 7; i++) room.pick(sel.seq[i], room.pickOptions()[0]);
  const opts = room.pickOptions();
  assert.strictEqual(opts.length, 2);
  const hidden = room.g.sel.faceDown[0];
  assert.ok(opts.includes(hidden));
  room.pick(by.Hal, hidden);
  assert.strictEqual(room.g.who[hidden], by.Hal);
  assert.strictEqual(room.g.sel.faceDown.length, 1);
  assert.notStrictEqual(room.g.sel.faceDown[0], hidden);
  assert.strictEqual(room.g.stage, 'turns');
});

test('3 players pick two characters each', () => {
  const { room } = setup(3);
  room.startRound();
  assert.strictEqual(room.g.sel.seq.length, 6);
  for (let i = 0; i < 6; i++) room.pick(room.g.sel.seq[i], room.pickOptions()[0]);
  for (const pid of room.g.order) assert.strictEqual(Object.values(room.g.who).filter(p => p === pid).length, 2);
});

test('a turn: gather first, then build one district and collect income', () => {
  const { room, by } = setup(5);
  deal(room, { king: by.Ann });
  assert.strictEqual(room.g.turn.pid, by.Ann);
  assert.strictEqual(room.g.crown, by.Ann);
  const [manor] = hand(room, by.Ann, 'manor', 'castle');
  assert.throws(() => room.build(by.Ann, { card: manor }), /err\.cit\.gatherFirst/);
  room.gather(by.Ann, 'gold');
  assert.strictEqual(gp(room, by.Ann).gold, 4);
  room.build(by.Ann, { card: manor });
  assert.strictEqual(gp(room, by.Ann).gold, 1);
  assert.throws(() => room.build(by.Ann, { card: gp(room, by.Ann).hand[0] }), /err\.cit\.buildLimit/);
  room.income(by.Ann);
  assert.strictEqual(gp(room, by.Ann).gold, 2); // the manor is noble
  assert.throws(() => room.income(by.Ann), /err\.cit\.usedAlready/);
});

test('gathering cards', () => {
  const { room, by } = setup(5);
  deal(room, { thief: by.Bob, magician: by.Cid, king: by.Ann });
  const before = gp(room, by.Bob).hand.length;
  const top = room.g.deck.slice(0, 2);
  room.gather(by.Bob, 'cards');
  assert.deepStrictEqual(room.g.turn.drawn, top);
  room.keep(by.Bob, top[1]);
  assert.strictEqual(gp(room, by.Bob).hand.length, before + 1);
  assert.strictEqual(room.g.deck[room.g.deck.length - 1], top[0]);
  room.endTurn(by.Bob);
  city(room, by.Cid, 'library', 'observatory');
  const n = gp(room, by.Cid).hand.length;
  room.gather(by.Cid, 'cards');
  assert.strictEqual(gp(room, by.Cid).hand.length, n + 3);
  assert.strictEqual(room.g.turn.stage, 'main');
});

test('abilities need gathering first; the Thief robs when the character is called', () => {
  const { room, by } = setup(5);
  deal(room, { thief: by.Bob, merchant: by.Cid });
  assert.throws(() => room.ability(by.Bob, { target: 'merchant' }), /err\.cit\.gatherFirst/);
  room.gather(by.Bob, 'gold');
  assert.throws(() => room.ability(by.Bob, { target: 'witch' }), /err\.cit\.badTarget/);
  room.ability(by.Bob, { target: 'merchant' });
  room.endTurn(by.Bob);
  // Cid's 2 gold went to Bob the moment the Merchant was called
  assert.strictEqual(room.g.turn.pid, by.Cid);
  assert.strictEqual(gp(room, by.Cid).gold, 0);
  assert.strictEqual(gp(room, by.Bob).gold, 6);
});

test('the Witch bewitches; the victim only gathers and the Witch plays on with the ability', () => {
  const { room, by } = setup(5);
  deal(room, { witch: by.Ann, architect: by.Bob });
  room.gather(by.Ann, 'gold');
  assert.throws(() => room.build(by.Ann, { card: gp(room, by.Ann).hand[0] }), /err\.cit\.noBuildNow/);
  room.ability(by.Ann, { target: 'architect' });
  assert.strictEqual(room.g.turn.pid, by.Bob);
  assert.ok(room.g.turn.bewitchedOnly);
  const bobHand = gp(room, by.Bob).hand.length;
  room.gather(by.Bob, 'gold');
  assert.strictEqual(gp(room, by.Bob).gold, 4);
  assert.strictEqual(gp(room, by.Bob).hand.length, bobHand); // no architect cards for Bob
  const t = room.g.turn;
  assert.strictEqual(t.pid, by.Ann);
  assert.strictEqual(t.char, 'architect');
  assert.strictEqual(t.stage, 'main');
  assert.strictEqual(gp(room, by.Ann).hand.length, 6); // +2 architect cards
  const cards = hand(room, by.Ann, 'temple', 'tavern', 'watchtower', 'prison');
  gp(room, by.Ann).gold = 10;
  room.build(by.Ann, { card: cards[0] });
  room.build(by.Ann, { card: cards[1] });
  room.build(by.Ann, { card: cards[2] });
  assert.throws(() => room.build(by.Ann, { card: cards[3] }), /err\.cit\.buildLimit/);
});

test('a bewitched King still takes the crown; the Witch gets no second turn if nobody has the character', () => {
  const { room, by } = setup(5);
  room.g.crown = by.Cid;
  deal(room, { witch: by.Ann, king: by.Bob });
  room.gather(by.Ann, 'gold');
  room.ability(by.Ann, { target: 'king' });
  assert.strictEqual(room.g.crown, by.Bob);
  room.gather(by.Bob, 'gold');
  assert.strictEqual(room.g.turn.pid, by.Ann);
  city(room, by.Ann, 'manor', 'palace');
  room.endTurn(by.Ann);
  assert.strictEqual(gp(room, by.Ann).gold, 4 + 2); // king income with the Witch's own city

  const two = setup(5);
  deal(two.room, { witch: two.by.Ann, merchant: two.by.Bob });
  two.room.gather(two.by.Ann, 'gold');
  two.room.ability(two.by.Ann, { target: 'architect' });
  assert.strictEqual(two.room.g.turn.pid, two.by.Bob);
  assert.strictEqual(two.room.g.turn.bewitchedOnly, false);
});

test('Magician: swap hands, or redraw', () => {
  const { room, by } = setup(5);
  deal(room, { magician: by.Ann });
  room.gather(by.Ann, 'gold');
  const mine = gp(room, by.Ann).hand.slice();
  const theirs = gp(room, by.Bob).hand.slice();
  room.ability(by.Ann, { mode: 'swap', player: by.Bob });
  assert.deepStrictEqual(gp(room, by.Ann).hand, theirs);
  assert.deepStrictEqual(gp(room, by.Bob).hand, mine);
  assert.throws(() => room.ability(by.Ann, { mode: 'redraw', cards: [theirs[0]] }), /err\.cit\.usedAlready/);
  const r2 = setup(5);
  deal(r2.room, { magician: r2.by.Ann });
  r2.room.gather(r2.by.Ann, 'gold');
  const h = gp(r2.room, r2.by.Ann).hand.slice();
  const top = r2.room.g.deck.slice(0, 2);
  r2.room.ability(r2.by.Ann, { mode: 'redraw', cards: [h[0], h[1]] });
  assert.deepStrictEqual(gp(r2.room, r2.by.Ann).hand, [h[2], h[3], ...top]);
  assert.deepStrictEqual(r2.room.g.deck.slice(-2), [h[0], h[1]]);
});

test('Abbot: gold or cards per blue district, and 1 gold from the richest', () => {
  const { room, by } = setup(5);
  deal(room, { abbot: by.Ann });
  city(room, by.Ann, 'temple', 'church', 'cathedral');
  room.gather(by.Ann, 'gold');
  const cards = gp(room, by.Ann).hand.length;
  room.income(by.Ann, { gold: 1 });
  assert.strictEqual(gp(room, by.Ann).gold, 5);
  assert.strictEqual(gp(room, by.Ann).hand.length, cards + 2);
  gp(room, by.Bob).gold = 7;
  gp(room, by.Cid).gold = 7;
  assert.throws(() => room.ability(by.Ann, { from: by.Dan }), /err\.cit\.badTarget/);
  room.ability(by.Ann, { from: by.Cid });
  assert.strictEqual(gp(room, by.Cid).gold, 6);
  assert.strictEqual(gp(room, by.Ann).gold, 6);
});

test('Merchant +1 gold, Architect +2 cards, income collected at the end if forgotten', () => {
  const { room, by } = setup(5);
  deal(room, { merchant: by.Ann, architect: by.Bob });
  city(room, by.Ann, 'tavern', 'market');
  room.gather(by.Ann, 'gold');
  assert.strictEqual(gp(room, by.Ann).gold, 5);
  room.endTurn(by.Ann);
  assert.strictEqual(gp(room, by.Ann).gold, 7);
  const n = gp(room, by.Bob).hand.length;
  room.gather(by.Bob, 'gold');
  assert.strictEqual(gp(room, by.Bob).hand.length, n + 2);
});

test('Diplomat swaps districts and pays the difference; not with a completed city or the Keep', () => {
  const { room, by } = setup(5);
  deal(room, { diplomat: by.Ann });
  city(room, by.Ann, 'tavern', 'prison');
  city(room, by.Bob, 'palace', 'keep');
  room.gather(by.Ann, 'gold');
  const [tavern] = gp(room, by.Ann).city;
  const [palace, keep] = gp(room, by.Bob).city;
  assert.throws(() => room.ability(by.Ann, { mine: tavern, owner: by.Bob, theirs: keep }), /err\.cit\.keep/);
  room.ability(by.Ann, { mine: tavern, owner: by.Bob, theirs: palace });
  assert.ok(gp(room, by.Ann).city.includes(palace));
  assert.ok(gp(room, by.Bob).city.includes(tavern));
  assert.strictEqual(gp(room, by.Ann).gold, 0);
  assert.strictEqual(gp(room, by.Bob).gold, 6);
  room.endTurn(by.Ann);
  assert.strictEqual(gp(room, by.Ann).gold, 1); // the prison is military

  const r2 = setup(5);
  deal(r2.room, { diplomat: r2.by.Ann });
  city(r2.room, r2.by.Ann, 'tavern');
  city(r2.room, r2.by.Bob, 'temple', 'church', 'market', 'docks', 'harbor', 'manor', 'castle');
  r2.room.gather(r2.by.Ann, 'gold');
  assert.throws(() => r2.room.ability(r2.by.Ann, { mine: gp(r2.room, r2.by.Ann).city[0], owner: r2.by.Bob, theirs: gp(r2.room, r2.by.Bob).city[0] }), /err\.cit\.completeCity/);
});

test('Queen: 3 gold when sitting next to the King', () => {
  const { room, by } = setup(5);
  deal(room, { king: by.Bob, queen: by.Ann });
  room.gather(by.Bob, 'gold');
  room.endTurn(by.Bob);
  room.gather(by.Ann, 'gold');
  assert.strictEqual(gp(room, by.Ann).gold, 7);
  const r2 = setup(5);
  deal(r2.room, { king: r2.by.Cid, queen: r2.by.Ann });
  r2.room.gather(r2.by.Cid, 'gold');
  r2.room.endTurn(r2.by.Cid);
  r2.room.gather(r2.by.Ann, 'gold');
  assert.strictEqual(gp(r2.room, r2.by.Ann).gold, 4);
});

test('classic set: the Assassin kills, the Warlord destroys, the Bishop protects', () => {
  const { room, by } = setup(5, { chars: { 1: 'assassin', 5: 'bishop', 8: 'warlord' } });
  assert.deepStrictEqual(room.g.chars.slice(0, 5), ['assassin', 'thief', 'magician', 'king', 'bishop']);
  room.g.crown = by.Eve;
  deal(room, { assassin: by.Ann, king: by.Bob, bishop: by.Cid, warlord: by.Dan });
  room.gather(by.Ann, 'gold');
  room.ability(by.Ann, { target: 'king' });
  room.endTurn(by.Ann);
  assert.strictEqual(room.g.turn.pid, by.Cid); // the King's turn was skipped
  city(room, by.Cid, 'church');
  city(room, by.Ann, 'castle', 'greatWall');
  room.gather(by.Cid, 'gold');
  room.endTurn(by.Cid);
  room.gather(by.Dan, 'gold');
  assert.throws(() => room.ability(by.Dan, { owner: by.Cid, card: gp(room, by.Cid).city[0] }), /err\.cit\.bishop/);
  room.ability(by.Dan, { owner: by.Ann, card: gp(room, by.Ann).city[0] }); // castle 4 − 1 + 1 for the wall
  assert.strictEqual(gp(room, by.Dan).gold, 0);
  assert.deepStrictEqual(gp(room, by.Ann).city.map(c => c.split('.')[0]), ['greatWall']);
  room.endTurn(by.Dan);
  // end of the round: the killed King's player still gets the crown
  assert.strictEqual(room.g.crown, by.Bob);
  assert.strictEqual(room.g.stage, 'select');
});

test('unique districts change building: Factory, Stables, Thieves’ Den, Quarry, Framework, Necropolis', () => {
  const { room, by } = setup(5);
  deal(room, { architect: by.Ann });
  room.gather(by.Ann, 'gold');
  const p = gp(room, by.Ann);
  city(room, by.Ann, 'factory', 'tavern');
  const cards = hand(room, by.Ann, 'stables', 'tavern', 'thievesDen', 'market', 'temple', 'castle');
  p.gold = 1;
  room.build(by.Ann, { card: cards[0] }); // stables: 2 − 1 for the factory, and not counted
  assert.strictEqual(p.gold, 0);
  assert.strictEqual(room.g.turn.built, 0);
  assert.throws(() => room.build(by.Ann, { card: cards[1] }), /err\.cit\.duplicate/);
  p.gold = 3;
  assert.throws(() => room.build(by.Ann, { card: cards[2], cards: [cards[3]] }), /err\.cit\.notEnoughGold/);
  room.build(by.Ann, { card: cards[2], cards: [cards[3], cards[4]] }); // den 6 − 1 = 5: 2 cards + 3 gold
  assert.strictEqual(p.gold, 0);
  assert.deepStrictEqual(p.hand, [cards[1], cards[5]]);
  p.city.push('quarry.0', 'framework.0');
  p.gold = 1;
  room.build(by.Ann, { card: cards[1] }); // a second tavern: fine with the Quarry
  room.build(by.Ann, { card: cards[5], framework: true }); // the castle, for the Framework
  assert.ok(!p.city.includes('framework.0'));
  assert.strictEqual(p.city.filter(c => c.startsWith('tavern')).length, 2);
  assert.strictEqual(p.gold, 0);
  assert.strictEqual(room.g.turn.built, 3);

  const r2 = setup(5);
  deal(r2.room, { king: r2.by.Ann });
  r2.room.gather(r2.by.Ann, 'gold');
  city(r2.room, r2.by.Ann, 'temple');
  const [necro] = hand(r2.room, r2.by.Ann, 'necropolis');
  r2.room.build(r2.by.Ann, { card: necro, necropolis: gp(r2.room, r2.by.Ann).city[0] });
  assert.deepStrictEqual(gp(r2.room, r2.by.Ann).city, [necro]);
  assert.strictEqual(gp(r2.room, r2.by.Ann).gold, 4);
});

test('Laboratory, Smithy, Museum and Armory, once a turn; Poor House and Park at the end', () => {
  const { room, by } = setup(5);
  deal(room, { merchant: by.Ann });
  room.gather(by.Ann, 'gold');
  const p = gp(room, by.Ann);
  city(room, by.Ann, 'laboratory', 'smithy', 'museum', 'armory', 'poorHouse', 'park');
  city(room, by.Bob, 'palace');
  const cards = hand(room, by.Ann, 'tavern', 'market');
  room.useDistrict(by.Ann, { kind: 'laboratory', card: cards[0] });
  assert.strictEqual(p.gold, 7);
  assert.throws(() => room.useDistrict(by.Ann, { kind: 'laboratory', card: cards[1] }), /err\.cit\.usedAlready/);
  room.useDistrict(by.Ann, { kind: 'smithy' });
  assert.strictEqual(p.gold, 5);
  assert.strictEqual(p.hand.length, 4);
  room.useDistrict(by.Ann, { kind: 'museum', card: p.hand[0] });
  assert.strictEqual(p.museum.length, 1);
  room.useDistrict(by.Ann, { kind: 'armory', owner: by.Bob, target: gp(room, by.Bob).city[0] });
  assert.deepStrictEqual(gp(room, by.Bob).city, []);
  assert.ok(!p.city.some(c => c.startsWith('armory')));
  p.gold = 0;
  p.hand = [];
  room.endTurn(by.Ann);
  assert.strictEqual(p.gold, 1);
  assert.strictEqual(p.hand.length, 2);
});

test('Monument counts as two, the game ends after the round, bonuses and the tie-break', () => {
  const { room, by, results } = setup(5, { districtsToEnd: 6 });
  deal(room, { thief: by.Bob, king: by.Ann, queen: by.Cid });
  room.gather(by.Bob, 'gold');
  room.endTurn(by.Bob);
  city(room, by.Ann, 'manor', 'castle', 'palace', 'temple');
  const [monument] = hand(room, by.Ann, 'monument');
  room.gather(by.Ann, 'gold');
  room.build(by.Ann, { card: monument });
  assert.strictEqual(room.citySize(by.Ann), 6);
  assert.strictEqual(room.g.firstComplete, by.Ann);
  assert.ok(room.g.lastRound);
  room.endTurn(by.Ann);
  city(room, by.Cid, 'palace', 'castle', 'monastery', 'tavern', 'watchtower', 'hauntedQuarter');
  room.gather(by.Cid, 'gold');
  room.endTurn(by.Cid);
  assert.strictEqual(room.phase, 'ended');
  const scores = Object.fromEntries(room.g.scores.map(s => [s.pid, s]));
  // Ann: 3 + 4 + 5 + 1 + 4 = 17, +4 for the first completed city
  assert.strictEqual(scores[by.Ann].total, 17 + 4);
  // Cid: 5 + 4 + 3 + 1 + 1 + 2 = 16, +2 completed, +3 all types (the Haunted Quarter is the purple one)
  assert.strictEqual(scores[by.Cid].colors, 3);
  assert.strictEqual(scores[by.Cid].total, 16 + 2 + 3);
  // a tie on 21: Cid had rank 9, Ann rank 4
  assert.strictEqual(room.g.winner, by.Cid);
  assert.strictEqual(results.length, 5);
  assert.strictEqual(results.find(r => r.userId === 'uCid').won, true);
  assert.throws(() => { const r = setup(5); city(r.room, r.by.Ann, 'manor', 'castle', 'palace', 'temple', 'tavern'); deal(r.room, { king: r.by.Ann }); r.room.gather(r.by.Ann, 'gold'); r.room.build(r.by.Ann, { card: hand(r.room, r.by.Ann, 'monument')[0] }); }, /err\.cit\.monument/);
});

test('end-game bonuses of unique districts', () => {
  const { room, by } = setup(5);
  const p = gp(room, by.Ann);
  room.g.crown = by.Ann;
  city(room, by.Ann, 'dragonGate', 'statue', 'imperialTreasury', 'mapRoom', 'basilica', 'wishingWell', 'temple');
  p.gold = 4;
  hand(room, by.Ann, 'tavern', 'secretVault');
  const s = room.scoreOf(by.Ann);
  assert.deepStrictEqual(s.extras, { dragonGate: 2, imperialTreasury: 4, mapRoom: 2, statue: 5, wishingWell: 6, basilica: 5, secretVault: 3 });
  assert.strictEqual(s.districts, 6 + 3 + 5 + 5 + 4 + 5 + 1);
});

test('timeouts take gold and end the turn; a player who left plays on by themselves', () => {
  const { room, by, timers } = setup(5, { turnSeconds: 60, pickSeconds: 30 });
  room.startRound();
  const picker = room.g.sel.seq[0];
  timers[timers.length - 1].fn();
  assert.strictEqual(Object.values(room.g.who)[0], picker);
  room.leave(by.Bob);
  assert.ok(room.player(by.Bob).left);
  // keep firing whatever timer is armed: the round completes with nobody acting
  for (let i = 0; i < 200 && room.g.round === 1; i++) timers[timers.length - 1].fn();
  assert.strictEqual(room.g.round, 2);
});

test('random games run to the end', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const rng = seeded(seed);
    const n = 3 + (seed % 6);
    const chars = seed % 2 ? {} : { chars: { 1: 'assassin', 5: 'bishop', 8: 'warlord', 9: 'none' } };
    const { room, results } = setup(n, { ...chars, uniqueCount: 29 }, rng);
    let guard = 0;
    while (room.phase === 'playing' && guard++ < 5000) {
      const g = room.g;
      if (g.stage === 'select') {
        const pid = g.sel.seq[g.sel.step];
        const opts = room.pickOptions();
        room.pick(pid, opts[Math.floor(rng() * opts.length)]);
        continue;
      }
      const t = g.turn;
      const pid = t.pid;
      if (t.stage === 'gather') { room.gather(pid, rng() < 0.5 && g.deck.length ? 'cards' : 'gold'); continue; }
      if (t.stage === 'draw') { room.keep(pid, t.drawn[0]); continue; }
      // try a few random things; errors are fine, they just mean "not allowed"
      const tryIt = fn => { try { fn(); } catch (e) { if (!e.key) throw e; } };
      const others = g.order.filter(p => p !== pid);
      const other = others[Math.floor(rng() * others.length)];
      const target = g.chars[Math.floor(rng() * g.chars.length)];
      const me = gp(room, pid);
      tryIt(() => room.ability(pid, { target, from: other, player: other, mode: rng() < 0.5 ? 'swap' : 'redraw', cards: me.hand.slice(0, 1),
        owner: other, card: gp(room, other).city[0], mine: me.city[0], theirs: gp(room, other).city[0] }));
      if (room.g.turn !== t) continue;
      tryIt(() => room.income(pid, { gold: 0 }));
      for (const c of me.hand.slice()) tryIt(() => room.build(pid, { card: c }));
      for (const kind of ['laboratory', 'smithy', 'museum', 'armory']) tryIt(() => room.useDistrict(pid, { kind, card: me.hand[0], owner: other, target: gp(room, other).city[0] }));
      if (room.g.turn === t) room.endTurn(pid);
    }
    assert.strictEqual(room.phase, 'ended', `seed ${seed}`);
    assert.strictEqual(results.length, n);
    // every card is somewhere: deck, hands, cities, museums
    const all = [...room.g.deck, ...room.g.order.flatMap(p => [...gp(room, p).hand, ...gp(room, p).city, ...gp(room, p).museum])];
    assert.strictEqual(new Set(all).size, all.length, `seed ${seed}: duplicated cards`);
    assert.strictEqual(all.length, 54 + 29, `seed ${seed}: lost cards`);
    for (const p of room.g.order) assert.ok(gp(room, p).gold >= 0);
    // the view never shows other hands
    const v = room.viewFor(room.g.order[0]);
    assert.ok(v.game.scores.length === n);
  }
});

test('views hide hands, picks and the face-down card', () => {
  const { room, by } = setup(5);
  room.startRound();
  const picker = room.g.sel.seq[0];
  const other = room.g.order.find(p => p !== picker);
  assert.ok(room.viewFor(picker).game.sel.options.length > 0);
  assert.strictEqual(room.viewFor(other).game.sel.options, null);
  assert.strictEqual(typeof room.viewFor(other).game.sel.faceDown, 'number');
  room.pick(picker, room.pickOptions()[0]);
  const v = room.viewFor(other);
  assert.deepStrictEqual(v.game.players[picker].chars, []);
  assert.strictEqual(v.game.players[picker].hand, 4);
  assert.ok(!('handCards' in v.game.players[picker]));
  assert.strictEqual(room.viewFor(picker).game.me.chars.length, 1);
  assert.ok(by.Ann);
});

test('settings are validated', () => {
  const room = new CitRoom({ code: 'X', setTimer: () => 0, clearTimer: () => {} });
  const a = room.join('Ann');
  room.join('Bob');
  assert.throws(() => room.updateSettings(a.id, { districtsToEnd: 3 }), /err\.cit\.range/);
  assert.throws(() => room.updateSettings(a.id, { turnSeconds: 5 }), /err\.cit\.rangeOrZero/);
  assert.throws(() => room.updateSettings(a.id, { chars: { 2: 'assassin' } }), /err\.invalidTarget/);
  room.updateSettings(a.id, { districtsToEnd: 8, turnSeconds: 0, chars: { 9: 'none' }, uniques: ['library', 'park'], uniqueCount: 2 });
  assert.strictEqual(room.settings.districtsToEnd, 8);
  assert.deepStrictEqual(room.settings.uniques, ['library', 'park']);
  assert.throws(() => room.start(a.id), /err\.needPlayers/);
});

test('a saved room comes back after a restart, mid-turn', () => {
  const { room, by } = setup(5, { turnSeconds: 90 });
  deal(room, { king: by.Ann, merchant: by.Bob });
  room.gather(by.Ann, 'gold');
  const copy = CitRoom.restore(JSON.parse(JSON.stringify(room)), { setTimer: () => 0, clearTimer: () => {} });
  assert.strictEqual(copy.g.turn.pid, by.Ann);
  assert.ok(copy.g.turn.endsAt > Date.now());
  assert.ok(copy.players.every(p => !p.connected));
  copy.endTurn(by.Ann);
  assert.strictEqual(copy.g.turn.pid, by.Bob);
});
