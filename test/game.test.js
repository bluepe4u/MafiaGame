'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Room, PHASES, defaultRoleCounts, validateRoleCounts, EXTEND_MS } = require('../src/game');

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
  assert.throws(() => room.join('P99'), /err\.roomFull/);
  const r2 = new Room({ code: 'Y' });
  r2.join('Bob');
  assert.throws(() => r2.join('bob'), /err\.nameTaken/);
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
  assert.deepStrictEqual(room.privateLog[by.B.id][0].params, { name: 'A', mafia: true });
});

test('doctor save prevents the kill', () => {
  const { room, by } = setup(SIX, SIX_ROLES);
  room.nightAction(by.A.id, by.E.id);
  room.nightAction(by.B.id, by.F.id);
  room.nightAction(by.C.id, by.E.id);
  room.nightAction(by.D.id, by.F.id);
  assert.strictEqual(by.E.alive, true);
  assert.strictEqual(room.log.at(-2).key, 'log.morningNobody');
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
  assert.throws(() => room.nightAction(by.C.id, by.E.id), /err\.invalidTarget/);
  room.nightAction(by.C.id, by.C.id); // self-heal allowed
});

test('mafia cannot target fellow mafia; split mafia vote means no kill', () => {
  const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
  const { room, by, host } = setup(names, ['mafia', 'mafia', 'citizen', 'citizen', 'citizen', 'citizen', 'citizen']);
  assert.throws(() => room.nightAction(by.A.id, by.B.id), /err\.invalidTarget/);
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
  assert.throws(() => room.endSpeech(other), /err\.speakerOrHost/);
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
  assert.throws(() => room.nightAction(by.C.id, by.C.id), /err\.invalidTarget/);
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
  assert.throws(() => room.nightAction(A.id, E.id), /err\.noActionTonight/);
  assert.deepStrictEqual(room.viewFor(A.id).night.validTargets, []);
  room.nightAction(B.id, A.id);
  room.nightAction(C.id, E.id);
  room.nightAction(D.id, E.id); // last actor -> night resolves without waiting for mafia
  assert.strictEqual(room.phase, PHASES.SPEECH);
  assert.ok(room.players.every(p => p.alive));
  assert.strictEqual(room.privateLog[B.id][0].params.mafia, true);
  room.skipToVote(A.id);
  room.forceEndVote(A.id);
  room.nightAction(A.id, E.id); // night 2: mafia kills again
});

test('log entries and errors are translation keys with params', () => {
  const { room, by, host } = setup(SIX, SIX_ROLES);
  room.nightAction(by.A.id, by.E.id);
  room.forceEndNight(host.id);
  assert.deepStrictEqual(room.log.find(e => e.key === 'log.morningKilled').params, { n: 1, name: 'E', role: 'citizen' });
  room.skipToVote(host.id);
  room.vote(by.B.id, by.A.id);
  room.vote(by.C.id, by.A.id);
  room.vote(by.D.id, 'skip');
  room.forceEndVote(host.id);
  assert.deepStrictEqual(room.log.find(e => e.key === 'log.noneVotedOut' || e.key === 'log.votedOut').params,
    { name: 'A', role: 'mafia', tally: [['A', 2]], skips: 1 });
  try { room.vote(by.B.id, by.A.id); assert.fail(); } catch (e) { assert.strictEqual(e.key, 'err.votingClosed'); }
});

test('speaker can extend once, host any number of times', () => {
  const { room, host } = setup(SIX, SIX_ROLES);
  room.forceEndNight(host.id);
  const speaker = room.player(room.speech.order[room.speech.index]);
  const other = room.players.find(p => p.id !== speaker.id && p.id !== host.id);
  const before = room.speech.endsAt;
  assert.throws(() => room.extendSpeech(other.id), /err\.speakerOrHost/);
  if (speaker.id !== host.id) {
    room.extendSpeech(speaker.id);
    assert.throws(() => room.extendSpeech(speaker.id), /err\.alreadyExtended/);
  }
  room.extendSpeech(host.id);
  room.extendSpeech(host.id);
  assert.ok(room.speech.endsAt >= before + 2 * EXTEND_MS);
  room.endSpeech(host.id);
  assert.strictEqual(room.speech.extended, false, 'next speaker gets their own extension');
});

test('extending reschedules the timer and stale timers do nothing', () => {
  const timers = [];
  const room = new Room({ code: 'T', setTimer: fn => timers.push(fn), clearTimer: () => {}, rng: () => 0 });
  const ps = SIX.map(n => room.join(n));
  room.start(ps[0].id);
  room.forceEndNight(ps[0].id);
  room.extendSpeech(ps[0].id);
  timers.at(-2)(); // the timer scheduled before the extension
  assert.strictEqual(room.speech.index, 0);
  timers.at(-1)();
  assert.strictEqual(room.speech.index, 1);
});

test('history records nights and votes; night details stay hidden until the end', () => {
  const { room, by } = setup(SIX, SIX_ROLES);
  room.nightAction(by.A.id, by.E.id);
  room.nightAction(by.B.id, by.A.id);
  room.nightAction(by.C.id, by.E.id); // doctor saves E
  room.nightAction(by.D.id, by.F.id);
  const night = room.history[0];
  assert.strictEqual(night.type, 'night');
  assert.strictEqual(night.saved, by.E.id);
  assert.strictEqual(night.killed, null);
  assert.strictEqual(night.actions.length, 4);
  room.skipToVote(by.A.id);
  for (const p of room.alive()) room.vote(p.id, p.id === by.A.id ? by.B.id : by.A.id);
  assert.strictEqual(room.phase, PHASES.ENDED);
  assert.deepStrictEqual(room.history[1].out, by.A.id);
  assert.strictEqual(room.viewFor(by.E.id).history.length, 2);

  const r2 = setup(SIX, SIX_ROLES);
  r2.room.forceEndNight(r2.host.id);
  r2.room.skipToVote(r2.host.id);
  r2.room.forceEndVote(r2.host.id);
  const view = r2.room.viewFor(r2.by.E.id);
  assert.deepStrictEqual(view.history.map(h => h.type), ['vote']);
});

test('a saved room restores mid-game with everyone offline', () => {
  const { room, by } = setup(SIX, SIX_ROLES);
  room.nightAction(by.A.id, by.E.id);
  const saved = JSON.parse(JSON.stringify(room));
  const timers = [];
  const back = Room.restore(saved, { setTimer: (fn, ms) => timers.push(ms), clearTimer: () => {} });
  assert.strictEqual(back.phase, PHASES.NIGHT);
  assert.strictEqual(back.gameId, room.gameId);
  assert.ok(back.players.every(p => !p.connected));
  assert.strictEqual(back.byToken(by.A.token).role, 'mafia');
  back.nightAction(back.player(by.B.id).id, by.A.id);
  back.nightAction(by.C.id, by.F.id);
  back.nightAction(by.D.id, by.F.id);
  assert.strictEqual(back.phase, PHASES.SPEECH);

  const mid = Room.restore(JSON.parse(JSON.stringify(back)), { setTimer: (fn, ms) => timers.push(ms), clearTimer: () => {} });
  assert.strictEqual(mid.phase, PHASES.SPEECH);
  assert.ok(timers.at(-1) >= 14000, 'speech timer resumes with time left');
});

test('vote timer closes the vote when it runs out', () => {
  const timers = [];
  const room = new Room({ code: 'T', setTimer: (fn, ms) => timers.push({ fn, ms }), clearTimer: () => {}, rng: () => 0 });
  const ps = SIX.map(n => room.join(n));
  room.updateSettings(ps[0].id, { voteSeconds: 60 });
  room.start(ps[0].id);
  room.forceEndNight(ps[0].id);
  room.skipToVote(ps[0].id);
  assert.strictEqual(room.phase, PHASES.VOTE);
  assert.strictEqual(timers.at(-1).ms > 59000 && timers.at(-1).ms <= 60000, true);
  room.vote(ps[1].id, ps[2].id);
  timers.at(-1).fn();
  assert.notStrictEqual(room.phase, PHASES.VOTE);
  assert.ok(room.log.some(e => e.key === 'log.voteTimeUp'));
  assert.strictEqual(room.history.at(-1).type, 'vote');
});

test('vote timer can be turned off, and a stale vote timer does nothing', () => {
  const timers = [];
  const room = new Room({ code: 'T', setTimer: (fn, ms) => timers.push({ fn, ms }), clearTimer: () => {}, rng: () => 0 });
  const ps = SIX.map(n => room.join(n));
  assert.strictEqual(room.settings.voteSeconds, 180);
  assert.throws(() => room.updateSettings(ps[0].id, { voteSeconds: 5 }), /err\.voteRange/);
  room.start(ps[0].id);
  room.forceEndNight(ps[0].id);
  room.skipToVote(ps[0].id);
  const voteTimer = timers.at(-1);
  room.forceEndVote(ps[0].id); // vote closed early: the old timer must not close a later vote
  room.forceEndNight(ps[0].id);
  if (room.phase === PHASES.SPEECH) room.skipToVote(ps[0].id);
  const before = room.history.length;
  voteTimer.fn();
  assert.strictEqual(room.history.length, before);

  const r2 = new Room({ code: 'U', setTimer: (fn, ms) => timers.push({ fn, ms }), clearTimer: () => {}, rng: () => 0 });
  const qs = SIX.map(n => r2.join(n));
  r2.updateSettings(qs[0].id, { voteSeconds: 0 });
  r2.start(qs[0].id);
  r2.forceEndNight(qs[0].id);
  r2.skipToVote(qs[0].id);
  assert.strictEqual(r2.voteEndsAt, null);
});

test('chat: town by day, mafia-only at night, dead can read but not write', () => {
  const { room, by } = setup(SIX, SIX_ROLES);
  // night: town closed, mafia open for mafia only
  assert.throws(() => room.sendChat(by.E.id, 'town', 'hi'), /err\.chatClosed/);
  assert.throws(() => room.sendChat(by.B.id, 'mafia', 'hi'), /err\.chatClosed/);
  room.sendChat(by.A.id, 'mafia', '  kill   E  ');
  assert.strictEqual(room.chat.mafia[0].text, 'kill E');
  assert.strictEqual(room.viewFor(by.B.id).chat.mafia, null, 'town cannot read mafia chat');
  assert.strictEqual(room.viewFor(by.A.id).chat.mafia.length, 1);
  // day
  room.nightAction(by.A.id, by.E.id);
  room.nightAction(by.B.id, by.A.id);
  room.nightAction(by.C.id, by.F.id);
  room.nightAction(by.D.id, by.F.id);
  assert.throws(() => room.sendChat(by.A.id, 'mafia', 'x'), /err\.chatClosed/);
  room.sendChat(by.B.id, 'town', 'I think A is mafia');
  assert.throws(() => room.sendChat(by.B.id, 'town', 'again'), /err\.chatTooFast/);
  assert.throws(() => room.sendChat(by.E.id, 'town', 'I am dead'), /err\.chatClosed/);
  assert.throws(() => room.sendChat(by.C.id, 'town', '   '), /err\.chatEmpty/);
  assert.strictEqual(room.viewFor(by.E.id).chat.town.length, 1);
  assert.deepStrictEqual(room.viewFor(by.E.id).chat.canPost, { town: false, mafia: false });
});

test('rooms saved by an older version restore with default settings and an empty chat', () => {
  const { room } = setup(SIX, SIX_ROLES);
  const old = JSON.parse(JSON.stringify(room));
  delete old.settings.voteSeconds;
  delete old.chat;
  delete old.voteEndsAt;
  const back = Room.restore(old, { setTimer: () => 0, clearTimer: () => {} });
  assert.strictEqual(back.settings.voteSeconds, 180);
  assert.deepStrictEqual(back.chat, { town: [], mafia: [] });
});
