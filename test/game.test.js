'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Room, PHASES, defaultRoleCounts, validateRoleCounts } = require('../src/game');

// Deterministic room: no real timers, roles dealt in a known order.
function setup(names, roles) {
  const room = new Room({ code: 'TEST', setTimer: () => 0, clearTimer: () => {}, rng: () => 0 });
  const players = names.map(n => room.join(n));
  const counts = { mafia: 0, cop: 0, doctor: 0, hooker: 0 };
  for (const r of roles) if (r !== 'citizen') counts[r]++;
  room.updateSettings(players[0].id, { roleCounts: counts });
  room.start(players[0].id);
  // override random deal with the requested layout
  players.forEach((p, i) => { p.role = roles[i]; });
  const by = Object.fromEntries(players.map(p => [p.name, p]));
  return { room, by, host: players[0] };
}

const SIX = ['A', 'B', 'C', 'D', 'E', 'F'];
const SIX_ROLES = ['mafia', 'cop', 'doctor', 'hooker', 'citizen', 'citizen'];

test('default role counts are valid for 4..12 players', () => {
  for (let n = 4; n <= 12; n++) assert.strictEqual(validateRoleCounts(defaultRoleCounts(n), n), null, `n=${n}`);
});

test('lobby enforces max players and unique names', () => {
  const room = new Room({ code: 'X' });
  for (let i = 0; i < 12; i++) room.join('P' + i);
  assert.throws(() => room.join('P99'), /full/);
  const r2 = new Room({ code: 'Y' });
  r2.join('Bob');
  assert.throws(() => r2.join('bob'), /taken/);
});

test('start deals exactly the configured roles', () => {
  const room = new Room({ code: 'X', setTimer: () => 0, clearTimer: () => {} });
  const ps = Array.from({ length: 10 }, (_, i) => room.join('P' + i));
  room.start(ps[0].id);
  const counts = {};
  for (const p of room.players) counts[p.role] = (counts[p.role] || 0) + 1;
  assert.deepStrictEqual(counts, { mafia: 3, cop: 1, doctor: 1, hooker: 1, citizen: 4 });
  assert.strictEqual(room.phase, PHASES.NIGHT);
});

test('mafia kill succeeds, then speeches start', () => {
  const { room, by } = setup(SIX, SIX_ROLES);
  room.nightAction(by.A.id, by.E.id); // mafia kills E
  room.nightAction(by.B.id, by.A.id); // cop checks A
  room.nightAction(by.C.id, by.F.id); // doctor heals F
  room.nightAction(by.D.id, by.F.id); // hooker visits F
  assert.strictEqual(by.E.alive, false);
  assert.strictEqual(room.phase, PHASES.SPEECH);
  assert.match(room.privateLog[by.B.id][0].text, /A is MAFIA/);
});

test('doctor save prevents the kill', () => {
  const { room, by } = setup(SIX, SIX_ROLES);
  room.nightAction(by.A.id, by.E.id);
  room.nightAction(by.B.id, by.F.id);
  room.nightAction(by.C.id, by.E.id);
  room.nightAction(by.D.id, by.F.id);
  assert.strictEqual(by.E.alive, true);
  assert.match(room.log.at(-2).text, /nobody died/);
});

test('hooker blocks the mafia kill', () => {
  const { room, by } = setup(SIX, SIX_ROLES);
  room.nightAction(by.A.id, by.E.id);
  room.nightAction(by.B.id, by.F.id);
  room.nightAction(by.C.id, by.F.id);
  room.nightAction(by.D.id, by.A.id); // hooker visits the mafia
  assert.strictEqual(by.E.alive, true);
});

test('hooker blocks the doctor so the kill goes through', () => {
  const { room, by } = setup(SIX, SIX_ROLES);
  room.nightAction(by.A.id, by.E.id);
  room.nightAction(by.B.id, by.F.id);
  room.nightAction(by.C.id, by.E.id);
  room.nightAction(by.D.id, by.C.id); // hooker visits the doctor
  assert.strictEqual(by.E.alive, false);
});

test('doctor cannot heal the same player twice in a row', () => {
  const { room, by, host } = setup(SIX, SIX_ROLES);
  room.nightAction(by.C.id, by.E.id);
  room.forceEndNight(host.id);
  room.skipToVote(host.id);
  room.forceEndVote(host.id); // no votes -> nobody out
  assert.strictEqual(room.phase, PHASES.NIGHT);
  assert.throws(() => room.nightAction(by.C.id, by.E.id), /Invalid target/);
  room.nightAction(by.C.id, by.C.id); // self-heal allowed
});

test('mafia cannot target fellow mafia; split mafia vote means no kill', () => {
  const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
  const { room, by, host } = setup(names, ['mafia', 'mafia', 'citizen', 'citizen', 'citizen', 'citizen', 'citizen']);
  assert.throws(() => room.nightAction(by.A.id, by.B.id), /Invalid target/);
  room.nightAction(by.A.id, by.C.id);
  room.nightAction(by.B.id, by.D.id);
  assert.ok(by.C.alive && by.D.alive);
  assert.strictEqual(room.phase, PHASES.SPEECH);
  void host;
});

test('speech order rotates to the next living seat each day', () => {
  const { room, by, host } = setup(SIX, SIX_ROLES);
  room.forceEndNight(host.id);
  const firstStarter = room.speech.order[0];
  // everyone speaks in seat order from the starter
  const seats = room.speech.order.map(id => room.player(id).seat);
  for (let i = 1; i < seats.length; i++) assert.strictEqual(seats[i], (seats[i - 1] + 1) % 6);
  room.skipToVote(host.id);
  room.forceEndVote(host.id);
  room.forceEndNight(host.id);
  const second = room.player(room.speech.order[0]).seat;
  assert.strictEqual(second, (room.player(firstStarter).seat + 1) % 6);
  void by;
});

test('rotation skips dead players', () => {
  const { room, by, host } = setup(SIX, SIX_ROLES);
  room.forceEndNight(host.id); // rng=0 -> day 1 starts with seat 0 (A)
  assert.strictEqual(room.speech.order[0], by.A.id);
  room.skipToVote(host.id);
  room.forceEndVote(host.id);
  by.B.alive = false; // B (seat 1) dies
  room.forceEndNight(host.id);
  assert.strictEqual(room.speech.order[0], by.C.id);
});

test('speaker can end own speech; others cannot', () => {
  const { room, by, host } = setup(SIX, SIX_ROLES);
  room.forceEndNight(host.id);
  const [first, second] = room.speech.order;
  const other = room.speech.order.find(id => id !== first && id !== host.id);
  assert.throws(() => room.endSpeech(other), /Only the speaker/);
  room.endSpeech(first);
  assert.strictEqual(room.speech.order[room.speech.index], second);
  void by;
});

test('speech timer advances speaker', () => {
  const timers = [];
  const room = new Room({ code: 'T', setTimer: fn => timers.push(fn), clearTimer: () => {}, rng: () => 0 });
  const ps = SIX.map(n => room.join(n));
  room.start(ps[0].id);
  room.forceEndNight(ps[0].id);
  assert.strictEqual(room.speech.index, 0);
  timers.at(-1)();
  assert.strictEqual(room.speech.index, 1);
  timers[0](); // stale timer from first speaker must not double-advance
  assert.strictEqual(room.speech.index, 1);
});

test('vote eliminates plurality; tie eliminates no one', () => {
  const { room, by, host } = setup(SIX, SIX_ROLES);
  room.forceEndNight(host.id);
  room.skipToVote(host.id);
  for (const v of ['B', 'C', 'D', 'E']) room.vote(by[v].id, by.F.id);
  room.vote(by.F.id, by.E.id);
  room.vote(by.A.id, 'skip');
  assert.strictEqual(by.F.alive, false);
  assert.strictEqual(room.phase, PHASES.NIGHT);

  room.forceEndNight(host.id);
  room.skipToVote(host.id);
  room.vote(by.A.id, by.B.id);
  room.vote(by.B.id, by.A.id);
  room.forceEndVote(host.id);
  assert.ok(by.A.alive && by.B.alive);
});

test('town wins when mafia is voted out', () => {
  const { room, by, host } = setup(SIX, SIX_ROLES);
  room.forceEndNight(host.id);
  room.skipToVote(host.id);
  for (const v of ['B', 'C', 'D', 'E', 'F']) room.vote(by[v].id, by.A.id);
  room.vote(by.A.id, 'skip');
  assert.strictEqual(room.phase, PHASES.ENDED);
  assert.strictEqual(room.winner, 'town');
});

test('mafia wins at parity', () => {
  const { room, by } = setup(['A', 'B', 'C', 'D'], ['mafia', 'cop', 'citizen', 'citizen']);
  by.D.alive = false;
  room.nightAction(by.B.id, by.C.id);
  room.nightAction(by.A.id, by.C.id);
  assert.strictEqual(room.winner, 'mafia');
});

test('views hide other roles but show mafia teammates', () => {
  const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
  const { room, by } = setup(names, ['mafia', 'mafia', 'cop', 'citizen', 'citizen', 'citizen', 'citizen']);
  const townView = room.viewFor(by.C.id);
  assert.deepStrictEqual(townView.players.filter(p => p.role).map(p => p.name), ['C']);
  const mafiaView = room.viewFor(by.A.id);
  assert.deepStrictEqual(mafiaView.players.filter(p => p.role).map(p => p.name), ['A', 'B']);
  assert.strictEqual(townView.night.mafiaVotes, undefined);
});

test('hooker is only in the default setup above 8 players', () => {
  assert.strictEqual(defaultRoleCounts(8).hooker, 0);
  assert.strictEqual(defaultRoleCounts(9).hooker, 1);
});

test('doctor can self-heal only once per game', () => {
  const { room, by, host } = setup(SIX, SIX_ROLES);
  room.nightAction(by.C.id, by.C.id);
  room.forceEndNight(host.id);
  room.skipToVote(host.id);
  room.forceEndVote(host.id);
  room.nightAction(by.C.id, by.E.id);
  room.forceEndNight(host.id);
  room.skipToVote(host.id);
  room.forceEndVote(host.id);
  assert.throws(() => room.nightAction(by.C.id, by.C.id), /Invalid target/);
  assert.ok(!room.viewFor(by.C.id).night.validTargets.includes(by.C.id));
});

test('self-heal blocked by hooker still uses it up', () => {
  const { room, by, host } = setup(SIX, SIX_ROLES);
  room.nightAction(by.C.id, by.C.id);
  room.nightAction(by.D.id, by.C.id);
  room.forceEndNight(host.id);
  assert.strictEqual(room.doctorSelfHealUsed, true);
});

test('first night without kill: mafia has no action, others still act', () => {
  const room = new Room({ code: 'N', setTimer: () => 0, clearTimer: () => {}, rng: () => 0 });
  const ps = SIX.map(n => room.join(n));
  room.updateSettings(ps[0].id, { firstNightKill: false, roleCounts: { mafia: 1, cop: 1, doctor: 1, hooker: 1 } });
  room.start(ps[0].id);
  ps.forEach((p, i) => { p.role = SIX_ROLES[i]; });
  const [A, B, C, D, E] = ps;
  assert.throws(() => room.nightAction(A.id, E.id), /no action tonight/);
  assert.deepStrictEqual(room.viewFor(A.id).night.validTargets, []);
  room.nightAction(B.id, A.id);
  room.nightAction(C.id, E.id);
  room.nightAction(D.id, E.id); // last actor -> night resolves without waiting for mafia
  assert.strictEqual(room.phase, PHASES.SPEECH);
  assert.ok(room.players.every(p => p.alive));
  assert.match(room.privateLog[B.id][0].text, /MAFIA/);
  room.skipToVote(A.id);
  room.forceEndVote(A.id);
  room.nightAction(A.id, E.id); // night 2: mafia kills again
});
