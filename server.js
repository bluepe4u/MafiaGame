'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const { Room, GameError } = require('./src/game');
const { UserStore } = require('./src/users');
const { ITEMS } = require('./src/items');
const { attachMonopoly } = require('./src/monopoly/server');
const { attachSpyfall } = require('./src/spyfall/server');
const { attachCitadels } = require('./src/citadels/server');
const { attachPoker } = require('./src/poker/server');
const { limitSocket } = require('./src/ratelimit');
const { TableStore } = require('./src/tables');
const { Archive } = require('./src/archive');
const { Pledges } = require('./src/pledges');
const { createVoiceHub, iceServers } = require('./src/voice');
const insights = require('./src/insights');
const { SttQueue } = require('./src/stt');
const { Stats } = require('./src/stats');
const { roomStore } = require('./src/db');
const { createKv, MemoryKv, limit } = require('./src/kv');
const { createMailer } = require('./src/mail');
const blogLib = require('./src/blog');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOM_IDLE_MS = 60 * 60 * 1000;
// rooms are saved here so a restart or update doesn't end games in progress
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

const users = new UserStore(DATA_DIR);
const tables = new TableStore(DATA_DIR);
tables.prune(Object.keys(users.users));
const archive = new Archive(DATA_DIR);
archive.prune(Object.keys(users.users));
const pledges = new Pledges(DATA_DIR);
const stats = new Stats(DATA_DIR);
const blog = new blogLib.BlogStore(DATA_DIR);
blog.seedFrom(path.join(__dirname, 'content', 'blog'));
// rate limits and one-time email links: Redis when REDIS_URL is set (connected at start), else memory
let kv = new MemoryKv();
const mailer = createMailer();
const RESET_TTL = 30 * 60; // seconds
const VERIFY_TTL = 3 * 24 * 60 * 60;
// a fresh site: the first account is created with a one-time admin invite left in the data dir
const boot = users.bootstrapInvite(DATA_DIR);
if (boot) console.log(`No accounts yet. Admin invite code is in ${boot.file}`);
else fs.rm(path.join(DATA_DIR, 'admin-invite.txt'), { force: true }, () => {});

const app = express();
app.set('trust proxy', 'loopback'); // behind Caddy: use its X-Forwarded-Proto/Host for invite links
app.disable('x-powered-by');

// Standard browser protections: only our own scripts run, nobody can frame the site, no MIME
// sniffing, HTTPS remembered. Inline styles stay allowed (the pages set CSS variables inline).
app.use((req, res, next) => {
  const host = /^[\w.:-]+$/.test(req.get('host') || '') ? req.get('host') : '';
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self'",
      "img-src 'self' data: blob:",
      `connect-src 'self'${host ? ` wss://${host} ws://${host}` : ''}`,
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(self), geolocation=(), payment=()', // the mic: voice chat on our own pages only
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});
// visit counts for the pages people open (see src/stats.js: no cookies, no tracking script)
const PAGES = new Set(['/', '/poker/', '/tycoon/', '/spy/', '/kingdoms/', '/terms/', '/privacy/', '/poker/fair.html']);
app.use((req, res, next) => {
  if (req.method === 'GET' && (PAGES.has(req.path) || /^\/blog\/([\w-]+\/)?$/.test(req.path))) {
    stats.view({ page: req.path, ip: req.ip, ua: req.get('user-agent'), referrer: req.get('referer'), host: req.hostname });
  }
  next();
});
app.get('/favicon.ico', (_req, res) => res.type('image/png').set('Cache-Control', 'public, max-age=604800').sendFile(path.join(__dirname, 'public', 'icon-48.png')));
// the games' old addresses (before they got their own names): old invite links keep working
const MOVED = { monopoly: 'tycoon', citadels: 'kingdoms', spyfall: 'spy' };
app.get(/^\/(monopoly|citadels|spyfall)(\/.*)?$/, (req, res) => {
  const [, from, rest] = req.path.match(/^\/(\w+)(\/.*)?$/);
  const query = req.originalUrl.slice(req.path.length);
  res.redirect(301, `/${MOVED[from]}${rest || '/'}${query}`);
});
// browsers re-check the page's files on every load (cheap: unchanged files answer 304), so
// nobody keeps running an old version after an update
// fonts never change under the same name: cached for a month
app.use('/fonts', express.static(path.join(__dirname, 'public', 'fonts'), { maxAge: '30d' }));
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: res => res.setHeader('Cache-Control', 'no-cache') }));
app.use('/avatars', express.static(users.avatarDir, { maxAge: '30d', immutable: true, index: false }));
app.get('/health', (_req, res) => res.send('ok'));

// ---------- accounts API ----------
// Handlers throw GameError for anything the user should see; the client translates the key.
const api = fn => async (req, res) => {
  try {
    res.json({ ok: true, ...(await fn(req)) });
  } catch (e) {
    if (!(e instanceof GameError)) console.error(e);
    const error = e instanceof GameError ? { key: e.key, params: e.params } : { key: 'err.server', params: {} };
    res.status(e instanceof GameError ? 400 : 500).json({ ok: false, error });
  }
};
// links in emails point here (PUBLIC_URL on the server, so a forged Host header can't redirect them)
const siteUrl = req => process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
const langOf = req => (req.body?.lang === 'ru' ? 'ru' : 'en');
const throttle = async (key, max, windowSec) => { if (!(await limit(kv, key, max, windowSec))) throw new GameError('err.slowDown'); };
// a confirmation link for the user's current email
async function sendVerify(req, user) {
  if (!user.email) return;
  const token = crypto.randomBytes(24).toString('hex');
  await kv.set(`verify:${token}`, JSON.stringify({ id: user.id, email: user.email }), VERIFY_TTL);
  await mailer.send('verify', user.email, langOf(req), { name: user.username, link: `${siteUrl(req)}/verify?token=${token}` })
    .catch(e => console.error('Sending the confirmation email failed:', e.message));
}
const bearer = req => (req.get('authorization') || '').replace(/^Bearer /, '');
const currentUser = req => {
  const user = users.byToken(bearer(req));
  if (!user) throw new GameError('err.loginRequired');
  return user;
};

// a picture for a blog article (bigger than the usual request limit)
app.post('/api/admin/blog/image', express.json({ limit: '6mb' }), api(req => {
  adminUser(req);
  const m = /^data:image\/[a-z]+;base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.image || ''));
  if (!m) throw new GameError('err.avatarType');
  return { url: blog.addImage(Buffer.from(m[1], 'base64')) };
}));
app.use('/api', express.json({ limit: '2mb' }));
// script errors from the pages (common.js reports them), a few per minute per address
const errorBudget = new Map(); // ip -> { n, until }
app.post('/api/err', (req, res) => {
  const now = Date.now();
  const b = errorBudget.get(req.ip);
  if (!b || b.until < now) errorBudget.set(req.ip, { n: 1, until: now + 60000 });
  else if (++b.n > 10) return res.status(429).end();
  if (errorBudget.size > 5000) errorBudget.clear();
  const body = req.body || {};
  const e = stats.error({ msg: body.msg, src: body.src, line: body.line, page: body.page, ua: req.get('user-agent') });
  console.warn(`client error on ${e.page}: ${e.msg} (${e.src}:${e.line})`);
  res.status(204).end();
});
app.post('/api/register', api(async req => {
  // a hidden field people never fill in: bots do
  if (req.body.website) throw new GameError('err.slowDown');
  await throttle(`register:${req.ip}`, 5, 3600);
  const { user, token, invite, recoveryCode } = users.register(req.body.username, req.body.password, req.body.invite, { email: req.body.email });
  if (invite?.tableId) { try { tables.join(invite.tableId, user); } catch {} }
  if (invite?.admin) fs.rm(path.join(DATA_DIR, 'admin-invite.txt'), { force: true }, () => {});
  users.saveNow();
  await sendVerify(req, user);
  return { token, user: users.selfProfile(user), recoveryCode };
}));
// playing without an account: a name is enough; the guest can save the account after a game
app.post('/api/guest', api(async req => {
  if (req.body.website) throw new GameError('err.slowDown');
  await throttle(`guest:${req.ip}`, 20, 3600);
  const { user, token } = users.createGuest(req.body.name);
  return { token, user: users.selfProfile(user) };
}));
app.post('/api/guest/save', api(async req => {
  const user = currentUser(req);
  await throttle(`register:${req.ip}`, 5, 3600);
  const { recoveryCode } = users.saveGuest(user, { username: req.body.username, email: req.body.email, password: req.body.password });
  users.saveNow();
  refreshUser(user.id);
  await sendVerify(req, user);
  return { user: users.selfProfile(user), recoveryCode };
}));
// the link from the confirmation email
app.get('/verify', async (req, res) => {
  const raw = /^[0-9a-f]{48}$/.test(String(req.query.token || '')) ? await kv.take(`verify:${req.query.token}`) : null;
  const data = raw ? JSON.parse(raw) : null;
  const ok = !!(data && users.confirmEmail(data.id, data.email));
  if (ok) refreshUser(data.id);
  res.redirect(302, `/?verified=${ok ? 1 : 0}`);
});
// add, change or remove the email (needs the password); a new address gets a confirmation link
app.post('/api/email', api(async req => {
  const user = currentUser(req);
  await throttle(`email:${user.id}`, 10, 3600);
  const before = user.email;
  users.setEmail(user, req.body.email, req.body.password);
  if (user.email && user.email !== before) await sendVerify(req, user);
  return { user: users.selfProfile(user) };
}));
app.post('/api/email/resend', api(async req => {
  const user = currentUser(req);
  if (!user.email || user.emailVerified) throw new GameError('err.invalidTarget');
  await throttle(`resend:${user.id}`, 3, 3600);
  await sendVerify(req, user);
  return {};
}));
// forgot the password: a one-time link to the account's email. The answer is the same whether or
// not such an account exists, so nobody can find out who has an account here.
app.post('/api/forgot', api(async req => {
  const email = String(req.body.email || '').trim().toLowerCase();
  await throttle(`forgot:${req.ip}`, 5, 3600);
  await throttle(`forgot:${email}`, 3, 3600);
  const user = users.byEmail(email) || users.byName(email);
  if (user && user.email) {
    const token = crypto.randomBytes(24).toString('hex');
    await kv.set(`reset:${token}`, user.id, RESET_TTL);
    await mailer.send('reset', user.email, langOf(req), { name: user.username, link: `${siteUrl(req)}/?reset=${token}` })
      .catch(e => console.error('Sending the reset email failed:', e.message));
  }
  return { sent: true };
}));
app.post('/api/reset', api(async req => {
  const tokenIn = String(req.body.token || '');
  await throttle(`reset:${req.ip}`, 10, 3600);
  const userId = /^[0-9a-f]{48}$/.test(tokenIn) ? await kv.get(`reset:${tokenIn}`) : null;
  if (!userId) throw new GameError('err.badResetLink');
  const { user, token } = users.resetByEmail(userId, req.body.password);
  await kv.del(`reset:${tokenIn}`);
  return { token, user: users.selfProfile(user) };
}));
// forgot the password: username + recovery code sets a new one (and issues a fresh code)
app.post('/api/recover', api(req => {
  const { user, token, recoveryCode } = users.recover(req.body.username, req.body.code, req.body.password);
  return { token, user: users.selfProfile(user), recoveryCode };
}));
app.post('/api/recovery', api(req => ({ recoveryCode: users.newRecoveryCode(currentUser(req)) })));
app.post('/api/login', api(async req => {
  await throttle(`login:${req.ip}`, 30, 600);
  const { user, token } = users.login(req.body.username, req.body.password);
  return { token, user: users.selfProfile(user) };
}));
app.post('/api/logout', api(req => { users.logout(bearer(req)); return {}; }));
app.get('/api/me', api(req => {
  const user = currentUser(req);
  // coming to the site: the daily bonus in site chips (and the welcome gift on the first visit)
  const daily = users.claimDaily(user);
  users.seen(user);
  return { user: users.selfProfile(user), daily, mail: mailer.enabled };
}));
app.post('/api/password', api(req => {
  const token = users.changePassword(currentUser(req), req.body.oldPassword, req.body.newPassword);
  return { token };
}));
app.get('/api/items', (_req, res) => res.json({ ok: true, items: ITEMS }));
// leaderboard and player pages: for logged-in players only
app.get('/api/leaderboard', api(req => {
  currentUser(req);
  return { users: Object.values(users.users).filter(u => !u.guest).map(u => users.publicProfile(u)) };
}));
app.get('/api/player/:id', api(req => {
  currentUser(req);
  const u = users.users[req.params.id];
  if (!u) throw new GameError('err.invalidTarget');
  return { user: users.publicProfile(u) };
}));
app.post('/api/equip', api(req => {
  const user = currentUser(req);
  users.equip(user, req.body.slot, req.body.itemId || null);
  refreshUser(user.id);
  return { user: users.selfProfile(user) };
}));
app.post('/api/gifts/seen', api(req => { users.giftsSeen(currentUser(req)); return {}; }));
// rooms this account is still in, in any game: the "back to my game" button
app.get('/api/active', api(req => {
  const user = currentUser(req);
  const mine = [...rooms.values()].filter(r => r.byUser(user.id)).map(roomSummary).concat(mono.userRooms(user.id), spy.userRooms(user.id), cit.userRooms(user.id), poker.userRooms(user.id));
  return { rooms: mine.filter(r => r.phase !== 'ended') };
}));

// ---------- admin: decency and gifts ----------
const adminUser = req => {
  const user = currentUser(req);
  if (!user.admin) throw new GameError('err.adminOnly');
  return user;
};
const targetUser = req => {
  const u = users.users[req.body.userId];
  if (!u) throw new GameError('err.invalidTarget');
  return u;
};
app.get('/api/admin/stats', api(req => {
  adminUser(req);
  return { stats: stats.summary(Math.min(90, Math.max(1, Number(req.query.days) || 14))) };
}));
app.get('/api/admin/users', api(req => {
  adminUser(req);
  return { users: Object.values(users.users).map(u => users.adminView(u)).sort((a, b) => a.username.localeCompare(b.username)) };
}));
// USDT poker tables: private, only for the accounts the admin lets in
app.post('/api/admin/usdt', api(req => {
  adminUser(req);
  const u = targetUser(req);
  users.setUsdtAccess(u, req.body.on);
  refreshUser(u.id);
  return { user: users.adminView(u) };
}));
app.post('/api/admin/karma', api(req => {
  adminUser(req);
  const u = targetUser(req);
  users.setKarma(u, req.body);
  refreshUser(u.id);
  return { user: users.adminView(u) };
}));
app.post('/api/admin/gift', api(req => {
  adminUser(req);
  const u = targetUser(req);
  users.gift(u, req.body.itemId);
  refreshUser(u.id);
  // pop the present open right away if they're online
  for (const sock of allSockets()) if (sock.data.userId === u.id) sock.emit('gift', { itemId: req.body.itemId });
  return { user: users.adminView(u) };
}));
// site-wide feature switches (family mode, voice chat, transcripts)
app.get('/api/features', (_req, res) => res.json({ ok: true, features: users.features }));
app.post('/api/admin/features', api(req => {
  adminUser(req);
  const f = users.setFeatures(req.body);
  for (const room of rooms.values()) {
    if (!f.family) room.settings.family = false;
    if (!f.voice || !f.transcripts) room.settings.transcripts = false;
    if (!f.voice) { room.settings.voice = false; voiceHub.closeRoom(room.code); }
    room.touch();
  }
  mono.applyFeatures(f);
  spy.applyFeatures(f);
  cit.applyFeatures(f);
  poker.applyFeatures(f);
  return { features: f };
}));

// invite codes: registration needs one; an invite can also seat the newcomer at a table
app.get('/api/admin/invites', api(req => {
  adminUser(req);
  return { invites: users.inviteList().map(i => ({ ...i, table: i.tableId ? tables.tables[i.tableId]?.name || null : null })) };
}));
app.post('/api/admin/invites', api(req => {
  const admin = adminUser(req);
  const tableId = req.body.tableId ? tables.get(req.body.tableId).id : null;
  return { code: users.createInvite(admin.id, { maxUses: req.body.maxUses, tableId }) };
}));
app.post('/api/admin/invites/revoke', api(req => {
  adminUser(req);
  users.revokeInvite(String(req.body.code || ''));
  return {};
}));

// account fixes: a new name, a temporary password (shown once to the admin)
app.post('/api/admin/rename', api(req => {
  adminUser(req);
  const u = targetUser(req);
  users.rename(u, req.body.username);
  refreshUser(u.id);
  return { user: users.adminView(u) };
}));
app.post('/api/admin/resetPassword', api(req => {
  adminUser(req);
  const u = targetUser(req);
  const password = users.resetPassword(u);
  // their open pages lose the login: send them back to the login form
  for (const sock of allSockets()) if (sock.data.userId === u.id) sock.emit('loggedOut');
  return { password, user: users.adminView(u) };
}));
// who's online right now (in any game) and every room on the server
app.get('/api/admin/live', api(req => {
  adminUser(req);
  const online = {};
  for (const sock of allSockets()) {
    const u = users.users[sock.data.userId];
    if (!u) continue;
    const o = (online[u.id] ||= { id: u.id, username: u.username, avatar: u.avatar ? `/avatars/${u.avatar}` : null, where: [] });
    const game = { '/monopoly': 'mono', '/spyfall': 'spy', '/citadels': 'cit', '/poker': 'poker' }[sock.nsp.name] || 'mafia';
    const where = sock.data.roomCode ? `${game}:${sock.data.roomCode}` : game;
    if (!o.where.includes(where)) o.where.push(where);
  }
  return {
    online: Object.values(online).sort((a, b) => a.username.localeCompare(b.username)),
    rooms: [...rooms.values()].map(roomSummary).concat(mono.list(), spy.list(), cit.list(), poker.list()).sort((a, b) => b.lastActivity - a.lastActivity),
  };
}));
app.post('/api/admin/endRoom', api(req => {
  adminUser(req);
  const code = String(req.body.code || '');
  const other = { mono, spy, cit, poker }[req.body.game];
  if (other) { if (!other.end(code)) throw new GameError('err.roomNotFound'); return {}; }
  const room = rooms.get(code);
  if (!room) throw new GameError('err.roomNotFound');
  for (const s of io.sockets.adapter.rooms.get(code) || []) {
    const sock = io.sockets.sockets.get(s);
    if (!sock) continue;
    voiceHub.leave(sock);
    sock.data.playerId = null;
    sock.leave(code);
    sock.emit('kicked', { closed: true });
  }
  room.dispose();
  rooms.delete(code);
  scheduleSave();
  return {};
}));
app.post('/api/admin/take', api(req => {
  adminUser(req);
  const u = targetUser(req);
  users.takeBack(u, req.body.itemId);
  refreshUser(u.id);
  return { user: users.adminView(u) };
}));

// avatar arrives as a data URL, already cropped and shrunk in the browser
app.post('/api/avatar', api(req => {
  const user = currentUser(req);
  const m = /^data:image\/[a-z]+;base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.image || ''));
  if (!m) throw new GameError('err.avatarType');
  users.setAvatar(user, Buffer.from(m[1], 'base64'));
  refreshUser(user.id);
  return { user: users.selfProfile(user) };
}));

// ---------- tables: a permanent space for a group, with a game picker ----------
const GAMES = ['mafia', 'mono', 'spy', 'cit', 'poker'];
const otherGame = game => ({ mono, spy, cit, poker })[game];
const gameInfo = (game, code) => (otherGame(game) ? otherGame(game).info(code) : rooms.has(code) ? roomSummary(rooms.get(code)) : null);
function tableView(table, user) {
  const online = new Set(allSockets().map(s => s.data.userId));
  const current = table.current && gameInfo(table.current.game, table.current.code);
  const live = !!(current && current.phase !== 'ended');
  return {
    id: table.id,
    name: table.name,
    public: !!table.public,
    isOwner: table.ownerId === user.id,
    ownerId: table.ownerId,
    members: table.members.map(id => users.users[id]).filter(Boolean).map(u => ({
      id: u.id, username: u.username, avatar: u.avatar ? `/avatars/${u.avatar}` : null,
      equipped: users.publicProfile(u).equipped, online: online.has(u.id),
    })),
    current: current ? { ...current, by: users.users[table.current.by]?.username || null } : null,
    canStart: table.ownerId === user.id || !!user.admin || !live,
    games: table.history.length,
  };
}
const tableAction = fn => api(req => {
  const user = currentUser(req);
  const table = fn(user, req.body || {});
  return table ? { table: tableView(table, user) } : {};
});
app.get('/api/tables', api(req => {
  const user = currentUser(req);
  return { tables: tables.mine(user.id).map(tb => tableView(tb, user)) };
}));
app.post('/api/tables/create', tableAction((user, b) => { if (user.guest) throw new GameError('err.guestAccount'); return tables.create(user, b.name); }));
app.post('/api/tables/join', tableAction((user, b) => tables.join(b.id, user)));
app.post('/api/tables/leave', tableAction((user, b) => { tables.leave(b.id, user); }));
app.post('/api/tables/rename', tableAction((user, b) => tables.rename(b.id, user, b.name)));
app.post('/api/tables/kick', tableAction((user, b) => tables.kick(b.id, user, b.userId)));
app.post('/api/tables/visibility', tableAction((user, b) => tables.setPublic(b.id, user, b.public)));
// public tables to find and join: the ones with people online and a game on first
app.get('/api/tables/public', api(req => {
  const user = currentUser(req);
  const online = new Set(allSockets().map(s => s.data.userId));
  const list = tables.publicList().filter(tb => !tb.members.includes(user.id)).map(tb => {
    const current = tb.current && gameInfo(tb.current.game, tb.current.code);
    const live = current && current.phase !== 'ended' ? { game: tb.current.game, phase: current.phase, players: current.players.length } : null;
    return { id: tb.id, name: tb.name, members: tb.members.length, online: tb.members.filter(m => online.has(m)).length, owner: users.users[tb.ownerId]?.username || null, live };
  });
  list.sort((a, b) => (!!b.live - !!a.live) || b.online - a.online || b.members - a.members);
  return { tables: list.slice(0, 30) };
}));
// what an invite link shows before joining: the game, who's there (no account needed)
app.get('/api/invite', (req, res) => {
  const code = String(req.query.code || '').toUpperCase();
  const info = /^[A-Z]{4}$/.test(code) && GAMES.includes(req.query.game) ? gameInfo(req.query.game, code) : null;
  if (!info || info.private || info.phase === 'ended') return res.json({ ok: true, room: null });
  res.json({ ok: true, room: { phase: info.phase, players: info.players.map(p => p.name).slice(0, 12) } });
});
// the next game: a fresh room, and everyone at the table is called into it
app.post('/api/tables/start', api(req => {
  const user = currentUser(req);
  const table = tables.get(req.body.id);
  if (!table.members.includes(user.id)) throw new GameError('err.tableNotFound');
  const game = req.body.game;
  if (!GAMES.includes(game)) throw new GameError('err.invalidTarget');
  if (!tableView(table, user).canStart) throw new GameError('err.tableBusy');
  const saved = tables.settingsFor(table.id, game);
  let code;
  if (otherGame(game)) code = otherGame(game).create(table.id, saved);
  else {
    const room = createRoom();
    room.tableId = table.id;
    if (saved) for (const k of Object.keys(room.settings)) if (k in saved) room.settings[k] = saved[k];
    scheduleSave();
    code = room.code;
  }
  tables.setCurrent(table, game, code, user.id);
  const call = { tableId: table.id, table: table.name, game, code, by: user.username, byId: user.id };
  for (const sock of allSockets()) if (table.members.includes(sock.data.userId)) sock.emit('tableGame', call);
  return call;
}));

// ---------- voice transcripts: clips -> text -> round notes -> the game's analysis ----------
const AI_LANG = process.env.INSIGHTS_LANG || 'ru';
const stt = new SttQueue({
  onText: (job, text) => {
    const room = rooms.get(job.code);
    if (!room || room.gameId !== job.gameId) return;
    try { room.addTranscript(job.pid, text, { phase: job.phase, day: job.day }); } catch {}
  },
});
// wait until a room's clips (for one day, or all) are transcribed, at most two minutes
async function drained(code, day) {
  for (let i = 0; i < 60 && stt.pending(code, day); i++) await new Promise(r => setTimeout(r, 2000));
}
const roundJobs = new Map(); // room code -> the latest round note in progress
function noteRound(room, day) {
  if (!room.settings.transcripts || !insights.enabled()) return;
  const { code, gameId } = room;
  const job = (roundJobs.get(code) || Promise.resolve()).then(async () => {
    await drained(code, day);
    if (room.gameId !== gameId) return;
    const input = room.roundInput(day);
    if (!input.lines.length) return; // nothing was said (or transcribed) that day
    const note = await insights.analyzeRound(input, AI_LANG);
    if (note) room.addRoundNote(gameId, day, note);
  }).catch(e => console.error('Round note failed:', e.message));
  roundJobs.set(code, job);
}
// after a game: wait for the last clips and round notes, then the AI's read of the whole game
async function finishMafiaGame(game, record) {
  const room = rooms.get(record.code);
  if (!room || !room.settings.transcripts) return;
  await drained(record.code);
  await roundJobs.get(record.code);
  if (room.gameId === record.gameId) {
    game.transcript = room.transcript.map(({ name, text, at, phase, day, channel }) => ({ name, text, at, phase, day, channel })).slice(-1500);
    game.roundNotes = room.roundNotes;
    archive.save();
  }
  if (!insights.enabled() || game.transcript.length < 3) return;
  const ins = await insights.analyzeMafia(game, AI_LANG);
  if (!ins) return;
  archive.setInsights(game.id, ins);
  rooms.get(record.code)?.setInsights(record.gameId, ins);
}
// one push-to-talk clip from a player's own microphone (audio is dropped once transcribed)
app.post('/api/voice/clip', express.raw({ type: () => true, limit: '3mb' }), api(req => {
  const user = currentUser(req);
  if (!stt.enabled()) throw new GameError('err.sttOff');
  const room = rooms.get(String(req.query.code || '').toUpperCase());
  const member = room && room.byUser(user.id);
  if (!member) throw new GameError('err.notInRoom');
  if (!room.settings.transcripts || !voiceAllowed(room) || !users.features.transcripts) throw new GameError('err.transcriptsOff');
  const phase = String(req.query.phase || '');
  const day = Number(req.query.day);
  if (!['night', 'speech', 'vote'].includes(phase) || !Number.isInteger(day) || day < room.day - 1 || day > room.day) throw new GameError('err.gameNotRunning');
  if (!Buffer.isBuffer(req.body) || req.body.length < 1500) return {}; // a click, not speech
  const names = [...room.players, ...room.spectators].map(p => p.name).join(', ');
  stt.add({
    code: room.code, gameId: room.gameId, pid: member.id, phase, day, audio: req.body, mime: req.get('content-type') || 'audio/webm',
    lang: AI_LANG, prompt: `Игра «Мафия», игроки: ${names}. Мафия, мирный житель, комиссар, доктор, путана, голосую, пропускаю, ночь, день, подозреваю.`,
  });
  return {};
}));

// ---------- voice: STUN/TURN servers for the browser-to-browser audio ----------
app.get('/api/voice/ice', api(req => ({ iceServers: iceServers(currentUser(req).id), insights: insights.enabled(), stt: stt.enabled() })));

// ---------- stakes between friends: who owes whom what ----------
const pledgeView = p => ({ ...p, kind: p.kind || 'lot', address: p.address || users.users[p.to]?.usdt?.address || null, network: p.network || users.users[p.to]?.usdt?.network || null, fromName: users.users[p.from]?.username || '?', toName: users.users[p.to]?.username || '?' });
app.get('/api/pledges', api(req => {
  const user = currentUser(req);
  return { pledges: pledges.mine(user.id).map(pledgeView) };
}));
app.post('/api/pledges/mark', api(req => {
  const user = currentUser(req);
  return { pledge: pledgeView(pledges.mark(String(req.body.id || ''), user.id, String(req.body.status || ''), req.body.tx)) };
}));

// ---------- site chips: the wallet, achievements ----------
app.get('/api/wallet', api(req => ({ wallet: users.walletView(currentUser(req)) })));
// where to be paid in USDT (only its owner sees it; in a settlement the payer sees the receiver's)
app.post('/api/wallet/usdt', api(req => {
  if (!currentUser(req).usdtAccess) throw new GameError('err.invalidTarget');
  const user = currentUser(req);
  users.setUsdt(user, { network: String(req.body.network || ''), address: req.body.address });
  refreshUser(user.id);
  return { wallet: users.walletView(user) };
}));

// ---------- the game night archive ----------
app.get('/api/archive', api(req => {
  const user = currentUser(req);
  if (req.query.table) {
    const table = tables.get(req.query.table);
    if (!table.members.includes(user.id) && !user.admin) throw new GameError('err.tableNotFound');
    return { table: table.name, nights: archive.forTable(table.id) };
  }
  return { nights: archive.forUser(user.id) };
}));

// ---------- personal touches: your birthday and theme; titles and badges from the admin ----------
app.post('/api/profile', api(req => {
  const user = currentUser(req);
  users.setPersonal(user, { birthday: req.body.birthday, theme: req.body.theme });
  refreshUser(user.id);
  return { user: users.selfProfile(user) };
}));
app.post('/api/admin/title', api(req => {
  adminUser(req);
  const u = targetUser(req);
  users.setTitle(u, req.body.title);
  refreshUser(u.id);
  return { user: users.adminView(u) };
}));
app.post('/api/admin/badge', api(req => {
  const admin = adminUser(req);
  const u = targetUser(req);
  if (req.body.remove) users.removeBadge(u, req.body.remove);
  else users.addBadge(u, req.body.emoji, req.body.label, admin.id);
  refreshUser(u.id);
  return { user: users.adminView(u) };
}));

// QR code of the invite link, for players in the same room to scan
// ---------- the blog, the sitemap and what AI assistants read ----------
const html = (res, body, status = 200) => res.status(status).type('html').set('Cache-Control', 'public, max-age=300').send(body);
const uiLang = req => (/^ru\b/i.test(req.get('accept-language') || '') ? 'ru' : 'en');
// exact paths (Express would treat /blog and /blog/ as the same route)
app.get(/^\/blog$/, (_req, res) => res.redirect(301, '/blog/'));
app.get(/^\/blog\/$/, (req, res) => html(res, blogLib.renderIndex(blog, siteUrl(req), 'en')));
app.get(/^\/blog\/ru\/$/, (req, res) => html(res, blogLib.renderIndex(blog, siteUrl(req), 'ru')));
app.get(/^\/blog\/(ru|en)$/, (req, res) => res.redirect(301, req.params[0] === 'ru' ? '/blog/ru/' : '/blog/'));
app.get(/^\/blog\/en\/$/, (_req, res) => res.redirect(301, '/blog/'));
app.get('/blog/rss.xml', (req, res) => res.type('application/rss+xml').set('Cache-Control', 'public, max-age=600').send(blogLib.rss(blog, siteUrl(req), 'en')));
app.get('/blog/ru/rss.xml', (req, res) => res.type('application/rss+xml').set('Cache-Control', 'public, max-age=600').send(blogLib.rss(blog, siteUrl(req), 'ru')));
app.use('/blog/img', express.static(blog.imageDir, { maxAge: '30d', immutable: true, index: false }));
app.get(/^\/blog\/([\w-]+)$/, (req, res) => res.redirect(301, `/blog/${req.params[0]}/`));
app.get(/^\/blog\/([\w-]+)\/$/, (req, res) => {
  const post = blog.bySlug(req.params[0]);
  if (!post || post.status !== 'published') return html(res, blogLib.renderIndex(blog, siteUrl(req), uiLang(req), { notFound: true }), 404);
  html(res, blogLib.renderPost(blog, post, siteUrl(req)));
});
const SITEMAP_PAGES = [['/', 1.0, 'weekly'], ['/poker/', 0.9, 'weekly'], ['/spy/', 0.8, 'monthly'], ['/tycoon/', 0.8, 'monthly'], ['/kingdoms/', 0.8, 'monthly'],
  ['/blog/', 0.8, 'daily'], ['/blog/ru/', 0.8, 'daily'], ['/poker/fair.html', 0.4, 'yearly'], ['/terms/', 0.2, 'yearly'], ['/privacy/', 0.2, 'yearly']];
app.get('/sitemap.xml', (req, res) => {
  const base = siteUrl(req);
  const urls = [
    ...SITEMAP_PAGES.map(([p, prio, freq]) => `  <url><loc>${base}${p}</loc><changefreq>${freq}</changefreq><priority>${prio}</priority></url>`),
    ...blog.published().map(p => `  <url><loc>${base}/blog/${p.slug}/</loc><lastmod>${new Date(p.updatedAt).toISOString().slice(0, 10)}</lastmod><priority>0.7</priority></url>`),
  ];
  res.type('application/xml').set('Cache-Control', 'public, max-age=600')
    .send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`);
});
// llms.txt: a plain summary of the site for AI assistants (https://llmstxt.org)
app.get('/llms.txt', (req, res) => {
  const base = siteUrl(req);
  const posts = blog.published().map(p => `- [${p.title}](${base}/blog/${p.slug}/): ${p.description}`).join('\n');
  res.type('text/plain; charset=utf-8').set('Cache-Control', 'public, max-age=600').send(`# bluepeau.club

> Free browser games to play with friends: Mafia (Werewolf), Texas hold'em poker, Tycoon (a property trading game), Find the spy and Kingdoms (a city-building card game with secret roles). No downloads, one link to invite everyone, voice chat built in, English and Russian.

## Games

- [Mafia](${base}/): 4–12 players, the site is the narrator: secret roles, nights and votes.
- [Poker](${base}/poker/): private no-limit Texas hold'em for 2–9 players, free site chips, provably fair decks.
- [Tycoon](${base}/tycoon/): roll, buy streets, build and trade, 2–8 players.
- [Find the spy](${base}/spy/): everyone knows the location except the spy, 3–12 players.
- [Kingdoms](${base}/kingdoms/): secret characters and city building, 3–8 players.

## Details

- [Blog in English](${base}/blog/) · [Блог на русском](${base}/blog/ru/): rules, strategy and ideas for game night.
- [Fair deal check](${base}/poker/fair.html): how every poker deck can be verified after a session.
- [Terms](${base}/terms/) · [Privacy](${base}/privacy/)
- Source code: https://github.com/bluepe4u/MafiaGame
${posts ? `\n## Articles\n\n${posts}\n` : ''}`);
});
// IndexNow (Bing, Yandex and others learn about a new article at once): on when INDEXNOW_KEY is set
const INDEXNOW_KEY = /^[\w-]{8,128}$/.test(process.env.INDEXNOW_KEY || '') ? process.env.INDEXNOW_KEY : null;
if (INDEXNOW_KEY) app.get(`/${INDEXNOW_KEY}.txt`, (_req, res) => res.type('text/plain').send(INDEXNOW_KEY));
function pingIndexNow(paths) {
  const base = process.env.PUBLIC_URL;
  if (!INDEXNOW_KEY || !base) return;
  fetch('https://api.indexnow.org/indexnow', {
    method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host: new URL(base).host, key: INDEXNOW_KEY, keyLocation: `${base}/${INDEXNOW_KEY}.txt`, urlList: paths.map(p => base + p) }),
  }).then(r => console.log(`IndexNow: ${r.status} for ${paths.join(', ')}`)).catch(e => console.error('IndexNow failed:', e.message));
}
// the admin writes the articles
app.get('/api/admin/blog', api(req => { adminUser(req); return { posts: blog.all(), games: Object.keys(blogLib.GAMES) }; }));
app.post('/api/admin/blog', api(req => {
  const user = adminUser(req);
  const was = req.body.id ? blog.posts[req.body.id]?.status : null;
  const post = blog.upsert(req.body, user.id);
  if (post.status === 'published') pingIndexNow([`/blog/${post.slug}/`, ...(was !== 'published' ? [post.lang === 'ru' ? '/blog/ru/' : '/blog/'] : [])]);
  return { post };
}));
app.post('/api/admin/blog/delete', api(req => { adminUser(req); blog.remove(req.body.id); return {}; }));
app.post('/api/admin/blog/preview', api(req => { adminUser(req); return { html: blogLib.md.parse(String(req.body.body || '').slice(0, 100000)) }; }));

app.get('/qr.svg', async (req, res) => {
  const code = String(req.query.room || '').toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) return res.status(400).end();
  const page = { mono: '/tycoon/', spy: '/spy/', cit: '/kingdoms/', poker: '/poker/' }[req.query.game] || '/';
  const svg = await QRCode.toString(`${req.protocol}://${req.get('host')}${page}?room=${code}`, { type: 'svg', margin: 1 });
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(svg);
});

const server = http.createServer(app);
const io = new Server(server);

const rooms = new Map(); // code -> Room
// Monopoly: its own namespace and rooms, same accounts; room codes are unique across both games
const mono = attachMonopoly({
  io, app, users, api, currentUser, dataDir: DATA_DIR, codeTaken: code => rooms.has(code) || spy.has(code) || cit.has(code) || poker.has(code),
  onArchive: record => archive.add(record),
  onStart: room => { stats.game('mono'); if (room.tableId) tables.saveSettings(room.tableId, 'mono', room.settings); },
});

const voiceHub = createVoiceHub(io.of('/'));
const voiceAllowed = room => users.features.voice && room.settings.voice !== false;
// Spyfall and Citadels: their own namespaces and rooms too; codes are unique across all the games
const spy = attachSpyfall({
  io, app, users, api, currentUser, dataDir: DATA_DIR, codeTaken: code => rooms.has(code) || mono.has(code) || cit.has(code) || poker.has(code),
  onArchive: record => archive.add(record),
  onStart: room => { stats.game('spy'); if (room.tableId) tables.saveSettings(room.tableId, 'spy', room.settings); },
});
const cit = attachCitadels({
  io, app, users, api, currentUser, dataDir: DATA_DIR, codeTaken: code => rooms.has(code) || mono.has(code) || spy.has(code) || poker.has(code),
  onArchive: record => archive.add(record),
  onStart: room => { stats.game('cit'); if (room.tableId) tables.saveSettings(room.tableId, 'cit', room.settings); },
});
// Poker (Texas hold'em): chips only
const poker = attachPoker({
  io, app, users, api, currentUser, dataDir: DATA_DIR, codeTaken: code => rooms.has(code) || mono.has(code) || spy.has(code) || cit.has(code),
  onArchive: record => archive.add(record),
  // USDT: who pays whom, with the receiver's address as it is now; paid wallet to wallet
  onSettle: ({ code, transfers, buyIn }) => pledges.add(transfers.map(x => ({
    kind: 'usdt', from: x.from, to: x.to, cents: x.cents, buyIn, game: 'poker', code,
    network: users.users[x.to]?.usdt?.network || null, address: users.users[x.to]?.usdt?.address || null,
  }))),
  wallet: {
    balance: uid => (users.users[uid] ? users.wallet(users.users[uid]).chips : 0),
    take: (uid, n, reason, extra) => { const u = users.users[uid]; const ok = !!u && users.takeChips(u, n, reason, extra); if (ok) setImmediate(() => refreshUser(uid)); return ok; },
    give: (uid, n, reason, extra) => { const u = users.users[uid]; if (u) { users.addChips(u, n, reason, extra); setImmediate(() => refreshUser(uid)); } },
  },
  usdtOk: uid => !!users.users[uid]?.usdt,
  usdtAccess: uid => !!users.users[uid]?.usdtAccess,
  onStart: room => { stats.game('poker'); if (room.tableId) tables.saveSettings(room.tableId, 'poker', room.settings); },
});
const allSockets = () => [...io.sockets.sockets.values(), ...mono.sockets(), ...spy.sockets(), ...cit.sockets(), ...poker.sockets()];
const roomSummary = room => ({
  game: 'mafia', code: room.code, phase: room.phase, lastActivity: room.lastActivity,
  players: room.players.map(p => ({ name: p.name, connected: p.connected })), spectators: room.spectators.length,
});

function newCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(code) || mono.has(code) || spy.has(code) || cit.has(code) || poker.has(code));
  return code;
}

// rooms show each player's avatar and decency status: re-send them when a profile changes
function refreshUser(userId) {
  for (const room of rooms.values()) if (room.byUser(userId)) broadcast(room);
  mono.refreshUser(userId);
  spy.refreshUser(userId);
  cit.refreshUser(userId);
  poker.refreshUser(userId);
}

const roomOptions = () => ({
  onChange: onRoomChange,
  profileOf: userId => users.publicProfile(users.users[userId]),
  onGameEnd: results => users.recordGame(results),
  onArchive: record => {
    const game = archive.add({ ...record, transcript: record.transcript.slice(-1500) });
    if (game) finishMafiaGame(game, record).catch(e => console.error('Insights failed:', e.message));
  },
  onRound: (room, day) => noteRound(room, day),
  onStart: room => { stats.game('mafia'); if (room.tableId) tables.saveSettings(room.tableId, 'mafia', room.settings); },
  features: () => users.features,
  onRate: (targetUserId, oldValue, newValue, fromUserId) => {
    users.applyRating(targetUserId, oldValue, newValue, fromUserId);
    refreshUser(targetUserId);
  },
});

function broadcast(room) {
  for (const s of io.sockets.adapter.rooms.get(room.code) || []) {
    const sock = io.sockets.sockets.get(s);
    if (sock?.data.playerId) sock.emit('state', room.viewFor(sock.data.playerId));
  }
}

// ---------- persistence ----------
const savedRooms = roomStore(DATA_DIR, 'mafia', 'rooms.json');
let saveTimer = null;
let shuttingDown = false;

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    savedRooms.save([...rooms.values()]);
  } catch (e) {
    console.error('Saving rooms failed:', e.message);
  }
}

function scheduleSave() {
  if (!saveTimer && !shuttingDown) saveTimer = setTimeout(saveNow, 1000);
}

function onRoomChange(room) {
  broadcast(room);
  scheduleSave();
}

function loadRooms() {
  let list;
  try {
    list = savedRooms.load();
  } catch (e) {
    console.error('Could not read saved rooms:', e.message);
    return;
  }
  for (const data of list) {
    try {
      rooms.set(data.code, Room.restore(data, roomOptions()));
    } catch (e) {
      console.error(`Could not restore room ${data.code}:`, e.message);
    }
  }
  console.log(`Restored ${rooms.size} room(s)`);
}

function createRoom() {
  const room = new Room({ code: newCode(), ...roomOptions() });
  rooms.set(room.code, room);
  return room;
}

// the client sends its login token when connecting; it reconnects after logging in or out
io.use((socket, next) => {
  socket.data.userId = users.byToken(socket.handshake.auth?.token)?.id || null;
  next();
});

io.on('connection', socket => {
  limitSocket(socket);
  const me = () => {
    const user = users.users[socket.data.userId];
    if (!user) throw new GameError('err.loginRequired');
    return user;
  };

  const attach = (room, player) => {
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    socket.join(room.code);
    socket.emit('session', { code: room.code, token: player.token });
    room.setConnected(player.id, true);
  };

  const ctx = () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !socket.data.playerId) throw new GameError('err.notInRoom');
    return { room, pid: socket.data.playerId };
  };

  // wraps handlers so game errors reach the client instead of crashing
  const on = (event, fn) => socket.on(event, (payload = {}, ack) => {
    try {
      fn(payload);
      if (typeof ack === 'function') ack({ ok: true });
    } catch (e) {
      if (!(e instanceof GameError)) console.error(e);
      const err = e instanceof GameError ? { key: e.key, params: e.params } : { key: 'err.server', params: {} };
      if (typeof ack === 'function') ack({ ok: false, error: err });
    }
  });

  on('create', () => {
    const user = me();
    const room = createRoom();
    try {
      attach(room, room.join(user.username, { userId: user.id }));
    } catch (e) {
      rooms.delete(room.code);
      throw e;
    }
  });

  on('join', ({ code, spectate }) => {
    const user = me();
    const room = rooms.get(String(code || '').toUpperCase().trim());
    if (!room) throw new GameError('err.roomNotFound');
    // already in this room (another tab or device): take that seat back
    attach(room, room.byUser(user.id) || room.join(user.username, { userId: user.id, spectate: !!spectate }));
  });

  on('resume', ({ code, token }) => {
    const room = rooms.get(String(code || '').toUpperCase());
    const player = room?.byToken(token);
    if (!player) throw new GameError('err.sessionExpired');
    attach(room, player);
  });

  voiceHub.attach(socket, ctx, { onTranscript: (room, pid, text) => room.addTranscript(pid, text), allowed: voiceAllowed });

  on('leave', () => {
    const { room, pid } = ctx();
    voiceHub.leave(socket);
    socket.leave(room.code);
    socket.data.playerId = null;
    room.leave(pid);
  });

  on('kick', ({ playerId }) => {
    const { room, pid } = ctx();
    room.kick(pid, playerId);
    for (const s of io.sockets.adapter.rooms.get(room.code) || []) {
      const sock = io.sockets.sockets.get(s);
      if (sock?.data.playerId === playerId) {
        voiceHub.leave(sock);
        sock.data.playerId = null;
        sock.leave(room.code);
        sock.emit('kicked');
      }
    }
  });

  on('settings', s => {
    const { room, pid } = ctx();
    room.updateSettings(pid, s);
    if (!voiceAllowed(room)) voiceHub.closeRoom(room.code);
  });
  on('start', () => { const { room, pid } = ctx(); room.start(pid); });
  on('restart', () => { const { room, pid } = ctx(); room.restart(pid); });
  on('nightAction', ({ targetId }) => { const { room, pid } = ctx(); room.nightAction(pid, targetId); });
  on('forceEndNight', () => { const { room, pid } = ctx(); room.forceEndNight(pid); });
  on('endSpeech', () => { const { room, pid } = ctx(); room.endSpeech(pid); });
  on('extendSpeech', () => { const { room, pid } = ctx(); room.extendSpeech(pid); });
  on('chat', ({ channel, text }) => { const { room, pid } = ctx(); room.sendChat(pid, channel, text); });
  on('rename', ({ playerId, name }) => { const { room, pid } = ctx(); room.rename(pid, playerId, name); });
  on('watch', ({ on: watch }) => { const { room, pid } = ctx(); room.setSpectating(pid, !!watch); });
  on('ready', ({ ready }) => { const { room, pid } = ctx(); room.setReady(pid, !!ready); });
  on('startCountdown', () => { const { room, pid } = ctx(); room.startCountdown(pid); });
  on('cancelCountdown', () => { const { room, pid } = ctx(); room.cancelCountdown(pid); });
  on('react', ({ emoji }) => { const { room, pid } = ctx(); io.to(room.code).emit('reaction', room.react(pid, emoji)); });
  on('revealRole', () => { const { room, pid } = ctx(); room.revealRole(pid); });
  on('rate', ({ targetId, value }) => {
    const { room, pid } = ctx();
    // ratings are between registered players only
    if ([pid, targetId].some(id => users.users[room.player(id)?.userId]?.guest)) throw new GameError('err.rateAccounts');
    room.rate(pid, targetId, Number(value));
  });
  on('skipToVote', () => { const { room, pid } = ctx(); room.skipToVote(pid); });
  on('vote', ({ targetId }) => { const { room, pid } = ctx(); room.vote(pid, targetId); });
  on('forceEndVote', () => { const { room, pid } = ctx(); room.forceEndVote(pid); });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !socket.data.playerId) return;
    const pid = socket.data.playerId;
    // only mark offline if no other socket (e.g. second tab) holds this player
    const stillHere = [...(io.sockets.adapter.rooms.get(room.code) || [])]
      .some(s => io.sockets.sockets.get(s)?.data.playerId === pid);
    if (!stillHere) room.setConnected(pid, false);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyone = room.players.some(p => p.connected);
    if (!anyone && now - room.lastActivity > ROOM_IDLE_MS) {
      room.dispose();
      rooms.delete(code);
      scheduleSave();
    }
  }
}, 5 * 60 * 1000).unref();

loadRooms();
// guests nobody saved are removed after a month of quiet (unless they're still at a table or in a room)
function pruneGuests() {
  const keep = new Set();
  for (const sock of allSockets()) if (sock.data.userId) keep.add(sock.data.userId);
  for (const tb of Object.values(tables.tables)) for (const m of tb.members) keep.add(m);
  const gone = users.pruneGuests(keep);
  if (gone.length) console.log(`Removed ${gone.length} unsaved guest account(s)`);
}
setInterval(pruneGuests, 6 * 60 * 60 * 1000).unref();
// Redis first (when configured): rate limits and email links, and the Socket.IO adapter, so events
// could be shared with more processes later. The rooms themselves still live in this one process.
(async () => {
  kv = await createKv();
  if (kv.kind === 'redis') {
    const { createAdapter } = require('@socket.io/redis-adapter');
    const pub = kv.client.duplicate();
    const sub = pub.duplicate();
    pub.on('error', e => console.error('Redis (pub):', e.message));
    sub.on('error', e => console.error('Redis (sub):', e.message));
    await Promise.all([pub.connect(), sub.connect()]);
    io.adapter(createAdapter(pub, sub));
  }
  if (!mailer.enabled) console.log('No SMTP_URL: emails are printed to the log instead of sent');
  server.listen(PORT, HOST, () => console.log(`Mafia server listening on http://${HOST}:${PORT}`));
})();

// Save before closing sockets, so disconnects during shutdown don't change who is host.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`${sig} received, shutting down`);
    saveNow();
    mono.shutdown();
    spy.shutdown();
    cit.shutdown();
    poker.shutdown();
    users.saveNow();
    tables.saveNow();
    archive.saveNow();
    pledges.saveNow();
    stats.saveNow();
    blog.saveNow();
    kv.close();
    shuttingDown = true;
    io.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
