'use strict';

// Texas hold'em client. Same accounts, tables and voice chat as the other games (common.js,
// voice.js); its own Socket.IO namespace. The hand evaluator (/poker/hand.js) is the server's own,
// so the highlighted cards are exactly the ones that count.

const SESSION_KEY = 'pk.session';
const PREFS_KEY = 'pk.prefs';
const socket = io('/poker', { auth: cb => cb({ token: store.get(AUTH_KEY) }) });

let state = null;
let clockOffset = 0;
let urlRoom = (new URLSearchParams(location.search).get('room') || '').toUpperCase().slice(0, 4);
let homeView = false;
let pre = null; // a pre-selected action for when it's my turn: { type, amt, n, street }
let raise = { key: '', to: 0 }; // the bet slider
let resultsShownFor = null;
let prefs = { fourColor: true, inBB: false, tab: null };
try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch {}
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {} };

// ---------- sounds (muted with the bell, like the alerts) ----------
const beep = (f, at = 0, dur = 0.12, type = 'triangle', vol = 0.05) => alertsOn && tone({ f, at, dur, type, vol, attack: 0.005 });
const SFX = {
  chips: () => { beep(2400, 0, 0.04, 'square', 0.02); beep(2900, 0.03, 0.05, 'square', 0.018); beep(2600, 0.07, 0.06, 'square', 0.015); },
  check: () => { beep(180, 0, 0.06, 'sine', 0.09); beep(170, 0.09, 0.06, 'sine', 0.08); },
  fold: () => beep(420, 0, 0.12, 'sine', 0.03),
  card: () => beep(1400, 0, 0.03, 'triangle', 0.03),
  deal: () => { for (let i = 0; i < 4; i++) beep(1500 + i * 60, i * 0.07, 0.03, 'triangle', 0.025); },
  tick: () => beep(1800, 0, 0.03, 'square', 0.02),
  win: () => [523, 659, 784, 1046].forEach((f, i) => beep(f, i * 0.09, 0.4, 'triangle', 0.05)),
  drama: () => { beep(110, 0, 1.2, 'sine', 0.05); beep(165, 0.2, 1.0, 'sine', 0.03); },
};

// ---------- cards ----------
const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
const rankText = r => (r === 'T' ? '10' : r);
function cardHtml(c, { cls = '', style = '' } = {}) {
  return `<div class="pc s-${c[1]} ${cls}" data-card="${c}" ${style ? `style="${style}"` : ''}><span class="pc-corner"><b>${rankText(c[0])}</b><i>${SUIT[c[1]]}</i></span><span class="pc-pip">${SUIT[c[1]]}</span></div>`;
}
const backHtml = (cls = '', style = '') => `<div class="pc back ${cls}" ${style ? `style="${style}"` : ''}></div>`;
const handName = best => t(best.name.key, pkNameParams(best.name.params));

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
  fairOnState(s);
  fxOnState(prev, s);
  render();
  autoPre();
});
socket.on('kicked', r => { leftRoom(); toast(t(r && r.closed ? 'toast.roomClosed' : 'toast.kicked')); });
function leftRoom() {
  store.set(SESSION_KEY, null);
  state = null;
  urlRoom = '';
  pre = null;
  history.replaceState(null, '', '/poker/');
  for (const id of OVERLAYS) closeOverlay(id);
  render();
}

// ---------- home and top bar ----------
if (urlRoom) $('#joinCode').value = urlRoom;
$('#createBtn').onclick = () => send('create');
$('#joinBtn').onclick = () => send('join', { code: $('#joinCode').value });
$('#watchBtn').onclick = () => send('join', { code: $('#joinCode').value, spectate: true });
$('#joinCode').addEventListener('keydown', e => { if (e.key === 'Enter') $('#joinBtn').click(); });
$('#homeBtn').onclick = () => { homeView = true; render(); };
$('#leaveBtn').onclick = async () => {
  if (state && state.phase === 'playing' && !state.me.spectator && !(await askConfirm({ title: t('ui.leaveRoom'), text: t('pk.confirmLeave'), danger: true }))) return;
  await send('leave');
  leftRoom();
};
$('#topRoom').onclick = async () => {
  try { await navigator.clipboard.writeText(`${location.origin}/poker/?room=${state.code}`); toast(t('toast.linkCopied'), 'info'); } catch {}
};
$('#copyLink').onclick = () => $('#topRoom').click();
$('#rulesBtn').innerHTML = COMMON_ICONS.book;
$('#rulesBtn').title = t('rules.title');
$('#rulesBtn').onclick = () => openRules('poker');
$('#homeRules').onclick = () => { $('#cheatBody').innerHTML = cheatHtml(null); $('#cheatSheet').classList.remove('hidden'); };

// ---------- helpers on the state ----------
const isHost = () => !!(state && state.me && state.hostId === state.me.id);
const member = id => state && [...state.players, ...state.spectators].find(p => p.id === id);
const nameOf = id => (member(id) || {}).name || '?';
const G = () => state.game;
const H = () => (state && state.game && state.game.hand) || null;
const myId = () => state && state.me && state.me.id;
const mySeat = () => state && state.game && state.game.seats[myId()];
const inHand = () => { const h = H(); return !!(h && h.seats.includes(myId()) && !h.folded[myId()]); };
const myTurn = () => !!(H() && H().stage === 'betting' && H().toAct === myId() && H().options);
const now = () => Date.now() + clockOffset;
const bb = () => (H() ? H().blinds.bb : G() ? G().blinds.bb : state.settings.bigBlind);
const loc = () => (lang === 'ru' ? 'ru-RU' : 'en-US');
function fmt(n) {
  if (n === null || n === undefined) return '';
  if (prefs.inBB && state && state.game) return `${+(n / bb()).toFixed(n % bb() ? 1 : 0)} BB`;
  return Math.round(n).toLocaleString(loc());
}
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
  $('#topRound').textContent = inRoom && state.game ? topChip() : '';
  if (inRoom && urlRoom !== state.code) { urlRoom = state.code; history.replaceState(null, '', `/poker/?room=${state.code}`); }
  updateTurnAlert(myTurn() ? { key: `act:${H().n}:${H().actions.length}`, text: t('pk.alert.turn') } : null);
  Voice.update(!!(state && state.me && state.features && state.features.voice && state.settings.voice !== false));
  document.documentElement.style.setProperty('--topbar-h', `${$('.topbar').offsetHeight}px`);
  document.body.classList.toggle('four-color', !!prefs.fourColor);
  if (!inRoom) { renderHomeWallet(); return show('home'); }
  if (state.phase === 'lobby') { show('lobby'); return renderLobby(); }
  show('game');
  renderGame();
}

function topChip() {
  const g = G();
  const b = g.blinds;
  return [g.handN ? t('pk.handN', { n: g.handN }) : null, t('pk.blinds', { sb: fmtRaw(b.sb), bb: fmtRaw(b.bb) }) + (b.ante ? ` · ${t('pk.ante', { n: fmtRaw(b.ante) })}` : '')].filter(Boolean).join(' · ');
}
const fmtRaw = n => Math.round(n).toLocaleString(loc());

// ---------- lobby ----------
$('#startBtn').onclick = () => send('start');
$('#readyBtn').onclick = () => { const mine = state.players.find(p => p.id === state.me.id); send('ready', { ready: !(mine && mine.ready) }); };
$('#watchToggle').onclick = () => send('watch', { on: !state.me.spectator });
$('#resetRules').onclick = () => send('settings', state.defaults);

function renderLobby() {
  $('#lobbyCount').textContent = `${state.players.length}/${state.maxPlayers}`;
  $('#lobbyPlayers').innerHTML = state.players.map(p => `
    <li class="${p.connected ? '' : 'offline'} ${p.ready ? 'is-ready' : ''}" data-pid="${p.id}">
      <span class="avatar-wrap clickable" data-open-player="${p.userId || ''}">${avatar(p.name, p.avatar, p.cos)}${p.ready ? '<span class="voted ready-mark">✓</span>' : ''}</span>
      <span class="pname"><b class="${nameCls(p.cos)}">${esc(p.name)}</b>${titleTag(p.title)}${statusPill(p.score)}${p.id === state.hostId ? `<span class="tag host">${esc(t('tag.host'))}</span>` : ''}</span>
      ${state.settings.bank === 'usdt'
        ? `<span class="tag ${p.usdtSet ? 'town' : 'mafia'}" title="${esc(t(p.usdtSet ? 'pk.usdt.has' : 'pk.usdt.none'))}">${p.usdtSet ? '✓' : '✗'} USDT</span>`
        : `<span class="pk-lot-price ${p.chips !== null && p.chips < state.settings.startStack ? 'short' : ''}" title="${esc(t('pk.chips.balance'))}">${p.chips === null ? '—' : fmtRaw(p.chips)}</span>`}
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
  const qr = `/qr.svg?room=${state.code}&game=poker`;
  if ($('#inviteQr').getAttribute('src') !== qr) $('#inviteQr').src = qr;
  renderSettings();
  $('#resetRules').classList.toggle('hidden', !isHost());
  $('#startBtn').classList.toggle('hidden', !isHost());
  $('#waitHost').classList.toggle('hidden', isHost());
  $('#startBtn').disabled = state.players.length < state.minPlayers;
  // real money: "ready" is agreeing to the buy-in
  let consent = $('#usdtConsent');
  if (!consent) { $('#readyBtn').closest('.lobby-me').insertAdjacentHTML('afterend', '<p id="usdtConsent" class="pk-consent hidden"></p>'); consent = $('#usdtConsent'); }
  const usdt = state.settings.bank === 'usdt';
  consent.classList.toggle('hidden', !usdt);
  if (usdt) consent.innerHTML = `${esc(t('pk.usdt.consent', { n: state.settings.usdtBuyIn }))}${account && !account.usdtSet ? ` <button class="small" id="consentWallet">${esc(t('pk.usdt.setAddress'))}</button>` : ''}`;
  if ($('#consentWallet')) $('#consentWallet').onclick = () => openWallet();
  $('#startBtn').textContent = state.players.length < state.minPlayers ? t('mono.needPlayers', { n: state.minPlayers }) : `${t('pk.start')} · ${t('ui.readyCount', { n: readyN, total: state.players.length })}`;
}

// The settings panel is rebuilt only when something in it changed, so typing isn't interrupted.
let settingsKey = '';
const NUM_GROUPS = [
  ['pk.set.group.chips', ['startStack', 'smallBlind', 'bigBlind', 'ante']],
  ['pk.set.group.pace', ['levelHands', 'turnSeconds']],
];
const BOOLS = ['rebuy', 'lateJoin', 'rabbit', 'showEquity'];
function renderSettings() {
  const s = state.settings;
  const host = isHost();
  const key = JSON.stringify([s, host, lang, state.features]);
  const box = $('#settingsBox');
  if (key === settingsKey || (box.contains(document.activeElement) && document.activeElement.type === 'number')) return;
  settingsKey = key;
  const d = state.defaults;
  const changed = k => s[k] !== d[k];
  const ro = k => (k === 'turnSeconds' && !s[k] ? '∞' : k === 'levelHands' && !s[k] ? '—' : fmtRaw(s[k]));
  const nums = NUM_GROUPS.map(([title, keys]) => `
    <h3>${esc(t(title))}</h3>
    <div class="num-grid">${keys.map(k => `<label class="field ${changed(k) ? 'changed' : ''}"><span>${esc(t('pk.set.' + k))}</span>
      ${host ? `<input type="number" data-num="${k}" value="${s[k]}" min="0">` : `<b class="num-ro">${ro(k)}</b>`}
      <small class="muted">${esc(t('pk.set.' + k + '.hint'))}</small></label>`).join('')}</div>`).join('');
  const voiceOk = !!(state.features && state.features.voice);
  const toggles = `<h3>${esc(t('pk.set.group.table'))}</h3><div class="pk-bools">
    ${BOOLS.map(k => `<label class="check ${changed(k) ? 'changed' : ''}"><input type="checkbox" class="switch" data-bool="${k}" ${s[k] ? 'checked' : ''} ${host ? '' : 'disabled'}>
      <span><b>${esc(t('pk.set.' + k))}</b><small class="muted">${esc(t('pk.set.' + k + '.hint'))}</small></span></label>`).join('')}
    ${voiceOk ? `<label class="check"><input type="checkbox" class="switch" data-bool="voice" ${s.voice !== false ? 'checked' : ''} ${host ? '' : 'disabled'}> <span><b>${esc(t('ui.voice'))}</b></span></label>` : ''}
  </div>`;
  const usdt = s.bank === 'usdt';
  const bank = `<h3>${esc(t('pk.set.group.bank'))}</h3>
    <div class="pk-bank">${['chips', 'usdt'].map(b => `<button class="pk-bank-opt ${s.bank === b ? 'on' : ''}" data-bank="${b}" ${host ? '' : 'disabled'}>
      <b>${esc(t('pk.bank.' + b))}</b><small>${esc(t('pk.bank.' + b + '.hint'))}</small></button>`).join('')}</div>
    ${usdt ? `<div class="num-grid pk-usdt-row"><label class="field"><span>${esc(t('pk.set.usdtBuyIn'))}</span>
      ${host ? `<input type="number" data-usdt="1" value="${s.usdtBuyIn}" min="1" max="10000" step="0.5">` : `<b class="num-ro">${s.usdtBuyIn} USDT</b>`}
      <small class="muted">${esc(t('pk.set.usdtBuyIn.hint'))}</small></label></div>` : ''}`;
  const sum = usdt
    ? t('pk.set.sumUsdt', { usdt: s.usdtBuyIn, stack: fmtRaw(s.startStack), rate: +(s.usdtBuyIn / s.startStack).toFixed(4), sb: fmtRaw(s.smallBlind), bb: fmtRaw(s.bigBlind) })
    : t('pk.set.sum', { stack: fmtRaw(s.startStack), sb: fmtRaw(s.smallBlind), bb: fmtRaw(s.bigBlind), n: Math.round(s.startStack / s.bigBlind) });
  const blinds = `<div class="pk-set-sum ${usdt ? 'usdt' : ''}"><span>${esc(sum)}</span></div>`;
  box.innerHTML = bank + blinds + nums + toggles;
  if (!host) return;
  for (const b of $$('#settingsBox [data-bank]')) b.onclick = () => send('settings', { bank: b.dataset.bank });
  const ui = box.querySelector('[data-usdt]');
  if (ui) ui.onchange = () => send('settings', { usdtBuyIn: Number(ui.value) }).then(res => { if (!res.ok) { settingsKey = ''; renderSettings(); } });
  for (const inp of $$('#settingsBox [data-num]')) inp.onchange = () => send('settings', { [inp.dataset.num]: parseInt(inp.value, 10) || 0 }).then(res => { if (!res.ok) { settingsKey = ''; renderSettings(); } });
  for (const inp of $$('#settingsBox [data-bool]')) inp.onchange = () => send('settings', { [inp.dataset.bool]: inp.checked });
}

// ---------- the wallet: site chips, achievements, where to be paid in USDT ----------
const USDT_NETS = { trc20: 'TRON (TRC-20)', erc20: 'Ethereum (ERC-20)', bep20: 'BNB Chain (BEP-20)' };
async function openWallet() {
  const res = await api('wallet');
  if (!res.ok) return;
  const w = res.wallet;
  const done = w.achievements.filter(a => a.at);
  const reason = e => t('pk.chips.r.' + e.reason, { id: e.id ? t('ach.' + e.id) : '', code: e.code || '', streak: e.streak || '' });
  $('#walletBody').innerHTML = `
    <div class="pk-shop-head"><div><span class="muted small-text">${esc(t('pk.chips.balance'))}</span><b class="pk-shop-bal">${fmtRaw(w.chips)}</b></div>
      <p class="muted small-text">${esc(t('pk.chips.hint'))}${w.daily ? ` ${esc(t('pk.chips.streak', { n: w.daily.streak }))}` : ''}</p></div>
    <h4>${esc(t('pk.ach.title'))} · ${done.length}/${w.achievements.length}</h4>
    <div class="pk-ach-grid">${w.achievements.map(a => `<div class="pk-ach ${a.at ? 'got' : ''}"><b>${esc(t('ach.' + a.id))}</b><span class="muted small-text">${esc(t('ach.' + a.id + '.text'))}</span><span class="pk-lot-price">+${fmtRaw(a.reward)}</span></div>`).join('')}</div>
    <h4>${esc(t('pk.usdt.title'))}</h4>
    <p class="muted small-text">${esc(t('pk.usdt.hint'))}</p>
    <div class="row pk-usdt-form"><select id="usdtNet">${Object.entries(USDT_NETS).map(([k, n]) => `<option value="${k}" ${w.usdt && w.usdt.network === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <input id="usdtAddr" placeholder="${esc(t('pk.usdt.address'))}" value="${esc(w.usdt ? w.usdt.address : '')}" spellcheck="false" autocomplete="off">
      <button id="usdtSave" class="primary small">${esc(t('pk.usdt.save'))}</button></div>
    ${w.log.length ? `<h4>${esc(t('pk.chips.log'))}</h4><ul class="pk-log">${w.log.slice(0, 25).map(e => `<li><span class="muted">${esc(fmtTime(e.at))}</span> <b class="${e.n > 0 ? 'pos' : 'neg'}">${e.n > 0 ? '+' : ''}${fmtRaw(e.n)}</b> ${esc(reason(e))}</li>`).join('')}</ul>` : ''}`;
  $('#usdtSave').onclick = async () => {
    const r = await api('wallet/usdt', { network: $('#usdtNet').value, address: $('#usdtAddr').value });
    if (r.ok) { toast(t('pk.usdt.saved'), 'info'); refreshAccount(); }
  };
  $('#walletSheet').classList.remove('hidden');
}
$('#homeWallet').onclick = () => openWallet();
$('#walletClose').onclick = () => closeOverlay('walletSheet');
function renderHomeWallet() {
  const el = $('#homeWallet');
  if (!el) return;
  el.innerHTML = `<span class="muted small-text">${esc(t('pk.chips.balance'))}</span><b class="pk-lot-price">${account && account.chips !== null && account.chips !== undefined ? fmtRaw(account.chips) : '—'}</b>`;
}

// who owes whom in USDT after the sessions (home screen)
const EXPLORER = { trc20: 'https://tronscan.org/#/transaction/', erc20: 'https://etherscan.io/tx/', bep20: 'https://bscscan.com/tx/' };
const usd = cents => `${(cents / 100).toFixed(2)} USDT`;
async function openPledges() {
  const res = await api('pledges');
  if (!res.ok) return;
  const me = account && account.id;
  const open = res.pledges.filter(p => p.status === 'owed' || p.status === 'sent');
  const done = res.pledges.filter(p => !open.includes(p)).slice(0, 20);
  const row = p => {
    const owe = p.from === me;
    const isUsdt = p.kind === 'usdt';
    const btns = [];
    if (owe && p.status === 'owed') {
      btns.push(isUsdt ? `<input class="pk-tx" data-tx="${p.id}" placeholder="${esc(t('pk.pl.txHash'))}" spellcheck="false"><button class="small primary" data-pl="${p.id}:sent">${esc(t('pk.pl.paid'))}</button>`
        : `<button class="small" data-pl="${p.id}:sent">${esc(t('pk.pl.sent'))}</button>`);
    }
    if (!owe && (p.status === 'owed' || p.status === 'sent')) btns.push(`<button class="primary small" data-pl="${p.id}:received">${esc(t('pk.pl.received'))}</button>`, `<button class="ghost small" data-pl="${p.id}:forgiven">${esc(t('pk.pl.forgive'))}</button>`);
    if (!owe && isUsdt && p.status === 'sent') btns.push(`<button class="danger small" data-pl="${p.id}:disputed">${esc(t('pk.pl.dispute'))}</button>`);
    const what = isUsdt ? `<span class="pk-usd">${usd(p.cents)}</span>` : `${esc(p.title)}${p.price ? ` <span class="pk-lot-price">${fmtRaw(p.price)}</span>` : ''}`;
    const pay = isUsdt && owe && p.status === 'owed'
      ? `<div class="pk-addr"><span class="muted small-text">${esc(t('pk.pl.payTo', { net: USDT_NETS[p.network] || p.network || '?' }))}</span><code>${esc(p.address || t('pk.pl.noAddress'))}</code>${p.address ? `<button class="ghost small" data-copy="${esc(p.address)}">${esc(t('pk.pl.copy'))}</button>` : ''}</div>` : '';
    const tx = isUsdt && p.tx ? `<a class="small-text" href="${EXPLORER[p.network] || EXPLORER.trc20}${encodeURIComponent(p.tx)}" target="_blank" rel="noopener">${esc(t('pk.pl.tx'))} ${esc(p.tx.slice(0, 10))}…</a>` : '';
    return `<li class="pk-pl ${owe ? 'owe' : 'owed'} st-${p.status}">
      <div><b>${what}</b><span class="muted small-text">${esc(t(owe ? 'pk.pl.youOwe' : 'pk.pl.owesYou', { name: owe ? p.toName : p.fromName }))} · ${esc(fmtTime(p.at))}</span>${pay}${tx}</div>
      <span class="tag">${esc(t('pk.pl.st.' + p.status))}</span>${btns.join('')}</li>`;
  };
  $('#pledgeBody').innerHTML = `<p class="muted small-text">${esc(t('pk.pl.hint'))}</p>
    ${open.length ? `<ul class="pk-pl-list">${open.map(row).join('')}</ul>` : `<p class="muted">${esc(t('pk.pl.none'))}</p>`}
    ${done.length ? `<h4>${esc(t('pk.pl.done'))}</h4><ul class="pk-pl-list">${done.map(row).join('')}</ul>` : ''}`;
  for (const b of $$('#pledgeBody [data-pl]')) {
    b.onclick = async () => {
      const [id, status] = b.dataset.pl.split(':');
      const txEl = $(`#pledgeBody [data-tx="${id}"]`);
      if (status === 'forgiven' && !(await askConfirm({ title: t('pk.pl.forgive'), text: t('pk.pl.forgiveText'), danger: true }))) return;
      if (status === 'disputed' && !(await askConfirm({ title: t('pk.pl.dispute'), text: t('pk.pl.disputeText'), danger: true }))) return;
      const r = await api('pledges/mark', { id, status, tx: txEl ? txEl.value : undefined });
      if (r.ok) openPledges();
      refreshPledgeCount();
      refreshAccount();
    };
  }
  for (const b of $$('#pledgeBody [data-copy]')) b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copy); toast(t('pk.pl.copied'), 'info'); } catch {} };
  $('#pledgeSheet').classList.remove('hidden');
}
async function refreshPledgeCount() {
  if (!account) return $('#pledgeCount').classList.add('hidden');
  const token = store.get(AUTH_KEY);
  try {
    const res = await fetch('/api/pledges', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
    const n = res.ok ? res.pledges.filter(p => p.status === 'owed' || p.status === 'sent').length : 0;
    $('#pledgeCount').textContent = n;
    $('#pledgeCount').classList.toggle('hidden', !n);
  } catch {}
}
$('#homePledges').onclick = openPledges;
// the debt banner on every page links here
if (new URLSearchParams(location.search).has('pay')) setTimeout(() => openPledges(), 600);
$('#pledgeClose').onclick = () => closeOverlay('pledgeSheet');

// ---------- the table ----------
// seats round an oval, me at the bottom; the next to act sits to my left (clockwise)
function seatOrder() {
  const order = G().order;
  const me = order.indexOf(myId());
  return me < 0 ? order : order.slice(me).concat(order.slice(0, me));
}
function seatPos(i, n) {
  const a = Math.PI / 2 + (i * 2 * Math.PI) / n;
  return { x: 50 + 45 * Math.cos(a), y: 50 + 41 * Math.sin(a) };
}
const toward = (p, k, ky = k) => ({ x: 50 + (p.x - 50) * k, y: 50 + (p.y - 50) * ky });

function lastAction(pid) {
  const h = H();
  if (!h) return null;
  for (let i = h.actions.length - 1; i >= 0; i--) {
    const a = h.actions[i];
    if (a.pid !== pid) continue;
    if (a.s !== h.street && h.stage === 'betting') return null;
    if (a.a === 'return' || a.a === 'ante') continue;
    if (a.a === 'sb' || a.a === 'bb') return null; // the bet in front shows it
    return a;
  }
  return null;
}
const actionText = a => t('pk.a.' + a.a, { n: fmt(a.to || a.amt) });

// chips as a little stack: colours by size
const CHIP_COLORS = [[1000, '#eab308'], [500, '#a855f7'], [100, '#1f2937'], [25, '#16a34a'], [5, '#dc2626'], [1, '#e5e7eb']];
function chipsHtml(amount) {
  const stack = [];
  let left = amount;
  for (const [v, c] of CHIP_COLORS) {
    while (left >= v && stack.length < 6) { stack.push(c); left -= v; }
  }
  if (!stack.length) stack.push('#e5e7eb');
  return `<span class="chips">${stack.slice(0, 6).reverse().map((c, i) => `<i style="--c:${c};--i:${i}"></i>`).join('')}</span>`;
}

// which cards to light up: the combination itself (a pair is two cards, no kickers) — mine while
// the hand is on, the winner's at the showdown
function highlight() {
  const h = H();
  if (!h) return { cards: new Set(), who: null };
  const r = h.result;
  if (r && !r.uncontested && h.stage === 'done') {
    if (!resultShown(h)) return { cards: new Set(), who: null };
    const w = r.pots[0].winners;
    return { cards: new Set(w.flatMap(p => (r.best[p] ? PH_best(r.best[p].cards).core : []))), who: 'win' };
  }
  const mine = h.hole[myId()];
  if (mine && h.board.length >= 3 && !h.folded[myId()]) return { cards: new Set(PH_best([...mine, ...h.board]).core), who: 'me' };
  return { cards: new Set(), who: null };
}
const PH_best = cards => PokerHand.best(cards);

function equityNow() {
  const h = H();
  if (!h || !h.equity || !h.equity.length || h.stage !== 'runout') return null;
  return h.equity[h.equity.length - 1];
}

// ---------- the table is built once and then changed in place, so things move instead of blinking ----------
// A card on the table: two faces, turned over with a 3D flip ("up" shows the face).
function card3(c, cls = '') {
  const el = document.createElement('div');
  el.className = `pc3 ${cls}`;
  el.innerHTML = '<div class="pc-in"><div class="pc pc-face pc-front"></div><div class="pc pc-face back"></div></div>';
  if (c) setFace(el, c);
  return el;
}
function setFace(el, c) {
  if (el.dataset.card === c) return;
  el.dataset.card = c;
  const f = el.querySelector('.pc-front');
  f.className = `pc pc-face pc-front s-${c[1]}`;
  f.innerHTML = `<span class="pc-corner"><b>${rankText(c[0])}</b><i>${SUIT[c[1]]}</i></span><span class="pc-pip">${SUIT[c[1]]}</span>`;
}
const flipUp = (el, slow = false) => { el.classList.toggle('slow', slow); requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('up'))); };

// moves, in table percent → pixels; the element sits at its destination and animates from the start
function tableSize() { const r = $('#pkTable').getBoundingClientRect(); return { w: r.width || 1, h: r.height || 1 }; }
function flyFrom(el, from, to, { ms = 450, delay = 0, easing = 'cubic-bezier(.2,.75,.25,1)', scale = 1, rot = 0, fade = false } = {}) {
  if (reducedMotion() || !el.animate) return null;
  const { w, h } = tableSize();
  const dx = ((from.x - to.x) / 100) * w;
  const dy = ((from.y - to.y) / 100) * h;
  return el.animate([
    { transform: `translate(${dx}px, ${dy}px) scale(${scale}) rotate(${rot}deg)`, opacity: fade ? 0 : 1 },
    { transform: 'translate(0, 0) scale(1) rotate(0)', opacity: 1 },
  ], { duration: ms, delay, easing, fill: 'backwards' });
}
function flyTo(el, from, to, { ms = 450, delay = 0, easing = 'cubic-bezier(.4,0,.2,1)', fade = true, scale = 1 } = {}) {
  if (reducedMotion() || !el.animate) { el.remove(); return; }
  const { w, h } = tableSize();
  const dx = ((to.x - from.x) / 100) * w;
  const dy = ((to.y - from.y) / 100) * h;
  const a = el.animate([{ transform: 'translate(0, 0)', opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: fade ? 0 : 1 }],
    { duration: ms, delay, easing, fill: 'forwards' });
  a.onfinish = () => el.remove();
}
// numbers that count to their new value
function countTo(el, to, ms = 650) {
  const from = Number(el.dataset.v);
  el.dataset.v = to;
  if (!Number.isFinite(from) || from === to || reducedMotion()) { el.textContent = fmt(to); return; }
  const t0 = performance.now();
  const step = tm => {
    if (Number(el.dataset.v) !== to) return;
    const k = Math.min(1, (tm - t0) / ms);
    el.textContent = fmt(Math.round(from + (to - from) * (1 - (1 - k) ** 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

const DECK_AT = { x: 50, y: 40 };
const POT_AT = { x: 50, y: 31 };
const seatPosOf = pid => { const o = seatOrder(); return seatPos(o.indexOf(pid), o.length); };
const betPos = pid => toward(seatPosOf(pid), 0.6, 0.5);

// what the table shows right now (to see what changed)
const T = { hand: null, layout: '', seats: new Map(), bets: new Map(), board: [], boardHand: null, rabbitShown: false, result: null };

// The result is held back until the cards have turned and the chips can go to the winners.
function resultShown(h) { return !!(T.result && T.result.n === h.n && performance.now() >= T.result.at); }

function renderTable() {
  const g = G();
  const h = g.hand;
  const order = seatOrder();
  const n = order.length;
  const layout = order.join();
  const seatsBox = $('#pkSeats');
  // a seat changed (someone sat down): rebuild the seats
  if (layout !== T.layout) {
    T.layout = layout;
    seatsBox.innerHTML = '<div class="pk-dealer hidden">D</div>';
    T.seats.clear();
    T.bets.clear();
    T.hand = null;
  }
  const newHand = h && T.hand !== h.n;
  if (h && !T.result || (h && T.result && T.result.n !== h.n && !h.result)) T.result = null;
  // the result: when the pot goes to the winners
  if (h && h.result && (!T.result || T.result.n !== h.n)) {
    const slowRiver = T.board.some(x => x.slow);
    const delay = newHand ? 0 : h.result.uncontested ? 450 : slowRiver ? 1700 : 1100;
    T.result = { n: h.n, at: performance.now() + delay, done: false };
    setTimeout(() => { if (state && H() && H().n === h.n) { payOut(h); render(); } }, delay + 20);
  }
  const hl = highlight();
  const eq = equityNow();
  const r = h && h.result;
  const paid = r && resultShown(h);
  const winners = new Set(paid ? r.pots.flatMap(p => p.winners) : []);
  // chips held back from the winners until they arrive
  const held = {};
  if (r && !paid) for (const p of r.pots) for (const w of p.winners) held[w] = (held[w] || 0) + Math.floor(p.amount / p.winners.length);

  order.forEach((pid, i) => {
    const pos = seatPos(i, n);
    let el = T.seats.get(pid);
    if (!el) {
      el = document.createElement('div');
      el.className = 'pk-seat';
      el.dataset.pid = pid;
      el.innerHTML = `<div class="pk-hole"></div><div class="pk-ava avatar-wrap"></div>
        <div class="pk-plate"><b class="pk-name"></b><span class="pk-stack"></span><span class="pk-pos hidden"></span></div>
        <div class="pk-act"></div><div class="pk-eq hidden"></div><div class="pk-hname"></div><div class="pk-won"></div>`;
      el.style.setProperty('--x', `${pos.x.toFixed(2)}%`);
      el.style.setProperty('--y', `${pos.y.toFixed(2)}%`);
      seatsBox.append(el);
      T.seats.set(pid, el);
    }
    updateSeat(el, pid, pos, i, { h, newHand, hl, eq, r, paid, winners, held });
    updateBet(pid, pos, h, newHand);
  });
  // the dealer button slides to its new seat
  const d = seatsBox.querySelector('.pk-dealer');
  if (h) {
    const i = order.indexOf(h.button);
    const pos = toward(seatPos(i, n), 0.78, 0.74);
    const off = i === 0 ? 7 : seatPos(i, n).x < 50 ? 3.5 : -3.5;
    d.style.left = `${(pos.x + off).toFixed(2)}%`;
    d.style.top = `${(pos.y + (i === 0 ? -2 : 0)).toFixed(2)}%`;
    d.classList.remove('hidden');
  } else d.classList.add('hidden');
  renderCenter(hl, held);
  if (h) T.hand = h.n;
  tick();
}

function updateSeat(el, pid, pos, i, { h, newHand, hl, eq, r, paid, winners, held }) {
  const g = G();
  const p = member(pid) || { name: '?' };
  const seat = g.seats[pid];
  const me = pid === myId();
  const dealt = !!(h && h.seats.includes(pid));
  const folded = dealt && !!h.folded[pid];
  const acting = !!(h && h.stage === 'betting' && h.toAct === pid);
  const showdown = !!(r && !r.uncontested && paid);
  el.className = ['pk-seat', me && 'me', folded && 'folded', acting && 'acting', winners.has(pid) && 'winner', !dealt && 'idle', pos.y < 50 ? 'top' : 'bottom', pos.x > 62 && 'east'].filter(Boolean).join(' ');
  // the avatar (only when it changes: the sticker bubbles live next to it)
  const avaKey = `${p.name}|${p.avatar}|${JSON.stringify(p.cos)}`;
  const ava = el.querySelector('.pk-ava');
  if (ava.dataset.k !== avaKey) {
    ava.dataset.k = avaKey;
    ava.innerHTML = `${avatar(p.name, p.avatar, p.cos)}<svg class="pk-ring" viewBox="0 0 40 40"><circle cx="20" cy="20" r="18.5" pathLength="100"/></svg>`;
    if (p.userId) { ava.classList.add('clickable'); ava.onclick = () => openPlayer(p.userId); }
  }
  const plate = el.querySelector('.pk-plate');
  const name = el.querySelector('.pk-name');
  name.className = `pk-name ${nameCls(p.cos)}`;
  name.textContent = p.name;
  // the stack: counts as chips go in or come back
  const stackEl = el.querySelector('.pk-stack');
  const allIn = dealt && h.allIn[pid] && h.stage !== 'done';
  const lost = seat.stack === 0 && (!dealt || (h.stage === 'done' && (!r || paid)));
  const status = seat.left ? t('pk.s.left') : allIn || (seat.stack === 0 && dealt && !lost) ? t('pk.s.allIn') : lost ? t('pk.s.busted') : seat.sitOut ? t('pk.s.sitOut') : '';
  if (status) { stackEl.innerHTML = `<em>${esc(status)}</em>`; delete stackEl.dataset.v; } else countTo(stackEl, seat.stack - (held[pid] || 0));
  const posTag = el.querySelector('.pk-pos');
  const tag = h && h.bbPid === pid ? 'BB' : h && h.sbPid === pid && h.seats.length > 2 ? 'SB' : '';
  posTag.textContent = tag;
  posTag.classList.toggle('hidden', !tag);
  // the clock goes round smoothly: one CSS animation for the time that's left
  const ring = ava.querySelector('.pk-ring circle');
  const key = acting && h.actEndsAt ? `${h.n}:${h.actions.length}:${h.actEndsAt}` : '';
  if (ring && ring.dataset.k !== key) {
    ring.dataset.k = key;
    ring.style.animation = 'none';
    if (key) {
      const total = state.settings.turnSeconds * 1000;
      const left = Math.max(0, h.actEndsAt - now());
      ring.style.setProperty('--from', 100 - (left / total) * 100);
      void ring.getBoundingClientRect();
      ring.style.animation = `pkRing ${left}ms linear forwards`;
    }
  }
  updateHole(el, pid, pos, i, h, newHand, hl);
  // the last action this street
  const act = el.querySelector('.pk-act');
  const a = h && h.stage === 'betting' ? lastAction(pid) : null;
  const aKey = a ? `${h.n}:${h.actions.indexOf(a)}` : '';
  if (act.dataset.k !== aKey) {
    act.dataset.k = aKey;
    act.className = `pk-act ${a ? `a-${a.a} on` : ''}`;
    if (a) act.textContent = actionText(a);
  }
  // equity in an all-in (if the table has it on)
  const eqEl = el.querySelector('.pk-eq');
  const e = eq && eq.eq[pid] !== undefined ? eq.eq[pid] : null;
  eqEl.classList.toggle('hidden', e === null);
  if (e !== null) {
    eqEl.classList.toggle('ahead', e >= 0.5);
    eqEl.innerHTML = `<b>${Math.round(e * 100)}%</b><i style="--w:${(e * 100).toFixed(1)}%"></i>`;
  }
  // the hand's name at the showdown
  const hn = el.querySelector('.pk-hname');
  const best = showdown && r.best[pid];
  const hnKey = best ? `${h.n}:${winners.has(pid)}` : '';
  if (hn.dataset.k !== hnKey) {
    hn.dataset.k = hnKey;
    hn.className = `pk-hname ${best ? 'on' : ''} ${best && winners.has(pid) ? 'win' : ''}`;
    hn.textContent = best ? handName(best) : '';
  }
  // what the winner took
  const won = el.querySelector('.pk-won');
  const net = paid && r.net ? r.net[pid] : 0;
  const wKey = net > 0 ? `${h.n}` : '';
  if (won.dataset.k !== wKey) {
    won.dataset.k = wKey;
    won.className = `pk-won ${net > 0 ? 'on' : ''}`;
    won.textContent = net > 0 ? `+${fmt(net)}` : '';
  }
}

// hole cards: dealt one at a time from the middle; mine turn over; others turn at the showdown;
// folded cards slide into the middle
function updateHole(el, pid, pos, i, h, newHand, hl) {
  const box = el.querySelector('.pk-hole');
  const me = pid === myId();
  box.classList.toggle('mine', me);
  const dealt = !!(h && h.seats.includes(pid));
  if (!h || !dealt) { if (box.dataset.n) { box.innerHTML = ''; delete box.dataset.n; } return; }
  const hole = h.hole[pid];
  if (box.dataset.n !== String(h.n)) {
    box.innerHTML = '';
    box.dataset.n = h.n;
    delete box.dataset.mucked;
    const k0 = h.seats.indexOf(pid) - h.seats.indexOf(h.sbPid);
    const order = (k0 + h.seats.length) % h.seats.length;
    for (let k = 0; k < 2; k++) {
      const c = card3(hole && hole[k], 'hole');
      box.append(c);
      const delay = newHand ? (k * h.seats.length + order) * 110 + 250 : 0;
      if (newHand) flyFrom(c, DECK_AT, pos, { ms: 420, delay, scale: 0.55, rot: -30, fade: true });
      if (hole && (me || h.shown[pid])) {
        if (newHand) setTimeout(() => flipUp(c), delay + 2 * h.seats.length * 110 + 200);
        else c.classList.add('up');
      }
    }
  }
  const cards = [...box.children];
  // turned over: at the showdown, or shown
  if (hole && !me) cards.forEach((c, k) => { if (!c.classList.contains('up')) { setFace(c, hole[k]); flipUp(c); } });
  // folded: others' cards go into the muck
  if (h.folded[pid] && !me && !box.dataset.mucked && !h.shown[pid]) {
    box.dataset.mucked = '1';
    cards.forEach((c, k) => flyTo(c, pos, DECK_AT, { ms: 420, delay: k * 60, scale: 0.5 }));
  }
  for (const c of cards) {
    const cc = c.dataset.card;
    c.classList.toggle('hl', !!cc && hl.cards.has(cc));
    c.classList.toggle(`hl-me`, !!cc && hl.cards.has(cc) && hl.who === 'me');
    c.classList.toggle('dim', hl.who === 'win' && !!cc && !hl.cards.has(cc));
  }
}

// a bet in front of a player: chips slide from the stack; at the end of a street they go to the pot
function updateBet(pid, pos, h, newHand) {
  const amount = h ? h.bets[pid] || 0 : 0;
  let el = T.bets.get(pid);
  const at = betPos(pid);
  if (amount > 0 && !newHand) {
    if (!el) {
      el = document.createElement('div');
      el.className = 'pk-bet';
      el.dataset.v = 0;
      el.style.left = `${at.x.toFixed(2)}%`;
      el.style.top = `${at.y.toFixed(2)}%`;
      el.innerHTML = '<span class="pk-bet-chips"></span><b></b>';
      $('#pkSeats').append(el);
      T.bets.set(pid, el);
    }
    const before = Number(el.dataset.v);
    if (amount !== before) {
      el.dataset.v = amount;
      el.querySelector('.pk-bet-chips').innerHTML = chipsHtml(amount);
      el.querySelector('b').textContent = fmt(amount);
      if (amount > before) flyFrom(el.querySelector('.pk-bet-chips'), pos, at, { ms: 380, scale: 0.8 });
    }
  } else if (el) {
    // swept into the pot (or a new hand began)
    T.bets.delete(pid);
    if (newHand) el.remove(); else flyTo(el, at, POT_AT, { ms: 420, scale: 0.9, fade: true });
  }
  if (newHand && amount > 0) {
    // blinds posted at the start of the hand
    T.bets.delete(pid);
    el = document.createElement('div');
    el.className = 'pk-bet';
    el.dataset.v = amount;
    el.style.left = `${at.x.toFixed(2)}%`;
    el.style.top = `${at.y.toFixed(2)}%`;
    el.innerHTML = `<span class="pk-bet-chips">${chipsHtml(amount)}</span><b>${fmt(amount)}</b>`;
    $('#pkSeats').append(el);
    T.bets.set(pid, el);
    flyFrom(el, pos, at, { ms: 380, delay: 120 });
  }
}

// the pot goes to the winners: chip stacks fly from the middle to each of them
function payOut(h) {
  const r = h.result;
  if (!r || !$('#pkFx')) return;
  const wins = [...new Set(r.pots.flatMap(p => p.winners))];
  for (const [k, w] of wins.entries()) {
    const el = document.createElement('div');
    el.className = 'pk-fly';
    const to = seatPosOf(w);
    el.style.left = `${to.x}%`;
    el.style.top = `${to.y}%`;
    el.innerHTML = chipsHtml(Math.max(...r.pots.filter(p => p.winners.includes(w)).map(p => p.amount)));
    $('#pkFx').append(el);
    const a = flyFrom(el, POT_AT, to, { ms: 650, delay: k * 120, easing: 'cubic-bezier(.3,.6,.2,1)' });
    if (a) a.onfinish = () => el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250, fill: 'forwards' }).onfinish = () => el.remove();
    else el.remove();
  }
  if (wins.includes(myId())) SFX.win(); else SFX.chips();
}

function renderCenter(hl, held) {
  const g = G();
  const h = g.hand;
  const el = $('#pkCenter');
  if (!el.dataset.ready) {
    el.dataset.ready = '1';
    el.innerHTML = `<div class="pk-top"></div><div class="pk-board">${[0, 1, 2, 3, 4].map(i => `<div class="pk-slot" data-slot="${i}"></div>`).join('')}</div><div class="pk-banner"></div>`;
  }
  const slots = $$('#pkCenter .pk-slot');
  // a new hand: the old board is swept away
  if (!h || T.boardHand !== h.n) {
    for (const x of T.board) x.el.animate ? x.el.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(-20%) scale(.9)' }], { duration: 300, fill: 'forwards' }).onfinish = () => x.el.remove() : x.el.remove();
    T.board = [];
    T.boardHand = h ? h.n : null;
  }
  if (h) {
    const r = h.result;
    const decisive = r && r.decisive && resultShown(h) ? { flop: [0, 1, 2], turn: [3], river: [4] }[r.decisive] : [];
    const rabbit = h.rabbit ? h.rabbit.cards : [];
    const all = [...h.board, ...rabbit];
    // the river after a squeeze: the card waiting face down
    const waiting = h.stage === 'runout' && h.squeeze;
    for (let i = 0; i < 5; i++) {
      let x = T.board[i];
      const c = all[i];
      if (c && x && x.el.dataset.card !== c) { setFace(x.el, c); }
      if (c && !x) {
        const isRabbit = i >= h.board.length;
        const el = card3(c, isRabbit ? 'board rabbit' : 'board');
        slots[i].append(el);
        x = T.board[i] = { el, slow: false };
        const fresh = T.hand === h.n; // not on first load
        if (!fresh) el.classList.add('up');
        else if (i < 3 && !isRabbit && h.board.length >= 3 && T.board.filter(Boolean).length <= 3) {
          // the flop: three cards from the first slot, spread, then turned one by one
          const slotW = slots[1].getBoundingClientRect().left - slots[0].getBoundingClientRect().left;
          if (el.animate && !reducedMotion()) el.animate([{ transform: `translateX(${-slotW * i}px)` }, { transform: 'none' }], { duration: 320, delay: 380, easing: 'cubic-bezier(.3,.7,.2,1)', fill: 'backwards' });
          flyFrom(el, DECK_AT, { x: 50, y: 50 }, { ms: 320, scale: 0.8, fade: true });
          setTimeout(() => flipUp(el), 760 + i * 140);
          SFX.card();
        } else {
          const slow = slots[i].dataset.wait === '1';
          x.slow = slow;
          if (!slow) flyFrom(el, DECK_AT, { x: 50, y: 50 }, { ms: 300, scale: 0.85, fade: true });
          setTimeout(() => flipUp(el, slow), slow ? 60 : 320);
          if (slow) SFX.drama(); else SFX.card();
        }
      }
      if (!c && x) { x.el.remove(); T.board[i] = undefined; }
      if (x) {
        const cc = x.el.dataset.card;
        x.el.classList.toggle('hl', hl.cards.has(cc));
        x.el.classList.toggle('hl-me', hl.cards.has(cc) && hl.who === 'me');
        x.el.classList.toggle('dim', hl.who === 'win' && !hl.cards.has(cc));
        x.el.classList.toggle('decisive', decisive.includes(i));
      }
      // the face-down river, peeled slowly
      const wait = !c && waiting && i === h.board.length;
      slots[i].dataset.wait = wait ? '1' : '';
      slots[i].classList.toggle('waiting', wait);
    }
    T.board.length = 5;
  } else for (const s of slots) { s.classList.remove('waiting'); s.dataset.wait = ''; }
  // above the board: the pot, or what the hand was about
  const top = el.querySelector('.pk-top');
  const r = h && h.result;
  const paid = r && resultShown(h);
  let topKey;
  let topHtml;
  if (h && !paid) {
    const pot = h.stage === 'done' ? r.pots.reduce((s, p) => s + p.amount, 0) : h.pot - h.seats.reduce((s, p) => s + (h.bets[p] || 0), 0);
    const pots = h.pots && h.pots.length > 1 ? h.pots : null;
    topKey = `pot:${pot}:${pots ? pots.map(p => p.amount).join() : ''}`;
    topHtml = pot > 0 ? `<div class="pk-pot">${chipsHtml(pot)}<span>${esc(t('pk.pot'))}</span><b class="pk-pot-n"></b>
      ${pots ? `<small>${pots.map((p, i) => esc(t(i ? 'pk.sidePot' : 'pk.mainPot', { n: fmt(p.amount) }))).join(' · ')}</small>` : ''}</div>` : '';
    if (top.dataset.k !== topKey) {
      const potEl = top.querySelector('.pk-pot-n');
      if (potEl && pot > 0 && !!pots === !!top.querySelector('small')) countTo(potEl, pot);
      else { top.innerHTML = topHtml; const n2 = top.querySelector('.pk-pot-n'); if (n2) { n2.dataset.v = pot; n2.textContent = fmt(pot); } }
      top.dataset.k = topKey;
    }
  } else {
    topKey = r ? `labels:${h.n}` : 'none';
    if (top.dataset.k !== topKey) {
      top.dataset.k = topKey;
      top.innerHTML = r && r.labels && r.labels.length ? `<div class="pk-labels">${r.labels.map(l => `<span class="pk-label l-${l.key.split('.').pop()}">${esc(labelText(l))}</span>`).join('')}</div>` : '';
    }
  }
  // below the board
  const banner = el.querySelector('.pk-banner');
  const b = bannerHtml(paid);
  if (banner.dataset.k !== b.key) {
    banner.dataset.k = b.key;
    banner.innerHTML = b.html;
  }
}

function bannerHtml(paid) {
  const g = G();
  const h = H();
  if (!h) {
    const seat = mySeat();
    const msg = state.phase === 'ended' ? t('pk.w.ended') : g.paused ? t('pk.w.paused') : seat && seat.stack === 0 && state.settings.rebuy ? t('pk.w.rebuy') : t('pk.w.players');
    return { key: 'wait:' + msg, html: `<span class="pk-wait">${esc(msg)}</span>` };
  }
  const r = h.result;
  if (h.stage === 'runout') return { key: `runout:${h.n}:${h.squeeze}`, html: `<span class="pk-allin">${esc(t('pk.b.allin'))}</span>` };
  if (h.stage !== 'done' || !r || !paid) return { key: `street:${h.n}:${h.street}`, html: h.street !== 'preflop' && h.stage === 'betting' ? `<span class="pk-street">${esc(t('pk.street.' + h.street))}</span>` : '' };
  // pots with the same winners make one line
  const pots = [];
  for (const p of r.pots) {
    const same = pots.find(q => q.winners.join() === p.winners.join());
    if (same) same.amount += p.amount; else pots.push({ ...p });
  }
  const lines = pots.map((p, i) => {
    const who = p.winners.map(nameOf).join(', ');
    const best = !r.uncontested && r.best[p.winners[0]] ? ` — ${handName(r.best[p.winners[0]])}` : '';
    const key = p.winners.length > 1 ? 'pk.b.split' : 'pk.b.wins';
    return `<div class="pk-res ${i ? 'side' : ''}">${esc(t(key, { name: who, n: fmt(p.amount) }))}${esc(best)}</div>`;
  }).join('');
  const rab = h.rabbit ? rabbitLine(h) : '';
  return { key: `res:${h.n}:${!!h.rabbit}:${lang}:${prefs.inBB}`, html: `${lines}${rab}` };
}
function labelText(l) {
  const p = l.params || {};
  return t(l.key, { ...p, name: p.pid ? nameOf(p.pid) : '', other: p.other ? nameOf(p.other) : '' });
}
// the rabbit hunt: what my hand would have made
function rabbitLine(h) {
  const mine = h.hole[myId()];
  const full = [...h.board, ...h.rabbit.cards];
  const b = mine ? PH_best([...mine, ...full]) : null;
  return `<div class="pk-rabbit">${rabbitIco} ${esc(t('pk.b.rabbit', { name: nameOf(h.rabbit.by) }))}${b ? ` · ${esc(t('pk.b.wouldHave', { hand: handName(b) }))}` : ''}</div>`;
}
const rabbitIco = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3c-1 3 0 7 2 9M15 3c1 3 0 7-2 9"/><ellipse cx="12" cy="16" rx="6" ry="5"/><circle cx="10" cy="15" r=".6" fill="currentColor"/><circle cx="14" cy="15" r=".6" fill="currentColor"/></svg>';

// ---------- the dock: my hand, what I can do ----------
function renderDock() {
  const g = G();
  const h = g.hand;
  const dock = $('#pkDock');
  const me = myId();
  const seat = mySeat();
  const hole = h && h.hole[me];
  const playing = state.phase === 'playing';
  // left: my hand — its name only; reading the odds is the player's job
  let info = '';
  if (hole) {
    const board = h.board;
    const label = t(h.folded[me] ? 'pk.d.folded' : board.length >= 3 ? 'pk.d.yourHand' : 'pk.d.start');
    const b = board.length >= 3 ? PH_best([...hole, ...board]) : null;
    info = `<div class="pk-mine"><span class="muted small-text">${esc(label)}</span><b class="pk-hand-name ${b ? 'cat-' + b.cat : ''}">${esc(b ? handName(b) : startName(hole))}</b></div>`;
  } else if (seat) {
    info = `<div class="pk-mine"><span class="muted small-text">${esc(t('pk.d.stack'))}</span><b class="pk-hand-name">${fmt(seat.stack)}</b></div>`;
  } else {
    info = `<div class="pk-mine"><span class="muted small-text">${esc(t('ui.watchingNote'))}</span></div>`;
  }
  // right: actions
  let right = '';
  if (myTurn()) right = actionsHtml();
  else if (playing && h && h.stage === 'betting' && inHand() && !h.allIn[me]) right = preHtml();
  else right = extrasHtml();
  const html = `<div class="pk-dock-left">${info}</div><div class="pk-dock-right">${right}</div>`;
  if (dock.dataset.html === html) return;
  if (dock.contains(document.activeElement) && document.activeElement.id === 'raiseRange' && myTurn()) return;
  dock.dataset.html = html;
  dock.innerHTML = html;
  bindDock();
}
function startName(hole) {
  const R = 'AKQJT98765432';
  const [x, y] = hole.slice().sort((a, b) => R.indexOf(a[0]) - R.indexOf(b[0]));
  if (x[0] === y[0]) return t('pk.d.pocket', { r: t('pk.rs.' + x[0]) });
  return `${rankText(x[0])}-${rankText(y[0])} ${t(x[1] === y[1] ? 'pk.d.suited' : 'pk.d.offsuit')}`;
}

function actionsHtml() {
  const h = H();
  const o = h.options;
  const key = `${h.n}:${h.street}:${h.currentBet}:${h.actions.length}`;
  if (raise.key !== key) raise = { key, to: o.minTo };
  raise.to = Math.max(o.minTo, Math.min(o.maxTo, raise.to));
  const presets = presetList(h, o);
  const allInOnly = o.minTo >= o.maxTo;
  const left = h.actEndsAt ? Math.max(0, Math.ceil((h.actEndsAt - now()) / 1000)) : null;
  return `<div class="pk-actions">
    ${o.canRaise && !allInOnly ? `<div class="pk-sizing">
      <div class="pk-presets">${presets.map(p => `<button class="ghost small" data-preset="${p.to}">${esc(p.label)}</button>`).join('')}</div>
      <div class="pk-slider"><button class="ghost small icon-only" data-step="-1">−</button>
        <input id="raiseRange" type="range" min="${o.minTo}" max="${o.maxTo}" step="${Math.max(1, Math.floor(bb() / 2))}" value="${raise.to}">
        <button class="ghost small icon-only" data-step="1">+</button>
        <input id="raiseInput" type="number" min="${o.minTo}" max="${o.maxTo}" value="${raise.to}"></div>
    </div>` : ''}
    <div class="pk-buttons">
      <button class="pk-b fold" data-act="fold"><b>${esc(t('pk.btn.fold'))}</b><small>F</small></button>
      ${o.canCheck ? `<button class="pk-b chk" data-act="check"><b>${esc(t('pk.btn.check'))}</b><small>C</small></button>`
        : `<button class="pk-b call" data-act="call"><b>${esc(t(o.toCall >= h.options.maxTo - h.bets[myId()] ? 'pk.btn.callAllIn' : 'pk.btn.call'))}</b><span>${fmt(o.toCall)}</span><small>C</small></button>`}
      ${o.canRaise ? (allInOnly
        ? `<button class="pk-b raise" data-act="allin"><b>${esc(t('pk.btn.allin'))}</b><span>${fmt(o.maxTo)}</span><small>R</small></button>`
        : `<button class="pk-b raise" data-act="raise"><b>${esc(t(raise.to >= o.maxTo ? 'pk.btn.allin' : o.isBet ? 'pk.btn.bet' : 'pk.btn.raiseTo'))}</b><span id="raiseLabel">${fmt(raise.to)}</span><small>R</small></button>`) : ''}
    </div>
    ${left !== null ? `<div class="pk-clock" id="pkClock">${left}</div>` : ''}
  </div>`;
}
function presetList(h, o) {
  const pot = h.pot + o.toCall;
  const big = h.blinds.bb;
  const list = [];
  const clamp = v => Math.max(o.minTo, Math.min(o.maxTo, Math.round(v)));
  if (h.street === 'preflop' && h.currentBet <= big) {
    for (const x of [2.5, 3, 4]) list.push({ label: `${x}BB`, to: clamp(x * big) });
  } else if (h.street === 'preflop') {
    for (const x of [2.5, 3]) list.push({ label: `${x}×`, to: clamp(x * h.currentBet) });
  } else {
    for (const [f, label] of [[0.33, '⅓'], [0.5, '½'], [0.75, '¾']]) list.push({ label, to: clamp(h.currentBet + f * pot) });
  }
  list.push({ label: t('pk.btn.pot'), to: clamp(h.currentBet + pot) });
  list.push({ label: t('pk.btn.max'), to: o.maxTo });
  return list.filter((p, i, a) => a.findIndex(q => q.to === p.to) === i);
}
// before my turn: check/fold, check, call this much, call anything
function preHtml() {
  const h = H();
  const me = myId();
  const toCall = Math.min(h.currentBet - h.bets[me], mySeat().stack);
  const opts = toCall > 0 ? [['fold', t('pk.pre.fold')], ['call', t('pk.pre.call', { n: fmt(toCall) })], ['callany', t('pk.pre.callAny')]]
    : [['checkfold', t('pk.pre.checkFold')], ['check', t('pk.pre.check')], ['callany', t('pk.pre.callAny')]];
  if (pre && (pre.n !== h.n || pre.street !== h.street || (pre.type === 'call' && pre.amt !== toCall))) pre = null;
  return `<div class="pk-pre"><span class="muted small-text">${esc(t('pk.pre.title', { name: nameOf(h.toAct) }))}</span>
    <div class="pk-pre-row">${opts.map(([k, label]) => `<button class="pk-pre-btn ${pre && pre.type === k ? 'on' : ''}" data-pre="${k}" data-amt="${toCall}"><i></i>${esc(label)}</button>`).join('')}</div></div>`;
}
// between hands and out of hands: show my cards, the rabbit hunt, sit out / back, rebuy, take a seat
function extrasHtml() {
  const g = G();
  const h = g.hand;
  const me = myId();
  const seat = mySeat();
  const btns = [];
  if (state.phase !== 'playing') return isHost() ? `<button class="primary" data-x="restart">${esc(t('pk.backToLobby'))}</button>` : '';
  if (h && h.stage === 'done' && h.hole[me] && !h.shown[me]) btns.push(`<button data-x="show">${esc(t('pk.x.show'))}</button>`);
  if (h && h.stage === 'done' && state.settings.rabbit && h.board.length < 5 && !h.rabbit) btns.push(`<button data-x="rabbit">${rabbitIco} ${esc(t('pk.x.rabbit'))}</button>`);
  if (seat) {
    // all-in: wait for the cards; the rebuy comes only once the hand is lost
    const pending = h && h.seats.includes(me) && !h.folded[me] && (h.stage !== 'done' || (h.result && !resultShown(h)));
    if (seat.stack === 0 && pending) btns.push(`<span class="muted small-text">${esc(t('pk.x.allInWait'))}</span>`);
    else if (seat.stack === 0 && state.settings.rebuy) btns.push(`<button class="primary" data-x="rebuy">${esc(t('pk.x.rebuy', { n: fmt(state.settings.startStack) }))}</button>`);
    else if (seat.stack === 0) btns.push(`<span class="muted">${esc(t('pk.x.out'))}</span>`);
    else if (seat.sitOut) btns.push(`<button class="primary" data-x="back">${esc(t('pk.x.back'))}</button>`);
    else btns.push(`<button class="ghost small" data-x="sitout">${esc(t('pk.x.sitOut'))}</button>`);
  } else if (state.me.spectator && state.settings.lateJoin && g.order.length < state.maxPlayers) {
    btns.push(`<button class="primary" data-x="sit">${esc(t('pk.x.sit', { n: fmt(state.settings.startStack) }))}</button>`);
  }
  if (h && h.stage === 'betting' && h.folded[me]) btns.unshift(`<span class="muted small-text">${esc(t('pk.x.waitNext'))}</span>`);
  return `<div class="pk-extras">${btns.join('')}</div>`;
}

function bindDock() {
  const h = H();
  for (const b of $$('#pkDock [data-act]')) b.onclick = () => doAct(b.dataset.act);
  for (const b of $$('#pkDock [data-preset]')) b.onclick = () => setRaise(Number(b.dataset.preset));
  for (const b of $$('#pkDock [data-step]')) b.onclick = () => setRaise(raise.to + Number(b.dataset.step) * Math.max(1, h.blinds.bb));
  const range = $('#raiseRange');
  if (range) range.oninput = () => setRaise(Number(range.value), 'range');
  const inp = $('#raiseInput');
  if (inp) {
    inp.onchange = () => setRaise(Number(inp.value), 'input');
    inp.onkeydown = e => { if (e.key === 'Enter') { setRaise(Number(inp.value), 'input'); doAct('raise'); } };
  }
  for (const b of $$('#pkDock [data-pre]')) {
    b.onclick = () => {
      pre = pre && pre.type === b.dataset.pre ? null : { type: b.dataset.pre, amt: Number(b.dataset.amt), n: h.n, street: h.street };
      renderDock();
    };
  }
  for (const b of $$('#pkDock [data-x]')) {
    b.onclick = async () => {
      const x = b.dataset.x;
      if (x === 'show') send('show');
      else if (x === 'rabbit') send('rabbit');
      else if (x === 'rebuy') send('rebuy');
      else if (x === 'sit') send('sit');
      else if (x === 'back') send('sitOut', { on: false });
      else if (x === 'sitout') send('sitOut', { on: true });
      else if (x === 'restart') send('restart');
    };
  }
}
function setRaise(v, from) {
  const o = H() && H().options;
  if (!o) return;
  raise.to = Math.max(o.minTo, Math.min(o.maxTo, Math.round(v) || o.minTo));
  const range = $('#raiseRange');
  const inp = $('#raiseInput');
  if (range && from !== 'range') range.value = raise.to;
  if (inp && from !== 'input') inp.value = raise.to;
  const lbl = $('#raiseLabel');
  if (lbl) {
    lbl.textContent = fmt(raise.to);
    lbl.previousElementSibling.textContent = t(raise.to >= o.maxTo ? 'pk.btn.allin' : o.isBet ? 'pk.btn.bet' : 'pk.btn.raiseTo');
  }
}
async function doAct(type) {
  if (!myTurn()) return;
  const o = H().options;
  pre = null;
  if (type === 'raise') {
    if (raise.to >= o.maxTo) return send('act', { type: 'allin' });
    return send('act', { type: 'raise', amount: raise.to });
  }
  if (type === 'fold' && o.canCheck && !(await askConfirm({ title: t('pk.btn.fold'), text: t('pk.foldFree'), ok: t('pk.btn.fold'), danger: true }))) return;
  send('act', { type });
}
// a pre-selected action fires when the turn comes
function autoPre() {
  if (!pre || !myTurn()) return;
  const h = H();
  const o = h.options;
  const p = pre;
  pre = null;
  if (p.n !== h.n || p.street !== h.street) return;
  if (p.type === 'checkfold') return send('act', { type: o.canCheck ? 'check' : 'fold' });
  if (p.type === 'check') { if (o.canCheck) send('act', { type: 'check' }); return; }
  if (p.type === 'fold') return send('act', { type: o.canCheck ? 'check' : 'fold' });
  if (p.type === 'call') { if (o.toCall === p.amt) send('act', { type: 'call' }); else if (o.canCheck) send('act', { type: 'check' }); return; }
  if (p.type === 'callany') return send('act', { type: o.canCheck ? 'check' : 'call' });
}
document.addEventListener('keydown', e => {
  if (!myTurn() || e.metaKey || e.ctrlKey || e.altKey) return;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement && document.activeElement.tagName) && document.activeElement.type !== 'range') return;
  if ($('.overlay:not(.hidden)')) return;
  const k = e.key.toLowerCase();
  const o = H().options;
  if (k === 'f') doAct('fold');
  else if (k === 'c') doAct(o.canCheck ? 'check' : 'call');
  else if (k === 'r' && o.canRaise) doAct(o.minTo >= o.maxTo ? 'allin' : 'raise');
});

// ---------- the side: hand history, the hands cheat sheet, the session ----------
let sideTab = prefs.tab || null;
for (const b of $$('[data-tab]')) b.onclick = () => { sideTab = b.dataset.tab; prefs.tab = sideTab; savePrefs(); renderSide(); };
function renderSide() {
  // new players see the hands first
  if (!sideTab) sideTab = account && account.pokerStats && account.pokerStats.hands >= 150 ? 'hands' : 'cheat';
  for (const b of $$('[data-tab]')) b.classList.toggle('active', b.dataset.tab === sideTab);
  const body = $('#pkSide');
  if (sideTab === 'cheat') body.innerHTML = cheatHtml(currentCat());
  else if (sideTab === 'table') body.innerHTML = sessionHtml();
  else body.innerHTML = handsHtml();
  for (const el of $$('#pkSide [data-hand]')) el.onclick = () => openHand(Number(el.dataset.hand));
  for (const el of $$('#pkSide [data-pref]')) el.onchange = () => { prefs[el.dataset.pref] = el.checked; savePrefs(); render(); };
}
function currentCat() {
  const h = H();
  const hole = h && h.hole[myId()];
  if (!hole) return null;
  return h.board.length >= 3 ? PH_best([...hole, ...h.board]).cat : hole[0][0] === hole[1][0] ? 1 : 0;
}
const CHEAT = [
  ['royal', 'As Ks Qs Js Ts', 9, 0.0032],
  ['straightFlush', '9h 8h 7h 6h 5h', 8, 0.0279],
  ['quads', 'Qc Qd Qh Qs 7d', 7, 0.168],
  ['full', 'Kh Kd Ks 4c 4h', 6, 2.6],
  ['flush', 'Ad Jd 8d 6d 2d', 5, 3.03],
  ['straight', 'Tc 9d 8s 7h 6c', 4, 4.62],
  ['trips', '7s 7h 7d Kc 2s', 3, 4.83],
  ['twoPair', 'Jh Jc 4s 4d Ah', 2, 23.5],
  ['pair', 'Ac Ad 9s 6h 3c', 1, 43.8],
  ['high', 'Ah Jd 8c 5s 3h', 0, 17.4],
];
function cheatHtml(cat) {
  const catOf = (k, c) => (k === 'royal' ? 9 : c);
  const mine = cat === 8 ? null : cat;
  return `<div class="pk-cheat">
    <p class="muted small-text">${esc(t('pk.cheat.intro'))}</p>
    <ol class="pk-ranks">${CHEAT.map(([k, cards, c, odds]) => `<li class="${mine !== null && catOf(k, c) === mine ? 'now' : ''}">
      <div class="pk-rank-head"><b>${esc(t('pk.cat.' + k))}</b><span class="muted small-text">${esc(t('pk.cheat.odds', { p: odds }))}</span></div>
      <div class="pk-rank-cards">${cards.split(' ').map(x => cardHtml(x, { cls: 'xs' })).join('')}</div>
      <span class="muted small-text">${esc(t('pk.cat.' + k + '.text'))}</span></li>`).join('')}</ol>
    <h4>${esc(t('pk.cheat.tipsTitle'))}</h4>
    <ul class="pk-tips">${[1, 2, 3, 4, 5].map(i => `<li>${esc(t('pk.cheat.tip' + i))}</li>`).join('')}</ul>
  </div>`;
}
function sessionHtml() {
  const g = G();
  const start = state.settings.startStack;
  const rows = g.order.map(pid => ({ pid, s: g.seats[pid] })).map(x => ({ ...x, net: x.s.stack - x.s.buyins * start })).sort((a, b) => b.net - a.net);
  return `<div class="pk-session">
    <div class="pk-facts">
      <span>${esc(t('pk.blinds', { sb: fmtRaw(g.blinds.sb), bb: fmtRaw(g.blinds.bb) }))}${g.blinds.ante ? ` · ${esc(t('pk.ante', { n: fmtRaw(g.blinds.ante) }))}` : ''}</span>
      ${g.nextLevelIn !== null ? `<span class="muted">${esc(t('pk.nextLevel', { n: g.nextLevelIn + 1 }))}</span>` : ''}
      ${g.biggest ? `<span class="muted">${esc(t('pk.biggest', { n: fmtRaw(g.biggest.amount), name: nameOf(g.biggest.pid), hand: g.biggest.n }))}</span>` : ''}
    </div>
    <table class="pk-standings"><thead><tr><th></th><th>${esc(t('pk.col.stack'))}</th><th>${esc(t('pk.col.buyins'))}</th><th>${esc(t('pk.col.net'))}</th></tr></thead>
    <tbody>${rows.map(x => `<tr class="${x.pid === myId() ? 'me' : ''}"><td>${esc(nameOf(x.pid))}</td><td>${fmt(x.s.stack)}</td><td>${x.s.buyins}</td><td class="${x.net > 0 ? 'pos' : x.net < 0 ? 'neg' : ''}">${x.net > 0 ? '+' : ''}${fmt(x.net)}</td></tr>`).join('')}</tbody></table>
    <h4>${esc(t('pk.view'))}</h4>
    <label class="check"><input type="checkbox" class="switch" data-pref="fourColor" ${prefs.fourColor ? 'checked' : ''}> <span>${esc(t('pk.pref.fourColor'))}</span></label>
    <label class="check"><input type="checkbox" class="switch" data-pref="inBB" ${prefs.inBB ? 'checked' : ''}> <span>${esc(t('pk.pref.inBB'))}</span></label>
  </div>`;
}
// the current hand's actions, then the hands before it
function handsHtml() {
  const g = G();
  const h = g.hand;
  const cur = h && h.stage !== 'done' ? `<div class="pk-live"><h4>${esc(t('pk.handN', { n: h.n }))}</h4>${actionsLog(h)}</div>` : '';
  const list = g.history.slice().reverse().map(x => {
    const mine = x.hole[myId()];
    const net = x.result.net ? x.result.net[myId()] : undefined;
    const w = x.result.pots[0].winners.map(nameOf).join(', ');
    return `<li class="pk-hist" data-hand="${x.n}">
      <span class="pk-hist-n">#${x.n}</span>
      <span class="pk-hist-cards">${mine ? mine.map(c => cardHtml(c, { cls: 'xs' })).join('') : ''}</span>
      <span class="pk-hist-board">${x.board.map(c => cardHtml(c, { cls: 'xxs' })).join('')}</span>
      <span class="pk-hist-who"><b>${esc(w)}</b><small class="muted">${fmt(x.result.pots.reduce((s, p) => s + p.amount, 0))}</small></span>
      ${net !== undefined ? `<span class="pk-hist-net ${net > 0 ? 'pos' : net < 0 ? 'neg' : ''}">${net > 0 ? '+' : ''}${fmt(net)}</span>` : '<span></span>'}
    </li>`;
  }).join('');
  return `${cur}${list ? `<ul class="pk-hist-list">${list}</ul>` : `<p class="muted small-text">${esc(t('pk.noHands'))}</p>`}`;
}
function actionsLog(h) {
  const streets = ['preflop', 'flop', 'turn', 'river'];
  const boardAt = { flop: h.board.slice(0, 3), turn: h.board.slice(3, 4), river: h.board.slice(4, 5) };
  return streets.map(s => {
    const acts = h.actions.filter(a => a.s === s && a.a !== 'ante');
    if (!acts.length && !(boardAt[s] && boardAt[s].length)) return '';
    return `<div class="pk-log-street"><span class="pk-log-s">${esc(t('pk.street.' + s))}</span>${boardAt[s] ? boardAt[s].map(c => cardHtml(c, { cls: 'xxs' })).join('') : ''}</div>
      <ul class="pk-log">${acts.map(a => `<li><b>${esc(nameOf(a.pid))}</b> ${esc(actionText(a))}</li>`).join('')}</ul>`;
  }).join('');
}

function openHand(n) {
  const x = G().history.find(r => r.n === n);
  if (!x) return;
  const r = x.result;
  $('#handTitle').textContent = `${t('pk.handN', { n: x.n })} · ${t('pk.blinds', { sb: fmtRaw(x.blinds.sb), bb: fmtRaw(x.blinds.bb) })}`;
  const players = x.seats.map(pid => {
    const cards = x.hole[pid];
    const best = r.best && r.best[pid];
    const net = r.net ? r.net[pid] : 0;
    return `<li class="${r.pots.some(p => p.winners.includes(pid)) ? 'won' : ''}"><b>${esc(nameOf(pid))}</b>${pid === x.button ? ' <span class="pk-pos">D</span>' : ''}
      <span class="pk-hist-cards">${cards ? cards.map(c => cardHtml(c, { cls: 'xs' })).join('') : backHtml('xs') + backHtml('xs')}</span>
      ${best ? `<span class="muted small-text">${esc(handName(best))}</span>` : ''}<span class="spacer"></span>
      <span class="${net > 0 ? 'pos' : net < 0 ? 'neg' : ''}">${net > 0 ? '+' : ''}${fmt(net)}</span></li>`;
  }).join('');
  const eqRows = r.history && r.history.length ? `<h4>${esc(t('pk.eqTitle'))}</h4><table class="pk-eq-table"><thead><tr><th></th>${r.history.map(e => `<th>${esc(t('pk.street.' + e.street))}</th>`).join('')}</tr></thead>
    <tbody>${r.pots[0].eligible.map(pid => `<tr><td>${esc(nameOf(pid))}</td>${r.history.map(e => `<td>${e.eq[pid] !== undefined ? Math.round(e.eq[pid] * 100) + '%' : '—'}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '';
  const labels = (r.labels || []).map(l => `<span class="pk-label l-${l.key.split('.').pop()}">${esc(labelText(l))}</span>`).join('');
  $('#handBody').innerHTML = `
    <div class="pk-board sm">${x.board.map(c => cardHtml(c, { cls: 'sm' })).join('')}${x.rabbit ? x.rabbit.cards.map(c => cardHtml(c, { cls: 'sm rabbit' })).join('') : ''}</div>
    ${labels ? `<div class="pk-labels">${labels}</div>` : ''}
    <ul class="pk-hand-players">${players}</ul>
    ${eqRows}
    <h4>${esc(t('pk.actions'))}</h4>${actionsLog(x)}
    ${x.fair ? `<p class="pk-fair-line muted small-text" title="${esc(t('pk.fair.commitHint'))}">🔒 ${esc(t('pk.fair.commit'))}: <code>${x.fair.commit.slice(0, 16)}…</code></p>` : ''}
    <div class="pk-hand-pots">${r.pots.map((p, i) => `<div>${esc(t(i ? 'pk.sidePot' : 'pk.mainPot', { n: fmt(p.amount) }))} → <b>${esc(p.winners.map(nameOf).join(', '))}</b></div>`).join('')}</div>`;
  $('#handSheet').classList.remove('hidden');
}
$('#handClose').onclick = () => closeOverlay('handSheet');
$('#cheatClose').onclick = () => closeOverlay('cheatSheet');

// ---------- provably fair deal ----------
// Our browser sends a fresh seed for every hand once it has seen the commitment to the server's
// seed for it, and remembers what it saw during the game: the check after the session compares
// the revealed seeds with this, not with what the server says later.
const FAIR_KEY = 'pk.fair';
let fairSeen = null;
let fairLast = '';
const randomHex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
function fairBook() {
  try { return JSON.parse(store.get(FAIR_KEY)) || { sent: {}, games: {} }; } catch { return { sent: {}, games: {} }; }
}
function fairSave(book) {
  // the last few sessions are enough
  const games = Object.keys(book.games);
  for (const id of games.slice(0, Math.max(0, games.length - 3))) delete book.games[id];
  const sent = Object.keys(book.sent);
  for (const c of sent.slice(0, Math.max(0, sent.length - 400))) delete book.sent[c];
  store.set(FAIR_KEY, JSON.stringify(book));
}
function fairOnState(s) {
  const seated = s.me && s.players.some(p => p.id === s.me.id);
  if (s.fairNext && s.fairNext !== fairSeen && seated) {
    fairSeen = s.fairNext;
    const seed = randomHex(16);
    const book = fairBook();
    book.sent[s.fairNext] = seed;
    fairSave(book);
    socket.emit('seed', { seed }, () => {});
  }
  const h = s.game && s.game.hand;
  if (!h || !h.fair || !s.gameId) return;
  const entry = { commit: h.fair.commit, clients: h.fair.clients, seats: h.seats, sbPid: h.sbPid, hole: h.hole, board: h.board, rabbit: h.rabbit ? h.rabbit.cards : null };
  const key = `${s.gameId}:${h.n}:${JSON.stringify(entry)}`;
  if (key === fairLast) return;
  fairLast = key;
  const book = fairBook();
  (book.games[s.gameId] = book.games[s.gameId] || {})[h.n] = entry;
  fairSave(book);
}

// one revealed hand against what we saw: the commitment, our seed in the mix, the cards
async function fairCheck(e, seen, sent, me) {
  const v = await PokerFair.verify(e);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const out = { n: e.n, v, commit: v.commitOk && (!seen || seen.commit === e.commit), seen: !!seen, seed: null, cards: null };
  // our seed is only in the hands we were dealt into
  if (sent[e.commit] && seen && seen.seats.includes(me)) out.seed = e.clients.includes(sent[e.commit]);
  if (seen) {
    out.commit = out.commit && same(seen.clients, e.clients);
    const from = seen.seats.indexOf(seen.sbPid);
    const dealt = seen.seats.map((_, k) => seen.seats[(from + k) % seen.seats.length]);
    const holeOk = Object.entries(seen.hole).every(([pid, c]) => same(c, v.hole[dealt.indexOf(pid)]));
    const boardOk = same(seen.board, v.board.slice(0, seen.board.length));
    const rabbitOk = !seen.rabbit || same(seen.rabbit, v.board.slice(seen.board.length, seen.board.length + seen.rabbit.length));
    out.cards = holeOk && boardOk && rabbitOk;
  }
  out.ok = out.commit && out.seed !== false && out.cards !== false;
  return out;
}

async function openFair() {
  $('#fairBody').innerHTML = `<p class="muted">${esc(t('pk.fair.checking'))}</p>`;
  $('#fairSheet').classList.remove('hidden');
  const res = await send('fairLog');
  if (!res.ok) return closeOverlay('fairSheet');
  const hands = res.result.hands;
  const book = fairBook();
  const seenGame = book.games[state.gameId] || {};
  const rows = [];
  for (const e of hands) rows.push(await fairCheck(e, seenGame[e.n], book.sent, myId()));
  const bad = rows.filter(r => !r.ok);
  const mark = x => (x === null ? `<span class="muted">—</span>` : x ? '<b class="pos">✓</b>' : '<b class="neg">✗</b>');
  $('#fairBody').innerHTML = `
    <p class="pk-fair-sum ${bad.length ? 'neg' : 'pos'}"><b>${esc(bad.length ? t('pk.fair.bad', { n: bad.length }) : t('pk.fair.allOk', { n: rows.length }))}</b></p>
    <p class="muted small-text">${esc(t('pk.fair.how'))}</p>
    <div class="pk-fair-actions"><button id="fairDownload" class="ghost small">${esc(t('pk.fair.download'))}</button>
      <button id="fairPage" class="ghost small">${esc(t('pk.fair.independent'))}</button></div>
    <table class="pk-fair-table"><thead><tr><th>#</th><th>${esc(t('pk.fair.col.commit'))}</th><th>${esc(t('pk.fair.col.seed'))}</th><th>${esc(t('pk.fair.col.cards'))}</th><th></th></tr></thead>
    <tbody>${rows.map(r => `<tr class="${r.ok ? '' : 'bad'}"><td>${r.n}</td><td>${mark(r.commit)}</td><td>${mark(r.seed)}</td>
      <td>${r.seen ? mark(r.cards) : `<span class="muted small-text">${esc(t('pk.fair.notSeen'))}</span>`}</td>
      <td class="pk-fair-board">${r.v.board.map(c => cardHtml(c, { cls: 'xs' })).join('')}</td></tr>`).join('')}</tbody></table>`;
  $('#fairPage').onclick = () => window.open('/poker/fair.html', '_blank', 'noopener');
  $('#fairDownload').onclick = () => {
    const blob = new Blob([JSON.stringify({ code: state.code, gameId: state.gameId, hands }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `poker-${state.code}-fair-log.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
}
$('#fairClose').onclick = () => closeOverlay('fairSheet');

// ---------- host controls ----------
function renderHost() {
  const box = $('#hostBox');
  const g = G();
  const show_ = isHost() && state.phase === 'playing';
  box.classList.toggle('hidden', !show_);
  if (!show_) return;
  box.innerHTML = `<button class="ghost small" id="pauseBtn">${esc(t(g.paused ? 'pk.host.resume' : 'pk.host.pause'))}</button>
    <button class="danger small" id="finishBtn" ${g.ending ? 'disabled' : ''}>${esc(t(g.ending ? 'pk.host.ending' : 'pk.host.finish'))}</button>`;
  $('#pauseBtn').onclick = () => send('pause', { on: !g.paused });
  $('#finishBtn').onclick = async () => {
    if (!(await askConfirm({ title: t('pk.host.finish'), text: t('pk.host.finishText'), danger: true }))) return;
    send('finish');
  };
}

// ---------- results ----------
function openResults() {
  const g = G();
  const st = g.final || [];
  $('#resultsBody').innerHTML = `<ol class="results pk-final">${st.map((x, i) => `<li class="${g.winners.includes(x.pid) ? 'first' : ''}">
    <span class="board-rank">${['🥇', '🥈', '🥉'][i] || i + 1}</span>${(() => { const p = member(x.pid) || { name: '?' }; return avatar(p.name, p.avatar, p.cos); })()}
    <b>${esc(nameOf(x.pid))}</b><span class="spacer"></span>
    <span class="muted small-text">${esc(t('pk.res.stack', { n: fmtRaw(x.stack), b: x.buyins }))}</span>
    <b class="${x.net > 0 ? 'pos' : x.net < 0 ? 'neg' : ''}">${x.net > 0 ? '+' : ''}${fmtRaw(x.net)}${g.usdt ? ` · ${g.usdt[x.pid] > 0 ? '+' : ''}${usd(g.usdt[x.pid])}` : ''}</b></li>`).join('')}</ol>
    ${g.biggest ? `<p class="muted">${esc(t('pk.biggest', { n: fmtRaw(g.biggest.amount), name: nameOf(g.biggest.pid), hand: g.biggest.n }))} · ${esc(t('pk.handsN', { n: g.handN }))}</p>` : ''}
    ${state.settings.bank === 'usdt' && g.settlement ? `<h4>${esc(t('pk.usdt.results'))}</h4>
      <ul class="pk-transfers">${g.settlement.map(x => `<li><b>${esc(nameOf(x.from))}</b> → <b>${esc(nameOf(x.to))}</b>: <span class="pk-usd">${usd(x.cents)}</span></li>`).join('') || `<li>${esc(t('pk.usdt.even'))}</li>`}</ul>
      <p class="muted small-text">${esc(t('pk.usdt.resultsHint'))}</p><button id="resPledges" class="ghost">${esc(t('pk.pl.title'))}</button>` : ''}
    ${g.history.some(x => x.fair) ? `<button id="resFair" class="ghost">🔒 ${esc(t('pk.fair.check'))}</button>` : ''}
    ${state.settings.bank === 'chips' ? `<p class="muted small-text">${esc(t('pk.chips.back'))}</p>` : ''}
    ${isHost() ? `<button id="toLobby" class="primary">${esc(t('pk.backToLobby'))}</button>` : ''}`;
  if (isHost()) $('#toLobby').onclick = () => { closeOverlay('results'); send('restart'); };
  if ($('#resPledges')) $('#resPledges').onclick = () => { closeOverlay('results'); openPledges(); };
  if ($('#resFair')) $('#resFair').onclick = () => { closeOverlay('results'); openFair(); };
  $('#results').classList.remove('hidden');
}
$('#resultsClose').onclick = () => closeOverlay('results');

function renderGame() {
  renderTable();
  renderDock();
  renderSide();
  renderHost();
  renderStickerBtn();
  if (state.phase === 'ended' && resultsShownFor !== state.gameId) { resultsShownFor = state.gameId; openResults(); }
}

// ---------- the clock, the countdowns ----------
function tick() {
  const h = state && state.game && state.game.hand;
  if (!h) return;
  const ring = $('#pkSeats .pk-seat.acting .pk-ring');
  if (ring && h.actEndsAt) ring.classList.toggle('low', h.actEndsAt - now() < 7000);
  const c = $('#pkClock');
  if (c && h.actEndsAt) {
    const s = Math.max(0, Math.ceil((h.actEndsAt - now()) / 1000));
    if (c.textContent !== String(s)) { c.textContent = s; if (s <= 5 && s > 0 && myTurn()) SFX.tick(); }
    c.classList.toggle('low', s <= 7);
  }
  const next = $('#pkCenter .pk-next');
  if (next && h.nextAt) next.textContent = t('pk.b.next', { s: Math.max(0, Math.ceil((h.nextAt - now()) / 1000)) });
}
setInterval(tick, 200);

// ---------- sounds on changes (the movement is in renderTable) ----------
function fxOnState(prev, s) {
  const a = prev && prev.game && prev.game.hand;
  const b = s.game && s.game.hand;
  if (!b) return;
  if (!a || a.n !== b.n) { SFX.deal(); pre = null; return; }
  for (const x of b.actions.slice(a.actions.length)) {
    if (x.a === 'check') SFX.check();
    else if (x.a === 'fold') SFX.fold();
    else if (['call', 'bet', 'raise', 'allin'].includes(x.a)) SFX.chips();
  }
}

// ---------- stickers ----------
function renderStickerBtn() {
  const b = $('#stickerBtn');
  if (!b.dataset.ready) {
    b.dataset.ready = '1';
    b.innerHTML = `${PK_STICKERS.svg('nh')}<span>${esc(t('pk.stickers'))}</span>`;
    b.onclick = e => { e.stopPropagation(); toggleStickers(); };
  }
  b.classList.toggle('hidden', !(state && state.me && state.phase !== 'lobby'));
}
function toggleStickers(force) {
  const pop = $('#stickerPop');
  const open = force !== undefined ? force : pop.classList.contains('hidden');
  if (!open) return pop.classList.add('hidden');
  pop.innerHTML = `<div class="pk-sticker-grid">${PK_STICKERS.ids.map(id => `<button class="pk-sticker" data-sticker="${id}" title="${esc(t('pk.st.' + id))}">${PK_STICKERS.svg(id)}<span>${esc(t('pk.st.' + id))}</span></button>`).join('')}</div>`;
  const r = $('#stickerBtn').getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(innerWidth - 340, r.left + r.width / 2 - 170))}px`;
  pop.style.bottom = `${innerHeight - r.top + 8}px`;
  pop.classList.remove('hidden');
  for (const b of pop.querySelectorAll('[data-sticker]')) b.onclick = () => { send('react', { sticker: b.dataset.sticker }); toggleStickers(false); };
}
document.addEventListener('pointerdown', e => { if (!e.target.closest('#stickerPop') && !e.target.closest('#stickerBtn')) $('#stickerPop').classList.add('hidden'); });
socket.on('reaction', r => {
  const seat = $(`#pkSeats .pk-seat[data-pid="${r.from}"]`);
  if (!seat || !PK_STICKERS.ids.includes(r.sticker)) return;
  seat.querySelector('.pk-sticker-say')?.remove();
  const el = document.createElement('div');
  el.className = 'pk-sticker-say';
  el.innerHTML = `${PK_STICKERS.svg(r.sticker)}<span>${esc(t('pk.st.' + r.sticker))}</span>`;
  seat.append(el);
  if (alertsOn) beep(880, 0, 0.08, 'sine', 0.04);
  setTimeout(() => el.classList.add('out'), 2600);
  setTimeout(() => el.remove(), 3000);
});

// ---------- leaderboard (poker stats) ----------
let boardTab = 'net';
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
    net: c => [c.net, `${c.net > 0 ? '+' : ''}${fmtRaw(c.net)}`],
    wins: c => [c.wins, c.wins],
    pot: c => [c.biggestPot, fmtRaw(c.biggestPot)],
    hands: c => [c.hands, fmtRaw(c.hands)],
    chips: (c, u) => [u.chips || 0, fmtRaw(u.chips || 0)],
  }[boardTab];
  const rows = boardUsers.filter(u => (boardTab === 'chips' ? u.chips !== null && u.chips !== undefined : u.pokerStats && u.pokerStats.games > 0)).map(u => ({ u, m: metric(u.pokerStats, u) })).sort((a, b) => b.m[0] - a.m[0]);
  $('#boardList').innerHTML = rows.length ? rows.map(({ u, m }, i) => `
    <li class="board-row ${account && u.id === account.id ? 'me' : ''}" data-player="${u.id}">
      <span class="board-rank">${['🥇', '🥈', '🥉'][i] || `<span class="rank">${i + 1}</span>`}</span>
      ${avatar(u.username, u.avatar, u.equipped)}
      <span class="board-id"><b class="${nameCls(u.equipped)}">${esc(u.username)}</b>${statusPill(u.score)}<span class="muted small-text">${esc(t('board.sub', { g: u.pokerStats.games, w: u.pokerStats.wins }))}</span></span>
      <span class="board-metric">${m[1]}</span>
    </li>`).join('') : `<p class="muted small-text">${esc(t('board.empty'))}</p>`;
  for (const row of $$('#boardList [data-player]')) row.onclick = () => openPlayer(row.dataset.player);
}
for (const b of $$('[data-board]')) b.onclick = () => { boardTab = b.dataset.board; renderBoardSheet(); };
$('#boardBtn').onclick = openBoard;
$('#homeBoard').onclick = openBoard;
$('#boardClose').onclick = () => closeOverlay('boardSheet');

const OVERLAYS = ['fairSheet', 'boardSheet', 'results', 'handSheet', 'cheatSheet', 'pledgeSheet', 'walletSheet'];
for (const id of OVERLAYS) $('#' + id).addEventListener('pointerdown', e => { if (e.target.id === id) closeOverlay(id); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { for (const id of OVERLAYS) closeOverlay(id); toggleStickers(false); } });
new ResizeObserver(() => document.documentElement.style.setProperty('--topbar-h', `${$('.topbar').offsetHeight}px`)).observe($('.topbar'));

// last, once everything above exists: the shared code may render right away
Site.init({
  game: 'poker',
  socket,
  urlRoom: () => urlRoom,
  hooks: {
    onAccount: () => { render(); refreshPledgeCount(); renderHomeWallet(); },
    onItems: () => render(),
    onLang: () => { settingsKey = ''; render(); },
    busy: () => !!(state && state.me && state.phase === 'playing' && inHand()),
    leave: async () => { if (state && state.me) await send('leave'); store.set(SESSION_KEY, null); },
  },
});
Voice.init({ socket, me: () => state && state.me && state.me.id, route: () => true, channel: () => 'all', transcripts: () => false });
$('#profileBtn').onclick = () => openProfile();
$('#homeProfile').onclick = () => openProfile();
applyStaticTranslations();
render();

// poker is 18+: asked once per browser
const AGE_KEY = 'pk.age18';
if (!store.get(AGE_KEY)) {
  askConfirm({ title: t('pk.age.title'), text: t('pk.age.text'), ok: t('pk.age.yes'), cancel: t('pk.age.no') }).then(yes => {
    if (yes) store.set(AGE_KEY, '1');
    else location.href = '/';
  });
}
