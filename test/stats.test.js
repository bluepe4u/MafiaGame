'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Stats } = require('../src/stats');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'stats-'));
const UA = 'Mozilla/5.0 (Macintosh) Safari/605';

test('stats: views, distinct visitors per day, sources, bots skipped', () => {
  let now = Date.parse('2026-10-21T10:00:00Z');
  const st = new Stats(tmp(), { now: () => now });
  st.view({ page: '/', ip: '1.1.1.1', ua: UA, referrer: 'https://www.reddit.com/r/boardgames', host: 'bluepeau.club' });
  st.view({ page: '/poker/', ip: '1.1.1.1', ua: UA, referrer: 'https://bluepeau.club/', host: 'bluepeau.club' });
  st.view({ page: '/', ip: '2.2.2.2', ua: UA });
  st.view({ page: '/', ip: '3.3.3.3', ua: 'Googlebot/2.1' });
  st.game('poker');
  let s = st.summary(1);
  assert.deepStrictEqual(s.days[0], { day: '2026-10-21', views: 3, visitors: 2, games: 1 });
  assert.deepStrictEqual(s.refs, [['reddit.com', 1]]);
  assert.deepStrictEqual(s.pages[0], ['/', 2]);
  // the next day the same person counts again (a new salt), and no IP is kept anywhere
  now += 86400000;
  st.view({ page: '/', ip: '1.1.1.1', ua: UA });
  s = st.summary(2);
  assert.strictEqual(s.days[1].visitors, 1);
  st.saveNow();
  assert.ok(!fs.readFileSync(st.file, 'utf8').includes('1.1.1.1'));
});

test('stats: errors are clipped, repeats counted, kept across restarts', () => {
  const dir = tmp();
  const st = new Stats(dir);
  st.error({ msg: 'x is undefined', src: 'https://bluepeau.club/poker/poker.js', line: 12, page: '/poker/', ua: UA });
  st.error({ msg: 'x is undefined', src: 'https://bluepeau.club/poker/poker.js', line: 12, page: '/poker/', ua: UA });
  st.error({ msg: 'y'.repeat(1000), page: '/' });
  st.saveNow();
  const back = new Stats(dir);
  const errs = back.summary().errors;
  assert.strictEqual(errs.length, 2);
  assert.strictEqual(errs.find(e => e.line === 12).count, 2);
  assert.strictEqual(errs.find(e => e.msg.startsWith('y')).msg.length, 300);
});
