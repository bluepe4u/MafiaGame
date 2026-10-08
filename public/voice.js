'use strict';

// Voice chat for both games: push-to-talk (or an open mic) straight between the browsers in a
// room (WebRTC, one connection per pair). The page says who may hear whom (route); a phone only
// sends its audio to people allowed to hear it and mutes anyone it shouldn't hear.
// With the room's transcripts on, each phone also turns its own player's speech into text
// (the browser's speech recognition) and sends the lines to the server.

const Voice = (() => {
  const MODE_KEY = 'voice.mode';
  const MIC = '<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/><path d="M19 11a7 7 0 0 1-14 0M12 18v3"/>';
  const MIC_OFF = '<path d="M9 9v3a3 3 0 0 0 5.1 2.1M15 9.3V6a3 3 0 0 0-5.7-1.3"/><path d="M19 11a7 7 0 0 1-11.3 5.5M5 11a7 7 0 0 0 .5 2.6M12 18v3M3 3l18 18"/>';
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  let cfg = null; // { socket, me(), route(from, to), channel(), transcripts() }
  let joined = false;
  let joining = false;
  let stream = null;
  let track = null;
  let ice = null;
  let present = []; // player ids in the room's voice chat
  let mode = store.get(MODE_KEY) === 'open' ? 'open' : 'ptt';
  let talking = false; // the mic is live right now
  let pttHeld = false;
  let openMuted = false;
  let recog = null;
  let recogWanted = false;
  const peers = new Map(); // pid -> { pc, sender, audio, polite, makingOffer, ignoreOffer, level }
  const levels = new Map(); // pid -> analyser for the "speaking" glow

  // ---------- the dock (bottom corner, only inside a room) ----------
  document.body.insertAdjacentHTML('beforeend', `<div id="voiceDock" class="voice-dock hidden" aria-live="polite"></div>`);
  const dock = document.getElementById('voiceDock');

  let shownKey = '';
  function render() {
    if (!cfg) return;
    const inVoice = present.length;
    // rebuild only when something shown changed: replacing the button mid-press would cut the speaker off
    const key = [joined, joining, inVoice, cfg.channel(), cfg.transcripts(), mode, openMuted, lang].join('|');
    if (key === shownKey && dock.firstElementChild) return;
    shownKey = key;
    if (!joined) {
      dock.innerHTML = `<button class="voice-join" type="button" ${joining ? 'disabled' : ''}>${svgIcon(MIC)}<span>${esc(t('voice.join'))}</span>${inVoice ? `<span class="voice-count">${inVoice}</span>` : ''}</button>`;
      dock.querySelector('.voice-join').onclick = join;
      return;
    }
    const ch = cfg.channel();
    const silent = ch === 'night';
    dock.innerHTML = `
      <div class="voice-row">
        <span class="voice-ch ${ch}">${esc(t('voice.ch.' + ch))}</span>
        ${cfg.transcripts() ? `<span class="voice-rec" title="${esc(t('voice.recHint'))}">● ${esc(t('voice.rec'))}</span>` : ''}
        <span class="voice-count" title="${esc(t('voice.inVoice'))}">${inVoice}</span>
        <button class="ghost small voice-leave" type="button" aria-label="${esc(t('voice.leave'))}" title="${esc(t('voice.leave'))}">×</button>
      </div>
      <button class="voice-talk ${talking ? 'live' : ''} ${mode}" type="button" ${silent ? 'disabled' : ''}>
        ${svgIcon(mode === 'open' && openMuted ? MIC_OFF : MIC)}
        <span>${esc(silent ? t('voice.silentNight') : mode === 'ptt' ? t('voice.hold') : openMuted ? t('voice.unmute') : t('voice.mute'))}</span>
      </button>
      ${mode === 'ptt' && !silent ? `<span class="voice-key muted small-text">${esc(t('voice.holdKey'))}</span>` : ''}
      <div class="voice-modes">
        <button class="${mode === 'ptt' ? 'on' : ''}" data-vmode="ptt" type="button">${esc(t('voice.ptt'))}</button>
        <button class="${mode === 'open' ? 'on' : ''}" data-vmode="open" type="button">${esc(t('voice.open'))}</button>
      </div>`;
    dock.querySelector('.voice-leave').onclick = leave;
    for (const b of dock.querySelectorAll('[data-vmode]')) b.onclick = () => { mode = b.dataset.vmode; store.set(MODE_KEY, mode); openMuted = false; applyMic(); render(); };
    const talk = dock.querySelector('.voice-talk');
    if (mode === 'ptt') {
      talk.addEventListener('pointerdown', e => { e.preventDefault(); talk.setPointerCapture?.(e.pointerId); pttHeld = true; applyMic(); });
      for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) talk.addEventListener(ev, () => { if (pttHeld) { pttHeld = false; applyMic(); } });
    } else {
      talk.onclick = () => { openMuted = !openMuted; applyMic(); render(); };
    }
  }

  // hold V to talk (not while typing)
  document.addEventListener('keydown', e => {
    if (!joined || mode !== 'ptt' || e.code !== 'KeyV' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
    pttHeld = true;
    applyMic();
  });
  document.addEventListener('keyup', e => { if (e.code === 'KeyV' && pttHeld) { pttHeld = false; applyMic(); } });
  window.addEventListener('blur', () => { if (pttHeld) { pttHeld = false; applyMic(); } });

  // ---------- joining and leaving ----------
  async function join() {
    if (joined || joining) return;
    joining = true;
    render();
    try {
      if (!ice) {
        const res = await api('voice/ice');
        ice = res.ok ? res.iceServers : [{ urls: 'stun:stun.l.google.com:19302' }];
      }
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      track = stream.getAudioTracks()[0];
      track.enabled = false;
      if (!audioCtx && window.AudioContext) audioCtx = new AudioContext();
      watchLevel(cfg.me(), stream);
      joined = true;
      cfg.socket.emit('voice:join', {}, res => { if (res && !res.ok) { toast(t(res.error.key)); leave(); } });
    } catch (e) {
      toast(t(e && e.name === 'NotAllowedError' ? 'voice.denied' : 'voice.failed'));
      stream = track = null;
    }
    joining = false;
    applyMic();
    render();
  }

  function leave() {
    joined = false;
    pttHeld = false;
    stopRecognition();
    cfg.socket.emit('voice:leave');
    for (const pid of [...peers.keys()]) dropPeer(pid);
    if (stream) for (const tr of stream.getTracks()) tr.stop();
    stream = track = null;
    levels.clear();
    talking = false;
    render();
    paintSpeaking();
  }

  // ---------- peers (perfect negotiation: the lower id is the polite side) ----------
  function peer(pid) {
    if (peers.has(pid)) return peers.get(pid);
    const pc = new RTCPeerConnection({ iceServers: ice });
    const audio = new Audio();
    audio.autoplay = true;
    const p = { pc, audio, polite: String(cfg.me()) < String(pid), makingOffer: false, ignoreOffer: false, sender: null };
    peers.set(pid, p);
    pc.ontrack = e => {
      const s = e.streams[0] || new MediaStream([e.track]);
      audio.srcObject = s;
      audio.play().catch(() => {});
      watchLevel(pid, s);
      routeAll();
    };
    pc.onicecandidate = e => cfg.socket.emit('voice:signal', { to: pid, data: { candidate: e.candidate } });
    pc.onnegotiationneeded = async () => {
      try {
        p.makingOffer = true;
        await pc.setLocalDescription();
        cfg.socket.emit('voice:signal', { to: pid, data: { description: pc.localDescription } });
      } catch {} finally { p.makingOffer = false; }
    };
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') pc.restartIce?.(); };
    p.sender = pc.addTrack(track, stream);
    return p;
  }

  function dropPeer(pid) {
    const p = peers.get(pid);
    if (!p) return;
    try { p.pc.close(); } catch {}
    p.audio.srcObject = null;
    peers.delete(pid);
    levels.delete(pid);
  }

  async function onSignal({ from, data }) {
    if (!joined || !data || !present.includes(from)) return;
    const p = peer(from);
    const pc = p.pc;
    try {
      if (data.description) {
        const collision = data.description.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
        p.ignoreOffer = !p.polite && collision;
        if (p.ignoreOffer) return;
        await pc.setRemoteDescription(data.description);
        if (data.description.type === 'offer') {
          await pc.setLocalDescription();
          cfg.socket.emit('voice:signal', { to: from, data: { description: pc.localDescription } });
        }
      } else if (data.candidate !== undefined) {
        try { await pc.addIceCandidate(data.candidate); } catch (e) { if (!p.ignoreOffer) throw e; }
      }
    } catch (e) { console.warn('voice signal', e); }
  }

  function onPeers({ peers: list }) {
    present = list || [];
    if (joined) {
      for (const pid of present) if (pid !== cfg.me()) peer(pid);
      for (const pid of [...peers.keys()]) if (!present.includes(pid)) dropPeer(pid);
      routeAll();
    }
    render();
  }

  // ---------- who hears whom ----------
  // Send my audio only to people allowed to hear me; mute people I'm not allowed to hear.
  function routeAll() {
    if (!joined) return;
    const me = cfg.me();
    for (const [pid, p] of peers) {
      const send = cfg.route(me, pid) ? track : null;
      if (p.sender && p.sender.track !== send) p.sender.replaceTrack(send).catch(() => {});
      p.audio.muted = !cfg.route(pid, me);
    }
  }

  function applyMic() {
    const silent = cfg && cfg.channel() === 'night';
    talking = !!(joined && track && !silent && (mode === 'ptt' ? pttHeld : !openMuted));
    if (track) track.enabled = talking;
    dock.querySelector('.voice-talk')?.classList.toggle('live', talking);
    if (talking && cfg.transcripts()) startRecognition(); else stopRecognition();
  }

  // ---------- transcripts: this phone's own speech, as text ----------
  function startRecognition() {
    recogWanted = true;
    if (!Recognition || recog) return;
    recog = new Recognition();
    recog.lang = lang === 'ru' ? 'ru-RU' : 'en-US';
    recog.continuous = true;
    recog.interimResults = false;
    recog.onresult = e => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal && r[0].transcript.trim()) cfg.socket.emit('voice:transcript', { text: r[0].transcript.trim() }, () => {});
      }
    };
    recog.onend = () => {
      recog = null;
      if (recogWanted && talking) startRecognition(); // the browser stops after a pause: keep going
    };
    recog.onerror = () => {};
    try { recog.start(); } catch { recog = null; }
  }

  function stopRecognition() {
    recogWanted = false;
    // let it finish the last phrase (push-to-talk release), then it ends on its own
    if (recog) try { recog.stop(); } catch {}
  }

  // ---------- the "speaking" glow on avatars ----------
  function watchLevel(pid, s) {
    if (!audioCtx) return;
    try {
      const src = audioCtx.createMediaStreamSource(s);
      const an = audioCtx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      levels.set(pid, { an, buf: new Uint8Array(an.fftSize), on: false });
    } catch {}
  }
  function paintSpeaking() {
    const speaking = new Set();
    for (const [pid, l] of levels) {
      l.an.getByteTimeDomainData(l.buf);
      let sum = 0;
      for (const v of l.buf) sum += (v - 128) ** 2;
      const rms = Math.sqrt(sum / l.buf.length);
      const muted = pid === cfg.me() ? !talking : peers.get(pid)?.audio.muted;
      if (rms > 6 && !muted) speaking.add(pid);
    }
    for (const el of document.querySelectorAll('.speaking')) if (!speaking.has(el.dataset.pid || el.dataset.token)) el.classList.remove('speaking');
    for (const pid of speaking) for (const el of document.querySelectorAll(`[data-pid="${pid}"], [data-token="${pid}"]`)) el.classList.add('speaking');
  }
  setInterval(() => { if (joined && levels.size) paintSpeaking(); }, 150);

  // ---------- page API ----------
  return {
    init(options) {
      cfg = options;
      cfg.socket.on('voice:peers', onPeers);
      cfg.socket.on('voice:signal', onSignal);
      // the host or the admin turned voice off for this room
      cfg.socket.on('voice:off', () => { if (joined) leave(); present = []; render(); });
      // after a reconnect the server has forgotten us: join again
      cfg.socket.on('connect', () => { if (joined) cfg.socket.emit('voice:join', {}); });
    },
    // call on every render: show the dock in a room, re-check who hears whom
    update(inRoom) {
      if (!cfg) return;
      dock.classList.toggle('hidden', !inRoom);
      if (!inRoom) { if (joined) leave(); present = []; return; }
      if (!present.length && !this.asked) { this.asked = true; cfg.socket.emit('voice:peers', {}, r => r && r.ok && onPeers(r)); }
      routeAll();
      applyMic();
      render();
    },
    resetRoom() { this.asked = false; present = []; },
    get joined() { return joined; },
    // for troubleshooting from the console: Voice.status()
    status: () => [...peers].map(([pid, p]) => ({ pid, state: p.pc.connectionState, sending: !!(p.sender && p.sender.track), muted: p.audio.muted, talking })),
  };
})();
