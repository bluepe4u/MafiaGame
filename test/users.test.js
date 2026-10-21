'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { UserStore, imageType } = require('../src/users');

// a new account: a username, a password and an email made from the name
let mailN = 0;
const mail = () => `player${++mailN}@example.com`;
const reg = (store, username, password) => store.register(username, password, null, { email: mail() });
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

test('invites: optional while sign-up is open, single or multi use, admin bootstrap only on an empty site', () => {
  const dir = tmp();
  const store = new UserStore(dir);
  store.setFeatures({ signup: false });
  assert.throws(() => store.register('Ann', 'pass', null, { email: mail() }), /err\.inviteRequired/);
  assert.throws(() => store.register('Ann', 'pass', 'NOPE'), /err\.inviteInvalid/);
  const boot = store.bootstrapInvite(dir);
  assert.strictEqual(fs.readFileSync(boot.file, 'utf8').trim(), boot.code);
  const { user: admin } = store.register('Данил', 'pass', boot.code.toLowerCase());
  assert.strictEqual(admin.admin, true);
  assert.throws(() => store.register('Bob', 'pass', boot.code), /err\.inviteInvalid/);
  assert.strictEqual(store.bootstrapInvite(dir), null);
  const code = store.createInvite(admin.id, { maxUses: 2, tableId: 'T1' });
  const r = store.register('Bob', 'pass', code, { email: mail() });
  assert.strictEqual(r.invite.tableId, 'T1');
  assert.ok(!r.user.admin);
  store.register('Cid', 'pass', code, { email: mail() });
  assert.throws(() => store.register('Dan', 'pass', code, { email: mail() }), /err\.inviteInvalid/);
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

test('site features: defaults (family off), changed by the admin, saved', () => {
  const dir = tmp();
  const store = new UserStore(dir);
  assert.deepStrictEqual(store.features, { family: false, voice: true, transcripts: true, signup: true });
  store.setFeatures({ family: true, voice: false, bogus: true });
  store.saveNow();
  assert.deepStrictEqual(new UserStore(dir).features, { family: true, voice: false, transcripts: true, signup: true });
});

test('site chips: the welcome gift, the daily bonus with its streak, achievements paid once, USDT addresses', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chips-'));
  const store = new UserStore(dir);
  reg(store, 'Ann', 'secret');
  const u = store.byName('Ann');
  assert.strictEqual(store.wallet(u).chips, 500);
  const d = store.claimDaily(u);
  assert.deepStrictEqual(d, { n: 100, streak: 1 });
  assert.strictEqual(store.claimDaily(u), null); // once a day
  assert.strictEqual(store.award(u, 'pk.first'), 200);
  assert.strictEqual(store.award(u, 'pk.first'), 0);
  assert.ok(!store.takeChips(u, 100000, 'test'));
  assert.ok(store.takeChips(u, 100, 'test'));
  assert.strictEqual(u.chips, 700);
  assert.throws(() => store.setUsdt(u, { network: 'trc20', address: '0x123' }), /usdt.address/);
  store.setUsdt(u, { network: 'trc20', address: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE' });
  assert.ok(store.publicProfile(u).usdtSet);
  assert.strictEqual(store.publicProfile(u).usdt, undefined); // the address itself stays private
});

test('email: required for new accounts, unique, login by email, optional for older accounts', () => {
  const dir = tmp();
  const store = new UserStore(dir);
  assert.throws(() => store.register('Ann', 'pass', null, {}), /err\.emailInvalid/);
  assert.throws(() => store.register('Ann', 'pass', null, { email: 'not-an-email' }), /err\.emailInvalid/);
  const { user: ann } = store.register('Ann', 'pass', null, { email: '  Ann@Example.COM ' });
  assert.strictEqual(ann.email, 'ann@example.com');
  assert.strictEqual(ann.emailVerified, false);
  assert.throws(() => store.register('Bob', 'pass', null, { email: 'ANN@example.com' }), /err\.emailTaken/);
  assert.strictEqual(store.login('ann@example.com', 'pass').user.id, ann.id);
  // the public profile never shows it; the owner's own view does
  assert.ok(!('email' in store.publicProfile(ann)));
  assert.strictEqual(store.selfProfile(ann).email, 'ann@example.com');
  // confirming only works for the address the link was sent to
  assert.strictEqual(store.confirmEmail(ann.id, 'old@example.com'), null);
  assert.ok(store.confirmEmail(ann.id, 'ann@example.com').emailVerified);
  // an account from before emails: adds one later with its password, can remove it again
  const { user: old } = store.register('Old', 'pass', null, { email: 'tmp@example.com' });
  delete old.email;
  delete old.emailVerified;
  assert.throws(() => store.setEmail(old, 'old@example.com', 'wrong'), /err\.badPassword/);
  store.setEmail(old, 'old@example.com', 'pass');
  assert.strictEqual(old.email, 'old@example.com');
  assert.strictEqual(old.emailVerified, false);
  store.setEmail(old, '', 'pass');
  assert.ok(!old.email);
  // a reset by email: a new password, the old sessions gone, the email proven
  const { token } = store.login('Ann', 'pass');
  const r = store.resetByEmail(ann.id, 'newpass');
  assert.strictEqual(store.byToken(token), null);
  assert.ok(store.byToken(r.token));
  assert.ok(store.login('Ann', 'newpass').token);
  store.saveNow();
  assert.strictEqual(new UserStore(dir).byEmail('ANN@example.com').id, ann.id);
});

test('database: the old users.json is imported once, as it was', () => {
  const dir = tmp();
  const legacy = { users: { u1: { id: 'u1', username: 'Вася', salt: 's', hash: 'h', likes: 3, dislikes: 1, createdAt: 1 } }, sessions: { abc: 'u1' }, invites: {}, ratingLog: [{ from: 'u1', to: 'u1', value: 1, at: 1 }], features: { family: true } };
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify(legacy));
  const store = new UserStore(dir);
  // the accounts from before keep everything, and get the private USDT tables (granted once)
  assert.deepStrictEqual(store.users, { u1: { ...legacy.users.u1, usdtAccess: true } });
  assert.deepStrictEqual(store.sessions, legacy.sessions);
  assert.strictEqual(store.features.family, true);
  assert.strictEqual(store.features.signup, true);
  assert.ok(!fs.existsSync(path.join(dir, 'users.json')));
  assert.ok(fs.existsSync(path.join(dir, 'users.json.migrated')));
  store.users.u1.likes = 4;
  const { user: fresh } = store.register('Новый', 'pass', null, { email: 'new@example.com' });
  assert.ok(!fresh.usdtAccess);
  store.saveNow();
  assert.strictEqual(new UserStore(dir).users.u1.likes, 4);
});

test('guests: a name is enough; saved later with everything kept; unsaved ones removed after a month', () => {
  const dir = tmp();
  const store = new UserStore(dir);
  const { user: ann } = store.register('Аня', 'pass', null, { email: mail() });
  const g = store.createGuest('  Аня ');
  assert.strictEqual(g.user.username, 'Аня 2'); // the name is taken: a number is added
  assert.ok(store.byToken(g.token));
  assert.throws(() => store.createGuest('x'), /usernameInvalid/);
  // no password: can't log in, isn't rated
  assert.throws(() => store.login('Аня 2', ''), /badLogin/);
  assert.strictEqual(store.publicProfile(g.user).score, null);
  assert.strictEqual(store.selfProfile(g.user).guest, true);
  // plays a game, then saves the account: the stats and chips stay
  store.claimDaily(g.user);
  const chips = store.wallet(g.user).chips;
  g.user.stats = { games: 3, wins: 1 };
  assert.throws(() => store.saveGuest(g.user, { username: 'Аня', email: mail(), password: 'pass' }), /usernameTaken/);
  const { user, recoveryCode } = store.saveGuest(g.user, { username: 'Аня Ч', email: 'anya2@example.com', password: 'secret' });
  assert.ok(recoveryCode);
  assert.ok(!user.guest);
  assert.strictEqual(user.stats.games, 3);
  assert.strictEqual(store.wallet(user).chips, chips);
  assert.ok(store.login('anya2@example.com', 'secret').token);
  assert.notStrictEqual(store.publicProfile(user).score, null);
  // a guest nobody saved, quiet for a month, is removed (unless still in a room or at a table)
  const old = store.createGuest('Гость').user;
  const keep = store.createGuest('Гость').user;
  const later = Date.now() + 31 * 24 * 60 * 60 * 1000;
  assert.deepStrictEqual(store.pruneGuests(new Set([keep.id]), later), [old.id]);
  assert.ok(store.users[keep.id] && store.users[ann.id] && store.users[user.id]);
});
