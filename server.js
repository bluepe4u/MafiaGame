'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Room, GameError } = require('./src/game');

const PORT = process.env.PORT || 3000;
const ROOM_IDLE_MS = 60 * 60 * 1000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.send('ok'));

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

function createRoom() {
  const room = new Room({ code: newCode(), onChange: broadcast });
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
    if (!room || !socket.data.playerId) throw new GameError('You are not in a room');
    return { room, pid: socket.data.playerId };
  };

  // wraps handlers so game errors reach the client instead of crashing
  const on = (event, fn) => socket.on(event, (payload = {}, ack) => {
    try {
      fn(payload);
      if (typeof ack === 'function') ack({ ok: true });
    } catch (e) {
      if (!(e instanceof GameError)) console.error(e);
      if (typeof ack === 'function') ack({ ok: false, error: e instanceof GameError ? e.message : 'Server error' });
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
    if (!room) throw new GameError('Room not found');
    attach(room, room.join(name));
  });

  on('resume', ({ code, token }) => {
    const room = rooms.get(String(code || '').toUpperCase());
    const player = room?.byToken(token);
    if (!player) throw new GameError('Session expired');
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
    }
  }
}, 5 * 60 * 1000).unref();

server.listen(PORT, () => console.log(`Mafia server listening on http://localhost:${PORT}`));
