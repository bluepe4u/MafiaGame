'use strict';

// "Find the spy" client. Same accounts, tables and voice chat as the other games (common.js,
// voice.js); its own Socket.IO namespace. Everything is public except your own card.

const SESSION_KEY = 'spy.session';
const CROSSED_KEY = 'spy.crossed.'; // + game and round: locations you crossed out
const socket = io('/spyfall', { auth: cb => cb({ token: store.get(AUTH_KEY) }) });

let state = null;
let LOCS = []; // [{ id, ru, en, roles: [{ ru, en }] }]
let clockOffset = 0;
let homeView = false;
let cardShown = false;
let urlRoom = (new URLSearchParams(location.search).get('room') || '').toUpperCase().slice(0, 4);

Site.init({
  game: 'spy',
  socket,
  urlRoom: () => urlRoom,
  hooks: {
    onAccount: () => render(),
    onItems: () => render(),
    onLang: () => render(),
    busy: () => !!(state && state.me && state.phase === 'playing' && !state.me.spectator),
    leave: async () => { if (state && state.me) await send('leave'); store.set(SESSION_KEY, null); },
  },
});
Voice.init({ socket, me: () => state && state.me && state.me.id, route: () => true, channel: () => 'all', transcripts: () => false });
fetch('/api/spy/locations').then(r => r.json()).then(d => { LOCS = d.locations || []; render(); }).catch(() => {});

const locName = id => { const l = LOCS.find(x => x.id === id); return l ? (lang === 'ru' ? l.ru : l.en) : id; };
const roleName = (locId, i) => { const l = LOCS.find(x => x.id === locId); const r = l && l.roles[i]; return r ? (lang === 'ru' ? r.ru : r.en) : ''; };

// ---------- socket ----------
let everConnected = false;
socket.on('connect', () => {
  everConnected = true;
  $('#offline').classList.add('hidden');
  let s = null;
  try { s = JSON.parse(store.get(SESSION_KEY)); } catch {}
  if (s && (!urlRoom || urlRoom === s.code)) socket.emit('resume', s, res => { if (!res.ok) { store.set(SESSION_KEY, null); state = null; render(); } });
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
  history.replaceState(null, '', '/spyfall/');
  render();
}

// ---------- home and top bar ----------
if (urlRoom) $('#joinCode').value = urlRoom;
$('#createBtn').onclick = () => send('create');
$('#joinBtn').onclick = () => send('join', { code: $('#joinCode').value });
$('#watchBtn').onclick = () => send('join', { code: $('#joinCode').value, spectate: true });
$('#joinCode').addEventListener('keydown', e => { if (e.key === 'Enter') $('#joinBtn').click(); });
$('#homeBtn').onclick = () => { homeView = true; render(); };
$('#profileBtn').onclick = () => openProfile();
$('#homeProfile').onclick = () => openProfile();
$('#leaveBtn').onclick = async () => {
  if (state && state.phase === 'playing' && !state.me.spectator && !(await askConfirm({ title: t('ui.leaveRoom'), text: t('spy.confirmLeave'), danger: true }))) return;
  await send('leave');
  leftRoom();
};
$('#topRoom').onclick = $('#copyLink').onclick = async () => {
  try { await navigator.clipboard.writeText(`${location.origin}/spyfall/?room=${state.code}`); toast(t('toast.linkCopied'), 'info'); } catch {}
};

// ---------- helpers ----------
const isHost = () => !!(state && state.me && state.hostId === state.me.id);
const member = id => state && [...state.players, ...state.spectators].find(p => p.id === id);
const nameOf = id => (member(id) || {}).name || '?';
const isPlayer = () => !!(state && state.me && !state.me.spectator && state.players.some(p => p.id === state.me.id));
const left = endsAt => Math.max(0, Math.ceil((endsAt - (Date.now() + clockOffset)) / 1000));
const clock = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function show(screen) {
  for (const id of ['home', 'lobby', 'game']) $('#' + id).classList.toggle('hidden', id !== screen);
  Site.setHome(screen === 'home');
}

function render() {
  const inRoom = !!(state && state.me) && !homeView;
  document.body.dataset.phase = inRoom ? state.phase : 'home';
  $('#topRoom').classList.toggle('hidden', !inRoom);
  $('#leaveBtn').classList.toggle('hidden', !inRoom);
  if (inRoom) $('#topCode').textContent = state.code;
  $('#topRound').textContent = inRoom && state.game ? t('spy.roundOf', { n: state.game.roundN, of: state.game.rounds }) : '';
  if (inRoom && urlRoom !== state.code) { urlRoom = state.code; history.replaceState(null, '', `/spyfall/?room=${state.code}`); }
  updateTurnAlert(spyNeed());
  Voice.update(!!(state && state.me && state.features && state.features.voice && state.settings.voice !== false));
  if (!inRoom) return show('home');
  if (state.phase === 'lobby') { show('lobby'); return renderLobby(); }
  show('game');
  renderGame();
}

// what the game is waiting on this player for: the turn alert (chime, buzz, blinking title)
function spyNeed() {
  if (!state || !state.me || state.phase !== 'playing' || !isPlayer()) return null;
  const r = state.game.round;
  const me = state.me.id;
  if (r.stage === 'talk' && r.asker === me) return { key: `ask:${r.n}:${r.asks}`, text: t('spy.alert.ask') };
  if (r.stage === 'accuse' && r.accusation.target !== me && r.accusation.votes[me] === undefined) return { key: `acc:${r.n}:${r.accusation.by}`, text: t('spy.alert.vote') };
  if (r.stage === 'final' && !r.final.mine) return { key: `final:${r.n}`, text: t('spy.alert.final') };
  return null;
}

// ---------- lobby ----------
$('#readyBtn').onclick = () => { const mine = state.players.find(p => p.id === state.me.id); send('ready', { ready: !(mine && mine.ready) }); };
$('#watchToggle').onclick = () => send('watch', { on: !state.me.spectator });
$('#roundsInput').addEventListener('change', e => send('settings', { rounds: parseInt(e.target.value, 10) }));
$('#minutesInput').addEventListener('change', e => send('settings', { roundMinutes: parseInt(e.target.value, 10) }));
$('#verdictSelect').addEventListener('change', e => send('settings', { verdict: e.target.value }));
$('#voiceOn').addEventListener('change', e => send('settings', { voice: e.target.checked }));
$('#startBtn').onclick = () => send('start');
const setIfNotFocused = (el, v) => { if (document.activeElement !== el) el.value = v; };

function renderLobby() {
  const s = state.settings;
  $('#lobbyCount').textContent = `${state.players.length}/${state.maxPlayers}`;
  $('#lobbyPlayers').innerHTML = state.players.map(p => `
    <li class="${p.connected ? '' : 'offline'} ${p.ready ? 'is-ready' : ''}">
      <span class="avatar-wrap clickable" data-open-player="${p.userId || ''}">${avatar(p.name, p.avatar, p.cos)}${p.ready ? '<span class="voted ready-mark">✓</span>' : ''}</span>
      <span class="pname"><b class="${nameCls(p.cos)}">${esc(p.name)}</b>${titleTag(p.title)}${statusPill(p.score)}${p.id === state.hostId ? `<span class="tag host">${esc(t('tag.host'))}</span>` : ''}</span>
      ${isHost() ? `<button class="ghost small icon-only" data-rename="${p.id}" aria-label="${esc(t('rename.btn'))}">✎</button>` : ''}
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
  $('#spectatorBox').classList.toggle('hidden', !state.spectators.length);
  $('#spectatorList').innerHTML = state.spectators.map(w => `<span class="spectator">${avatar(w.name, w.avatar, w.cos)}<b>${esc(w.name)}</b></span>`).join('');
  $('#shareCode').innerHTML = esc(t('ui.shareCode', { code: '\u0000' })).replace('\u0000', `<strong class="code">${esc(state.code)}</strong>`);
  const qr = `/qr.svg?room=${state.code}&game=spy`;
  if ($('#inviteQr').getAttribute('src') !== qr) $('#inviteQr').src = qr;
  $('#setupSummary').innerHTML = [
    t('spy.sumRounds', { n: s.rounds, m: s.roundMinutes }),
    t('spy.verdict.' + s.verdict),
    state.features && state.features.voice ? t(s.voice !== false ? 'sum.voiceOn' : 'sum.voiceOff') : '',
  ].filter(Boolean).map(x => `<li>${esc(x)}</li>`).join('');
  $('#hostSettings').classList.toggle('hidden', !isHost());
  $('#startBtn').classList.toggle('hidden', !isHost());
  $('#waitHost').classList.toggle('hidden', isHost());
  $('#startBtn').disabled = state.players.length < state.minPlayers;
  $('#startBtn').textContent = state.players.length < state.minPlayers ? t('mono.needPlayers', { n: state.minPlayers }) : `${t('spy.start')} · ${t('ui.readyCount', { n: readyN, total: state.players.length })}`;
  if (isHost()) {
    setIfNotFocused($('#roundsInput'), s.rounds);
    setIfNotFocused($('#minutesInput'), s.roundMinutes);
    $('#verdictSelect').value = s.verdict;
    $('#voiceOn').checked = s.voice !== false;
    $('#voiceOn').closest('label').classList.toggle('hidden', !(state.features && state.features.voice));
  }
}

// ---------- your card: hidden until you hold it (someone might be looking at your screen) ----------
const cardEl = $('#spyCard');
const peek = on => { if (cardShown === on) return; cardShown = on; if (state && state.game) renderCard(); };
cardEl.addEventListener('pointerdown', e => { e.preventDefault(); cardEl.setPointerCapture(e.pointerId); peek(true); });
for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) cardEl.addEventListener(ev, () => peek(false));
cardEl.addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); peek(true); } });
cardEl.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') peek(false); });
window.addEventListener('blur', () => peek(false));

function renderCard() {
  const card = state.game.card;
  const box = cardEl.closest('.spy-card-box');
  if (!card) { box.className = 'card spy-card-box'; cardEl.innerHTML = `<div class="role-hidden">${esc(t('ui.watchingNote'))}</div>`; return; }
  box.className = 'card spy-card-box' + (cardShown ? (card.spy ? ' spy' : ' town') : '');
  cardEl.innerHTML = !cardShown
    ? `<div class="role-hidden">${esc(t('spy.holdCard'))}</div>`
    : card.spy
      ? `<div class="card-big">🕵️ ${esc(t('spy.youAreSpy'))}</div><p class="muted">${esc(t('spy.spyHint'))}</p>`
      : `<div class="muted small-text">${esc(t('spy.location'))}</div><div class="card-big">${esc(locName(card.location))}</div>
         <div class="muted small-text">${esc(t('spy.yourRole'))}</div><div class="card-role">${esc(roleName(card.location, card.role))}</div>`;
}

// ---------- the list of locations: cross out what it can't be ----------
const crossedKey = () => `${CROSSED_KEY}${state.gameId}:${state.game.roundN}`;
function crossed() { try { return JSON.parse(sessionStorage.getItem(crossedKey())) || []; } catch { return []; } }
function renderLocations() {
  const out = new Set(crossed());
  const r = state.game.round;
  const reveal = r.stage === 'reveal' ? r.location : null;
  $('#locGrid').innerHTML = LOCS.map(l => `<button class="loc ${out.has(l.id) ? 'out' : ''} ${reveal === l.id ? 'answer' : ''}" data-loc="${l.id}">${esc(lang === 'ru' ? l.ru : l.en)}</button>`).join('');
  for (const b of $$('#locGrid [data-loc]')) {
    b.onclick = () => {
      const set = new Set(crossed());
      set.has(b.dataset.loc) ? set.delete(b.dataset.loc) : set.add(b.dataset.loc);
      try { sessionStorage.setItem(crossedKey(), JSON.stringify([...set])); } catch {}
      renderLocations();
    };
  }
}

// ---------- the game ----------
function renderGame() {
  const g = state.game;
  const r = g.round;
  renderCard();
  renderLocations();
  renderStage();
  renderPlayers();
  $('#roundInfo').textContent = t('spy.roundOf', { n: g.roundN, of: g.rounds });
  $('#historyBox').classList.toggle('hidden', !g.history.length);
  $('#historyList').innerHTML = g.history.slice().reverse().map(h => `<li><b>${esc(t('spy.round', { n: h.n }))}</b> · ${esc(locName(h.location))} · ${esc(t('spy.spyWas', { name: nameOf(h.spy) }))} —
    <span class="tag ${h.result.winner === 'spy' ? 'mafia' : 'town'}">${esc(t('spy.reason.' + h.result.reason))}</span></li>`).join('');
  void r;
}

function renderStage() {
  const g = state.game;
  const r = g.round;
  const me = state.me.id;
  const playing = isPlayer();
  const panel = $('#stagePanel');
  const spyBtn = playing && g.card && g.card.spy && (r.stage === 'talk' || r.stage === 'final')
    ? `<button id="spyGuessBtn" class="danger">🕵️ ${esc(t('spy.revealGuess'))}</button>` : '';
  if (state.phase === 'ended') {
    const ranked = g.order.slice().sort((a, b) => g.scores[b] - g.scores[a]);
    panel.innerHTML = `<div class="stage-title">${esc(t('spy.gameOver'))}</div>
      <div class="winner-line">🏆 ${esc(t('spy.winners', { names: g.winners.map(nameOf).join(', ') }))}</div>
      <ol class="results">${ranked.map((pid, i) => `<li class="${g.winners.includes(pid) ? 'first' : ''}"><span class="board-rank">${['🥇', '🥈', '🥉'][i] || i + 1}</span><b>${esc(nameOf(pid))}</b><span class="spacer"></span><b>${esc(t('spy.points', { n: g.scores[pid] }))}</b></li>`).join('')}</ol>
      ${isHost() ? `<button id="restartBtn" class="primary">${esc(t('mono.backToLobby'))}</button>` : ''}`;
    if (isHost()) $('#restartBtn').onclick = () => send('restart');
    return;
  }
  if (r.stage === 'talk') {
    const mine = r.asker === me;
    panel.innerHTML = `<div class="stage-top"><span class="big-timer" id="spyTimer"></span><span class="muted">${esc(t('spy.untilVote'))}</span></div>
      <div class="stage-title">${mine ? esc(t('spy.yourQuestion')) : esc(t('spy.asking', { name: nameOf(r.asker) }))}</div>
      ${mine ? `<p class="muted small-text">${esc(t('spy.pickWhom'))}</p><div class="row wrap ask-row">${state.players.filter(p => p.id !== me && p.id !== r.lastAsker).map(p => `<button data-ask="${p.id}">${esc(p.name)}</button>`).join('')}</div>`
        : r.lastAsker ? `<p class="muted small-text">${esc(t('spy.askedBy', { name: nameOf(r.lastAsker), to: nameOf(r.asker) }))}</p>` : `<p class="muted small-text">${esc(t('spy.dealerStarts'))}</p>`}
      ${r.lastAccusation ? `<p class="muted small-text">${esc(t('spy.accusationFailed', { by: nameOf(r.lastAccusation.by), target: nameOf(r.lastAccusation.target) }))}</p>` : ''}
      <div class="row">${spyBtn}</div>`;
    for (const b of $$('[data-ask]')) b.onclick = () => send('ask', { target: b.dataset.ask });
  } else if (r.stage === 'accuse') {
    const a = r.accusation;
    const voters = state.players.filter(p => p.id !== a.target);
    const votedN = voters.filter(p => a.votes[p.id] !== undefined).length;
    const canVote = playing && me !== a.target && a.votes[me] === undefined;
    panel.innerHTML = `<div class="stage-top"><span class="big-timer" id="spyTimer"></span><span class="muted">${esc(t('spy.toVote'))}</span></div>
      <div class="stage-title">⚖️ ${esc(t('spy.accuses', { by: nameOf(a.by), target: nameOf(a.target) }))}</div>
      <p class="muted small-text">${esc(t('spy.verdictNeed.' + state.settings.verdict))} · ${esc(t('spy.votedOf', { n: votedN, of: voters.length }))}</p>
      <div class="vote-chips">${voters.map(p => `<span class="tag ${a.votes[p.id] === true ? 'mafia' : a.votes[p.id] === false ? 'town' : ''}">${esc(p.name)}${a.votes[p.id] === true ? ' ✓' : a.votes[p.id] === false ? ' ✗' : ''}</span>`).join('')}</div>
      ${canVote ? `<div class="row center"><button id="voteYes" class="danger">${esc(t('spy.yesSpy'))}</button><button id="voteNo">${esc(t('spy.noSpy'))}</button></div>`
        : me === a.target ? `<p>${esc(t('spy.youAreAccused'))}</p>` : ''}`;
    if (canVote) { $('#voteYes').onclick = () => send('voteAccusation', { yes: true }); $('#voteNo').onclick = () => send('voteAccusation', { yes: false }); }
  } else if (r.stage === 'final') {
    const voted = new Set(r.final.voted);
    panel.innerHTML = `<div class="stage-top"><span class="big-timer" id="spyTimer"></span><span class="muted">${esc(t('spy.toVote'))}</span></div>
      <div class="stage-title">⏰ ${esc(t('spy.finalTitle'))}</div>
      <p class="muted small-text">${esc(t('spy.verdictNeed.' + state.settings.verdict))} · ${esc(t('spy.votedOf', { n: voted.size, of: state.players.length }))}</p>
      ${playing ? `<div class="row wrap ask-row">${state.players.filter(p => p.id !== me).map(p => `<button class="${r.final.mine === p.id ? 'primary' : ''}" data-final="${p.id}">${esc(p.name)}</button>`).join('')}</div>` : ''}
      <div class="row">${spyBtn}</div>`;
    for (const b of $$('[data-final]')) b.onclick = () => send('finalVote', { target: b.dataset.final });
  } else if (r.stage === 'reveal') {
    const res = r.result;
    const won = res.winner === 'spy';
    panel.innerHTML = `<div class="reveal-banner ${won ? 'spy' : 'town'}">${won ? '🕵️' : '🎉'} ${esc(t(won ? 'spy.spyWins' : 'spy.townWins'))}</div>
      <div class="stage-title">${esc(t('spy.reason.' + res.reason))}</div>
      <p>${esc(t('spy.spyWas', { name: nameOf(r.spy) }))} · ${esc(t('spy.locationWas', { place: locName(r.location) }))}${res.guess && res.reason === 'spyMissed' ? ` · ${esc(t('spy.spyGuessed', { place: locName(res.guess) }))}` : ''}</p>
      <div class="vote-chips">${Object.entries(r.points).map(([pid, n]) => `<span class="tag town">${esc(nameOf(pid))} +${n}</span>`).join('')}</div>
      ${isHost() ? `<button id="nextBtn" class="primary">${esc(t(g.roundN >= g.rounds ? 'spy.toResults' : 'spy.nextRound'))}</button>` : `<p class="muted small-text">${esc(t('spy.waitHostNext'))}</p>`}`;
    if (isHost()) $('#nextBtn').onclick = () => send('next');
  }
  const gb = $('#spyGuessBtn');
  if (gb) gb.onclick = openGuess;
  tick();
}

function renderPlayers() {
  const g = state.game;
  const r = g.round;
  const me = state.me.id;
  const canAccuse = isPlayer() && state.phase === 'playing' && r.stage === 'talk' && !r.accusers.includes(me);
  $('#spyPlayers').innerHTML = g.order.map(pid => {
    const p = member(pid) || { name: '?' };
    const tags = [
      r.asker === pid && r.stage === 'talk' ? `<span class="tag host">${esc(t('spy.asks'))}</span>` : '',
      r.dealer === pid ? `<span class="tag">${esc(t('spy.dealer'))}</span>` : '',
      r.accusers.includes(pid) ? `<span class="tag" title="${esc(t('spy.accusedOnce'))}">⚖️</span>` : '',
      r.stage === 'reveal' && r.spy === pid ? `<span class="tag mafia">🕵️ ${esc(t('spy.spy'))}</span>` : '',
      r.stage === 'reveal' && r.roles && r.roles[pid] !== undefined ? `<span class="tag town">${esc(roleName(r.location, r.roles[pid]))}</span>` : '',
      p.connected === false ? `<span class="tag">${esc(t('tag.offline'))}</span>` : '',
    ].join('');
    return `<div class="spy-player ${r.asker === pid && r.stage === 'talk' ? 'asking' : ''} ${pid === me ? 'me' : ''}" data-pid="${pid}">
      <span class="avatar-wrap clickable" data-open-player="${p.userId || ''}">${avatar(p.name, p.avatar, p.cos)}</span>
      <div class="sp-main"><b class="${nameCls(p.cos)}">${esc(p.name)}</b><div class="sp-tags">${tags}</div></div>
      <span class="sp-score">${g.scores[pid]}</span>
      ${canAccuse && pid !== me ? `<button class="ghost small" data-accuse="${pid}">${esc(t('spy.accuse'))}</button>` : ''}
    </div>`;
  }).join('');
  for (const el of $$('#spyPlayers [data-open-player]')) if (el.dataset.openPlayer) el.onclick = () => openPlayer(el.dataset.openPlayer);
  for (const b of $$('[data-accuse]')) {
    b.onclick = async () => {
      if (!(await askConfirm({ title: t('spy.accuse'), text: t('spy.accuseConfirm', { name: nameOf(b.dataset.accuse) }), danger: true }))) return;
      send('accuse', { target: b.dataset.accuse });
    };
  }
}

// ---------- the spy names the location ----------
function openGuess() {
  $('#guessGrid').innerHTML = LOCS.map(l => `<button class="loc" data-guess="${l.id}">${esc(lang === 'ru' ? l.ru : l.en)}</button>`).join('');
  for (const b of $$('[data-guess]')) {
    b.onclick = async () => {
      if (!(await askConfirm({ title: t('spy.guessTitle'), text: t('spy.guessConfirm', { place: locName(b.dataset.guess) }), danger: true }))) return;
      $('#guessSheet').classList.add('hidden');
      send('spyGuess', { location: b.dataset.guess });
    };
  }
  $('#guessSheet').classList.remove('hidden');
}
$('#guessClose').onclick = () => $('#guessSheet').classList.add('hidden');

// ---------- the clock ----------
function tick() {
  const el = $('#spyTimer');
  if (!el || !state || !state.game || !state.game.round) return;
  const r = state.game.round;
  const at = r.stage === 'talk' ? r.endsAt : r.stage === 'accuse' ? r.accusation.endsAt : r.stage === 'final' ? r.final.endsAt : null;
  if (!at) { el.textContent = ''; return; }
  const s = left(at);
  el.textContent = clock(s);
  el.classList.toggle('low', s <= 30);
}
setInterval(tick, 250);

// ---------- sounds on changes ----------
function fxOnState(prev, s) {
  if (!prev || !prev.game || !s.game || !s.game.round || !alertsOn) return;
  const a = prev.game.round, b = s.game.round;
  if (a && b.stage !== a.stage && b.stage === 'reveal') [523, 659, 784].forEach((f, i) => tone({ f, at: i * 0.1, dur: 0.4, vol: 0.07, type: 'triangle' }));
  if (a && b.n !== a.n) cardShown = false;
}

// ---------- leaderboard (this game's stats) ----------
let boardTab = 'wins';
let boardUsers = [];
async function openBoard() {
  const res = await api('leaderboard');
  if (!res.ok) return;
  boardUsers = res.users;
  $('#boardSheet').classList.remove('hidden');
  renderBoard();
}
function renderBoard() {
  for (const b of $$('[data-board]')) b.classList.toggle('active', b.dataset.board === boardTab);
  const metric = {
    wins: s => [s.wins, s.wins],
    points: s => [s.points, s.points],
    spy: s => [s.spyWins, `${s.spyWins}/${s.spyRounds}`],
    games: s => [s.games, s.games],
  }[boardTab];
  const rows = boardUsers.map(u => ({ u, m: metric(u.spyStats) })).filter(r => r.u.spyStats.games > 0).sort((a, b) => b.m[0] - a.m[0]);
  $('#boardList').innerHTML = rows.length ? rows.map(({ u, m }, i) => `
    <li class="board-row ${account && u.id === account.id ? 'me' : ''}" data-player="${u.id}">
      <span class="board-rank">${['🥇', '🥈', '🥉'][i] || `<span class="rank">${i + 1}</span>`}</span>
      ${avatar(u.username, u.avatar, u.equipped)}
      <span class="board-id"><b class="${nameCls(u.equipped)}">${esc(u.username)}</b><span class="muted small-text">${esc(t('spy.board.sub', { g: u.spyStats.games, w: u.spyStats.wins }))}</span></span>
      <span class="board-metric">${m[1]}</span>
    </li>`).join('') : `<p class="muted small-text">${esc(t('board.empty'))}</p>`;
  for (const row of $$('#boardList [data-player]')) row.onclick = () => openProfile(row.dataset.player, 'spy');
}
for (const b of $$('[data-board]')) b.onclick = () => { boardTab = b.dataset.board; renderBoard(); };
$('#boardBtn').onclick = openBoard;
$('#homeBoard').onclick = openBoard;
$('#boardClose').onclick = () => $('#boardSheet').classList.add('hidden');
for (const id of ['boardSheet', 'guessSheet']) $('#' + id).addEventListener('pointerdown', e => { if (e.target.id === id) $('#' + id).classList.add('hidden'); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') for (const id of ['boardSheet', 'guessSheet']) $('#' + id).classList.add('hidden'); });

applyStaticTranslations();
render();
