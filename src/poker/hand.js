// Poker hands: the best five of up to seven cards, and each hand's chances to win (equity).
// Shared by the server (require) and the browser (served at /poker/hand.js as window.PokerHand),
// so the table highlights exactly what the server scores.
//
// A card is "As", "Td", "9h": rank 23456789TJQKA, suit s h d c.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PokerHand = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const RANKS = '23456789TJQKA';
  const SUITS = 'shdc';
  // high card … straight flush; a royal flush is an ace-high straight flush
  const CATS = ['high', 'pair', 'twoPair', 'trips', 'straight', 'flush', 'full', 'quads', 'straightFlush'];
  const B = [1, 16, 256, 4096, 65536, 1048576]; // score = cat * 16^5 + tiebreak ranks, highest first

  // cards as numbers 0..51 for speed: rank = (n >> 2) + 2, suit = n & 3
  const toInt = c => (RANKS.indexOf(c[0]) << 2) | SUITS.indexOf(c[1]);
  const toStr = n => RANKS[n >> 2] + SUITS[n & 3];
  const DECK = [];
  for (const r of RANKS) for (const s of SUITS) DECK.push(r + s);

  // the top card of a five-in-a-row in a mask of ranks (bit r for rank r; the ace also counts as 1)
  function straightHigh(mask) {
    if (mask & (1 << 14)) mask |= 2;
    for (let h = 14; h >= 5; h--) if (((mask >> (h - 4)) & 31) === 31) return h;
    return 0;
  }

  // reused buffers: score() is the hot loop of the equity calculation
  const rc = new Int8Array(15);
  const sc = new Int8Array(4);
  const sm = new Int32Array(4);

  // the hand's score: higher wins, equal ties
  function score(cards) {
    rc.fill(0); sc.fill(0); sm.fill(0);
    let mask = 0;
    for (let i = 0; i < cards.length; i++) {
      const r = (cards[i] >> 2) + 2;
      const s = cards[i] & 3;
      rc[r]++; sc[s]++; sm[s] |= 1 << r; mask |= 1 << r;
    }
    let flush = -1;
    for (let s = 0; s < 4; s++) if (sc[s] >= 5) flush = s;
    if (flush >= 0) {
      const sf = straightHigh(sm[flush]);
      if (sf) return 8 * B[5] + sf * B[4];
    }
    let quad = 0, trip = 0, trip2 = 0, pair = 0, pair2 = 0;
    for (let r = 14; r >= 2; r--) {
      const n = rc[r];
      if (n === 4) { if (!quad) quad = r; } else if (n === 3) { if (!trip) trip = r; else if (!trip2) trip2 = r; } else if (n === 2) { if (!pair) pair = r; else if (!pair2) pair2 = r; }
    }
    const kickers = (skip, n) => {
      let v = 0, k = 0;
      for (let r = 14; r >= 2 && k < n; r--) {
        if (!rc[r] || skip.includes(r)) continue;
        v += r * B[3 - k]; k++;
      }
      return v;
    };
    if (quad) return 7 * B[5] + quad * B[4] + kickers([quad], 1);
    if (trip && (trip2 || pair)) return 6 * B[5] + trip * B[4] + Math.max(trip2, pair) * B[3];
    if (flush >= 0) {
      let v = 0, k = 0;
      for (let r = 14; r >= 2 && k < 5; r--) if (sm[flush] & (1 << r)) { v += r * B[4 - k]; k++; }
      return 5 * B[5] + v;
    }
    const st = straightHigh(mask);
    if (st) return 4 * B[5] + st * B[4];
    if (trip) return 3 * B[5] + trip * B[4] + kickers([trip], 2);
    if (pair && pair2) return 2 * B[5] + pair * B[4] + pair2 * B[3] + kickers([pair, pair2], 1) / 16;
    if (pair) return B[5] + pair * B[4] + kickers([pair], 3);
    let v = 0, k = 0;
    for (let r = 14; r >= 2 && k < 5; r--) if (rc[r]) { v += r * B[4 - k]; k++; }
    return v;
  }

  // The best hand in full: category, score, the five cards it uses and what to call it.
  // name: { key, params } for the client's translations, e.g. pk.h.twoPair { a: 'K', b: '7' }
  function best(cardStrs) {
    const cards = cardStrs.map(toInt);
    const s = score(cards);
    const cat = Math.floor(s / B[5]);
    const digits = [4, 3, 2, 1, 0].map(i => Math.floor(s / B[i]) % 16);
    const R = r => RANKS[r - 2];
    const of = r => cardStrs.filter(c => RANKS.indexOf(c[0]) + 2 === r);
    const sorted = cardStrs.slice().sort((a, b) => RANKS.indexOf(b[0]) - RANKS.indexOf(a[0]));
    let used;
    let params = {};
    const run = (pool, high) => {
      const out = [];
      for (let r = high; r > high - 5; r--) out.push(pool.find(c => (RANKS.indexOf(c[0]) + 2 === r) || (r === 1 && c[0] === 'A')));
      return out;
    };
    if (cat === 8 || cat === 5) {
      const suit = [...SUITS].find(x => cardStrs.filter(c => c[1] === x).length >= 5);
      const pool = sorted.filter(c => c[1] === suit);
      used = cat === 8 ? run(pool, digits[0]) : pool.slice(0, 5);
      params = { a: R(cat === 8 ? digits[0] : RANKS.indexOf(used[0][0]) + 2) };
    } else if (cat === 4) {
      used = run(sorted, digits[0]);
      params = { a: R(digits[0]) };
    } else {
      // groups first (quads, trips, pairs), then the highest other cards
      const groups = cat === 7 ? [digits[0]] : cat === 6 ? [digits[0], digits[1]] : cat === 3 ? [digits[0]] : cat === 2 ? [digits[0], digits[1]] : cat === 1 ? [digits[0]] : [];
      const take = cat === 6 ? [3, 2] : null;
      used = [];
      groups.forEach((r, i) => used.push(...of(r).slice(0, take ? take[i] : 4)));
      for (const c of sorted) if (used.length < 5 && !used.includes(c)) used.push(c);
      params = cat === 0 ? { a: sorted[0][0] } : groups.length === 2 ? { a: R(groups[0]), b: R(groups[1]) } : { a: R(groups[0]) };
    }
    const key = cat === 8 && digits[0] === 14 ? 'royal' : CATS[cat];
    // the cards that make the combination itself, without kickers: a pair is two cards
    const core = used.slice(0, [1, 2, 4, 3, 5, 5, 5, 4, 5][cat]);
    return { cat, score: s, cards: used, core, name: { key: 'pk.h.' + key, params } };
  }

  // compare two hands of 5..7 cards: >0 when a wins
  const compare = (a, b) => score(a.map(toInt)) - score(b.map(toInt));

  // a small seeded generator, so a runout's equity doesn't depend on Math.random's state
  function mulberry(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Each hand's chance to win the pot from here (ties count as a share). holes: [[c, c], …],
  // board: 0–5 cards. Exact when two or fewer cards are to come, sampled before the flop.
  // outs (one card to come): how many rivers win or tie for each hand.
  function equity(holes, board = [], { samples = 12000, seed = 1, dead = [] } = {}) {
    const n = holes.length;
    const H = holes.map(h => h.map(toInt));
    const Bd = board.map(toInt);
    const used = new Set([...H.flat(), ...Bd, ...dead.map(toInt)]);
    const rest = [];
    for (let i = 0; i < 52; i++) if (!used.has(i)) rest.push(i);
    const need = 5 - Bd.length;
    const share = new Float64Array(n);
    const wins = new Float64Array(n);
    const ties = new Float64Array(n);
    const outs = need === 1 ? new Array(n).fill(0) : null;
    const hand = new Array(7);
    let total = 0;
    const scores = new Array(n);
    const deal = extra => {
      let top = -1, k = 0;
      for (let p = 0; p < n; p++) {
        hand.length = 0;
        hand.push(H[p][0], H[p][1], ...Bd, ...extra);
        scores[p] = score(hand);
        if (scores[p] > top) { top = scores[p]; k = 1; } else if (scores[p] === top) k++;
      }
      for (let p = 0; p < n; p++) {
        if (scores[p] !== top) continue;
        share[p] += 1 / k;
        if (k === 1) wins[p]++; else ties[p]++;
        if (outs) outs[p]++;
      }
      total++;
    };
    if (need === 0) deal([]);
    else if (need === 1) for (const a of rest) deal([a]);
    else if (need === 2) {
      for (let i = 0; i < rest.length; i++) for (let j = i + 1; j < rest.length; j++) deal([rest[i], rest[j]]);
    } else {
      const rnd = mulberry(seed);
      const pick = rest.slice();
      const extra = new Array(need);
      for (let s = 0; s < samples; s++) {
        // a partial shuffle: the first `need` cards of the rest
        for (let i = 0; i < need; i++) {
          const j = i + Math.floor(rnd() * (pick.length - i));
          const t = pick[i]; pick[i] = pick[j]; pick[j] = t;
          extra[i] = pick[i];
        }
        deal(extra);
      }
    }
    return {
      eq: [...share].map(x => x / total),
      win: [...wins].map(x => x / total),
      tie: [...ties].map(x => x / total),
      outs,
      exact: need <= 2,
    };
  }

  return { RANKS, SUITS, CATS, DECK, score: cs => score(cs.map(toInt)), best, compare, equity, toInt, toStr };
}));
