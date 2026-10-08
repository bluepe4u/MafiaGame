'use strict';

// Monopoly on the shared server: its own Socket.IO namespace (/monopoly) and room list, the
// same accounts as Mafia. Rooms are saved to monopoly-rooms.json so restarts don't end games.

const fs = require('fs');
const path = require('path');
const { MonoRoom } = require('./game');
const { GameError } = require('../game');

const ROOM_IDLE_MS = 60 * 60 * 1000;

function attachMonopoly({ io, app, users, api, currentUser, dataDir, codeTaken }) {
  const nsp = io.of('/monopoly');
  const rooms = new Map(); // code -> MonoRoom
  const stateFile = path.join(dataDir, 'monopoly-rooms.json');
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
      console.error('Saving Monopoly rooms failed:', e.message);
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
    onGameEnd: results => users.recordMonoGame(results),
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
      try { rooms.set(data.code, MonoRoom.restore(data, roomOptions())); } catch (e) { console.error(`Could not restore Monopoly room ${data.code}:`, e.message); }
    }
    console.log(`Restored ${rooms.size} Monopoly room(s)`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Could not read Monopoly rooms:', e.message);
  }

  nsp.use((socket, next) => {
    socket.data.userId = users.byToken(socket.handshake.auth?.token)?.id || null;
    next();
  });

  nsp.on('connection', socket => {
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
      const room = new MonoRoom({ code: newCode(), ...roomOptions() });
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
    on('leave', () => {
      const { room, pid } = ctx();
      socket.leave(room.code);
      socket.data.playerId = null;
      room.leave(pid);
    });
    on('kick', ({ playerId }) => {
      const { room, pid } = ctx();
      room.kick(pid, playerId);
      for (const s of nsp.adapter.rooms.get(room.code) || []) {
        const sock = nsp.sockets.get(s);
        if (sock?.data.playerId === playerId) { sock.data.playerId = null; sock.leave(room.code); sock.emit('kicked'); }
      }
    });

    const act = (event, method, args = () => []) => on(event, p => { const { room, pid } = ctx(); return room[method](pid, ...args(p)); });
    act('settings', 'updateSettings', p => [p]);
    act('ready', 'setReady', p => [p.ready]);
    act('watch', 'setSpectating', p => [p.on]);
    act('piece', 'setPiece', p => [p.piece]);
    act('rename', 'rename', p => [p.playerId, p.name]);
    act('start', 'start');
    act('restart', 'restart');
    act('roll', 'roll');
    act('buy', 'buy');
    act('decline', 'decline');
    act('bid', 'bid', p => [p.amount]);
    act('endTurn', 'endTurn');
    act('payBail', 'payBail');
    act('useJailCard', 'useJailCard');
    act('build', 'buildHouse', p => [Number(p.square)]);
    act('sell', 'sellHouse', p => [Number(p.square)]);
    act('mortgage', 'mortgage', p => [Number(p.square)]);
    act('unmortgage', 'unmortgage', p => [Number(p.square)]);
    act('payDebt', 'payDebt');
    act('bankrupt', 'declareBankruptcy');
    act('resign', 'resign');
    on('trade', p => { const { room, pid } = ctx(); room.proposeTrade(pid, p); });
    act('tradeRespond', 'respondTrade', p => [p.id, !!p.accept]);
    on('react', ({ emoji }) => {
      const { room, pid } = ctx();
      const allowed = ['👍', '👎', '😂', '🤔', '😱', '🤥', '🔥', '💀', '❤️', '👀', '💸', '🏠', '🎲'];
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

  // the board itself, for the client to draw
  const { SQUARES, GROUPS, RAILWAY_RENT } = require('./board');
  app.get('/api/mono/board', (_req, res) => res.json({ ok: true, squares: SQUARES, groups: GROUPS, railwayRent: RAILWAY_RENT }));

  // stats pages
  app.get('/api/mono/leaderboard', api(req => {
    currentUser(req);
    return { users: Object.values(users.users).map(u => users.publicProfile(u)) };
  }));

  setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      room.expireTrades();
      const anyone = [...room.players, ...room.spectators].some(p => p.connected);
      if (!anyone && now - room.lastActivity > ROOM_IDLE_MS) { room.dispose(); rooms.delete(code); scheduleSave(); }
    }
  }, 30 * 1000).unref();

  return {
    has: code => rooms.has(code),
    refreshUser: userId => { for (const room of rooms.values()) if (room.byUser(userId)) broadcast(room); },
    shutdown: () => { saveNow(); shuttingDown = true; },
  };
}

module.exports = { attachMonopoly };
