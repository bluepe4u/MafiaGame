'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Visit counts and script errors, kept on our own server: no cookies, nothing sent elsewhere.
// A visitor is counted once a day by a hash of IP + browser with a salt that changes every day,
// so nobody can be followed from one day to the next, and IPs are never stored.

const KEEP_DAYS = 90;
const KEEP_ERRORS = 200;
const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|curl|wget|python|headless|monitor/i;

const dayOf = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
const emptyDay = () => ({ views: {}, visitors: 0, refs: {}, games: {} });
const bump = (obj, key, n = 1) => { obj[key] = (obj[key] || 0) + n; };

class Stats {
  constructor(dir, { now = () => Date.now() } = {}) {
    this.file = path.join(dir, 'stats.json');
    this.now = now;
    this.days = {}; // YYYY-MM-DD -> { views: { path: n }, visitors, refs: { host: n }, games: { game: n } }
    this.errors = []; // { at, msg, src, line, page, ua }, the newest last
    this.today = { day: null, salt: null, seen: [] }; // today's salt and visitor hashes
    this.saveTimer = null;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.days = data.days || {};
      this.errors = data.errors || [];
      if (data.today) this.today = data.today;
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('Could not read the stats:', e.message);
    }
    this.seen = new Set(this.today.seen);
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ days: this.days, errors: this.errors, today: { ...this.today, seen: [...this.seen] } }));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('Saving the stats failed:', e.message);
    }
  }

  save() {
    if (!this.saveTimer) this.saveTimer = setTimeout(() => this.saveNow(), 5000);
  }

  // today's record; a new day gets a new salt and forgets yesterday's hashes
  day() {
    const d = dayOf(this.now());
    if (this.today.day !== d) {
      this.today = { day: d, salt: crypto.randomBytes(16).toString('hex'), seen: [] };
      this.seen = new Set();
      const cutoff = dayOf(this.now() - KEEP_DAYS * 86400000);
      for (const k of Object.keys(this.days)) if (k < cutoff) delete this.days[k];
    }
    return (this.days[d] = this.days[d] || emptyDay());
  }

  // a page was opened (the server counts the HTML request; there's no tracking script)
  view({ page, ip, ua, referrer, host }) {
    if (!ua || BOT.test(ua)) return;
    const day = this.day();
    bump(day.views, page);
    const visitor = crypto.createHash('sha256').update(`${this.today.salt}|${ip}|${ua}`).digest('hex').slice(0, 16);
    if (!this.seen.has(visitor)) { this.seen.add(visitor); day.visitors += 1; }
    let ref = '';
    try { ref = referrer ? new URL(referrer).hostname.replace(/^www\./, '') : ''; } catch {}
    if (ref && ref !== host) bump(day.refs, ref.slice(0, 80));
    this.save();
  }

  game(name) {
    bump(this.day().games, name);
    this.save();
  }

  error({ msg, src, line, page, ua }) {
    const clip = (s, n) => String(s || '').slice(0, n);
    const e = { at: this.now(), msg: clip(msg, 300), src: clip(src, 200), line: Number(line) || 0, page: clip(page, 100), ua: clip(ua, 160) };
    // the same error again only bumps its count
    const last = this.errors.find(x => x.msg === e.msg && x.src === e.src && x.line === e.line);
    if (last) { last.count = (last.count || 1) + 1; last.at = e.at; } else this.errors.push(e);
    if (this.errors.length > KEEP_ERRORS) this.errors.splice(0, this.errors.length - KEEP_ERRORS);
    this.save();
    return e;
  }

  // the admin's view: the last two weeks, top pages and sources, the latest errors
  summary(daysBack = 14) {
    this.day();
    const days = [];
    const pages = {};
    const refs = {};
    const games = {};
    for (let k = daysBack - 1; k >= 0; k--) {
      const d = dayOf(this.now() - k * 86400000);
      const x = this.days[d] || emptyDay();
      days.push({ day: d, views: Object.values(x.views).reduce((a, b) => a + b, 0), visitors: x.visitors, games: Object.values(x.games).reduce((a, b) => a + b, 0) });
      for (const [p, n] of Object.entries(x.views)) bump(pages, p, n);
      for (const [r, n] of Object.entries(x.refs)) bump(refs, r, n);
      for (const [g, n] of Object.entries(x.games)) bump(games, g, n);
    }
    const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
    return { days, pages: top(pages, 12), refs: top(refs, 12), games: top(games, 10), errors: this.errors.slice(-30).reverse() };
  }
}

module.exports = { Stats, dayOf };
