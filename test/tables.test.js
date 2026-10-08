'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TableStore } = require('../src/tables');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mafia-tables-'));
const ann = { id: 'a' }, bob = { id: 'b' }, cid = { id: 'c' }, admin = { id: 'z', admin: true };

test('tables: create, join by link, owner powers, leaving hands it over, saved to disk', () => {
  const dir = tmp();
  const store = new TableStore(dir);
  const table = store.create(ann, '  Friday   crew ');
  assert.strictEqual(table.name, 'Friday crew');
  assert.match(table.id, /^[A-Z2-9]{8}$/);
  store.join(table.id.toLowerCase(), bob);
  store.join(table.id, bob); // twice is fine
  store.join(table.id, cid);
  assert.deepStrictEqual(table.members, ['a', 'b', 'c']);
  assert.throws(() => store.rename(table.id, bob, 'Mine'), /err\.tableOwnerOnly/);
  store.rename(table.id, admin, 'Admin can too');
  assert.throws(() => store.kick(table.id, ann, 'a'), /err\.invalidTarget/);
  store.kick(table.id, ann, 'c');
  assert.deepStrictEqual(store.mine('c'), []);
  store.setCurrent(table, 'mono', 'ABCD', 'b');
  assert.deepStrictEqual(table.current.code, 'ABCD');
  store.leave(table.id, ann);
  assert.strictEqual(table.ownerId, 'b');
  store.saveNow();
  const again = new TableStore(dir);
  assert.strictEqual(again.get(table.id).history.length, 1);
  again.leave(table.id, bob);
  assert.throws(() => again.get(table.id), /err\.tableNotFound/);
});

test('tables: pruning removes deleted accounts and empty tables', () => {
  const store = new TableStore(tmp());
  const t1 = store.create(ann, 'One');
  store.join(t1.id, bob);
  const t2 = store.create(cid, 'Two');
  store.prune(['b']);
  assert.deepStrictEqual(store.get(t1.id).members, ['b']);
  assert.strictEqual(store.get(t1.id).ownerId, 'b');
  assert.throws(() => store.get(t2.id), /err\.tableNotFound/);
});
