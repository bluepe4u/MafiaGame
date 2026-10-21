// The check of a provably fair deal, in the browser (and in the tests: Node has the same Web
// Crypto). The same steps as src/poker/fair.js: sha256(seed) must equal the commitment, and the
// deck comes from a Fisher-Yates shuffle fed by HMAC-SHA256(seed, "clientSeeds:nonce:counter").
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PokerFair = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const RANKS = '23456789TJQKA';
  const SUITS = 'shdc';
  const DECK = [...RANKS].flatMap(r => [...SUITS].map(s => r + s));
  const enc = new TextEncoder();
  const subtle = () => globalThis.crypto.subtle;
  const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

  const sha256 = async text => hex(await subtle().digest('SHA-256', enc.encode(text)));

  async function deckOf(seed, clientSeeds, nonce) {
    const key = await subtle().importKey('raw', enc.encode(seed), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const message = `${clientSeeds.join(',')}:${nonce}`;
    let counter = 0;
    let block = new DataView(new ArrayBuffer(0));
    let at = 0;
    const next = async () => {
      if (at + 4 > block.byteLength) {
        block = new DataView(await subtle().sign('HMAC', key, enc.encode(`${message}:${counter++}`)));
        at = 0;
      }
      const u = block.getUint32(at);
      at += 4;
      return u;
    };
    const a = DECK.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const n = i + 1;
      const limit = Math.floor(0x100000000 / n) * n;
      let u;
      do u = await next(); while (u >= limit);
      const j = u % n;
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // the deal from a deck, as the table deals it: two cards each from the small blind, then the
  // board with a burn before the flop, the turn and the river
  function dealOf(deck, players) {
    const d = deck.slice();
    const hole = players.map(() => []);
    for (let round = 0; round < 2; round++) for (let k = 0; k < players.length; k++) hole[k].push(d.pop());
    const board = [];
    for (const n of [3, 1, 1]) { d.pop(); for (let k = 0; k < n; k++) board.push(d.pop()); }
    return { hole, board };
  }

  // a hand from the fairness log: { n, commit, seed, clients, nonce, players }
  async function verify(entry) {
    const commitOk = (await sha256(entry.seed)) === entry.commit;
    const deck = await deckOf(entry.seed, entry.clients, entry.nonce);
    return { commitOk, deck, ...dealOf(deck, entry.players || entry.clients.map((_, k) => `#${k + 1}`)) };
  }

  return { DECK, sha256, deckOf, dealOf, verify };
});
