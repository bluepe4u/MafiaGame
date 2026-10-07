'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { UserStore, imageType } = require('../src/users');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mafia-users-'));
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);

test('register, log in, sessions, and persistence across restarts', () => {
  const dir = tmp();
  const store = new UserStore(dir);
  const { user, token } = store.register('  Вася  Пупкин ', 'pass');
  assert.strictEqual(user.username, 'Вася Пупкин');
  assert.strictEqual(store.byToken(token).id, user.id);
  assert.throws(() => store.register('вася пупкин', 'x1234'), /err\.usernameTaken/);
  assert.throws(() => store.register('a', 'pass'), /err\.usernameInvalid/);
  assert.throws(() => store.register('<script>', 'pass'), /err\.usernameInvalid/);
  assert.throws(() => store.register('Bob', '123'), /err\.passwordShort/);
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
  store.register('Kay', 'secret');
  for (let i = 0; i < 10; i++) assert.throws(() => store.login('Kay', 'nope'), /err\.badLogin/);
  assert.throws(() => store.login('Kay', 'secret'), /err\.tooManyLogins/);
});

test('changing the password logs out other sessions', () => {
  const store = new UserStore(tmp());
  const { user, token } = store.register('Luca', 'old1');
  assert.throws(() => store.changePassword(user, 'bad', 'new1'), /err\.badPassword/);
  const fresh = store.changePassword(user, 'old1', 'new1');
  assert.strictEqual(store.byToken(token), null);
  assert.strictEqual(store.byToken(fresh).id, user.id);
  assert.ok(store.login('Luca', 'new1').token);
});

test('avatars: only real images, old file replaced', () => {
  const dir = tmp();
  const store = new UserStore(dir);
  const { user } = store.register('Vito', 'pass');
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
  const { user } = store.register('Fredo', 'pass');
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
