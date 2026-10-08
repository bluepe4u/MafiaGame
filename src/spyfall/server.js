'use strict';

// "Find the spy" on the shared server: its own Socket.IO namespace (/spyfall) and room list, the
// same accounts as the other games. Rooms are saved to spyfall-rooms.json.

const fs = require('fs');
const path = require('path');
const { SpyRoom } = require('./game');
const { LOCATIONS } = require('./locations');
const { GameError } = require('../game');
const { limitSocket } = require('../ratelimit');
const { createVoiceHub } = require('../voice');

const ROOM_IDLE_MS = 60 * 60 * 1000;

function attachSpyfall({ io, app, users, api, currentUser, dataDir, codeTaken, onArchive = () => {}, onStart = () => {} }) {
  const voiceAllowed = room => users.features.voice && room.settings.voice !== false;
  const nsp = io.of('/spyfall');
  const voice = createVoiceHub(nsp);
  const rooms = new Map(); // code -> SpyRoom
  const stateFile = path.join(dataDir, 'spyfall-rooms.json');
  let saveTimer = null;
  let shuttingDown = false;

  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = `${stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...rooms.values()]));
      fs.renameSync(tmp, stateFile);
    } catch (e) {
      console.error('Saving Spyfall rooms failed:', e.message);
    }
  }
  const scheduleSave = () => { if (!saveTimer && !shuttingDown) saveTimer = setTimeout(saveNow, 1000); };

  function broadcast(room) {
    for (const s of nsp.adapter.rooms.get(room.code) || []) {
      const sock = nsp.sockets.get(s);
      if (sock?.data.playerId) sock.emit('state', room.viewFor(sock.data.playerId));
    }
  }

  const roomOptions = () => ({
    onChange: room => { broadcast(room); scheduleSave(); },
    profileOf: userId => users.publicProfile(users.users[userId]),
    onGameEnd: results => users.recordSpyGame(results),
    onArchive,
    onStart,
    features: () => users.features,
  });

  function newCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code;
    do code = Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
    while (rooms.has(code) || codeTaken(code));
    return code;
  }

  try {
    for (const data of JSON.parse(fs.readFileSync(stateFile, 'utf8'))) {
      try { rooms.set(data.code, SpyRoom.restore(data, roomOptions())); } catch (e) { console.error(`Could not restore Spyfall room ${data.code}:`, e.message); }
    }
    console.log(`Restored ${rooms.size} Spyfall room(s)`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Could not read Spyfall rooms:', e.message);
  }

  nsp.use((socket, next) => {
    socket.data.userId = users.byToken(socket.handshake.auth?.token)?.id || null;
    next();
  });

  nsp.on('connection', socket => {
    limitSocket(socket);
    const me = () => {
      const user = users.users[socket.data.userId];
      if (!user) throw new GameError('err.loginRequired');
      return user;
    };
    const attach = (room, member) => {
      socket.data.roomCode = room.code;
      socket.data.playerId = member.id;
      socket.join(room.code);
      socket.emit('session', { code: room.code, token: member.token });
      room.setConnected(member.id, true);
    };
    const ctx = () => {
      const room = rooms.get(socket.data.roomCode);
      if (!room || !socket.data.playerId) throw new GameError('err.notInRoom');
      return { room, pid: socket.data.playerId };
    };
    const on = (event, fn) => socket.on(event, (payload = {}, ack) => {
      try {
        const result = fn(payload || {});
        if (typeof ack === 'function') ack({ ok: true, ...(result && typeof result === 'object' ? { result } : {}) });
      } catch (e) {
        if (!(e instanceof GameError)) console.error(e);
        const error = e instanceof GameError ? { key: e.key, params: e.params } : { key: 'err.server', params: {} };
        if (typeof ack === 'function') ack({ ok: false, error });
      }
    });

    on('create', () => {
      const user = me();
      const room = new SpyRoom({ code: newCode(), ...roomOptions() });
      rooms.set(room.code, room);
      attach(room, room.join(user.username, { userId: user.id }));
    });
    on('join', ({ code, spectate }) => {
      const user = me();
      const room = rooms.get(String(code || '').toUpperCase().trim());
      if (!room) throw new GameError('err.roomNotFound');
      attach(room, room.byUser(user.id) || room.join(user.username, { userId: user.id, spectate: !!spectate }));
    });
    on('resume', ({ code, token }) => {
      const room = rooms.get(String(code || '').toUpperCase());
      const member = room?.byToken(token);
      if (!member) throw new GameError('err.sessionExpired');
      attach(room, member);
    });
    voice.attach(socket, ctx, { allowed: voiceAllowed });

    on('leave', () => {
      const { room, pid } = ctx();
      voice.leave(socket);
      socket.leave(room.code);
      socket.data.playerId = null;
      room.leave(pid);
    });
    on('kick', ({ playerId }) => {
      const { room, pid } = ctx();
      room.kick(pid, playerId);
      for (const s of nsp.adapter.rooms.get(room.code) || []) {
        const sock = nsp.sockets.get(s);
        if (sock?.data.playerId === playerId) { voice.leave(sock); sock.data.playerId = null; sock.leave(room.code); sock.emit('kicked'); }
      }
    });

    const act = (event, method, args = () => []) => on(event, p => { const { room, pid } = ctx(); return room[method](pid, ...args(p)); });
    on('settings', p => {
      const { room, pid } = ctx();
      room.updateSettings(pid, p);
      if (!voiceAllowed(room)) voice.closeRoom(room.code);
    });
    act('ready', 'setReady', p => [p.ready]);
    act('watch', 'setSpectating', p => [p.on]);
    act('rename', 'rename', p => [p.playerId, p.name]);
    act('start', 'start');
    act('restart', 'restart');
    act('next', 'next');
    act('ask', 'ask', p => [p.target]);
    act('accuse', 'accuse', p => [p.target]);
    act('voteAccusation', 'voteAccusation', p => [!!p.yes]);
    act('finalVote', 'finalVote', p => [p.target]);
    act('spyGuess', 'spyGuess', p => [p.location]);
    on('react', ({ emoji }) => {
      const { room, pid } = ctx();
      const allowed = ['👍', '👎', '😂', '🤔', '😱', '🤥', '🔥', '💀', '❤️', '👀', '🕵️', '🎯'];
      const owned = users.publicProfile(users.users[room.member(pid)?.userId])?.reactions || [];
      if (!allowed.includes(emoji) && !owned.includes(emoji)) throw new GameError('err.invalidTarget');
      nsp.to(room.code).emit('reaction', { from: pid, emoji });
    });

    socket.on('disconnect', () => {
      const room = rooms.get(socket.data.roomCode);
      if (!room || !socket.data.playerId) return;
      const pid = socket.data.playerId;
      const stillHere = [...(nsp.adapter.rooms.get(room.code) || [])].some(s => nsp.sockets.get(s)?.data.playerId === pid);
      if (!stillHere) room.setConnected(pid, false);
    });
  });

  // the locations, for the client to show (names and roles in both languages)
  app.get('/api/spy/locations', (_req, res) => res.json({ ok: true, locations: LOCATIONS }));

  setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      const anyone = [...room.players, ...room.spectators].some(p => p.connected);
      if (!anyone && now - room.lastActivity > ROOM_IDLE_MS) { room.dispose(); rooms.delete(code); scheduleSave(); }
    }
  }, 30 * 1000).unref();

  // a room as the admin and the "back to my game" button see it
  const summary = room => ({
    game: 'spy', code: room.code, phase: room.phase, lastActivity: room.lastActivity,
    players: room.players.map(p => ({ name: p.name, connected: p.connected })), spectators: room.spectators.length,
  });

  return {
    has: code => rooms.has(code),
    list: () => [...rooms.values()].map(summary),
    info: code => (rooms.has(code) ? summary(rooms.get(code)) : null),
    // the admin switched a feature off: turn it off in every room
    applyFeatures: f => {
      for (const room of rooms.values()) {
        if (!f.voice) { room.settings.voice = false; voice.closeRoom(room.code); }
        room.touch();
      }
    },
    // an empty room for a table's next game: the first one in becomes the host
    create: (tableId = null, settings = null) => {
      const room = new SpyRoom({ code: newCode(), tableId, ...roomOptions() });
      // the table's house rules from last time (only settings this version knows)
      if (settings) for (const k of Object.keys(room.settings)) if (k in settings) room.settings[k] = settings[k];
      rooms.set(room.code, room);
      scheduleSave();
      return room.code;
    },
    userRooms: userId => [...rooms.values()].filter(r => r.byUser(userId)).map(summary),
    sockets: () => [...nsp.sockets.values()],
    // the admin closes a stuck room: everyone in it is sent back to the home screen
    end: code => {
      const room = rooms.get(code);
      if (!room) return false;
      for (const s of nsp.adapter.rooms.get(code) || []) {
        const sock = nsp.sockets.get(s);
        if (!sock) continue;
        voice.leave(sock);
        sock.data.playerId = null;
        sock.leave(code);
        sock.emit('kicked', { closed: true });
      }
      room.dispose();
      rooms.delete(code);
      scheduleSave();
      return true;
    },
    refreshUser: userId => { for (const room of rooms.values()) if (room.byUser(userId)) broadcast(room); },
    shutdown: () => { saveNow(); shuttingDown = true; },
  };
}

module.exports = { attachSpyfall };
