'use strict';

const socket = io();
const $ = sel => document.querySelector(sel);
const SESSION_KEY = 'mafia.session';
const NAME_KEY = 'mafia.name';

let state = null;
let clockOffset = 0; // serverNow - clientNow
let roleShown = false;

// ---------- utils ----------
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), 3000);
}

function send(event, payload = {}) {
  return new Promise(resolve => {
    socket.emit(event, payload, res => {
      if (res && !res.ok) toast(res.error);
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
const isHost = () => state && state.me && state.hostId === state.me.id;
const roleName = r => state.roleInfo[r].name;
const roleTag = r => r ? `<span class="tag ${state.roleInfo[r].team}">${esc(roleName(r))}</span>` : '';

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
  toast('You were removed from the room');
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

// ---------- lobby ----------
$('#leaveBtn').onclick = async () => {
  await send('leave');
  saveSession(null);
  state = null;
  render();
};
$('#startBtn').onclick = () => send('start');
$('#autoRoles').onclick = () => send('settings', { roleCounts: null });
for (const input of document.querySelectorAll('[data-role]')) {
  input.addEventListener('change', () => {
    const counts = {};
    for (const i of document.querySelectorAll('[data-role]')) counts[i.dataset.role] = parseInt(i.value, 10) || 0;
    send('settings', { roleCounts: counts });
  });
}
$('#speechSeconds').addEventListener('change', e => send('settings', { speechSeconds: parseInt(e.target.value, 10) }));
$('#revealRole').addEventListener('change', e => send('settings', { revealRoleOnDeath: e.target.checked }));

function setIfNotFocused(el, prop, value) {
  if (document.activeElement !== el) el[prop] = value;
}

function renderLobby() {
  $('#lobbyCode').textContent = state.code;
  $('#lobbyCount').textContent = `${state.players.length}/${state.maxPlayers} players · need at least ${state.minPlayers}`;
  $('#lobbyPlayers').innerHTML = state.players.map(p => `
    <li>
      <span>${esc(p.name)}${p.id === state.hostId ? ' <span class="tag">host</span>' : ''}${p.id === state.me.id ? ' <span class="tag">you</span>' : ''}${p.connected ? '' : ' <span class="tag">offline</span>'}</span>
      ${isHost() && p.id !== state.me.id ? `<button class="ghost small" data-kick="${p.id}">Kick</button>` : ''}
    </li>`).join('');
  for (const b of document.querySelectorAll('[data-kick]')) b.onclick = () => send('kick', { playerId: b.dataset.kick });

  const rc = state.roleCounts;
  const citizens = state.players.length - rc.mafia - rc.cop - rc.doctor - rc.hooker;
  $('#roleSummary').textContent =
    `Roles: ${rc.mafia} Mafia, ${rc.cop} Cop, ${rc.doctor} Doctor, ${rc.hooker} Hooker, ${Math.max(0, citizens)} Citizen` +
    `${state.settings.roleCounts ? '' : ' (auto)'} · ${state.settings.speechSeconds}s speeches`;
  $('#roleError').textContent = state.players.length >= state.minPlayers ? (state.roleCountsError || '') : '';

  $('#hostSettings').classList.toggle('hidden', !isHost());
  $('#startBtn').classList.toggle('hidden', !isHost());
  $('#waitHost').classList.toggle('hidden', isHost());
  $('#startBtn').disabled = state.players.length < state.minPlayers || !!state.roleCountsError;
  if (isHost()) {
    for (const i of document.querySelectorAll('[data-role]')) setIfNotFocused(i, 'value', rc[i.dataset.role]);
    setIfNotFocused($('#speechSeconds'), 'value', state.settings.speechSeconds);
    $('#revealRole').checked = state.settings.revealRoleOnDeath;
  }
}

// ---------- game ----------
const ACTION_VERB = { mafia: 'Kill', cop: 'Check', doctor: 'Heal', hooker: 'Visit' };
const NIGHT_PROMPT = {
  mafia: 'Choose someone to kill. Your team sees your picks — agree on one target (ties mean no kill).',
  cop: 'Choose someone to investigate.',
  doctor: 'Choose someone to protect tonight.',
  hooker: 'Choose someone to visit. Their night action will be blocked.',
  citizen: 'You sleep through the night. Keep your eyes closed and wait for morning.',
};

$('#roleToggle').onclick = () => { roleShown = !roleShown; renderGame(); };

function phaseTitle() {
  switch (state.phase) {
    case 'night': return `Night ${state.day}`;
    case 'speech': return `Day ${state.day} · Discussion`;
    case 'vote': return `Day ${state.day} · Vote`;
    case 'ended': return 'Game over';
    default: return '';
  }
}

function renderPhasePanel() {
  const me = state.me;
  const panel = $('#phasePanel');

  if (state.phase === 'night') {
    if (!me.alive) {
      panel.innerHTML = `<div class="big">You are dead.</div><p class="muted">Stay quiet while the night plays out.</p>`;
    } else {
      const picked = state.night.myTarget;
      panel.innerHTML = `
        <div class="big">The town sleeps…</div>
        <p>${esc(NIGHT_PROMPT[me.role])}</p>
        ${picked ? `<p>Your choice: <strong>${esc(nameOf(picked))}</strong> (you can change it until everyone has acted)</p>` : ''}
        <p class="muted">Waiting on ${state.night.pendingCount} night action(s).</p>`;
    }
  } else if (state.phase === 'speech') {
    const sp = state.speech;
    const current = sp.current;
    const canEnd = current === me.id || isHost();
    panel.innerHTML = `
      <div class="muted">Speaking now</div>
      <div class="big">${esc(nameOf(current))}${current === me.id ? ' (you)' : ''}</div>
      <div class="timer" id="timer"></div>
      ${canEnd ? `<button id="endSpeech" class="primary">${current === me.id ? 'Finish my speech' : 'Next speaker'}</button>` : ''}
      <div class="order">${sp.order.map((pid, i) => `<span class="${i < sp.index ? 'done' : i === sp.index ? 'now' : ''}">${i + 1}. ${esc(nameOf(pid))}</span>`).join('')}</div>`;
    if (canEnd) $('#endSpeech').onclick = () => send('endSpeech');
    tickTimer();
  } else if (state.phase === 'vote') {
    const alive = state.players.filter(p => p.alive);
    const voted = Object.keys(state.votes).length;
    const myVote = state.votes[me.id];
    panel.innerHTML = `
      <div class="big">Who should leave the town?</div>
      <p class="muted">${voted}/${alive.length} voted. Most votes is eliminated; ties or skips ≥ top mean nobody leaves.</p>
      ${me.alive ? `<p>Your vote: <strong>${myVote ? (myVote === 'skip' ? 'Skip' : esc(nameOf(myVote))) : '—'}</strong></p>
        <button id="skipVote" ${myVote === 'skip' ? 'disabled' : ''}>Vote to skip</button>` : '<p>You are dead and cannot vote.</p>'}`;
    if (me.alive) $('#skipVote').onclick = () => send('vote', { targetId: 'skip' });
  } else if (state.phase === 'ended') {
    panel.innerHTML = `
      <div class="winner">${state.winner === 'town' ? 'Town wins!' : 'Mafia wins!'}</div>
      <p class="muted">All roles are revealed below.</p>
      ${isHost() ? '<button id="restart" class="primary">Back to lobby</button>' : '<p class="muted">Waiting for host…</p>'}`;
    if (isHost()) $('#restart').onclick = () => send('restart');
  }
}

function renderPlayers() {
  const me = state.me;
  const night = state.phase === 'night' && me.alive && me.role !== 'citizen' ? state.night : null;
  const voting = state.phase === 'vote' && me.alive;
  const voteCounts = {};
  if (state.votes) for (const t of Object.values(state.votes)) voteCounts[t] = (voteCounts[t] || 0) + 1;

  $('#players').innerHTML = state.players.map(p => {
    const cls = [
      p.alive ? '' : 'dead',
      p.id === me.id ? 'me' : '',
      state.speech && state.speech.current === p.id ? 'speaking' : '',
      (night && night.myTarget === p.id) || (voting && state.votes[me.id] === p.id) ? 'selected' : '',
    ].join(' ');

    const meta = [];
    if (!p.connected) meta.push('offline');
    if (p.id === state.hostId) meta.push('host');
    if (night && night.mafiaVotes) {
      const pickers = Object.entries(night.mafiaVotes).filter(([, t]) => t === p.id).map(([m]) => nameOf(m));
      if (pickers.length) meta.push('Mafia pick: ' + pickers.join(', '));
    }
    if (state.phase === 'vote') {
      const voters = Object.entries(state.votes).filter(([, t]) => t === p.id).map(([v]) => nameOf(v));
      if (voters.length) meta.push(`${voters.length} vote(s): ${voters.join(', ')}`);
    }

    let btn = '';
    if (night && night.validTargets.includes(p.id)) {
      btn = `<button data-night="${p.id}">${ACTION_VERB[me.role]}</button>`;
    } else if (voting && p.alive && p.id !== me.id) {
      btn = `<button data-vote="${p.id}">Vote</button>`;
    }

    return `<li class="${cls}">
      <div><span class="name">${p.seat + 1}. ${esc(p.name)}</span>${p.id === me.id ? '<span class="tag">you</span>' : ''}${p.id === me.id && !roleShown ? '' : roleTag(p.role)}</div>
      ${meta.length ? `<div class="meta">${esc(meta.join(' · '))}</div>` : ''}
      ${btn}
    </li>`;
  }).join('');

  for (const b of document.querySelectorAll('[data-night]')) b.onclick = () => send('nightAction', { targetId: b.dataset.night });
  for (const b of document.querySelectorAll('[data-vote]')) b.onclick = () => send('vote', { targetId: b.dataset.vote });
}

function renderHostControls() {
  const hc = $('#hostControls');
  const controls = {
    night: ['forceEndNight', 'Force end night'],
    speech: ['skipToVote', 'Skip to vote'],
    vote: ['forceEndVote', 'Close voting now'],
  }[state.phase];
  hc.classList.toggle('hidden', !isHost() || !controls);
  if (isHost() && controls) {
    hc.innerHTML = `<span class="muted">Host:</span><button class="ghost small" id="hostAction">${controls[1]}</button>`;
    $('#hostAction').onclick = () => {
      if (confirm(`${controls[1]}?`)) send(controls[0]);
    };
  }
}

function renderGame() {
  const me = state.me;
  $('#phaseTitle').textContent = phaseTitle();
  $('#roleToggle').textContent = roleShown ? 'Hide role' : 'Show role';
  const info = state.roleInfo[me.role];
  const card = $('#roleCard');
  card.classList.toggle('hidden', !roleShown);
  if (roleShown) {
    const allies = me.role === 'mafia'
      ? state.players.filter(p => p.role === 'mafia' && p.id !== me.id).map(p => p.name)
      : [];
    card.innerHTML = `
      <div class="muted">Your role${me.alive ? '' : ' (dead)'}</div>
      <div class="role-name">${esc(info.name)} ${roleTag(me.role)}</div>
      <p>${esc(info.blurb)}</p>
      ${allies.length ? `<p>Fellow Mafia: <strong>${esc(allies.join(', '))}</strong></p>` : ''}`;
  }
  renderPhasePanel();
  renderPlayers();
  renderHostControls();

  $('#log').innerHTML = state.log.map(e => `<li>${esc(e.text)}</li>`).join('');
  $('#privateBox').classList.toggle('hidden', state.privateLog.length === 0);
  $('#privateLog').innerHTML = state.privateLog.map(e => `<li>Night ${e.day}: ${esc(e.text)}</li>`).join('');
}

function tickTimer() {
  const el = $('#timer');
  if (!el || !state || !state.speech || !state.speech.endsAt) return;
  const left = Math.max(0, Math.ceil((state.speech.endsAt - (Date.now() + clockOffset)) / 1000));
  el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  el.classList.toggle('low', left <= 10);
}
setInterval(tickTimer, 250);

function render() {
  if (!state || !state.me) return show('home');
  if (state.phase === 'lobby') { show('lobby'); renderLobby(); return; }
  show('game');
  renderGame();
}

render();
