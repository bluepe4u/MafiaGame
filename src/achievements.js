'use strict';

// Achievements and what they pay in site chips. Names and texts are in the client's translations
// (ach.<id>, ach.<id>.text). Each is paid once.
const ACHIEVEMENTS = {
  welcome: { reward: 500 },
  streak7: { reward: 500 },
  'pk.first': { reward: 200, game: 'poker' },
  'pk.win': { reward: 500, game: 'poker' },
  'pk.hands100': { reward: 300, game: 'poker' },
  'pk.hands1000': { reward: 1500, game: 'poker' },
  'pk.allIns10': { reward: 400, game: 'poker' },
  'pk.quads': { reward: 500, game: 'poker' },
  'pk.straightFlush': { reward: 2000, game: 'poker' },
  'pk.royal': { reward: 10000, game: 'poker' },
  'pk.72': { reward: 300, game: 'poker' },
  'pk.runnerRunner': { reward: 400, game: 'poker' },
  'mafia.win': { reward: 200, game: 'mafia' },
  'mono.win': { reward: 200, game: 'mono' },
  'spy.win': { reward: 200, game: 'spy' },
  'cit.win': { reward: 200, game: 'cit' },
};

// the daily bonus for coming to the site: grows with the streak, a week in a row pays extra
const dailyBonus = streak => 100 + 20 * Math.min(streak - 1, 6);

module.exports = { ACHIEVEMENTS, dailyBonus };
