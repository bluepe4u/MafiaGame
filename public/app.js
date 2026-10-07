'use strict';

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

const AUTH_KEY = 'mafia.auth';
// the login token travels with every (re)connection; after logging in or out we reconnect
const socket = io({ auth: cb => cb({ token: store.get(AUTH_KEY) }) });
const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);
const SESSION_KEY = 'mafia.session';
const ALERTS_KEY = 'mafia.alerts';
const REVEALED_KEY = 'mafia.revealed';
const TAB_KEY = 'mafia.tab';
const NOTES_PREFIX = 'mafia.notes.';
const HOLD_MS = 1500;

let state = null;
let clockOffset = 0; // serverNow - clientNow
let roleShown = false; // true only while the role card is pressed
// room code in the address bar (?room=ABCD): from an invite link, or the room we're in
let urlRoom = (new URLSearchParams(location.search).get('room') || '').toUpperCase().slice(0, 4);

// ---------- utils ----------
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), 3500);
}

function send(event, payload = {}) {
  return new Promise(resolve => {
    socket.emit(event, payload, res => {
      if (res && !res.ok) toast(t(res.error.key, res.error.params));
      resolve(res);
    });
  });
}

function loadSession() {
  try { return JSON.parse(store.get(SESSION_KEY)); } catch { return null; }
}
function saveSession(s) {
  store.set(SESSION_KEY, s ? JSON.stringify(s) : null);
}

function show(screen) {
  for (const id of ['home', 'lobby', 'game']) $('#' + id).classList.toggle('hidden', id !== screen);
}

const playerById = id => state.players.find(p => p.id === id);
const nameOf = id => (playerById(id) || {}).name || '?';
const isHost = () => !!(state && state.me && state.hostId === state.me.id);
const roleName = r => t('role.' + r);
const tagHtml = (key, cls = '') => `<span class="tag ${cls}">${esc(t(key))}</span>`;
// initials on a colour derived from the name, so each player is recognisable at a glance
function avatar(name, url) {
  if (url) return `<img class="avatar" src="${esc(url)}" alt="" loading="lazy">`;
  let h = 0;
  for (const c of name) h = (h * 31 + c.codePointAt(0)) % 360;
  const parts = name.trim().split(/\s+/);
  const initials = (parts.length > 1 ? parts[0][0] + parts[1][0] : [...name].slice(0, 2).join('')).toUpperCase();
  return `<span class="avatar" style="--h:${h}">${esc(initials)}</span>`;
}
// decency status from likes minus dislikes, lowest to highest
const TIER_MIN = [-Infinity, -9, -4, -1, 2, 5, 10];
const tierOf = score => TIER_MIN.findLastIndex(min => (score || 0) >= min);
const statusPill = score => score === null || score === undefined ? '' : `<span class="status t${tierOf(score)}">${esc(t('tier.' + tierOf(score)))}</span>`;
const icon = paths => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
const ICONS = {
  night: icon('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>'),
  speech: icon('<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/><path d="M19 11a7 7 0 0 1-14 0M12 18v3"/>'),
  vote: icon('<path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9"/>'),
  ended: icon('<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>'),
  eye: icon('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/>'),
  bell: icon('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>'),
  bellOff: icon('<path d="M8.7 3A6 6 0 0 1 18 8c0 2.9.5 5 1.2 6.5M17 17H3s3-2 3-9c0-.8.1-1.5.4-2.2"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0M3 3l18 18"/>'),
  check: icon('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  up: icon('<path d="M7 10v11H4V10zM7 10l4-7c1.7 0 2.6 1.2 2.2 2.8L12.5 9H19a2 2 0 0 1 2 2.3l-1.3 7.5A2.5 2.5 0 0 1 17.3 21H7"/>'),
  down: icon('<path d="M17 14V3h3v11zM17 14l-4 7c-1.7 0-2.6-1.2-2.2-2.8L11.5 15H5a2 2 0 0 1-2-2.3l1.3-7.5A2.5 2.5 0 0 1 6.7 3H17"/>'),
};
const progress = (done, total) => `<div class="bar-track"><div class="bar-fill" style="width:${total ? (100 * done / total) : 0}%"></div></div>`;
const roleTag = r => r ? `<span class="tag ${state.roleInfo[r].team}">${esc(roleName(r))}</span>` : '';
// identifies "the moment" a host action was requested for; if it changes, the action is stale
const momentKey = () => state ? `${state.phase}:${state.day}:${state.speech ? state.speech.index : ''}` : '';
const inviteUrl = () => `${location.origin}/?room=${state.code}`;

// ---------- host confirmation (dialog + press-and-hold) ----------
let pending = null;
let hold = null;

function confirmHost({ title, text, event, payload = {} }) {
  pending = { event, payload, key: momentKey() };
  $('#modalTitle').textContent = title;
  $('#modalText').textContent = text;
  resetHold();
  $('#modal').classList.remove('hidden');
  $('#modalCancel').focus(); // Enter/Space on a stray keypress cancels rather than confirms
}

function closeModal() {
  resetHold();
  pending = null;
  $('#modal').classList.add('hidden');
}

function resetHold() {
  if (hold) cancelAnimationFrame(hold.raf);
  hold = null;
  $('.hold-fill').style.width = '0';
}

function startHold() {
  if (hold || !pending) return;
  hold = { start: performance.now(), raf: 0 };
  const step = now => {
    if (!hold) return;
    const p = Math.min(1, (now - hold.start) / HOLD_MS);
    $('.hold-fill').style.width = `${p * 100}%`;
    if (p >= 1) {
      const { event, payload } = pending;
      closeModal();
      send(event, payload);
      return;
    }
    hold.raf = requestAnimationFrame(step);
  };
  hold.raf = requestAnimationFrame(step);
}

const holdBtn = $('#modalHold');
holdBtn.addEventListener('pointerdown', e => { e.preventDefault(); startHold(); });
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) holdBtn.addEventListener(ev, resetHold);
holdBtn.addEventListener('keydown', e => {
  if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); startHold(); }
});
holdBtn.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') resetHold(); });
holdBtn.addEventListener('click', e => e.preventDefault());
$('#modalCancel').onclick = closeModal;
$('#modal').addEventListener('pointerdown', e => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (pending) closeModal();
  closeMarkMenu();
  $('#recap').classList.add('hidden');
});

// ---------- socket ----------
let everConnected = false;
socket.on('connect', () => {
  everConnected = true;
  $('#offline').classList.add('hidden');
  const s = loadSession();
  // an invite link to a different room wins over resuming the old one
  if (s && (!urlRoom || urlRoom === s.code)) {
    socket.emit('resume', s, res => {
      if (!res.ok) { saveSession(null); state = null; render(); }
    });
  }
});
socket.on('disconnect', () => { if (everConnected) $('#offline').classList.remove('hidden'); });
socket.on('session', s => saveSession(s));
socket.on('state', s => {
  clockOffset = s.serverNow - Date.now();
  state = s;
  render();
});
socket.on('kicked', () => {
  leftRoom();
  toast(t('toast.kicked'));
});

function leftRoom() {
  saveSession(null);
  state = null;
  urlRoom = '';
  chatSeen.town = chatSeen.mafia = chatSeen.dead = null;
  chatRendered = '';
  history.replaceState(null, '', '/');
  render();
}

// ---------- home ----------
if (urlRoom) $('#joinCode').value = urlRoom;
$('#createBtn').onclick = () => send('create');
$('#joinBtn').onclick = () => send('join', { code: $('#joinCode').value });
$('#joinCode').addEventListener('keydown', e => { if (e.key === 'Enter') $('#joinBtn').click(); });

// ---------- accounts ----------
let account = null; // { id, username, avatar, likes, dislikes, score } once logged in
let authMode = 'login';

async function api(path, body) {
  const token = store.get(AUTH_KEY);
  try {
    const res = await fetch('/api/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) toast(t(data.error.key, data.error.params));
    return data;
  } catch {
    toast(t('err.server'));
    return { ok: false };
  }
}

function setAccount(user, token) {
  if (token !== undefined) store.set(AUTH_KEY, token);
  account = user;
  // reconnect so the server knows who this socket belongs to
  socket.disconnect().connect();
  renderAccount();
  render();
}

function renderAuthMode() {
  for (const b of $$('[data-auth-mode]')) b.classList.toggle('active', b.dataset.authMode === authMode);
  $('#authSubmit').textContent = t(authMode === 'login' ? 'auth.login' : 'auth.register');
  $('#authPass').autocomplete = authMode === 'login' ? 'current-password' : 'new-password';
}
for (const b of $$('[data-auth-mode]')) b.onclick = () => { authMode = b.dataset.authMode; renderAuthMode(); };
$('#authCard').addEventListener('submit', async e => {
  e.preventDefault();
  const res = await api(authMode, { username: $('#authUser').value, password: $('#authPass').value });
  if (!res.ok) return;
  $('#authPass').value = '';
  setAccount(res.user, res.token);
  toast(t('toast.welcome', { name: res.user.username }), 'info');
});

function renderAccount() {
  $('#authCard').classList.toggle('hidden', !!account);
  $('#playCard').classList.toggle('hidden', !account);
  $('#profileBtn').classList.toggle('hidden', !account);
  if (!account) return;
  $('#profileBtn').innerHTML = avatar(account.username, account.avatar);
  $('#profileBtn').title = t('profile.open');
  $('#homeProfile').innerHTML = `${avatar(account.username, account.avatar)}
    <span class="me-text"><b>${esc(account.username)}</b>${statusPill(account.score)}</span>`;
  $('#profileAvatar').innerHTML = avatar(account.username, account.avatar);
  $('#profileName').textContent = account.username;
  $('#profileStatus').innerHTML = statusPill(account.score);
  $('#profileLikes').innerHTML = `${ICONS.up}${esc(t('profile.likes', { n: account.likes }))}`;
  $('#profileDislikes').innerHTML = `${ICONS.down}${esc(t('profile.dislikes', { n: account.dislikes }))}`;
  const current = tierOf(account.score);
  $('#tierLadder').innerHTML = TIER_MIN.map((min, i) => `<span class="status t${i} ${i === current ? 'current' : ''}">${esc(t('tier.' + i))}</span>`).join('');
}

const openProfile = async () => {
  const res = await api('me'); // fresh likes/dislikes
  if (res.ok) { account = res.user; renderAccount(); }
  $('#profile').classList.remove('hidden');
};
$('#profileBtn').onclick = openProfile;
$('#homeProfile').onclick = openProfile;
$('#profileClose').onclick = () => $('#profile').classList.add('hidden');
$('#profile').addEventListener('pointerdown', e => { if (e.target.id === 'profile') $('#profile').classList.add('hidden'); });
$('#logoutBtn').onclick = async () => {
  await api('logout', {});
  $('#profile').classList.add('hidden');
  setAccount(null, null);
};
$('#passwordForm').addEventListener('submit', async e => {
  e.preventDefault();
  const res = await api('password', { oldPassword: $('#oldPass').value, newPassword: $('#newPass').value });
  if (!res.ok) return;
  store.set(AUTH_KEY, res.token);
  $('#oldPass').value = $('#newPass').value = '';
  toast(t('toast.passwordChanged'), 'info');
});

// Crop to a centred square and shrink to 256px before uploading, so photos stay small.
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      canvas.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL('image/jpeg', 0.86));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}
$('#avatarFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let image;
  try { image = await shrinkImage(file); } catch { toast(t('err.avatarType')); return; }
  const res = await api('avatar', { image });
  if (!res.ok) return;
  account = res.user;
  renderAccount();
  toast(t('toast.photoUpdated'), 'info');
});

(async () => {
  if (!store.get(AUTH_KEY)) { renderAccount(); return; }
  const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${store.get(AUTH_KEY)}` } }).then(r => r.json()).catch(() => null);
  if (res && res.ok) account = res.user;
  else if (res) store.set(AUTH_KEY, null); // expired or logged out elsewhere
  renderAccount();
})();

// ---------- top bar ----------
$('#leaveBtn').onclick = async () => {
  const inGame = state && state.phase !== 'lobby' && state.phase !== 'ended';
  if (inGame && !confirm(t('confirm.leave'))) return;
  await send('leave');
  leftRoom();
};
$('#topRoom').onclick = () => copyInvite();

function phaseTitle() {
  return t('phase.' + state.phase, { n: state.day });
}

function renderTopbar() {
  const inRoom = !!(state && state.me);
  $('#topRoom').classList.toggle('hidden', !inRoom);
  $('#leaveBtn').classList.toggle('hidden', !inRoom);
  $('#topPhase').textContent = inRoom ? phaseTitle() : '';
  $('#topMe').textContent = inRoom ? t(isHost() ? 'ui.playingAsHost' : 'ui.playingAs', { name: state.me.name }) : '';
  if (inRoom) $('#topCode').textContent = state.code;
  renderAlertsBtn();
}

// ---------- invite ----------
async function copyInvite() {
  try {
    await navigator.clipboard.writeText(inviteUrl());
    toast(t('toast.linkCopied'), 'info');
  } catch {}
}
$('#copyLink').onclick = copyInvite;
$('#shareLink').classList.toggle('hidden', !navigator.share);
$('#shareLink').onclick = () => navigator.share({ title: 'Mafia', text: t('share.text', { code: state.code }), url: inviteUrl() }).catch(() => {});

// ---------- turn alerts ----------
let alertsOn = store.get(ALERTS_KEY) !== 'off';
let lastNeed = null;
let audioCtx = null;
let titleBlink = null;

// browsers only allow sound after the user has interacted with the page
document.addEventListener('pointerdown', () => {
  if (!audioCtx && window.AudioContext) audioCtx = new AudioContext();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}, { capture: true });

function renderAlertsBtn() {
  const b = $('#alertsBtn');
  b.innerHTML = alertsOn ? ICONS.bell : ICONS.bellOff;
  b.setAttribute('aria-pressed', String(alertsOn));
  b.title = t('ui.alerts');
  b.setAttribute('aria-label', t('ui.alerts'));
}
$('#alertsBtn').onclick = () => {
  alertsOn = !alertsOn;
  store.set(ALERTS_KEY, alertsOn ? null : 'off');
  renderAlertsBtn();
  if (alertsOn) chime();
};

function chime() {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  [[660, 0], [990, 0.13]].forEach(([freq, at]) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, now + at);
    gain.gain.linearRampToValueAtTime(0.18, now + at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + at + 0.45);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(now + at);
    osc.stop(now + at + 0.5);
  });
}

// What, if anything, the game is waiting on this player for right now.
function needsMe() {
  if (!state || !state.me || !state.me.alive) return null;
  if (state.phase === 'night' && state.night.hasAction && !state.night.myTarget) return { type: 'night', key: `n${state.day}` };
  if (state.phase === 'speech' && state.speech.current === state.me.id) return { type: 'speech', key: `s${state.day}:${state.speech.index}` };
  if (state.phase === 'vote' && !state.votes[state.me.id]) return { type: 'vote', key: `v${state.day}` };
  return null;
}

function updateAlerts() {
  const need = needsMe();
  if (need && need.key !== (lastNeed && lastNeed.key) && alertsOn) {
    chime();
    if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
  }
  lastNeed = need;
  clearInterval(titleBlink);
  if (!need) { document.title = 'Mafia'; return; }
  const msg = `● ${t('alert.' + need.type)}`;
  document.title = msg;
  // blink the tab title so it's noticeable among other tabs
  let on = true;
  titleBlink = setInterval(() => {
    on = !on || !document.hidden;
    document.title = on ? msg : 'Mafia';
  }, 1000);
}

// ---------- lobby ----------
$('#startBtn').onclick = () => confirmHost({
  title: t('host.start.title'),
  text: t('host.start.text', { n: state.players.length }),
  event: 'start',
});
$('#autoRoles').onclick = () => send('settings', { roleCounts: null });
for (const input of $$('[data-role]')) {
  input.addEventListener('change', () => {
    const counts = {};
    for (const i of $$('[data-role]')) counts[i.dataset.role] = parseInt(i.value, 10) || 0;
    send('settings', { roleCounts: counts });
  });
}
$('#speechSeconds').addEventListener('change', e => send('settings', { speechSeconds: parseInt(e.target.value, 10) }));
$('#voteSeconds').addEventListener('change', e => send('settings', { voteSeconds: parseInt(e.target.value, 10) || 0 }));
$('#revealRole').addEventListener('change', e => send('settings', { revealRoleOnDeath: e.target.checked }));
$('#firstNightKill').addEventListener('change', e => send('settings', { firstNightKill: e.target.checked }));

function setIfNotFocused(el, prop, value) {
  if (document.activeElement !== el) el[prop] = value;
}

function renderLobby() {
  $('#shareCode').innerHTML = esc(t('ui.shareCode', { code: '\u0000' })).replace('\u0000', `<strong class="code">${esc(state.code)}</strong>`);
  const qr = `/qr.svg?room=${state.code}`;
  if ($('#inviteQr').getAttribute('src') !== qr) $('#inviteQr').src = qr;
  $('#lobbyCount').textContent = t('ui.lobbyCount', { count: state.players.length, max: state.maxPlayers, min: state.minPlayers });
  const empty = Math.max(0, state.minPlayers - state.players.length);
  $('#lobbyPlayers').innerHTML = state.players.map(p => `
    <li class="${p.connected ? '' : 'offline'}">
      ${avatar(p.name, p.avatar)}
      <span class="pname"><b>${esc(p.name)}</b>${statusPill(p.score)}${p.id === state.hostId ? tagHtml('tag.host', 'host') : ''}${p.id === state.me.id ? tagHtml('tag.you', 'you') : ''}${p.connected ? '' : tagHtml('tag.offline')}</span>
      ${isHost() && p.id !== state.me.id ? `<button class="ghost small" data-kick="${p.id}">${esc(t('ui.remove'))}</button>` : ''}
    </li>`).join('') + `<li class="empty">${esc(t('ui.emptySeat'))}</li>`.repeat(empty);
  for (const b of $$('[data-kick]')) {
    b.onclick = () => confirmHost({
      title: t('host.kick.title', { name: nameOf(b.dataset.kick) }),
      text: t('host.kick.text'),
      event: 'kick',
      payload: { playerId: b.dataset.kick },
    });
  }

  const rc = state.roleCounts;
  const s = state.settings;
  const citizens = Math.max(0, state.players.length - rc.mafia - rc.cop - rc.doctor - rc.hooker);
  $('#setupSummary').innerHTML = [
    t('sum.roles', { ...rc, citizen: citizens, auto: !s.roleCounts }),
    t('sum.speech', { s: s.speechSeconds }),
    s.voteSeconds ? t('sum.vote', { s: s.voteSeconds }) : t('sum.noVoteLimit'),
    t(s.firstNightKill ? 'sum.firstNightKill' : 'sum.noFirstNightKill'),
    t(s.revealRoleOnDeath ? 'sum.reveal' : 'sum.noReveal'),
  ].map(t => `<li>${esc(t)}</li>`).join('');
  const rce = state.roleCountsError;
  $('#roleError').textContent = state.players.length >= state.minPlayers && rce ? t(rce.key, rce.params) : '';

  $('#hostSettings').classList.toggle('hidden', !isHost());
  $('#startBtn').classList.toggle('hidden', !isHost());
  $('#waitHost').classList.toggle('hidden', isHost());
  $('#startBtn').disabled = state.players.length < state.minPlayers || !!state.roleCountsError;
  if (isHost()) {
    for (const i of $$('[data-role]')) setIfNotFocused(i, 'value', rc[i.dataset.role]);
    setIfNotFocused($('#speechSeconds'), 'value', s.speechSeconds);
    setIfNotFocused($('#voteSeconds'), 'value', s.voteSeconds);
    $('#revealRole').checked = s.revealRoleOnDeath;
    $('#firstNightKill').checked = s.firstNightKill;
  }
}

// ---------- private notes & marks (kept in this browser only, per game) ----------
let notes = { gameId: null, marks: {}, notes: {}, pad: '' };

function loadNotes() {
  if (!state.gameId || notes.gameId === state.gameId) return;
  try {
    notes = JSON.parse(store.get(NOTES_PREFIX + state.gameId)) || null;
  } catch { notes = null; }
  notes = { marks: {}, notes: {}, pad: '', ...notes, gameId: state.gameId };
  // notes from earlier games are no use any more
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(NOTES_PREFIX) && k !== NOTES_PREFIX + state.gameId) localStorage.removeItem(k);
    }
  } catch {}
  setIfNotFocused($('#notePad'), 'value', notes.pad);
}

function saveNotes() {
  store.set(NOTES_PREFIX + notes.gameId, JSON.stringify(notes));
}

$('#notePad').addEventListener('input', e => { notes.pad = e.target.value; saveNotes(); });

let markFor = null;
function openMarkMenu(pid, anchor) {
  markFor = pid;
  const menu = $('#markMenu');
  $('#markTitle').textContent = t('mark.title', { name: nameOf(pid) });
  $('#markNote').value = notes.notes[pid] || '';
  for (const b of $$('[data-set-mark]')) b.classList.toggle('active', (notes.marks[pid] || '') === b.dataset.setMark);
  menu.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth, h = menu.offsetHeight;
  // positioned in page coordinates so it scrolls together with the seat
  menu.style.left = `${window.scrollX + Math.min(window.innerWidth - w - 12, Math.max(12, r.left + r.width / 2 - w / 2))}px`;
  menu.style.top = `${window.scrollY + (r.bottom + 8 + h > window.innerHeight ? Math.max(12, r.top - h - 8) : r.bottom + 8)}px`;
}
function closeMarkMenu() {
  markFor = null;
  $('#markMenu').classList.add('hidden');
}
for (const b of $$('[data-set-mark]')) {
  b.onclick = () => {
    if (!markFor) return;
    if (b.dataset.setMark) notes.marks[markFor] = b.dataset.setMark;
    else { delete notes.marks[markFor]; delete notes.notes[markFor]; }
    saveNotes();
    closeMarkMenu();
    renderSeats();
  };
}
$('#markNote').addEventListener('input', e => {
  if (!markFor) return;
  const v = e.target.value.trim();
  if (v) notes.notes[markFor] = v; else delete notes.notes[markFor];
  saveNotes();
  renderSeats();
});
$('#markNote').addEventListener('keydown', e => { if (e.key === 'Enter') closeMarkMenu(); });
document.addEventListener('pointerdown', e => {
  if (markFor && !e.target.closest('#markMenu') && !e.target.closest('[data-mark]')) closeMarkMenu();
});
window.addEventListener('resize', closeMarkMenu);

// ---------- game ----------

// Your role is shown only while you press and hold the card.
const roleCardEl = $('#roleCard');
const peek = on => {
  if (roleShown === on) return;
  roleShown = on;
  if (state && state.me && state.phase !== 'lobby') renderGame();
};
roleCardEl.addEventListener('pointerdown', e => { e.preventDefault(); roleCardEl.setPointerCapture(e.pointerId); peek(true); });
for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) roleCardEl.addEventListener(ev, () => peek(false));
roleCardEl.addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); peek(true); } });
roleCardEl.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') peek(false); });
roleCardEl.addEventListener('contextmenu', e => e.preventDefault());
window.addEventListener('blur', () => peek(false));

function nightPrompt() {
  const me = state.me;
  if (me.role === 'mafia' && !state.night.mafiaKills) {
    return t('night.mafiaNoKill');
  }
  return t('night.prompt.' + me.role);
}

function renderPhasePanel() {
  const me = state.me;
  const panel = $('#phasePanel');

  if (state.phase === 'night') {
    const picked = state.night.myTarget;
    panel.innerHTML = `
      <div class="phase-icon">${ICONS.night}</div>
      <div class="big">${esc(t('night.sleeps'))}</div>
      <div class="prompt">${esc(me.alive ? nightPrompt() : t('night.dead'))}</div>
      ${picked ? `<div class="choice">${esc(t('night.yourChoice', { name: nameOf(picked) }))}<div class="muted small-text">${esc(t('night.canChange'))}</div></div>` : ''}`;
  } else if (state.phase === 'speech') {
    const sp = state.speech;
    const mine = sp.current === me.id;
    const canExtend = isHost() || (mine && !sp.extended);
    panel.innerHTML = `
      <div class="muted small-text">${esc(t('speech.now'))}</div>
      <div class="big">${esc(nameOf(sp.current))}${mine ? ' ' + esc(t('speech.you')) : ''}</div>
      <div class="timer-wrap" id="timerWrap"><div class="timer-ring"></div><div class="timer" id="timer"></div></div>
      ${mine || canExtend ? `<div class="row center">
        ${mine ? `<button id="endSpeech" class="primary">${esc(t('speech.finish'))}</button>` : ''}
        ${canExtend ? `<button id="extendSpeech">${esc(t('speech.extend'))}</button>` : ''}
      </div>` : ''}
      <div class="order">${sp.order.map((pid, i) => `<span class="${i < sp.index ? 'done' : i === sp.index ? 'now' : ''}">${i + 1}. ${esc(nameOf(pid))}</span>`).join('')}</div>`;
    if (mine) $('#endSpeech').onclick = () => send('endSpeech');
    if (canExtend) $('#extendSpeech').onclick = () => send('extendSpeech');
    tickTimer();
  } else if (state.phase === 'vote') {
    const alive = state.players.filter(p => p.alive);
    const voted = Object.keys(state.votes).length;
    const myVote = state.votes[me.id];
    const missing = alive.filter(p => !state.votes[p.id]).map(p => p.name);
    panel.innerHTML = `
      ${state.voteEndsAt
        ? '<div class="timer-wrap small" id="timerWrap"><div class="timer-ring"></div><div class="timer" id="timer"></div></div>'
        : `<div class="phase-icon">${ICONS.vote}</div>`}
      <div class="big">${esc(t('vote.title'))}</div>
      ${progress(voted, alive.length)}
      <div class="muted small-text">${esc(t('vote.status', { voted, total: alive.length }))}</div>
      ${missing.length ? `<div class="waiting-for">${esc(t('vote.waitingFor', { names: missing.join(', ') }))}</div>` : ''}
      ${me.alive ? `<div class="choice">${esc(t('vote.yours', { choice: myVote ? (myVote === 'skip' ? t('vote.skip') : nameOf(myVote)) : '—' }))}</div>
        <button id="skipVote" ${myVote === 'skip' ? 'disabled' : ''}>${esc(t('vote.skipBtn'))}</button>` : `<div class="muted">${esc(t('vote.dead'))}</div>`}`;
    if (me.alive) $('#skipVote').onclick = () => send('vote', { targetId: 'skip' });
    tickTimer();
  } else if (state.phase === 'ended') {
    panel.innerHTML = `
      <div class="phase-icon">${ICONS.ended}</div>
      <div class="winner">${esc(t('end.' + state.winner))}</div>
      <div class="muted">${esc(t('end.revealed'))}</div>
      <button id="openRecap" class="primary">${esc(t('end.recap'))}</button>
      ${me.rateable ? `<div class="muted small-text rate-hint">${esc(t('end.rateHint'))}</div>` : ''}`;
    $('#openRecap').onclick = openRecap;
  }
}

function seatPosition(i, n) {
  // clockwise from the top of an ellipse
  const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
  return { left: 50 + 40 * Math.cos(a), top: 50 + 40 * Math.sin(a) };
}

// the cop's own check results, by player name
function copChecks() {
  const out = {};
  for (const e of state.privateLog) if (e.key === 'log.copResult') out[e.params.name] = e.params.mafia;
  return out;
}

function renderSeats() {
  const me = state.me;
  const night = state.phase === 'night' && state.night.hasAction ? state.night : null;
  const voting = state.phase === 'vote' && me.alive;
  const n = state.players.length;
  const checks = copChecks();

  for (const el of $$('#table .seat')) el.remove();
  const html = state.players.map((p, i) => {
    const mark = notes.marks[p.id];
    const note = notes.notes[p.id];
    const cls = [
      'seat',
      p.alive ? '' : 'dead',
      p.id === me.id ? 'me' : '',
      state.speech && state.speech.current === p.id ? 'speaking' : '',
      (night && night.myTarget === p.id) || (voting && state.votes[me.id] === p.id) ? 'selected' : '',
      mark ? `marked-${mark}` : '',
    ].join(' ');

    const meta = [];
    if (!p.connected) meta.push(t('tag.offline'));
    if (p.id === state.hostId) meta.push(t('tag.host'));
    if (!p.alive) meta.push(t('tag.dead'));
    let extra = '';
    if (night && night.mafiaVotes) {
      const pickers = Object.entries(night.mafiaVotes).filter(([, t]) => t === p.id).map(([m]) => nameOf(m));
      if (pickers.length) extra = t('seat.mafiaPick', { names: pickers.join(', ') });
    }
    if (state.phase === 'vote') {
      const voters = Object.entries(state.votes).filter(([, t]) => t === p.id).map(([v]) => nameOf(v));
      if (voters.length) extra = t('seat.votes', { n: voters.length, names: voters.join(', ') });
    }

    let btn = '';
    if (state.phase === 'ended' && me.rateable && p.rateable && p.id !== me.id) {
      const r = state.myRatings[p.id] || 0;
      btn = `<div class="rate">
        <button class="rate-up ${r === 1 ? 'on' : ''}" data-rate="${p.id}" data-value="1" aria-label="${esc(t('rate.like'))}" aria-pressed="${r === 1}">${ICONS.up}</button>
        <button class="rate-down ${r === -1 ? 'on' : ''}" data-rate="${p.id}" data-value="-1" aria-label="${esc(t('rate.dislike'))}" aria-pressed="${r === -1}">${ICONS.down}</button>
      </div>`;
    } else if (night && night.validTargets.includes(p.id)) {
      btn = `<button data-night="${p.id}">${esc(t('action.' + me.role))}</button>`;
    } else if (voting && p.alive && p.id !== me.id) {
      btn = `<button data-vote="${p.id}">${esc(t('vote.btn'))}</button>`;
    }

    const showRole = p.id !== me.id || roleShown || state.phase === 'ended';
    const checked = p.name in checks && !p.role ? `<span class="tag ${checks[p.name] ? 'mafia' : 'town'}">${esc(t('seat.checked', { result: t(checks[p.name] ? 'cop.mafia' : 'cop.town') }))}</span>` : '';
    const voted = state.phase === 'vote' && state.votes[p.id] ? `<span class="voted" title="${esc(t('seat.voted'))}">${ICONS.check}</span>` : '';
    const markBtn = p.id !== me.id
      ? `<button class="mark-btn ${mark || ''}" data-mark="${p.id}" aria-label="${esc(t('mark.title', { name: p.name }))}"></button>`
      : '';
    const markTag = mark ? `<span class="tag mark-tag ${mark}">${esc(t('mark.short.' + mark))}</span>` : '';
    const pos = seatPosition(i, n);
    return `<div class="${cls}" style="left:${pos.left}%;top:${pos.top}%">
      <span class="num">${p.seat + 1}</span>
      ${markBtn}
      <span class="avatar-wrap" title="${p.score === null ? '' : esc(t('tier.' + tierOf(p.score)))}">${avatar(p.name, p.avatar)}${voted}</span>
      <div class="name">${esc(p.name)}</div>
      ${(showRole && p.role) || meta.length || p.id === me.id || checked || markTag ? `<div class="meta">${p.id === me.id ? tagHtml('tag.you', 'you') : ''}${markTag}${showRole ? roleTag(p.role) : ''}${checked} ${esc(meta.join(' · '))}</div>` : ''}
      ${note ? `<div class="seat-note">${esc(note)}</div>` : ''}
      ${extra ? `<div class="votes">${esc(extra)}</div>` : ''}
      ${btn}
    </div>`;
  }).join('');
  $('#table').insertAdjacentHTML('beforeend', html);

  for (const b of $$('[data-night]')) b.onclick = () => send('nightAction', { targetId: b.dataset.night });
  for (const b of $$('[data-vote]')) b.onclick = () => send('vote', { targetId: b.dataset.vote });
  for (const b of $$('[data-rate]')) {
    b.onclick = () => {
      const v = Number(b.dataset.value);
      send('rate', { targetId: b.dataset.rate, value: state.myRatings[b.dataset.rate] === v ? 0 : v });
    };
  }
  for (const b of $$('[data-mark]')) {
    b.onclick = e => {
      e.stopPropagation();
      if (markFor === b.dataset.mark) closeMarkMenu();
      else openMarkMenu(b.dataset.mark, b);
    };
  }
}

function hostAction(key, event, params = {}) {
  return {
    label: t(`host.${key}.label`, params),
    title: t(`host.${key}.title`, params),
    text: t(`host.${key}.text`, params),
    event,
  };
}

function hostActions() {
  switch (state.phase) {
    case 'night': return [hostAction('endNight', 'forceEndNight')];
    case 'speech': {
      const cur = state.speech.current;
      const list = [];
      if (cur !== state.me.id) {
        list.push(hostAction('endSpeech', 'endSpeech', { name: nameOf(cur) }));
      }
      list.push(hostAction('skipVote', 'skipToVote'));
      return list;
    }
    case 'vote': {
      const alive = state.players.filter(p => p.alive).length;
      const missing = alive - Object.keys(state.votes).length;
      return [hostAction('closeVote', 'forceEndVote', { n: missing })];
    }
    case 'ended': return [hostAction('lobby', 'restart')];
    default: return [];
  }
}

function renderHostPanel() {
  const actions = isHost() ? hostActions() : [];
  $('#hostPanel').classList.toggle('hidden', actions.length === 0);
  $('#hostButtons').innerHTML = actions.map((a, i) => `<button class="danger small" data-host="${i}">${esc(a.label)}…</button>`).join('');
  for (const b of $$('[data-host]')) b.onclick = () => confirmHost(actions[b.dataset.host]);
}

function roleDetails() {
  const me = state.me;
  const allies = me.role === 'mafia'
    ? state.players.filter(p => p.role === 'mafia' && p.id !== me.id).map(p => p.name)
    : [];
  return `
    <div class="role-name">${esc(roleName(me.role))}</div>
    <p>${esc(t('blurb.' + me.role))}</p>
    ${allies.length ? `<p class="allies">${esc(t('ui.fellowMafia', { names: allies.join(', ') }))}</p>` : ''}`;
}

function renderRoleCard() {
  const me = state.me;
  const box = roleCardEl.closest('.role-box');
  box.className = 'card role-box' + (roleShown ? ` revealed ${state.roleInfo[me.role].team}` : '');
  roleCardEl.innerHTML = roleShown
    ? roleDetails() + (me.alive ? '' : tagHtml('tag.dead'))
    : `<div class="role-hidden">${ICONS.eye}<span>${esc(t('ui.roleHidden'))}</span></div>`;
}

// ---------- role reveal at the start of a game ----------
function maybeReveal() {
  const show = state.phase !== 'lobby' && state.phase !== 'ended' && state.gameId && store.get(REVEALED_KEY) !== state.gameId;
  const overlay = $('#reveal');
  if (!show) { overlay.classList.add('hidden'); return; }
  if (!overlay.classList.contains('hidden')) return;
  $('#revealCard').classList.remove('flipped');
  $('#revealDone').classList.add('hidden');
  $('#revealFront').className = `flip-face flip-front ${state.roleInfo[state.me.role].team}`;
  $('#revealFront').innerHTML = `<span class="eyebrow">${esc(t('ui.yourRole'))}</span>${roleDetails()}`;
  overlay.classList.remove('hidden');
}
$('#revealCard').onclick = () => {
  $('#revealCard').classList.add('flipped');
  $('#revealDone').classList.remove('hidden');
};
$('#revealDone').onclick = () => {
  store.set(REVEALED_KEY, state.gameId);
  $('#reveal').classList.add('hidden');
};

// ---------- sidebar tabs: log, votes, notes ----------
let tab = store.get(TAB_KEY) || 'chat';
function renderTabs() {
  for (const b of $$('[data-tab]')) {
    b.classList.toggle('active', b.dataset.tab === tab);
    b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  }
  for (const p of $$('[data-panel]')) p.classList.toggle('hidden', p.dataset.panel !== tab);
}
for (const b of $$('[data-tab]')) b.onclick = () => { tab = b.dataset.tab; store.set(TAB_KEY, tab); renderTabs(); renderChat(); };

// votes grouped by target, biggest first
function groupVotes(votes) {
  const by = {};
  for (const [voter, target] of Object.entries(votes)) (by[target] ||= []).push(voter);
  return Object.entries(by).sort((a, b) => (a[0] === 'skip') - (b[0] === 'skip') || b[1].length - a[1].length);
}

function voteRows(entry) {
  const rows = groupVotes(entry.votes).map(([target, voters]) => `
    <div class="vote-row ${target === entry.out ? 'out' : ''}">
      <span class="vote-target">${target === 'skip' ? esc(t('votes.skip')) : esc(nameOf(target))}<b>${voters.length}</b></span>
      <span class="vote-voters">${voters.map(v => esc(nameOf(v))).join(', ')}</span>
    </div>`);
  return rows.join('');
}

function renderVotesPanel() {
  const entries = state.history.filter(h => h.type === 'vote').slice();
  if (state.phase === 'vote') entries.push({ day: state.day, votes: state.votes, out: null, live: true });
  if (!entries.length) { $('#votesPanel').innerHTML = `<p class="muted small-text">${esc(t('votes.empty'))}</p>`; return; }
  $('#votesPanel').innerHTML = entries.reverse().map(e => `
    <section class="vote-day">
      <div class="vote-day-head">${esc(t('votes.day', { n: e.day }))}${e.live ? `<span class="tag host">${esc(t('votes.live'))}</span>` : ''}
        ${e.out ? `<span class="muted">· ${esc(nameOf(e.out))} ${esc(t('votes.out'))}</span>` : ''}</div>
      ${voteRows(e)}
    </section>`).join('');
}

// ---------- chat: everyone by day, the Mafia at night ----------
$('#lobbyChatSlot').append($('#chatTemplate').content.cloneNode(true));
let chatChannel = 'town';
let chatPhaseKey = null; // switch channel automatically when night falls / day breaks
const chatSeen = { town: null, mafia: null, dead: null }; // messages read, per channel (null: not known yet)
let chatRendered = '';

const chatMessages = ch => (state && state.chat && state.chat[ch]) || [];
const chatVisible = () => !!state && (state.phase === 'lobby' || tab === 'chat');

function chatSection(m) {
  if (m.phase === 'lobby') return t('phase.lobby');
  if (m.phase === 'night') return t('phase.night', { n: m.day });
  if (m.phase === 'ended') return t('phase.ended');
  return t('chat.day', { n: m.day });
}

function chatClosedReason() {
  const me = state.me;
  if (chatChannel === 'dead') return t('chat.closedGraveyard');
  if (chatChannel === 'mafia') return t('chat.closedMafiaDay');
  if (state.phase === 'night') return t('chat.closedNight');
  if (!me.alive) return t('chat.closedDead');
  return '';
}

function placeChat() {
  const slot = state.phase === 'lobby' ? $('#lobbyChatSlot') : $('#gameChatSlot');
  const chat = $('#chat');
  if (chat.parentElement !== slot) slot.append(chat);
}

function renderChat() {
  if (!state || !state.me || !state.chat) return;
  const me = state.me;
  const available = ch => ch === 'town' || state.chat[ch] !== null;
  // night: Mafia players land in their own chat; the dead in the graveyard; otherwise the town chat
  const phaseKey = `${state.phase}:${state.day}:${me.alive}`;
  if (phaseKey !== chatPhaseKey) {
    chatPhaseKey = phaseKey;
    chatChannel = state.chat.canPost.mafia ? 'mafia' : state.chat.canPost.dead ? 'dead' : 'town';
  }
  if (!available(chatChannel)) chatChannel = 'town';

  $('#chatChannels').classList.toggle('hidden', !available('mafia') && !available('dead'));
  for (const b of $$('[data-channel]')) {
    b.classList.toggle('active', b.dataset.channel === chatChannel);
    b.classList.toggle('hidden', !available(b.dataset.channel));
  }

  const list = chatMessages(chatChannel);
  for (const ch of ['town', 'mafia', 'dead']) {
    const n = chatMessages(ch).length;
    // first look after (re)loading: what's there already counts as read; a new game starts a fresh chat
    if (chatSeen[ch] === null || chatSeen[ch] > n) chatSeen[ch] = n;
  }
  if (chatVisible()) chatSeen[chatChannel] = list.length;
  // unread counts on the channel buttons and the Chat tab
  let unreadTotal = 0;
  for (const b of $$('[data-channel]')) {
    const ch = b.dataset.channel;
    const n = Math.max(0, chatMessages(ch).length - chatSeen[ch]);
    unreadTotal += n;
    const badge = b.querySelector('.badge');
    badge.textContent = n > 9 ? '9+' : n;
    badge.classList.toggle('hidden', !n || ch === chatChannel);
  }
  const tabBadge = $('#chatBadge');
  tabBadge.textContent = unreadTotal > 9 ? '9+' : unreadTotal;
  tabBadge.classList.toggle('hidden', !unreadTotal || chatVisible());

  const canPost = state.chat.canPost[chatChannel];
  $('#chatForm').classList.toggle('hidden', !canPost);
  $('#chatClosed').classList.toggle('hidden', canPost);
  $('#chatClosed').textContent = canPost ? '' : chatClosedReason();
  $('#chat').classList.toggle('mafia', chatChannel === 'mafia');
  $('#chat').classList.toggle('dead', chatChannel === 'dead');
  $('#revealBtn').classList.toggle('hidden', !(chatChannel === 'dead' && state.chat.canPost.dead && !me.revealed));

  // re-render the list only when something changed, so scrolling isn't disturbed
  const key = `${chatChannel}:${list.length}:${list.at(-1)?.id}:${lang}`;
  if (key === chatRendered) return;
  chatRendered = key;
  const box = $('#chatList');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  let html = '';
  let section = null;
  let prev = null;
  for (const m of list) {
    const sec = chatSection(m);
    if (sec !== section) { html += `<div class="chat-sep"><span>${esc(sec)}</span></div>`; section = sec; prev = null; }
    if (m.kind === 'reveal') {
      html += `<div class="msg-reveal">${avatar(m.name, (playerById(m.from) || {}).avatar)}<span><b>${esc(m.name)}</b> ${esc(t('chat.revealed'))}</span>${roleTag(m.role)}</div>`;
      prev = null;
      continue;
    }
    const mine = m.from === me.id;
    const grouped = prev && prev.from === m.from && m.at - prev.at < 5 * 60 * 1000;
    const time = new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    html += `<div class="msg ${mine ? 'mine' : ''} ${grouped ? 'grouped' : ''}">
      ${mine || grouped ? '<span class="msg-gap"></span>' : avatar(m.name, (playerById(m.from) || {}).avatar)}
      <div class="msg-body">
        ${mine || grouped ? '' : `<div class="msg-name">${esc(m.name)}</div>`}
        <div class="bubble">${esc(m.text)}<time>${esc(time)}</time></div>
      </div>
    </div>`;
    prev = m;
  }
  const empty = { town: 'chat.empty', mafia: 'chat.emptyMafia', dead: 'chat.emptyDead' }[chatChannel];
  box.innerHTML = html || `<p class="chat-empty">${esc(t(empty))}</p>`;
  if (nearBottom || list.at(-1)?.from === me.id) box.scrollTop = box.scrollHeight;
}

for (const b of $$('[data-channel]')) {
  b.onclick = () => { chatChannel = b.dataset.channel; chatRendered = ''; renderChat(); $('#chatList').scrollTop = 1e9; };
}
$('#revealBtn').onclick = () => send('revealRole');
$('#chatForm').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text) return;
  const res = await send('chat', { channel: chatChannel, text });
  if (res && res.ok) input.value = '';
  input.focus();
});

// ---------- end-of-game recap ----------
function openRecap() {
  const roleOf = id => (playerById(id) || {}).role;
  const roles = state.players.map(p => `<span class="recap-player">${avatar(p.name, p.avatar)}<b>${esc(p.name)}</b>${roleTag(p.role)}</span>`).join('');
  const sections = state.history.map(h => {
    if (h.type === 'night') {
      const lines = [];
      const mafia = h.actions.filter(a => a.role === 'mafia');
      const byTarget = {};
      for (const a of mafia) (byTarget[a.target] ||= []).push(a);
      for (const [target, acts] of Object.entries(byTarget)) {
        const names = acts.map(a => nameOf(a.actor) + (a.blocked ? ` (${t('recap.blocked')})` : '')).join(', ');
        lines.push(['mafia', t('recap.mafia', { names, target: nameOf(target) })]);
      }
      for (const a of h.actions.filter(x => x.role !== 'mafia')) {
        const params = { actor: nameOf(a.actor), target: nameOf(a.target) };
        if (a.role === 'cop') params.result = t(roleOf(a.target) === 'mafia' ? 'cop.mafia' : 'cop.town');
        lines.push([a.role, t('recap.' + a.role, params) + (a.blocked ? ` (${t('recap.blocked')})` : '')]);
      }
      const result = h.killed ? t('recap.killed', { name: nameOf(h.killed) })
        : h.saved ? t('recap.saved', { name: nameOf(h.saved) }) : t('recap.nobody');
      return `<section class="recap-step night">
        <h4>${ICONS.night}${esc(t('recap.night', { n: h.day }))}</h4>
        <ul>${lines.map(([role, text]) => `<li class="r-${role}">${esc(text)}</li>`).join('')}</ul>
        <p class="recap-result ${h.killed ? 'bad' : 'good'}">${esc(result)}</p>
      </section>`;
    }
    return `<section class="recap-step vote">
      <h4>${ICONS.vote}${esc(t('recap.vote', { n: h.day }))}</h4>
      ${voteRows(h)}
      <p class="recap-result ${h.out ? 'bad' : ''}">${esc(h.out ? t('recap.out', { name: nameOf(h.out) }) : t('recap.noneOut'))}</p>
    </section>`;
  }).join('');
  $('#recapBody').innerHTML = `
    <div class="recap-winner">${esc(t('end.' + state.winner))}</div>
    <h3>${esc(t('recap.roles'))}</h3>
    <div class="recap-roles">${roles}</div>
    <div class="recap-steps">${sections}</div>`;
  $('#recap').classList.remove('hidden');
}
$('#recapClose').onclick = () => $('#recap').classList.add('hidden');
$('#recap').addEventListener('pointerdown', e => { if (e.target.id === 'recap') $('#recap').classList.add('hidden'); });

function renderGame() {
  loadNotes();
  renderRoleCard();
  renderPhasePanel();
  renderSeats();
  renderHostPanel();
  renderTabs();
  renderVotesPanel();
  $('#log').innerHTML = state.log.slice().reverse().map(e => `<li>${esc(t(e.key, e.params))}</li>`).join('');
  $('#privateBox').classList.toggle('hidden', state.privateLog.length === 0);
  $('#privateLog').innerHTML = state.privateLog.slice().reverse().map(e => `<li>${esc(t('ui.nightNote', { n: e.day, text: t(e.key, e.params) }))}</li>`).join('');
  maybeReveal();
}

// counts down the current speech, or the vote when it has a time limit
function tickTimer() {
  const el = $('#timer');
  if (!el || !state) return;
  const speech = state.phase === 'speech' && state.speech;
  const endsAt = speech ? speech.endsAt : state.phase === 'vote' && state.voteEndsAt;
  if (!endsAt) return;
  const total = speech ? state.settings.speechSeconds : state.settings.voteSeconds;
  const left = Math.max(0, Math.ceil((endsAt - (Date.now() + clockOffset)) / 1000));
  el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  el.classList.toggle('low', left <= 10);
  const wrap = $('#timerWrap');
  wrap.classList.toggle('low', left <= 10);
  wrap.style.setProperty('--p', Math.min(1, left / total));
}
setInterval(tickTimer, 250);

function render() {
  // a pending host confirmation is void once the game has moved on or the user is no longer host
  if (pending && (!isHost() || pending.key !== momentKey())) {
    closeModal();
    toast(t('toast.hostCancelled'));
  }
  renderTopbar();
  updateAlerts();
  const inRoom = !!(state && state.me);
  document.body.dataset.phase = inRoom ? state.phase : 'home';
  document.body.dataset.winner = (state && state.winner) || '';
  if (inRoom && urlRoom !== state.code) {
    urlRoom = state.code;
    history.replaceState(null, '', `/?room=${state.code}`);
  }
  if (!inRoom || state.phase === 'lobby' || state.phase === 'ended') $('#reveal').classList.add('hidden');
  if (!inRoom || state.phase !== 'ended') $('#recap').classList.add('hidden');
  if (!inRoom) { closeMarkMenu(); return show('home'); }
  placeChat();
  if (state.phase === 'lobby') { show('lobby'); renderLobby(); renderChat(); return; }
  show('game');
  renderGame();
  renderChat();
}

// ---------- language ----------
const langSelect = $('#langSelect');
langSelect.innerHTML = Object.entries(LANGS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
langSelect.value = lang;
langSelect.onchange = () => {
  setLang(langSelect.value);
  applyStaticTranslations();
  renderAuthMode();
  renderAccount();
  render();
};

applyStaticTranslations();
render();
renderAuthMode();
if (!store.get(AUTH_KEY)) $('#authUser').focus();
