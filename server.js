'use strict';

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
const { limitSocket } = require('./src/ratelimit');
const { TableStore } = require('./src/tables');
const { Archive } = require('./src/archive');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOM_IDLE_MS = 60 * 60 * 1000;
// rooms are saved here so a restart or update doesn't end games in progress
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'rooms.json');

const users = new UserStore(DATA_DIR);
const tables = new TableStore(DATA_DIR);
tables.prune(Object.keys(users.users));
const archive = new Archive(DATA_DIR);
archive.prune(Object.keys(users.users));
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
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      'font-src https://fonts.gstatic.com',
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
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});
// browsers re-check the page's files on every load (cheap: unchanged files answer 304), so
// nobody keeps running an old version after an update
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: res => res.setHeader('Cache-Control', 'no-cache') }));
app.use('/avatars', express.static(users.avatarDir, { maxAge: '30d', immutable: true, index: false }));
app.get('/health', (_req, res) => res.send('ok'));

// ---------- accounts API ----------
// Handlers throw GameError for anything the user should see; the client translates the key.
const api = fn => (req, res) => {
  try {
    res.json({ ok: true, ...fn(req) });
  } catch (e) {
    if (!(e instanceof GameError)) console.error(e);
    const error = e instanceof GameError ? { key: e.key, params: e.params } : { key: 'err.server', params: {} };
    res.status(e instanceof GameError ? 400 : 500).json({ ok: false, error });
  }
};
const bearer = req => (req.get('authorization') || '').replace(/^Bearer /, '');
const currentUser = req => {
  const user = users.byToken(bearer(req));
  if (!user) throw new GameError('err.loginRequired');
  return user;
};

app.use('/api', express.json({ limit: '2mb' }));
app.post('/api/register', api(req => {
  const { user, token, invite, recoveryCode } = users.register(req.body.username, req.body.password, req.body.invite);
  if (invite.tableId) { try { tables.join(invite.tableId, user); } catch {} }
  if (invite.admin) fs.rm(path.join(DATA_DIR, 'admin-invite.txt'), { force: true }, () => {});
  return { token, user: users.publicProfile(user), recoveryCode };
}));
// forgot the password: username + recovery code sets a new one (and issues a fresh code)
app.post('/api/recover', api(req => {
  const { user, token, recoveryCode } = users.recover(req.body.username, req.body.code, req.body.password);
  return { token, user: users.publicProfile(user), recoveryCode };
}));
app.post('/api/recovery', api(req => ({ recoveryCode: users.newRecoveryCode(currentUser(req)) })));
app.post('/api/login', api(req => {
  const { user, token } = users.login(req.body.username, req.body.password);
  return { token, user: users.publicProfile(user) };
}));
app.post('/api/logout', api(req => { users.logout(bearer(req)); return {}; }));
app.get('/api/me', api(req => ({ user: users.publicProfile(currentUser(req)) })));
app.post('/api/password', api(req => {
  const token = users.changePassword(currentUser(req), req.body.oldPassword, req.body.newPassword);
  return { token };
}));
app.get('/api/items', (_req, res) => res.json({ ok: true, items: ITEMS }));
// leaderboard and player pages: for logged-in players only
app.get('/api/leaderboard', api(req => {
  currentUser(req);
  return { users: Object.values(users.users).map(u => users.publicProfile(u)) };
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
  return { user: users.publicProfile(user) };
}));
app.post('/api/gifts/seen', api(req => { users.giftsSeen(currentUser(req)); return {}; }));
// rooms this account is still in, in either game: the "back to my game" button
app.get('/api/active', api(req => {
  const user = currentUser(req);
  const mine = [...rooms.values()].filter(r => r.byUser(user.id)).map(roomSummary).concat(mono.userRooms(user.id));
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
app.get('/api/admin/users', api(req => {
  adminUser(req);
  return { users: Object.values(users.users).map(u => users.adminView(u)).sort((a, b) => a.username.localeCompare(b.username)) };
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
// who's online right now (in either game) and every room on the server
app.get('/api/admin/live', api(req => {
  adminUser(req);
  const online = {};
  for (const sock of allSockets()) {
    const u = users.users[sock.data.userId];
    if (!u) continue;
    const o = (online[u.id] ||= { id: u.id, username: u.username, avatar: u.avatar ? `/avatars/${u.avatar}` : null, where: [] });
    const where = sock.data.roomCode ? `${sock.nsp.name === '/monopoly' ? 'mono' : 'mafia'}:${sock.data.roomCode}` : (sock.nsp.name === '/monopoly' ? 'mono' : 'mafia');
    if (!o.where.includes(where)) o.where.push(where);
  }
  return {
    online: Object.values(online).sort((a, b) => a.username.localeCompare(b.username)),
    rooms: [...rooms.values()].map(roomSummary).concat(mono.list()).sort((a, b) => b.lastActivity - a.lastActivity),
  };
}));
app.post('/api/admin/endRoom', api(req => {
  adminUser(req);
  const code = String(req.body.code || '');
  if (req.body.game === 'mono') { if (!mono.end(code)) throw new GameError('err.roomNotFound'); return {}; }
  const room = rooms.get(code);
  if (!room) throw new GameError('err.roomNotFound');
  for (const s of io.sockets.adapter.rooms.get(code) || []) {
    const sock = io.sockets.sockets.get(s);
    if (!sock) continue;
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
  return { user: users.publicProfile(user) };
}));

// ---------- tables: a permanent space for a group, with a game picker ----------
const GAMES = ['mafia', 'mono'];
const gameInfo = (game, code) => (game === 'mono' ? mono.info(code) : rooms.has(code) ? roomSummary(rooms.get(code)) : null);
function tableView(table, user) {
  const online = new Set(allSockets().map(s => s.data.userId));
  const current = table.current && gameInfo(table.current.game, table.current.code);
  const live = !!(current && current.phase !== 'ended');
  return {
    id: table.id,
    name: table.name,
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
app.post('/api/tables/create', tableAction((user, b) => tables.create(user, b.name)));
app.post('/api/tables/join', tableAction((user, b) => tables.join(b.id, user)));
app.post('/api/tables/leave', tableAction((user, b) => { tables.leave(b.id, user); }));
app.post('/api/tables/rename', tableAction((user, b) => tables.rename(b.id, user, b.name)));
app.post('/api/tables/kick', tableAction((user, b) => tables.kick(b.id, user, b.userId)));
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
  if (game === 'mono') code = mono.create(table.id, saved);
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
  return { user: users.publicProfile(user) };
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
app.get('/qr.svg', async (req, res) => {
  const code = String(req.query.room || '').toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) return res.status(400).end();
  const page = req.query.game === 'mono' ? '/monopoly/' : '/';
  const svg = await QRCode.toString(`${req.protocol}://${req.get('host')}${page}?room=${code}`, { type: 'svg', margin: 1 });
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(svg);
});

const server = http.createServer(app);
const io = new Server(server);

const rooms = new Map(); // code -> Room
// Monopoly: its own namespace and rooms, same accounts; room codes are unique across both games
const mono = attachMonopoly({
  io, app, users, api, currentUser, dataDir: DATA_DIR, codeTaken: code => rooms.has(code),
  onArchive: record => archive.add(record),
  onStart: room => room.tableId && tables.saveSettings(room.tableId, 'mono', room.settings),
});

const allSockets = () => [...io.sockets.sockets.values(), ...mono.sockets()];
const roomSummary = room => ({
  game: 'mafia', code: room.code, phase: room.phase, lastActivity: room.lastActivity,
  players: room.players.map(p => ({ name: p.name, connected: p.connected })), spectators: room.spectators.length,
});

function newCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(code) || mono.has(code));
  return code;
}

// rooms show each player's avatar and decency status: re-send them when a profile changes
function refreshUser(userId) {
  for (const room of rooms.values()) if (room.byUser(userId)) broadcast(room);
  mono.refreshUser(userId);
}

const roomOptions = () => ({
  onChange: onRoomChange,
  profileOf: userId => users.publicProfile(users.users[userId]),
  onGameEnd: results => users.recordGame(results),
  onArchive: record => archive.add(record),
  onStart: room => room.tableId && tables.saveSettings(room.tableId, 'mafia', room.settings),
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
let saveTimer = null;
let shuttingDown = false;

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...rooms.values()]));
    fs.renameSync(tmp, STATE_FILE);
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
    list = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Could not read saved rooms:', e.message);
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

  on('leave', () => {
    const { room, pid } = ctx();
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
        sock.data.playerId = null;
        sock.leave(room.code);
        sock.emit('kicked');
      }
    }
  });

  on('settings', s => { const { room, pid } = ctx(); room.updateSettings(pid, s); });
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
  on('rate', ({ targetId, value }) => { const { room, pid } = ctx(); room.rate(pid, targetId, Number(value)); });
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
server.listen(PORT, HOST, () => console.log(`Mafia server listening on http://${HOST}:${PORT}`));

// Save before closing sockets, so disconnects during shutdown don't change who is host.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`${sig} received, shutting down`);
    saveNow();
    mono.shutdown();
    users.saveNow();
    tables.saveNow();
    archive.saveNow();
    shuttingDown = true;
    io.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
