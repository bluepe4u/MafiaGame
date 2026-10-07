'use strict';

const socket = io();
const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);
const SESSION_KEY = 'mafia.session';
const NAME_KEY = 'mafia.name';
const HOLD_MS = 1500;

let state = null;
let clockOffset = 0; // serverNow - clientNow
let roleShown = false;

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
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}
function saveSession(s) {
  try { s ? localStorage.setItem(SESSION_KEY, JSON.stringify(s)) : localStorage.removeItem(SESSION_KEY); } catch {}
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
function avatar(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.codePointAt(0)) % 360;
  const parts = name.trim().split(/\s+/);
  const initials = (parts.length > 1 ? parts[0][0] + parts[1][0] : [...name].slice(0, 2).join('')).toUpperCase();
  return `<span class="avatar" style="--h:${h}">${esc(initials)}</span>`;
}
const icon = paths => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
const ICONS = {
  night: icon('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>'),
  speech: icon('<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/><path d="M19 11a7 7 0 0 1-14 0M12 18v3"/>'),
  vote: icon('<path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9"/>'),
  ended: icon('<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>'),
  eye: icon('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/>'),
};
const progress = (done, total) => `<div class="bar-track"><div class="bar-fill" style="width:${total ? (100 * done / total) : 0}%"></div></div>`;
const roleTag = r => r ? `<span class="tag ${state.roleInfo[r].team}">${esc(roleName(r))}</span>` : '';
// identifies "the moment" a host action was requested for; if it changes, the action is stale
const momentKey = () => state ? `${state.phase}:${state.day}:${state.speech ? state.speech.index : ''}` : '';

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
document.addEventListener('keydown', e => { if (e.key === 'Escape' && pending) closeModal(); });

// ---------- socket ----------
socket.on('connect', () => {
  const s = loadSession();
  if (s) {
    socket.emit('resume', s, res => {
      if (!res.ok) { saveSession(null); state = null; render(); }
    });
  }
});
socket.on('session', s => saveSession(s));
socket.on('state', s => {
  clockOffset = s.serverNow - Date.now();
  state = s;
  render();
});
socket.on('kicked', () => {
  saveSession(null);
  state = null;
  render();
  toast(t('toast.kicked'));
});

// ---------- home ----------
$('#name').value = localStorage.getItem(NAME_KEY) || '';
const myName = () => {
  const n = $('#name').value.trim();
  if (n) localStorage.setItem(NAME_KEY, n);
  return n;
};
$('#createBtn').onclick = () => send('create', { name: myName() });
$('#joinBtn').onclick = () => send('join', { name: myName(), code: $('#joinCode').value });
$('#joinCode').addEventListener('keydown', e => { if (e.key === 'Enter') $('#joinBtn').click(); });

// ---------- top bar ----------
$('#topRoom').onclick = async () => {
  try { await navigator.clipboard.writeText(state.code); toast(t('toast.copied'), 'info'); } catch {}
};
$('#leaveBtn').onclick = async () => {
  const inGame = state && state.phase !== 'lobby' && state.phase !== 'ended';
  if (inGame && !confirm(t('confirm.leave'))) return;
  await send('leave');
  saveSession(null);
  state = null;
  render();
};

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
$('#revealRole').addEventListener('change', e => send('settings', { revealRoleOnDeath: e.target.checked }));
$('#firstNightKill').addEventListener('change', e => send('settings', { firstNightKill: e.target.checked }));

function setIfNotFocused(el, prop, value) {
  if (document.activeElement !== el) el[prop] = value;
}

function renderLobby() {
  $('#shareCode').innerHTML = esc(t('ui.shareCode', { code: '\u0000' })).replace('\u0000', `<strong class="code">${esc(state.code)}</strong>`);
  $('#lobbyCount').textContent = t('ui.lobbyCount', { count: state.players.length, max: state.maxPlayers, min: state.minPlayers });
  const empty = Math.max(0, state.minPlayers - state.players.length);
  $('#lobbyPlayers').innerHTML = state.players.map(p => `
    <li class="${p.connected ? '' : 'offline'}">
      ${avatar(p.name)}
      <span class="pname"><b>${esc(p.name)}</b>${p.id === state.hostId ? tagHtml('tag.host', 'host') : ''}${p.id === state.me.id ? tagHtml('tag.you', 'you') : ''}${p.connected ? '' : tagHtml('tag.offline')}</span>
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
    $('#revealRole').checked = s.revealRoleOnDeath;
    $('#firstNightKill').checked = s.firstNightKill;
  }
}

// ---------- game ----------

$('#roleToggle').onclick = () => { roleShown = !roleShown; renderGame(); };

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
      ${picked ? `<div class="choice">${esc(t('night.yourChoice', { name: nameOf(picked) }))}<div class="muted small-text">${esc(t('night.canChange'))}</div></div>` : ''}
      <div class="progress">${esc(t('night.waiting', { n: state.night.pendingCount }))}</div>`;
  } else if (state.phase === 'speech') {
    const sp = state.speech;
    const mine = sp.current === me.id;
    panel.innerHTML = `
      <div class="muted small-text">${esc(t('speech.now'))}</div>
      <div class="big">${esc(nameOf(sp.current))}${mine ? ' ' + esc(t('speech.you')) : ''}</div>
      <div class="timer-wrap" id="timerWrap"><div class="timer-ring"></div><div class="timer" id="timer"></div></div>
      ${mine ? `<button id="endSpeech" class="primary">${esc(t('speech.finish'))}</button>` : ''}
      <div class="order">${sp.order.map((pid, i) => `<span class="${i < sp.index ? 'done' : i === sp.index ? 'now' : ''}">${i + 1}. ${esc(nameOf(pid))}</span>`).join('')}</div>`;
    if (mine) $('#endSpeech').onclick = () => send('endSpeech');
    tickTimer();
  } else if (state.phase === 'vote') {
    const alive = state.players.filter(p => p.alive);
    const voted = Object.keys(state.votes).length;
    const myVote = state.votes[me.id];
    panel.innerHTML = `
      <div class="phase-icon">${ICONS.vote}</div>
      <div class="big">${esc(t('vote.title'))}</div>
      ${progress(voted, alive.length)}
      <div class="muted small-text">${esc(t('vote.status', { voted, total: alive.length }))}</div>
      ${me.alive ? `<div class="choice">${esc(t('vote.yours', { choice: myVote ? (myVote === 'skip' ? t('vote.skip') : nameOf(myVote)) : '—' }))}</div>
        <button id="skipVote" ${myVote === 'skip' ? 'disabled' : ''}>${esc(t('vote.skipBtn'))}</button>` : `<div class="muted">${esc(t('vote.dead'))}</div>`}`;
    if (me.alive) $('#skipVote').onclick = () => send('vote', { targetId: 'skip' });
  } else if (state.phase === 'ended') {
    panel.innerHTML = `
      <div class="phase-icon">${ICONS.ended}</div>
      <div class="winner">${esc(t('end.' + state.winner))}</div>
      <div class="muted">${esc(t('end.revealed'))}</div>`;
  }
}

function seatPosition(i, n) {
  // clockwise from the top of an ellipse
  const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
  return { left: 50 + 40 * Math.cos(a), top: 50 + 40 * Math.sin(a) };
}

function renderSeats() {
  const me = state.me;
  const night = state.phase === 'night' && state.night.hasAction ? state.night : null;
  const voting = state.phase === 'vote' && me.alive;
  const n = state.players.length;

  for (const el of $$('#table .seat')) el.remove();
  const html = state.players.map((p, i) => {
    const cls = [
      'seat',
      p.alive ? '' : 'dead',
      p.id === me.id ? 'me' : '',
      state.speech && state.speech.current === p.id ? 'speaking' : '',
      (night && night.myTarget === p.id) || (voting && state.votes[me.id] === p.id) ? 'selected' : '',
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
    if (night && night.validTargets.includes(p.id)) {
      btn = `<button data-night="${p.id}">${esc(t('action.' + me.role))}</button>`;
    } else if (voting && p.alive && p.id !== me.id) {
      btn = `<button data-vote="${p.id}">${esc(t('vote.btn'))}</button>`;
    }

    const showRole = p.id !== me.id || roleShown || state.phase === 'ended';
    const pos = seatPosition(i, n);
    return `<div class="${cls}" style="left:${pos.left}%;top:${pos.top}%">
      <span class="num">${p.seat + 1}</span>
      ${avatar(p.name)}
      <div class="name">${esc(p.name)}</div>
      ${(showRole && p.role) || meta.length || p.id === me.id ? `<div class="meta">${p.id === me.id ? tagHtml('tag.you', 'you') : ''}${showRole ? roleTag(p.role) : ''} ${esc(meta.join(' · '))}</div>` : ''}
      ${extra ? `<div class="votes">${esc(extra)}</div>` : ''}
      ${btn}
    </div>`;
  }).join('');
  $('#table').insertAdjacentHTML('beforeend', html);

  for (const b of $$('[data-night]')) b.onclick = () => send('nightAction', { targetId: b.dataset.night });
  for (const b of $$('[data-vote]')) b.onclick = () => send('vote', { targetId: b.dataset.vote });
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
    case 'night': return [hostAction('endNight', 'forceEndNight', { n: state.night.pendingCount })];
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

function renderRoleCard() {
  const me = state.me;
  $('#roleToggle').textContent = t(roleShown ? 'ui.hide' : 'ui.show');
  const card = $('#roleCard');
  const box = card.closest('.role-box');
  box.className = 'card role-box' + (roleShown ? ` revealed ${state.roleInfo[me.role].team}` : '');
  if (!roleShown) {
    card.className = '';
    card.innerHTML = `<div class="role-hidden">${ICONS.eye}<span>${esc(t('ui.roleHidden'))}</span></div>`;
    return;
  }
  const allies = me.role === 'mafia'
    ? state.players.filter(p => p.role === 'mafia' && p.id !== me.id).map(p => p.name)
    : [];
  card.className = '';
  card.innerHTML = `
    <div class="role-name">${esc(roleName(me.role))}${me.alive ? '' : tagHtml('tag.dead')}</div>
    <p>${esc(t('blurb.' + me.role))}</p>
    ${allies.length ? `<p>${esc(t('ui.fellowMafia', { names: allies.join(', ') }))}</p>` : ''}`;
}

function renderGame() {
  renderRoleCard();
  renderPhasePanel();
  renderSeats();
  renderHostPanel();
  $('#log').innerHTML = state.log.slice().reverse().map(e => `<li>${esc(t(e.key, e.params))}</li>`).join('');
  $('#privateBox').classList.toggle('hidden', state.privateLog.length === 0);
  $('#privateLog').innerHTML = state.privateLog.slice().reverse().map(e => `<li>${esc(t('ui.nightNote', { n: e.day, text: t(e.key, e.params) }))}</li>`).join('');
}

function tickTimer() {
  const el = $('#timer');
  if (!el || !state || !state.speech || !state.speech.endsAt) return;
  const left = Math.max(0, Math.ceil((state.speech.endsAt - (Date.now() + clockOffset)) / 1000));
  el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  el.classList.toggle('low', left <= 10);
  const wrap = $('#timerWrap');
  wrap.classList.toggle('low', left <= 10);
  wrap.style.setProperty('--p', Math.min(1, left / state.settings.speechSeconds));
}
setInterval(tickTimer, 250);

function render() {
  // a pending host confirmation is void once the game has moved on or the user is no longer host
  if (pending && (!isHost() || pending.key !== momentKey())) {
    closeModal();
    toast(t('toast.hostCancelled'));
  }
  renderTopbar();
  document.body.dataset.phase = state && state.me ? state.phase : 'home';
  document.body.dataset.winner = (state && state.winner) || '';
  if (!state || !state.me) return show('home');
  if (state.phase === 'lobby') { show('lobby'); renderLobby(); return; }
  show('game');
  renderGame();
}

// ---------- language ----------
const langSelect = $('#langSelect');
langSelect.innerHTML = Object.entries(LANGS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
langSelect.value = lang;
langSelect.onchange = () => {
  setLang(langSelect.value);
  applyStaticTranslations();
  render();
};

applyStaticTranslations();
render();
