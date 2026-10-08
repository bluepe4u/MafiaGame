'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { SttQueue, clean } = require('../src/stt');

test('stt: Whisper silence hallucinations and noises are dropped', () => {
  assert.strictEqual(clean('Субтитры сделал DimaTorzok'), '');
  assert.strictEqual(clean('Продолжение следует...'), '');
  assert.strictEqual(clean('угу'), '');
  assert.strictEqual(clean('  я  голосую   за Диму '), 'я голосую за Диму');
});

test('stt: clips go out in order, paced to the free tier, a 429 waits and retries', async () => {
  process.env.GROQ_API_KEY = 'test';
  let clock = 0;
  const calls = [];
  let fail429 = true;
  const fetchImpl = async (url, opts) => {
    calls.push({ url, at: clock, model: opts.body.get('model'), lang: opts.body.get('language') });
    if (fail429 && calls.length === 2) {
      fail429 = false;
      return { ok: false, status: 429, headers: { get: () => '5' } };
    }
    return { ok: true, status: 200, json: async () => ({ text: `text ${calls.length}` }) };
  };
  const got = [];
  const q = new SttQueue({
    onText: (job, text) => got.push([job.n, text]),
    fetchImpl, now: () => clock, sleep: async ms => { clock += ms; },
  });
  for (let n = 1; n <= 20; n++) q.add({ n, code: 'R', day: 1, audio: Buffer.from('x'), lang: 'ru' });
  assert.strictEqual(q.pending('R', 1), 20);
  while (q.running) await new Promise(r => setImmediate(r));
  assert.strictEqual(got.length, 20);
  assert.deepStrictEqual(got.map(g => g[0]), Array.from({ length: 20 }, (_, i) => i + 1)); // nothing lost, in order
  assert.ok(calls[2].at >= 5000, 'waited out the 429');
  assert.ok(calls.at(-1).at >= 60000, 'no more than 18 requests in the first minute');
  assert.strictEqual(calls[0].model, 'whisper-large-v3-turbo');
  assert.strictEqual(calls[0].lang, 'ru');
  assert.strictEqual(q.pending('R'), 0);
  delete process.env.GROQ_API_KEY;
});
