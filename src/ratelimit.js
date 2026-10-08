'use strict';

// Per-connection flood protection for socket events: a token bucket for everything, plus a
// minimum gap for events that are only spammy (reactions). Dropped events get an error ack
// (quiet ones say so, and the client shows nothing).

function limitSocket(socket, { burst = 30, perSecond = 12, gaps = { react: 500 } } = {}) {
  let tokens = burst;
  let last = Date.now();
  const lastAt = {};
  socket.use((packet, next) => {
    const event = packet[0];
    const now = Date.now();
    tokens = Math.min(burst, tokens + ((now - last) / 1000) * perSecond);
    last = now;
    const gap = gaps[event];
    const tooSoon = gap && now - (lastAt[event] || 0) < gap;
    if (tokens < 1 || tooSoon) {
      const ack = packet[packet.length - 1];
      if (typeof ack === 'function') ack({ ok: false, quiet: !!tooSoon, error: { key: 'err.slowDown', params: {} } });
      return;
    }
    tokens -= 1;
    if (gap) lastAt[event] = now;
    next();
  });
}

module.exports = { limitSocket };
