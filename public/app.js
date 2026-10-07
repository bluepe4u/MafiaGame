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

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), 3500);
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
const isHost = () => !!(state && state.me && state.hostId === state.me.id);
const roleName = r => state.roleInfo[r].name;
const roleTag = r => r ? `<span class="tag ${state.roleInfo[r].team}">${esc(roleName(r))}</span>` : '';
// identifies "the moment" a host action was requested for; if it changes, the action is stale
const momentKey = () => state ? `${state.phase}:${state.day}:${state.speech ? state.speech.index : ''}` : '';

// ---------- host confirmation (dialog + press-and-hold) ----------
let pending = null;
let hold = null;

function confirmHost({ title, text, event, payload = {}, label = 'Press and hold to confirm' }) {
  pending = { event, payload, key: momentKey() };
  $('#modalTitle').textContent = title;
  $('#modalText').textContent = text;
  $('.hold-label').textContent = label;
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

// ---------- top bar ----------
$('#leaveBtn').onclick = async () => {
  const inGame = state && state.phase !== 'lobby' && state.phase !== 'ended';
  if (inGame && !confirm('Leave this game? You will not be able to rejoin it.')) return;
  await send('leave');
  saveSession(null);
  state = null;
  render();
};

function phaseTitle() {
  switch (state.phase) {
    case 'lobby': return 'Lobby';
    case 'night': return `Night ${state.day}`;
    case 'speech': return `Day ${state.day} · Discussion`;
    case 'vote': return `Day ${state.day} · Vote`;
    case 'ended': return 'Game over';
    default: return '';
  }
}

function renderTopbar() {
  const inRoom = !!(state && state.me);
  $('#topRoom').classList.toggle('hidden', !inRoom);
  $('#leaveBtn').classList.toggle('hidden', !inRoom);
  $('#topPhase').textContent = inRoom ? phaseTitle() : '';
  $('#topMe').textContent = inRoom ? `Playing as ${state.me.name}${isHost() ? ' (host)' : ''}` : '';
  if (inRoom) $('#topCode').textContent = state.code;
}

// ---------- lobby ----------
$('#startBtn').onclick = () => confirmHost({
  title: 'Start the game?',
  text: `Roles will be dealt to all ${state.players.length} players. Nobody can join after this.`,
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
  $('#lobbyCode').textContent = state.code;
  $('#lobbyCount').textContent = `${state.players.length}/${state.maxPlayers} · minimum ${state.minPlayers}`;
  $('#lobbyPlayers').innerHTML = state.players.map(p => `
    <li>
      <span>${esc(p.name)}${p.id === state.hostId ? '<span class="tag">host</span>' : ''}${p.id === state.me.id ? '<span class="tag">you</span>' : ''}${p.connected ? '' : '<span class="tag">offline</span>'}</span>
      ${isHost() && p.id !== state.me.id ? `<button class="ghost small" data-kick="${p.id}">Remove</button>` : ''}
    </li>`).join('');
  for (const b of $$('[data-kick]')) {
    b.onclick = () => confirmHost({
      title: `Remove ${nameOf(b.dataset.kick)}?`,
      text: 'They will be taken out of the room and will need to join again.',
      event: 'kick',
      payload: { playerId: b.dataset.kick },
    });
  }

  const rc = state.roleCounts;
  const s = state.settings;
  const citizens = Math.max(0, state.players.length - rc.mafia - rc.cop - rc.doctor - rc.hooker);
  $('#setupSummary').innerHTML = [
    `Roles${s.roleCounts ? '' : ' (auto)'}: ${rc.mafia} Mafia, ${rc.cop} Cop, ${rc.doctor} Doctor, ${rc.hooker} Hooker, ${citizens} Citizen`,
    `${s.speechSeconds} seconds per speech`,
    s.firstNightKill ? 'Mafia kill on the first night' : 'No kill on the first night (Mafia only meet)',
    s.revealRoleOnDeath ? 'Roles are revealed on death' : 'Roles stay hidden on death',
  ].map(t => `<li>${esc(t)}</li>`).join('');
  $('#roleError').textContent = state.players.length >= state.minPlayers ? (state.roleCountsError || '') : '';

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
const ACTION_VERB = { mafia: 'Kill', cop: 'Check', doctor: 'Heal', hooker: 'Visit' };
const NIGHT_PROMPT = {
  mafia: 'Pick someone to kill. Your team sees your picks — agree on one target (a tie means no kill).',
  cop: 'Pick someone to investigate.',
  doctor: 'Pick someone to protect tonight.',
  hooker: 'Pick someone to visit. Their night action will be cancelled.',
  citizen: 'You sleep through the night. Wait for morning.',
};

$('#roleToggle').onclick = () => { roleShown = !roleShown; renderGame(); };

function nightPrompt() {
  const me = state.me;
  if (me.role === 'mafia' && !state.night.mafiaKills) {
    return 'There is no kill tonight. Use this night to learn who your fellow Mafia are.';
  }
  return NIGHT_PROMPT[me.role];
}

function renderPhasePanel() {
  const me = state.me;
  const panel = $('#phasePanel');

  if (state.phase === 'night') {
    const picked = state.night.myTarget;
    panel.innerHTML = `
      <div class="big">The town sleeps…</div>
      ${me.alive ? `<div class="prompt">${esc(nightPrompt())}</div>` : '<div class="prompt">You are dead. Stay quiet while the night plays out.</div>'}
      ${picked ? `<div>Your choice: <strong>${esc(nameOf(picked))}</strong><div class="muted small-text">You can change it until everyone has acted.</div></div>` : ''}
      <div class="muted small-text">Waiting on ${state.night.pendingCount} night action(s).</div>`;
  } else if (state.phase === 'speech') {
    const sp = state.speech;
    const mine = sp.current === me.id;
    panel.innerHTML = `
      <div class="muted">Speaking now</div>
      <div class="big">${esc(nameOf(sp.current))}${mine ? ' (you)' : ''}</div>
      <div class="timer" id="timer"></div>
      ${mine ? '<button id="endSpeech" class="primary">Finish my speech</button>' : ''}
      <div class="order">${sp.order.map((pid, i) => `<span class="${i < sp.index ? 'done' : i === sp.index ? 'now' : ''}">${i + 1}. ${esc(nameOf(pid))}</span>`).join('')}</div>`;
    if (mine) $('#endSpeech').onclick = () => send('endSpeech');
    tickTimer();
  } else if (state.phase === 'vote') {
    const alive = state.players.filter(p => p.alive);
    const voted = Object.keys(state.votes).length;
    const myVote = state.votes[me.id];
    panel.innerHTML = `
      <div class="big">Who should leave the town?</div>
      <div class="muted small-text">${voted}/${alive.length} voted. The top vote-getter leaves only with strictly more votes than anyone else and than “skip”.</div>
      ${me.alive ? `<div>Your vote: <strong>${myVote ? (myVote === 'skip' ? 'Skip' : esc(nameOf(myVote))) : '—'}</strong></div>
        <button id="skipVote" ${myVote === 'skip' ? 'disabled' : ''}>Vote to skip</button>` : '<div class="muted">You are dead and cannot vote.</div>'}`;
    if (me.alive) $('#skipVote').onclick = () => send('vote', { targetId: 'skip' });
  } else if (state.phase === 'ended') {
    panel.innerHTML = `
      <div class="winner">${state.winner === 'town' ? 'Town wins!' : 'Mafia wins!'}</div>
      <div class="muted">All roles are revealed around the table.</div>`;
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
    if (!p.connected) meta.push('offline');
    if (p.id === state.hostId) meta.push('host');
    if (!p.alive) meta.push('dead');
    let extra = '';
    if (night && night.mafiaVotes) {
      const pickers = Object.entries(night.mafiaVotes).filter(([, t]) => t === p.id).map(([m]) => nameOf(m));
      if (pickers.length) extra = `Mafia pick: ${pickers.join(', ')}`;
    }
    if (state.phase === 'vote') {
      const voters = Object.entries(state.votes).filter(([, t]) => t === p.id).map(([v]) => nameOf(v));
      if (voters.length) extra = `${voters.length} vote${voters.length > 1 ? 's' : ''}: ${voters.join(', ')}`;
    }

    let btn = '';
    if (night && night.validTargets.includes(p.id)) {
      btn = `<button data-night="${p.id}">${ACTION_VERB[me.role]}</button>`;
    } else if (voting && p.alive && p.id !== me.id) {
      btn = `<button data-vote="${p.id}">Vote</button>`;
    }

    const showRole = p.id !== me.id || roleShown || state.phase === 'ended';
    const pos = seatPosition(i, n);
    return `<div class="${cls}" style="left:${pos.left}%;top:${pos.top}%">
      <div class="name"><span class="num">${p.seat + 1}</span>${esc(p.name)}${p.id === me.id ? '<span class="tag">you</span>' : ''}</div>
      ${(showRole && p.role) || meta.length ? `<div class="meta">${showRole ? roleTag(p.role) : ''} ${esc(meta.join(' · '))}</div>` : ''}
      ${extra ? `<div class="votes">${esc(extra)}</div>` : ''}
      ${btn}
    </div>`;
  }).join('');
  $('#table').insertAdjacentHTML('beforeend', html);

  for (const b of $$('[data-night]')) b.onclick = () => send('nightAction', { targetId: b.dataset.night });
  for (const b of $$('[data-vote]')) b.onclick = () => send('vote', { targetId: b.dataset.vote });
}

function hostActions() {
  switch (state.phase) {
    case 'night': return [{
      label: 'Force end night', title: 'End the night now?',
      text: `${state.night.pendingCount} player(s) have not acted yet. Their actions will be skipped and the night will resolve immediately.`,
      event: 'forceEndNight',
    }];
    case 'speech': {
      const cur = state.speech.current;
      const list = [];
      if (cur !== state.me.id) {
        list.push({
          label: `End ${nameOf(cur)}'s speech`, title: `Cut off ${nameOf(cur)}?`,
          text: `${nameOf(cur)}'s speech will end now and the next player will start speaking.`,
          event: 'endSpeech',
        });
      }
      list.push({
        label: 'Skip to vote', title: 'Skip the rest of the discussion?',
        text: 'Everyone who has not spoken yet will lose their turn and voting will open immediately.',
        event: 'skipToVote',
      });
      return list;
    }
    case 'vote': {
      const alive = state.players.filter(p => p.alive).length;
      const missing = alive - Object.keys(state.votes).length;
      return [{
        label: 'Close voting now', title: 'Close the vote now?',
        text: `${missing} player(s) have not voted yet. The vote will be counted as it stands.`,
        event: 'forceEndVote',
      }];
    }
    case 'ended': return [{
      label: 'Back to lobby', title: 'Return everyone to the lobby?',
      text: 'The table resets for a new game. Offline players are removed.',
      event: 'restart',
    }];
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
  $('#roleToggle').textContent = roleShown ? 'Hide' : 'Show';
  const card = $('#roleCard');
  if (!roleShown) {
    card.className = 'muted small-text';
    card.textContent = 'Hidden. Click “Show” when nobody is looking at your screen.';
    return;
  }
  const info = state.roleInfo[me.role];
  const allies = me.role === 'mafia'
    ? state.players.filter(p => p.role === 'mafia' && p.id !== me.id).map(p => p.name)
    : [];
  card.className = '';
  card.innerHTML = `
    <div class="role-name">${esc(info.name)} ${roleTag(me.role)}${me.alive ? '' : ' <span class="tag">dead</span>'}</div>
    <p>${esc(info.blurb)}</p>
    ${allies.length ? `<p>Fellow Mafia: <strong>${esc(allies.join(', '))}</strong></p>` : ''}`;
}

function renderGame() {
  renderRoleCard();
  renderPhasePanel();
  renderSeats();
  renderHostPanel();
  $('#log').innerHTML = state.log.slice().reverse().map(e => `<li>${esc(e.text)}</li>`).join('');
  $('#privateBox').classList.toggle('hidden', state.privateLog.length === 0);
  $('#privateLog').innerHTML = state.privateLog.slice().reverse().map(e => `<li>Night ${e.day}: ${esc(e.text)}</li>`).join('');
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
  // a pending host confirmation is void once the game has moved on or the user is no longer host
  if (pending && (!isHost() || pending.key !== momentKey())) {
    closeModal();
    toast('The game moved on, so that host action was cancelled.');
  }
  renderTopbar();
  if (!state || !state.me) return show('home');
  if (state.phase === 'lobby') { show('lobby'); renderLobby(); return; }
  show('game');
  renderGame();
}

render();
