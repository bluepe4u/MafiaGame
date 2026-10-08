'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { limitSocket } = require('../src/ratelimit');

// a stand-in socket: runs packets through the middleware and records what got through
function fakeSocket(opts) {
  let mw = null;
  const passed = [];
  limitSocket({ use: fn => { mw = fn; } }, opts);
  const emit = (event, ack) => mw([event, {}, ack], () => passed.push(event));
  return { emit, passed };
}

test('rate limit: a burst passes, a flood is cut off with an error ack', () => {
  const s = fakeSocket({ burst: 5, perSecond: 0.001, gaps: {} });
  const acks = [];
  for (let i = 0; i < 8; i++) s.emit('roll', r => acks.push(r));
  assert.strictEqual(s.passed.length, 5);
  assert.strictEqual(acks.length, 3);
  assert.strictEqual(acks[0].error.key, 'err.slowDown');
  assert.strictEqual(acks[0].quiet, false);
});

test('rate limit: reactions need a gap, and are dropped quietly', () => {
  const s = fakeSocket({ gaps: { react: 10000 } });
  const acks = [];
  s.emit('react', r => acks.push(r));
  s.emit('react', r => acks.push(r));
  s.emit('vote');
  assert.deepStrictEqual(s.passed, ['react', 'vote']);
  assert.strictEqual(acks[0].quiet, true);
});
