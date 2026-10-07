'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const { Room, GameError } = require('./src/game');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOM_IDLE_MS = 60 * 60 * 1000;
// rooms are saved here so a restart or update doesn't end games in progress
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'rooms.json');

const app = express();
app.set('trust proxy', 'loopback'); // behind Caddy: use its X-Forwarded-Proto/Host for invite links
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.send('ok'));

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
      rooms.set(data.code, Room.restore(data, { onChange: onRoomChange }));
    } catch (e) {
      console.error(`Could not restore room ${data.code}:`, e.message);
    }
  }
  console.log(`Restored ${rooms.size} room(s)`);
}

function createRoom() {
  const room = new Room({ code: newCode(), onChange: onRoomChange });
  rooms.set(room.code, room);
  return room;
}

io.on('connection', socket => {
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

  on('create', ({ name }) => {
    const room = createRoom();
    try {
      attach(room, room.join(name));
    } catch (e) {
      rooms.delete(room.code);
      throw e;
    }
  });

  on('join', ({ code, name }) => {
    const room = rooms.get(String(code || '').toUpperCase().trim());
    if (!room) throw new GameError('err.roomNotFound');
    attach(room, room.join(name));
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
    shuttingDown = true;
    io.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
