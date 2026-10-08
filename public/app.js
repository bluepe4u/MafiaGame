'use strict';

// Mafia client. The login, profile, admin panel, sounds and other shared parts are in common.js.

// the login token travels with every (re)connection; after logging in or out we reconnect
const socket = io({ auth: cb => cb({ token: store.get(AUTH_KEY) }) });
const SESSION_KEY = 'mafia.session';
const REVEALED_KEY = 'mafia.revealed';
const TAB_KEY = 'mafia.tab';
const NOTES_PREFIX = 'mafia.notes.';
const HOLD_MS = 1500;

let state = null;
// "← Home" from the lobby shows the home screen but keeps the seat (back via the banner)
let homeView = false;
let clockOffset = 0; // serverNow - clientNow
let roleShown = false; // true only while the role card is pressed
// room code in the address bar (?room=ABCD): from an invite link, or the room we're in
let urlRoom = (new URLSearchParams(location.search).get('room') || '').toUpperCase().slice(0, 4);
Site.init({
  game: 'mafia',
  socket,
  urlRoom: () => urlRoom,
  hooks: {
    onAccount: () => { renderReactButtons(); render(); },
    onItems: () => render(),
    onLang: () => { renderSpookyBtn(); render(); },
    celebrate: () => celebrate('town'),
    busy: () => !!(state && state.me && !state.me.spectator && state.phase !== 'lobby' && state.phase !== 'ended'),
    leave: async () => { if (state && state.me) await send('leave'); saveSession(null); },
  },
});

// ---------- utils ----------
function loadSession() {
  try { return JSON.parse(store.get(SESSION_KEY)); } catch { return null; }
}
function saveSession(s) {
  store.set(SESSION_KEY, s ? JSON.stringify(s) : null);
}

function show(screen) {
  for (const id of ['home', 'lobby', 'game']) $('#' + id).classList.toggle('hidden', id !== screen);
  Site.setHome(screen === 'home');
}

const playerById = id => state.players.find(p => p.id === id);
const nameOf = id => (playerById(id) || {}).name || '?';
const isHost = () => !!(state && state.me && state.hostId === state.me.id);
const roleName = r => t('role.' + r);
const tagHtml = (key, cls = '') => `<span class="tag ${cls}">${esc(t(key))}</span>`;
const icon = svgIcon;
const ICONS = {
  ...COMMON_ICONS,
  night: icon('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>'),
  speech: icon('<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/><path d="M19 11a7 7 0 0 1-14 0M12 18v3"/>'),
  vote: icon('<path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9"/>'),
  ended: icon('<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>'),
  eyeOpen: icon('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  eye: icon('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/>'),
  check: icon('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
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
  closeRename();
  for (const id of ['recap', 'board']) $('#' + id).classList.add('hidden');
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
socket.on('session', s => { saveSession(s); homeView = false; });
socket.on('state', s => {
  clockOffset = s.serverNow - Date.now();
  state = s;
  render();
});
socket.on('kicked', r => {
  leftRoom();
  toast(t(r && r.closed ? 'toast.roomClosed' : 'toast.kicked'));
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
$('#watchBtn').onclick = () => send('join', { code: $('#joinCode').value, spectate: true });
$('#joinCode').addEventListener('keydown', e => { if (e.key === 'Enter') $('#joinBtn').click(); });

$('#homeBtn').onclick = () => { homeView = true; render(); };

// ---------- accounts (shared, see common.js) ----------
$('#profileBtn').onclick = () => openProfile();
$('#homeProfile').onclick = () => openProfile();

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
  const watchers = inRoom ? state.spectators : [];
  $('#topWatchers').classList.toggle('hidden', !watchers.length);
  $('#topWatchers').innerHTML = `${ICONS.eyeOpen}<span>${watchers.length}</span>`;
  $('#topWatchers').title = t('ui.watchersTitle', { names: watchers.map(w => w.name).join(', ') });
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
  updateTurnAlert(need && { key: need.key, text: t('alert.' + need.type) });
}

// ---------- lobby ----------
$('#startBtn').onclick = () => send('startCountdown');
$('#readyBtn').onclick = () => {
  const mine = state.players.find(p => p.id === state.me.id);
  send('ready', { ready: !(mine && mine.ready) });
};
$('#watchToggle').onclick = () => send('watch', { on: !state.me.spectator });
$('#nightSeconds').addEventListener('change', e => send('settings', { nightSeconds: parseInt(e.target.value, 10) || 0 }));

// ---------- start countdown (anyone can call "wait!") ----------
$('#countdownCancel').onclick = () => send('cancelCountdown');
let countdownLast = null;
function renderCountdown() {
  const box = $('#countdown');
  const endsAt = state && state.me && state.phase === 'lobby' && state.countdownEndsAt;
  if (!endsAt) { box.classList.add('hidden'); countdownLast = null; return; }
  const left = Math.max(1, Math.ceil((endsAt - (Date.now() + clockOffset)) / 1000));
  box.classList.remove('hidden');
  if (left !== countdownLast) {
    countdownLast = left;
    const num = $('#countdownNum');
    num.textContent = left;
    num.classList.remove('tick');
    void num.offsetWidth;
    num.classList.add('tick');
    if (alertsOn && audioCtx) tone({ f: left === 1 ? 880 : 587, dur: 0.18, vol: 0.08, type: 'triangle' });
  }
}
setInterval(renderCountdown, 200);
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
    <li class="${p.connected ? '' : 'offline'} ${p.ready ? 'is-ready' : ''}" data-pid="${p.id}">
      <span class="avatar-wrap ${p.userId ? 'clickable' : ''}" data-open-player="${p.userId || ''}">${avatar(p.name, p.avatar, p.cos)}${p.ready ? `<span class="voted ready-mark">${ICONS.check}</span>` : ''}</span>
      <span class="pname"><b class="${nameCls(p.cos)}">${esc(p.name)}</b>${statusPill(p.score)}${p.id === state.hostId ? tagHtml('tag.host', 'host') : ''}${p.id === state.me.id ? tagHtml('tag.you', 'you') : ''}${p.connected ? '' : tagHtml('tag.offline')}</span>
      ${isHost() ? `<button class="ghost small icon-only" data-rename="${p.id}" title="${esc(t('rename.btn'))}" aria-label="${esc(t('rename.btn'))}">✎</button>` : ''}
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
    s.nightSeconds ? t('sum.night', { s: s.nightSeconds }) : t('sum.noNightLimit'),
    t(s.firstNightKill ? 'sum.firstNightKill' : 'sum.noFirstNightKill'),
    t(s.revealRoleOnDeath ? 'sum.reveal' : 'sum.noReveal'),
  ].map(t => `<li>${esc(t)}</li>`).join('');
  const rce = state.roleCountsError;
  $('#roleError').textContent = state.players.length >= state.minPlayers && rce ? t(rce.key, rce.params) : '';

  $('#hostSettings').classList.toggle('hidden', !isHost());
  $('#startBtn').classList.toggle('hidden', !isHost());
  $('#waitHost').classList.toggle('hidden', isHost());
  $('#startBtn').disabled = state.players.length < state.minPlayers || !!state.roleCountsError || !!state.countdownEndsAt;
  const readyN = state.players.filter(p => p.ready).length;
  const mine = state.players.find(p => p.id === state.me.id);
  $('#readyCount').textContent = t('ui.readyCount', { n: readyN, total: state.players.length });
  $('#readyBtn').classList.toggle('hidden', !mine);
  $('#readyBtn').classList.toggle('on', !!(mine && mine.ready));
  $('#readyBtn').innerHTML = `${ICONS.check}<span>${esc(t(mine && mine.ready ? 'ui.ready' : 'ui.unready'))}</span>`;
  $('#watchToggle').textContent = t(state.me.spectator ? 'ui.playInstead' : 'ui.watchInstead');
  $('#spectatorBox').classList.toggle('hidden', !state.spectators.length);
  $('#spectatorList').innerHTML = state.spectators.map(w => `<span class="spectator ${w.connected ? '' : 'offline'}" data-pid="${w.id}">${avatar(w.name, w.avatar, w.cos)}<b>${esc(w.name)}</b>${statusPill(w.score)}${
    isHost() ? `<button class="ghost small icon-only" data-rename="${w.id}" aria-label="${esc(t('rename.btn'))}">✎</button>` : ''}${
    isHost() && w.id !== state.me.id ? `<button class="ghost small" data-kick="${w.id}">${esc(t('ui.remove'))}</button>` : ''}</span>`).join('');
  for (const b of $$('#lobby [data-rename]')) b.onclick = e => { e.stopPropagation(); openRename(b.dataset.rename, b, ([...state.players, ...state.spectators].find(p => p.id === b.dataset.rename) || {}).name || ''); };
  for (const el of $$('#lobby [data-open-player]')) if (el.dataset.openPlayer) el.onclick = () => openPlayer(el.dataset.openPlayer);
  for (const b of $$('#spectatorList [data-kick]')) {
    b.onclick = () => confirmHost({ title: t('host.kick.title', { name: (state.spectators.find(w => w.id === b.dataset.kick) || {}).name }), text: t('host.kick.text'), event: 'kick', payload: { playerId: b.dataset.kick } });
  }
  $('#startBtn').textContent = `${t('ui.startGame')} · ${t('ui.readyCount', { n: readyN, total: state.players.length })}`;
  if (isHost()) {
    for (const i of $$('[data-role]')) setIfNotFocused(i, 'value', rc[i.dataset.role]);
    setIfNotFocused($('#speechSeconds'), 'value', s.speechSeconds);
    setIfNotFocused($('#voteSeconds'), 'value', s.voteSeconds);
    setIfNotFocused($('#nightSeconds'), 'value', s.nightSeconds);
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
  if (roleShown === on || (on && state && state.me && state.me.spectator)) return;
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
    // the Mafia and the Doctor may also choose nobody
    const canPickNobody = state.night.hasAction && (me.role === 'mafia' || me.role === 'doctor');
    const nobodyPickers = state.night.mafiaVotes
      ? Object.entries(state.night.mafiaVotes).filter(([m, tgt]) => tgt === 'none' && m !== me.id).map(([m]) => nameOf(m))
      : [];
    panel.innerHTML = `
      ${state.nightEndsAt
        ? '<div class="timer-wrap small" id="timerWrap"><div class="timer-ring"></div><div class="timer" id="timer"></div></div>'
        : `<div class="phase-icon">${ICONS.night}</div>`}
      <div class="big">${esc(t('night.sleeps'))}</div>
      <div class="prompt">${esc(me.alive ? nightPrompt() : t('night.dead'))}</div>
      ${picked ? `<div class="choice">${esc(picked === 'none' ? t('night.choseNobody') : t('night.yourChoice', { name: nameOf(picked) }))}<div class="muted small-text">${esc(t('night.canChange'))}</div></div>` : ''}
      ${canPickNobody ? `<button id="nightNobody" ${picked === 'none' ? 'disabled' : ''}>${esc(t('night.nobody.' + me.role))}</button>` : ''}
      ${nobodyPickers.length ? `<div class="muted small-text">${esc(t('night.mafiaNobody', { names: nobodyPickers.join(', ') }))}</div>` : ''}`;
    if (canPickNobody) $('#nightNobody').onclick = () => send('nightAction', { targetId: 'none' });
    tickTimer();
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
  // clockwise from the top of the round table
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
  $('#table').style.setProperty('--n', Math.max(4, n));
  const html = state.players.map((p, i) => {
    const mark = notes.marks[p.id];
    const fx = seatFx(p, i);
    const note = notes.notes[p.id];
    const cls = [
      'seat',
      p.alive ? '' : 'dead',
      p.id === me.id ? 'me' : '',
      state.speech && state.speech.current === p.id ? 'speaking' : '',
      (night && night.myTarget === p.id) || (voting && state.votes[me.id] === p.id) ? 'selected' : '',
      mark ? `marked-${mark}` : '',
      fx.cls,
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
    return `<div class="${cls}" data-pid="${p.id}" style="left:${pos.left}%;top:${pos.top}%;${fx.style}">
      <span class="num">${p.seat + 1}</span>
      ${markBtn}
      <span class="avatar-wrap" title="${p.score === null ? '' : esc(t('tier.' + tierOf(p.score)))}">${avatar(p.name, p.avatar, p.cos)}${voted}</span>
      <div class="name ${nameCls(p.cos)}">${esc(p.name)}</div>
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
  if (me.spectator) {
    box.className = 'card role-box';
    roleCardEl.innerHTML = `<div class="role-hidden">${ICONS.eyeOpen}<span>${esc(t('ui.watchingNote'))}</span></div>`;
    return;
  }
  box.className = 'card role-box' + (roleShown ? ` revealed ${state.roleInfo[me.role].team}` : '');
  roleCardEl.innerHTML = roleShown
    ? roleDetails() + (me.alive ? '' : tagHtml('tag.dead'))
    : `<div class="role-hidden">${ICONS.eye}<span>${esc(t('ui.roleHidden'))}</span></div>`;
}

// ---------- role reveal at the start of a game ----------
function maybeReveal() {
  const show = !state.me.spectator && state.phase !== 'lobby' && state.phase !== 'ended' && state.gameId && store.get(REVEALED_KEY) !== state.gameId;
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
const chatShown = {}; // channel -> ids already on screen, so only new messages animate in

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
  const shown = chatShown[chatChannel];
  const isNew = m => shown && !shown.has(m.id) ? 'pop' : '';
  for (const m of list) {
    const sec = chatSection(m);
    if (sec !== section) { html += `<div class="chat-sep"><span>${esc(sec)}</span></div>`; section = sec; prev = null; }
    if (m.kind === 'reveal') {
      html += `<div class="msg-reveal ${isNew(m)}">${avatar(m.name, (playerById(m.from) || {}).avatar, (playerById(m.from) || {}).cos)}<span><b>${esc(m.name)}</b> ${esc(t('chat.revealed'))}</span>${roleTag(m.role)}</div>`;
      prev = null;
      continue;
    }
    const mine = m.from === me.id;
    const grouped = prev && prev.from === m.from && m.at - prev.at < 5 * 60 * 1000;
    const time = new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    html += `<div class="msg ${mine ? 'mine' : ''} ${grouped ? 'grouped' : ''} ${isNew(m)}">
      ${mine || grouped ? '<span class="msg-gap"></span>' : avatar(m.name, (playerById(m.from) || {}).avatar, (playerById(m.from) || {}).cos)}
      <div class="msg-body">
        ${mine || grouped ? '' : `<div class="msg-name ${nameCls((playerById(m.from) || {}).cos)}">${esc(m.name)}</div>`}
        <div class="bubble">${esc(m.text)}<time>${esc(time)}</time></div>
      </div>
    </div>`;
    prev = m;
  }
  const empty = { town: 'chat.empty', mafia: 'chat.emptyMafia', dead: 'chat.emptyDead' }[chatChannel];
  box.innerHTML = html || `<p class="chat-empty">${esc(t(empty))}</p>`;
  chatShown[chatChannel] = new Set(list.map(m => m.id));
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
  const roles = state.players.map(p => `<span class="recap-player">${avatar(p.name, p.avatar, p.cos)}<b>${esc(p.name)}</b>${roleTag(p.role)}</span>`).join('');
  const sections = state.history.map(h => {
    if (h.type === 'night') {
      const lines = [];
      const mafia = h.actions.filter(a => a.role === 'mafia');
      const byTarget = {};
      for (const a of mafia) (byTarget[a.target] ||= []).push(a);
      for (const [target, acts] of Object.entries(byTarget)) {
        const names = acts.map(a => nameOf(a.actor) + (a.blocked ? ` (${t('recap.blocked')})` : '')).join(', ');
        lines.push(['mafia', target === 'none' ? t('recap.mafiaNobody', { names }) : t('recap.mafia', { names, target: nameOf(target) })]);
      }
      for (const a of h.actions.filter(x => x.role !== 'mafia')) {
        if (a.target === 'none') { lines.push([a.role, t('recap.doctorNobody', { actor: nameOf(a.actor) })]); continue; }
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
  const endsAt = speech ? speech.endsAt : state.phase === 'vote' ? state.voteEndsAt : state.phase === 'night' && state.nightEndsAt;
  if (!endsAt) return;
  const total = speech ? state.settings.speechSeconds : state.phase === 'vote' ? state.settings.voteSeconds : state.settings.nightSeconds;
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
  fxOnState();
  renderTopbar();
  updateAlerts();
  const inRoom = !!(state && state.me) && !homeView;
  document.body.dataset.phase = inRoom ? state.phase : 'home';
  document.body.dataset.winner = (state && state.winner) || '';
  if (inRoom && urlRoom !== state.code) {
    urlRoom = state.code;
    history.replaceState(null, '', `/?room=${state.code}`);
  }
  if (!inRoom || state.phase === 'lobby' || state.phase === 'ended') $('#reveal').classList.add('hidden');
  if (!inRoom || state.phase !== 'ended') $('#recap').classList.add('hidden');
  if (!inRoom) { closeMarkMenu(); reactBar.classList.add('hidden'); return show('home'); }
  placeChat();
  renderReactBar();
  if (state.phase === 'lobby') { show('lobby'); renderLobby(); renderChat(); return; }
  show('game');
  renderGame();
  renderChat();
}

// ---------- effects: phase cards, death and entrance animations, sounds, Halloween ----------
const SPOOKY_KEY = 'mafia.spooky';
const inSpookySeason = () => { const d = new Date(); return d.getMonth() === 9 || (d.getMonth() === 10 && d.getDate() <= 2); };
let spooky = store.get(SPOOKY_KEY) ? store.get(SPOOKY_KEY) === 'on' : inSpookySeason();
const PUMPKIN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6c-1-.2-1.4-1.6-.6-3"/><path d="M12 6c4.9-1.6 9 1.4 9 6.5S17.4 21 12 21 3 17.6 3 12.5 7.1 4.4 12 6z"/><path d="M8.5 11l1.5 1.5L8.5 14M15.5 11 14 12.5l1.5 1.5M9 17c2 1 4 1 6 0"/></svg>';
const BAT = '<svg viewBox="0 0 64 28"><path d="M32 9c1.5-3 2.5-4 3-6 .6 2 .4 3.5 0 5 4-3 9-5.5 15-6-2 2.5-2 5 0 8 2-2 6-3 10-2-3 2-4 6-4 10-3-2-7-3-10-1-1-3-4-5-8-5-2 0-4 2-6 6-2-4-4-6-6-6-4 0-7 2-8 5-3-2-7-1-10 1 0-4-1-8-4-10 4-1 8 0 10 2 2-3 2-5.5 0-8 6 .5 11 3 15 6-.4-1.5-.6-3 0-5 .5 2 1.5 3 3 6z"/></svg>';

function renderSpookyBtn() {
  const b = $('#spookyBtn');
  b.innerHTML = PUMPKIN;
  b.setAttribute('aria-pressed', String(spooky));
  b.title = t('fx.halloween');
  b.setAttribute('aria-label', t('fx.halloween'));
}

function applySpooky() {
  document.body.classList.toggle('halloween', spooky);
  renderSpookyBtn();
  const bats = $('#bats');
  bats.innerHTML = spooky && !reducedMotion()
    ? Array.from({ length: 7 }, (_, i) => `<i class="bat" style="--y:${8 + Math.random() * 55}vh;--d:${14 + Math.random() * 14}s;--delay:${-Math.random() * 20}s;--s:${0.5 + Math.random() * 0.8};--dir:${i % 2 ? 1 : -1}">${BAT}</i>`).join('')
    : '';
}
$('#spookyBtn').onclick = () => {
  spooky = !spooky;
  store.set(SPOOKY_KEY, spooky ? 'on' : 'off');
  applySpooky();
  if (spooky) sfx('night');
};

// --- sounds, synthesized on the fly (tone() is in common.js) ---
function noise({ at = 0, dur = 1, vol = 0.05, freq = 800 }) {
  const now = audioCtx.currentTime + at;
  const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * dur, audioCtx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = audioCtx.createBufferSource();
  const bp = audioCtx.createBiquadFilter();
  const gain = audioCtx.createGain();
  src.buffer = buf;
  bp.type = 'bandpass';
  bp.frequency.value = freq;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(vol, now + dur * 0.4);
  gain.gain.linearRampToValueAtTime(0, now + dur);
  src.connect(bp).connect(gain).connect(audioCtx.destination);
  src.start(now);
}

const SOUNDS = {
  normal: {
    night: () => { tone({ f: 220, f2: 196, dur: 1.4, vol: 0.08 }); tone({ f: 330, f2: 294, dur: 1.4, vol: 0.05 }); },
    morning: () => [523, 659, 784].forEach((f, i) => tone({ f, at: i * 0.12, dur: 0.6, vol: 0.07 })),
    vote: () => [0, 0.16].forEach(at => tone({ f: 880, at, dur: 0.12, vol: 0.06, type: 'triangle' })),
    death: () => { tone({ f: 130, f2: 55, dur: 0.9, vol: 0.18 }); noise({ dur: 0.5, vol: 0.04, freq: 300 }); },
    win: () => [523, 659, 784, 1046].forEach((f, i) => tone({ f, at: i * 0.1, dur: 0.7, vol: 0.07, type: 'triangle' })),
  },
  spooky: {
    // a wolf howl over the wind
    night: () => {
      noise({ dur: 2.6, vol: 0.05, freq: 500 });
      tone({ f: 330, f2: 700, dur: 0.9, vol: 0.09, vib: 8, lowpass: 1800 });
      tone({ f: 700, f2: 420, at: 0.85, dur: 1.4, vol: 0.09, vib: 10, lowpass: 1800 });
    },
    // a low church bell
    morning: () => [[196, 0.16], [392 * 1.19, 0.06], [588, 0.05], [98, 0.1]].forEach(([f, vol]) => tone({ f, dur: 3, vol, attack: 0.005 })),
    // heartbeat
    vote: () => [0, 0.22, 0.9, 1.12].forEach((at, i) => tone({ f: i % 2 ? 50 : 62, f2: 40, at, dur: 0.2, vol: 0.35, attack: 0.005 })),
    // a creepy organ stinger
    death: () => {
      [220, 261.6, 311.1, 370].forEach(f => tone({ f, dur: 1.8, vol: 0.035, type: 'square', lowpass: 1400 }));
      tone({ f: 1400, f2: 500, at: 0.05, dur: 0.8, vol: 0.04, vib: 30 });
    },
    // a descending theremin
    win: () => tone({ f: 950, f2: 260, dur: 2.4, vol: 0.09, vib: 14, lowpass: 2500 }),
  },
};
function sfx(name) {
  if (!alertsOn || !audioCtx) return;
  try { SOUNDS[spooky ? 'spooky' : 'normal'][name](); } catch {}
}

// --- what changed since the last state: phase changes and deaths ---
let fxPrev = null;
const diedAt = {}; // playerId -> when we saw them die
let seatsEnteredAt = 0;
let seatsGame = null;

function showPhaseCard(icon, title, sub) {
  if (reducedMotion()) return;
  const card = $('#phaseCard');
  $('#phaseCardIcon').innerHTML = icon;
  $('#phaseCardTitle').textContent = title;
  $('#phaseCardSub').textContent = sub || '';
  card.classList.remove('hidden', 'play');
  void card.offsetWidth; // restart the animation
  card.classList.add('play');
  clearTimeout(showPhaseCard.timer);
  showPhaseCard.timer = setTimeout(() => card.classList.add('hidden'), 2300);
}

function celebrate(winner) {
  if (reducedMotion()) return;
  const layer = $('#fxLayer');
  const colors = winner === 'mafia' ? ['#e5484d', '#ff8a8e', '#7a1f2b', '#f1f1f4'] : ['#3dd68c', '#8b7cff', '#f5b546', '#f1f1f4'];
  const pieces = spooky
    ? Array.from({ length: 26 }, () => `<i class="swarm-bat" style="--x:${Math.random() * 100}vw;--y:${60 + Math.random() * 40}vh;--d:${1.6 + Math.random() * 1.4}s;--delay:${Math.random() * 0.8}s;--s:${0.4 + Math.random() * 0.9}">${BAT}</i>`)
    : Array.from({ length: 90 }, () => `<i class="confetti" style="--x:${Math.random() * 100}vw;--r:${Math.random() * 720 - 360}deg;--d:${2 + Math.random() * 1.8}s;--delay:${Math.random() * 0.6}s;background:${colors[Math.floor(Math.random() * colors.length)]}"></i>`);
  layer.innerHTML = pieces.join('');
  clearTimeout(celebrate.timer);
  celebrate.timer = setTimeout(() => { layer.innerHTML = ''; }, 4500);
}

function fxOnState() {
  if (!state || !state.me) { fxPrev = null; return; }
  const now = { gameId: state.gameId, phase: state.phase, day: state.day, alive: new Set(state.players.filter(p => p.alive).map(p => p.id)) };
  const prev = fxPrev;
  fxPrev = now;
  if (!prev || prev.gameId !== now.gameId || !now.gameId) return; // first look (page load, new game): no replay
  for (const id of prev.alive) {
    if (!now.alive.has(id)) { diedAt[id] = Date.now(); sfx('death'); }
  }
  if (prev.phase === now.phase && prev.day === now.day) return;
  const lastLog = state.log.at(-1);
  if (now.phase === 'night') { showPhaseCard(ICONS.night, t('phase.night', { n: now.day }), t('night.sleeps')); sfx('night'); }
  else if (now.phase === 'speech') {
    const morning = [...state.log].reverse().find(e => e.key === 'log.morningKilled' || e.key === 'log.morningNobody');
    showPhaseCard(ICONS.speech, t('fx.morning', { n: now.day }), morning ? t(morning.key, morning.params) : '');
    sfx('morning');
  } else if (now.phase === 'vote') { showPhaseCard(ICONS.vote, t('vote.title'), t('fx.voteSub')); sfx('vote'); }
  else if (now.phase === 'ended') {
    showPhaseCard(ICONS.ended, t('end.' + state.winner), lastLog && lastLog.key !== 'log.townWins' && lastLog.key !== 'log.mafiaWins' ? t(lastLog.key, lastLog.params) : '');
    sfx('win');
    celebrate(state.winner);
  }
}

// CSS animations restart whenever seats are re-rendered, so each one is given a negative delay
// matching how far into the animation it already is.
function seatFx(p, i) {
  const now = Date.now();
  const cls = [];
  let style = '';
  if (diedAt[p.id] && now - diedAt[p.id] < 1800) { cls.push('dying'); style += `--fx-t:-${now - diedAt[p.id]}ms;`; }
  if (seatsGame !== state.gameId) { seatsGame = state.gameId; seatsEnteredAt = now; }
  const sinceEnter = now - seatsEnteredAt - i * 70;
  if (sinceEnter < 600) { cls.push('entering'); style += `--fx-enter:${-sinceEnter}ms;`; }
  return { cls: cls.join(' '), style };
}

// ---------- emoji reactions: float up from the sender's seat ----------
const REACTIONS = ['👍', '👎', '😂', '🤔', '😱', '🤥', '🔥', '💀', '❤️', '👀'];
const reactBar = $('#reactBar');
// the base set plus any reaction items the player owns
function renderReactButtons() {
  const list = [...REACTIONS, ...((account && account.reactions) || [])];
  reactBar.innerHTML = list.map(e => `<button class="react-btn" data-react="${e}" aria-label="${e}">${e}</button>`).join('');
  for (const b of reactBar.querySelectorAll('[data-react]')) b.onclick = () => send('react', { emoji: b.dataset.react });
}
renderReactButtons();
const reactLayer = document.createElement('div');
reactLayer.className = 'react-layer';
reactLayer.setAttribute('aria-hidden', 'true');
document.body.append(reactLayer);

// the same rule as the server: everyone in the lobby and after the game; living players by day
function canReact() {
  if (!state || !state.me) return false;
  if (state.phase === 'lobby' || state.phase === 'ended') return true;
  return (state.phase === 'speech' || state.phase === 'vote') && state.me.alive && !state.me.spectator;
}

function renderReactBar() {
  const slot = state && state.phase === 'lobby' ? $('#lobbyReactSlot') : $('#gameReactSlot');
  if (reactBar.parentElement !== slot) slot.append(reactBar);
  reactBar.classList.toggle('hidden', !canReact());
}

socket.on('reaction', r => {
  const anchor = [...$$(`[data-pid="${r.from}"]`)].find(el => el.offsetParent);
  const rect = anchor ? anchor.getBoundingClientRect() : { left: innerWidth / 2, width: 0, top: innerHeight / 2 };
  const el = document.createElement('span');
  el.className = 'reaction';
  el.textContent = r.emoji;
  el.style.left = `${rect.left + rect.width / 2}px`;
  el.style.top = `${rect.top + 8}px`;
  el.style.setProperty('--dx', `${Math.round(Math.random() * 50 - 25)}px`);
  el.style.setProperty('--rot', `${Math.round(Math.random() * 30 - 15)}deg`);
  reactLayer.append(el);
  el.addEventListener('animationend', () => el.remove());
  setTimeout(() => el.remove(), 2500); // in case the animation never runs
  if (anchor) { anchor.classList.remove('reacted'); void anchor.offsetWidth; anchor.classList.add('reacted'); }
});

// ---------- leaderboard ----------
const MIN_GAMES_FOR_RATE = 3;
let boardTab = 'wins';
let boardUsers = [];
async function openBoard() {
  const res = await api('leaderboard');
  if (!res.ok) return;
  boardUsers = res.users;
  $('#board').classList.remove('hidden');
  renderBoard();
}
function renderBoard() {
  for (const b of $$('[data-board]')) b.classList.toggle('active', b.dataset.board === boardTab);
  const metric = {
    wins: u => [u.stats.wins, u.stats.wins],
    winrate: u => [u.stats.games >= MIN_GAMES_FOR_RATE ? pctOf(u.stats.wins, u.stats.games) : -1, `${pctOf(u.stats.wins, u.stats.games)}%`],
    decency: u => [u.score, u.score > 0 ? `+${u.score}` : u.score],
    games: u => [u.stats.games, u.stats.games],
  }[boardTab];
  const rows = boardUsers.map(u => ({ u, m: metric(u) })).filter(r => r.m[0] >= 0 && (boardTab === 'decency' || r.u.stats.games > 0))
    .sort((a, b) => b.m[0] - a.m[0] || b.u.stats.wins - a.u.stats.wins || a.u.username.localeCompare(b.u.username));
  const medal = i => ['🥇', '🥈', '🥉'][i] || `<span class="rank">${i + 1}</span>`;
  $('#boardList').innerHTML = rows.length ? rows.map(({ u, m }, i) => `
    <li class="board-row ${account && u.id === account.id ? 'me' : ''}" data-player="${u.id}">
      <span class="board-rank">${medal(i)}</span>
      ${avatar(u.username, u.avatar, u.equipped)}
      <span class="board-id"><b class="${nameCls(u.equipped)}">${esc(u.username)}</b>${statusPill(u.score)}
        <span class="muted small-text">${esc(t('board.sub', { g: u.stats.games, w: u.stats.wins }))}</span></span>
      <span class="board-metric">${m[1]}</span>
    </li>`).join('') : `<p class="muted small-text">${esc(t('board.empty'))}</p>`;
  $('#boardNote').textContent = boardTab === 'winrate' ? t('board.minGames', { n: MIN_GAMES_FOR_RATE }) : '';
  for (const row of $$('#boardList [data-player]')) row.onclick = () => openPlayer(row.dataset.player);
}
for (const b of $$('[data-board]')) b.onclick = () => { boardTab = b.dataset.board; renderBoard(); };
$('#boardBtn').innerHTML = '<span class="trophy">🏆</span>';
$('#boardBtn').onclick = openBoard;
$('#homeBoard').onclick = openBoard;
$('#boardClose').onclick = () => $('#board').classList.add('hidden');
$('#board').addEventListener('pointerdown', e => { if (e.target.id === 'board') $('#board').classList.add('hidden'); });

applyStaticTranslations();
applySpooky();
render();
