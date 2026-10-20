'use strict';

// Citadels client. Same accounts, tables and voice chat as the other games (common.js, voice.js);
// its own Socket.IO namespace. Hands, picks and the face-down cards are secret.

const SESSION_KEY = 'cit.session';
const socket = io('/citadels', { auth: cb => cb({ token: store.get(AUTH_KEY) }) });

let state = null;
let CARDS = null; // { characters, rankChoices, districts }
let clockOffset = 0;
let urlRoom = (new URLSearchParams(location.search).get('room') || '').toUpperCase().slice(0, 4);
let homeView = false; // back on the home screen while still in a room
let targeting = null; // picking a district in the cities: { title, can(pid, card) -> null | { cost }, pick(pid, card) }


// ---------- sound effects (muted with the bell, like the alerts) ----------
const beep = (f, at = 0, dur = 0.15, type = 'triangle', vol = 0.06) => alertsOn && tone({ f, at, dur, type, vol, attack: 0.01 });
const SFX = {
  coin: () => { beep(988, 0, 0.1); beep(1319, 0.07, 0.25); },
  build: () => { beep(196, 0, 0.12, 'square', 0.04); beep(262, 0.09, 0.22, 'triangle', 0.06); },
  pick: () => { beep(523, 0, 0.1); beep(784, 0.08, 0.2); },
  bad: () => { beep(330, 0, 0.18, 'sine', 0.07); beep(220, 0.12, 0.3, 'sine', 0.06); },
  win: () => [523, 659, 784, 1046].forEach((f, i) => beep(f, i * 0.1, 0.5)),
};

// ---------- icons ----------
const drawIcon = paths => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
const ICONS = {
  noble: drawIcon('<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/>'),
  religious: drawIcon('<path d="M12 2v5M9.5 4.5h5M5 21V12l7-5 7 5v9M10 21v-5h4v5"/>'),
  trade: drawIcon('<path d="M12 3v17M8 21h8M4 7h16M7 7l-3 6a3 3 0 0 0 6 0zM17 7l-3 6a3 3 0 0 0 6 0z"/>'),
  military: drawIcon('<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M12 8v8M9 11h6"/>'),
  unique: drawIcon('<path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6-4.5-4.2 6.1-.7z"/>'),
  coin: drawIcon('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/>'),
  cards: drawIcon('<rect x="4" y="6" width="11" height="15" rx="2"/><path d="M9 3h9a2 2 0 0 1 2 2v13"/>'),
  crown: drawIcon('<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/>'),
  book: drawIcon('<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h11"/>'),
  clock: drawIcon('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
};
$('#rulesBtn').innerHTML = COMMON_ICONS.book;
$('#rulesBtn').title = t('rules.title');

// ---------- card data ----------
fetch('/api/cit/cards').then(r => r.json()).then(d => { CARDS = d; settingsKey = ''; render(); });
const kindOf = card => String(card).split('.')[0];
const dinfo = card => (CARDS ? CARDS.districts[kindOf(card)] : { color: 'unique', cost: 0 });
const dName = card => t('d.' + kindOf(card));
const cName = c => t('char.' + c);
const rankOf = c => (CARDS ? CARDS.characters[c].rank : 0);
const charColor = c => (CARDS && CARDS.characters[c].color) || null;

// a district card; size 'sm' (in a city), 'md' (in the hand) or 'lg' (up close)
function districtHtml(card, { size = 'sm', cls = '', attrs = '', cost } = {}) {
  const d = dinfo(card);
  const kind = kindOf(card);
  const price = cost !== undefined && cost !== d.cost ? `<s>${d.cost}</s>${cost}` : d.cost;
  const text = d.color === 'unique' && size !== 'sm' ? `<span class="dc-text">${esc(t('d.' + kind + '.text'))}</span>` : '';
  return `<div class="dcard ${size} c-${d.color} ${cls}" data-kind="${kind}" ${attrs} title="${esc(dName(card))}">
    <span class="dc-cost">${d.unbuildable ? '✕' : price}</span>
    <span class="dc-ico">${ICONS[d.color]}</span>
    <span class="dc-name">${esc(dName(card))}</span>${text}
  </div>`;
}

// a character card; size 'tile' (the track) or 'full' (choosing, rules)
function charHtml(c, { size = 'full', cls = '', attrs = '', extra = '' } = {}) {
  const color = charColor(c);
  return `<div class="ccard ${size} ch-${c} ${cls}" ${attrs}>
    <span class="cc-rank">${rankOf(c)}</span>
    <span class="cc-name">${esc(cName(c))}</span>
    ${color ? `<span class="cc-color c-${color}">${ICONS[color]}</span>` : ''}
    ${size === 'full' ? `<span class="cc-text">${esc(t('char.' + c + '.text'))}</span>` : ''}
    ${extra}
  </div>`;
}

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
  targeting = null;
  history.replaceState(null, '', '/citadels/');
  closeAll();
  render();
}

// ---------- home ----------
if (urlRoom) $('#joinCode').value = urlRoom;
$('#createBtn').onclick = () => send('create');
$('#joinBtn').onclick = () => send('join', { code: $('#joinCode').value });
$('#watchBtn').onclick = () => send('join', { code: $('#joinCode').value, spectate: true });
$('#joinCode').addEventListener('keydown', e => { if (e.key === 'Enter') $('#joinBtn').click(); });
$('#homeBtn').onclick = () => { homeView = true; render(); };
$('#leaveBtn').onclick = async () => {
  if (state && state.phase === 'playing' && !state.me.spectator && !(await askConfirm({ title: t('ui.leaveRoom'), text: t('cit.confirmLeave'), danger: true }))) return;
  await send('leave');
  leftRoom();
};
$('#topRoom').onclick = async () => {
  try { await navigator.clipboard.writeText(`${location.origin}/citadels/?room=${state.code}`); toast(t('toast.linkCopied'), 'info'); } catch {}
};
$('#copyLink').onclick = () => $('#topRoom').click();

// ---------- helpers on the game state ----------
const isHost = () => !!(state && state.me && state.hostId === state.me.id);
const member = id => state && [...state.players, ...state.spectators].find(p => p.id === id);
const nameOf = id => (member(id) || {}).name || '?';
const G = () => state.game;
const gp = id => G().players[id];
const myId = () => state && state.me && state.me.id;
const iPlay = () => !!(state && state.game && state.me && state.game.players[state.me.id]);
const myTurn = () => !!(iPlay() && G().stage === 'turns' && G().turn && G().turn.pid === myId());
const has = (pid, kind) => gp(pid).city.some(c => kindOf(c) === kind);
const now = () => Date.now() + clockOffset;
const secondsLeft = endsAt => (endsAt ? Math.max(0, Math.ceil((endsAt - now()) / 1000)) : null);
const mini = (pid, cls = '') => {
  const p = member(pid) || { name: '?' };
  return `<span class="mini ${cls}">${avatarCore(p.name, p.avatar)}<b>${esc(p.name)}</b></span>`;
};
// log parameters that are characters or districts are shown by name
function logText(e) {
  const p = { ...e.params };
  if (p.char) p.char = cName(p.char);
  if (p.chars) p.chars = p.chars.map(cName).join(', ');
  for (const k of ['card', 'mine', 'theirs', 'necropolis']) if (p[k]) p[k] = t('d.' + p[k]);
  return t(e.key, p);
}

// ---------- render ----------
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
  $('#topRound').textContent = inRoom && state.game ? roundChip() : '';
  if (inRoom && urlRoom !== state.code) { urlRoom = state.code; history.replaceState(null, '', `/citadels/?room=${state.code}`); }
  renderReactBar();
  updateTurnAlert(citNeed());
  Voice.update(!!(state && state.me && state.features && state.features.voice && state.settings.voice !== false));
  if (!inRoom) return show('home');
  if (state.phase === 'lobby') { show('lobby'); return renderLobby(); }
  if (!CARDS) return;
  show('game');
  renderGame();
}

function roundChip() {
  const g = G();
  const parts = [t('cit.round', { n: g.round })];
  if (g.stage === 'select') parts.push(t('cit.stage.select'));
  else if (g.turn) parts.push(cName(g.turn.char));
  if (g.lastRound && state.phase === 'playing') parts.push(t('cit.lastRound'));
  return parts.join(' · ');
}

// ---------- lobby ----------
$('#startBtn').onclick = () => send('start');
$('#readyBtn').onclick = () => {
  const mine = state.players.find(p => p.id === state.me.id);
  send('ready', { ready: !(mine && mine.ready) });
};
$('#watchToggle').onclick = () => send('watch', { on: !state.me.spectator });
$('#resetRules').onclick = () => send('settings', state.defaults);

function renderLobby() {
  $('#lobbyCount').textContent = `${state.players.length}/${state.maxPlayers}`;
  $('#lobbyPlayers').innerHTML = state.players.map(p => `
    <li class="${p.connected ? '' : 'offline'} ${p.ready ? 'is-ready' : ''}" data-pid="${p.id}">
      <span class="avatar-wrap clickable" data-open-player="${p.userId || ''}">${avatar(p.name, p.avatar, p.cos)}${p.ready ? '<span class="voted ready-mark">✓</span>' : ''}</span>
      <span class="pname"><b class="${nameCls(p.cos)}">${esc(p.name)}</b>${titleTag(p.title)}${statusPill(p.score)}${p.id === state.hostId ? `<span class="tag host">${esc(t('tag.host'))}</span>` : ''}</span>
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
  $('#spectatorBox').classList.toggle('hidden', !state.spectators.length);
  $('#spectatorList').innerHTML = state.spectators.map(w => `<span class="spectator">${avatar(w.name, w.avatar, w.cos)}<b>${esc(w.name)}</b></span>`).join('');
  $('#shareCode').innerHTML = esc(t('ui.shareCode', { code: '\u0000' })).replace('\u0000', `<strong class="code">${esc(state.code)}</strong>`);
  const qr = `/qr.svg?room=${state.code}&game=cit`;
  if ($('#inviteQr').getAttribute('src') !== qr) $('#inviteQr').src = qr;
  renderSettings();
  $('#resetRules').classList.toggle('hidden', !isHost());
  $('#startBtn').classList.toggle('hidden', !isHost());
  $('#waitHost').classList.toggle('hidden', isHost());
  const n = state.players.length;
  $('#startBtn').disabled = n < state.minPlayers;
  $('#startBtn').textContent = n < state.minPlayers ? t('cit.needPlayers', { n: state.minPlayers }) : `${t('cit.start')} · ${t('ui.readyCount', { n: readyN, total: n })}`;
}

// The settings panel is rebuilt only when something in it changed, so typing isn't interrupted.
let settingsKey = '';
const NUM_GROUPS = [
  ['cit.set.group.game', ['districtsToEnd', 'startGold', 'startCards', 'takeGold', 'drawCards']],
  ['cit.set.group.score', ['firstBonus', 'completeBonus', 'colorsBonus']],
  ['cit.set.group.time', ['turnSeconds', 'pickSeconds']],
];
function renderSettings() {
  if (!CARDS) return;
  const s = state.settings;
  const host = isHost();
  const key = JSON.stringify([s, host, lang, state.players.length, state.features]);
  if (key === settingsKey || $('#settingsBox').contains(document.activeElement) && document.activeElement.tagName === 'INPUT' && document.activeElement.type === 'number') return;
  settingsKey = key;
  const d = state.defaults;
  const changed = k => JSON.stringify(s[k]) !== JSON.stringify(d[k]);
  const n = state.players.length;
  // characters: a tile per rank; ranks with a choice are a switch
  const ranks = Object.entries(CARDS.rankChoices).map(([rank, choices]) => {
    const cur = choices.length > 1 ? s.chars[rank] : choices[0];
    const off = cur === 'none' || (Number(rank) === 9 && n > 0 && n < 5);
    const body = choices.length > 1 && host
      ? `<div class="seg">${choices.map(c => `<button class="${c === cur ? 'on' : ''}" data-char="${rank}:${c}">${esc(c === 'none' ? t('cit.set.noNine') : cName(c))}</button>`).join('')}</div>`
      : `<b>${esc(cur === 'none' ? t('cit.set.noNine') : cName(cur))}</b>`;
    return `<div class="rank-row ${off ? 'off' : ''} ${choices.length > 1 && s.chars[rank] !== d.chars[rank] ? 'changed' : ''}">
      <span class="rank-num">${rank}</span>${body}
      ${Number(rank) === 9 && n > 0 && n < 5 && cur !== 'none' ? `<span class="muted small-text">${esc(t('cit.set.nineNeeds5'))}</span>` : ''}
    </div>`;
  }).join('');
  const nums = NUM_GROUPS.map(([title, keys]) => `
    <h3>${esc(t(title))}</h3>
    <div class="num-grid">${keys.map(k => `<label class="field ${changed(k) ? 'changed' : ''}"><span>${esc(t('cit.set.' + k))}</span>
      ${host ? `<input type="number" data-num="${k}" value="${s[k]}" min="0" max="600">` : `<b class="num-ro">${k.endsWith('Seconds') && !s[k] ? '∞' : s[k]}</b>`}</label>`).join('')}</div>`).join('');
  const uniqueKinds = Object.keys(CARDS.districts).filter(k => CARDS.districts[k].color === 'unique');
  const uniques = `
    <h3>${esc(t('cit.set.group.uniques'))}</h3>
    <div class="row uniq-head">
      <label class="field inline ${changed('uniqueCount') ? 'changed' : ''}"><span>${esc(t('cit.set.uniqueCount'))}</span>
        ${host ? `<input type="number" data-num="uniqueCount" value="${s.uniqueCount}" min="0" max="${uniqueKinds.length}">` : `<b class="num-ro">${s.uniqueCount}</b>`}</label>
      <span class="muted small-text">${esc(t('cit.set.uniquePool', { n: s.uniques.length, max: uniqueKinds.length }))}</span>
      ${host ? `<button class="ghost small" data-uniq-all="1">${esc(t('cit.set.all'))}</button><button class="ghost small" data-uniq-all="0">${esc(t('cit.set.none'))}</button>` : ''}
    </div>
    <div class="uniq-grid">${uniqueKinds.map(k => `<button class="uniq ${s.uniques.includes(k) ? 'on' : ''}" data-uniq="${k}" ${host ? '' : 'disabled'} title="${esc(t('d.' + k + '.text'))}">
      <span class="uniq-cost">${CARDS.districts[k].cost || '✕'}</span><span class="uniq-name">${esc(t('d.' + k))}</span><span class="uniq-text">${esc(t('d.' + k + '.text'))}</span></button>`).join('')}</div>`;
  const voiceOk = !!(state.features && state.features.voice);
  const toggles = `
    <div class="checks settings-rest">
      <label class="check ${changed('kingFaceUp') ? 'changed' : ''}"><input type="checkbox" class="switch" data-bool="kingFaceUp" ${s.kingFaceUp ? 'checked' : ''} ${host ? '' : 'disabled'}> <span>${esc(t('cit.set.kingFaceUp'))}</span></label>
      ${voiceOk ? `<label class="check"><input type="checkbox" class="switch" data-bool="voice" ${s.voice !== false ? 'checked' : ''} ${host ? '' : 'disabled'}> <span>${esc(t('ui.voice'))}</span></label>` : ''}
    </div>`;
  $('#settingsBox').innerHTML = `
    <h3>${esc(t('cit.set.group.chars'))}</h3>
    <div class="rank-list">${ranks}</div>
    <p class="muted small-text set-hint">${esc(t('cit.set.charsHint'))}</p>
    ${nums}${toggles}${uniques}`;
  if (!host) return;
  for (const b of $$('#settingsBox [data-char]')) b.onclick = () => { const [rank, c] = b.dataset.char.split(':'); send('settings', { chars: { [rank]: c } }); };
  for (const inp of $$('#settingsBox [data-num]')) inp.onchange = () => send('settings', { [inp.dataset.num]: parseInt(inp.value, 10) || 0 }).then(res => { if (!res.ok) { settingsKey = ''; renderSettings(); } });
  for (const inp of $$('#settingsBox [data-bool]')) inp.onchange = () => send('settings', { [inp.dataset.bool]: inp.checked });
  for (const b of $$('#settingsBox [data-uniq]')) b.onclick = () => {
    const k = b.dataset.uniq;
    send('settings', { uniques: s.uniques.includes(k) ? s.uniques.filter(x => x !== k) : [...s.uniques, k] });
  };
  for (const b of $$('#settingsBox [data-uniq-all]')) b.onclick = () => send('settings', { uniques: b.dataset.uniqAll === '1' ? uniqueKinds : [] });
}

// ---------- the game ----------
function renderGame() {
  const g = G();
  if (targeting && !(myTurn() && G().turn.stage === 'main')) targeting = null;
  document.body.classList.toggle('targeting', !!targeting);
  renderTrack();
  renderCities();
  renderAction();
  renderHand();
  $('#log').innerHTML = g.log.slice().reverse().map(e => `<li>${esc(logText(e))}</li>`).join('');
  $('#restartBtn').classList.toggle('hidden', !(isHost() && state.phase === 'ended'));
  syncPickModal();
}

function renderTrack() {
  const g = G();
  const mineChars = iPlay() ? g.me.chars : [];
  $('#charTrack').innerHTML = g.chars.map(c => {
    const rank = rankOf(c);
    const out = g.sel && g.sel.faceUp.includes(c);
    const owner = g.order.find(p => gp(p).chars.includes(c));
    const cur = g.stage === 'turns' && g.turn && g.turn.char === c;
    const done = g.stage === 'turns' && rank < g.called || state.phase === 'ended';
    const marks = [
      g.killed === c ? `<span class="mark m-kill">${esc(t('cit.mark.killed'))}</span>` : '',
      g.robbed === c ? `<span class="mark m-rob">${esc(t('cit.mark.robbed'))}</span>` : '',
      g.bewitched === c ? `<span class="mark m-witch">${esc(t('cit.mark.bewitched'))}</span>` : '',
    ].join('');
    const who = out ? `<span class="cc-who muted">${esc(t('cit.faceUp'))}</span>`
      : owner ? `<span class="cc-who">${avatarCore(nameOf(owner), (member(owner) || {}).avatar)}</span>`
      : done && g.stage === 'turns' ? `<span class="cc-who muted">—</span>` : '';
    return charHtml(c, {
      size: 'tile',
      cls: [out && 'out', cur && 'now', done && !cur && 'done', mineChars.includes(c) && 'mine'].filter(Boolean).join(' '),
      attrs: `data-char-info="${c}"`,
      extra: `${marks}${who}`,
    });
  }).join('');
  for (const el of $$('#charTrack [data-char-info]')) el.onclick = () => openCharInfo(el.dataset.charInfo);
}

function renderCities() {
  const g = G();
  const me = myId();
  // me first, then the others in seat order after me
  const start = Math.max(0, g.order.indexOf(me));
  const seats = g.order.map((_, i) => g.order[(start + i) % g.order.length]);
  $('#cities').innerHTML = seats.map(pid => {
    const p = gp(pid);
    const m = member(pid) || { name: '?' };
    const acting = g.stage === 'turns' && g.turn && g.turn.pid === pid;
    const picking = g.stage === 'select' && g.sel.seq[g.sel.step] === pid;
    const cards = p.city.map(card => {
      let cls = '', attrs = `data-city="${pid}" data-card="${card}"`;
      if (targeting) {
        const ok = targeting.can(pid, card);
        cls = ok ? 'can-target' : 'no-target';
        if (ok && ok.cost !== undefined) attrs += ` data-tcost="${ok.cost}"`;
      }
      return districtHtml(card, { cls: `${cls} ${freshCards.has(card) ? 'fresh' : ''}`, attrs });
    }).join('');
    const charTags = p.chars.map(c => `<span class="tag ch-tag ch-${c} ${g.killed === c ? 'dead' : ''}">${rankOf(c)} · ${esc(cName(c))}</span>`).join('');
    return `<div class="city ${pid === me ? 'me' : ''} ${acting ? 'acting' : ''} ${picking ? 'picking' : ''} ${p.complete ? 'complete' : ''}" data-pid="${pid}">
      <div class="city-head">
        <span class="avatar-wrap clickable" data-open-player="${m.userId || ''}">${avatar(m.name, m.avatar, m.cos)}</span>
        <span class="city-id">
          <span class="city-name"><b class="${nameCls(m.cos)}">${esc(m.name)}</b>${titleTag(m.title)}
            ${g.crown === pid ? `<span class="crown" title="${esc(t('cit.crown'))}">${ICONS.crown}</span>` : ''}
            ${m.left ? `<span class="tag">${esc(t('cit.tag.left'))}</span>` : !m.connected ? `<span class="tag">${esc(t('cit.tag.offline'))}</span>` : ''}
            ${g.firstComplete === pid ? `<span class="tag first">${esc(t('cit.tag.first'))}</span>` : p.complete ? `<span class="tag done">${esc(t('cit.tag.complete'))}</span>` : ''}
          </span>
          <span class="city-chars">${charTags}${acting ? `<span class="tag now">${esc(t('cit.tag.turn'))}</span>` : ''}${picking ? `<span class="tag now">${esc(t('cit.tag.picking'))}</span>` : ''}</span>
        </span>
        <span class="city-stats">
          <span class="stat-chip gold" title="${esc(t('cit.gold'))}">${ICONS.coin}<b>${p.gold}</b></span>
          <span class="stat-chip" title="${esc(t('cit.handCount'))}">${ICONS.cards}<b>${p.hand}</b></span>
          <span class="stat-chip size" title="${esc(t('cit.citySize'))}"><b>${p.size}</b>/${state.settings.districtsToEnd}</span>
        </span>
      </div>
      <div class="city-row">${cards || `<span class="muted small-text empty-city">${esc(t('cit.emptyCity'))}</span>`}${p.museum ? `<span class="museum-chip">${esc(t('cit.museumCards', { n: p.museum }))}</span>` : ''}</div>
    </div>`;
  }).join('');
  for (const el of $$('#cities [data-open-player]')) if (el.dataset.openPlayer) el.onclick = () => openPlayer(el.dataset.openPlayer);
  for (const el of $$('#cities [data-card]')) {
    el.onclick = () => {
      const pid = el.dataset.city, card = el.dataset.card;
      if (targeting) {
        if (!targeting.can(pid, card)) return;
        const tg = targeting;
        targeting = null;
        return tg.pick(pid, card);
      }
      openCard(card, { owner: pid });
    };
  }
}

// ---------- what I can do now ----------
function renderAction() {
  const g = G();
  const panel = $('#actionPanel');
  const timer = endsAt => (endsAt ? `<span class="turn-timer" data-ends="${endsAt}">${ICONS.clock}<b>${secondsLeft(endsAt)}</b></span>` : '');
  if (state.phase === 'ended') {
    const top = g.scores[0];
    panel.innerHTML = `<p class="eyebrow">${esc(t('cit.gameOver'))}</p>
      <div class="big">${esc(t('cit.winnerIs', { name: nameOf(g.winner) }))}</div>
      <p class="muted">${esc(t('cit.points', { n: top.total }))}</p>
      <div class="row"><button class="primary" data-act="results">${esc(t('cit.showResults'))}</button></div>`;
    return bindActions();
  }
  if (g.stage === 'select') {
    const picker = g.sel.seq[g.sel.step];
    const mine = picker === myId();
    panel.innerHTML = `<div class="ap-head"><p class="eyebrow">${esc(t('cit.stage.select'))}</p>${timer(g.sel.endsAt)}</div>
      <div class="big">${mine ? esc(t('cit.pick.yours')) : esc(t('cit.pick.waiting', { name: nameOf(picker) }))}</div>
      <div class="pick-progress">${g.sel.seq.map((p, i) => `<span class="${i < g.sel.step ? 'done' : i === g.sel.step ? 'now' : ''}" title="${esc(nameOf(p))}">${avatarCore(nameOf(p), (member(p) || {}).avatar)}</span>`).join('')}</div>
      ${g.sel.faceUp.length ? `<p class="muted small-text">${esc(t('cit.faceUpList', { chars: g.sel.faceUp.map(cName).join(', ') }))}</p>` : ''}
      ${iPlay() && g.me.chars.length && !mine ? `<p class="small-text">${esc(t('cit.youPicked', { chars: g.me.chars.map(cName).join(', ') }))}</p>` : ''}
      ${mine ? `<div class="row"><button class="primary" data-act="openPick">${esc(t('cit.pick.open'))}</button></div>` : ''}`;
    return bindActions();
  }
  const tr = g.turn;
  if (!tr) { panel.innerHTML = ''; return; }
  const head = `<div class="ap-head"><p class="eyebrow">${esc(t('cit.turnOf', { char: cName(tr.char) }))}${tr.witch ? ` · ${esc(t('cit.asWitch'))}` : ''}</p>${timer(tr.endsAt)}</div>`;
  if (!myTurn()) {
    panel.innerHTML = `${head}<div class="big">${esc(nameOf(tr.pid))}</div>
      <p class="muted small-text">${esc(t('cit.stageOther.' + tr.stage, { name: nameOf(tr.pid) }))}</p>
      ${charHtml(tr.char, { size: 'full', cls: 'inline' })}`;
    return bindActions();
  }
  const me = gp(myId());
  const s = state.settings;
  if (tr.stage === 'gather') {
    const gold = s.takeGold + (has(myId(), 'goldMine') ? 1 : 0);
    const draw = s.drawCards + (has(myId(), 'observatory') ? 1 : 0);
    panel.innerHTML = `${head}<div class="big">${esc(t(tr.bewitchedOnly ? 'cit.gather.bewitched' : 'cit.gather.title'))}</div>
      <div class="gather">
        <button class="gather-btn" data-act="gold">${ICONS.coin}<b>${esc(t('cit.gather.gold', { n: gold }))}</b><span>${esc(t('cit.gather.goldHint'))}</span></button>
        <button class="gather-btn" data-act="cards" ${g.deck ? '' : 'disabled'}>${ICONS.cards}<b>${esc(t(has(myId(), 'library') ? 'cit.gather.cardsAll' : 'cit.gather.cards', { n: draw }))}</b><span>${esc(t('cit.gather.cardsHint', { n: g.deck }))}</span></button>
      </div>`;
    return bindActions();
  }
  if (tr.stage === 'draw') {
    panel.innerHTML = `${head}<div class="big">${esc(t('cit.keep.title'))}</div>
      <div class="drawn">${tr.drawn.map(c => `<button class="card-btn" data-keep="${c}">${districtHtml(c, { size: 'md' })}</button>`).join('')}</div>
      <p class="muted small-text">${esc(t('cit.keep.hint'))}</p>`;
    for (const b of panel.querySelectorAll('[data-keep]')) b.onclick = () => send('keep', { card: b.dataset.keep });
    return;
  }
  // the main part of the turn
  const actions = [];
  const used = tr.used || {};
  const abilityKey = { assassin: 'kill', witch: 'bewitch', thief: 'rob', magician: 'magic', abbot: 'tithe', diplomat: 'exchange', warlord: 'destroy' }[tr.char];
  if (abilityKey) {
    if (tr.char === 'magician') {
      actions.push(`<button data-act="swapHands" ${used.ability ? 'disabled' : ''}>${esc(t('cit.act.swapHands'))}</button>`);
      actions.push(`<button data-act="redraw" ${used.ability || !g.me.hand.length ? 'disabled' : ''}>${esc(t('cit.act.redraw'))}</button>`);
    } else {
      const richest = Math.max(...g.order.map(p => gp(p).gold));
      const disabled = used.ability || (tr.char === 'abbot' && me.gold >= richest);
      actions.push(`<button data-act="${abilityKey}" ${disabled ? 'disabled' : ''}>${esc(t('cit.act.' + abilityKey))}</button>`);
    }
  }
  if (charColor(tr.char) && !(tr.char === 'witch' && !tr.witch)) {
    const n = g.me.income;
    actions.push(`<button data-act="income" class="income-btn c-${charColor(tr.char)}" ${used.income || !n ? 'disabled' : ''}>${ICONS[charColor(tr.char)]} ${esc(used.income ? t('cit.act.incomeDone') : t('cit.act.income', { n }))}</button>`);
  }
  const uses = { laboratory: me.hand > 0, smithy: me.gold >= 2 && g.deck > 0, museum: me.hand > 0, armory: true };
  for (const [kind, ok] of Object.entries(uses)) {
    if (has(myId(), kind)) actions.push(`<button data-act="use:${kind}" class="c-unique" ${used[kind] || !ok ? 'disabled' : ''}>${ICONS.unique} ${esc(t('cit.use.' + kind))}</button>`);
  }
  const limit = tr.limit;
  const buildLine = limit === 0 ? t('cit.build.none') : t('cit.build.left', { n: Math.max(0, limit - tr.built), total: limit });
  panel.innerHTML = `${head}
    ${targeting ? `<div class="targeting-bar"><b>${esc(targeting.title)}</b><button class="ghost small" data-act="cancelTarget">${esc(t('ui.cancel'))}</button></div>` : ''}
    <div class="big">${esc(t(tr.char === 'witch' && !tr.witch ? 'cit.main.witch' : 'cit.main.title'))}</div>
    <p class="muted small-text">${esc(buildLine)}</p>
    <div class="act-grid">${actions.join('')}</div>
    <button class="primary big-btn" data-act="endTurn">${esc(t('cit.act.endTurn'))}</button>
    ${charColor(tr.char) && !used.income && g.me.income ? `<p class="muted small-text">${esc(t('cit.incomeAuto'))}</p>` : ''}`;
  bindActions();
}

function bindActions() {
  for (const b of $$('#actionPanel [data-act]')) b.onclick = () => doAction(b.dataset.act);
}

function doAction(act) {
  const g = G();
  const tr = g.turn;
  const me = myId();
  // the characters a named ability may target
  const nameable = (extra = () => true) => g.chars.filter(c => rankOf(c) !== 1 && !g.sel.faceUp.includes(c) && extra(c));
  const pickChar = (title, chars, then) => openChooser({
    title,
    items: chars.map(c => ({ value: c, html: charHtml(c, { size: 'full', cls: 'choice' }) })),
    onPick: then,
  });
  switch (act) {
    case 'results': return openResults();
    case 'openPick': pickDismissed = false; return syncPickModal(true);
    case 'gold': return send('gather', { choice: 'gold' });
    case 'cards': return send('gather', { choice: 'cards' });
    case 'endTurn': targeting = null; return send('endTurn');
    case 'cancelTarget': targeting = null; return render();
    case 'kill': return pickChar(t('cit.act.kill'), nameable(), c => send('ability', { target: c }));
    case 'bewitch': return pickChar(t('cit.act.bewitch'), nameable(), c => send('ability', { target: c }));
    case 'rob': return pickChar(t('cit.act.rob'), nameable(c => rankOf(c) > 2 && c !== g.killed && c !== g.bewitched), c => send('ability', { target: c }));
    case 'swapHands': return openChooser({
      title: t('cit.act.swapHands'),
      items: g.order.filter(p => p !== me).map(p => ({ value: p, html: `<div class="player-choice">${mini(p)}<span class="muted small-text">${esc(t('cit.cardsInHand', { n: gp(p).hand }))}</span></div>` })),
      onPick: p => send('ability', { mode: 'swap', player: p }),
    });
    case 'redraw': return openChooser({
      title: t('cit.act.redraw'), hint: t('cit.redrawHint'), multi: true, confirm: t('cit.redrawOk'),
      items: g.me.hand.map(c => ({ value: c, html: districtHtml(c, { size: 'md' }) })),
      onPick: cards => send('ability', { mode: 'redraw', cards }),
    });
    case 'tithe': {
      const max = Math.max(...g.order.map(p => gp(p).gold));
      const richest = g.order.filter(p => gp(p).gold === max);
      if (richest.length === 1) return send('ability', { from: richest[0] });
      return openChooser({
        title: t('cit.act.tithe'),
        items: richest.map(p => ({ value: p, html: `<div class="player-choice">${mini(p)}<span class="muted small-text">${esc(t('cit.goldN', { n: gp(p).gold }))}</span></div>` })),
        onPick: p => send('ability', { from: p }),
      });
    }
    case 'income': {
      const n = g.me.income;
      if (tr.char !== 'abbot') return send('income');
      return openChooser({
        title: t('cit.act.income', { n }), hint: t('cit.abbotSplit'),
        items: Array.from({ length: n + 1 }, (_, i) => n - i).map(gold => ({ value: gold, html: `<div class="split"><b>${ICONS.coin} ${gold}</b><b>${ICONS.cards} ${n - gold}</b></div>` })),
        onPick: gold => send('income', { gold }),
      });
    }
    case 'destroy': return startTargeting(t('cit.target.destroy'), (pid, card) => {
      const cost = rank8Cost(pid, card, Math.max(0, dinfo(card).cost - 1));
      return cost !== null && cost <= gp(me).gold ? { cost } : null;
    }, (pid, card) => send('ability', { owner: pid, card }));
    case 'exchange': return startTargeting(t('cit.target.mine'), (pid, card) => (pid === me && kindOf(card) !== 'keep' ? {} : null), (_, mine) => {
      startTargeting(t('cit.target.theirs', { card: dName(mine) }), (pid, card) => {
        if (pid === me || swapDuplicates(me, mine, pid, card)) return null;
        const cost = rank8Cost(pid, card, Math.max(0, dinfo(card).cost - dinfo(mine).cost));
        return cost !== null && cost <= gp(me).gold ? { cost } : null;
      }, (pid, card) => send('ability', { mine, owner: pid, theirs: card }));
    });
    case 'use:laboratory': return openChooser({
      title: t('cit.use.laboratory'), items: g.me.hand.map(c => ({ value: c, html: districtHtml(c, { size: 'md' }) })),
      onPick: card => send('useDistrict', { kind: 'laboratory', card }),
    });
    case 'use:museum': return openChooser({
      title: t('cit.use.museum'), items: g.me.hand.map(c => ({ value: c, html: districtHtml(c, { size: 'md' }) })),
      onPick: card => send('useDistrict', { kind: 'museum', card }),
    });
    case 'use:smithy': return send('useDistrict', { kind: 'smithy' });
    case 'use:armory': return startTargeting(t('cit.target.armory'), (_, card) => (kindOf(card) !== 'armory' ? {} : null), (pid, card) => send('useDistrict', { kind: 'armory', owner: pid, target: card }));
    default:
  }
}

// What a rank-8 ability costs on this district (with the Great Wall), or null if it's protected.
function rank8Cost(pid, card, base) {
  const g = G();
  if (kindOf(card) === 'keep' || gp(pid).complete) return null;
  if (gp(pid).chars.includes('bishop') && g.killed !== 'bishop') return null;
  return base + (has(pid, 'greatWall') && kindOf(card) !== 'greatWall' ? 1 : 0);
}

// would swapping these two districts leave a city with two of the same name?
function swapDuplicates(me, mine, other, theirs) {
  const clash = (pid, gone, coming) => !has(pid, 'quarry') && gp(pid).city.some(c => c !== gone && kindOf(c) === kindOf(coming));
  return clash(me, mine, theirs) || clash(other, theirs, mine);
}

function startTargeting(title, can, pick) {
  targeting = { title, can, pick };
  render();
  toast(title, 'info');
}

// ---------- my hand ----------
function renderHand() {
  const g = G();
  $('#handCard').classList.toggle('hidden', !iPlay());
  if (!iPlay()) return;
  const tr = g.turn;
  const canBuild = myTurn() && tr.stage === 'main' && tr.limit > 0;
  const gold = gp(myId()).gold;
  $('#handNote').textContent = g.me.museum.length ? t('cit.museumCards', { n: g.me.museum.length }) : '';
  $('#hand').innerHTML = g.me.hand.map(c => {
    const cost = g.me.buildCosts[c];
    const problem = g.me.buildProblems[c];
    const ok = canBuild && !problem && (cost <= gold || buildAlternatives(c).length) && (tr.built < tr.limit || kindOf(c) === 'stables');
    return `<button class="card-btn ${ok ? 'buildable' : ''} ${freshCards.has(c) ? 'fresh' : ''}" data-hand="${c}">${districtHtml(c, { size: 'md', cost })}</button>`;
  }).join('') || `<p class="muted small-text">${esc(t('cit.emptyHand'))}</p>`;
  for (const b of $$('#hand [data-hand]')) b.onclick = () => openCard(b.dataset.hand, { hand: true });
}

// other ways to pay for this card: the Framework, the Necropolis, the Thieves' Den
function buildAlternatives(card) {
  const me = myId();
  const out = [];
  const kind = kindOf(card);
  if (has(me, 'framework') && kind !== 'framework') out.push('framework');
  if (kind === 'necropolis' && gp(me).city.length) out.push('necropolis');
  if (kind === 'thievesDen' && G().me.hand.length > 1) out.push('den');
  return out;
}

// ---------- one card up close ----------
function openCard(card, { hand = false, owner = null } = {}) {
  const g = G();
  const d = dinfo(card);
  const cost = hand ? g.me.buildCosts[card] : undefined;
  $('#cardZoom').innerHTML = districtHtml(card, { size: 'lg', cost });
  const acts = [];
  const tr = g.turn;
  if (hand && myTurn() && tr.stage === 'main') {
    const problem = g.me.buildProblems[card];
    const limitLeft = tr.built < tr.limit || kindOf(card) === 'stables';
    const gold = gp(myId()).gold;
    if (problem) acts.push(`<p class="muted small-text">${esc(t(problem))}</p>`);
    else if (!limitLeft) acts.push(`<p class="muted small-text">${esc(t(tr.limit ? 'err.cit.buildLimit' : 'err.cit.noBuildNow'))}</p>`);
    else {
      acts.push(`<button class="primary" data-build="gold" ${cost > gold ? 'disabled' : ''}>${esc(t('cit.build.for', { n: cost }))}</button>`);
      for (const alt of buildAlternatives(card)) acts.push(`<button data-build="${alt}">${esc(t('cit.build.' + alt))}</button>`);
      if (cost > gold && !buildAlternatives(card).length) acts.push(`<p class="muted small-text">${esc(t('cit.build.short', { n: cost - gold }))}</p>`);
    }
  }
  if (owner) acts.push(`<p class="muted small-text">${esc(t('cit.cardOwner', { name: nameOf(owner) }))}</p>`);
  if (d.color !== 'unique') acts.push(`<p class="muted small-text">${esc(t('cit.colorNote', { color: t('color.' + d.color) }))}</p>`);
  acts.push(`<button class="ghost" data-close-card>${esc(t('ui.close'))}</button>`);
  $('#cardActions').innerHTML = acts.join('');
  $('#cardModal').classList.remove('hidden');
  $('#cardActions [data-close-card]').onclick = () => closeOverlay('cardModal');
  for (const b of $$('#cardActions [data-build]')) {
    b.onclick = () => {
      closeOverlay('cardModal');
      const how = b.dataset.build;
      if (how === 'gold') return send('build', { card });
      if (how === 'framework') return send('build', { card, framework: true });
      if (how === 'necropolis') return startTargeting(t('cit.target.necropolis'), pid => (pid === myId() ? {} : null), (_, victim) => send('build', { card, necropolis: victim }));
      // Thieves' Den: pay part of it with cards
      openChooser({
        title: t('cit.build.den'), hint: t('cit.denHint', { n: cost }), multi: true, confirm: t('cit.denOk'),
        items: g.me.hand.filter(c => c !== card).map(c => ({ value: c, html: districtHtml(c, { size: 'md' }) })),
        onPick: cards => send('build', { card, cards }),
      });
    };
  }
}
$('#cardModal').addEventListener('pointerdown', e => { if (e.target.id === 'cardModal') closeOverlay('cardModal'); });

function openCharInfo(c) {
  openChooser({ title: cName(c), items: [{ value: c, html: charHtml(c, { size: 'full' }), static: true }] });
}

// ---------- chooser: one (or several) of a list ----------
function openChooser({ title, hint = '', items, multi = false, confirm = '', onPick }) {
  $('#chooserTitle').textContent = title;
  $('#chooserHint').textContent = hint;
  $('#chooserBody').innerHTML = items.map((it, i) => `<button class="choose-item" data-i="${i}" ${it.static ? 'disabled' : ''}>${it.html}</button>`).join('');
  $('#chooserFoot').classList.toggle('hidden', !multi);
  $('#chooserOk').textContent = confirm;
  const picked = new Set();
  for (const b of $$('#chooserBody [data-i]')) {
    b.onclick = () => {
      const v = items[b.dataset.i].value;
      if (!multi) { closeOverlay('chooser'); return onPick && onPick(v); }
      if (picked.has(v)) picked.delete(v); else picked.add(v);
      b.classList.toggle('on', picked.has(v));
      $('#chooserOk').disabled = !picked.size;
    };
  }
  $('#chooserOk').disabled = true;
  $('#chooserOk').onclick = () => { closeOverlay('chooser'); onPick([...picked]); };
  $('#chooser').classList.remove('hidden');
}
$('#chooserClose').onclick = () => closeOverlay('chooser');
$('#chooser').addEventListener('pointerdown', e => { if (e.target.id === 'chooser') closeOverlay('chooser'); });

// ---------- choosing a character ----------
let pickDismissed = false;
let pickShownFor = null;
function syncPickModal(force) {
  const g = state && state.game;
  const options = g && state.phase === 'playing' && g.stage === 'select' && g.sel.options;
  const key = options ? `${g.round}:${g.sel.step}` : null;
  if (!options) { pickShownFor = null; return closeOverlay('pickModal'); }
  if (key !== pickShownFor) { pickShownFor = key; pickDismissed = false; SFX.pick(); }
  if (pickDismissed && !force) return;
  const before = g.sel.step;
  $('#pickBody').innerHTML = `
    <div class="pick-grid">${options.slice().sort((x, y) => rankOf(x) - rankOf(y)).map(c => `<button class="choose-item" data-pick="${c}">${charHtml(c, { size: 'full' })}</button>`).join('')}</div>
    <div class="pick-info muted small-text">
      ${g.sel.faceUp.length ? `<p>${esc(t('cit.faceUpList', { chars: g.sel.faceUp.map(cName).join(', ') }))}</p>` : ''}
      <p>${esc(t('cit.pick.info', { before, hidden: g.sel.faceDown }))}</p>
      ${options.length > g.sel.poolSize ? `<p>${esc(t('cit.pick.lastWithHidden'))}</p>` : ''}
      ${g.me.chars.length ? `<p>${esc(t('cit.youPicked', { chars: g.me.chars.map(cName).join(', ') }))}</p>` : ''}
    </div>`;
  for (const b of $$('#pickBody [data-pick]')) b.onclick = () => send('pick', { char: b.dataset.pick });
  $('#pickModal').classList.remove('hidden');
}
$('#pickClose').onclick = () => { pickDismissed = true; closeOverlay('pickModal'); };

// ---------- results ----------
function openResults() {
  const g = state.game;
  if (!g || !g.scores) return;
  const extraLine = ex => Object.entries(ex).map(([k, v]) => `${esc(t('d.' + k))} +${v}`).join(', ');
  $('#resultsBody').innerHTML = `
    <ol class="results-list">${g.scores.map(s => {
      const m = member(s.pid) || { name: '?' };
      const p = gp(s.pid);
      return `<li class="result ${s.pid === g.winner ? 'top' : ''}">
        <span class="place">${['🥇', '🥈', '🥉'][s.place - 1] || s.place}</span>
        ${avatar(m.name, m.avatar, m.cos)}
        <span class="result-id"><b>${esc(m.name)}</b>
          <span class="muted small-text">${p.chars.map(c => esc(cName(c))).join(', ')}</span>
          <span class="breakdown small-text">
            <span>${esc(t('cit.score.districts', { n: s.districts }))}</span>
            ${s.colors ? `<span>${esc(t('cit.score.colors', { n: s.colors }))}</span>` : ''}
            ${s.complete ? `<span>${esc(t(g.firstComplete === s.pid ? 'cit.score.first' : 'cit.score.complete', { n: s.complete }))}</span>` : ''}
            ${Object.keys(s.extras).length ? `<span>${extraLine(s.extras)}</span>` : ''}
          </span>
          <span class="result-city">${p.city.map(c => districtHtml(c)).join('')}</span>
        </span>
        <span class="result-total">${s.total}</span>
      </li>`;
    }).join('')}</ol>
    <p class="muted small-text">${esc(t('cit.tieRule'))}</p>`;
  $('#results').classList.remove('hidden');
}
$('#resultsClose').onclick = () => closeOverlay('results');
$('#restartBtn').onclick = () => send('restart');

// ---------- rules: the shared rules window, on the Citadels tab ----------
$('#rulesBtn').onclick = () => openRules('cit');
$('#homeRules').onclick = () => openRules('cit');

// ---------- effects: sounds and freshly built districts ----------
const freshCards = new Set();
function fxOnState(prev, s) {
  const g = s.game;
  if (!g || !prev || !prev.game || prev.gameId !== s.gameId) return;
  const me = s.me && s.me.id;
  freshCards.clear();
  for (const pid of g.order) {
    const before = new Set(prev.game.players[pid] ? prev.game.players[pid].city : []);
    for (const c of g.players[pid].city) if (!before.has(c)) freshCards.add(c);
  }
  if (g.me && prev.game.me) for (const c of g.me.hand) if (!prev.game.me.hand.includes(c)) freshCards.add(c);
  if (freshCards.size && [...freshCards].some(c => g.order.some(p => g.players[p].city.includes(c)))) SFX.build();
  const mine = g.players[me], before = prev.game.players[me];
  if (mine && before && mine.gold > before.gold) SFX.coin();
  if (mine && before && mine.gold < before.gold && !freshCards.size) SFX.bad();
  if (s.phase === 'ended' && prev.phase !== 'ended') { SFX.win(); setTimeout(openResults, 900); }
  if (freshCards.size) setTimeout(() => { freshCards.clear(); }, 1600);
}

// the clocks tick between updates
setInterval(() => {
  for (const el of $$('[data-ends]')) {
    const left = secondsLeft(Number(el.dataset.ends));
    el.querySelector('b').textContent = left;
    el.classList.toggle('low', left <= 10);
  }
}, 500);

// ---------- turn alerts ----------
function citNeed() {
  if (!state || !state.me || state.phase !== 'playing' || !state.game || !iPlay()) return null;
  const g = state.game;
  if (g.stage === 'select' && g.sel.seq[g.sel.step] === myId()) return { key: `pick:${g.round}:${g.sel.step}`, text: t('cit.alert.pick') };
  if (myTurn()) return { key: `turn:${g.round}:${g.turn.char}:${g.turn.witch}`, text: t('cit.alert.turn', { char: cName(g.turn.char) }) };
  return null;
}

// ---------- reactions ----------
const REACTIONS = ['👍', '👎', '😂', '🤔', '😱', '🤥', '🔥', '💀', '👑', '🗡️', '💰'];
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
  const anchor = $(`#cities [data-pid="${r.from}"] .avatar-wrap`);
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

// ---------- leaderboard (Citadels stats) ----------
let boardTab = 'wins';
let boardUsers = [];
async function openBoard() {
  const res = await api('leaderboard');
  if (!res.ok) return;
  boardUsers = res.users;
  $('#boardSheet').classList.remove('hidden');
  renderBoardSheet();
}
function renderBoardSheet() {
  for (const b of $$('[data-board]')) b.classList.toggle('active', b.dataset.board === boardTab);
  const metric = {
    wins: c => [c.wins, c.wins],
    winrate: c => [c.games >= 3 ? pctOf(c.wins, c.games) : -1, `${pctOf(c.wins, c.games)}%`],
    best: c => [c.bestScore, c.bestScore],
    avg: c => [c.games >= 3 ? c.scoreSum / c.games : -1, (c.scoreSum / Math.max(1, c.games)).toFixed(1)],
    games: c => [c.games, c.games],
  }[boardTab];
  const rows = boardUsers.filter(u => u.citStats && u.citStats.games > 0).map(u => ({ u, m: metric(u.citStats) })).filter(r => r.m[0] >= 0)
    .sort((a, b) => b.m[0] - a.m[0] || b.u.citStats.wins - a.u.citStats.wins);
  $('#boardList').innerHTML = rows.length ? rows.map(({ u, m }, i) => `
    <li class="board-row ${account && u.id === account.id ? 'me' : ''}" data-player="${u.id}">
      <span class="board-rank">${['🥇', '🥈', '🥉'][i] || `<span class="rank">${i + 1}</span>`}</span>
      ${avatar(u.username, u.avatar, u.equipped)}
      <span class="board-id"><b class="${nameCls(u.equipped)}">${esc(u.username)}</b>${statusPill(u.score)}<span class="muted small-text">${esc(t('board.sub', { g: u.citStats.games, w: u.citStats.wins }))}</span></span>
      <span class="board-metric">${m[1]}</span>
    </li>`).join('') : `<p class="muted small-text">${esc(t('board.empty'))}</p>`;
  $('#boardNote').textContent = boardTab === 'winrate' || boardTab === 'avg' ? t('board.minGames', { n: 3 }) : '';
  for (const row of $$('#boardList [data-player]')) row.onclick = () => openPlayer(row.dataset.player);
}
for (const b of $$('[data-board]')) b.onclick = () => { boardTab = b.dataset.board; renderBoardSheet(); };
$('#boardBtn').onclick = openBoard;
$('#homeBoard').onclick = openBoard;
$('#boardClose').onclick = () => closeOverlay('boardSheet');

const OVERLAYS = ['boardSheet', 'results', 'chooser', 'cardModal'];
function closeAll() { for (const id of [...OVERLAYS, 'pickModal']) closeOverlay(id); }
for (const id of [...OVERLAYS, 'pickModal']) $('#' + id).addEventListener('pointerdown', e => { if (e.target.id === id) { if (id === 'pickModal') pickDismissed = true; closeOverlay(id); } });
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  for (const id of OVERLAYS) closeOverlay(id);
  if (!$('#pickModal').classList.contains('hidden')) { pickDismissed = true; closeOverlay('pickModal'); }
  if (targeting) { targeting = null; render(); }
});

// last, once everything above exists: the shared code may render right away
Site.init({
  game: 'cit',
  socket,
  urlRoom: () => urlRoom,
  hooks: {
    onAccount: () => render(),
    onItems: () => render(),
    onLang: () => { settingsKey = ''; render(); },
    busy: () => !!(state && state.me && state.phase === 'playing' && !state.me.spectator),
    leave: async () => { if (state && state.me) await send('leave'); store.set(SESSION_KEY, null); },
  },
});
Voice.init({ socket, me: () => state && state.me && state.me.id, route: () => true, channel: () => 'all', transcripts: () => false });
$('#profileBtn').onclick = () => openProfile();
$('#homeProfile').onclick = () => openProfile();
applyStaticTranslations();
render();
