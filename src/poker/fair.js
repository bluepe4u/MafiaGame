'use strict';

// Provably fair deal. Before a hand the table sees a commitment: sha256 of a secret server seed.
// Each player's browser adds a seed of its own (the server can't know them when it commits), and
// the deck is shuffled with a stream from HMAC-SHA256(server seed, client seeds + hand number).
// When the session ends the server seeds are revealed, so anyone can recompute every deck and
// check it against the commitments (public/poker/fair.js does this in the browser).

const crypto = require('crypto');
const { DECK } = require('./hand');

const newSeed = () => crypto.randomBytes(32).toString('hex');
const commit = seed => crypto.createHash('sha256').update(seed).digest('hex');
// what a client may send as its seed: short, no separators
const cleanClientSeed = s => String(s || '').replace(/[^\w-]/g, '').slice(0, 64);

// uniform integers from the HMAC stream: 4 bytes at a time, a new block when one runs out
function stream(seed, message) {
  let counter = 0;
  let block = Buffer.alloc(0);
  let at = 0;
  return () => {
    if (at + 4 > block.length) {
      block = crypto.createHmac('sha256', seed).update(`${message}:${counter++}`).digest();
      at = 0;
    }
    const u = block.readUInt32BE(at);
    at += 4;
    return u;
  };
}

// Fisher-Yates over the deck in its fixed order; rejection sampling keeps every j equally likely.
// The dealer takes cards from the end of the array.
function deckOf(seed, clientSeeds, nonce) {
  const next = stream(seed, `${clientSeeds.join(',')}:${nonce}`);
  const a = DECK.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const n = i + 1;
    const limit = Math.floor(0x100000000 / n) * n;
    let u;
    do u = next(); while (u >= limit);
    const j = u % n;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = { newSeed, commit, deckOf, cleanClientSeed };
