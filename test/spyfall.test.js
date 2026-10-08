'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { SpyRoom, POINTS } = require('../src/spyfall/game');
const { LOCATIONS } = require('../src/spyfall/locations');

// a room with manual timers; players in a fixed order, the spy chosen by the test
function setup(n = 4, settings = {}) {
  const timers = [];
  const results = [];
  const archived = [];
  const room = new SpyRoom({
    code: 'SPY', rng: () => 0, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {},
    onGameEnd: r => results.push(...r), onArchive: r => archived.push(r),
  });
  const names = ['Ann', 'Bob', 'Cid', 'Dan', 'Eve'].slice(0, n);
  const ps = names.map(nm => room.join(nm, { userId: 'u' + nm }));
  if (Object.keys(settings).length) room.updateSettings(ps[0].id, settings);
  room.start(ps[0].id);
  const by = Object.fromEntries(names.map((nm, i) => [nm, ps[i].id]));
  room.g.order = ps.map(p => p.id);
  const makeSpy = pid => {
    const r = room.round;
    const roles = {};
    room.g.order.filter(x => x !== pid).forEach((x, i) => { roles[x] = i; });
    Object.assign(r, { spy: pid, roles });
  };
  return { room, by, makeSpy, timers, results, archived };
}

test('locations: 95 in 5 sets, each with 6 roles in Russian and English', () => {
  assert.strictEqual(LOCATIONS.length, 95);
  assert.strictEqual(LOCATIONS.filter(l => l.pack === 'classic').length, 30);
  for (const l of LOCATIONS) {
    assert.ok(l.ru && l.en && l.roles.length === 6, l.id);
    assert.ok(l.roles.every(r => r.ru && r.en), l.id);
  }
  assert.strictEqual(new Set(LOCATIONS.map(l => l.id)).size, 95);
});

test('cards: the spy sees no location; everyone else the same location and a role; others see nothing', () => {
  const { room, by, makeSpy } = setup();
  makeSpy(by.Cid);
  assert.deepStrictEqual(room.viewFor(by.Cid).game.card, { spy: true });
  const ann = room.viewFor(by.Ann).game.card;
  assert.strictEqual(ann.location, room.round.location);
  assert.ok(Number.isInteger(ann.role));
  const view = JSON.stringify(room.viewFor(by.Ann).game.round);
  assert.ok(!view.includes(by.Cid + '"') || !('spy' in room.viewFor(by.Ann).game.round && room.viewFor(by.Ann).game.round.spy));
  assert.strictEqual(room.viewFor(by.Ann).game.round.spy, undefined);
  assert.strictEqual(room.viewFor(by.Ann).game.round.location, undefined);
});

test('questions: the asker passes the turn; no asking straight back', () => {
  const { room, by } = setup();
  const first = room.round.asker;
  const other = room.g.order.find(p => p !== first);
  assert.throws(() => room.ask(other, first), /err\.spy\.notYourQuestion/);
  room.ask(first, other);
  assert.strictEqual(room.round.asker, other);
  assert.throws(() => room.ask(other, first), /err\.spy\.noAskBack/);
  const third = room.g.order.find(p => p !== first && p !== other);
  room.ask(other, third);
  assert.strictEqual(room.round.asks, 2);
});

test('accusation: unanimous yes on the spy — town wins, the accuser gets more', () => {
  const { room, by, makeSpy } = setup();
  makeSpy(by.Dan);
  room.accuse(by.Ann, by.Dan);
  assert.strictEqual(room.round.stage, 'accuse');
  assert.throws(() => room.voteAccusation(by.Dan, false), /cantVoteOnYourself/);
  room.voteAccusation(by.Bob, true);
  room.voteAccusation(by.Cid, true);
  assert.strictEqual(room.round.stage, 'reveal');
  assert.deepStrictEqual(room.round.result, { winner: 'town', reason: 'caught', accused: by.Dan, by: by.Ann });
  assert.strictEqual(room.g.scores[by.Ann], POINTS.accuser);
  assert.strictEqual(room.g.scores[by.Bob], POINTS.town);
  assert.strictEqual(room.g.scores[by.Dan], 0);
  assert.strictEqual(room.viewFor(by.Bob).game.round.spy, by.Dan); // revealed now
});

test('accusation: one "no" keeps the round going (unanimous); each player accuses once; majority setting', () => {
  const { room, by, makeSpy } = setup();
  makeSpy(by.Dan);
  room.accuse(by.Ann, by.Bob);
  room.voteAccusation(by.Cid, true);
  room.voteAccusation(by.Dan, false);
  assert.strictEqual(room.round.stage, 'talk');
  assert.throws(() => room.accuse(by.Ann, by.Cid), /accusedAlready/);
  // majority: innocent Bob voted out → the spy wins big
  const m = setup(5, { verdict: 'majority' });
  m.makeSpy(m.by.Eve);
  m.room.accuse(m.by.Ann, m.by.Bob);
  m.room.voteAccusation(m.by.Cid, true);
  m.room.voteAccusation(m.by.Dan, true);
  m.room.voteAccusation(m.by.Eve, false);
  assert.deepStrictEqual(m.room.round.result.winner, 'spy');
  assert.strictEqual(m.room.g.scores[m.by.Eve], POINTS.spyWrongAccuse);
});

test('spy guess: right wins 4, wrong hands the round to the town', () => {
  const a = setup();
  a.makeSpy(a.by.Bob);
  assert.throws(() => a.room.spyGuess(a.by.Ann, a.room.round.location), /notTheSpy/);
  a.room.spyGuess(a.by.Bob, a.room.round.location);
  assert.strictEqual(a.room.g.scores[a.by.Bob], POINTS.spyGuessed);
  const b = setup();
  b.makeSpy(b.by.Bob);
  b.room.spyGuess(b.by.Bob, LOCATIONS.find(l => l.id !== b.room.round.location).id);
  assert.strictEqual(b.room.round.result.winner, 'town');
  assert.strictEqual(b.room.g.scores[b.by.Ann], POINTS.town);
});

test('time out: the final vote (secret until counted), a tie or a miss lets the spy win', () => {
  const { room, by, makeSpy, timers } = setup();
  makeSpy(by.Cid);
  timers.at(-1).fn(); // the round clock runs out
  assert.strictEqual(room.round.stage, 'final');
  room.finalVote(by.Ann, by.Cid);
  assert.strictEqual(room.viewFor(by.Bob).game.round.final.votes, undefined);
  assert.deepStrictEqual(room.viewFor(by.Bob).game.round.final.voted, [by.Ann]);
  room.finalVote(by.Bob, by.Cid);
  room.finalVote(by.Dan, by.Cid);
  room.finalVote(by.Cid, by.Ann);
  assert.strictEqual(room.round.result.reason, 'finalCaught');
  // a split vote: the spy survives
  const s = setup();
  s.makeSpy(s.by.Cid);
  s.timers.at(-1).fn();
  s.room.finalVote(s.by.Ann, s.by.Cid);
  s.room.finalVote(s.by.Bob, s.by.Dan);
  s.timers.at(-1).fn(); // the final vote's clock
  assert.strictEqual(s.room.round.result.winner, 'spy');
  assert.strictEqual(s.room.g.scores[s.by.Cid], POINTS.spyTime);
});

test('rounds: the host moves on; after the last round the game ends with winners, stats and an archive record', () => {
  const { room, by, makeSpy, results, archived } = setup(3, { rounds: 2 });
  makeSpy(by.Cid);
  room.spyGuess(by.Cid, room.round.location);
  assert.throws(() => room.next(by.Bob), /err\.hostOnly/);
  room.next(by.Ann);
  assert.strictEqual(room.g.roundN, 2);
  assert.notStrictEqual(room.g.used[0], room.g.used[1]); // a new location
  makeSpy(by.Ann);
  room.accuse(by.Bob, by.Ann);
  room.voteAccusation(by.Cid, true);
  room.next(by.Ann);
  assert.strictEqual(room.phase, 'ended');
  assert.deepStrictEqual(room.g.winners, [by.Cid]); // 4 points vs 2+1
  const cid = results.find(r => r.userId === 'uCid');
  assert.deepStrictEqual([cid.won, cid.points, cid.spyRounds, cid.guessed], [true, 5, 1, 1]);
  assert.strictEqual(results.find(r => r.userId === 'uBob').caught, 1);
  assert.strictEqual(archived[0].rounds.length, 2);
  assert.strictEqual(archived[0].rounds[0].reason, 'guessed');
});

test('save and restore mid-round', () => {
  const { room, by } = setup();
  const copy = SpyRoom.restore(JSON.parse(JSON.stringify(room)), { setTimer: () => 1, clearTimer: () => {} });
  assert.strictEqual(copy.round.location, room.round.location);
  assert.strictEqual(copy.viewFor(by.Ann).game.card.location, room.round.location);
  assert.throws(() => setup(2), /err\.needPlayers/);
});

test('sets and count: the game\'s list is N locations from the chosen sets; rounds and guesses stay in it', () => {
  const { room, by, makeSpy } = setup(3, { packs: ['russia', 'city', 'bogus'], locations: 25 });
  assert.deepStrictEqual(room.settings.packs, ['russia', 'city']);
  assert.strictEqual(room.g.deck.length, 25);
  const packOf = Object.fromEntries(LOCATIONS.map(l => [l.id, l.pack]));
  assert.ok(room.g.deck.every(id => ['russia', 'city'].includes(packOf[id])));
  assert.ok(room.g.deck.includes(room.round.location));
  assert.deepStrictEqual(room.viewFor(by.Ann).game.deck, room.g.deck);
  makeSpy(by.Cid);
  const outside = LOCATIONS.find(l => !room.g.deck.includes(l.id)).id;
  assert.throws(() => room.spyGuess(by.Cid, outside), /err\.invalidTarget/);
  // asking for more than the sets hold: all of them
  const small = setup(3, { packs: ['travel'], locations: 60 });
  assert.strictEqual(small.room.g.deck.length, 15);
  const r = new SpyRoom({ code: 'X' });
  const host = r.join('Ann');
  assert.throws(() => r.updateSettings(host.id, { packs: [] }), /err\.spy\.pickPack/);
  assert.throws(() => r.updateSettings(host.id, { locations: 5 }), /err\.spy\.locationsRange/);
  assert.throws(() => r.updateSettings(host.id, { locations: 61 }), /err\.spy\.locationsRange/);
});
