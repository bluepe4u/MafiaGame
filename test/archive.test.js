'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Archive, NIGHT_GAP_MS } = require('../src/archive');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mafia-archive-'));
const H = 60 * 60 * 1000;
const game = (tableId, startedAt, users = ['a', 'b']) => ({
  game: 'mafia', tableId, startedAt, endedAt: startedAt + H / 2, winner: 'town',
  players: users.map(u => ({ userId: u, name: u.toUpperCase(), role: 'citizen', team: 'town', won: true, survived: true })),
});

test('archive: games group into nights per table, split by long breaks; newest first; saved', () => {
  const dir = tmp();
  const a = new Archive(dir);
  const t0 = Date.UTC(2026, 9, 9, 18);
  a.add(game('T1', t0));
  a.add(game('T1', t0 + H));
  a.add(game('T1', t0 + H + NIGHT_GAP_MS + H)); // the next night
  a.add(game('T2', t0 + H / 4));
  assert.strictEqual(a.add({ ...game(null, t0), players: [{ userId: null, name: 'guest' }] }), null);
  const nights = a.forTable('T1');
  assert.deepStrictEqual(nights.map(n => n.games.length), [1, 2]);
  assert.strictEqual(a.forUser('a').length, 3);
  assert.strictEqual(a.forUser('zzz').length, 0);
  a.saveNow();
  const again = new Archive(dir);
  assert.strictEqual(again.games.length, 4);
  again.prune(['b']);
  assert.ok(again.games.every(g => g.players.find(p => p.name === 'A').userId === null));
});
