'use strict';

// Tables: a permanent space for a group of friends. One link that never changes; whoever is
// allowed picks the next game and everyone at the table is called into the new room.
// Saved in the site database; the rooms themselves live in each game's own store.

const crypto = require('crypto');
const { GameError } = require('./game');
const { Saved } = require('./db');

const MAX_NAME = 40;
const MAX_TABLES_PER_USER = 10;
const HISTORY_KEEP = 50;

class TableStore {
  constructor(dir) {
    this.store = new Saved(dir, 'tables', { tables: 'map' }, 'tables.json');
    this.tables = {}; // id -> { id, name, ownerId, members: [userId], createdAt, current, history }
    this.saveTimer = null;
    this.tables = this.store.load().tables || {};
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      this.store.save({ tables: this.tables });
    } catch (e) {
      console.error('Saving tables failed:', e.message);
    }
  }

  save() {
    if (!this.saveTimer) this.saveTimer = setTimeout(() => this.saveNow(), 500);
  }

  get(id) {
    const table = this.tables[String(id || '').toUpperCase()];
    if (!table) throw new GameError('err.tableNotFound');
    return table;
  }

  mine(userId) {
    return Object.values(this.tables).filter(t => t.members.includes(userId)).sort((a, b) => a.createdAt - b.createdAt);
  }

  cleanName(name) {
    name = String(name || '').trim().replace(/\s+/g, ' ').slice(0, MAX_NAME);
    if (!name) throw new GameError('err.nameRequired');
    return name;
  }

  requireOwner(table, user) {
    if (table.ownerId !== user.id && !user.admin) throw new GameError('err.tableOwnerOnly');
  }

  create(user, name) {
    if (this.mine(user.id).length >= MAX_TABLES_PER_USER) throw new GameError('err.tooManyTables', { n: MAX_TABLES_PER_USER });
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let id;
    do id = Array.from(crypto.randomBytes(8), b => alphabet[b % alphabet.length]).join('');
    while (this.tables[id]);
    const table = { id, name: this.cleanName(name), ownerId: user.id, members: [user.id], createdAt: Date.now(), current: null, history: [] };
    this.tables[id] = table;
    this.save();
    return table;
  }

  join(id, user) {
    const table = this.get(id);
    if (!table.members.includes(user.id)) {
      if (this.mine(user.id).length >= MAX_TABLES_PER_USER) throw new GameError('err.tooManyTables', { n: MAX_TABLES_PER_USER });
      table.members.push(user.id);
      this.save();
    }
    return table;
  }

  // Leaving hands the table to the next member; the last one out closes it.
  leave(id, user) {
    const table = this.get(id);
    table.members = table.members.filter(m => m !== user.id);
    if (!table.members.length) delete this.tables[table.id];
    else if (table.ownerId === user.id) table.ownerId = table.members[0];
    this.save();
  }

  rename(id, user, name) {
    const table = this.get(id);
    this.requireOwner(table, user);
    table.name = this.cleanName(name);
    this.save();
    return table;
  }

  kick(id, user, targetId) {
    const table = this.get(id);
    this.requireOwner(table, user);
    if (targetId === table.ownerId) throw new GameError('err.invalidTarget');
    table.members = table.members.filter(m => m !== targetId);
    this.save();
    return table;
  }

  // Public tables are listed for everyone to find and join; private ones only by their link.
  setPublic(id, user, on) {
    const table = this.get(id);
    this.requireOwner(table, user);
    table.public = !!on;
    this.save();
    return table;
  }

  publicList() {
    return Object.values(this.tables).filter(t => t.public);
  }

  // Remember the room the table is playing in now.
  setCurrent(table, game, code, byUserId) {
    table.current = { game, code, by: byUserId, at: Date.now() };
    table.history = [table.current, ...table.history].slice(0, HISTORY_KEEP);
    this.save();
  }

  // House rules: the settings a table last played each game with, applied to its next room.
  saveSettings(id, game, settings) {
    const table = this.tables[id];
    if (!table) return;
    (table.settings ||= {})[game] = { ...settings };
    this.save();
  }

  settingsFor(id, game) {
    return this.tables[id]?.settings?.[game] || null;
  }

  // Forget accounts that no longer exist (e.g. after the admin wipes accounts).
  prune(userIds) {
    const alive = new Set(userIds);
    for (const table of Object.values(this.tables)) {
      table.members = table.members.filter(m => alive.has(m));
      if (!table.members.length) delete this.tables[table.id];
      else if (!alive.has(table.ownerId)) table.ownerId = table.members[0];
    }
    this.save();
  }
}

module.exports = { TableStore };
