'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pledges, LIMIT_DAYS, BAN_DAYS } = require('../src/pledges');

const DAY = 24 * 60 * 60 * 1000;
const TX = 'ab'.repeat(32);

test('USDT debts: marked paid with a hash, confirmed or disputed; the debtor levels by age', () => {
  const store = new Pledges(fs.mkdtempSync(path.join(os.tmpdir(), 'pledges-')));
  store.add([{ kind: 'usdt', from: 'bob', to: 'ann', cents: 1250 }]);
  const p = store.list[0];
  assert.strictEqual(store.debtOf('bob').level, 0);
  assert.strictEqual(store.debtOf('bob').cents, 1250);
  assert.strictEqual(store.debtOf('bob', Date.now() + LIMIT_DAYS * DAY).level, 1);
  assert.strictEqual(store.debtOf('bob', Date.now() + BAN_DAYS * DAY).level, 2);
  assert.strictEqual(store.debtOf('ann').level, 0);
  assert.throws(() => store.mark(p.id, 'ann', 'sent', TX), /invalidTarget/); // only the payer marks it paid
  assert.throws(() => store.mark(p.id, 'bob', 'sent', 'nope'), /usdt.tx/);
  store.mark(p.id, 'bob', 'sent', TX);
  assert.strictEqual(store.debtOf('bob', Date.now() + BAN_DAYS * DAY).count, 0); // marked paid: no penalty
  // the money didn't come: unpaid again, the clock from the original date
  assert.throws(() => store.mark(p.id, 'bob', 'disputed'), /invalidTarget/);
  store.mark(p.id, 'ann', 'disputed');
  assert.strictEqual(p.status, 'owed');
  assert.strictEqual(store.debtOf('bob', p.at + BAN_DAYS * DAY).level, 2);
  store.mark(p.id, 'bob', 'sent', TX);
  store.mark(p.id, 'ann', 'received');
  assert.strictEqual(p.status, 'received');
  assert.throws(() => store.mark(p.id, 'ann', 'disputed'), /invalidTarget/);
});
