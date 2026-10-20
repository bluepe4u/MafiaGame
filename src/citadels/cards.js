'use strict';

// Citadels cards: characters and the district deck of the 2016 edition. Names and texts live
// in the client's translations (public/citadels/cit-i18n.js); here are only the numbers.

// One character per rank in a game. `color`: the districts its income counts.
const CHARACTERS = {
  witch: { rank: 1 },
  assassin: { rank: 1 },
  thief: { rank: 2 },
  magician: { rank: 3 },
  king: { rank: 4, color: 'noble' },
  abbot: { rank: 5, color: 'religious' },
  bishop: { rank: 5, color: 'religious' },
  merchant: { rank: 6, color: 'trade' },
  architect: { rank: 7 },
  diplomat: { rank: 8, color: 'military' },
  warlord: { rank: 8, color: 'military' },
  queen: { rank: 9 },
};

// What the lobby can pick for each rank; the first is the beginner set from the rules sheet.
// Rank 9 can be left out (and always is with fewer than 5 players).
const RANK_CHOICES = {
  1: ['witch', 'assassin'],
  2: ['thief'],
  3: ['magician'],
  4: ['king'],
  5: ['abbot', 'bishop'],
  6: ['merchant'],
  7: ['architect'],
  8: ['diplomat', 'warlord'],
  9: ['queen', 'none'],
};

const COLORS = ['noble', 'religious', 'trade', 'military', 'unique'];

// The 54 ordinary districts
const BASIC = {
  manor: { color: 'noble', cost: 3, count: 5 },
  castle: { color: 'noble', cost: 4, count: 4 },
  palace: { color: 'noble', cost: 5, count: 3 },
  temple: { color: 'religious', cost: 1, count: 3 },
  church: { color: 'religious', cost: 2, count: 3 },
  monastery: { color: 'religious', cost: 3, count: 3 },
  cathedral: { color: 'religious', cost: 5, count: 2 },
  tavern: { color: 'trade', cost: 1, count: 5 },
  market: { color: 'trade', cost: 2, count: 4 },
  tradingPost: { color: 'trade', cost: 2, count: 3 },
  docks: { color: 'trade', cost: 3, count: 3 },
  harbor: { color: 'trade', cost: 4, count: 3 },
  townHall: { color: 'trade', cost: 5, count: 2 },
  watchtower: { color: 'military', cost: 1, count: 3 },
  prison: { color: 'military', cost: 2, count: 3 },
  barracks: { color: 'military', cost: 3, count: 3 },
  fortress: { color: 'military', cost: 5, count: 2 },
};

// Unique (purple) districts, one of each; a game uses some of them (settings.uniqueCount).
// What each does is written into the rules engine by its id.
const UNIQUE = {
  hauntedQuarter: { cost: 2 },
  stables: { cost: 2 },
  keep: { cost: 3 },
  armory: { cost: 3 },
  framework: { cost: 3 },
  statue: { cost: 3 },
  basilica: { cost: 4 },
  museum: { cost: 4 },
  monument: { cost: 4 },
  poorHouse: { cost: 4 },
  observatory: { cost: 4 },
  ivoryTower: { cost: 5 },
  laboratory: { cost: 5 },
  smithy: { cost: 5 },
  factory: { cost: 5 },
  quarry: { cost: 5 },
  capitol: { cost: 5 },
  mapRoom: { cost: 5 },
  imperialTreasury: { cost: 5 },
  wishingWell: { cost: 5 },
  necropolis: { cost: 5 },
  greatWall: { cost: 6 },
  library: { cost: 6 },
  schoolOfMagic: { cost: 6 },
  dragonGate: { cost: 6 },
  goldMine: { cost: 6 },
  park: { cost: 6 },
  thievesDen: { cost: 6 },
  secretVault: { cost: 0, unbuildable: true },
};

const DISTRICTS = {
  ...BASIC,
  ...Object.fromEntries(Object.entries(UNIQUE).map(([k, v]) => [k, { color: 'unique', count: 1, ...v }])),
};

// A card in play is "<kind>.<n>", e.g. "manor.3", so equal districts stay distinguishable.
const kindOf = card => String(card).split('.')[0];
const info = card => DISTRICTS[kindOf(card)];

module.exports = { CHARACTERS, RANK_CHOICES, COLORS, BASIC, UNIQUE, DISTRICTS, kindOf, info };
