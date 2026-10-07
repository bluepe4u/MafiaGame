'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const { Room, GameError } = require('./src/game');
const { UserStore } = require('./src/users');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOM_IDLE_MS = 60 * 60 * 1000;
// rooms are saved here so a restart or update doesn't end games in progress
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'rooms.json');

const users = new UserStore(DATA_DIR);

const app = express();
app.set('trust proxy', 'loopback'); // behind Caddy: use its X-Forwarded-Proto/Host for invite links
app.use(express.static(path.join(__dirname, 'public')));
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
  const { user, token } = users.register(req.body.username, req.body.password);
  return { token, user: users.publicProfile(user) };
}));
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
// avatar arrives as a data URL, already cropped and shrunk in the browser
app.post('/api/avatar', api(req => {
  const user = currentUser(req);
  const m = /^data:image\/[a-z]+;base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.image || ''));
  if (!m) throw new GameError('err.avatarType');
  users.setAvatar(user, Buffer.from(m[1], 'base64'));
  refreshUser(user.id);
  return { user: users.publicProfile(user) };
}));

// QR code of the invite link, for players in the same room to scan
app.get('/qr.svg', async (req, res) => {
  const code = String(req.query.room || '').toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) return res.status(400).end();
  const svg = await QRCode.toString(`${req.protocol}://${req.get('host')}/?room=${code}`, { type: 'svg', margin: 1 });
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(svg);
});

const server = http.createServer(app);
const io = new Server(server);

const rooms = new Map(); // code -> Room

function newCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

// rooms show each player's avatar and decency status: re-send them when a profile changes
function refreshUser(userId) {
  for (const room of rooms.values()) if (room.byUser(userId)) broadcast(room);
}

const roomOptions = () => ({
  onChange: onRoomChange,
  profileOf: userId => users.publicProfile(users.users[userId]),
  onGameEnd: results => users.recordGame(results),
  onRate: (targetUserId, oldValue, newValue) => {
    users.applyRating(targetUserId, oldValue, newValue);
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
    users.saveNow();
    shuttingDown = true;
    io.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
