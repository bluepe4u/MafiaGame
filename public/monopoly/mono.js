'use strict';

// Monopoly client. Same accounts as Mafia (shared login token), its own Socket.IO namespace.

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};
const AUTH_KEY = 'mafia.auth'; // shared with Mafia: one login for the whole site
const SESSION_KEY = 'mono.session';
const SOUND_KEY = 'mafia.alerts';
const TAB_KEY = 'mono.tab';
const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => `${Math.round(n).toLocaleString('ru-RU')} ₽`;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const socket = io('/monopoly', { auth: cb => cb({ token: store.get(AUTH_KEY) }) });

let state = null;
let account = null;
let BOARD = null; // { squares, groups, railwayRent }
let clockOffset = 0;
let urlRoom = (new URLSearchParams(location.search).get('room') || '').toUpperCase().slice(0, 4);

function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), 3500);
}

function send(event, payload = {}) {
  return new Promise(resolve => {
    socket.emit(event, payload, res => {
      if (res && !res.ok) toast(t(res.error.key, res.error.params));
      resolve(res);
    });
  });
}

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

// ---------- shared look: avatars, cosmetics, decency status ----------
let ITEMS = {};
fetch('/api/items').then(r => r.json()).then(d => { ITEMS = d.items || {}; render(); }).catch(() => {});
const nameCls = cos => (cos && cos.name ? `nm ${cos.name.replace('.', '-')}` : '');
function avatarCore(name, url) {
  if (url) return `<img class="avatar" src="${esc(url)}" alt="" loading="lazy">`;
  let h = 0;
  for (const c of name) h = (h * 31 + c.codePointAt(0)) % 360;
  const parts = name.trim().split(/\s+/);
  const initials = (parts.length > 1 ? parts[0][0] + parts[1][0] : [...name].slice(0, 2).join('')).toUpperCase();
  return `<span class="avatar" style="--h:${h}">${esc(initials)}</span>`;
}
function avatar(name, url, cos) {
  const inner = avatarCore(name, url);
  const hat = cos && cos.hat && ITEMS[cos.hat]
    ? `<span class="hat"><svg viewBox="0 0 10 10" aria-hidden="true"><text x="5" y="8.6" font-size="8.6" text-anchor="middle">${ITEMS[cos.hat].emoji}</text></svg></span>` : '';
  const frame = cos && cos.frame ? cos.frame.replace('.', '-') : '';
  return hat || frame ? `<span class="cos ${frame}">${inner}${hat}</span>` : inner;
}
const TIER_MIN = [-Infinity, -9, -4, -1, 2, 5, 10];
const tierOf = score => TIER_MIN.findLastIndex(min => (score || 0) >= min);
const statusPill = score => score === null || score === undefined ? '' : `<span class="status t${tierOf(score)}">${esc(t('tier.' + tierOf(score)))}</span>`;

// ---------- site switcher (top-left menu) ----------
$('#brandBtn').onclick = e => { e.stopPropagation(); $('#siteMenu').classList.toggle('hidden'); };
document.addEventListener('pointerdown', e => { if (!e.target.closest('.brand-switch')) $('#siteMenu').classList.add('hidden'); });

// ---------- sound ----------
let soundOn = store.get(SOUND_KEY) !== 'off';
let audioCtx = null;
document.addEventListener('pointerdown', () => {
  if (!audioCtx && window.AudioContext) audioCtx = new AudioContext();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}, { capture: true });
function tone(f, at = 0, dur = 0.15, type = 'triangle', vol = 0.06) {
  if (!soundOn || !audioCtx) return;
  const now = audioCtx.currentTime + at;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.value = f;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(vol, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0008, now + dur);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(now);
  osc.stop(now + dur + 0.05);
}
const SFX = {
  dice: () => { for (let i = 0; i < 6; i++) tone(180 + Math.random() * 260, i * 0.05, 0.05, 'square', 0.03); },
  coin: () => { tone(988, 0, 0.12); tone(1319, 0.08, 0.3); },
  pay: () => { tone(392, 0, 0.18, 'sine', 0.07); tone(294, 0.1, 0.25, 'sine', 0.06); },
  turn: () => { tone(660, 0, 0.12); tone(880, 0.1, 0.25); },
  win: () => [523, 659, 784, 1046].forEach((f, i) => tone(f, i * 0.1, 0.5)),
};
function renderSoundBtn() {
  const b = $('#soundBtn');
  b.innerHTML = soundOn ? '🔔' : '🔕';
  b.setAttribute('aria-pressed', String(soundOn));
}
$('#soundBtn').onclick = () => { soundOn = !soundOn; store.set(SOUND_KEY, soundOn ? null : 'off'); renderSoundBtn(); if (soundOn) SFX.turn(); };

// ---------- accounts (same as the Mafia side) ----------
let authMode = 'login';
function renderAuthMode() {
  for (const b of $$('[data-auth-mode]')) b.classList.toggle('active', b.dataset.authMode === authMode);
  $('#authSubmit').textContent = t(authMode === 'login' ? 'auth.login' : 'auth.register');
}
for (const b of $$('[data-auth-mode]')) b.onclick = () => { authMode = b.dataset.authMode; renderAuthMode(); };
$('#authCard').addEventListener('submit', async e => {
  e.preventDefault();
  const res = await api(authMode, { username: $('#authUser').value, password: $('#authPass').value });
  if (!res.ok) return;
  $('#authPass').value = '';
  store.set(AUTH_KEY, res.token);
  account = res.user;
  socket.disconnect().connect();
  renderAccount();
  render();
});
function renderAccount() {
  $('#authCard').classList.toggle('hidden', !!account);
  $('#playCard').classList.toggle('hidden', !account);
  $('#profileBtn').classList.toggle('hidden', !account);
  $('#boardBtn').classList.toggle('hidden', !account);
  if (!account) return;
  $('#profileBtn').innerHTML = avatar(account.username, account.avatar, account.equipped);
  $('#homeProfile').innerHTML = `${avatar(account.username, account.avatar, account.equipped)}
    <span class="me-text"><b class="${nameCls(account.equipped)}">${esc(account.username)}</b>${statusPill(account.score)}</span>`;
}
$('#profileBtn').onclick = () => account && openPlayer(account.id);
$('#homeProfile').onclick = () => account && openPlayer(account.id);
(async () => {
  if (store.get(AUTH_KEY)) {
    const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${store.get(AUTH_KEY)}` } }).then(r => r.json()).catch(() => null);
    if (res && res.ok) account = res.user;
    else if (res) store.set(AUTH_KEY, null);
  }
  renderAccount();
  if (!account) $('#authUser').focus();
})();

// ---------- board data ----------
fetch('/api/mono/board').then(r => r.json()).then(d => { BOARD = d; buildBoard(); render(); });
// full names (title deeds, log) and short ones (drawn on the board)
const sqName = i => (BOARD ? (lang === 'ru' ? BOARD.squares[i].name : BOARD.squares[i].en) : `#${i}`);
const sqShort = i => (BOARD ? (lang === 'ru' ? BOARD.squares[i].short : BOARD.squares[i].shortEn) : `#${i}`);

// ---------- socket ----------
let everConnected = false;
socket.on('connect', () => {
  everConnected = true;
  $('#offline').classList.add('hidden');
  let s = null;
  try { s = JSON.parse(store.get(SESSION_KEY)); } catch {}
  if (s && (!urlRoom || urlRoom === s.code)) {
    socket.emit('resume', s, res => { if (!res.ok) { store.set(SESSION_KEY, null); state = null; render(); } });
  }
});
socket.on('disconnect', () => { if (everConnected) $('#offline').classList.remove('hidden'); });
socket.on('session', s => store.set(SESSION_KEY, JSON.stringify(s)));
socket.on('state', s => {
  clockOffset = s.serverNow - Date.now();
  const prev = state;
  state = s;
  fxOnState(prev, s);
  render();
});
socket.on('kicked', () => { leftRoom(); toast(t('toast.kicked')); });
function leftRoom() {
  store.set(SESSION_KEY, null);
  state = null;
  urlRoom = '';
  history.replaceState(null, '', '/monopoly/');
  render();
}

// ---------- home ----------
if (urlRoom) $('#joinCode').value = urlRoom;
$('#createBtn').onclick = () => send('create');
$('#joinBtn').onclick = () => send('join', { code: $('#joinCode').value });
$('#watchBtn').onclick = () => send('join', { code: $('#joinCode').value, spectate: true });
$('#joinCode').addEventListener('keydown', e => { if (e.key === 'Enter') $('#joinBtn').click(); });
$('#leaveBtn').onclick = async () => {
  if (state && state.phase === 'playing' && !state.me.spectator && !confirm(t('mono.confirmResign'))) return;
  await send('leave');
  leftRoom();
};
$('#topRoom').onclick = async () => {
  try { await navigator.clipboard.writeText(`${location.origin}/monopoly/?room=${state.code}`); toast(t('toast.linkCopied'), 'info'); } catch {}
};
$('#copyLink').onclick = () => $('#topRoom').click();

// ---------- helpers on the game state ----------
const isHost = () => !!(state && state.me && state.hostId === state.me.id);
const member = id => state && [...state.players, ...state.spectators].find(p => p.id === id);
const nameOf = id => (member(id) || {}).name || '?';
const gp = id => state.game.players[id];
const PALETTE = ['#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#ec4899', '#14b8a6', '#f97316'];
// each player's colour is their piece (picked in the lobby)
const colorOf = id => {
  const piece = (member(id) || {}).piece;
  if (piece && piece.startsWith('#')) return piece;
  const i = state.game ? state.game.order.indexOf(id) : state.players.findIndex(p => p.id === id);
  return PALETTE[Math.max(0, i) % 8];
};
// a player's piece: their avatar in a ring of their colour
const pieceOf = id => {
  const p = member(id) || { name: '?' };
  return `<span class="pc-ring" style="--pc:${colorOf(id)}">${avatarCore(p.name, p.avatar)}</span>`;
};
const dot = id => `<span class="pdot" style="--pc:${colorOf(id)}"></span>`;
const owned = pid => Object.entries(state.game.props).filter(([, p]) => p.owner === pid).map(([sq]) => Number(sq));

// ---------- render ----------
function show(screen) {
  for (const id of ['home', 'lobby', 'game']) $('#' + id).classList.toggle('hidden', id !== screen);
}

function render() {
  const inRoom = !!(state && state.me);
  document.body.dataset.phase = inRoom ? state.phase : 'home';
  $('#topRoom').classList.toggle('hidden', !inRoom);
  $('#leaveBtn').classList.toggle('hidden', !inRoom);
  if (inRoom) $('#topCode').textContent = state.code;
  $('#topRound').textContent = inRoom && state.game ? t('mono.round', { n: state.game.round }) : '';
  if (inRoom && urlRoom !== state.code) { urlRoom = state.code; history.replaceState(null, '', `/monopoly/?room=${state.code}`); }
  renderReactBar();
  if (!inRoom) return show('home');
  if (state.phase === 'lobby') { show('lobby'); return renderLobby(); }
  show('game');
  renderGame();
}

// ---------- lobby ----------
for (const input of $$('[data-rule]')) input.addEventListener('change', () => send('settings', { [input.dataset.rule]: input.checked }));
$('#startingCash').addEventListener('change', e => send('settings', { startingCash: parseInt(e.target.value, 10) }));
$('#turnSeconds').addEventListener('change', e => send('settings', { turnSeconds: parseInt(e.target.value, 10) || 0 }));
$('#startBtn').onclick = () => send('start');
$('#readyBtn').onclick = () => {
  const mine = state.players.find(p => p.id === state.me.id);
  send('ready', { ready: !(mine && mine.ready) });
};
$('#watchToggle').onclick = () => send('watch', { on: !state.me.spectator });
const setIfNotFocused = (el, v) => { if (document.activeElement !== el) el.value = v; };

function renderLobby() {
  const s = state.settings;
  $('#lobbyCount').textContent = `${state.players.length}/${state.maxPlayers}`;
  $('#lobbyPlayers').innerHTML = state.players.map(p => `
    <li class="${p.connected ? '' : 'offline'} ${p.ready ? 'is-ready' : ''}" data-pid="${p.id}">
      <span class="avatar-wrap clickable pc-wrap" style="--pc:${colorOf(p.id)}" data-open-player="${p.userId || ''}">${avatar(p.name, p.avatar, p.cos)}${p.ready ? '<span class="voted ready-mark">✓</span>' : ''}</span>
      <span class="pname"><b class="${nameCls(p.cos)}">${esc(p.name)}</b>${statusPill(p.score)}${p.id === state.hostId ? `<span class="tag host">${esc(t('tag.host'))}</span>` : ''}</span>
      ${isHost() && p.id !== state.me.id ? `<button class="ghost small" data-kick="${p.id}">${esc(t('ui.remove'))}</button>` : ''}
    </li>`).join('');
  for (const b of $$('#lobby [data-kick]')) b.onclick = () => send('kick', { playerId: b.dataset.kick });
  for (const el of $$('#lobby [data-open-player]')) if (el.dataset.openPlayer) el.onclick = () => openPlayer(el.dataset.openPlayer);
  const mine = state.players.find(p => p.id === state.me.id);
  const readyN = state.players.filter(p => p.ready).length;
  $('#readyCount').textContent = t('ui.readyCount', { n: readyN, total: state.players.length });
  $('#readyBtn').classList.toggle('hidden', !mine);
  $('#readyBtn').classList.toggle('on', !!(mine && mine.ready));
  $('#readyBtn').innerHTML = `✓ <span>${esc(t(mine && mine.ready ? 'ui.ready' : 'ui.unready'))}</span>`;
  $('#watchToggle').textContent = t(state.me.spectator ? 'ui.playInstead' : 'ui.watchInstead');
  $('#pieceBox').classList.toggle('hidden', !mine);
  const taken = new Set(state.players.filter(p => p.id !== state.me.id).map(p => p.piece));
  $('#pieces').innerHTML = state.tokens.map(tk => `<button class="swatch ${mine && mine.piece === tk ? 'on' : ''}" style="--pc:${tk}" data-piece="${tk}" ${taken.has(tk) ? 'disabled' : ''} aria-label="${tk}"></button>`).join('');
  for (const b of $$('[data-piece]')) b.onclick = () => send('piece', { piece: b.dataset.piece });
  $('#spectatorBox').classList.toggle('hidden', !state.spectators.length);
  $('#spectatorList').innerHTML = state.spectators.map(w => `<span class="spectator">${avatar(w.name, w.avatar, w.cos)}<b>${esc(w.name)}</b></span>`).join('');
  $('#shareCode').innerHTML = esc(t('ui.shareCode', { code: '\u0000' })).replace('\u0000', `<strong class="code">${esc(state.code)}</strong>`);
  const qr = `/qr.svg?room=${state.code}&game=mono`;
  if ($('#inviteQr').getAttribute('src') !== qr) $('#inviteQr').src = qr;

  $('#setupSummary').innerHTML = [
    `${t('mono.startingCash')}: ${money(s.startingCash)}`,
    s.turnSeconds ? `${t('mono.turnTime').split('(')[0].trim()}: ${s.turnSeconds} s` : t('mono.turnTime').split('(')[0].trim() + ': ∞',
    ...['doubleGo', 'auctions', 'freeParking', 'noRentInJail'].filter(k => s[k]).map(k => t('mono.rule.' + k)),
  ].map(x => `<li>${esc(x)}</li>`).join('');
  $('#hostSettings').classList.toggle('hidden', !isHost());
  $('#startBtn').classList.toggle('hidden', !isHost());
  $('#waitHost').classList.toggle('hidden', isHost());
  $('#startBtn').disabled = state.players.length < state.minPlayers;
  $('#startBtn').textContent = state.players.length < state.minPlayers ? t('mono.needPlayers', { n: state.minPlayers }) : `${t('mono.start')} · ${t('ui.readyCount', { n: readyN, total: state.players.length })}`;
  if (isHost()) {
    setIfNotFocused($('#startingCash'), s.startingCash);
    setIfNotFocused($('#turnSeconds'), s.turnSeconds);
    for (const input of $$('[data-rule]')) input.checked = !!s[input.dataset.rule];
  }
}

// ---------- the board ----------
// Grid position of square i on an 11×11 board, GO in the bottom-right corner.
function gridPos(i) {
  if (i === 0) return [11, 11, 'corner'];
  if (i < 10) return [11, 11 - i, 'bottom'];
  if (i === 10) return [11, 1, 'corner'];
  if (i < 20) return [21 - i, 1, 'left'];
  if (i === 20) return [1, 1, 'corner'];
  if (i < 30) return [1, i - 19, 'top'];
  if (i === 30) return [1, 11, 'corner'];
  return [i - 29, 11, 'right'];
}
// thin line icons, drawn in the cell's colour
const svg = (paths, extra = '') => `<svg class="sq-svg" viewBox="0 0 24 24" aria-hidden="true" ${extra}>${paths}</svg>`;
const ICONS = {
  go: svg('<path d="M4 12h13M12 6l6 6-6 6"/>'),
  jail: svg('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 4v16M15 4v16M4 12h16"/>'),
  parking: svg('<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M10 17V8h3.5a2.5 2.5 0 0 1 0 5H10"/>'),
  gotojail: svg('<circle cx="8" cy="15" r="3.2"/><circle cx="16" cy="15" r="3.2"/><path d="M8 11.8V8a4 4 0 0 1 8 0v3.8"/>'),
  chance: svg('<path d="M9 9a3 3 0 1 1 4 2.8c-.8.4-1 1-1 1.7V15"/><circle cx="12" cy="18.5" r=".6" fill="currentColor"/>'),
  chest: svg('<rect x="3" y="9" width="18" height="11" rx="2"/><path d="M3 13h18M5 9V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2"/><rect x="10.5" y="11.5" width="3" height="3" rx=".6"/>'),
  tax: svg('<path d="M9 20V5h4.5a3.5 3.5 0 0 1 0 7H7M7 16h7"/>'),
  railway: svg('<rect x="6" y="3" width="12" height="13" rx="3"/><path d="M6 10h12M9 20l-2 2M15 20l2 2M9 16l-1 4M15 16l1 4"/><circle cx="9.5" cy="13" r=".7" fill="currentColor"/><circle cx="14.5" cy="13" r=".7" fill="currentColor"/>'),
  electric: svg('<path d="M13 2 5 13.5h6L10 22l8-11.5h-6z"/>'),
  water: svg('<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
};
const iconFor = (sq, i) => ICONS[sq.type] || (sq.type === 'utility' ? (i === 12 ? ICONS.electric : ICONS.water) : '');

function buildBoard() {
  if (!BOARD) return;
  $('#squares').innerHTML = BOARD.squares.map((sq, i) => {
    const [row, col, side] = gridPos(i);
    const icon = sq.group ? '' : iconFor(sq, i);
    return `<button class="sq ${side} t-${sq.type} ${sq.group ? 'g-' + sq.group : ''}" style="grid-row:${row};grid-column:${col}" data-sq="${i}">
      ${sq.group ? '<span class="strip"><span class="bldg"></span></span>' : ''}
      <span class="sq-body">
        ${icon ? `<span class="sq-icon">${icon}</span>` : ''}
        <span class="sq-name">${esc(sqShort(i))}</span>
      </span>
      ${sq.price ? `<span class="tag-price">${sq.price}</span>` : sq.amount ? `<span class="tag-price tax">${sq.amount}</span>` : ''}
      <span class="lock">${ICONS.lock}</span>
    </button>`;
  }).join('');
  for (const b of $$('#squares [data-sq]')) b.onclick = () => openSquare(Number(b.dataset.sq));
}

// current rent on an owned square, as shown on its tag
function rentNow(i) {
  const g = state.game;
  const sq = BOARD.squares[i];
  const pr = g.props[i];
  if (sq.type === 'street') {
    if (pr.houses) return sq.rent[pr.houses];
    return sq.rent[0] * (BOARD.groups[sq.group].every(x => g.props[x] && g.props[x].owner === pr.owner) ? 2 : 1);
  }
  if (sq.type === 'railway') return BOARD.railwayRent[Object.entries(g.props).filter(([k, p]) => p.owner === pr.owner && BOARD.squares[k].type === 'railway').length - 1];
  const both = Object.entries(g.props).filter(([k, p]) => p.owner === pr.owner && BOARD.squares[k].type === 'utility').length === 2;
  return both ? '×10' : '×4';
}

function updateBoard() {
  const g = state.game;
  for (const el of $$('#squares [data-sq]')) {
    const i = Number(el.dataset.sq);
    const pr = g.props[i];
    const sq = BOARD.squares[i];
    el.classList.toggle('owned', !!pr);
    el.classList.toggle('mortgaged', !!(pr && pr.mortgaged));
    el.style.setProperty('--owner', pr ? colorOf(pr.owner) : 'transparent');
    const bldg = el.querySelector('.bldg');
    if (bldg) bldg.innerHTML = !pr || !pr.houses ? '' : pr.houses === 5 ? '<i class="hotel"></i>' : '<i class="house"></i>'.repeat(pr.houses);
    const tag = el.querySelector('.tag-price');
    if (tag && sq.price) tag.textContent = pr && !pr.mortgaged ? rentNow(i) : sq.price;
    el.querySelector('.sq-name').textContent = sqShort(i);
  }
  renderTokens();
}

// ---------- tokens: hop square by square ----------
const shownPos = {}; // pid -> square currently drawn
const hopping = {};
function tokenXY(sq, k, n) {
  const el = $(`#squares [data-sq="${sq}"]`);
  const board = $('#board').getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const spread = Math.min(r.width, r.height) * 0.28;
  const angle = (2 * Math.PI * k) / Math.max(1, n);
  const dx = n > 1 ? Math.cos(angle) * spread : 0;
  const dy = n > 1 ? Math.sin(angle) * spread : 0;
  return [r.left - board.left + r.width / 2 + dx, r.top - board.top + r.height / 2 + dy];
}
function renderTokens() {
  const g = state.game;
  const layer = $('#tokens');
  const alive = g.order.filter(pid => !gp(pid).bankrupt);
  for (const pid of g.order) {
    let el = layer.querySelector(`[data-token="${pid}"]`);
    if (gp(pid).bankrupt) { if (el) el.remove(); continue; }
    if (!el) {
      el = document.createElement('span');
      el.className = 'token';
      el.dataset.token = pid;
      layer.append(el);
    }
    const p = member(pid) || { name: '?' };
    const key = `${p.name}|${p.avatar}`;
    if (el.dataset.key !== key) { el.innerHTML = avatarCore(p.name, p.avatar); el.dataset.key = key; }
    el.style.setProperty('--pc', colorOf(pid));
    el.classList.toggle('active', g.turn && g.turn.pid === pid);
    el.classList.toggle('jailed', gp(pid).inJail);
    const target = gp(pid).pos;
    if (shownPos[pid] === undefined) shownPos[pid] = target;
    if (shownPos[pid] !== target && !hopping[pid]) hop(pid, target);
  }
  placeTokens(alive);
}
function placeTokens(alive = state.game.order.filter(pid => !gp(pid).bankrupt)) {
  const bySquare = {};
  for (const pid of alive) (bySquare[shownPos[pid]] ||= []).push(pid);
  for (const [sq, pids] of Object.entries(bySquare)) {
    pids.forEach((pid, k) => {
      const el = $(`[data-token="${pid}"]`);
      if (!el) return;
      const [x, y] = tokenXY(Number(sq), k, pids.length);
      el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
    });
  }
}
function hop(pid, target) {
  const steps = (target - shownPos[pid] + 40) % 40;
  // jumps (jail, cards going backwards, long moves) teleport; dice moves walk
  if (reducedMotion() || steps === 0 || steps > 12 || (gp(pid).inJail && target === 10)) {
    shownPos[pid] = target;
    placeTokens();
    return;
  }
  hopping[pid] = true;
  let left = steps;
  const tick = () => {
    shownPos[pid] = (shownPos[pid] + 1) % 40;
    placeTokens();
    tone(500 + (steps - left) * 40, 0, 0.05, 'sine', 0.025);
    if (--left > 0) setTimeout(tick, 150);
    else {
      hopping[pid] = false;
      if (shownPos[pid] !== gp(pid).pos) hop(pid, gp(pid).pos);
    }
  };
  setTimeout(tick, 120);
}
window.addEventListener('resize', () => state && state.game && placeTokens());

// ---------- dice, cards and sounds on changes ----------
let lastDiceAt = null;
function fxOnState(prev, s) {
  const g = s.game;
  if (!g) return;
  if (g.lastDice && g.lastDice.at !== lastDiceAt) {
    const fresh = lastDiceAt !== null;
    lastDiceAt = g.lastDice.at;
    if (fresh) { animateDice(g.lastDice.dice); SFX.dice(); }
    else drawDice(g.lastDice.dice);
  }
  if (!prev || !prev.game) return;
  const me = s.me && s.me.id;
  if (g.turn && prev.game.turn && g.turn.pid !== prev.game.turn.pid && g.turn.pid === me) SFX.turn();
  const pg = prev.game.players[me];
  if (pg && g.players[me]) {
    if (g.players[me].cash > pg.cash) SFX.coin();
    else if (g.players[me].cash < pg.cash) SFX.pay();
  }
  if (s.phase === 'ended' && prev.phase !== 'ended') { SFX.win(); setTimeout(openResults, 900); }
}
const PIPS = { 1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };
const dieHtml = n => Array.from({ length: 9 }, (_, i) => `<i class="${PIPS[n].includes(i + 1) ? 'pip' : ''}"></i>`).join('');
function drawDice(d) {
  const dies = $$('#dice .die');
  dies[0].innerHTML = dieHtml(d[0]);
  dies[1].innerHTML = dieHtml(d[1]);
  $('#dice').classList.toggle('doubles', d[0] === d[1]);
}
function animateDice(final) {
  if (reducedMotion()) return drawDice(final);
  const box = $('#dice');
  box.classList.add('rolling');
  let n = 0;
  const spin = setInterval(() => {
    drawDice([1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)]);
    if (++n >= 8) { clearInterval(spin); box.classList.remove('rolling'); drawDice(final); }
  }, 70);
}

// ---------- game screen ----------
function renderGame() {
  if (!BOARD) return;
  const g = state.game;
  updateBoard();
  renderCenter();
  renderPlayers();
  renderMyProps();
  renderTrades();
  renderTabs();
  $('#log').innerHTML = g.log.slice().reverse().map(e => `<li>${esc(fmtLog(e))}</li>`).join('');
  $('#bankInfo').textContent = t('mono.bankSupply', { h: g.housesLeft, t: g.hotelsLeft }) + (state.settings.freeParking ? ` · ${t('mono.pot', { n: g.pot })}` : '');
  const playing = state.phase === 'playing' && !state.me.spectator && gp(state.me.id) && !gp(state.me.id).bankrupt;
  $('#resignBtn').classList.toggle('hidden', !playing);
  $('#restartBtn').classList.toggle('hidden', !(isHost() && state.phase === 'ended'));
}

function fmtLog(e) {
  const p = { ...e.params };
  if (p.square !== undefined) p.square = sqName(p.square);
  if (p.deck) p.deck = t('mono.deck.' + p.deck);
  if (p.card) p.card = t('mono.card.' + p.card);
  return t(e.key, p);
}

function timerHtml(endsAt) {
  return endsAt ? '<span class="mini-timer" id="turnTimer"></span>' : '';
}

function renderCenter() {
  const g = state.game;
  const me = state.me.id;
  const myGp = gp(me);
  const actions = $('#actions');
  const info = $('#turnInfo');
  let html = '';
  if (state.phase === 'ended') {
    info.innerHTML = `<div class="winner-line">${esc(t('mono.winner', { name: nameOf(g.winner) }))}</div>`;
    $('#feed').innerHTML = '';
    actions.innerHTML = `<button id="openResults" class="primary">${esc(t('mono.results'))}</button>`;
    $('#openResults').onclick = openResults;
    $('#cardShow').classList.add('hidden');
    return;
  }
  const turnPid = g.turn.pid;
  info.innerHTML = `${pieceOf(turnPid)}
    <b>${esc(turnPid === me ? t('mono.yourTurn') : t('mono.turnOf', { name: nameOf(turnPid) }))}</b> ${timerHtml(g.auction ? g.auction.endsAt : g.debts.length ? g.debts[0].endsAt : g.turn.endsAt)}`;
  if (g.auction) {
    const a = g.auction;
    const canBid = myGp && !myGp.bankrupt;
    html = `<div class="auction">
      <div class="auction-title">${esc(t('mono.auctionTitle', { square: sqName(a.square) }))}</div>
      <div class="auction-bid">${a.bidder ? esc(t('mono.auctionBid', { amount: a.bid, name: nameOf(a.bidder) })) : esc(t('mono.auctionNoBid'))}</div>
      ${canBid ? `<div class="row center bid-row">
        ${[10, 50, 100].map(x => `<button class="small" data-bid="${a.bid + x}">+${x}</button>`).join('')}
        <input id="bidInput" type="number" min="${a.bid + 1}" value="${a.bid + 10}">
        <button id="bidBtn" class="primary small">${esc(t('mono.bid'))}</button>
      </div>` : ''}
    </div>`;
  } else if (g.debts.length) {
    const d = g.debts[0];
    html = d.pid === me
      ? `<div class="debt"><div class="debt-title">${esc(t('mono.debtTitle', { amount: d.amount }))}</div>
          <p class="muted small-text">${esc(t('mono.debtHint'))}</p>
          <div class="row center"><button id="payDebtBtn" class="primary" ${myGp.cash < d.amount ? 'disabled' : ''}>${esc(t('mono.payDebt', { amount: d.amount }))}</button>
          <button id="bankruptBtn" class="danger">${esc(t('mono.goBankrupt'))}</button></div></div>`
      : `<div class="muted">${esc(t('mono.waitDebt', { name: nameOf(d.pid), amount: d.amount }))}</div>`;
  } else if (turnPid === me) {
    const st = g.turn.stage;
    if (st === 'roll') {
      html = myGp.inJail
        ? `<div class="muted small-text">${esc(t('mono.inJail', { n: myGp.jailTurns + 1 }))}</div><div class="row center">
            <button id="rollBtn" class="primary big-roll">${esc(t('mono.roll'))}</button>
            <button id="bailBtn" ${myGp.cash < 50 ? 'disabled' : ''}>${esc(t('mono.payBail', { n: 50 }))}</button>
            ${myGp.jailCards ? `<button id="cardBtn">${esc(t('mono.useCard'))}</button>` : ''}</div>`
        : `<button id="rollBtn" class="primary big-roll">${esc(t('mono.roll'))}</button>`;
    } else if (st === 'buy') {
      const sq = g.turn.offer;
      const price = BOARD.squares[sq].price;
      html = `<button class="mini-deed g-${BOARD.squares[sq].group || BOARD.squares[sq].type}" data-info="${sq}"><span class="md-strip"></span><b>${esc(sqName(sq))}</b><span class="md-price">${price} ₽</span></button>
        <div class="row center"><button id="buyBtn" class="primary" ${myGp.cash < price ? 'disabled' : ''}>${esc(t('mono.buy', { price }))}</button>
        <button id="declineBtn">${esc(t(state.settings.auctions ? 'mono.decline' : 'mono.declineNoAuction'))}</button></div>`;
    } else if (st === 'end') {
      html = `<button id="endBtn" class="primary">${esc(t('mono.endTurn'))}</button>`;
    }
  }
  actions.innerHTML = html;
  const bind = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };
  bind('#rollBtn', () => send('roll'));
  for (const b of $$('#actions [data-info]')) b.onclick = () => openSquare(Number(b.dataset.info));
  bind('#bailBtn', () => send('payBail'));
  bind('#cardBtn', () => send('useJailCard'));
  bind('#buyBtn', () => send('buy'));
  bind('#declineBtn', () => send('decline'));
  bind('#endBtn', () => send('endTurn'));
  bind('#payDebtBtn', () => send('payDebt'));
  bind('#bankruptBtn', () => confirm(t('mono.goBankrupt') + '?') && send('bankrupt'));
  bind('#bidBtn', () => send('bid', { amount: parseInt($('#bidInput').value, 10) }));
  for (const b of $$('[data-bid]')) b.onclick = () => send('bid', { amount: Number(b.dataset.bid) });

  // the last few events, newest at the bottom
  $('#feed').innerHTML = g.log.slice(-5).map((e, i, arr) => `<li style="--age:${arr.length - 1 - i}">${esc(fmtLog(e))}</li>`).join('');

  // the card just drawn
  const card = g.lastCard;
  const cs = $('#cardShow');
  if (card) {
    cs.className = `card-show deck-${card.deck}`;
    cs.innerHTML = `<div class="card-deck">${esc(t('mono.deck.' + card.deck))}</div><div class="card-text">${esc(t('mono.card.' + card.id))}</div>`;
  } else cs.classList.add('hidden');
  tickTimer();
}

function tickTimer() {
  const el = $('#turnTimer');
  if (!el || !state || !state.game) return;
  const g = state.game;
  const endsAt = g.auction ? g.auction.endsAt : g.debts.length ? g.debts[0].endsAt : g.turn && g.turn.endsAt;
  if (!endsAt) { el.textContent = ''; return; }
  const left = Math.max(0, Math.ceil((endsAt - (Date.now() + clockOffset)) / 1000));
  el.textContent = `${left}s`;
  el.classList.toggle('low', left <= 10);
  const fill = $('#pcTimerFill');
  const total = g.auction ? 10 : state.settings.turnSeconds || 1;
  if (fill) fill.style.width = `${Math.min(100, (100 * left) / total)}%`;
}
setInterval(tickTimer, 250);

function renderPlayers() {
  const g = state.game;
  const turnPid = g.turn && state.phase === 'playing' ? g.turn.pid : null;
  const deadline = turnPid ? (g.auction ? g.auction.endsAt : g.debts.length ? g.debts[0].endsAt : g.turn.endsAt) : null;
  $('#playerList').innerHTML = g.order.map(pid => {
    const p = member(pid) || { name: '?' };
    const s = gp(pid);
    const mine = owned(pid).sort((a, b) => a - b);
    const tags = [s.inJail ? `<span class="tag">${esc(t('mono.jail'))}</span>` : '', s.bankrupt ? `<span class="tag mafia">${esc(t('mono.bankrupt'))}</span>` : '',
      p.connected === false ? `<span class="tag">${esc(t('tag.offline'))}</span>` : '', s.jailCards ? `<span class="tag">${esc(t('mono.trade.cards'))}: ${s.jailCards}</span>` : ''].join('');
    return `<div class="pcard ${pid === turnPid ? 'turn' : ''} ${s.bankrupt ? 'out' : ''} ${pid === state.me.id ? 'me' : ''}" data-pid="${pid}" style="--pc:${colorOf(pid)}">
      <span class="avatar-wrap clickable pc-wrap" data-open-player="${p.userId || ''}">${avatar(p.name, p.avatar, p.cos)}</span>
      <div class="pc-main">
        <div class="pc-top"><b class="pc-name ${nameCls(p.cos)}">${esc(p.name)}</b>${tags}</div>
        <div class="pc-cash">${money(s.cash)}</div>
        <div class="pc-props">${mine.map(sq => `<i class="g-${BOARD.squares[sq].group || BOARD.squares[sq].type} ${g.props[sq].mortgaged ? 'm' : ''}" title="${esc(sqName(sq))}"></i>`).join('')}</div>
      </div>
      ${pid === turnPid && deadline ? '<span class="pc-timer"><span id="pcTimerFill"></span></span>' : ''}
    </div>`;
  }).join('');
  for (const el of $$('#playerList [data-open-player]')) if (el.dataset.openPlayer) el.onclick = () => openPlayer(el.dataset.openPlayer);
}

// ---------- my properties: build, sell, mortgage ----------
const GROUP_ORDER = ['brown', 'lightblue', 'pink', 'orange', 'red', 'yellow', 'green', 'darkblue'];
function renderMyProps() {
  const g = state.game;
  const me = state.me.id;
  if (!gp(me)) { $('#myProps').innerHTML = ''; return; }
  const mine = owned(me).sort((a, b) => {
    const ga = BOARD.squares[a].group, gb = BOARD.squares[b].group;
    return (ga ? GROUP_ORDER.indexOf(ga) : 9 + (BOARD.squares[a].type === 'railway' ? 0 : 1)) - (gb ? GROUP_ORDER.indexOf(gb) : 9 + (BOARD.squares[b].type === 'railway' ? 0 : 1)) || a - b;
  });
  if (!mine.length) { $('#myProps').innerHTML = `<p class="muted small-text">${esc(t('mono.noProps'))}</p>`; return; }
  $('#myProps').innerHTML = mine.map(sq => {
    const s = BOARD.squares[sq];
    const pr = g.props[sq];
    const ownsSet = s.group && BOARD.groups[s.group].every(x => g.props[x] && g.props[x].owner === me);
    const level = !pr.houses ? '' : pr.houses === 5 ? '🏨' : '🏠'.repeat(pr.houses);
    return `<div class="mprop ${pr.mortgaged ? 'mortgaged' : ''}">
      <span class="mband g-${s.group || s.type}"></span>
      <button class="mname" data-info="${sq}">${esc(sqName(sq))} <span class="lvl">${level}</span>${pr.mortgaged ? `<span class="tag">${esc(t('mono.mortgaged'))}</span>` : ''}</button>
      <span class="mbtns">
        ${s.type === 'street' && ownsSet && !pr.mortgaged && pr.houses < 5 ? `<button class="small" data-act="build" data-sq="${sq}" title="${s.house} ₽">🏠 ${esc(t('mono.build'))}</button>` : ''}
        ${pr.houses ? `<button class="small ghost" data-act="sell" data-sq="${sq}">${esc(t('mono.sell'))}</button>` : ''}
        ${!pr.mortgaged && !pr.houses ? `<button class="small ghost" data-act="mortgage" data-sq="${sq}">${esc(t('mono.mortgage', { n: s.price / 2 }))}</button>` : ''}
        ${pr.mortgaged ? `<button class="small ghost" data-act="unmortgage" data-sq="${sq}">${esc(t('mono.unmortgage', { n: g.unmortgageCosts[sq] }))}</button>` : ''}
      </span>
    </div>`;
  }).join('');
  for (const b of $$('#myProps [data-act]')) b.onclick = () => send(b.dataset.act, { square: Number(b.dataset.sq) });
  for (const b of $$('#myProps [data-info]')) b.onclick = () => openSquare(Number(b.dataset.info));
}

// ---------- trades ----------
let draft = null; // { to, give: Set, take: Set, giveCash, takeCash, giveCards, takeCards }
function renderTrades() {
  const g = state.game;
  const me = state.me.id;
  const panel = $('#tradePanel');
  if (!gp(me) || gp(me).bankrupt || state.phase !== 'playing') { panel.innerHTML = `<p class="muted small-text">${esc(t('mono.trade.none'))}</p>`; $('#tradeBadge').classList.add('hidden'); return; }
  const mineOffers = g.trades.filter(tr => tr.from === me || tr.to === me);
  const incoming = mineOffers.filter(tr => tr.to === me).length;
  $('#tradeBadge').textContent = incoming;
  $('#tradeBadge').classList.toggle('hidden', !incoming || tab === 'trade');
  const sideTxt = s => [...s.props.map(sq => sqName(sq)), s.cash ? money(s.cash) : '', s.cards ? `🔑×${s.cards}` : ''].filter(Boolean).join(', ') || t('mono.trade.nothing');
  const offers = mineOffers.map(tr => {
    const inc = tr.to === me;
    return `<div class="offer-card ${inc ? 'incoming' : ''}">
      <div class="offer-head">${esc(inc ? t('mono.trade.incoming', { name: nameOf(tr.from) }) : t('mono.trade.outgoing', { name: nameOf(tr.to) }))}</div>
      <div class="offer-sides"><div><span class="muted small-text">${esc(t('mono.trade.give'))}</span><p>${esc(sideTxt(inc ? tr.take : tr.give))}</p></div>
      <div><span class="muted small-text">${esc(t('mono.trade.get'))}</span><p>${esc(sideTxt(inc ? tr.give : tr.take))}</p></div></div>
      <div class="row">${inc ? `<button class="primary small" data-respond="${tr.id}" data-accept="1">${esc(t('mono.trade.accept'))}</button>
        <button class="ghost small" data-respond="${tr.id}">${esc(t('mono.trade.decline'))}</button>` : `<button class="ghost small" data-respond="${tr.id}">${esc(t('mono.trade.cancel'))}</button>`}</div>
    </div>`;
  }).join('');
  const others = g.order.filter(pid => pid !== me && !gp(pid).bankrupt);
  if (draft && !others.includes(draft.to)) draft = null;
  if (!draft && others.length) draft = { to: others[0], give: new Set(), take: new Set(), giveCash: 0, takeCash: 0, giveCards: 0, takeCards: 0 };
  const tradeable = pid => owned(pid).filter(sq => {
    const s = BOARD.squares[sq];
    return !s.group || !BOARD.groups[s.group].some(x => g.props[x] && g.props[x].houses);
  });
  const list = (pid, set, key) => tradeable(pid).map(sq => `<label class="tprop"><input type="checkbox" data-tset="${key}" value="${sq}" ${set.has(sq) ? 'checked' : ''}><span class="mband g-${BOARD.squares[sq].group || BOARD.squares[sq].type}"></span>${esc(sqName(sq))}</label>`).join('') || `<span class="muted small-text">—</span>`;
  const form = draft ? `<div class="trade-form">
    <div class="row"><span class="muted small-text">${esc(t('mono.trade.with'))}</span>
      <select id="tradeTo">${others.map(pid => `<option value="${pid}" ${pid === draft.to ? 'selected' : ''}>${esc(nameOf(pid))}</option>`).join('')}</select></div>
    <div class="trade-cols">
      <div><h4>${esc(t('mono.trade.give'))}</h4>${list(me, draft.give, 'give')}
        <label class="tcash">${esc(t('mono.trade.cash'))} <input type="number" min="0" step="10" data-tnum="giveCash" value="${draft.giveCash}"></label>
        ${gp(me).jailCards ? `<label class="tcash">${esc(t('mono.trade.cards'))} <input type="number" min="0" max="${gp(me).jailCards}" data-tnum="giveCards" value="${draft.giveCards}"></label>` : ''}</div>
      <div><h4>${esc(t('mono.trade.get'))}</h4>${list(draft.to, draft.take, 'take')}
        <label class="tcash">${esc(t('mono.trade.cash'))} <input type="number" min="0" step="10" data-tnum="takeCash" value="${draft.takeCash}"></label>
        ${gp(draft.to).jailCards ? `<label class="tcash">${esc(t('mono.trade.cards'))} <input type="number" min="0" max="${gp(draft.to).jailCards}" data-tnum="takeCards" value="${draft.takeCards}"></label>` : ''}</div>
    </div>
    <button id="sendTrade" class="primary small">${esc(t('mono.trade.send'))}</button>
  </div>` : '';
  // keep the form untouched while someone is typing in it
  if (panel.contains(document.activeElement) && document.activeElement.matches('input[type=number]')) {
    panel.querySelector('.offers').innerHTML = offers || `<p class="muted small-text">${esc(t('mono.trade.none'))}</p>`;
  } else {
    panel.innerHTML = `<div class="offers">${offers || `<p class="muted small-text">${esc(t('mono.trade.none'))}</p>`}</div><h3>${esc(t('mono.trade.new'))}</h3>${form}`;
  }
  for (const b of $$('[data-respond]')) b.onclick = () => send('tradeRespond', { id: b.dataset.respond, accept: !!b.dataset.accept });
  const to = $('#tradeTo');
  if (to) to.onchange = () => { draft = { to: to.value, give: new Set(), take: new Set(), giveCash: 0, takeCash: 0, giveCards: 0, takeCards: 0 }; renderTrades(); };
  for (const c of $$('[data-tset]')) c.onchange = () => { draft[c.dataset.tset][c.checked ? 'add' : 'delete'](Number(c.value)); };
  for (const n of $$('[data-tnum]')) n.oninput = () => { draft[n.dataset.tnum] = Math.max(0, parseInt(n.value, 10) || 0); };
  const sendBtn = $('#sendTrade');
  if (sendBtn) sendBtn.onclick = async () => {
    const res = await send('trade', {
      to: draft.to,
      give: { props: [...draft.give], cash: draft.giveCash, cards: draft.giveCards },
      take: { props: [...draft.take], cash: draft.takeCash, cards: draft.takeCards },
    });
    if (res && res.ok) { draft = null; toast('✓ ' + t('mono.trade.send'), 'info'); }
  };
}

// ---------- sidebar tabs ----------
let tab = store.get(TAB_KEY) || 'props';
function renderTabs() {
  for (const b of $$('[data-tab]')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const p of $$('[data-panel]')) p.classList.toggle('hidden', p.dataset.panel !== tab);
}
for (const b of $$('[data-tab]')) b.onclick = () => { tab = b.dataset.tab; store.set(TAB_KEY, tab); renderTabs(); if (state && state.game) renderTrades(); };

// ---------- square details ----------
function openSquare(i) {
  const s = BOARD.squares[i];
  const g = state && state.game;
  const pr = g && g.props[i];
  let body = '';
  if (s.type === 'street') {
    body = `<table class="rent-table">
      <tr><td>${esc(t('mono.rent'))}</td><td>${s.rent[0]} ₽</td></tr>
      <tr><td>${esc(t('mono.rentSet'))}</td><td>${s.rent[0] * 2} ₽</td></tr>
      ${[1, 2, 3, 4].map(n => `<tr><td>${esc(t('mono.rentHouses', { n }))}</td><td>${s.rent[n]} ₽</td></tr>`).join('')}
      <tr><td>${esc(t('mono.rentHotel'))}</td><td>${s.rent[5]} ₽</td></tr>
      <tr class="sep"><td>${esc(t('mono.houseCost'))}</td><td>${s.house} ₽</td></tr>
      <tr><td>${esc(t('mono.mortgageValue'))}</td><td>${s.price / 2} ₽</td></tr></table>`;
  } else if (s.type === 'railway') {
    body = `<table class="rent-table">${BOARD.railwayRent.map((r, k) => `<tr><td>${esc(t('mono.railRent', { n: k + 1 }))}</td><td>${r} ₽</td></tr>`).join('')}
      <tr class="sep"><td>${esc(t('mono.mortgageValue'))}</td><td>${s.price / 2} ₽</td></tr></table>`;
  } else if (s.type === 'utility') {
    body = `<p>${esc(t('mono.utilRent'))}</p><table class="rent-table"><tr><td>${esc(t('mono.mortgageValue'))}</td><td>${s.price / 2} ₽</td></tr></table>`;
  } else if (s.type === 'tax') body = `<p class="big-amount">${s.amount} ₽</p>`;
  $('#sqCard').innerHTML = `
    <div class="sq-head g-${s.group || s.type}"><span>${esc(sqName(i))}</span></div>
    ${s.price ? `<div class="sq-meta"><span>${esc(t('mono.price'))}: <b>${s.price} ₽</b></span><span>${pr ? `${esc(t('mono.owner'))}: <b style="color:${colorOf(pr.owner)}">${esc(nameOf(pr.owner))}</b>${pr.mortgaged ? ` · ${esc(t('mono.mortgaged'))}` : ''}` : esc(t('mono.unowned'))}</span></div>` : ''}
    ${body}
    <button id="sqClose" class="ghost small">${esc(t('ui.close'))}</button>`;
  $('#sqInfo').classList.remove('hidden');
  $('#sqClose').onclick = () => $('#sqInfo').classList.add('hidden');
}
$('#sqInfo').addEventListener('pointerdown', e => { if (e.target.id === 'sqInfo') $('#sqInfo').classList.add('hidden'); });

// ---------- results ----------
function openResults() {
  const g = state.game;
  const rows = g.order.map(pid => ({ pid, s: gp(pid) })).sort((a, b) => {
    if (a.pid === g.winner) return -1;
    if (b.pid === g.winner) return 1;
    // whoever went bankrupt later finished higher (bankruptAt counts the players still left)
    return (a.s.bankruptAt || 0) - (b.s.bankruptAt || 0) || b.s.netWorth - a.s.netWorth;
  });
  $('#resultsBody').innerHTML = `<ol class="results">${rows.map(({ pid, s }, i) => {
    const p = member(pid) || { name: '?' };
    return `<li class="${i === 0 ? 'first' : ''}"><span class="board-rank">${['🥇', '🥈', '🥉'][i] || i + 1}</span>
      ${pieceOf(pid)}
      <b class="${nameCls(p.cos)}">${esc(p.name)}</b><span class="spacer"></span>
      ${s.bankrupt ? `<span class="tag mafia">${esc(t('mono.bankrupt'))}</span>` : `<b>${money(s.netWorth)}</b>`}</li>`;
  }).join('')}</ol>`;
  $('#results').classList.remove('hidden');
}
$('#resultsClose').onclick = () => $('#results').classList.add('hidden');
$('#restartBtn').onclick = () => send('restart');
$('#resignBtn').onclick = () => confirm(t('mono.confirmResign')) && send('resign');

// ---------- reactions ----------
const REACTIONS = ['👍', '👎', '😂', '🤔', '😱', '🤥', '🔥', '💀', '💸', '🏠', '🎲'];
function renderReactBar() {
  const bar = $('#reactBar');
  const list = [...REACTIONS, ...((account && account.reactions) || [])];
  if (bar.childElementCount !== list.length) {
    bar.innerHTML = list.map(e => `<button class="react-btn" data-react="${e}">${e}</button>`).join('');
    for (const b of bar.querySelectorAll('[data-react]')) b.onclick = () => send('react', { emoji: b.dataset.react });
  }
  bar.classList.toggle('hidden', !(state && state.me && state.phase !== 'lobby'));
}
const reactLayer = document.createElement('div');
reactLayer.className = 'react-layer';
document.body.append(reactLayer);
socket.on('reaction', r => {
  const anchor = $(`[data-token="${r.from}"]`) || $(`#playerList [data-pid="${r.from}"]`);
  const rect = anchor ? anchor.getBoundingClientRect() : { left: innerWidth / 2, width: 0, top: innerHeight / 2 };
  const el = document.createElement('span');
  el.className = 'reaction';
  el.textContent = r.emoji;
  el.style.left = `${rect.left + rect.width / 2}px`;
  el.style.top = `${rect.top}px`;
  el.style.setProperty('--dx', `${Math.round(Math.random() * 40 - 20)}px`);
  el.style.setProperty('--rot', `${Math.round(Math.random() * 30 - 15)}deg`);
  reactLayer.append(el);
  el.addEventListener('animationend', () => el.remove());
  setTimeout(() => el.remove(), 2500);
});

// ---------- leaderboard and player pages (Monopoly stats) ----------
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
let boardTab = 'wins';
let boardUsers = [];
async function openBoard() {
  const res = await api('mono/leaderboard');
  if (!res.ok) return;
  boardUsers = res.users;
  $('#boardSheet').classList.remove('hidden');
  renderBoardSheet();
}
function renderBoardSheet() {
  for (const b of $$('[data-board]')) b.classList.toggle('active', b.dataset.board === boardTab);
  const metric = {
    wins: m => [m.wins, m.wins],
    winrate: m => [m.games >= 3 ? pct(m.wins, m.games) : -1, `${pct(m.wins, m.games)}%`],
    worth: m => [m.bestNetWorth, money(m.bestNetWorth)],
    rent: m => [m.rentCollected, money(m.rentCollected)],
    games: m => [m.games, m.games],
  }[boardTab];
  const rows = boardUsers.map(u => ({ u, m: metric(u.monoStats) })).filter(r => r.u.monoStats.games > 0 && r.m[0] >= 0)
    .sort((a, b) => b.m[0] - a.m[0] || b.u.monoStats.wins - a.u.monoStats.wins);
  $('#boardList').innerHTML = rows.length ? rows.map(({ u, m }, i) => `
    <li class="board-row ${account && u.id === account.id ? 'me' : ''}" data-player="${u.id}">
      <span class="board-rank">${['🥇', '🥈', '🥉'][i] || `<span class="rank">${i + 1}</span>`}</span>
      ${avatar(u.username, u.avatar, u.equipped)}
      <span class="board-id"><b class="${nameCls(u.equipped)}">${esc(u.username)}</b>${statusPill(u.score)}<span class="muted small-text">${esc(t('mono.board.sub', { g: u.monoStats.games, w: u.monoStats.wins }))}</span></span>
      <span class="board-metric">${m[1]}</span>
    </li>`).join('') : `<p class="muted small-text">${esc(t('board.empty'))}</p>`;
  $('#boardNote').textContent = boardTab === 'winrate' ? t('board.minGames', { n: 3 }) : '';
  for (const row of $$('#boardList [data-player]')) row.onclick = () => openPlayer(row.dataset.player);
}
for (const b of $$('[data-board]')) b.onclick = () => { boardTab = b.dataset.board; renderBoardSheet(); };
$('#boardBtn').onclick = openBoard;
$('#homeBoard').onclick = openBoard;
$('#boardClose').onclick = () => $('#boardSheet').classList.add('hidden');

// Five axes from in-game actions only; each needs 3 games before it shows.
function monoStyle(m) {
  const enough = m.games >= 3;
  const v = x => (enough ? Math.max(0, Math.min(1, x)) : null);
  return [
    ['results', v(m.games && m.recent.length ? m.recent.reduce((s, r) => s + (r.players > 1 ? (r.players - r.place) / (r.players - 1) : 1), 0) / m.recent.length : 0)],
    ['builder', v((m.housesBuilt + 5 * m.hotelsBuilt) / Math.max(1, m.games) / 15)],
    ['landlord', v(m.rentCollected + m.rentPaid ? m.rentCollected / (m.rentCollected + m.rentPaid) : 0)],
    ['dealer', v((m.trades + m.auctionsWon) / Math.max(1, m.games) / 4)],
    ['survival', v(1 - m.bankruptcies / Math.max(1, m.games))],
  ];
}
function radarSvg(axes) {
  const size = 300, c = 150, R = 104;
  const point = (i, r) => { const a = -Math.PI / 2 + (2 * Math.PI * i) / axes.length; return [c + r * Math.cos(a), c + r * Math.sin(a)]; };
  const ring = f => axes.map((_, i) => point(i, R * f).join(',')).join(' ');
  const shape = axes.map(([, v], i) => point(i, R * Math.max(0.04, v || 0)).join(',')).join(' ');
  return `<svg class="radar" viewBox="-40 -10 ${size + 80} ${size + 20}" role="img">
    <defs><linearGradient id="radarFill" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--glow-a)" stop-opacity=".75"/><stop offset="1" stop-color="var(--glow-b)" stop-opacity=".55"/></linearGradient></defs>
    ${[0.25, 0.5, 0.75, 1].map(f => `<polygon points="${ring(f)}" class="radar-ring"/>`).join('')}
    ${axes.map((_, i) => `<line x1="${c}" y1="${c}" x2="${point(i, R)[0]}" y2="${point(i, R)[1]}" class="radar-axis"/>`).join('')}
    <polygon points="${shape}" class="radar-shape" fill="url(#radarFill)"/>
    ${axes.map(([key, v], i) => {
      const [x, y] = point(i, R + 30);
      const anchor = Math.abs(x - c) < 8 ? 'middle' : x > c ? 'start' : 'end';
      return `<text x="${x}" y="${y}" text-anchor="${anchor}" class="radar-label"><tspan>${esc(t('mono.axis.' + key))}</tspan><tspan x="${x}" dy="15" class="radar-value">${v === null ? '—' : Math.round(v * 100) + '%'}</tspan></text>`;
    }).join('')}
  </svg>`;
}
async function openPlayer(userId) {
  if (!userId) return;
  const res = await api('player/' + userId);
  if (!res.ok) return;
  const u = res.user;
  const m = u.monoStats;
  const axes = monoStyle(m);
  const tile = (v, label) => `<div class="stat"><b>${v}</b><span>${esc(label)}</span></div>`;
  const fav = Object.entries(m.groups).sort((a, b) => b[1] - a[1])[0];
  $('#playerTitle').textContent = u.username;
  $('#playerBody').innerHTML = `
    <div class="profile-top"><span class="player-avatar">${avatar(u.username, u.avatar, u.equipped)}</span>
      <div class="profile-id"><div class="profile-name ${nameCls(u.equipped)}">${esc(u.username)}</div>${statusPill(u.score)}</div></div>
    ${!m.games ? `<p class="muted">${esc(t('player.noGames'))}</p>` : `
    <div class="stat-grid four">
      ${tile(m.games, t('player.games'))}${tile(pct(m.wins, m.games) + '%', t('player.winRate'))}
      ${tile((m.placeSum / m.games).toFixed(1), t('mono.player.avgPlace'))}${tile(money(m.bestNetWorth), t('mono.player.bestWorth'))}
    </div>
    <section class="player-section"><h3>${esc(t('mono.player.style'))}</h3>
      <div class="radar-wrap">${radarSvg(axes)}<ul class="radar-help">${axes.map(([k, v]) => `<li><b>${esc(t('mono.axis.' + k))}</b> — ${esc(t('mono.help.' + k))}${v === null ? ` <span class="need-more">${esc(t('player.needMore.games', { n: 3 - m.games }))}</span>` : ''}</li>`).join('')}</ul></div>
    </section>
    <section class="player-section"><h3>${esc(t('player.highlights'))}</h3>
      <div class="stat-grid four">
        ${tile(money(m.rentCollected), t('mono.player.rentIn'))}${tile(money(m.rentPaid), t('mono.player.rentOut'))}
        ${tile(m.housesBuilt, t('mono.player.houses'))}${tile(m.hotelsBuilt, t('mono.player.hotels'))}
        ${tile(m.auctionsWon, t('mono.player.auctions'))}${tile(m.jailed, t('mono.player.jailed'))}
        ${tile(m.bestStreak, t('player.bestStreak'))}${tile(fav ? `<span class="mband g-${fav[0]}"></span> ${esc(t('mono.group.' + fav[0]))}` : '—', t('mono.player.favGroup'))}
      </div>
    </section>
    <section class="player-section"><h3>${esc(t('mono.player.recent'))}</h3>
      <div class="recent-games">${m.recent.map(r => `<span class="recent ${r.won ? 'won' : 'lost'}"><b>${r.place}</b><span>${esc(t('mono.place', { n: r.place }))} / ${r.players}</span><span class="muted">${money(r.netWorth)}</span></span>`).join('')}</div>
    </section>`}`;
  $('#playerPage').classList.remove('hidden');
}
$('#playerClose').onclick = () => $('#playerPage').classList.add('hidden');
for (const id of ['boardSheet', 'playerPage', 'results']) $('#' + id).addEventListener('pointerdown', e => { if (e.target.id === id) $('#' + id).classList.add('hidden'); });
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  for (const id of ['boardSheet', 'playerPage', 'results', 'sqInfo']) $('#' + id).classList.add('hidden');
  $('#siteMenu').classList.add('hidden');
});

// ---------- language ----------
const langSelect = $('#langSelect');
langSelect.innerHTML = Object.entries(LANGS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
langSelect.value = lang;
langSelect.onchange = () => {
  setLang(langSelect.value);
  applyStaticTranslations();
  renderAuthMode();
  renderAccount();
  buildBoard();
  render();
};

applyStaticTranslations();
renderAuthMode();
renderSoundBtn();
render();
