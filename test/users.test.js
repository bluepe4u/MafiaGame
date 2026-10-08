'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { UserStore, imageType } = require('../src/users');

// every registration needs an invite: make a fresh single-use one
const reg = (store, username, password) => store.register(username, password, store.createInvite(null));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mafia-users-'));
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);

test('register, log in, sessions, and persistence across restarts', () => {
  const dir = tmp();
  const store = new UserStore(dir);
  const { user, token } = reg(store, '  Вася  Пупкин ', 'pass');
  assert.strictEqual(user.username, 'Вася Пупкин');
  assert.strictEqual(store.byToken(token).id, user.id);
  assert.throws(() => reg(store, 'вася пупкин', 'x1234'), /err\.usernameTaken/);
  assert.throws(() => reg(store, 'a', 'pass'), /err\.usernameInvalid/);
  assert.throws(() => reg(store, '<script>', 'pass'), /err\.usernameInvalid/);
  assert.throws(() => reg(store, 'Bob', '123'), /err\.passwordShort/);
  assert.throws(() => store.login('Вася Пупкин', 'wrong'), /err\.badLogin/);
  const again = store.login('вася пупкин', 'pass');
  assert.ok(again.token && again.token !== token);
  assert.ok(!JSON.stringify(store.sessions).includes(token), 'tokens are stored hashed');
  store.logout(token);
  assert.strictEqual(store.byToken(token), null);
  store.saveNow();
  const reloaded = new UserStore(dir);
  assert.strictEqual(reloaded.byToken(again.token).username, 'Вася Пупкин');
  assert.ok(!JSON.stringify(reloaded.users).includes('"pass"'), 'no plain-text password');
});

test('too many failed logins are refused for a while', () => {
  const store = new UserStore(tmp());
  reg(store, 'Kay', 'secret');
  for (let i = 0; i < 10; i++) assert.throws(() => store.login('Kay', 'nope'), /err\.badLogin/);
  assert.throws(() => store.login('Kay', 'secret'), /err\.tooManyLogins/);
});

test('changing the password logs out other sessions', () => {
  const store = new UserStore(tmp());
  const { user, token } = reg(store, 'Luca', 'old1');
  assert.throws(() => store.changePassword(user, 'bad', 'new1'), /err\.badPassword/);
  const fresh = store.changePassword(user, 'old1', 'new1');
  assert.strictEqual(store.byToken(token), null);
  assert.strictEqual(store.byToken(fresh).id, user.id);
  assert.ok(store.login('Luca', 'new1').token);
});

test('avatars: only real images, old file replaced', () => {
  const dir = tmp();
  const store = new UserStore(dir);
  const { user } = reg(store, 'Vito', 'pass');
  assert.throws(() => store.setAvatar(user, Buffer.from('<svg onload=alert(1)>')), /err\.avatarType/);
  assert.throws(() => store.setAvatar(user, Buffer.alloc(2 * 1024 * 1024, 0xff)), /err\.avatarTooBig/);
  store.setAvatar(user, PNG);
  const first = user.avatar;
  assert.match(first, /\.png$/);
  store.setAvatar(user, PNG);
  assert.notStrictEqual(user.avatar, first);
  assert.strictEqual(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpg');
  assert.strictEqual(store.publicProfile(user).avatar, `/avatars/${user.avatar}`);
});

test('ratings change likes, dislikes and score', () => {
  const store = new UserStore(tmp());
  const { user } = reg(store, 'Fredo', 'pass');
  store.applyRating(user.id, 0, 1);
  store.applyRating(user.id, 0, -1);
  store.applyRating(user.id, 0, -1);
  store.applyRating(user.id, -1, 1);
  assert.deepStrictEqual(
    { likes: user.likes, dislikes: user.dislikes, score: store.publicProfile(user).score },
    { likes: 2, dislikes: 1, score: 1 },
  );
  assert.strictEqual(store.publicProfile(user).hash, undefined, 'no secrets in the public profile');
});

test('game results add up into profile stats', () => {
  const store = new UserStore(tmp());
  const { user } = reg(store, 'Sonny', 'pass');
  store.recordGame([{ userId: user.id, role: 'mafia', team: 'mafia', won: true, survived: true }, { userId: 'nobody', role: 'cop', team: 'town', won: false, survived: false }]);
  store.recordGame([{ userId: user.id, role: 'cop', team: 'town', won: false, survived: false }]);
  const st = store.publicProfile(user).stats;
  assert.deepStrictEqual(
    { games: st.games, wins: st.wins, survived: st.survived, mafiaGames: st.mafiaGames, mafiaWins: st.mafiaWins, townGames: st.townGames, townWins: st.townWins, roles: st.roles },
    { games: 2, wins: 1, survived: 1, mafiaGames: 1, mafiaWins: 1, townGames: 1, townWins: 0, roles: { mafia: 1, cop: 1 } },
  );
  assert.deepStrictEqual([st.streak, st.bestStreak, st.recent.map(g => g.role)], [0, 1, ['cop', 'mafia']]);
});

test('decency bonus, dislike shield, lowest status, and who disliked whom', () => {
  const store = new UserStore(tmp());
  const dan = reg(store, 'Данил', 'pass').user;
  const a = reg(store, 'Ann', 'pass').user;
  const b = reg(store, 'Bob', 'pass').user;
  store.applyRating(dan.id, 0, -1, a.id);
  store.applyRating(dan.id, 0, -1, b.id);
  store.applyRating(dan.id, -1, 1, b.id); // B changed their mind
  assert.deepStrictEqual(store.dislikedBy(dan.id), ['Ann']);
  store.setKarma(dan, { dislikeShield: true, bonus: 5 });
  const p = store.publicProfile(dan);
  assert.deepStrictEqual([p.likes, p.dislikes, p.score], [2, 1, 6], 'each dislike adds a like; base +5');
  store.applyRating(a.id, 0, 1, b.id);
  store.setKarma(a, { lowest: true });
  assert.strictEqual(store.publicProfile(a).score, -10);
});

test('items: gift, equip, take back; reactions unlocked; unknown items refused', () => {
  const store = new UserStore(tmp());
  const u = reg(store, 'Kay', 'pass').user;
  assert.throws(() => store.gift(u, 'hat.nope'), /err\.invalidTarget/);
  assert.throws(() => store.equip(u, 'hat', 'hat.crown'), /err\.invalidTarget/, 'must own it first');
  store.gift(u, 'hat.crown');
  store.gift(u, 'react.knife');
  store.equip(u, 'hat', 'hat.crown');
  assert.throws(() => store.equip(u, 'frame', 'hat.crown'), /err\.invalidTarget/, 'wrong slot');
  let p = store.publicProfile(u);
  assert.deepStrictEqual(p.equipped, { hat: 'hat.crown' });
  assert.deepStrictEqual(p.reactions, ['🔪']);
  assert.deepStrictEqual(p.gifts, ['hat.crown', 'react.knife']);
  store.giftsSeen(u);
  store.takeBack(u, 'hat.crown');
  p = store.publicProfile(u);
  assert.deepStrictEqual([p.equipped, p.inventory, p.gifts], [{}, ['react.knife'], []]);
});

test('detailed game numbers add up; old stats without them still load', () => {
  const store = new UserStore(tmp());
  const { user } = reg(store, 'Luca', 'pass');
  user.stats = { games: 3, wins: 2, survived: 1, mafiaGames: 1, mafiaWins: 1, townGames: 2, townWins: 1, roles: { mafia: 1, citizen: 2 } };
  store.recordGame([{ userId: user.id, role: 'citizen', team: 'town', won: true, survived: true, votes: 2, votesOnMafia: 1, votesMatched: 2, ballots: 3, decisive: 1, mafiaVotedOut: 1, kills: 0, saves: 0, copHits: 0, players: 8 }]);
  store.recordGame([{ userId: user.id, role: 'mafia', team: 'mafia', won: true, survived: false, votes: 1, votesOnMafia: 0, votesMatched: 0, ballots: 1, decisive: 0, mafiaVotedOut: 0, kills: 2, saves: 0, copHits: 0, players: 8 }]);
  const st = store.publicProfile(user).stats;
  assert.deepStrictEqual(
    [st.games, st.detailedGames, st.votes, st.townVotes, st.votesOnMafia, st.ballots, st.decisive, st.mafiaVotedOut, st.kills, st.streak, st.roleWins],
    [5, 2, 3, 2, 1, 4, 1, 1, 2, 2, { citizen: 1, mafia: 1 }],
  );
});

test('Monopoly results add up into their own stats', () => {
  const store = new UserStore(tmp());
  const { user } = reg(store, 'Tessio', 'pass');
  const base = { userId: user.id, players: 4, rentCollected: 300, rentPaid: 100, bought: 5, housesBuilt: 4, hotelsBuilt: 1, auctionsWon: 1, trades: 2, jailed: 1, doubles: 3, passedGo: 6, cardsDrawn: 4, rounds: 20, peakNetWorth: 3000 };
  store.recordMonoGame([{ ...base, won: true, place: 1, bankrupt: false, netWorth: 2500, topGroup: 'orange' }]);
  store.recordMonoGame([{ ...base, won: false, place: 3, bankrupt: true, netWorth: 0, topGroup: 'orange' }]);
  const m = store.publicProfile(user).monoStats;
  assert.deepStrictEqual([m.games, m.wins, m.bankruptcies, m.placeSum, m.rentCollected, m.hotelsBuilt, m.bestNetWorth, m.groups, m.streak, m.bestStreak],
    [2, 1, 1, 4, 600, 2, 2500, { orange: 2 }, 0, 1]);
  assert.strictEqual(store.publicProfile(user).stats.games, 0, 'Mafia stats are separate');
});

test('admin fixes: rename (unique names) and a temporary password that logs out everywhere', () => {
  const store = new UserStore(tmp());
  const { user, token } = reg(store, 'Dima', 'pass');
  reg(store, 'Lena', 'pass');
  assert.throws(() => store.rename(user, 'lena'), /err\.usernameTaken/);
  store.rename(user, ' Дима  К ');
  assert.strictEqual(user.username, 'Дима К');
  const temp = store.resetPassword(user);
  assert.match(temp, /^[a-z2-9]{8}$/);
  assert.strictEqual(store.byToken(token), null);
  assert.throws(() => store.login('Дима К', 'pass'), /err\.badLogin/);
  assert.ok(store.login('дима к', temp).token);
});

test('invites: required, single or multi use, admin bootstrap only on an empty site', () => {
  const dir = tmp();
  const store = new UserStore(dir);
  assert.throws(() => store.register('Ann', 'pass'), /err\.inviteRequired/);
  assert.throws(() => store.register('Ann', 'pass', 'NOPE'), /err\.inviteInvalid/);
  const boot = store.bootstrapInvite(dir);
  assert.strictEqual(fs.readFileSync(boot.file, 'utf8').trim(), boot.code);
  const { user: admin } = store.register('Данил', 'pass', boot.code.toLowerCase());
  assert.strictEqual(admin.admin, true);
  assert.throws(() => store.register('Bob', 'pass', boot.code), /err\.inviteInvalid/);
  assert.strictEqual(store.bootstrapInvite(dir), null);
  const code = store.createInvite(admin.id, { maxUses: 2, tableId: 'T1' });
  const r = store.register('Bob', 'pass', code);
  assert.strictEqual(r.invite.tableId, 'T1');
  assert.ok(!r.user.admin);
  store.register('Cid', 'pass', code);
  assert.throws(() => store.register('Dan', 'pass', code), /err\.inviteInvalid/);
  assert.deepStrictEqual(store.inviteList().find(i => i.code === code).usedBy, ['Bob', 'Cid']);
  store.saveNow();
  assert.ok(new UserStore(dir).invites[code]);
  store.revokeInvite(code);
  assert.ok(!store.invites[code]);
});

test('recovery code: shown once at registration, resets the password, then rotates', () => {
  const store = new UserStore(tmp());
  const { user, token, recoveryCode } = reg(store, 'Ann', 'pass');
  assert.match(recoveryCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.throws(() => store.recover('Ann', 'AAAA-BBBB-CCCC', 'newpass'), /err\.badRecovery/);
  const r = store.recover('ann', recoveryCode.toLowerCase().replace(/-/g, ' '), 'newpass');
  assert.strictEqual(store.byToken(token), null);
  assert.ok(store.login('Ann', 'newpass').token);
  assert.throws(() => store.recover('Ann', recoveryCode, 'again'), /err\.badRecovery/);
  assert.ok(store.recover('Ann', r.recoveryCode, 'again'));
  assert.strictEqual(store.publicProfile(user).hasRecovery, true);
});

test('personal touches: admin titles and badges, your own birthday (birthday hat) and theme', () => {
  const store = new UserStore(tmp());
  const { user } = reg(store, 'Ann', 'pass');
  store.setTitle(user, '  Король   блефа ');
  store.addBadge(user, '🐍', 'Самая хитрая', 'admin');
  assert.throws(() => store.addBadge(user, '', 'x'), /err\.badgeRequired/);
  const d = new Date();
  const today = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  store.setPersonal(user, { birthday: today, theme: 'ocean' });
  assert.throws(() => store.setPersonal(user, { birthday: '13-40' }), /err\.birthdayInvalid/);
  assert.throws(() => store.setPersonal(user, { theme: 'neon-pink' }), /err\.invalidTarget/);
  const p = store.publicProfile(user);
  assert.strictEqual(p.title, 'Король блефа');
  assert.strictEqual(p.badges[0].label, 'Самая хитрая');
  assert.strictEqual(p.birthdayToday, true);
  assert.strictEqual(p.equipped.hat, 'hat.birthday');
  assert.strictEqual(p.theme, 'ocean');
  store.removeBadge(user, p.badges[0].id);
  store.setPersonal(user, { birthday: null });
  assert.strictEqual(store.publicProfile(user).badges.length, 0);
  assert.strictEqual(store.publicProfile(user).equipped.hat, undefined);
});
