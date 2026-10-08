'use strict';

// Monopoly client. Same accounts as Mafia, its own Socket.IO namespace. The login, profile,
// admin panel, sounds and alerts are shared with Mafia (common.js).

const SESSION_KEY = 'mono.session';
const AUTO_END_KEY = 'mono.autoEnd';
// compact amounts for the price tags on the board: 600, 1.4к, 20к
const tagMoney = n => (typeof n !== 'number' ? n : n < 1000 ? String(n) : `${+(n / 1000).toFixed(n % 1000 ? 1 : 0)}к`);

const socket = io('/monopoly', { auth: cb => cb({ token: store.get(AUTH_KEY) }) });

let state = null;
// "← Home" from the lobby shows the home screen but keeps the seat (back via the banner)
let homeView = false;
let BOARD = null; // { squares, groups, railwayRent }
let clockOffset = 0;
let urlRoom = (new URLSearchParams(location.search).get('room') || '').toUpperCase().slice(0, 4);

Site.init({
  game: 'mono',
  socket,
  urlRoom: () => urlRoom,
  hooks: {
    onAccount: () => render(),
    onItems: () => render(),
    onLang: () => { buildBoard(); render(); },
    busy: () => !!(state && state.me && state.phase === 'playing' && !state.me.spectator && state.game && gp(state.me.id) && !gp(state.me.id).bankrupt),
    leave: async () => { if (state && state.me) await send('leave'); store.set(SESSION_KEY, null); },
  },
});
$('#homeBtn').onclick = () => { homeView = true; render(); };
$('#profileBtn').onclick = () => openProfile();
$('#homeProfile').onclick = () => openProfile();

// ---------- sound effects (muted with the bell, like the alerts) ----------
const beep = (f, at = 0, dur = 0.15, type = 'triangle', vol = 0.06) => alertsOn && tone({ f, at, dur, type, vol, attack: 0.01 });
const SFX = {
  dice: () => { for (let i = 0; i < 6; i++) beep(180 + Math.random() * 260, i * 0.05, 0.05, 'square', 0.03); },
  coin: () => { beep(988, 0, 0.12); beep(1319, 0.08, 0.3); },
  pay: () => { beep(392, 0, 0.18, 'sine', 0.07); beep(294, 0.1, 0.25, 'sine', 0.06); },
  turn: () => { beep(660, 0, 0.12); beep(880, 0.1, 0.25); },
  win: () => [523, 659, 784, 1046].forEach((f, i) => beep(f, i * 0.1, 0.5)),
};

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
socket.on('session', s => { store.set(SESSION_KEY, JSON.stringify(s)); homeView = false; });
socket.on('state', s => {
  clockOffset = s.serverNow - Date.now();
  const prev = state;
  state = s;
  fxOnState(prev, s);
  render();
});
socket.on('kicked', r => { leftRoom(); toast(t(r && r.closed ? 'toast.roomClosed' : 'toast.kicked')); });
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
  if (state && state.phase === 'playing' && !state.me.spectator && !(await askConfirm({ title: t('ui.leaveRoom'), text: t('mono.confirmResign'), danger: true }))) return;
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
  Site.setHome(screen === 'home');
}

function render() {
  i18nVariant = state && state.me && state.settings && state.settings.family ? 'family' : null;
  const inRoom = !!(state && state.me) && !homeView;
  document.body.dataset.phase = inRoom ? state.phase : 'home';
  $('#topRoom').classList.toggle('hidden', !inRoom);
  $('#leaveBtn').classList.toggle('hidden', !inRoom);
  if (inRoom) $('#topCode').textContent = state.code;
  $('#topRound').textContent = inRoom && state.game ? t('mono.round', { n: state.game.round }) : '';
  if (inRoom && urlRoom !== state.code) { urlRoom = state.code; history.replaceState(null, '', `/monopoly/?room=${state.code}`); }
  renderReactBar();
  updateTurnAlert(monoNeed());
  if (!inRoom) return show('home');
  if (state.phase === 'lobby') { show('lobby'); return renderLobby(); }
  show('game');
  renderGame();
}

// ---------- lobby ----------
for (const input of $$('[data-rule]')) {
  input.addEventListener('change', () => send('settings', {
    [input.dataset.rule]: input.checked,
    // family mode comes with a shorter game unless the host already chose a length
    ...(input.dataset.rule === 'family' && input.checked && !state.settings.roundLimit ? { roundLimit: 20 } : {}),
  }));
}
$('#startingCash').addEventListener('change', e => send('settings', { startingCash: parseInt(e.target.value, 10) }));
$('#turnSeconds').addEventListener('change', e => send('settings', { turnSeconds: parseInt(e.target.value, 10) || 0 }));
$('#mortgageTurns').addEventListener('change', e => send('settings', { mortgageTurns: parseInt(e.target.value, 10) || 0 }));
$('#roundLimit').addEventListener('change', e => send('settings', { roundLimit: parseInt(e.target.value, 10) || 0 }));
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
      <span class="pname"><b class="${nameCls(p.cos)}">${esc(p.name)}</b>${titleTag(p.title)}${statusPill(p.score)}${p.id === state.hostId ? `<span class="tag host">${esc(t('tag.host'))}</span>` : ''}</span>
      ${isHost() ? `<button class="ghost small icon-only" data-rename="${p.id}" title="${esc(t('rename.btn'))}" aria-label="${esc(t('rename.btn'))}">✎</button>` : ''}
      ${isHost() && p.id !== state.me.id ? `<button class="ghost small" data-kick="${p.id}">${esc(t('ui.remove'))}</button>` : ''}
    </li>`).join('');
  for (const b of $$('#lobby [data-kick]')) b.onclick = () => send('kick', { playerId: b.dataset.kick });
  for (const b of $$('#lobby [data-rename]')) b.onclick = e => { e.stopPropagation(); openRename(b.dataset.rename, b, nameOf(b.dataset.rename)); };
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
  $('#spectatorList').innerHTML = state.spectators.map(w => `<span class="spectator">${avatar(w.name, w.avatar, w.cos)}<b>${esc(w.name)}</b>${isHost() ? `<button class="ghost small icon-only" data-rename="${w.id}" aria-label="${esc(t('rename.btn'))}">✎</button>` : ''}</span>`).join('');
  $('#shareCode').innerHTML = esc(t('ui.shareCode', { code: '\u0000' })).replace('\u0000', `<strong class="code">${esc(state.code)}</strong>`);
  const qr = `/qr.svg?room=${state.code}&game=mono`;
  if ($('#inviteQr').getAttribute('src') !== qr) $('#inviteQr').src = qr;

  $('#setupSummary').innerHTML = [
    `${t('mono.startingCash')}: ${money(s.startingCash)}`,
    s.turnSeconds ? `${t('mono.turnTime').split('(')[0].trim()}: ${s.turnSeconds} s` : t('mono.turnTime').split('(')[0].trim() + ': ∞',
    s.mortgageTurns ? `${t('mono.mortgageTurns').split('(')[0].trim()}: ${s.mortgageTurns}` : '',
    s.roundLimit ? t('mono.sumRounds', { n: s.roundLimit }) : '',
    ...['doubleGo', 'auctions', 'freeParking', 'noRentInJail'].filter(k => s[k]).map(k => t('mono.rule.' + k)),
    s.family ? t('ui.family') : '',
  ].filter(Boolean).map(x => `<li>${esc(x)}</li>`).join('');
  $('#hostSettings').classList.toggle('hidden', !isHost());
  $('#startBtn').classList.toggle('hidden', !isHost());
  $('#waitHost').classList.toggle('hidden', isHost());
  $('#startBtn').disabled = state.players.length < state.minPlayers;
  $('#startBtn').textContent = state.players.length < state.minPlayers ? t('mono.needPlayers', { n: state.minPlayers }) : `${t('mono.start')} · ${t('ui.readyCount', { n: readyN, total: state.players.length })}`;
  if (isHost()) {
    setIfNotFocused($('#startingCash'), s.startingCash);
    setIfNotFocused($('#turnSeconds'), s.turnSeconds);
    setIfNotFocused($('#mortgageTurns'), s.mortgageTurns);
    setIfNotFocused($('#roundLimit'), s.roundLimit || 0);
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
  go: svg('<path d="M20 12H7M12 6l-6 6 6 6"/>'),
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

// Full-colour drawings for the special squares, in the spirit of the classic board.
const ART = {
  chance: `<svg class="art art-chance" viewBox="0 0 40 48" aria-hidden="true">
    <text x="20" y="41" text-anchor="middle" font-size="46" font-weight="900" font-family="Georgia, 'Times New Roman', serif"
      fill="#f97316" stroke="#7c2d12" stroke-width="1.6" paint-order="stroke">?</text></svg>`,
  chest: `<svg class="art art-chest" viewBox="0 0 48 40" aria-hidden="true">
    <path d="M5 17V12a8 8 0 0 1 8-8h22a8 8 0 0 1 8 8v5z" fill="#2563eb" stroke="#0b1d4a" stroke-width="2"/>
    <rect x="5" y="17" width="38" height="20" rx="2" fill="#1d4ed8" stroke="#0b1d4a" stroke-width="2"/>
    <rect x="11" y="4.6" width="5" height="32" fill="#f5c542" stroke="#7a5b00" stroke-width="1"/>
    <rect x="32" y="4.6" width="5" height="32" fill="#f5c542" stroke="#7a5b00" stroke-width="1"/>
    <rect x="5" y="16" width="38" height="3.5" fill="#f5c542" stroke="#7a5b00" stroke-width="1"/>
    <rect x="20" y="14" width="8" height="10" rx="1.5" fill="#fde68a" stroke="#7a5b00" stroke-width="1.2"/>
    <circle cx="24" cy="18.5" r="1.5" fill="#7a5b00"/><rect x="23.3" y="19" width="1.4" height="3" fill="#7a5b00"/></svg>`,
  car: `<svg class="art art-car" viewBox="0 0 66 38" aria-hidden="true">
    <path d="M5 26q0-7 7-8l8-1q6-9 15-9h8q7 0 11 9l5 1q5 1 5 8v3H5z" fill="#dc2626" stroke="#450a0a" stroke-width="2" stroke-linejoin="round"/>
    <path d="M23 17q5-7 12-7h4v7z M42 10h1q5 0 8 7h-9z" fill="#bae6fd" stroke="#450a0a" stroke-width="1.5"/>
    <circle cx="18" cy="29" r="6" fill="#111827"/><circle cx="18" cy="29" r="2.4" fill="#d1d5db"/>
    <circle cx="50" cy="29" r="6" fill="#111827"/><circle cx="50" cy="29" r="2.4" fill="#d1d5db"/>
    <rect x="57" y="21" width="5" height="3" rx="1" fill="#fde047"/></svg>`,
  police: `<svg class="art art-police" viewBox="0 0 48 40" aria-hidden="true">
    <path d="M8 21Q7 7 24 5q17 2 16 16z" fill="#1e3a8a" stroke="#0b1d4a" stroke-width="2"/>
    <rect x="8" y="20" width="32" height="6" fill="#111827"/>
    <path d="M5 26h38q-4 9-19 9T5 26z" fill="#0f172a"/>
    <path d="M24 9l2 4.2 4.6.6-3.4 3.2.9 4.5L24 19.3l-4.1 2.2.9-4.5-3.4-3.2 4.6-.6z" fill="#f5c542" stroke="#7a5b00" stroke-width=".8"/></svg>`,
  train: `<svg class="art art-train" viewBox="0 0 66 42" aria-hidden="true">
    <circle cx="16" cy="6" r="3.2" fill="#cbd5e1"/><circle cx="21" cy="3.5" r="2.4" fill="#e2e8f0"/>
    <path d="M13 10h7l-1 6h-5z" fill="#111827"/>
    <rect x="8" y="15" width="34" height="14" rx="6" fill="#111827"/>
    <rect x="40" y="7" width="17" height="22" rx="1.5" fill="#1f2937"/>
    <rect x="44" y="10" width="9" height="7" rx="1" fill="#fde68a"/>
    <path d="M8 23l-6 6h8z" fill="#374151"/><rect x="5" y="19" width="5" height="4" rx="1" fill="#fbbf24"/>
    <rect x="6" y="29" width="54" height="3" fill="#374151"/>
    <circle cx="17" cy="34" r="5" fill="#111827" stroke="#9ca3af" stroke-width="1.5"/>
    <circle cx="30" cy="34" r="5" fill="#111827" stroke="#9ca3af" stroke-width="1.5"/>
    <circle cx="48" cy="33" r="6" fill="#111827" stroke="#9ca3af" stroke-width="1.5"/>
    <path d="M17 34h31" stroke="#9ca3af" stroke-width="1.6"/></svg>`,
  bulb: `<svg class="art art-bulb" viewBox="0 0 40 48" aria-hidden="true">
    <path d="M20 4a13 13 0 0 0-8 23c2 2 3 4 3 6h10c0-2 1-4 3-6A13 13 0 0 0 20 4z" fill="#fde047" stroke="#a16207" stroke-width="2"/>
    <path d="M16 26q4-8 8 0" fill="none" stroke="#a16207" stroke-width="1.6"/>
    <rect x="14" y="33" width="12" height="4" rx="1" fill="#9ca3af" stroke="#4b5563"/><rect x="15" y="37" width="10" height="4" rx="1" fill="#6b7280" stroke="#374151"/>
    <rect x="17" y="41" width="6" height="3" rx="1" fill="#374151"/>
    <path d="M3 17h4M33 17h4M7 5l3 3M33 5l-3 3" stroke="#f59e0b" stroke-width="2" stroke-linecap="round"/></svg>`,
  tap: `<svg class="art art-tap" viewBox="0 0 48 44" aria-hidden="true">
    <rect x="18" y="4" width="12" height="4" rx="2" fill="#6b7280" stroke="#374151"/><rect x="22.5" y="7" width="3" height="6" fill="#6b7280"/>
    <path d="M4 14h26a8 8 0 0 1 8 8v4h-8v-4H4z" fill="#9ca3af" stroke="#374151" stroke-width="2" stroke-linejoin="round"/>
    <path d="M34 30c0 0-4 5-4 8a4 4 0 0 0 8 0c0-3-4-8-4-8z" fill="#38bdf8" stroke="#0369a1" stroke-width="1.5"/></svg>`,
  coins: `<svg class="art art-coins" viewBox="0 0 48 40" aria-hidden="true">
    ${[30, 24, 18, 12].map((y, k) => `<ellipse cx="${k % 2 ? 22 : 20}" cy="${y}" rx="13" ry="4.5" fill="#f5c542" stroke="#7a5b00" stroke-width="1.5"/>`).join('')}
    <ellipse cx="34" cy="31" rx="10" ry="3.6" fill="#fcd34d" stroke="#7a5b00" stroke-width="1.5"/>
    <text x="20" y="14.2" text-anchor="middle" font-size="7" font-weight="900" fill="#7a5b00">₽</text></svg>`,
  ring: `<svg class="art art-ring" viewBox="0 0 40 44" aria-hidden="true">
    <circle cx="20" cy="29" r="11" fill="none" stroke="#d4a017" stroke-width="4"/>
    <path d="M13 12l7-8 7 8-7 9z" fill="#bae6fd" stroke="#0369a1" stroke-width="1.5"/>
    <path d="M13 12h14M20 4v17M16.5 8l3.5 4 3.5-4" fill="none" stroke="#0369a1" stroke-width=".8"/></svg>`,
  arrow: `<svg class="art art-arrow" viewBox="0 0 64 34" aria-hidden="true">
    <path d="M62 11H24V2L2 17l22 15v-9h38z" fill="#dc2626" stroke="#7f1d1d" stroke-width="2" stroke-linejoin="round"/></svg>`,
  bars: `<svg class="art art-bars" viewBox="0 0 40 40" aria-hidden="true">
    <rect x="1" y="1" width="38" height="38" fill="#f97316" stroke="#111827" stroke-width="2"/>
    <circle cx="20" cy="17" r="6" fill="#fde68a" stroke="#111827" stroke-width="1.5"/>
    <path d="M12 39v-8q8-7 16 0v8z" fill="#111827"/>
    ${[8, 16, 24, 32].map(x => `<rect x="${x - 1.4}" y="1" width="2.8" height="38" fill="#111827"/>`).join('')}</svg>`,
};

function cellHtml(sq, i) {
  if (sq.type === 'go') return `<span class="corner-art go-art"><span class="go-word">${esc(sqShort(i))}</span>${ART.arrow}<span class="go-sal">+${money(200)}</span></span>`;
  if (sq.type === 'jail') return `<span class="jail-art"><span class="jail-cell">${ART.bars}<b>${esc(sqShort(i))}</b></span>
    <span class="visit visit-l">${esc(t('mono.visit1'))}</span><span class="visit visit-b">${esc(t('mono.visit2'))}</span></span>`;
  if (sq.type === 'parking') return `<span class="corner-art">${ART.car}<b class="corner-name">${esc(sqShort(i))}</b></span>`;
  if (sq.type === 'gotojail') return `<span class="corner-art">${ART.police}<b class="corner-name">${esc(sqShort(i))}</b></span>`;
  // Chance and the Chest: everyone knows the picture, no caption needed
  if (sq.type === 'chance') return `<span class="sq-body only-art">${ART.chance}</span>`;
  if (sq.type === 'chest') return `<span class="sq-body only-art">${ART.chest}</span>`;
  if (sq.type === 'tax') return `<span class="sq-body only-art">${i === 4 ? ART.coins : ART.ring}</span><span class="tag-price tax">${tagMoney(sq.amount)}</span>`;
  if (sq.type === 'utility') return `<span class="sq-body only-art">${i === 12 ? ART.bulb : ART.tap}</span><span class="tag-price">${tagMoney(sq.price)}</span><span class="lock">${ICONS.lock}</span>`;
  if (sq.type === 'railway') return `<span class="sq-body">${ART.train}<span class="sq-name">${esc(sqShort(i))}</span></span><span class="tag-price">${tagMoney(sq.price)}</span><span class="lock">${ICONS.lock}</span>`;
  return `<span class="strip"><span class="bldg"></span></span>
    <span class="sq-body"><span class="sq-name">${esc(sqShort(i))}</span></span>
    <span class="tag-price">${tagMoney(sq.price)}</span><span class="lock">${ICONS.lock}</span>`;
}

function buildBoard() {
  if (!BOARD) return;
  $('#squares').innerHTML = BOARD.squares.map((sq, i) => {
    const [row, col, side] = gridPos(i);
    return `<button class="sq ${side} t-${sq.type} ${sq.group ? 'g-' + sq.group : ''}" style="grid-row:${row};grid-column:${col}" data-sq="${i}" aria-label="${esc(sqName(i))}">${cellHtml(sq, i)}</button>`;
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
    if (tag && sq.price) tag.textContent = pr && pr.mortgaged ? (pr.mortgageLeft || '') : tagMoney(pr ? rentNow(i) : sq.price);
    const nm = el.querySelector('.sq-name');
    if (nm) nm.textContent = sqShort(i);
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
    if (steps) flashSquare(target, pid);
    return;
  }
  hopping[pid] = true;
  let left = steps;
  const tick = () => {
    shownPos[pid] = (shownPos[pid] + 1) % 40;
    placeTokens();
    beep(500 + (steps - left) * 40, 0, 0.05, 'sine', 0.025);
    if (--left > 0) setTimeout(tick, 150);
    else {
      hopping[pid] = false;
      if (shownPos[pid] !== gp(pid).pos) hop(pid, gp(pid).pos);
      else flashSquare(target, pid);
    }
  };
  setTimeout(tick, 120);
}
window.addEventListener('resize', () => state && state.game && placeTokens());

// where a token lands lights up in the player's colour
function flashSquare(sq, pid) {
  const el = $(`#squares [data-sq="${sq}"]`);
  if (!el) return;
  el.style.setProperty('--flash', colorOf(pid));
  el.classList.remove('landed');
  void el.offsetWidth;
  el.classList.add('landed');
  setTimeout(() => el.classList.remove('landed'), 1400);
}

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
  if (prev.gameId === s.gameId) requestAnimationFrame(() => moneyFx(prev.game, g));
  const pg = prev.game.players[me];
  if (pg && g.players[me]) {
    if (g.players[me].cash > pg.cash) SFX.coin();
    else if (g.players[me].cash < pg.cash) SFX.pay();
  }
  if (s.phase === 'ended' && prev.phase !== 'ended') { SFX.win(); setTimeout(openResults, 900); }
}
// Money that changed hands: each card shows +/− for a moment, and a single payment (rent, a
// deal's cash) flies as a chip from the payer's card to the receiver's.
const fxLayer = document.createElement('div');
fxLayer.className = 'money-layer';
fxLayer.setAttribute('aria-hidden', 'true');
document.body.append(fxLayer);
function moneyFx(prevG, g) {
  const deltas = g.order.map(pid => [pid, g.players[pid].cash - (prevG.players[pid] ? prevG.players[pid].cash : g.players[pid].cash)]).filter(([, d]) => d);
  if (!deltas.length || reducedMotion()) return;
  const card = pid => $(`#playerList [data-pid="${pid}"]`);
  const neg = deltas.filter(([, d]) => d < 0);
  const pos = deltas.filter(([, d]) => d > 0);
  if (neg.length === 1 && pos.length === 1 && -neg[0][1] === pos[0][1]) {
    const from = card(neg[0][0]), to = card(pos[0][0]);
    if (from && to) {
      const a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
      const chip = document.createElement('span');
      chip.className = 'money-chip';
      chip.style.setProperty('--pc', colorOf(neg[0][0]));
      chip.textContent = `${money(pos[0][1])} → ${nameOf(pos[0][0])}`;
      chip.style.left = `${a.left + a.width / 2}px`;
      chip.style.top = `${a.top + a.height / 2}px`;
      chip.style.setProperty('--dx', `${b.left - a.left}px`);
      chip.style.setProperty('--dy', `${b.top - a.top}px`);
      fxLayer.append(chip);
      chip.addEventListener('animationend', () => chip.remove());
      setTimeout(() => chip.remove(), 2500);
    }
  }
  for (const [pid, d] of deltas) {
    const el = card(pid);
    if (!el) continue;
    const r = el.querySelector('.pc-cash').getBoundingClientRect();
    const pop = document.createElement('span');
    pop.className = `cash-pop ${d > 0 ? 'up' : 'down'}`;
    pop.textContent = `${d > 0 ? '+' : '−'}${money(Math.abs(d))}`;
    pop.style.left = `${r.right + 6}px`;
    pop.style.top = `${r.top + r.height / 2}px`;
    fxLayer.append(pop);
    pop.addEventListener('animationend', () => pop.remove());
    setTimeout(() => pop.remove(), 2500);
    el.classList.remove('cash-up', 'cash-down');
    void el.offsetWidth;
    el.classList.add(d > 0 ? 'cash-up' : 'cash-down');
  }
}

// ---------- turn alerts: chime, buzz and a blinking tab title when the game needs you ----------
function monoNeed() {
  if (!state || !state.me || state.phase !== 'playing' || !state.game) return null;
  const g = state.game;
  const me = state.me.id;
  const mine = gp(me);
  if (!mine || mine.bankrupt) return null;
  const deal = g.trades.find(x => x.to === me);
  if (deal) return { key: `deal:${deal.id}`, text: t('mono.alert.deal', { name: nameOf(deal.from) }) };
  if (g.auction) {
    const a = g.auction;
    const canBid = a.bidder !== me && mine.cash >= (a.bidder ? a.bid + 1 : a.min);
    return canBid ? { key: `auction:${g.round}:${g.turn.pid}:${a.square}`, text: t('mono.alert.auction', { square: sqShort(a.square) }) } : null;
  }
  if (g.debts.length) return g.debts[0].pid === me ? { key: `debt:${g.round}:${g.debts[0].amount}`, text: t('mono.alert.debt') } : null;
  if (g.turn.pid === me) return { key: `turn:${g.round}`, text: t('mono.alert.turn') };
  return null;
}

// 3D dice: each die is a cube that tumbles and lands on the rolled face
const PIPS = { 1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };
const FACE_ROT = { 1: [0, 0], 2: [0, -90], 3: [-90, 0], 4: [90, 0], 5: [0, 90], 6: [0, 180] }; // [x, y] to show each face
const faceHtml = n => `<span class="face f${n}">${Array.from({ length: 9 }, (_, i) => `<i class="${PIPS[n].includes(i + 1) ? 'pip' : ''}"></i>`).join('')}</span>`;
function ensureDice() {
  const box = $('#dice');
  if (box.querySelector('.cube')) return;
  box.innerHTML = [0, 1].map(() => `<span class="die3d"><span class="cube">${[1, 2, 3, 4, 5, 6].map(faceHtml).join('')}</span></span>`).join('');
}
const spins = [0, 0];
function drawDice(d, animate = false) {
  ensureDice();
  $$('#dice .cube').forEach((cube, k) => {
    const [x, y] = FACE_ROT[d[k]];
    if (animate) spins[k] += 2 + Math.floor(Math.random() * 2); // extra full turns so it really tumbles
    cube.style.transition = animate ? `transform ${0.9 + k * 0.15}s cubic-bezier(.2, .9, .25, 1.05)` : 'none';
    cube.style.transform = `rotateX(${x + spins[k] * 360}deg) rotateY(${y + spins[k] * 360}deg)`;
  });
  $('#dice').classList.toggle('doubles', d[0] === d[1]);
  if (animate) {
    $('#dice').classList.remove('bounce');
    void $('#dice').offsetWidth;
    $('#dice').classList.add('bounce');
  }
}
function animateDice(final) {
  drawDice(final, !reducedMotion());
}

// ---------- game screen ----------
function renderGame() {
  if (!BOARD) return;
  const g = state.game;
  updateBoard();
  renderCenter();
  renderPlayers();
  renderDeal();
  if (deal && !$('#tradeModal').classList.contains('hidden')) renderTrade();
  if (!$('#sqInfo').classList.contains('hidden') && openSq !== null) openSquare(openSq, true);
  $('#bankInfo').innerHTML = `<span class="bank-item" title="${esc(t('mono.bankSupply', { h: g.housesLeft, t: g.hotelsLeft }))}"><i class="house"></i>${g.housesLeft}</span>
    <span class="bank-item"><i class="hotel"></i>${g.hotelsLeft}</span>
    ${state.settings.freeParking ? `<span class="bank-item" title="${esc(t('mono.pot', { n: g.pot }))}">${ART.car}${money(g.pot)}</span>` : ''}`;
  const playing = state.phase === 'playing' && !state.me.spectator && gp(state.me.id) && !gp(state.me.id).bankrupt;
  $('#resignBtn').classList.toggle('hidden', !playing);
  $('#autoEndBtn').classList.toggle('hidden', !playing);
  renderAutoEnd();
  $('#restartBtn').classList.toggle('hidden', !(isHost() && state.phase === 'ended'));
}

function fmtLog(e) {
  const p = { ...e.params };
  if (p.square !== undefined) p.square = sqName(p.square);
  if (p.deck) p.deck = t('mono.deck.' + p.deck);
  if (p.card) p.card = t('mono.card.' + p.card);
  return t(e.key, p);
}

const kbd = k => `<kbd class="kb">${k}</kbd>`;

// Keyboard: Space rolls / ends the turn / pays a debt, B buys, A sends it to auction,
// P pays bail, 1-3 are the quick bids. Ignored while typing or with a window open.
document.addEventListener('keydown', e => {
  if (!state || state.phase !== 'playing' || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  if (e.target.closest && e.target.closest('input, textarea, select, button, [contenteditable]')) return;
  if ($$('.overlay:not(.hidden)').length) return;
  const press = sel => {
    const b = $(sel);
    if (!b || b.disabled) return false;
    e.preventDefault();
    b.click();
    return true;
  };
  const keys = { Space: ['#rollBtn', '#endBtn', '#payDebtBtn'], KeyB: ['#buyBtn'], KeyA: ['#declineBtn'], KeyP: ['#bailBtn'] };
  const digit = /^Digit([1-3])$/.exec(e.code);
  if (digit) press(`#actions [data-key="${digit[1]}"]`);
  else for (const sel of keys[e.code] || []) if (press(sel)) break;
});

// "Auto-end turn": when there's nothing left to do, end the turn after a short pause
// (paused while a property card or the trade window is open).
let autoEnd = store.get(AUTO_END_KEY) === 'on';
let autoEndTimer = null;
function scheduleAutoEnd() {
  if (autoEndTimer) return;
  const key = `${state.game.round}:${state.game.lastDice && state.game.lastDice.at}`;
  autoEndTimer = setTimeout(function fire() {
    const g = state && state.game;
    const still = autoEnd && g && state.phase === 'playing' && g.turn && g.turn.pid === state.me.id && g.turn.stage === 'end' && !g.debts.length && !g.auction
      && `${g.round}:${g.lastDice && g.lastDice.at}` === key;
    if (still && $$('.overlay:not(.hidden)').length) { autoEndTimer = setTimeout(fire, 1000); return; }
    autoEndTimer = null;
    if (still) send('endTurn');
  }, 2000);
}
function renderAutoEnd() {
  const b = $('#autoEndBtn');
  b.classList.toggle('on', autoEnd);
  b.setAttribute('aria-pressed', String(autoEnd));
  b.textContent = t('mono.autoEnd');
  b.title = t('mono.autoEndHint');
}
$('#autoEndBtn').onclick = () => {
  autoEnd = !autoEnd;
  store.set(AUTO_END_KEY, autoEnd ? 'on' : null);
  renderAutoEnd();
  if (autoEnd && state && state.game && state.game.turn && state.game.turn.pid === state.me.id && state.game.turn.stage === 'end') scheduleAutoEnd();
};

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
        ${a.bidder ? [10, 50, 100].map((x, k) => `<button class="small" data-bid="${a.bid + x}" data-key="${k + 1}">+${x}${kbd(k + 1)}</button>`).join('') : `<button class="small" data-bid="${a.min}" data-key="1">${money(a.min)}${kbd(1)}</button>`}
        <input id="bidInput" type="number" step="10" min="${a.bidder ? a.bid + 1 : a.min}" value="${a.bidder ? a.bid + 10 : a.min}">
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
            <button id="rollBtn" class="primary big-roll">${esc(t('mono.roll'))}${kbd('␣')}</button>
            <button id="bailBtn" ${myGp.cash < 50 ? 'disabled' : ''}>${esc(t('mono.payBail', { n: 50 }))}${kbd('P')}</button>
            ${myGp.jailCards ? `<button id="cardBtn">${esc(t('mono.useCard'))}</button>` : ''}</div>`
        : `<button id="rollBtn" class="primary big-roll">${esc(t('mono.roll'))}${kbd('␣')}</button>`;
    } else if (st === 'buy') {
      const sq = g.turn.offer;
      const price = BOARD.squares[sq].price;
      html = `<button class="mini-deed g-${BOARD.squares[sq].group || BOARD.squares[sq].type}" data-info="${sq}"><span class="md-strip"></span><b>${esc(sqName(sq))}</b><span class="md-price">${price} ₽</span></button>
        <div class="row center"><button id="buyBtn" class="primary" ${myGp.cash < price ? 'disabled' : ''}>${esc(t('mono.buy', { price }))}${kbd('B')}</button>
        <button id="declineBtn">${esc(t(state.settings.auctions ? 'mono.decline' : 'mono.declineNoAuction'))}${kbd('A')}</button></div>`;
    } else if (st === 'end') {
      html = `<button id="endBtn" class="primary">${esc(t('mono.endTurn'))}${kbd('␣')}</button>`;
      if (autoEnd) scheduleAutoEnd();
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
  bind('#bankruptBtn', async () => (await askConfirm({ title: t('mono.goBankrupt'), text: t('mono.confirmBankrupt'), danger: true })) && send('bankrupt'));
  bind('#bidBtn', () => send('bid', { amount: parseInt($('#bidInput').value, 10) }));
  for (const b of $$('[data-bid]')) b.onclick = () => send('bid', { amount: Number(b.dataset.bid) });

  // the last few events, newest at the bottom
  const byName = name => [...state.players, ...state.spectators].find(p => p.name === name);
  $('#feed').innerHTML = g.log.slice(-5).map((e, i, arr) => {
    const who = e.params && byName(e.params.name);
    return `<li style="--age:${arr.length - 1 - i}">${who ? `<span class="pdot" style="--pc:${colorOf(who.id)}"></span>` : ''}${esc(fmtLog(e))}</li>`;
  }).join('');

  // the card just drawn
  const card = g.lastCard;
  const cs = $('#cardShow');
  if (card) {
    cs.className = `card-show deck-${card.deck}`;
    cs.innerHTML = `<div class="card-deck">${esc(t('mono.deck.' + card.deck))}</div><div class="card-text">${esc(t('mono.card.' + card.id))}</div>`;
  } else cs.classList.add('hidden');
  $('#logBtn').innerHTML = `${COMMON_ICONS.list}<span>${esc(t('mono.log.all', { n: g.log.length }))}</span>`;
  if (!$('#logSheet').classList.contains('hidden')) renderLog();
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
    const tags = [s.inJail ? `<span class="tag">${esc(t('mono.jail'))}</span>` : '', s.bankrupt ? `<span class="tag mafia">${esc(t('mono.bankrupt'))}</span>` : '',
      p.connected === false ? `<span class="tag">${esc(t('tag.offline'))}</span>` : '', s.jailCards ? `<span class="tag key-tag" title="${esc(t('mono.trade.cards'))}"><svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M14 9l2 2"/></svg>×${s.jailCards}</span>` : ''].join('');
    return `<div class="pcard ${pid === turnPid ? 'turn' : ''} ${s.bankrupt ? 'out' : ''} ${pid === state.me.id ? 'me' : ''}" data-pid="${pid}" style="--pc:${colorOf(pid)}">
      <span class="avatar-wrap clickable pc-wrap" data-open-player="${p.userId || ''}">${avatar(p.name, p.avatar, p.cos)}</span>
      <div class="pc-main">
        <div class="pc-top"><b class="pc-name ${nameCls(p.cos)}">${esc(p.name)}</b>${tags}</div>
        <div class="pc-cash">${money(s.cash)}</div>
      </div>
      ${pid === turnPid && deadline ? '<span class="pc-timer"><span id="pcTimerFill"></span></span>' : ''}
    </div>`;
  }).join('');
  for (const el of $$('#playerList .pcard')) el.onclick = e => { e.stopPropagation(); openPlayerMenu(el.dataset.pid, el); };
}

// ---------- square details ----------
let openSq = null;
function openSquare(i, refresh = false) {
  openSq = i;
  const s = BOARD.squares[i];
  const g = state && state.game;
  const pr = g && g.props[i];
  let body = '';
  if (s.type === 'street') {
    body = `<table class="rent-table">
      <tr><td>${esc(t('mono.rent'))}</td><td>${money(s.rent[0])}</td></tr>
      <tr><td>${esc(t('mono.rentSet'))}</td><td>${money(s.rent[0] * 2)}</td></tr>
      ${[1, 2, 3, 4].map(n => `<tr><td>${esc(t('mono.rentHouses', { n }))}</td><td>${money(s.rent[n])}</td></tr>`).join('')}
      <tr><td>${esc(t('mono.rentHotel'))}</td><td>${money(s.rent[5])}</td></tr>
      <tr class="sep"><td>${esc(t('mono.houseCost'))}</td><td>${money(s.house)}</td></tr>
      <tr><td>${esc(t('mono.mortgageValue'))}</td><td>${money(s.price / 2)}</td></tr></table>`;
  } else if (s.type === 'railway') {
    body = `<table class="rent-table">${BOARD.railwayRent.map((r, k) => `<tr><td>${esc(t('mono.railRent', { n: k + 1 }))}</td><td>${money(r)}</td></tr>`).join('')}
      <tr class="sep"><td>${esc(t('mono.mortgageValue'))}</td><td>${money(s.price / 2)}</td></tr></table>`;
  } else if (s.type === 'utility') {
    body = `<p>${esc(t('mono.utilRent'))}</p><table class="rent-table"><tr><td>${esc(t('mono.mortgageValue'))}</td><td>${money(s.price / 2)}</td></tr></table>`;
  } else if (s.type === 'tax') body = `<p class="big-amount">${money(s.amount)}</p>`;
  $('#sqCard').innerHTML = `
    <div class="sq-head g-${s.group || s.type}"><span>${esc(sqName(i))}</span></div>
    ${s.price ? `<div class="sq-meta"><span>${esc(t('mono.price'))}: <b>${money(s.price)}</b></span><span>${pr ? `${esc(t('mono.owner'))}: <b style="color:${colorOf(pr.owner)}">${esc(nameOf(pr.owner))}</b>${pr.mortgaged ? ` · ${esc(t('mono.mortgaged'))}` : ''}` : esc(t('mono.unowned'))}</span></div>` : ''}
    ${pr && pr.mortgaged && pr.mortgageLeft ? `<p class="sq-warn">${esc(t('mono.mortgageLeft', { n: pr.mortgageLeft }))}</p>` : ''}
    ${body}
    ${manageHtml(i)}
    <button id="sqClose" class="ghost small">${esc(t('ui.close'))}</button>`;
  if (!refresh) $('#sqInfo').classList.remove('hidden');
  $('#sqClose').onclick = () => { $('#sqInfo').classList.add('hidden'); openSq = null; };
  for (const b of $$('#sqCard [data-act]')) b.onclick = () => send(b.dataset.act, { square: i });
}

// Build / sell / mortgage live on the property's own card — the one place to manage it.
function manageHtml(i) {
  const g = state && state.game;
  if (!g || state.phase !== 'playing' || !state.me) return '';
  const pr = g.props[i];
  const me = state.me.id;
  if (!pr || pr.owner !== me || !gp(me) || gp(me).bankrupt) return '';
  const s = BOARD.squares[i];
  const cash = gp(me).cash;
  const set = s.group ? BOARD.groups[s.group] : [];
  const ownsSet = s.group && set.every(x => g.props[x] && g.props[x].owner === me);
  const groupBuilt = set.some(x => g.props[x] && g.props[x].houses);
  const myTurn = g.turn && g.turn.pid === me && !g.debts.length;
  const btns = [];
  if (s.type === 'street' && ownsSet && !pr.mortgaged && pr.houses < 5) {
    const min = Math.min(...set.map(x => g.props[x].houses));
    btns.push(`<button class="primary small" data-act="build" ${!myTurn || pr.houses !== min || cash < s.house || set.some(x => g.props[x].mortgaged) ? 'disabled' : ''}>${esc(t('mono.build'))} · ${money(s.house)}</button>`);
  }
  if (pr.houses) btns.push(`<button class="small" data-act="sell">${esc(t('mono.sell'))} · +${money(s.house / 2)}</button>`);
  if (!pr.mortgaged && !groupBuilt) btns.push(`<button class="small" data-act="mortgage">${esc(t('mono.mortgage', { n: money(s.price / 2) }))}</button>`);
  if (pr.mortgaged) btns.push(`<button class="small" data-act="unmortgage" ${cash < g.unmortgageCosts[i] ? 'disabled' : ''}>${esc(t('mono.unmortgage', { n: money(g.unmortgageCosts[i]) }))}</button>`);
  return btns.length ? `<div class="sq-manage"><span class="muted small-text">${esc(t('mono.yourProperty'))}</span><div class="row">${btns.join('')}</div></div>` : '';
}

// ---------- player menu: deal or profile ----------
function openPlayerMenu(pid, anchor) {
  const menu = $('#playerMenu');
  const p = member(pid) || {};
  const g = state.game;
  const me = state.me.id;
  const canTrade = state.phase === 'playing' && pid !== me && gp(me) && !gp(me).bankrupt && gp(pid) && !gp(pid).bankrupt;
  menu.innerHTML = `<div class="mark-title">${esc(p.name || '')}</div>
    ${canTrade ? `<button class="mk" data-menu="trade">${esc(t('mono.menu.trade'))}</button>` : ''}
    ${p.userId ? `<button class="mk" data-menu="profile">${esc(t('mono.menu.profile'))}</button>` : ''}`;
  if (!menu.querySelector('button')) return;
  menu.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${window.scrollX + Math.min(window.innerWidth - menu.offsetWidth - 12, r.right + 8)}px`;
  menu.style.top = `${window.scrollY + r.top}px`;
  menu.querySelector('[data-menu="trade"]')?.addEventListener('click', () => { menu.classList.add('hidden'); openTrade(pid); });
  menu.querySelector('[data-menu="profile"]')?.addEventListener('click', () => { menu.classList.add('hidden'); openPlayer(p.userId); });
  void g;
}
document.addEventListener('pointerdown', e => { if (!e.target.closest('#playerMenu') && !e.target.closest('.pcard')) $('#playerMenu').classList.add('hidden'); });

// ---------- trade window ----------
// Mirrors the server's fairness rules so players see the problem before sending.
const JAIL_CARD_VALUE = 50;
const sideValue = x => {
  const g = state.game;
  return x.props.reduce((tt, sq) => tt + (g.props[sq] && g.props[sq].mortgaged ? BOARD.squares[sq].price / 2 : BOARD.squares[sq].price), 0) + x.cash + x.cards * JAIL_CARD_VALUE;
};
function tradeCheck(from, to, give, take) {
  const g = state.game;
  const val = sq => (g.props[sq].mortgaged ? BOARD.squares[sq].price / 2 : BOARD.squares[sq].price);
  const value = x => x.props.reduce((tt, sq) => tt + val(sq), 0) + x.cash + x.cards * JAIL_CARD_VALUE;
  const completing = (pid, props, away) => props.filter(sq => {
    const grp = BOARD.squares[sq].group;
    return grp && BOARD.groups[grp].every(x => props.includes(x) || (g.props[x] && g.props[x].owner === pid && !away.includes(x)));
  });
  const fromSet = completing(from, take.props, give.props), toSet = completing(to, give.props, take.props);
  const a = value(give), b = value(take);
  const full = props => props.reduce((tt, sq) => tt + BOARD.squares[sq].price, 0);
  if ((a > 0 && b * 2 < a && !fromSet.length) || (b > 0 && a * 2 < b && !toSet.length)) return { ok: false, msg: t('mono.trade.fairBad') };
  if (toSet.length && !fromSet.length && b < full(toSet)) return { ok: false, msg: t('mono.trade.cheapSet', { min: full(toSet) }) };
  if (fromSet.length && !toSet.length && a < full(fromSet)) return { ok: false, msg: t('mono.trade.cheapSet', { min: full(fromSet) }) };
  return { ok: a + b > 0, msg: a + b > 0 ? t('mono.trade.fairOk') : '' };
}

let deal = null; // { to, give: Set, take: Set, giveCash, takeCash, giveCards, takeCards }
function openTrade(pid) {
  deal = { to: pid, give: new Set(), take: new Set(), giveCash: 0, takeCash: 0, giveCards: 0, takeCards: 0 };
  $('#tradeTitle').textContent = t('mono.trade.title', { name: nameOf(pid) });
  $('#tradeModal').classList.remove('hidden');
  renderTrade();
}
function renderTrade() {
  if (!deal || !state || !state.game) return;
  const g = state.game;
  const me = state.me.id;
  const tradeable = pid => owned(pid).filter(sq => {
    const s = BOARD.squares[sq];
    return !s.group || !BOARD.groups[s.group].some(x => g.props[x] && g.props[x].houses);
  }).sort((a, b) => a - b);
  const tile = (sq, set, key) => `<button class="deed-tile g-${BOARD.squares[sq].group || BOARD.squares[sq].type} ${set.has(sq) ? 'on' : ''} ${g.props[sq].mortgaged ? 'mort' : ''}" data-tile="${key}" data-sq="${sq}">
    <span class="dt-strip"></span><span class="dt-name">${esc(sqShort(sq))}</span><span class="dt-price">${money(BOARD.squares[sq].price)}</span></button>`;
  const side = (pid, key) => {
    const set = deal[key];
    const cashKey = key + 'Cash', cardKey = key + 'Cards';
    const v = sideValue({ props: [...set], cash: deal[cashKey], cards: deal[cardKey] });
    return `<div class="trade-side">
      <div class="side-head"><h4>${esc(t(key === 'give' ? 'mono.trade.give' : 'mono.trade.get'))}</h4><span class="side-value">${money(v)}</span></div>
      <div class="side-who">${pieceOf(pid)}<span>${esc(nameOf(pid))}</span><span class="muted">${money(gp(pid).cash)}</span></div>
      <div class="deed-grid">${tradeable(pid).map(sq => tile(sq, set, key)).join('') || '<span class="muted small-text">—</span>'}</div>
      <label class="tcash">${esc(t('mono.trade.cash'))} <input type="number" min="0" step="10" max="${gp(pid).cash}" data-num="${cashKey}" value="${deal[cashKey]}"></label>
      ${gp(pid).jailCards ? `<label class="tcash">${esc(t('mono.trade.cards'))} <input type="number" min="0" max="${gp(pid).jailCards}" data-num="${cardKey}" value="${deal[cardKey]}"></label>` : ''}
    </div>`;
  };
  const give = { props: [...deal.give], cash: deal.giveCash, cards: deal.giveCards };
  const take = { props: [...deal.take], cash: deal.takeCash, cards: deal.takeCards };
  const check = tradeCheck(me, deal.to, give, take);
  const focused = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.num;
  $('#tradeBody').innerHTML = `<div class="trade-cols">${side(me, 'give')}${side(deal.to, 'take')}</div>
    <div class="trade-foot"><span class="fair ${check.ok ? 'ok' : 'bad'}">${esc(check.msg)}</span>
    <button id="sendTrade" class="primary" ${check.ok ? '' : 'disabled'}>${esc(t('mono.trade.send'))}</button></div>`;
  if (focused) { const el = $(`#tradeBody [data-num="${focused}"]`); if (el) { el.focus(); el.setSelectionRange?.(el.value.length, el.value.length); } }
  for (const b of $$('#tradeBody [data-tile]')) b.onclick = () => { const set = deal[b.dataset.tile]; const sq = Number(b.dataset.sq); set.has(sq) ? set.delete(sq) : set.add(sq); renderTrade(); };
  for (const n of $$('#tradeBody [data-num]')) n.oninput = () => { deal[n.dataset.num] = Math.max(0, parseInt(n.value, 10) || 0); renderTrade(); };
  $('#sendTrade').onclick = async () => {
    const res = await send('trade', { to: deal.to, give, take });
    if (res && res.ok) { $('#tradeModal').classList.add('hidden'); deal = null; }
  };
}
$('#tradeClose').onclick = () => { $('#tradeModal').classList.add('hidden'); deal = null; };
$('#tradeModal').addEventListener('pointerdown', e => { if (e.target.id === 'tradeModal') { $('#tradeModal').classList.add('hidden'); deal = null; } });

// ---------- open deals, shown to the whole table ----------
function renderDeal() {
  const box = $('#dealShow');
  const g = state.game;
  const tr = state.phase === 'playing' && g.trades.length ? g.trades[g.trades.length - 1] : null;
  if (!tr) { box.classList.add('hidden'); box.dataset.id = ''; return; }
  const me = state.me.id;
  const sideHtml = (pid, x) => `<div class="deal-side"><div class="deal-who">${pieceOf(pid)}<b>${esc(t('mono.deal.gives', { name: nameOf(pid) }))}</b><span class="side-value">${money(sideValue(x))}</span></div>
    <div class="deal-items">${x.props.map(sq => `<span class="deal-prop g-${BOARD.squares[sq].group || BOARD.squares[sq].type}"><i></i>${esc(sqShort(sq))}</span>`).join('')}
    ${x.cash ? `<span class="deal-cash">${money(x.cash)}</span>` : ''}${x.cards ? `<span class="deal-cash">${esc(t('mono.trade.cards'))} ×${x.cards}</span>` : ''}
    ${!x.props.length && !x.cash && !x.cards ? `<span class="muted">${esc(t('mono.trade.nothing'))}</span>` : ''}</div></div>`;
  box.innerHTML = `<div class="deal-title">${esc(t('mono.deal.offer', { from: nameOf(tr.from), to: nameOf(tr.to) }))}</div>
    <div class="deal-sides">${sideHtml(tr.from, tr.give)}<span class="deal-arrow">⇄</span>${sideHtml(tr.to, tr.take)}</div>
    <div class="row center">${tr.to === me ? `<button class="primary" data-deal="accept">${esc(t('mono.trade.accept'))}</button><button data-deal="decline">${esc(t('mono.trade.decline'))}</button>`
      : tr.from === me ? `<button data-deal="cancel">${esc(t('mono.trade.cancel'))}</button>` : `<span class="muted small-text">${esc(t('mono.deal.waiting', { name: nameOf(tr.to) }))}</span>`}</div>`;
  if (box.dataset.id !== tr.id) { box.dataset.id = tr.id; box.classList.remove('hidden', 'pop'); void box.offsetWidth; box.classList.add('pop'); if (tr.to !== me) SFX.turn(); }
  box.classList.remove('hidden');
  for (const b of box.querySelectorAll('[data-deal]')) b.onclick = () => send('tradeRespond', { id: tr.id, accept: b.dataset.deal === 'accept' });
}


$('#sqInfo').addEventListener('pointerdown', e => { if (e.target.id === 'sqInfo') $('#sqInfo').classList.add('hidden'); });

// ---------- results: standings, net worth over the game, highlights ----------
function openResults() {
  const g = state.game;
  const rows = g.order.map(pid => ({ pid, s: gp(pid) })).sort((a, b) => {
    if (a.pid === g.winner) return -1;
    if (b.pid === g.winner) return 1;
    // whoever went bankrupt later finished higher (bankruptAt counts the players still left)
    return (a.s.bankruptAt || 0) - (b.s.bankruptAt || 0) || b.s.netWorth - a.s.netWorth;
  });
  const standings = `<ol class="results">${rows.map(({ pid, s }, i) => {
    const p = member(pid) || { name: '?' };
    return `<li class="${i === 0 ? 'first' : ''}"><span class="board-rank">${['🥇', '🥈', '🥉'][i] || i + 1}</span>
      ${pieceOf(pid)}
      <b class="${nameCls(p.cos)}">${esc(p.name)}</b><span class="spacer"></span>
      ${s.bankrupt ? `<span class="tag mafia">${esc(t('mono.bankrupt'))}</span>` : `<b>${money(s.netWorth)}</b>`}</li>`;
  }).join('')}</ol>`;
  $('#resultsBody').innerHTML = standings + worthChart(g) + highlightsHtml(g, rows);
  $('#results').classList.remove('hidden');
}

// net worth of every player, one point per round
function worthChart(g) {
  const pts = g.worth || [];
  if (pts.length < 2) return '';
  const W = 560, H = 200, padL = 46, padB = 22, padT = 8;
  const max = Math.max(1, ...pts.flatMap(p => Object.values(p.w)));
  const x = i => padL + ((W - padL - 8) * i) / (pts.length - 1);
  const y = v => padT + (H - padT - padB) * (1 - v / max);
  const step = Math.pow(10, Math.floor(Math.log10(max)));
  const tick = max / step > 5 ? step * 2 : max / step > 2 ? step : step / 2;
  const ticks = [];
  for (let v = 0; v <= max; v += tick) ticks.push(v);
  const every = Math.ceil(pts.length / 8);
  const lines = g.order.map(pid => {
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.w[pid] || 0).toFixed(1)}`).join('');
    const last = pts.length - 1;
    return `<path d="${d}" class="wc-line" style="--pc:${colorOf(pid)}"/><circle cx="${x(last)}" cy="${y(pts[last].w[pid] || 0)}" r="3.5" style="fill:${colorOf(pid)}"/>`;
  }).join('');
  return `<section class="player-section"><h3>${esc(t('mono.sum.worth'))}</h3>
    <svg class="worth-chart" viewBox="0 0 ${W} ${H}" role="img">
      ${ticks.map(v => `<line x1="${padL}" x2="${W - 8}" y1="${y(v)}" y2="${y(v)}" class="wc-grid"/><text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end" class="wc-label">${tagMoney(v)}</text>`).join('')}
      ${pts.map((p, i) => (i % every === 0 || i === pts.length - 1 ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle" class="wc-label">${p.round}</text>` : '')).join('')}
      ${lines}
    </svg>
    <div class="wc-legend">${g.order.map(pid => `<span>${dot(pid)}${esc(nameOf(pid))}</span>`).join('')}<span class="muted small-text">${esc(t('mono.sum.byRound'))}</span></div>
  </section>`;
}

function highlightsHtml(g, rows) {
  const st = pid => gp(pid).stats || {};
  const best = (f, min = 1) => {
    const top = g.order.map(pid => [pid, f(st(pid))]).sort((a, b) => b[1] - a[1])[0];
    return top && top[1] >= min ? top : null;
  };
  const who = pid => `${dot(pid)}<b>${esc(nameOf(pid))}</b>`;
  const items = [];
  const hl = g.highlights || {};
  if (hl.rent) items.push(['💸', t('mono.sum.bigRent'), money(hl.rent.amount), `${who(hl.rent.from)} → ${who(hl.rent.to)} · ${esc(sqShort(hl.rent.square))}`]);
  if (hl.deal) items.push(['🤝', t('mono.sum.bigDeal'), money(hl.deal.value), `${who(hl.deal.from)} ⇄ ${who(hl.deal.to)}`]);
  const landlord = best(s => s.rentCollected || 0);
  if (landlord) items.push(['🏦', t('mono.sum.landlord'), money(landlord[1]), who(landlord[0])]);
  const builder = best(s => (s.housesBuilt || 0) + 5 * (s.hotelsBuilt || 0));
  if (builder) items.push(['🏗️', t('mono.sum.builder'), `${st(builder[0]).housesBuilt}<i class="house"></i> ${st(builder[0]).hotelsBuilt}<i class="hotel"></i>`, who(builder[0])]);
  const peak = best(s => s.peakNetWorth || 0);
  if (peak) items.push(['📈', t('mono.sum.peak'), money(peak[1]), who(peak[0])]);
  const jail = best(s => s.jailed || 0);
  if (jail) items.push(['🚔', t('mono.sum.jailbird'), t('mono.sum.times', { n: jail[1] }), who(jail[0])]);
  const runnerUp = rows[1];
  if (runnerUp && rows.length > 2) items.push(['🛡️', t('mono.sum.heldOut'), t('mono.sum.untilRound', { n: gp(runnerUp.pid).outRound || g.round }), who(runnerUp.pid)]);
  items.push(['⏱️', t('mono.sum.length'), t('mono.sum.rounds', { n: g.round }), '']);
  return `<section class="player-section"><h3>${esc(t('player.highlights'))}</h3>
    <div class="highlights">${items.map(([ico, label, value, sub]) => `<div class="hl"><span class="hl-ico">${ico}</span>
      <span class="hl-text"><span class="muted small-text">${esc(label)}</span><b>${value}</b><span class="small-text">${sub}</span></span></div>`).join('')}</div>
  </section>`;
}
$('#resultsClose').onclick = () => $('#results').classList.add('hidden');
$('#restartBtn').onclick = () => send('restart');
$('#resignBtn').onclick = async () => (await askConfirm({ title: t('mono.resign'), text: t('mono.confirmResign'), danger: true })) && send('resign');

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
const pct = pctOf;
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

// ---------- the whole game log ----------
$('#logBtn').onclick = () => { renderLog(); $('#logSheet').classList.remove('hidden'); };
$('#logClose').onclick = () => $('#logSheet').classList.add('hidden');
function renderLog() {
  if (!state || !state.game) return;
  const byName = name => [...state.players, ...state.spectators].find(p => p.name === name);
  const time = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  $('#logList').innerHTML = state.game.log.slice().reverse().map(e => {
    const who = e.params && byName(e.params.name);
    return `<li><span class="log-time">${time(e.at)}</span>${who ? dot(who.id) : '<span class="pdot blank"></span>'}<span>${esc(fmtLog(e))}</span></li>`;
  }).join('');
}

for (const id of ['boardSheet', 'results', 'logSheet']) $('#' + id).addEventListener('pointerdown', e => { if (e.target.id === id) $('#' + id).classList.add('hidden'); });
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  for (const id of ['boardSheet', 'results', 'sqInfo', 'tradeModal', 'playerMenu', 'logSheet']) $('#' + id).classList.add('hidden');
});

applyStaticTranslations();
render();
