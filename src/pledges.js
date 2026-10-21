'use strict';

// Stakes between friends: what a player put up and lost ("a pizza", "a round of drinks"). The site
// only keeps the record of who owes whom; the thing itself changes hands outside it. The one who
// owes marks it sent, the one owed confirms it arrived (or lets it go). Saved to pledges.json.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { GameError } = require('./game');

const KEEP_DONE_MS = 90 * 24 * 60 * 60 * 1000; // settled pledges are kept for three months
const DAY = 24 * 60 * 60 * 1000;
// an unpaid USDT debt: after this many days no USDT tables (and the debtor mark), after this many a ban
const LIMIT_DAYS = Number(process.env.DEBT_LIMIT_DAYS) || 3;
const BAN_DAYS = Number(process.env.DEBT_BAN_DAYS) || 14;

class Pledges {
  constructor(dir) {
    this.file = path.join(dir, 'pledges.json');
    // { id, kind: lot | usdt, from, to, title | cents + network + address, game, code, at,
    //   status: owed | sent | received | forgiven, tx (the payer's transaction hash), doneAt }
    this.list = [];
    this.saveTimer = null;
    try {
      this.list = JSON.parse(fs.readFileSync(this.file, 'utf8')).pledges || [];
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('Could not read the pledges:', e.message);
    }
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ pledges: this.list }));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('Saving the pledges failed:', e.message);
    }
  }

  save() {
    if (!this.saveTimer) this.saveTimer = setTimeout(() => this.saveNow(), 1000);
  }

  add(items) {
    const at = Date.now();
    for (const x of items) this.list.push({ id: crypto.randomBytes(6).toString('hex'), status: 'owed', at, doneAt: null, ...x });
    const cutoff = at - KEEP_DONE_MS;
    this.list = this.list.filter(p => !p.doneAt || p.doneAt > cutoff);
    this.save();
  }

  mine(userId) { return this.list.filter(p => p.from === userId || p.to === userId).sort((a, b) => b.at - a.at); }
  open(userId) { return this.list.filter(p => (p.from === userId || p.to === userId) && (p.status === 'owed' || p.status === 'sent')).length; }

  // What a user owes in USDT and hasn't even marked paid. level 1: past LIMIT_DAYS (no USDT
  // tables, marked a debtor); level 2: past BAN_DAYS (banned from the games until it's paid).
  debtOf(userId, now = Date.now()) {
    const owed = this.list.filter(p => p.kind === 'usdt' && p.from === userId && p.status === 'owed');
    if (!owed.length) return { level: 0, count: 0, cents: 0 };
    const oldest = Math.min(...owed.map(p => p.at));
    const age = now - oldest;
    return {
      level: age >= BAN_DAYS * DAY ? 2 : age >= LIMIT_DAYS * DAY ? 1 : 0,
      count: owed.length,
      cents: owed.reduce((a, p) => a + p.cents, 0),
      oldest,
      limitAt: oldest + LIMIT_DAYS * DAY,
      banAt: oldest + BAN_DAYS * DAY,
    };
  }

  // sent: by the one who owes (for USDT with the transaction hash); received / forgiven: by the one owed
  mark(id, userId, status, tx = '') {
    const p = this.list.find(x => x.id === id);
    if (!p || (p.status !== 'owed' && p.status !== 'sent')) throw new GameError('err.invalidTarget');
    if (status !== 'disputed' && (status === 'sent' ? p.from !== userId : p.to !== userId)) throw new GameError('err.invalidTarget');
    if (!['sent', 'received', 'forgiven', 'disputed'].includes(status)) throw new GameError('err.invalidTarget');
    // the receiver says the money didn't come: unpaid again, from the original date
    if (status === 'disputed') {
      if (p.to !== userId || p.status !== 'sent' || p.kind !== 'usdt') throw new GameError('err.invalidTarget');
      p.status = 'owed';
      p.disputedTx = p.tx;
      p.tx = null;
      this.save();
      return p;
    }
    if (status === 'sent' && p.kind === 'usdt') {
      tx = String(tx || '').trim();
      if (!/^(0x)?[0-9a-fA-F]{64}$/.test(tx)) throw new GameError('err.usdt.tx');
      p.tx = tx;
    }
    p.status = status;
    if (status !== 'sent') p.doneAt = Date.now();
    this.save();
    return p;
  }
}

module.exports = { Pledges, LIMIT_DAYS, BAN_DAYS };
