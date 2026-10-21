'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fair = require('../src/poker/fair');
const PokerFair = require('../public/poker/fair');
const PH = require('../src/poker/hand');
const { PokerRoom } = require('../src/poker/game');

test('fair: the browser check recomputes the server deck', async () => {
  assert.deepStrictEqual(PokerFair.DECK, PH.DECK);
  for (let k = 0; k < 20; k++) {
    const seed = fair.newSeed();
    const clients = [fair.newSeed().slice(0, 16), '', 'my-own_seed'];
    const deck = fair.deckOf(seed, clients, `game:${k}`);
    assert.deepStrictEqual([...deck].sort(), [...PH.DECK].sort());
    assert.deepStrictEqual(await PokerFair.deckOf(seed, clients, `game:${k}`), deck);
    assert.strictEqual(await PokerFair.sha256(seed), fair.commit(seed));
  }
  // any one seed changes the deck
  const seed = fair.newSeed();
  assert.notDeepStrictEqual(fair.deckOf(seed, ['a', 'b'], 'x:1'), fair.deckOf(seed, ['a', 'c'], 'x:1'));
  assert.notDeepStrictEqual(fair.deckOf(seed, ['a', 'b'], 'x:1'), fair.deckOf(seed, ['a', 'b'], 'x:2'));
  assert.strictEqual(fair.cleanClientSeed('a,b:c/d 😀e'), 'abcde');
});

test('fair: every card lands on every position about equally', () => {
  const seed = fair.newSeed();
  const N = 4000;
  const top = {};
  for (let k = 0; k < N; k++) { const d = fair.deckOf(seed, ['x'], `n:${k}`); top[d[51]] = (top[d[51]] || 0) + 1; }
  // 52 cards, ~77 each; a fair shuffle stays well inside these bounds
  for (const c of PH.DECK) assert.ok(top[c] > 35 && top[c] < 130, `${c}: ${top[c]}`);
});

test('fair: the table commits first, deals from the seeds and reveals them at the end', async () => {
  const room = new PokerRoom({ code: 'FAIR', fair, setTimer: () => 1, clearTimer: () => {} });
  const ps = ['Ann', 'Bob', 'Cid'].map(nm => room.join(nm, { userId: 'u' + nm }));
  const first = room.viewFor(ps[0].id).fairNext;
  assert.match(first, /^[0-9a-f]{64}$/);
  room.setClientSeed(ps[0].id, 'ann-seed');
  room.setClientSeed(ps[1].id, 'bob,seed'); // separators are dropped
  room.start(ps[0].id);
  const h = room.g.hand;
  // the hand uses the commitment shown before it, and a new one is out for the next hand
  assert.strictEqual(h.fair.commit, first);
  const v = room.viewFor(ps[0].id);
  assert.notStrictEqual(v.fairNext, first);
  assert.strictEqual(v.game.hand.fair.commit, first);
  assert.ok(!JSON.stringify(v).includes(room.g.fairLog[0].seed), 'the seed stays secret while playing');
  assert.throws(() => room.fairLog(), /err.pk.notNow/);
  // the clients' seeds go in table order
  assert.deepStrictEqual(h.fair.clients, h.seats.map(p => ({ [ps[0].id]: 'ann-seed', [ps[1].id]: 'bobseed', [ps[2].id]: '' })[p]));

  room.endGame();
  const { hands } = room.fairLog();
  assert.strictEqual(hands.length, 1);
  const check = await PokerFair.verify(hands[0]);
  assert.ok(check.commitOk);
  // the recomputed deal is the one the table dealt
  const from = h.seats.indexOf(h.sbPid);
  const dealt = h.seats.map((_, k) => h.seats[(from + k) % h.seats.length]);
  assert.deepStrictEqual(check.hole, dealt.map(p => h.hole[p]));
  assert.deepStrictEqual(hands[0].players, dealt.map(p => room.player(p).name));
});

test('fair: the next commitment survives a restart of the server', () => {
  const room = new PokerRoom({ code: 'FAIR', fair, setTimer: () => 1, clearTimer: () => {} });
  room.join('Ann');
  const data = JSON.parse(JSON.stringify(room));
  const back = PokerRoom.restore(data, { fair, setTimer: () => 1, clearTimer: () => {} });
  assert.strictEqual(back.fairNext.commit, room.fairNext.commit);
});
