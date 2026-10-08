'use strict';

// Voice chat signalling for both games. Audio goes browser to browser (WebRTC); the server only
// keeps who is in a room's voice chat, relays connection offers between them, and hands out
// STUN/TURN servers. Who may hear whom (Mafia at night, players who are out) is decided by
// each sender's browser from the game state, so a phone never even sends audio it shouldn't.

const crypto = require('crypto');

const SIGNAL_MAX_BYTES = 20000; // an SDP offer is a few KB
const SIGNALS_PER_10S = 200;
const TURN_TTL_S = 12 * 60 * 60;

// STUN always; TURN (relay for strict networks) when the server has a shared secret configured.
function iceServers(userId) {
  const servers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
  const secret = process.env.TURN_SECRET;
  const host = process.env.TURN_HOST;
  if (secret && host) {
    // coturn's "use-auth-secret": username = expiry:user, password = base64(HMAC-SHA1(secret, username))
    const username = `${Math.floor(Date.now() / 1000) + TURN_TTL_S}:${userId}`;
    const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
    servers.push({ urls: [`turn:${host}:3478?transport=udp`, `turn:${host}:3478?transport=tcp`], username, credential });
  }
  return servers;
}

// One per namespace: presence per room code (playerId -> socket id).
function createVoiceHub(nsp) {
  const rooms = new Map(); // code -> Map(pid -> socketId)

  const peersOf = code => [...(rooms.get(code)?.keys() || [])];
  const announce = code => nsp.to(code).emit('voice:peers', { peers: peersOf(code) });

  function leave(socket) {
    const code = socket.data.voiceRoom;
    const pid = socket.data.voicePid;
    if (!code) return;
    const members = rooms.get(code);
    if (members && members.get(pid) === socket.id) members.delete(pid);
    if (members && !members.size) rooms.delete(code);
    socket.data.voiceRoom = socket.data.voicePid = null;
    announce(code);
  }

  // ctx() -> { room, pid } for the socket's current room (throws when not in one)
  function attach(socket, ctx, { onTranscript } = {}) {
    let window = { start: Date.now(), n: 0 };
    const quietAck = ack => typeof ack === 'function' && ack({ ok: true });
    socket.on('voice:join', (_p, ack) => {
      try {
        const { room, pid } = ctx();
        if (socket.data.voiceRoom && socket.data.voiceRoom !== room.code) leave(socket);
        if (!rooms.has(room.code)) rooms.set(room.code, new Map());
        rooms.get(room.code).set(pid, socket.id);
        socket.data.voiceRoom = room.code;
        socket.data.voicePid = pid;
        announce(room.code);
        quietAck(ack);
      } catch {
        if (typeof ack === 'function') ack({ ok: false, error: { key: 'err.notInRoom', params: {} } });
      }
    });
    socket.on('voice:leave', (_p, ack) => { leave(socket); quietAck(ack); });
    socket.on('voice:peers', (_p, ack) => {
      if (typeof ack === 'function') ack({ ok: true, peers: socket.data.voiceRoom ? peersOf(socket.data.voiceRoom) : [] });
    });
    socket.on('voice:signal', ({ to, data } = {}) => {
      const code = socket.data.voiceRoom;
      if (!code || !to) return;
      if (Date.now() - window.start > 10000) window = { start: Date.now(), n: 0 };
      if (++window.n > SIGNALS_PER_10S) return;
      if (JSON.stringify(data || null).length > SIGNAL_MAX_BYTES) return;
      const target = nsp.sockets.get(rooms.get(code)?.get(to));
      if (target) target.emit('voice:signal', { from: socket.data.voicePid, data });
    });
    if (onTranscript) {
      socket.on('voice:transcript', ({ text } = {}, ack) => {
        try {
          const { room, pid } = ctx();
          onTranscript(room, pid, text);
          quietAck(ack);
        } catch (e) {
          if (typeof ack === 'function') ack({ ok: false, quiet: true, error: { key: e.key || 'err.server', params: {} } });
        }
      });
    }
    socket.on('disconnect', () => leave(socket));
  }

  return { attach, leave, peersOf };
}

module.exports = { createVoiceHub, iceServers };
