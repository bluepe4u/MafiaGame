'use strict';

// Short-lived shared state: rate limits and one-time tokens (email confirmation, password reset).
// In Redis when REDIS_URL is set (the installer runs one on the server), so it survives restarts and
// would be shared by several processes; otherwise in memory (tests, local runs). Same async API.

class MemoryKv {
  constructor() {
    this.map = new Map(); // key -> { value, until }
    this.kind = 'memory';
  }

  live(key) {
    const e = this.map.get(key);
    if (e && e.until && e.until < Date.now()) { this.map.delete(key); return null; }
    return e || null;
  }

  async get(key) { return this.live(key)?.value ?? null; }
  async set(key, value, ttlSec) { this.map.set(key, { value: String(value), until: ttlSec ? Date.now() + ttlSec * 1000 : 0 }); }
  async del(key) { this.map.delete(key); }
  // read and delete at once: a token works a single time
  async take(key) { const v = await this.get(key); this.map.delete(key); return v; }
  // count in a window that starts with the first hit
  async incr(key, ttlSec) {
    const e = this.live(key);
    const n = (e ? Number(e.value) : 0) + 1;
    this.map.set(key, { value: String(n), until: e ? e.until : Date.now() + ttlSec * 1000 });
    if (this.map.size > 50000) this.sweep();
    return n;
  }

  sweep() { for (const k of this.map.keys()) this.live(k); }
  async close() {}
}

class RedisKv {
  constructor(client) {
    this.client = client;
    this.kind = 'redis';
  }

  async get(key) { return this.client.get(key); }
  async set(key, value, ttlSec) { await this.client.set(key, String(value), ttlSec ? { EX: ttlSec } : {}); }
  async del(key) { await this.client.del(key); }
  async take(key) { return this.client.getDel(key); }
  async incr(key, ttlSec) {
    const [n] = await this.client.multi().incr(key).expire(key, ttlSec, 'NX').exec();
    return Number(n);
  }

  async close() { await this.client.quit().catch(() => {}); }
}

// connects to Redis if REDIS_URL is set; falls back to memory if it can't
async function createKv(url = process.env.REDIS_URL) {
  if (!url) return new MemoryKv();
  const { createClient } = require('redis');
  const client = createClient({ url, socket: { reconnectStrategy: n => Math.min(n * 200, 5000) } });
  let errors = 0;
  client.on('error', e => { if (errors++ < 3 || errors % 100 === 0) console.error('Redis:', e.message); });
  // a Redis that's down at start must not keep the site from starting: wait a few seconds at most
  let timer;
  try {
    await Promise.race([client.connect(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), 3000); })]);
    clearTimeout(timer);
    console.log('Redis connected');
    return new RedisKv(client);
  } catch (e) {
    clearTimeout(timer);
    client.disconnect().catch(() => {});
    console.error(`Redis at ${url} is not reachable (${e.message}): using memory`);
    return new MemoryKv();
  }
}

// a rate limit: at most `max` hits per `windowSec` for a key; throws the given error past it
async function limit(kv, key, max, windowSec) {
  return (await kv.incr(`rl:${key}`, windowSec)) <= max;
}

module.exports = { createKv, MemoryKv, limit };
