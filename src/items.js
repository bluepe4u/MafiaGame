'use strict';

// Cosmetic items the admin can gift to players. Display names live in the client's translations
// (item.<id>); `slot` is where an item is equipped. Reaction items aren't equipped: owning one adds
// its emoji to the player's reaction bar.
const ITEMS = {
  // hats sit on top of the avatar
  'hat.tophat': { slot: 'hat', emoji: '🎩' },
  'hat.crown': { slot: 'hat', emoji: '👑' },
  'hat.cap': { slot: 'hat', emoji: '🧢' },
  'hat.grad': { slot: 'hat', emoji: '🎓' },
  'hat.helmet': { slot: 'hat', emoji: '🪖' },
  'hat.pumpkin': { slot: 'hat', emoji: '🎃' },
  'hat.rose': { slot: 'hat', emoji: '🌹' },
  // worn automatically on your birthday (not given by the admin)
  'hat.birthday': { slot: 'hat', emoji: '🎂', auto: true },
  // animated rings around the avatar
  'frame.gold': { slot: 'frame' },
  'frame.fire': { slot: 'frame' },
  'frame.neon': { slot: 'frame' },
  'frame.blood': { slot: 'frame' },
  'frame.ice': { slot: 'frame' },
  // name colours
  'name.gold': { slot: 'name' },
  'name.blood': { slot: 'name' },
  'name.toxic': { slot: 'name' },
  'name.rainbow': { slot: 'name' },
  // extra reactions
  'react.knife': { slot: 'reaction', emoji: '🔪' },
  'react.wine': { slot: 'reaction', emoji: '🍷' },
  'react.detective': { slot: 'reaction', emoji: '🕵️' },
  'react.clown': { slot: 'reaction', emoji: '🤡' },
  'react.rat': { slot: 'reaction', emoji: '🐀' },
  'react.kiss': { slot: 'reaction', emoji: '💋' },
  'react.brain': { slot: 'reaction', emoji: '🧠' },
  'react.flower': { slot: 'reaction', emoji: '💐' },
};

const EQUIP_SLOTS = ['hat', 'frame', 'name'];

module.exports = { ITEMS, EQUIP_SLOTS };
