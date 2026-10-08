'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { createVoiceHub, iceServers } = require('../src/voice');
const insights = require('../src/insights');

// a tiny stand-in for a Socket.IO namespace and its sockets
function fakeNsp() {
  const sockets = new Map();
  const sent = [];
  const nsp = { sockets, to: code => ({ emit: (ev, data) => sent.push({ code, ev, data }) }) };
  const connect = (id, room, pid) => {
    const s = new EventEmitter();
    s.id = id;
    s.data = {};
    s.got = [];
    s.emit = (ev, data) => s.got.push({ ev, data });
    s.fire = (ev, payload, ack) => EventEmitter.prototype.emit.call(s, ev, payload, ack);
    sockets.set(id, s);
    return { s, ctx: () => ({ room: { code: room }, pid }) };
  };
  return { nsp, connect, sent };
}

test('voice hub: presence per room, offers relayed only to someone in the same voice chat', () => {
  const { nsp, connect, sent } = fakeNsp();
  const hub = createVoiceHub(nsp);
  const a = connect('s1', 'ROOM', 'pa');
  const b = connect('s2', 'ROOM', 'pb');
  const c = connect('s3', 'OTHER', 'pc');
  for (const x of [a, b, c]) hub.attach(x.s, x.ctx);
  a.s.fire('voice:join', {});
  b.s.fire('voice:join', {});
  c.s.fire('voice:join', {});
  assert.deepStrictEqual(hub.peersOf('ROOM'), ['pa', 'pb']);
  assert.deepStrictEqual(sent.at(-2).data.peers, ['pa', 'pb']);
  a.s.fire('voice:signal', { to: 'pb', data: { description: { type: 'offer', sdp: 'x' } } });
  assert.deepStrictEqual(b.s.got.at(-1), { ev: 'voice:signal', data: { from: 'pa', data: { description: { type: 'offer', sdp: 'x' } } } });
  a.s.fire('voice:signal', { to: 'pc', data: {} }); // a different room: dropped
  assert.strictEqual(c.s.got.length, 0);
  a.s.fire('voice:signal', { to: 'pb', data: { big: 'x'.repeat(30000) } }); // too big: dropped
  assert.strictEqual(b.s.got.length, 1);
  b.s.fire('disconnect');
  assert.deepStrictEqual(hub.peersOf('ROOM'), ['pa']);
});

test('ice servers: STUN always; TURN with time-limited credentials when configured', () => {
  delete process.env.TURN_SECRET;
  assert.strictEqual(iceServers('u1').length, 1);
  process.env.TURN_SECRET = 'shh';
  process.env.TURN_HOST = 'example.com';
  const turn = iceServers('u1')[1];
  assert.match(turn.username, /^\d+:u1$/);
  assert.strictEqual(turn.credential, crypto.createHmac('sha1', 'shh').update(turn.username).digest('base64'));
  delete process.env.TURN_SECRET;
  delete process.env.TURN_HOST;
});

test('insights: off without a key; with one, the reply is parsed and trimmed to real names', async () => {
  const record = {
    winner: 'town', timeline: [{ type: 'vote', day: 1, out: 'Ann' }],
    players: [{ name: 'Ann', role: 'mafia', survived: false }, { name: 'Bob', role: 'cop', survived: true }],
    transcript: [1, 2, 3].map(i => ({ name: 'Bob', text: `line ${i}`, phase: 'speech', day: 1, channel: 'town' })),
  };
  delete process.env.ANTHROPIC_API_KEY;
  assert.strictEqual(await insights.analyzeMafia(record), null);
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const realFetch = global.fetch;
  let sentBody = null;
  global.fetch = async (url, opts) => {
    sentBody = JSON.parse(opts.body);
    const reply = { summary: 'Bob found her.', moments: ['m1'], players: [{ name: 'Bob', line: 'sharp', accused: ['Ann', 'Ghost'] }, { name: 'Ghost', line: 'x' }], mvp: 'Bob', bestBluff: 'Nobody' };
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'Here: ' + JSON.stringify(reply) }] }) };
  };
  try {
    const ins = await insights.analyzeMafia(record, 'en');
    assert.strictEqual(ins.summary, 'Bob found her.');
    assert.deepStrictEqual(ins.players, [{ name: 'Bob', line: 'sharp', accused: ['Ann'] }]);
    assert.strictEqual(ins.mvp, 'Bob');
    assert.strictEqual(ins.bestBluff, null);
    assert.match(sentBody.messages[0].content, /Bob: line 2/);
  } finally {
    global.fetch = realFetch;
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test('round note: parsed and kept to real names of players in that day', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const realFetch = global.fetch;
  let sent = '';
  global.fetch = async (url, opts) => {
    sent = JSON.parse(opts.body).messages[0].content;
    const reply = {
      summary: 'C pushed A.', accusations: [{ from: 'C', to: 'A', strength: 7, why: 'quiet' }, { from: 'C', to: 'Ghost', strength: 1 }, { from: 'A', to: 'A', strength: 1 }],
      defenses: [{ from: 'B', to: 'A' }], alliances: [{ players: ['A', 'B'], why: 'backed each other' }, { players: ['A'] }],
      suspects: [{ name: 'A', by: ['C', 'Ghost'] }], quotes: [{ name: 'A', text: 'это не я' }],
    };
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: JSON.stringify(reply) }] }) };
  };
  try {
    const note = await insights.analyzeRound({ day: 1, alive: ['A', 'B', 'C'], morning: null, earlier: [], lines: [{ name: 'C', text: 'подозреваю А' }], votes: [['C', 'A']], out: 'A' });
    assert.deepStrictEqual(note.accusations, [{ from: 'C', to: 'A', strength: 3, why: 'quiet' }]);
    assert.deepStrictEqual(note.alliances, [{ players: ['A', 'B'], why: 'backed each other' }]);
    assert.deepStrictEqual(note.suspects, [{ name: 'A', by: ['C'] }]);
    assert.match(sent, /C: подозреваю А/);
    assert.match(sent, /do NOT know anyone's role/);
  } finally {
    global.fetch = realFetch;
    delete process.env.ANTHROPIC_API_KEY;
  }
});
