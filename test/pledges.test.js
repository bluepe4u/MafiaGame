'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pledges } = require('../src/pledges');

const TX = 'ab'.repeat(32);

test('USDT debts: marked paid with a hash, confirmed or disputed; nothing is enforced', () => {
  const store = new Pledges(fs.mkdtempSync(path.join(os.tmpdir(), 'pledges-')));
  store.add([{ kind: 'usdt', from: 'bob', to: 'ann', cents: 1250 }]);
  const p = store.list[0];
  assert.throws(() => store.mark(p.id, 'ann', 'sent', TX), /invalidTarget/); // only the payer marks it paid
  assert.throws(() => store.mark(p.id, 'bob', 'sent', 'nope'), /usdt.tx/);
  store.mark(p.id, 'bob', 'sent', TX);
  // the money didn't come: unpaid again
  assert.throws(() => store.mark(p.id, 'bob', 'disputed'), /invalidTarget/);
  store.mark(p.id, 'ann', 'disputed');
  assert.strictEqual(p.status, 'owed');
  store.mark(p.id, 'bob', 'sent', TX);
  store.mark(p.id, 'ann', 'received');
  assert.strictEqual(p.status, 'received');
  assert.throws(() => store.mark(p.id, 'ann', 'disputed'), /invalidTarget/);
});
