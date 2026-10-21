'use strict';

// Everything the site keeps lives in one SQLite file (DATA_DIR/site.db), through Node's built-in
// node:sqlite. The stores keep working on their objects in memory as before; saving writes only the
// records that changed (each record is one row of JSON), in one transaction. On the first start the
// old JSON files are imported once and renamed to *.json.migrated (kept as they were).
//
// A store describes its saved parts: 'map' (an object of records by id), 'list' (an array of
// records with an id, kept in order) or 'value' (anything, saved whole).

const fs = require('fs');
const path = require('path');

// node:sqlite prints an "experimental" warning on Node 22; it's stable enough for this
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if (String(warning?.message || warning).includes('SQLite')) return;
  return emitWarning.call(process, warning, ...rest);
};
const { DatabaseSync } = require('node:sqlite');

const open = new Map(); // file -> Db, one connection per data dir

class Db {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.file = file;
    this.sql = new DatabaseSync(file);
    this.sql.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS records (
        part TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL,
        PRIMARY KEY (part, id)
      );
      CREATE INDEX IF NOT EXISTS records_seq ON records (part, seq);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.q = {
      rows: this.sql.prepare('SELECT id, data FROM records WHERE part = ? ORDER BY seq, id'),
      put: this.sql.prepare('INSERT INTO records (part, id, seq, data) VALUES (?, ?, ?, ?) ON CONFLICT (part, id) DO UPDATE SET data = excluded.data'),
      del: this.sql.prepare('DELETE FROM records WHERE part = ? AND id = ?'),
      maxSeq: this.sql.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM records WHERE part = ?'),
      get: this.sql.prepare('SELECT value FROM kv WHERE key = ?'),
      set: this.sql.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'),
      metaGet: this.sql.prepare('SELECT value FROM meta WHERE key = ?'),
      metaSet: this.sql.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'),
    };
  }

  meta(key, value) {
    if (value === undefined) return this.q.metaGet.get(key)?.value ?? null;
    this.q.metaSet.run(key, String(value));
  }

  transaction(fn) {
    this.sql.exec('BEGIN');
    try {
      fn();
      this.sql.exec('COMMIT');
    } catch (e) {
      this.sql.exec('ROLLBACK');
      throw e;
    }
  }

  close() {
    this.sql.close();
    open.delete(this.file);
  }
}

function dbFor(dir) {
  const file = path.join(dir, 'site.db');
  if (!open.has(file)) open.set(file, new Db(file));
  return open.get(file);
}

// A store's saved state in the database. `name` prefixes its parts; `legacy` is the old JSON file
// (relative to dir) whose top-level fields are the parts.
class Saved {
  constructor(dir, name, parts, legacy = null) {
    this.db = dbFor(dir);
    this.name = name;
    this.parts = parts; // { part: 'map' | 'list' | 'value' }
    this.legacy = legacy && path.join(dir, legacy);
    this.cache = {}; // part -> Map(id -> json) as last written; for values, the json string
  }

  key(part) { return `${this.name}.${part}`; }

  load() {
    const migratedKey = `migrated:${this.name}`;
    if (this.legacy && !this.db.meta(migratedKey)) {
      let data = null;
      try { data = JSON.parse(fs.readFileSync(this.legacy, 'utf8')); } catch (e) {
        if (e.code !== 'ENOENT') console.error(`Could not read ${this.legacy}:`, e.message);
      }
      if (data) {
        this.save(data);
        fs.renameSync(this.legacy, `${this.legacy}.migrated`);
        console.log(`Moved ${path.basename(this.legacy)} into the database`);
      }
      this.db.meta(migratedKey, Date.now());
    }
    const out = {};
    for (const [part, kind] of Object.entries(this.parts)) {
      if (kind === 'value') {
        const row = this.db.q.get.get(this.key(part));
        this.cache[part] = row ? row.value : undefined;
        out[part] = row ? JSON.parse(row.value) : undefined;
        continue;
      }
      const rows = this.db.q.rows.all(this.key(part));
      this.cache[part] = new Map(rows.map(r => [r.id, r.data]));
      out[part] = kind === 'map'
        ? Object.fromEntries(rows.map(r => [r.id, JSON.parse(r.data)]))
        : rows.map(r => JSON.parse(r.data));
    }
    return out;
  }

  // write what changed since the last save: changed records, new ones, and deletions
  save(data) {
    this.db.transaction(() => {
      for (const [part, kind] of Object.entries(this.parts)) {
        if (!(part in data)) continue;
        const key = this.key(part);
        if (kind === 'value') {
          const json = JSON.stringify(data[part] ?? null);
          if (this.cache[part] !== json) { this.db.q.set.run(key, json); this.cache[part] = json; }
          continue;
        }
        const before = this.cache[part] || new Map();
        const now = new Map();
        const entries = kind === 'map' ? Object.entries(data[part] || {}) : (data[part] || []).map(x => [String(x.id), x]);
        let seq = kind === 'list' ? this.db.q.maxSeq.get(key).n : 0;
        for (const [id, rec] of entries) {
          const json = JSON.stringify(rec);
          now.set(id, json);
          if (before.get(id) !== json) this.db.q.put.run(key, id, before.has(id) ? 0 : ++seq, json);
        }
        for (const id of before.keys()) if (!now.has(id)) this.db.q.del.run(key, id);
        this.cache[part] = now;
      }
    });
  }
}

// A game's saved rooms: an array of room JSON in, the same array out.
function roomStore(dir, game, legacy) {
  const saved = new Saved(dir, `rooms.${game}`, { rooms: 'map' }, null);
  const legacyFile = path.join(dir, legacy);
  return {
    load() {
      const migratedKey = `migrated:rooms.${game}`;
      if (!saved.db.meta(migratedKey)) {
        try {
          const list = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
          saved.load();
          saved.save({ rooms: Object.fromEntries(list.map(r => [r.code, r])) });
          fs.renameSync(legacyFile, `${legacyFile}.migrated`);
        } catch (e) {
          if (e.code !== 'ENOENT') console.error(`Could not read ${legacyFile}:`, e.message);
        }
        saved.db.meta(migratedKey, Date.now());
      }
      return Object.values(saved.load().rooms);
    },
    save(rooms) {
      saved.save({ rooms: Object.fromEntries(rooms.map(r => { const j = typeof r.toJSON === 'function' ? r.toJSON() : r; return [j.code, j]; })) });
    },
  };
}

module.exports = { dbFor, Saved, roomStore };
