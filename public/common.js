'use strict';

// Shared by all the games (Mafia at /, Tycoon at /tycoon/, Find the spy at /spy/, Kingdoms at
// /kingdoms/, poker at /poker/): small helpers, the login, avatars and cosmetics, sounds and turn alerts, one profile
// window (stats for every game, wardrobe, account), the admin panel, gifts and the "back to my game" banner.
// A page loads i18n.js, then this file, then its own script, which calls Site.init().

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};
const AUTH_KEY = 'mafia.auth'; // one login for the whole site
// script errors go to our own server for the admin's stats tab: a few per page load, our files only
let errorsSent = 0;
function reportError(msg, src, line) {
  if (errorsSent >= 5 || (src && !src.startsWith(location.origin))) return;
  errorsSent += 1;
  try {
    const body = JSON.stringify({ msg: String(msg || '').slice(0, 300), src: src || '', line: line || 0, page: location.pathname });
    navigator.sendBeacon('/api/err', new Blob([body], { type: 'application/json' }));
  } catch {}
}
window.addEventListener('error', e => reportError(e.message, e.filename, e.lineno));
window.addEventListener('unhandledrejection', e => reportError(e.reason && (e.reason.stack || e.reason.message || e.reason), '', 0));
const ALERTS_KEY = 'mafia.alerts';
const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const pctOf = (a, b) => (b ? Math.round((100 * a) / b) : 0);
const money = n => `${Math.round(n).toLocaleString('ru-RU')} ₽`;
const svgIcon = paths => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
const COMMON_ICONS = {
  bell: svgIcon('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>'),
  bellOff: svgIcon('<path d="M8.7 3A6 6 0 0 1 18 8c0 2.9.5 5 1.2 6.5M17 17H3s3-2 3-9c0-.8.1-1.5.4-2.2"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0M3 3l18 18"/>'),
  up: svgIcon('<path d="M7 10v11H4V10zM7 10l4-7c1.7 0 2.6 1.2 2.2 2.8L12.5 9H19a2 2 0 0 1 2 2.3l-1.3 7.5A2.5 2.5 0 0 1 17.3 21H7"/>'),
  down: svgIcon('<path d="M17 14V3h3v11zM17 14l-4 7c-1.7 0-2.6-1.2-2.2-2.8L11.5 15H5a2 2 0 0 1-2-2.3l1.3-7.5A2.5 2.5 0 0 1 6.7 3H17"/>'),
  trophy: svgIcon('<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>'),
  hat: svgIcon('<path d="M4 17h16l-1.8-7.2c-.3-1-1.3-1.4-2.2-1l-1.9 1a3 3 0 0 1-2.2 0l-1.9-1c-.9-.4-1.9 0-2.2 1z"/><path d="M2 17.5h20"/>'),
  dice: svgIcon('<rect x="4" y="4" width="16" height="16" rx="3.5"/><circle cx="9" cy="9" r="1.1" fill="currentColor"/><circle cx="15" cy="15" r="1.1" fill="currentColor"/><circle cx="12" cy="12" r="1.1" fill="currentColor"/>'),
  table: svgIcon('<ellipse cx="12" cy="9" rx="9" ry="3.5"/><path d="M5 11.5V19M19 11.5V19M12 12.5V20"/>'),
  gear: svgIcon('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  book: svgIcon('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>'),
  eye: svgIcon('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: svgIcon('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/>'),
  list: svgIcon('<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>'),
  spy: svgIcon('<circle cx="7" cy="15" r="3.5"/><circle cx="17" cy="15" r="3.5"/><path d="M10.5 15h3M3 11l3.5-5h11L21 11"/>'),
  castle: svgIcon('<path d="M4 21V11l3 2V8l3 2V5l2-2 2 2v5l3-2v5l3-2v10z"/><path d="M10 21v-4a2 2 0 0 1 4 0v4"/>'),
  chip: svgIcon('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><path d="M12 3v4.5M12 16.5V21M3 12h4.5M16.5 12H21M5.6 5.6l3.2 3.2M15.2 15.2l3.2 3.2M18.4 5.6l-3.2 3.2M8.8 15.2l-3.2 3.2"/>'),
};
const ico = (name, cls = '') => `<span class="ui-ico ${cls}">${COMMON_ICONS[name]}</span>`;
// drawn icons instead of emoji in the site's chrome (trophy buttons, the game switcher)
for (const el of document.querySelectorAll('.trophy')) el.outerHTML = ico('trophy');
for (const a of document.querySelectorAll('#siteMenu a')) {
  const i = a.querySelector('.site-ico');
  const href = a.getAttribute('href');
  if (i) i.outerHTML = ico(href.includes('tycoon') ? 'dice' : href.includes('spy') ? 'spy' : href.includes('kingdoms') ? 'castle' : href.includes('poker') ? 'chip' : href.includes('blog') ? 'book' : 'hat', 'site-ico');
}
// the menu button (phones, and inside a room) names itself
if ($('#brandBtn')) $('#brandBtn').setAttribute('aria-label', t('nav.games'));

// The page's settings and hooks (filled in by Site.init)
const Site = {
  game: 'mafia', // or 'mono', 'spy', 'cit', 'poker'
  socket: null,
  baseTitle: document.title,
  home: false,
  ready: false, // the account check on page load is done
  urlRoom: () => '',
  hooks: {
    onAccount() {}, onLang() {}, onItems() {}, celebrate() {},
    busy: () => false, // in the middle of a game: a table's call shows a banner instead of moving
    leave: async () => {}, // leave the current room (before following the table to a new one)
  },
};
// the games: page, icon and name in one place
const GAME_INFO = { mafia: { path: '/mafia/', icon: 'hat', name: 'site.mafia' }, mono: { path: '/tycoon/', icon: 'dice', name: 'site.monopoly' }, spy: { path: '/spy/', icon: 'spy', name: 'site.spyfall' }, cit: { path: '/kingdoms/', icon: 'castle', name: 'site.citadels' }, poker: { path: '/poker/', icon: 'chip', name: 'site.poker' } };
const gameInfoOf = game => GAME_INFO[game] || GAME_INFO.mafia;
const gameTitle = game => t(gameInfoOf(game).name);
const gameUrl = (game, code) => `${gameInfoOf(game).path}?room=${code}&join=1`;
const gameIcon = game => ico(gameInfoOf(game).icon);

function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), 3500);
}

function send(event, payload = {}) {
  return new Promise(resolve => {
    Site.socket.emit(event, payload, res => {
      if (res && !res.ok && !res.quiet) toast(t(res.error.key, res.error.params));
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

// ---------- avatars, cosmetics, decency status ----------
let ITEMS = {}; // the cosmetics catalog: hats, frames, name colours, reactions
fetch('/api/items').then(r => r.json()).then(d => { ITEMS = d.items || {}; Site.hooks.onItems(); renderAccount(); }).catch(() => {});
const nameCls = cos => (cos && cos.name ? `nm ${cos.name.replace('.', '-')}` : '');
// initials on a colour derived from the name, so each player is recognisable at a glance
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
  // the hat is drawn in a tiny SVG so it scales with whatever size the avatar is
  const hat = cos && cos.hat && ITEMS[cos.hat]
    ? `<span class="hat"><svg viewBox="0 0 10 10" aria-hidden="true"><text x="5" y="8.6" font-size="8.6" text-anchor="middle">${ITEMS[cos.hat].emoji}</text></svg></span>`
    : '';
  const frame = cos && cos.frame ? cos.frame.replace('.', '-') : '';
  return hat || frame ? `<span class="cos ${frame}">${inner}${hat}</span>` : inner;
}
// decency status from likes minus dislikes, lowest to highest
const TIER_MIN = [-Infinity, -9, -4, -1, 2, 5, 10];
const tierOf = score => TIER_MIN.findLastIndex(min => (score || 0) >= min);
// (family mode hides decency statuses)
const statusPill = score => score === null || score === undefined || i18nVariant === 'family' ? '' : `<span class="status t${tierOf(score)}">${esc(t('tier.' + tierOf(score)))}</span>`;
// an admin-given title, shown under the name
const titleTag = title => (title ? `<span class="ptitle">${esc(title)}</span>` : '');
const THEMES = ['ocean', 'violet', 'sunset', 'forest', 'rose', 'mono'];

// ---------- sound and turn alerts ----------
let alertsOn = store.get(ALERTS_KEY) !== 'off';
let audioCtx = null;
// browsers only allow sound after the user has interacted with the page
document.addEventListener('pointerdown', () => {
  if (!audioCtx && window.AudioContext) audioCtx = new AudioContext();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}, { capture: true });

// one synthesized note (no sound files to load)
function tone({ f, f2, at = 0, dur = 0.5, type = 'sine', vol = 0.12, attack = 0.02, vib = 0, lowpass }) {
  if (!audioCtx) return;
  const now = audioCtx.currentTime + at;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(f, now);
  if (f2) osc.frequency.exponentialRampToValueAtTime(f2, now + dur);
  if (vib) {
    const lfo = audioCtx.createOscillator();
    const depth = audioCtx.createGain();
    lfo.frequency.value = 5.5;
    depth.gain.value = vib;
    lfo.connect(depth).connect(osc.frequency);
    lfo.start(now);
    lfo.stop(now + dur + 0.1);
  }
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(vol, now + attack);
  gain.gain.exponentialRampToValueAtTime(0.0008, now + dur);
  let out = osc.connect(gain);
  if (lowpass) {
    const lp = audioCtx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = lowpass;
    out = out.connect(lp);
  }
  out.connect(audioCtx.destination);
  osc.start(now);
  osc.stop(now + dur + 0.05);
}
const chime = () => [[660, 0], [990, 0.13]].forEach(([f, at]) => tone({ f, at, dur: 0.45, vol: 0.18 }));

function renderAlertsBtn() {
  const b = $('#alertsBtn');
  b.innerHTML = alertsOn ? COMMON_ICONS.bell : COMMON_ICONS.bellOff;
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

// The game is waiting on this player: chime and buzz once per new request, and blink the
// tab title until it's handled. need = { key, text } or null.
const turnAlert = { key: null, blink: null };
function updateTurnAlert(need) {
  if (need && need.key !== turnAlert.key && alertsOn) {
    chime();
    if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
  }
  turnAlert.key = need ? need.key : null;
  clearInterval(turnAlert.blink);
  if (!need) { document.title = Site.baseTitle; return; }
  const msg = `● ${need.text}`;
  document.title = msg;
  let on = true;
  turnAlert.blink = setInterval(() => {
    on = !on || !document.hidden;
    document.title = on ? msg : Site.baseTitle;
  }, 1000);
}

// ---------- site switcher (top-left menu) ----------
$('#brandBtn').onclick = e => { e.stopPropagation(); $('#siteMenu').classList.toggle('hidden'); };
document.addEventListener('pointerdown', e => { if (!e.target.closest('.brand-switch')) $('#siteMenu').classList.add('hidden'); });

// ---------- shared windows: profile, admin, gift ----------
document.body.insertAdjacentHTML('beforeend', `
  <div id="profile" class="overlay hidden" role="dialog" aria-modal="true">
    <div class="sheet player-sheet">
      <div class="sheet-head"><h2 id="profileTitle"></h2><button id="profileClose" class="ghost small" data-i18n="ui.close"></button></div>
      <div class="sheet-body player-body">
        <div id="profileTop" class="profile-top"></div>
        <div id="profileTabs" class="tabs profile-tabs" role="tablist"></div>
        <div id="profileBody" class="profile-tab-body"></div>
      </div>
    </div>
  </div>
  <div id="admin" class="overlay hidden" role="dialog" aria-modal="true">
    <div class="sheet admin-sheet">
      <div class="sheet-head"><h2 data-i18n="admin.title"></h2><button id="adminClose" class="ghost small" data-i18n="ui.close"></button></div>
      <div class="sheet-body">
        <div class="tabs" role="tablist">
          <button data-admin-tab="live" data-i18n="admin.tab.live"></button>
          <button data-admin-tab="users" data-i18n="admin.tab.users"></button>
          <button data-admin-tab="invites" data-i18n="admin.tab.invites"></button>
          <button data-admin-tab="features" data-i18n="admin.tab.features"></button>
          <button data-admin-tab="stats" data-i18n="admin.tab.stats"></button>
          <button data-admin-tab="blog" data-i18n="admin.tab.blog"></button>
        </div>
        <div id="adminBody" class="admin-body"></div>
      </div>
    </div>
  </div>
  <div id="renameMenu" class="mark-menu rename-menu hidden" role="dialog">
    <div id="renameTitle" class="mark-title"></div>
    <form id="renameForm" class="row">
      <input id="renameInput" maxlength="20" autocomplete="off">
      <button type="submit" class="primary small" data-i18n="rename.save"></button>
    </form>
    <p class="muted small-text" data-i18n="rename.hint"></p>
  </div>
  <div id="tableCall" class="table-call hidden" role="status"></div>
  <div id="giftBox" class="overlay gift-overlay hidden" role="dialog" aria-modal="true">
    <div class="gift-stage">
      <div class="gift-title" data-i18n="gift.title"></div>
      <button id="giftPresent" class="gift-present" type="button" aria-label="Open">🎁</button>
      <div id="giftItem" class="gift-item hidden"></div>
      <div id="giftName" class="gift-name"></div>
      <button id="giftDone" class="primary hidden" data-i18n="gift.done"></button>
    </div>
  </div>`);
const closeOverlay = id => $('#' + id).classList.add('hidden');
for (const id of ['profile', 'admin']) {
  $('#' + id).addEventListener('pointerdown', e => { if (e.target.id === id) closeOverlay(id); });
}
$('#profileClose').onclick = () => closeOverlay('profile');
$('#adminClose').onclick = () => closeOverlay('admin');
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  closeOverlay('profile');
  closeOverlay('admin');
  $('#siteMenu').classList.add('hidden');
});

// ---------- dialogs: a styled confirm, and a "save this" notice ----------
document.body.insertAdjacentHTML('beforeend', `<div id="askBox" class="overlay hidden" role="alertdialog" aria-modal="true">
  <div class="sheet ask-sheet"><div class="sheet-body"><h2 id="askTitle"></h2><p id="askText" class="muted"></p><div id="askExtra"></div>
  <div class="row ask-actions"><button id="askNo" class="ghost"></button><button id="askYes" class="primary"></button></div></div></div></div>`);
let askResolve = null;
function askConfirm({ title, text = '', ok, cancel, danger = false, extra = '', alert = false }) {
  if (askResolve) askResolve(false);
  $('#askTitle').textContent = title;
  $('#askText').textContent = text;
  $('#askExtra').innerHTML = extra;
  $('#askYes').textContent = ok || t(alert ? 'ui.ok' : 'ui.confirm');
  $('#askYes').className = danger ? 'danger' : 'primary';
  $('#askNo').textContent = cancel || t('ui.cancel');
  $('#askNo').classList.toggle('hidden', alert);
  $('#askBox').classList.remove('hidden');
  (alert ? $('#askYes') : $('#askNo')).focus(); // a stray Enter cancels rather than confirms
  return new Promise(resolve => { askResolve = resolve; });
}
function closeAsk(answer) {
  $('#askBox').classList.add('hidden');
  const r = askResolve;
  askResolve = null;
  if (r) r(answer);
}
$('#askYes').onclick = () => closeAsk(true);
$('#askNo').onclick = () => closeAsk(false);
$('#askBox').addEventListener('pointerdown', e => { if (e.target.id === 'askBox') closeAsk(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && askResolve) closeAsk(false); });

function showRecoveryCode(code, key) {
  askConfirm({
    title: t('recovery.title'), text: t(key), alert: true, ok: t('recovery.saved'),
    extra: `<div class="recovery-code"><code>${esc(code)}</code><button class="small" type="button" id="copyRecovery">${esc(t('ui.copy'))}</button></div>`,
  });
  $('#copyRecovery').onclick = () => copyText(code);
}

// ---------- settings menu (gear): language, sound, Halloween ----------
(() => {
  const top = $('.topbar');
  const langEl = $('#langSelect');
  langEl.insertAdjacentHTML('beforebegin', `<div class="settings-wrap"><button id="settingsBtn" class="icon-btn" type="button" aria-haspopup="true"></button>
    <div id="settingsMenu" class="settings-menu hidden" role="menu">
      <label class="set-row"><span data-i18n="settings.language"></span></label>
      <div class="set-row"><span data-i18n="settings.sound"></span></div>
      <button class="set-row set-link" id="rulesBtn" type="button"><span data-i18n="rules.title"></span>${ico('book')}</button>
    </div></div>`);
  const menu = $('#settingsMenu');
  menu.children[0].append(langEl);
  menu.children[1].append($('#alertsBtn'));
  const spooky = $('#spookyBtn');
  if (spooky) {
    menu.children[1].insertAdjacentHTML('afterend', '<div class="set-row"><span data-i18n="settings.halloween"></span></div>');
    menu.children[2].append(spooky);
  }
  $('#settingsBtn').innerHTML = COMMON_ICONS.gear;
  $('#settingsBtn').onclick = e => { e.stopPropagation(); menu.classList.toggle('hidden'); };
  document.addEventListener('pointerdown', e => { if (!e.target.closest('.settings-wrap')) menu.classList.add('hidden'); });
  $('#rulesBtn').onclick = () => { menu.classList.add('hidden'); openRules(); };
  void top;
})();

// ---------- show / hide password ----------
function addPasswordToggles(root = document) {
  for (const input of root.querySelectorAll('input[type="password"]:not([data-eye])')) {
    input.dataset.eye = '1';
    const wrap = document.createElement('span');
    wrap.className = 'pass-wrap';
    input.replaceWith(wrap);
    wrap.append(input);
    wrap.insertAdjacentHTML('beforeend', `<button type="button" class="pass-eye" aria-label="${esc(t('auth.showPassword'))}" title="${esc(t('auth.showPassword'))}">${COMMON_ICONS.eye}</button>`);
    const b = wrap.querySelector('.pass-eye');
    b.onclick = () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      b.innerHTML = show ? COMMON_ICONS.eyeOff : COMMON_ICONS.eye;
      input.focus();
    };
  }
}
addPasswordToggles();

// ---------- rules reference ----------
document.body.insertAdjacentHTML('beforeend', `<div id="rules" class="overlay hidden" role="dialog" aria-modal="true">
  <div class="sheet player-sheet"><div class="sheet-head"><h2 data-i18n="rules.title"></h2><button id="rulesClose" class="ghost small" data-i18n="ui.close"></button></div>
  <div class="sheet-body"><div class="tabs" role="tablist"><button data-rules="mafia" data-i18n="site.mafia"></button><button data-rules="mono" data-i18n="site.monopoly"></button><button data-rules="spy" data-i18n="site.spyfall"></button><button data-rules="cit" data-i18n="site.citadels"></button><button data-rules="poker" data-i18n="site.poker"></button></div>
  <div id="rulesBody" class="rules-body"></div></div></div></div>`);
let rulesTab = null;
function openRules(game) {
  rulesTab = game || rulesTab || Site.game;
  for (const b of $$('[data-rules]')) b.classList.toggle('active', b.dataset.rules === rulesTab);
  // line by line: "## " is a heading, "- " lines make a list, anything else is a paragraph
  let html = '';
  let list = false;
  for (const line of t('rules.' + rulesTab).split('\n').map(l => l.trim()).filter(Boolean)) {
    const item = line.startsWith('- ');
    if (list && !item) { html += '</ul>'; list = false; }
    if (line.startsWith('## ')) html += `<h3>${esc(line.slice(3))}</h3>`;
    else if (item) { if (!list) { html += '<ul>'; list = true; } html += `<li>${esc(line.slice(2))}</li>`; }
    else html += `<p>${esc(line)}</p>`;
  }
  $('#rulesBody').innerHTML = html + (list ? '</ul>' : '');
  $('#rules').classList.remove('hidden');
}
for (const b of $$('[data-rules]')) b.onclick = () => openRules(b.dataset.rules);
$('#rulesClose').onclick = () => closeOverlay('rules');
$('#rules').addEventListener('pointerdown', e => { if (e.target.id === 'rules') closeOverlay('rules'); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeOverlay('rules'); });

// ---------- a short explanation under each lobby setting that has one (key + ".hint") ----------
for (const el of document.querySelectorAll('#lobby label [data-i18n]')) {
  const key = el.dataset.i18n + '.hint';
  if (DICT.en[key]) el.closest('label').insertAdjacentHTML('beforeend', `<small class="hint" data-i18n="${key}"></small>`);
}
// and a "rules" link next to the lobby's setup heading
for (const h of document.querySelectorAll('#lobby .card-head')) {
  if (h.querySelector('h2')?.closest('.card')?.querySelector('#startBtn')) h.insertAdjacentHTML('beforeend', `<button class="ghost small rules-link" type="button">${ico('book')}<span data-i18n="rules.open"></span></button>`);
}
for (const b of document.querySelectorAll('.rules-link')) b.onclick = () => openRules();

// ---------- first visit: how this works ----------
const ONBOARD_KEY = 'site.onboarded';
function renderOnboarding() {
  let box = $('#onboarding');
  if (!box) {
    $('#playCard').insertAdjacentHTML('afterbegin', `<div id="onboarding" class="onboarding hidden"><b data-i18n="onboard.title"></b>
      <ol><li data-i18n="onboard.1"></li><li data-i18n="onboard.2"></li><li data-i18n="onboard.3"></li></ol>
      <div class="row"><button class="small" id="onboardRules" type="button" data-i18n="rules.open"></button><button class="ghost small" id="onboardOk" type="button" data-i18n="onboard.ok"></button></div></div>`);
    box = $('#onboarding');
    applyStaticTranslations(box);
    $('#onboardOk').onclick = () => { store.set(ONBOARD_KEY, '1'); box.classList.add('hidden'); };
    $('#onboardRules').onclick = () => openRules();
  }
  box.classList.toggle('hidden', !!store.get(ONBOARD_KEY) || !account);
}

// ---------- accounts ----------
let account = null; // the logged-in user's profile (see UserStore.publicProfile)
let authMode = 'login';

function setAccount(user, token) {
  if (token !== undefined) store.set(AUTH_KEY, token);
  if (user) store.set(HAD_ACCOUNT_KEY, '1');
  account = user;
  // reconnect so the server knows who this socket belongs to
  Site.socket.disconnect().connect();
  renderAccount();
}

// guest (just a name) | login | register | forgot (a reset link by email) | recover (the old recovery code) | reset (from the link)
const resetToken = new URLSearchParams(location.search).get('reset') || '';
if (/^[0-9a-f]{48}$/.test(resetToken)) authMode = 'reset';
// someone new to the site plays with just a name; anyone who has logged in here before sees log-in
const HAD_ACCOUNT_KEY = 'site.hadAccount';
if (authMode === 'login' && !store.get(AUTH_KEY) && !store.get(HAD_ACCOUNT_KEY)) authMode = 'guest';
const inviteCode = () => (new URLSearchParams(location.search).get('room') || '').toUpperCase();
// "By … you accept the terms and the privacy policy": signing up, or playing as a guest
function legalHtml(mode) {
  return `${esc(t(mode === 'guest' ? 'auth.legalGuest' : 'auth.legal'))} <a href="/terms/" target="_blank">${esc(t('auth.legalTerms'))}</a> ${esc(t('auth.legalAnd'))} <a href="/privacy/" target="_blank">${esc(t('auth.legalPrivacy'))}</a>.`;
}
function renderAuthMode() {
  const m = authMode;
  for (const b of $$('[data-auth-mode]')) b.classList.toggle('active', b.dataset.authMode === m);
  $('.auth-tabs').classList.toggle('hidden', m === 'reset');
  $('#authSubmit').textContent = t({ guest: inviteCode() ? 'auth.takeSeat' : 'auth.playNow', login: 'auth.login', register: 'auth.register', recover: 'auth.recoverSubmit', forgot: 'auth.sendLink', reset: 'auth.recoverSubmit' }[m]);
  $('#authPass').autocomplete = m === 'login' ? 'current-password' : 'new-password';
  $('#authPassLabel').textContent = t(m === 'recover' || m === 'reset' ? 'auth.newPassword' : 'auth.password');
  $('#authUserLabel').textContent = t(m === 'login' ? 'auth.userOrEmail' : m === 'guest' ? 'auth.yourName' : 'auth.username');
  $('#authUser').autocomplete = m === 'guest' ? 'nickname' : 'username';
  $('#authUser').closest('label').classList.toggle('hidden', m === 'forgot' || m === 'reset');
  $('#authPass').closest('label').classList.toggle('hidden', m === 'forgot' || m === 'guest');
  $('#authPass').required = m !== 'forgot' && m !== 'guest';
  $('#emailField').classList.toggle('hidden', m !== 'register' && m !== 'forgot');
  $('#authEmail').required = m === 'register' || m === 'forgot';
  $('#inviteField').classList.toggle('hidden', m !== 'register');
  $('#recoverField').classList.toggle('hidden', m !== 'recover');
  $('#forgotBtn').textContent = t(m === 'login' ? 'auth.forgot' : 'auth.backToLogin');
  $('#forgotBtn').classList.toggle('hidden', m === 'register' || m === 'guest');
  $('#codeBtn').classList.toggle('hidden', m !== 'forgot');
  const legal = document.getElementById('authLegal');
  if (legal) { legal.innerHTML = legalHtml(m); legal.classList.toggle('hidden', m !== 'register' && m !== 'guest'); }
  const hint = document.querySelector('#authCard .auth-hint');
  if (hint) hint.textContent = t(m === 'forgot' ? 'auth.forgotHint' : m === 'reset' ? 'auth.resetHint' : m === 'guest' ? 'auth.guestHint' : 'auth.hint');
}
// the password label, the recovery-code field and "Forgot password?" join the login form
// these labels change with the mode, so the page's static translation pass must leave them alone
for (const [el, id] of [[$('#authPass').closest('label').querySelector('span'), 'authPassLabel'], [$('#authUser').closest('label').querySelector('span'), 'authUserLabel'], [$('#authCard .auth-hint'), null]]) {
  if (!el) continue;
  if (id) el.id = id;
  el.removeAttribute('data-i18n');
}
$('#authUser').closest('label').insertAdjacentHTML('afterend', `<label id="emailField" class="field hidden"><span data-i18n="auth.email"></span>
  <input id="authEmail" name="email" type="email" maxlength="254" autocomplete="email" spellcheck="false"></label>
  <input id="authWebsite" name="website" tabindex="-1" autocomplete="off" class="hp-field" aria-hidden="true">`);
$('#inviteField').insertAdjacentHTML('afterend', `<label id="recoverField" class="field hidden"><span data-i18n="auth.recoveryCode"></span>
  <input id="authRecovery" maxlength="20" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX"></label>`);
$('#authSubmit').insertAdjacentHTML('afterend', '<button type="button" id="forgotBtn" class="link-btn"></button><button type="button" id="codeBtn" class="link-btn hidden" data-i18n="auth.haveCode"></button>');
$('.auth-tabs').insertAdjacentHTML('afterbegin', '<button type="button" data-auth-mode="guest" data-i18n="auth.play"></button>');
$('#forgotBtn').onclick = () => { authMode = authMode === 'login' ? 'forgot' : 'login'; renderAuthMode(); };
$('#codeBtn').onclick = () => { authMode = 'recover'; renderAuthMode(); };
for (const b of $$('[data-auth-mode]')) b.onclick = () => { authMode = b.dataset.authMode; renderAuthMode(); };
$('#authCard').addEventListener('submit', async e => {
  e.preventDefault();
  const mode = authMode;
  const body = { username: $('#authUser').value, email: $('#authEmail').value, password: $('#authPass').value, invite: $('#authInvite').value, code: $('#authRecovery').value, website: $('#authWebsite').value, lang };
  if (mode === 'reset') body.token = resetToken;
  if (mode === 'guest') body.name = body.username;
  const res = await api(mode, body);
  if (!res.ok) return;
  if (mode === 'forgot') {
    await askConfirm({ title: t('auth.linkSentTitle'), text: t('auth.linkSent'), alert: true });
    authMode = 'login';
    return renderAuthMode();
  }
  $('#authPass').value = '';
  $('#authRecovery').value = '';
  if (mode === 'reset') history.replaceState(null, '', location.pathname);
  if (mode === 'recover' || mode === 'reset') { authMode = 'login'; renderAuthMode(); }
  setAccount(res.user, res.token);
  toast(t(mode === 'reset' ? 'toast.passwordChanged' : 'toast.welcome', { name: res.user.username }), 'info');
  if (res.recoveryCode) showRecoveryCode(res.recoveryCode, mode === 'register' ? 'recovery.afterRegister' : 'recovery.afterReset');
  if (mode === 'register' && res.user.email) setTimeout(() => toast(t('auth.checkEmail', { email: res.user.email }), 'info'), 3800);
  joinPendingTable();
  // came from an invite link: straight into that room (the emit waits for the reconnect)
  if (inviteCode() && Site.socket) send('join', { code: inviteCode() });
});

// An invite link (?room=CODE) for someone not logged in: what they're joining, and who's there
async function renderInvite() {
  const code = inviteCode();
  let box = document.getElementById('inviteBanner');
  if (!code || account) { if (box) box.remove(); return; }
  const res = await fetch(`/api/invite?game=${encodeURIComponent(Site.game)}&code=${encodeURIComponent(code)}`).then(r => r.json()).catch(() => null);
  const room = res && res.room;
  if (!room) return;
  if (!box) { box = document.createElement('div'); box.id = 'inviteBanner'; box.className = 'invite-banner'; $('#authCard').prepend(box); }
  const names = room.players;
  const who = names.length ? t('invite.who', { names: names.slice(0, 3).join(', '), more: names.length > 3 ? t('invite.more', { n: names.length - 3 }) : '' }) : t('invite.empty');
  box.innerHTML = `<span class="invite-game">${gameIcon(Site.game)} ${esc(gameTitle(Site.game))} · <span class="code">${esc(code)}</span></span>
    <b class="invite-title">${esc(t('invite.title', { game: gameTitle(Site.game) }))}</b><span class="muted small-text">${esc(who)}</span>`;
}

// ---------- a guest's account: saved after a game, with everything they've played kept ----------
let saveOfferedFor = null;
// pages call this when a game ends (once per game); a guest is offered to keep their stats
Site.gameOver = function gameOver(gameKey) {
  if (!account || !account.guest || saveOfferedFor === gameKey || store.get('site.saveDismissed') === gameKey) return;
  saveOfferedFor = gameKey;
  setTimeout(() => openSaveAccount(gameKey), 2500);
};
function openSaveAccount(gameKey = null) {
  let sheet = document.getElementById('saveSheet');
  if (!sheet) {
    document.body.insertAdjacentHTML('beforeend', `<div id="saveSheet" class="overlay hidden" role="dialog" aria-modal="true" aria-labelledby="saveTitle">
      <div class="sheet save-sheet"><div class="sheet-head"><h2 id="saveTitle"></h2><button id="saveClose" class="ghost small" type="button"></button></div>
      <form id="saveForm" class="sheet-body save-body" autocomplete="on"></form></div></div>`);
    sheet = document.getElementById('saveSheet');
    sheet.addEventListener('pointerdown', e => { if (e.target === sheet) closeSave(); });
  }
  const closeSave = () => { sheet.classList.add('hidden'); if (gameKey) store.set('site.saveDismissed', gameKey); };
  $('#saveTitle').textContent = t('save.title');
  $('#saveClose').textContent = t('save.later');
  $('#saveClose').onclick = closeSave;
  const form = $('#saveForm');
  form.innerHTML = `<p class="muted">${esc(t('save.lead'))}</p>
    <ul class="save-perks"><li>${esc(t('save.perk.stats'))}</li><li>${esc(t('save.perk.chips'))}</li><li>${esc(t('save.perk.rating'))}</li><li>${esc(t('save.perk.tables'))}</li></ul>
    <label class="field"><span>${esc(t('auth.username'))}</span><input name="username" maxlength="20" autocomplete="username" value="${esc(account.username)}" required></label>
    <label class="field"><span>${esc(t('auth.email'))}</span><input name="email" type="email" maxlength="254" autocomplete="email" required></label>
    <label class="field"><span>${esc(t('auth.password'))}</span><input name="password" type="password" autocomplete="new-password" required></label>
    <button type="submit" class="primary big-btn">${esc(t('save.submit'))}</button>
    <p class="muted small-text">${legalHtml('register')}</p>`;
  addPasswordToggles(form);
  form.onsubmit = async e => {
    e.preventDefault();
    const r = await api('guest/save', { ...Object.fromEntries(new FormData(form).entries()), lang });
    if (!r.ok) return;
    sheet.classList.add('hidden');
    account = r.user;
    store.set(HAD_ACCOUNT_KEY, '1');
    renderAccount();
    toast(t('save.done', { name: r.user.username }), 'info');
    if (r.recoveryCode) showRecoveryCode(r.recoveryCode, 'recovery.afterRegister');
    setTimeout(() => toast(t('auth.checkEmail', { email: r.user.email }), 'info'), 4000);
  };
  sheet.classList.remove('hidden');
  form.querySelector('[name="email"]').focus();
}
// back from the confirmation link
if (qs0().get('verified')) {
  setTimeout(() => toast(t(qs0().get('verified') === '1' ? 'auth.verified' : 'auth.verifyFailed'), qs0().get('verified') === '1' ? 'info' : ''), 600);
  history.replaceState(null, '', location.pathname);
}
function qs0() { return new URLSearchParams(location.search); }

function renderAccount() {
  // a reset link shows its form even to someone logged in on this device
  $('#authCard').classList.toggle('hidden', (!!account && authMode !== 'reset') || !Site.ready);
  $('#playCard').classList.toggle('hidden', !account || !Site.ready || authMode === 'reset');
  $('#bootLoader').classList.toggle('hidden', Site.ready);
  $('#profileBtn').classList.toggle('hidden', !account);
  $('#boardBtn').classList.toggle('hidden', !account);
  document.body.dataset.theme = (account && account.theme) || '';
  document.body.classList.toggle('signed-in', !!account);
  if (account) document.getElementById('inviteBanner')?.remove();
  if (account) {
    $('#profileBtn').innerHTML = avatar(account.username, account.avatar, account.equipped);
    $('#profileBtn').title = t('profile.open');
    $('#homeProfile').innerHTML = `${avatar(account.username, account.avatar, account.equipped)}
      <span class="me-text"><b class="${nameCls(account.equipped)}">${esc(account.username)}</b>${statusPill(account.score)}</span>`;
    queueGifts(account.gifts);
  }
  Site.hooks.onAccount();
  renderOnboarding();
  refreshHome();
}

// the home screen's group parts: tables first (the "you're in a game" list skips their rooms)
async function refreshHome() {
  await loadTables();
  await renderActive();
}

async function refreshAccount() {
  const res = await api('me');
  if (res.ok) { account = res.user; renderAccount(); }
  // the first visit of the day: the site-chips bonus
  if (res.ok && res.daily) setTimeout(() => toast(t('chips.daily', res.daily), 'info'), 800);
  return res;
}

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

// ---------- "back to my game": rooms this account is still in, in either game ----------
let activeRooms = [];
let autoJoinDone = false;
async function renderActive() {
  let box = $('#activeGames');
  if (!box) {
    const html = '<div id="activeGames" class="active-games hidden"></div>';
    if ($('#tables')) $('#tables').insertAdjacentHTML('afterend', html); // tables stay on top
    else $('#playCard').insertAdjacentHTML('afterbegin', html);
    box = $('#activeGames');
  }
  if (account && !Site.home) autoJoinDone = true; // the page opened inside a room: nothing to auto-join later
  if (!account || !Site.home) { box.classList.add('hidden'); return; }
  const res = await fetch('/api/active', { headers: { Authorization: `Bearer ${store.get(AUTH_KEY)}` } }).then(r => r.json()).catch(() => null);
  activeRooms = (res && res.ok && res.rooms) || [];
  if (!Site.home) return;
  // Right after opening the page: a link to a room we're in, or to a table's game, goes straight in.
  // (Only once: "← Home" from the lobby keeps the room in the address bar.)
  if (!autoJoinDone && Site.urlRoom()) {
    autoJoinDone = true;
    const url = Site.urlRoom();
    const atTable = myTables.some(tb => tb.current && tb.current.game === Site.game && tb.current.code === url && tb.current.phase !== 'ended');
    if (atTable || activeRooms.some(r => r.game === Site.game && r.code === url)) { send('join', { code: url }); return; }
  }
  autoJoinDone = true;
  // rooms a table is playing in are already shown on the table card
  const shown = activeRooms.filter(r => !myTables.some(tb => tb.current && tb.current.code === r.code));
  box.classList.toggle('hidden', !shown.length);
  box.innerHTML = shown.map(r => `
    <a class="active-game g-${r.game}" href="${gameInfoOf(r.game).path}?room=${r.code}" data-active="${r.game}:${r.code}">
      <span class="ag-ico">${gameIcon(r.game)}</span>
      <span class="ag-text"><b>${esc(t('active.title', { game: gameTitle(r.game) }))}</b>
        <span class="muted small-text">${esc(t('ui.room'))} <span class="code">${r.code}</span> · ${esc(t(r.phase === 'lobby' ? 'active.lobby' : 'active.playing'))} · ${r.players.map(p => esc(p.name)).join(', ')}</span></span>
      <span class="ag-go">${esc(t('active.back'))} →</span>
    </a>`).join('');
  for (const a of box.querySelectorAll('[data-active]')) {
    const [game, code] = a.dataset.active.split(':');
    if (game === Site.game) a.onclick = e => { e.preventDefault(); send('join', { code }); };
  }
}

// ---------- profile: one window for both games ----------
const SLOT_ORDER = ['hat', 'frame', 'name', 'reaction'];
let profileUser = null;
let profileTab = null;

async function openProfile(userId, tab) {
  if (!account) return;
  userId = userId || account.id;
  const self = userId === account.id;
  const res = self ? await refreshAccount() : await api('player/' + userId);
  if (!res.ok) return;
  if (!profileUser || profileUser.id !== userId) profileTab = null;
  profileUser = res.user;
  profileTab = tab || profileTab || Site.game;
  renderProfile();
  $('#profile').classList.remove('hidden');
}
const openPlayer = userId => userId && openProfile(userId);

function renderProfile() {
  const u = profileUser;
  if (!u) return;
  const self = !!account && u.id === account.id;
  if (self) profileUser = account;
  $('#profileTitle').textContent = self ? t('profile.title') : u.username;
  const pic = avatar(u.username, u.avatar, u.equipped);
  $('#profileTop').innerHTML = `
    ${self ? `<label class="avatar-upload"><span>${pic}</span><span class="avatar-edit">${esc(t('profile.changePhoto'))}</span>
      <input id="avatarFile" type="file" accept="image/png,image/jpeg,image/webp,image/heic,image/*" hidden></label>` : `<span class="player-avatar">${pic}</span>`}
    <div class="profile-id">
      <div class="profile-name ${nameCls(u.equipped)}">${esc(u.username)}</div>
      ${titleTag(u.title)}
      ${u.birthdayToday ? `<span class="bday-pill">🎂 ${esc(t('profile.birthdayToday'))}</span>` : ''}
      ${statusPill(u.score)}
      <div class="karma"><span class="karma-up">${COMMON_ICONS.up}${esc(t('profile.likes', { n: u.likes }))}</span><span class="karma-down">${COMMON_ICONS.down}${esc(t('profile.dislikes', { n: u.dislikes }))}</span></div>
    </div>`;
  $('#profileTop').insertAdjacentHTML('afterend', '');
  const badges = (u.badges || []).map(b => `<span class="badge-chip" title="${esc(b.label)}">${esc(b.emoji)} ${esc(b.label)}</span>`).join('');
  let badgeRow = $('#profileBadges');
  if (!badgeRow) { $('#profileTop').insertAdjacentHTML('afterend', '<div id="profileBadges" class="badge-row"></div>'); badgeRow = $('#profileBadges'); }
  badgeRow.innerHTML = badges;
  badgeRow.classList.toggle('hidden', !badges);
  const tabs = ['mafia', 'mono', 'spy', 'cit', 'poker', ...(self ? ['wardrobe', 'account'] : [])];
  if (!tabs.includes(profileTab)) profileTab = Site.game;
  $('#profileTabs').innerHTML = tabs.map(k => `<button class="${k === profileTab ? 'active' : ''}" data-ptab="${k}">${esc(t('profile.tab.' + k))}</button>`).join('');
  for (const b of $$('#profileTabs [data-ptab]')) b.onclick = () => { profileTab = b.dataset.ptab; renderProfile(); };
  $('#profileBody').innerHTML = { mafia: mafiaStatsHtml, mono: monoStatsHtml, spy: spyStatsHtml, cit: citStatsHtml, poker: pokerStatsHtml, wardrobe: wardrobeHtml, account: accountHtml }[profileTab](u);
  if (self) bindProfileControls();
}

function bindProfileControls() {
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
    renderProfile();
    toast(t('toast.photoUpdated'), 'info');
  });
  for (const b of $$('#profileBody [data-equip]')) {
    b.onclick = async () => {
      const slot = b.dataset.slot;
      const res = await api('equip', { slot, itemId: account.equipped[slot] === b.dataset.equip ? null : b.dataset.equip });
      if (res.ok) { account = res.user; renderAccount(); renderProfile(); }
    };
  }
  if ($('#guestSave')) {
    $('#guestSave').onclick = () => { closeOverlay('profile'); openSaveAccount(); };
    $('#guestLeave').onclick = async () => {
      if (!(await askConfirm({ title: t('save.leave'), text: t('save.leaveText'), danger: true }))) return;
      await api('logout', {});
      closeOverlay('profile');
      setAccount(null, null);
    };
  }
  const form = $('#passwordForm');
  if (form) {
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const res = await api('password', { oldPassword: $('#oldPass').value, newPassword: $('#newPass').value });
      if (!res.ok) return;
      store.set(AUTH_KEY, res.token);
      $('#oldPass').value = $('#newPass').value = '';
      toast(t('toast.passwordChanged'), 'info');
    });
    $('#logoutBtn').onclick = async () => {
      await api('logout', {});
      closeOverlay('profile');
      setAccount(null, null);
    };
    $('#adminBtn').onclick = () => { closeOverlay('profile'); openAdmin(); };
    const saveEmail = async email => {
      const r = await api('email', { email, password: $('#emailPass').value, lang });
      if (!r.ok) return;
      account = r.user;
      renderProfile();
      toast(t(email ? 'email.saved' : 'email.removed', { email }), 'info');
    };
    $('#emailForm').addEventListener('submit', e => { e.preventDefault(); saveEmail($('#emailNew').value.trim()); });
    if ($('#emailRemove')) $('#emailRemove').onclick = () => { if (!$('#emailPass').value) return toast(t('email.passwordFirst')); saveEmail(''); };
    if ($('#emailResend')) $('#emailResend').onclick = async () => { const r = await api('email/resend', { lang }); if (r.ok) toast(t('auth.checkEmail', { email: account.email }), 'info'); };
    const savePersonal = async body => {
      const r = await api('profile', body);
      if (r.ok) { account = r.user; renderAccount(); renderProfile(); }
    };
    const bday = () => {
      const d = $('#bdayDay').value, m = $('#bdayMonth').value;
      if ((d && m) || (!d && !m)) savePersonal({ birthday: d && m ? `${m}-${d}` : null });
    };
    $('#bdayDay').onchange = bday;
    $('#bdayMonth').onchange = bday;
    for (const b of $$('[data-theme-pick]')) b.onclick = () => savePersonal({ theme: b.dataset.themePick || null });
    $('#myArchiveBtn').onclick = () => { closeOverlay('profile'); openArchive(null); };
    addPasswordToggles($('#profileBody'));
    $('#recoveryBtn').onclick = async () => {
      if (account.hasRecovery && !(await askConfirm({ title: t('recovery.renew'), text: t('recovery.renewWarn') }))) return;
      const r = await api('recovery', {});
      if (!r.ok) return;
      showRecoveryCode(r.recoveryCode, 'recovery.afterRenew');
      refreshAccount().then(renderProfile);
    };
  }
}

const statTile = (v, label) => `<div class="stat"><b>${v}</b><span>${esc(label)}</span></div>`;

// Radar ("pentagon") chart: axes = [[key, value 0..1 or null], ...], labels from labelPrefix + key
function radarSvg(axes, labelPrefix) {
  const size = 300, c = size / 2, R = 104;
  const point = (i, r) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / axes.length;
    return [c + r * Math.cos(a), c + r * Math.sin(a)];
  };
  const ring = f => axes.map((_, i) => point(i, R * f).join(',')).join(' ');
  const at = v => R * Math.max(0.04, v || 0);
  const labels = axes.map(([key, v], i) => {
    const [x, y] = point(i, R + 30);
    const anchor = Math.abs(x - c) < 8 ? 'middle' : x > c ? 'start' : 'end';
    return `<text x="${x}" y="${y}" text-anchor="${anchor}" class="radar-label"><tspan>${esc(t(labelPrefix + key))}</tspan>
      <tspan x="${x}" dy="15" class="radar-value">${v === null ? '—' : Math.round(v * 100) + '%'}</tspan></text>`;
  }).join('');
  return `<svg class="radar" viewBox="-40 -10 ${size + 80} ${size + 20}" role="img">
    <defs><linearGradient id="radarFill" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--glow-a)" stop-opacity=".75"/><stop offset="1" stop-color="var(--glow-b)" stop-opacity=".55"/></linearGradient></defs>
    ${[0.25, 0.5, 0.75, 1].map(f => `<polygon points="${ring(f)}" class="radar-ring"/>`).join('')}
    ${axes.map((_, i) => `<line x1="${c}" y1="${c}" x2="${point(i, R)[0]}" y2="${point(i, R)[1]}" class="radar-axis"/>`).join('')}
    <polygon points="${axes.map(([, v], i) => point(i, at(v)).join(',')).join(' ')}" class="radar-shape" fill="url(#radarFill)"/>
    ${axes.map(([, v], i) => `<circle cx="${point(i, at(v))[0]}" cy="${point(i, at(v))[1]}" r="4" class="radar-dot"/>`).join('')}
    ${labels}
  </svg>`;
}

// Mafia playstyle: five axes, each 0..1, built only from explicit in-app actions (final votes,
// night moves, game outcomes): never from timing or chat, since the talking happens in voice.
// An axis stays empty (null) until there's enough data for it to mean something.
const AXIS_MIN = { survival: 3, deception: 2, intuition: 5, influence: 5, town: 3 };
function playstyle(st) {
  const axis = (key, part, whole) => [key, whole >= AXIS_MIN[key] ? part / whole : null, whole];
  return [
    axis('survival', st.survived, st.games),
    axis('deception', st.mafiaWins, st.mafiaGames),
    axis('intuition', st.votesOnMafia, st.townVotes),
    axis('influence', st.decisive, st.ballots),
    axis('town', st.townWins, st.townGames),
  ];
}

function mafiaStatsHtml(u) {
  const st = u.stats;
  if (!st.games) return `<p class="muted">${esc(t('player.noGames'))}</p>`;
  const roleName = r => t('role.' + r);
  const team = r => (r === 'mafia' ? 'mafia' : 'town');
  const axes = playstyle(st);
  const roleRows = Object.entries(st.roles).sort((a, b) => b[1] - a[1]);
  const best = roleRows.filter(([, g]) => g >= 2).map(([r, g]) => [r, (st.roleWins[r] || 0) / g]).sort((a, b) => b[1] - a[1])[0];
  const dateFmt = ts => new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' });
  return `
    <div class="stat-grid four">
      ${statTile(st.games, t('player.games'))}${statTile(pctOf(st.wins, st.games) + '%', t('player.winRate'))}
      ${statTile(st.streak, t('player.streak'))}${statTile(st.bestStreak, t('player.bestStreak'))}
    </div>
    <section class="player-section">
      <h3>${esc(t('player.playstyle'))}</h3>
      <div class="radar-wrap">${radarSvg(axes, 'player.axis.')}
        <ul class="radar-help">${axes.map(([k, v, n]) => `<li><b>${esc(t('player.axis.' + k))}</b> — ${esc(t('player.help.' + k))}
          ${v === null ? `<span class="need-more">${esc(t('player.needMore.' + (k === 'intuition' || k === 'influence' ? 'votes' : 'games'), { n: AXIS_MIN[k] - n }))}</span>` : ''}</li>`).join('')}</ul>
      </div>
      <p class="muted small-text">${esc(t('player.reliability'))}</p>
    </section>
    <section class="player-section">
      <h3>${esc(t('player.roles'))}</h3>
      <div class="role-bars">${roleRows.map(([r, g]) => `
        <div class="role-bar">
          <span class="tag ${team(r)}">${esc(roleName(r))}</span>
          <span class="bar-track wide"><span class="bar-fill ${team(r)}" style="width:${pctOf(st.roleWins[r] || 0, g)}%"></span></span>
          <span class="muted small-text">${esc(t('player.roleLine', { g, w: pctOf(st.roleWins[r] || 0, g) }))}</span>
        </div>`).join('')}</div>
    </section>
    <section class="player-section">
      <h3>${esc(t('player.highlights'))}</h3>
      <div class="stat-grid four">
        ${statTile(st.kills, t('player.kills'))}${statTile(st.saves, t('player.saves'))}
        ${statTile(st.copHits, t('player.copHits'))}${statTile(st.mafiaVotedOut, t('player.mafiaVotedOut'))}
      </div>
      <div class="highlight-line">
        ${roleRows[0] ? `<span class="muted small-text">${esc(t('player.favRole'))}:</span> <span class="tag ${team(roleRows[0][0])}">${esc(roleName(roleRows[0][0]))}</span>` : ''}
        ${best ? `<span class="muted small-text">${esc(t('player.bestRole'))}:</span> <span class="tag ${team(best[0])}">${esc(roleName(best[0]))} · ${Math.round(best[1] * 100)}%</span>` : ''}
      </div>
    </section>
    <section class="player-section">
      <h3>${esc(t('player.recent'))}</h3>
      <div class="recent-games">${st.recent.map(g => `
        <span class="recent ${g.won ? 'won' : 'lost'}" title="${esc(dateFmt(g.at))} · ${esc(roleName(g.role))} · ${esc(t(g.won ? 'player.won' : 'player.lost'))}">
          <b>${g.won ? 'W' : 'L'}</b><span>${esc(roleName(g.role))}</span>${g.survived ? '' : '<i>💀</i>'}
        </span>`).join('')}</div>
    </section>`;
}

// Monopoly playstyle: five axes from in-game actions; each needs 3 games before it shows.
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

function monoStatsHtml(u) {
  const m = u.monoStats;
  if (!m.games) return `<p class="muted">${esc(t('player.noGames'))}</p>`;
  const axes = monoStyle(m);
  const fav = Object.entries(m.groups).sort((a, b) => b[1] - a[1])[0];
  return `
    <div class="stat-grid four">
      ${statTile(m.games, t('player.games'))}${statTile(pctOf(m.wins, m.games) + '%', t('player.winRate'))}
      ${statTile((m.placeSum / m.games).toFixed(1), t('mono.player.avgPlace'))}${statTile(money(m.bestNetWorth), t('mono.player.bestWorth'))}
    </div>
    <section class="player-section"><h3>${esc(t('mono.player.style'))}</h3>
      <div class="radar-wrap">${radarSvg(axes, 'mono.axis.')}<ul class="radar-help">${axes.map(([k, v]) => `<li><b>${esc(t('mono.axis.' + k))}</b> — ${esc(t('mono.help.' + k))}${v === null ? ` <span class="need-more">${esc(t('player.needMore.games', { n: 3 - m.games }))}</span>` : ''}</li>`).join('')}</ul></div>
    </section>
    <section class="player-section"><h3>${esc(t('player.highlights'))}</h3>
      <div class="stat-grid four">
        ${statTile(money(m.rentCollected), t('mono.player.rentIn'))}${statTile(money(m.rentPaid), t('mono.player.rentOut'))}
        ${statTile(m.housesBuilt, t('mono.player.houses'))}${statTile(m.hotelsBuilt, t('mono.player.hotels'))}
        ${statTile(m.auctionsWon, t('mono.player.auctions'))}${statTile(m.jailed, t('mono.player.jailed'))}
        ${statTile(m.bestStreak, t('player.bestStreak'))}${statTile(fav ? `<span class="mband g-${fav[0]}"></span> ${esc(t('mono.group.' + fav[0]))}` : '—', t('mono.player.favGroup'))}
      </div>
    </section>
    <section class="player-section"><h3>${esc(t('mono.player.recent'))}</h3>
      <div class="recent-games">${m.recent.map(r => `<span class="recent ${r.won ? 'won' : 'lost'}"><b>${r.place}</b><span>${esc(t('mono.place', { n: r.place }))} / ${r.players}</span><span class="muted">${money(r.netWorth)}</span></span>`).join('')}</div>
    </section>`;
}

function spyStatsHtml(u) {
  const m = u.spyStats || {};
  if (!m.games) return `<p class="muted">${esc(t('player.noGames'))}</p>`;
  return `
    <div class="stat-grid four">
      ${statTile(m.games, t('player.games'))}${statTile(pctOf(m.wins, m.games) + '%', t('player.winRate'))}
      ${statTile(m.points, t('spy.stat.points'))}${statTile(m.bestStreak, t('player.bestStreak'))}
    </div>
    <section class="player-section"><h3>${esc(t('player.highlights'))}</h3>
      <div class="stat-grid four">
        ${statTile(`${m.spyWins}/${m.spyRounds}`, t('spy.stat.asSpy'))}${statTile(m.guessed, t('spy.stat.guessed'))}
        ${statTile(m.townWins, t('spy.stat.townWins'))}${statTile(m.caught, t('spy.stat.caught'))}
      </div>
    </section>
    <section class="player-section"><h3>${esc(t('mono.player.recent'))}</h3>
      <div class="recent-games">${m.recent.map(r => `<span class="recent ${r.won ? 'won' : 'lost'}"><b>${r.won ? 'W' : 'L'}</b><span>${esc(t('spy.points', { n: r.points }))}</span></span>`).join('')}</div>
    </section>`;
}

// Citadels playstyle: five axes from what happened in the games; each needs 3 games.
function citStyle(c) {
  const v = x => (c.games >= 3 ? Math.max(0, Math.min(1, x)) : null);
  const per = x => x / Math.max(1, c.games);
  return [
    ['results', v(c.recent.length ? c.recent.reduce((s, r) => s + (r.players > 1 ? (r.players - r.place) / (r.players - 1) : 1), 0) / c.recent.length : 0)],
    ['builder', v(per(c.built) / 9)],
    ['finisher', v(per(c.firstComplete) * 1.5)],
    ['schemer', v(per(c.stolen / 3 + c.kills + c.swaps + c.destroyed) / 3)],
    ['score', v(per(c.scoreSum) / 35)],
  ];
}

function citStatsHtml(u) {
  const c = u.citStats || {};
  if (!c.games) return `<p class="muted">${esc(t('player.noGames'))}</p>`;
  const axes = citStyle(c);
  const chars = Object.entries(c.chars).sort((a, b) => b[1] - a[1]);
  const best = chars.filter(([, n]) => n >= 2).map(([k, n]) => [k, (c.charWins[k] || 0) / n]).sort((a, b) => b[1] - a[1])[0];
  return `
    <div class="stat-grid four">
      ${statTile(c.games, t('player.games'))}${statTile(pctOf(c.wins, c.games) + '%', t('player.winRate'))}
      ${statTile((c.placeSum / c.games).toFixed(1), t('cit.player.avgPlace'))}${statTile(c.bestScore, t('cit.player.bestScore'))}
    </div>
    <section class="player-section"><h3>${esc(t('cit.player.style'))}</h3>
      <div class="radar-wrap">${radarSvg(axes, 'cit.axis.')}<ul class="radar-help">${axes.map(([k, v]) => `<li><b>${esc(t('cit.axis.' + k))}</b> — ${esc(t('cit.help.' + k))}${v === null ? ` <span class="need-more">${esc(t('player.needMore.games', { n: 3 - c.games }))}</span>` : ''}</li>`).join('')}</ul></div>
    </section>
    <section class="player-section"><h3>${esc(t('player.highlights'))}</h3>
      <div class="stat-grid four">
        ${statTile((c.scoreSum / c.games).toFixed(1), t('cit.player.avgScore'))}${statTile(c.built, t('cit.player.built'))}
        ${statTile(c.firstComplete, t('cit.player.first'))}${statTile(c.stolen, t('cit.player.stolen'))}
        ${statTile(c.destroyed, t('cit.player.destroyed'))}${statTile(c.swaps, t('cit.player.swaps'))}
        ${statTile(c.bestStreak, t('player.bestStreak'))}${statTile(chars[0] ? esc(t('char.' + chars[0][0])) : '—', t('cit.player.favChar'))}
      </div>
      ${best ? `<div class="highlight-line"><span class="muted small-text">${esc(t('cit.player.bestChar'))}:</span> <span class="tag">${esc(t('char.' + best[0]))} · ${Math.round(best[1] * 100)}%</span></div>` : ''}
    </section>
    <section class="player-section"><h3>${esc(t('cit.player.recent'))}</h3>
      <div class="recent-games">${c.recent.map(r => `<span class="recent ${r.won ? 'won' : 'lost'}"><b>${r.place}</b><span>${esc(t('cit.place', { n: r.place }))} / ${r.players}</span><span class="muted">${esc(t('cit.points', { n: r.score }))}</span></span>`).join('')}</div>
    </section>`;
}

// Poker: the usual tracker numbers (VPIP, PFR, showdowns) and the best hand ever shown
function pokerStatsHtml(u) {
  const c = u.pokerStats || {};
  if (!c.games) return `<p class="muted">${esc(t('player.noGames'))}</p>`;
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '—');
  const chips = n => `${n > 0 ? '+' : ''}${n}`;
  const best = c.bestHand;
  const suit = { s: '♠', h: '♥', d: '♦', c: '♣' };
  const cards = best ? best.cards.map(x => `<span class="mini-card s-${x[1]}">${x[0] === 'T' ? '10' : x[0]}${suit[x[1]]}</span>`).join('') : '';
  return `
    <div class="stat-grid four">
      ${statTile(c.games, t('player.games'))}${statTile(pctOf(c.wins, c.games) + '%', t('player.winRate'))}
      ${statTile(chips(c.net), t('pk.player.net'))}${statTile(c.biggestPot, t('pk.player.biggestPot'))}
    </div>
    <section class="player-section"><h3>${esc(t('pk.player.style'))}</h3>
      <div class="stat-grid four">
        ${statTile(c.hands, t('pk.player.hands'))}${statTile(pct(c.vpip, c.hands), 'VPIP')}
        ${statTile(pct(c.pfr, c.hands), 'PFR')}${statTile(pct(c.handsWon, c.hands), t('pk.player.handsWon'))}
        ${statTile(pct(c.showdowns, c.hands), t('pk.player.wtsd'))}${statTile(pct(c.sdWon, c.showdowns), t('pk.player.wsd'))}
        ${statTile(`${c.allInsWon}/${c.allIns}`, t('pk.player.allIns'))}${statTile(c.rebuys, t('pk.player.rebuys'))}
      </div>
      <p class="muted small-text">${esc(t('pk.player.styleHint'))}</p>
      ${best ? `<div class="highlight-line"><span class="muted small-text">${esc(t('pk.player.bestHand'))}:</span> <span class="tag">${esc(t(best.name.key, pkNameParams(best.name.params)))}</span> <span class="mini-cards">${cards}</span></div>` : ''}
    </section>
    <section class="player-section"><h3>${esc(t('cit.player.recent'))}</h3>
      <div class="recent-games">${c.recent.map(r => `<span class="recent ${r.won ? 'won' : 'lost'}"><b>${r.place}</b><span>${esc(t('cit.place', { n: r.place }))} / ${r.players}</span><span class="muted">${chips(r.net)}</span></span>`).join('')}</div>
    </section>`;
}
// a hand's name: ranks as words in the current language ("K" -> "Kings" / "короли")
function pkNameParams(p = {}) {
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    out[k] = t('pk.r.' + v);
    out[k + 's'] = t('pk.rs.' + v);
    out[k + 'g'] = t('pk.rg.' + v);
  }
  return out;
}

function itemPreview(id) {
  const it = ITEMS[id] || {};
  if (it.slot === 'hat' || it.slot === 'reaction') return `<span class="item-emoji">${it.emoji}</span>`;
  if (it.slot === 'frame') return `<span class="cos ${id.replace('.', '-')}"><span class="avatar" style="--h:260">★</span></span>`;
  return `<span class="item-name ${nameCls({ name: id })}">Aa</span>`;
}

function wardrobeHtml() {
  const inv = account.inventory || [];
  const current = tierOf(account.score);
  const items = !inv.length ? `<p class="muted small-text">${esc(t('wardrobe.empty'))}</p>` : SLOT_ORDER.map(slot => {
    const mine = inv.filter(id => (ITEMS[id] || {}).slot === slot);
    if (!mine.length) return '';
    return `<div class="ward-slot"><span class="muted small-text">${esc(t('wardrobe.slot.' + slot))}</span><div class="ward-items">${mine.map(id => {
      const on = slot === 'reaction' || account.equipped[slot] === id;
      return `<button class="ward-item ${on ? 'on' : ''}" ${slot === 'reaction' ? 'disabled' : ''} data-equip="${id}" data-slot="${slot}" title="${esc(t('item.' + id))}">
        ${itemPreview(id)}<span class="ward-label">${esc(t('item.' + id))}</span>
        ${on ? `<span class="ward-on">${esc(t(slot === 'reaction' ? 'wardrobe.unlocked' : 'wardrobe.equipped'))}</span>` : ''}
      </button>`;
    }).join('')}</div></div>`;
  }).join('');
  return `<div class="wardrobe">${items}</div>
    <section class="player-section">
      <h3>${esc(t('profile.decency'))}</h3>
      <p class="muted small-text">${esc(t('profile.decencyHint'))}</p>
      <div class="tier-ladder">${TIER_MIN.map((_, i) => `<span class="status t${i} ${i === current ? 'current' : ''}">${esc(t('tier.' + i))}</span>`).join('')}</div>
    </section>`;
}

function accountHtml() {
  // a guest: nothing to change yet, but everything to keep
  if (account.guest) {
    return `<section class="player-section"><h3>${esc(t('save.profileTitle'))}</h3>
      <p class="muted small-text">${esc(t('save.profileText'))}</p>
      <button id="guestSave" class="primary" type="button">${esc(t('save.submit'))}</button></section>
      <div class="row account-actions"><button id="guestLeave" class="danger" type="button">${esc(t('save.leave'))}</button></div>`;
  }
  const [bm, bd] = (account.birthday || '-').split('-');
  const months = Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleDateString(lang === 'ru' ? 'ru-RU' : 'en-GB', { month: 'long' }));
  return `<section class="player-section">
      <h3>${esc(t('personal.title'))}</h3>
      <div class="row bday-row"><span class="muted small-text">${esc(t('personal.birthday'))}</span>
        <select id="bdayDay"><option value="">—</option>${Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, '0')).map(d => `<option ${d === bd ? 'selected' : ''}>${d}</option>`).join('')}</select>
        <select id="bdayMonth"><option value="">—</option>${months.map((m, i) => { const v = String(i + 1).padStart(2, '0'); return `<option value="${v}" ${v === bm ? 'selected' : ''}>${esc(m)}</option>`; }).join('')}</select>
      </div>
      <p class="muted small-text">${esc(t('personal.birthdayHint'))}</p>
      <div class="theme-row"><span class="muted small-text">${esc(t('personal.theme'))}</span>
        <button class="theme-swatch ${!account.theme ? 'on' : ''}" data-theme-pick="" title="${esc(t('personal.themeDefault'))}"></button>
        ${THEMES.map(k => `<button class="theme-swatch th-${k} ${account.theme === k ? 'on' : ''}" data-theme-pick="${k}" title="${esc(t('personal.theme.' + k))}"></button>`).join('')}
      </div>
    </section>
    <button id="myArchiveBtn" class="small" type="button">${ico('book')} ${esc(t('archive.mine'))}</button>
    <form id="emailForm" class="password-form" autocomplete="on">
      <h3>${esc(t('email.title'))}</h3>
      <p class="muted small-text">${account.email
        ? `${esc(account.email)} · ${account.emailVerified ? `<span class="pos">${esc(t('email.verified'))}</span>` : `<span class="warn-text">${esc(t('email.unverified'))}</span> <button type="button" id="emailResend" class="link-btn">${esc(t('email.resend'))}</button>`}`
        : esc(t('email.none'))}</p>
      <div class="row">
        <input id="emailNew" type="email" autocomplete="email" maxlength="254" placeholder="${esc(t(account.email ? 'email.change' : 'email.add'))}">
        <input id="emailPass" type="password" autocomplete="current-password" placeholder="${esc(t('email.password'))}">
        <button type="submit">${esc(t('profile.save'))}</button>
      </div>
      ${account.email ? `<button type="button" id="emailRemove" class="link-btn">${esc(t('email.remove'))}</button>` : ''}
    </form>
    <form id="passwordForm" class="password-form" autocomplete="on">
      <h3>${esc(t('profile.changePassword'))}</h3>
      <input type="text" name="username" autocomplete="username" value="${esc(account.username)}" hidden>
      <div class="row">
        <input id="oldPass" type="password" autocomplete="current-password" placeholder="${esc(t('profile.oldPassword'))}">
        <input id="newPass" type="password" autocomplete="new-password" placeholder="${esc(t('profile.newPassword'))}">
        <button type="submit">${esc(t('profile.save'))}</button>
      </div>
    </form>
    <section class="player-section">
      <h3>${esc(t('recovery.title'))}</h3>
      <p class="muted small-text">${esc(t(account.hasRecovery ? 'recovery.have' : 'recovery.none'))}</p>
      <button id="recoveryBtn" class="small">${esc(t(account.hasRecovery ? 'recovery.renew' : 'recovery.create'))}</button>
    </section>
    <div class="row account-actions">
      <button id="logoutBtn" class="danger">${esc(t('profile.logout'))}</button>
      ${account.admin ? `<button id="adminBtn" class="ghost">${esc(t('admin.open'))}</button>` : '<span id="adminBtn" hidden></span>'}
    </div>`;
}

// ---------- gifts: an unboxing when something new arrives ----------
let giftShowing = null;
let giftOpening = false;
const giftQueue = []; // several gifts open one after another
function queueGifts(ids) {
  for (const id of ids || []) if (ITEMS[id] && id !== giftShowing && !giftQueue.includes(id)) giftQueue.push(id);
  if (!giftShowing && giftQueue.length) showGift(giftQueue.shift());
}
function showGift(itemId) {
  giftShowing = itemId;
  giftOpening = false;
  $('#giftPresent').classList.remove('hidden', 'opening');
  $('#giftItem').classList.add('hidden');
  $('#giftDone').classList.add('hidden');
  $('#giftName').textContent = t('gift.tap');
  $('#giftBox').classList.remove('hidden');
  if (alertsOn) [523, 659, 784].forEach((f, i) => tone({ f, at: i * 0.09, dur: 0.4, vol: 0.06, type: 'triangle' }));
}
$('#giftPresent').onclick = () => {
  const id = giftShowing;
  if (!id || giftOpening) return;
  giftOpening = true;
  $('#giftPresent').classList.add('opening');
  setTimeout(() => {
    $('#giftPresent').classList.add('hidden');
    $('#giftItem').innerHTML = (ITEMS[id] || {}).slot === 'hat' ? avatar(account.username, account.avatar, { hat: id }) : itemPreview(id);
    $('#giftItem').classList.remove('hidden');
    $('#giftName').textContent = t('item.' + id);
    $('#giftDone').classList.remove('hidden');
    if (!reducedMotion()) Site.hooks.celebrate();
    if (alertsOn) [784, 988, 1175, 1568].forEach((f, i) => tone({ f, at: i * 0.07, dur: 0.5, vol: 0.06, type: 'triangle' }));
  }, 650);
};
$('#giftDone').onclick = async () => {
  giftShowing = null;
  if (giftQueue.length) { showGift(giftQueue.shift()); return; }
  $('#giftBox').classList.add('hidden');
  await api('gifts/seen', {});
  const res = await api('me');
  if (res.ok) { account = { ...res.user, gifts: [] }; renderAccount(); }
};

// ---------- admin: who's online, rooms, decency, gifts, account fixes ----------
let adminTab = 'live';
function openAdmin() {
  $('#admin').classList.remove('hidden');
  renderAdmin();
}
for (const b of $$('[data-admin-tab]')) b.onclick = () => { adminTab = b.dataset.adminTab; renderAdmin(); };

const ago = ts => {
  const min = Math.round((Date.now() - ts) / 60000);
  return min < 1 ? t('admin.justNow') : min < 60 ? t('admin.minAgo', { n: min }) : t('admin.hAgo', { n: Math.round(min / 60) });
};
const gameName = gameTitle;

async function renderAdmin() {
  for (const b of $$('[data-admin-tab]')) b.classList.toggle('active', b.dataset.adminTab === adminTab);
  return adminTab === 'live' ? renderAdminLive() : adminTab === 'invites' ? renderAdminInvites() : adminTab === 'features' ? renderAdminFeatures() : adminTab === 'stats' ? renderAdminStats() : adminTab === 'blog' ? renderAdminBlog() : renderAdminUsers();
}

// the blog: a list of articles and a Markdown editor (pages are served at /blog/)
let blogEdit = null; // the article being edited ({} for a new one)
async function renderAdminBlog() {
  const res = await api('admin/blog');
  if (!res.ok || adminTab !== 'blog') return;
  const body = $('#adminBody');
  if (!blogEdit) {
    body.innerHTML = `<div class="row"><button id="blogNew" class="primary small">＋ ${esc(t('admin.blog.new'))}</button><a class="small-text" href="/blog/" target="_blank">/blog/ ↗</a></div>
      ${res.posts.length ? `<ul class="admin-blog-list">${res.posts.map(p => `<li><span><b>${esc(p.title)}</b>
        <span class="muted small-text">${p.lang.toUpperCase()} · ${esc(t(p.status === 'published' ? 'admin.blog.published' : 'admin.blog.draft'))} · /blog/${esc(p.slug)}/</span></span>
        <span class="row">${p.status === 'published' ? `<a class="small-text" href="/blog/${esc(p.slug)}/" target="_blank">↗</a>` : ''}<button class="small" data-bedit="${p.id}">${esc(t('admin.blog.edit'))}</button></span></li>`).join('')}</ul>`
        : `<p class="muted small-text">${esc(t('admin.blog.none'))}</p>`}`;
    $('#blogNew').onclick = () => { blogEdit = { lang, status: 'draft' }; renderAdminBlog(); };
    for (const b of body.querySelectorAll('[data-bedit]')) b.onclick = () => { blogEdit = res.posts.find(p => p.id === b.dataset.bedit); renderAdminBlog(); };
    return;
  }
  const p = blogEdit;
  const opt = (v, cur, label) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
  body.innerHTML = `<form id="blogForm" class="blog-editor">
    <label class="field"><span>${esc(t('admin.blog.title'))}</span><input name="title" maxlength="140" required value="${esc(p.title || '')}"></label>
    <div class="row">
      <label class="field"><span>${esc(t('admin.blog.lang'))}</span><select name="lang">${opt('en', p.lang, 'English')}${opt('ru', p.lang, 'Русский')}</select></label>
      <label class="field"><span>${esc(t('admin.blog.game'))}</span><select name="game">${opt('', p.game || '', '—')}${res.games.map(g => opt(g, p.game, g)).join('')}</select></label>
      <label class="field"><span>${esc(t('admin.blog.status'))}</span><select name="status">${opt('draft', p.status, t('admin.blog.draft'))}${opt('published', p.status, t('admin.blog.published'))}</select></label>
    </div>
    <label class="field"><span>${esc(t('admin.blog.slug'))}</span><input name="slug" maxlength="80" value="${esc(p.slug || '')}" placeholder="${esc(t('admin.blog.slugHint'))}"></label>
    <label class="field"><span>${esc(t('admin.blog.description'))}</span><textarea name="description" rows="2" maxlength="300">${esc(p.description || '')}</textarea></label>
    <div class="row">
      <label class="field"><span>${esc(t('admin.blog.group'))}</span><input name="group" maxlength="80" value="${esc(p.group || '')}" placeholder="mafia-rules"></label>
      <label class="field"><span>${esc(t('admin.blog.tags'))}</span><input name="tags" value="${esc((p.tags || []).join(', '))}"></label>
    </div>
    <label class="field"><span>${esc(t('admin.blog.body'))}</span><textarea name="body" rows="18" class="blog-md">${esc(p.body || '')}</textarea></label>
    <div class="row">
      <label class="small ghost-file">${esc(t('admin.blog.image'))}<input type="file" id="blogImage" accept="image/jpeg,image/png,image/webp" hidden></label>
      <label class="check"><input type="checkbox" id="blogCover"> <span class="small-text">${esc(t('admin.blog.asCover'))}</span></label>
      <input type="hidden" name="cover" value="${esc(p.cover || '')}">
      ${p.cover ? `<span class="muted small-text">${esc(t('admin.blog.cover'))}: ${esc(p.cover)}</span>` : ''}
    </div>
    <div class="row">
      <button type="submit" class="primary">${esc(t('profile.save'))}</button>
      <button type="button" id="blogPreview">${esc(t('admin.blog.preview'))}</button>
      <button type="button" id="blogBack" class="ghost">${esc(t('admin.blog.back'))}</button>
      ${p.id ? `<button type="button" id="blogDelete" class="danger small">${esc(t('admin.blog.delete'))}</button>` : ''}
    </div>
    <p class="muted small-text">${esc(t('admin.blog.hint'))}</p>
    <div id="blogPreviewBox" class="blog-body blog-preview hidden"></div>
  </form>`;
  const form = $('#blogForm');
  const values = () => Object.fromEntries(new FormData(form).entries());
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const r = await api('admin/blog', { ...values(), id: p.id });
    if (!r.ok) return;
    blogEdit = r.post;
    toast(t(r.post.status === 'published' ? 'admin.blog.savedLive' : 'admin.blog.saved', { url: `/blog/${r.post.slug}/` }), 'info');
    renderAdminBlog();
  });
  $('#blogBack').onclick = () => { blogEdit = null; renderAdminBlog(); };
  $('#blogPreview').onclick = async () => {
    const r = await api('admin/blog/preview', { body: form.body.value });
    if (r.ok) { $('#blogPreviewBox').innerHTML = r.html; $('#blogPreviewBox').classList.remove('hidden'); }
  };
  if ($('#blogDelete')) $('#blogDelete').onclick = async () => {
    if (!(await askConfirm({ title: t('admin.blog.delete'), text: p.title, danger: true }))) return;
    const r = await api('admin/blog/delete', { id: p.id });
    if (r.ok) { blogEdit = null; renderAdminBlog(); }
  };
  $('#blogImage').onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    const image = await new Promise(resolve => { const fr = new FileReader(); fr.onload = () => resolve(fr.result); fr.readAsDataURL(file); });
    const r = await api('admin/blog/image', { image });
    if (!r.ok) return;
    if ($('#blogCover').checked) form.cover.value = r.url;
    else { const ta = form.body; ta.setRangeText(`\n![](${r.url})\n`, ta.selectionStart, ta.selectionEnd, 'end'); }
    toast(t('admin.blog.uploaded'), 'info');
  };
}

// visits per day (no cookies: see src/stats.js), where people come from, games started, script errors
async function renderAdminStats() {
  const res = await api('admin/stats');
  if (!res.ok || adminTab !== 'stats') return;
  const st = res.stats;
  const max = Math.max(1, ...st.days.map(d => d.views));
  const list = (rows, label = x => esc(x)) => (rows.length ? `<ul class="admin-stat-list">${rows.map(([k, n]) => `<li><span>${label(k)}</span><b>${n}</b></li>`).join('')}</ul>` : `<p class="muted small-text">${esc(t('admin.stats.none'))}</p>`);
  $('#adminBody').innerHTML = `
    <section class="player-section"><h3>${esc(t('admin.stats.days'))}</h3>
      <div class="admin-chart">${st.days.map(d => `<div class="admin-bar" title="${d.day}: ${esc(t('admin.stats.views'))} ${d.views} · ${esc(t('admin.stats.visitors'))} ${d.visitors} · ${esc(t('admin.stats.games'))} ${d.games}">
        <i style="height:${Math.round((d.views / max) * 100)}%"></i><em style="height:${Math.round((d.visitors / max) * 100)}%"></em><span>${d.day.slice(8)}</span></div>`).join('')}</div>
      <p class="muted small-text">${esc(t('admin.stats.legend'))} · ${esc(t('admin.stats.total', { v: st.days.reduce((a, d) => a + d.visitors, 0), g: st.days.reduce((a, d) => a + d.games, 0) }))}</p>
    </section>
    <section class="player-section"><h3>${esc(t('admin.stats.pages'))}</h3>${list(st.pages)}</section>
    <section class="player-section"><h3>${esc(t('admin.stats.refs'))}</h3>${list(st.refs)}</section>
    <section class="player-section"><h3>${esc(t('admin.stats.gamesBy'))}</h3>${list(st.games, g => esc(gameName(g)))}</section>
    <section class="player-section"><h3>${esc(t('admin.stats.errors'))}</h3>
      ${st.errors.length ? `<ul class="admin-errors">${st.errors.map(e => `<li><b>${esc(e.msg)}</b>${e.count > 1 ? ` ×${e.count}` : ''}
        <span class="muted small-text">${esc(e.page)} · ${esc((e.src || '').replace(location.origin, ''))}:${e.line} · ${esc(ago(e.at))}</span></li>`).join('')}</ul>`
        : `<p class="muted small-text">${esc(t('admin.stats.noErrors'))}</p>`}
    </section>`;
}

async function renderAdminLive() {
  const res = await api('admin/live');
  if (!res.ok || adminTab !== 'live') return;
  const body = $('#adminBody');
  body.innerHTML = `
    <section class="player-section"><h3>${esc(t('admin.online', { n: res.online.length }))}</h3>
      ${res.online.length ? `<div class="online-list">${res.online.map(u => `<span class="online-user">${avatarCore(u.username, u.avatar)}<b>${esc(u.username)}</b>
        <span class="muted small-text">${u.where.map(w => { const [g, code] = w.split(':'); return esc(gameName(g)) + (code ? ` · ${code}` : ''); }).join(', ')}</span></span>`).join('')}</div>`
        : `<p class="muted small-text">${esc(t('admin.nobodyOnline'))}</p>`}
    </section>
    <section class="player-section"><h3>${esc(t('admin.rooms', { n: res.rooms.length }))}</h3>
      ${res.rooms.length ? res.rooms.map(r => `<div class="admin-room">
        <span class="ag-ico">${gameIcon(r.game)}</span>
        <span class="admin-room-id"><b><span class="code">${r.code}</span> · ${esc(gameName(r.game))}</b>
          <span class="muted small-text">${esc(t('admin.phase.' + (r.phase === 'lobby' ? 'lobby' : r.phase === 'ended' ? 'ended' : 'playing')))} · ${esc(ago(r.lastActivity))}${r.spectators ? ` · 👁 ${r.spectators}` : ''}</span>
          <span class="small-text">${r.players.map(p => `<span class="${p.connected ? '' : 'muted'}">${esc(p.name)}</span>`).join(', ') || '—'}</span></span>
        <button class="danger small" data-end="${r.game}:${r.code}">${esc(t('admin.endRoom'))}</button>
      </div>`).join('') : `<p class="muted small-text">${esc(t('admin.noRooms'))}</p>`}
    </section>
    <button id="adminRefresh" class="ghost small">${esc(t('admin.refresh'))}</button>`;
  for (const b of body.querySelectorAll('[data-end]')) {
    b.onclick = async () => {
      const [game, code] = b.dataset.end.split(':');
      if (!(await askConfirm({ title: t('admin.endRoom'), text: t('admin.endConfirm', { code }), danger: true }))) return;
      const r = await api('admin/endRoom', { game, code });
      if (r.ok) { toast(t('admin.ended', { code }), 'info'); renderAdmin(); }
    };
  }
  $('#adminRefresh').onclick = renderAdmin;
}

async function renderAdminUsers() {
  const res = await api('admin/users');
  if (!res.ok || adminTab !== 'users') return;
  const body = $('#adminBody');
  const itemIds = Object.keys(ITEMS);
  body.innerHTML = res.users.map(u => `
    <div class="admin-user" data-user="${u.id}">
      <div class="admin-head">
        ${avatar(u.username, u.avatar, u.equipped)}
        <div class="admin-id"><b class="${nameCls(u.equipped)}">${esc(u.username)}</b>${statusPill(u.score)}
          <span class="muted small-text">${u.likes} 👍 · ${u.dislikes} 👎 · ${esc(t('admin.raw', { l: u.rawLikes, d: u.rawDislikes }))}</span></div>
      </div>
      <div class="admin-controls">
        <label class="admin-bonus">${esc(t('admin.bonus'))} <input type="number" value="${u.bonus}" data-bonus></label>
        <label class="check"><input type="checkbox" class="switch" data-shield ${u.dislikeShield ? 'checked' : ''}> ${esc(t('admin.shield'))}</label>
        <label class="check"><input type="checkbox" class="switch" data-usdt ${u.usdtAccess ? 'checked' : ''}> ${esc(t('admin.usdt'))}</label>
        <button class="danger small" data-lowest>${esc(t('admin.lowest'))}</button>
      </div>
      <div class="muted small-text">${esc(t('admin.dislikedBy'))}: ${u.dislikedBy.length ? u.dislikedBy.map(esc).join(', ') : esc(t('admin.nobody'))}</div>
      <div class="admin-items">
        ${u.inventory.map(id => `<span class="admin-item">${itemPreview(id)}${esc(t('item.' + id))}<button class="ghost small" data-take="${id}" aria-label="×">×</button></span>`).join('')}
        <select data-give><option value="">${esc(t('admin.give'))}</option>${itemIds.filter(id => !u.inventory.includes(id) && !ITEMS[id].auto).map(id => `<option value="${id}">${ITEMS[id].emoji || ''} ${esc(t('item.' + id))}</option>`).join('')}</select>
      </div>
      <div class="admin-controls admin-account">
        <form class="row" data-rename><input value="${esc(u.username)}" maxlength="20" aria-label="${esc(t('admin.rename'))}"><button class="small" type="submit">${esc(t('admin.rename'))}</button></form>
        <button class="ghost small" data-reset>${esc(t('admin.resetPassword'))}</button>
      </div>
      <div class="admin-controls admin-touches">
        <form class="row" data-title><input value="${esc(u.title || '')}" maxlength="32" placeholder="${esc(t('admin.titlePlaceholder'))}"><button class="small" type="submit">${esc(t('admin.setTitle'))}</button></form>
        <div class="badge-row">${(u.badges || []).map(b => `<span class="badge-chip">${esc(b.emoji)} ${esc(b.label)}<button class="ghost small" data-unbadge="${b.id}" aria-label="×">×</button></span>`).join('')}</div>
        <form class="row" data-badge><input class="badge-emoji" maxlength="8" placeholder="🏅"><input maxlength="32" placeholder="${esc(t('admin.badgePlaceholder'))}"><button class="small" type="submit">${esc(t('admin.addBadge'))}</button></form>
      </div>
      <div class="temp-pass hidden" data-temp></div>
    </div>`).join('');
  for (const row of body.querySelectorAll('[data-user]')) {
    const userId = row.dataset.user;
    const after = r => { if (r.ok) renderAdmin(); };
    row.querySelector('[data-bonus]').onchange = e => api('admin/karma', { userId, bonus: e.target.value }).then(after);
    row.querySelector('[data-shield]').onchange = e => api('admin/karma', { userId, dislikeShield: e.target.checked }).then(after);
    row.querySelector('[data-usdt]').onchange = e => api('admin/usdt', { userId, on: e.target.checked }).then(after);
    row.querySelector('[data-lowest]').onclick = () => api('admin/karma', { userId, lowest: true }).then(after);
    row.querySelector('[data-give]').onchange = e => e.target.value && api('admin/gift', { userId, itemId: e.target.value }).then(r => {
      if (r.ok) toast(t('admin.gifted', { name: r.user.username }), 'info');
      after(r);
    });
    for (const b of row.querySelectorAll('[data-take]')) b.onclick = () => api('admin/take', { userId, itemId: b.dataset.take }).then(after);
    row.querySelector('[data-title]').addEventListener('submit', e => { e.preventDefault(); api('admin/title', { userId, title: e.target.querySelector('input').value }).then(after); });
    row.querySelector('[data-badge]').addEventListener('submit', e => {
      e.preventDefault();
      const [emoji, label] = e.target.querySelectorAll('input');
      api('admin/badge', { userId, emoji: emoji.value, label: label.value }).then(after);
    });
    for (const b of row.querySelectorAll('[data-unbadge]')) b.onclick = () => api('admin/badge', { userId, remove: b.dataset.unbadge }).then(after);
    row.querySelector('[data-rename]').addEventListener('submit', async e => {
      e.preventDefault();
      const r = await api('admin/rename', { userId, username: e.target.querySelector('input').value });
      if (r.ok) { toast(t('admin.renamed', { name: r.user.username }), 'info'); if (account && userId === account.id) refreshAccount(); renderAdmin(); }
    });
    row.querySelector('[data-reset]').onclick = async () => {
      const name = row.querySelector('.admin-id b').textContent;
      if (!(await askConfirm({ title: t('admin.resetPassword'), text: t('admin.resetConfirm', { name }), danger: true }))) return;
      const r = await api('admin/resetPassword', { userId });
      if (!r.ok) return;
      const box = row.querySelector('[data-temp]');
      box.innerHTML = `${esc(t('admin.tempPassword', { name }))} <code>${esc(r.password)}</code> <button class="small" type="button">${esc(t('ui.copy'))}</button>`;
      box.classList.remove('hidden');
      box.querySelector('button').onclick = () => navigator.clipboard.writeText(r.password).then(() => toast(t('toast.copiedText'), 'info'), () => {});
    };
  }
}

// ---------- site features (admin): switch family mode, voice chat, transcripts on or off ----------
async function renderAdminFeatures() {
  const res = await fetch('/api/features').then(r => r.json()).catch(() => null);
  if (!res || !res.ok || adminTab !== 'features') return;
  const f = res.features;
  const body = $('#adminBody');
  body.innerHTML = `<p class="muted small-text">${esc(t('features.hint'))}</p>
    <div class="checks feature-list">${['signup', 'voice', 'transcripts', 'family'].map(k => `
      <label class="check"><input type="checkbox" class="switch" data-feature="${k}" ${f[k] ? 'checked' : ''} ${k === 'transcripts' && !f.voice ? 'disabled' : ''}>
        <span>${esc(t('features.' + k))}</span><small class="hint">${esc(t('features.' + k + '.hint'))}</small></label>`).join('')}</div>`;
  for (const input of body.querySelectorAll('[data-feature]')) {
    input.onchange = async () => {
      const r = await api('admin/features', { [input.dataset.feature]: input.checked });
      if (r.ok) { toast(t('features.saved'), 'info'); renderAdmin(); }
    };
  }
}

// ---------- invites (admin): registration needs a code ----------
const signupUrl = code => `${location.origin}/?invite=${code}`;
const copyText = text => navigator.clipboard.writeText(text).then(() => toast(t('toast.copiedText'), 'info'), () => toast(text));

async function renderAdminInvites() {
  const res = await api('admin/invites');
  if (!res.ok || adminTab !== 'invites') return;
  const body = $('#adminBody');
  body.innerHTML = `
    <form id="inviteForm" class="invite-form">
      <label class="field"><span>${esc(t('invite.uses'))}</span><select id="inviteUses">${[1, 3, 10, 30].map(n => `<option value="${n}">${n}</option>`).join('')}</select></label>
      <label class="field"><span>${esc(t('invite.table'))}</span><select id="inviteTable"><option value="">${esc(t('invite.noTable'))}</option>${myTables.map(tb => `<option value="${tb.id}">${esc(tb.name)}</option>`).join('')}</select></label>
      <button class="primary" type="submit">${esc(t('invite.create'))}</button>
    </form>
    <p class="muted small-text">${esc(t('invite.hint'))}</p>
    ${res.invites.length ? res.invites.map(i => `<div class="admin-room invite-row ${i.uses >= i.maxUses ? 'used' : ''}">
      <span class="admin-room-id"><b><span class="code">${esc(i.code)}</span> · ${esc(t('invite.usedOf', { n: i.uses, max: i.maxUses }))}</b>
        <span class="muted small-text">${i.table ? `${esc(i.table)} · ` : ''}${i.admin ? esc(t('invite.admin')) + ' · ' : ''}${esc(ago(i.createdAt))}${i.usedBy.length ? ` · ${esc(i.usedBy.join(', '))}` : ''}</span></span>
      ${i.uses < i.maxUses ? `<button class="small" data-copy-invite="${esc(i.code)}">${esc(t('invite.copyLink'))}</button>` : ''}
      <button class="ghost small" data-revoke="${esc(i.code)}">${esc(t('invite.revoke'))}</button>
    </div>`).join('') : `<p class="muted small-text">${esc(t('invite.none'))}</p>`}`;
  $('#inviteForm').addEventListener('submit', async e => {
    e.preventDefault();
    const r = await api('admin/invites', { maxUses: Number($('#inviteUses').value), tableId: $('#inviteTable').value || null });
    if (r.ok) { copyText(signupUrl(r.code)); renderAdmin(); }
  });
  for (const b of body.querySelectorAll('[data-copy-invite]')) b.onclick = () => copyText(signupUrl(b.dataset.copyInvite));
  for (const b of body.querySelectorAll('[data-revoke]')) b.onclick = () => api('admin/invites/revoke', { code: b.dataset.revoke }).then(renderAdmin);
}

// ---------- tables: a permanent space for the group, with the next-game picker ----------
let myTables = [];
let publicTables = [];
let tableMenu = null; // the table whose settings are open
let tablesTimer = null;
const tableUrl = id => `${location.origin}/?table=${id}`;

async function loadTables() {
  clearTimeout(tablesTimer);
  if (!account) { myTables = []; renderTables(); return; }
  const res = await fetch('/api/tables', { headers: { Authorization: `Bearer ${store.get(AUTH_KEY)}` } }).then(r => r.json()).catch(() => null);
  if (res && res.ok) myTables = res.tables;
  const pub = await fetch('/api/tables/public', { headers: { Authorization: `Bearer ${store.get(AUTH_KEY)}` } }).then(r => r.json()).catch(() => null);
  if (pub && pub.ok) publicTables = pub.tables;
  renderTables();
  // keep "who's online" fresh while the home screen is open
  if (Site.home) tablesTimer = setTimeout(() => { if (!document.hidden) loadTables(); else tablesTimer = setTimeout(loadTables, 20000); }, 20000);
}

function renderTables() {
  let box = $('#tables');
  if (!box) {
    $('#playCard').insertAdjacentHTML('afterbegin', '<div id="tables" class="tables hidden"></div>');
    box = $('#tables');
  }
  box.classList.toggle('hidden', !account || !Site.home);
  if (!account || !Site.home) return;
  const createForm = `<form class="row table-create hidden" id="tableCreate"><input id="tableName" maxlength="40" placeholder="${esc(t('table.namePlaceholder'))}"><button class="primary small" type="submit">${esc(t('table.create'))}</button></form>`;
  if (!myTables.length) {
    box.innerHTML = `<button class="ghost table-new" id="tableNew">${ico('table')} ${esc(t('table.createFirst'))}</button>${createForm}<p class="muted small-text table-help">${esc(t('table.help'))}</p>`;
  } else {
    box.innerHTML = myTables.map(tb => {
      const online = tb.members.filter(m => m.online).length;
      const cur = tb.current && tb.current.phase !== 'ended' ? tb.current : null;
      const open = tableMenu === tb.id;
      return `<div class="table-card">
        <div class="tc-head"><span class="tc-ico">${ico('table')}</span><span class="tc-title"><b>${esc(tb.name)}</b>${tb.public ? ` <span class="tag tc-public">${esc(t('table.publicTag'))}</span>` : ''}
          <span class="muted small-text">${esc(t('table.online', { n: online, total: tb.members.length }))}</span></span>
          ${tb.games ? `<button class="ghost small" data-tarchive="${tb.id}" title="${esc(t('archive.title'))}">${ico('book')} ${esc(t('archive.short'))}</button>` : ''}
          <button class="ghost small icon-only" data-tmenu="${tb.id}" aria-label="${esc(t('table.settings'))}" title="${esc(t('table.settings'))}">⋯</button></div>
        <div class="tc-members">${tb.members.map(m => `<span class="tc-member ${m.online ? 'on' : ''}" title="${esc(m.username)}">${avatar(m.username, m.avatar, m.equipped)}</span>`).join('')}</div>
        ${cur ? `<a class="tc-now g-${cur.game}" href="${gameUrl(cur.game, cur.code)}" data-go="${cur.game}:${cur.code}"><span class="ag-ico">${gameIcon(cur.game)}</span>
          <span class="tc-text"><b>${esc(t('table.now', { game: gameTitle(cur.game) }))}</b>
          <span class="muted small-text">${esc(t(cur.phase === 'lobby' ? 'active.lobby' : 'active.playing'))} · ${cur.players.map(p => esc(p.name)).join(', ') || esc(t('table.empty'))}</span></span>
          <span class="ag-go">${esc(t('table.join'))} →</span></a>` : ''}
        ${tb.canStart ? `<div class="tc-pick"><span class="muted small-text">${esc(t(cur ? 'table.newGame' : 'table.nextGame'))}</span>
          ${Object.keys(GAME_INFO).map(g => `<button data-start="${tb.id}:${g}">${gameIcon(g)} ${esc(gameTitle(g))}</button>`).join('')}</div>` : ''}
        ${open ? `<div class="tc-settings">
          <div class="row"><button class="small" data-tcopy="${tb.id}">${esc(t('table.copyLink'))}</button>
            ${account.admin ? `<button class="small" data-tinvite="${tb.id}">${esc(t('table.inviteNew'))}</button>` : ''}</div>
          <p class="muted small-text">${esc(t(account.admin ? 'table.linkHintAdmin' : 'table.linkHint'))}</p>
          ${tb.isOwner || account.admin ? `<div class="checks tc-vis"><label class="check"><input type="checkbox" class="switch" data-tpublic="${tb.id}" ${tb.public ? 'checked' : ''}>
            <span>${esc(t('table.public'))}</span><small class="hint">${esc(t('table.publicHint'))}</small></label></div>` : ''}
          ${tb.isOwner || account.admin ? `<form class="row" data-trename="${tb.id}"><input value="${esc(tb.name)}" maxlength="40"><button class="small" type="submit">${esc(t('table.rename'))}</button></form>
            <div class="tc-kick">${tb.members.filter(m => m.id !== tb.ownerId).map(m => `<span class="tc-kick-item">${esc(m.username)}<button class="ghost small" data-tkick="${tb.id}:${m.id}" aria-label="×">×</button></span>`).join('')}</div>` : ''}
          <div class="row"><button class="ghost small" id="tableNew">＋ ${esc(t('table.another'))}</button><button class="danger small" data-tleave="${tb.id}">${esc(t('table.leave'))}</button></div>
        </div>` : ''}
      </div>`;
    }).join('') + createForm;
  }
  // public tables of other people, to join with one tap
  if (publicTables.length) {
    box.insertAdjacentHTML('beforeend', `<div class="public-tables"><h3>${esc(t('table.browse'))}</h3>${publicTables.map(pt => `<div class="pt-row">
      <span class="tc-ico">${pt.live ? gameIcon(pt.live.game) : ico('table')}</span>
      <span class="tc-title"><b>${esc(pt.name)}</b><span class="muted small-text">${esc(t('table.online', { n: pt.online, total: pt.members }))}${pt.live ? ` · ${esc(t('table.now', { game: gameTitle(pt.live.game) }))}` : ''}</span></span>
      <button class="small" data-tjoin="${pt.id}">${esc(t('table.joinPublic'))}</button></div>`).join('')}</div>`);
  }
  const after = r => { if (r.ok) loadTables(); };
  const newBtn = $('#tableNew');
  if (newBtn) newBtn.onclick = () => { $('#tableCreate').classList.remove('hidden'); $('#tableName').focus(); };
  $('#tableCreate').addEventListener('submit', async e => {
    e.preventDefault();
    const r = await api('tables/create', { name: $('#tableName').value });
    if (r.ok) { tableMenu = r.table.id; toast(t('table.created'), 'info'); loadTables(); }
  });
  for (const b of box.querySelectorAll('[data-tmenu]')) b.onclick = () => { tableMenu = tableMenu === b.dataset.tmenu ? null : b.dataset.tmenu; renderTables(); };
  for (const b of box.querySelectorAll('[data-start]')) {
    b.onclick = async () => {
      const [id, game] = b.dataset.start.split(':');
      b.disabled = true;
      const r = await api('tables/start', { id, game });
      b.disabled = false;
      if (r.ok) followTable(r, true);
    };
  }
  for (const a of box.querySelectorAll('[data-go]')) {
    a.onclick = e => {
      const [game, code] = a.dataset.go.split(':');
      if (game !== Site.game) return; // a normal link to the other game's page
      e.preventDefault();
      send('join', { code });
    };
  }
  for (const b of box.querySelectorAll('[data-tcopy]')) b.onclick = () => copyText(tableUrl(b.dataset.tcopy));
  for (const b of box.querySelectorAll('[data-tpublic]')) b.onchange = () => api('tables/visibility', { id: b.dataset.tpublic, public: b.checked }).then(after);
  for (const b of box.querySelectorAll('[data-tjoin]')) {
    b.onclick = async () => {
      const r = await api('tables/join', { id: b.dataset.tjoin });
      if (r.ok) { toast(t('table.joined', { name: r.table.name }), 'info'); loadTables(); }
    };
  }
  for (const b of box.querySelectorAll('[data-tarchive]')) b.onclick = () => openArchive(b.dataset.tarchive);
  for (const b of box.querySelectorAll('[data-tinvite]')) {
    b.onclick = async () => {
      const r = await api('admin/invites', { maxUses: 1, tableId: b.dataset.tinvite });
      if (r.ok) copyText(`${signupUrl(r.code)}`);
    };
  }
  for (const f of box.querySelectorAll('[data-trename]')) {
    f.addEventListener('submit', e => { e.preventDefault(); api('tables/rename', { id: f.dataset.trename, name: f.querySelector('input').value }).then(after); });
  }
  for (const b of box.querySelectorAll('[data-tkick]')) {
    b.onclick = () => { const [id, userId] = b.dataset.tkick.split(':'); api('tables/kick', { id, userId }).then(after); };
  }
  for (const b of box.querySelectorAll('[data-tleave]')) {
    b.onclick = async () => (await askConfirm({ title: t('table.leave'), text: t('table.leaveConfirm'), danger: true })) && api('tables/leave', { id: b.dataset.tleave }).then(r => { tableMenu = null; after(r); });
  }
}

// Someone at one of my tables started the next game: follow them there (or offer to, mid-game).
async function followTable(call, mine = false) {
  const url = gameUrl(call.game, call.code);
  if (!mine && Site.hooks.busy()) {
    const box = $('#tableCall');
    box.innerHTML = `<span>${gameIcon(call.game)} ${esc(t('table.call', { name: call.by, table: call.table, game: gameTitle(call.game) }))}</span>
      <a class="primary small btn-link" href="${url}">${esc(t('table.go'))}</a><button class="ghost small" type="button" aria-label="×">×</button>`;
    box.classList.remove('hidden');
    box.querySelector('button').onclick = () => box.classList.add('hidden');
    box.querySelector('a').onclick = async e => { e.preventDefault(); await Site.hooks.leave(); location.href = url; };
    if (alertsOn) chime();
    return;
  }
  if (!mine) {
    toast(t('table.moving', { name: call.by, game: gameTitle(call.game) }), 'info');
    if (alertsOn) chime();
    await new Promise(r => setTimeout(r, 1200));
  }
  await Site.hooks.leave();
  location.href = url;
}

// ---------- Mafia rounds: the AI's live notes, and who votes together (from the votes) ----------
// One day's note: summary, who accused / defended whom, who seems to play together, quotes.
function roundNoteHtml(r, retro) {
  const n = r.note;
  const dots = k => '●'.repeat(k) + '○'.repeat(3 - k);
  return `<section class="round-note">
    <h4>${esc(t('archive.day', { n: r.day }))}</h4>
    <p>${esc(n.summary)}</p>
    ${n.accusations.length ? `<div class="rn-block"><span class="rn-label">${esc(t('rounds.accused'))}</span><ul>${n.accusations.map(a => `<li><b>${esc(a.from)}</b> → <b>${esc(a.to)}</b> <span class="rn-dots" title="${esc(t('rounds.strength'))}">${dots(a.strength)}</span>${a.why ? ` <span class="muted">${esc(a.why)}</span>` : ''}</li>`).join('')}</ul></div>` : ''}
    ${n.defenses.length ? `<div class="rn-block"><span class="rn-label">${esc(t('rounds.defended'))}</span><ul>${n.defenses.map(d => `<li><b>${esc(d.from)}</b> 🛡 <b>${esc(d.to)}</b></li>`).join('')}</ul></div>` : ''}
    ${n.alliances.length ? `<div class="rn-block"><span class="rn-label">${esc(t('rounds.together'))}</span><ul>${n.alliances.map(a => `<li><b>${a.players.map(esc).join(' + ')}</b>${a.why ? ` <span class="muted">${esc(a.why)}</span>` : ''}</li>`).join('')}</ul></div>` : ''}
    ${n.suspects.length ? `<div class="rn-block"><span class="rn-label">${esc(t('rounds.suspects'))}</span><div class="badge-row">${n.suspects.map(x => `<span class="badge-chip">${esc(x.name)}${x.by.length ? ` <span class="muted">← ${x.by.map(esc).join(', ')}</span>` : ''}</span>`).join('')}</div></div>` : ''}
    ${n.quotes.length ? `<div class="rn-quotes">${n.quotes.map(q => `<blockquote>«${esc(q.text)}» <span class="muted">— ${esc(q.name)}</span></blockquote>`).join('')}</div>` : ''}
    ${retro ? `<p class="rn-retro">✨ ${esc(retro)}</p>` : ''}
  </section>`;
}

// Pairs who voted for the same target most often, from the actual votes (no AI involved).
// history: [{ type: 'vote', votes: { voterId: targetId | 'skip' } }], name(id)
function votePairs(history, name) {
  const pair = {};
  for (const h of history.filter(x => x.type === 'vote')) {
    const voters = Object.keys(h.votes);
    for (let i = 0; i < voters.length; i++) {
      for (let j = i + 1; j < voters.length; j++) {
        const [a, b] = [voters[i], voters[j]].sort();
        const p = (pair[a + '|' + b] ||= { a, b, same: 0, both: 0 });
        p.both += 1;
        if (h.votes[a] === h.votes[b]) p.same += 1;
      }
    }
  }
  return Object.values(pair).filter(p => p.same >= 2).sort((x, y) => y.same / y.both - x.same / x.both || y.same - x.same).slice(0, 6)
    .map(p => ({ names: [name(p.a), name(p.b)], same: p.same, both: p.both }));
}
function votePairsHtml(pairs) {
  if (!pairs.length) return '';
  return `<div class="rn-block vote-pairs"><span class="rn-label">${esc(t('rounds.votedTogether'))}</span>
    <ul>${pairs.map(p => `<li><b>${p.names.map(esc).join(' + ')}</b> <span class="muted">${esc(t('rounds.votedOf', { n: p.same, of: p.both }))}</span></li>`).join('')}</ul></div>`;
}

// ---------- after a Mafia game: the AI's read and the voice transcript ----------
function insightsHtml(ins) {
  if (!ins) return '';
  const line = p => `<li><b>${esc(p.name)}</b> — ${esc(p.line)}${p.accused && p.accused.length ? ` <span class="muted small-text">(${esc(t('insights.accused', { names: p.accused.join(', ') }))})</span>` : ''}</li>`;
  return `<section class="insights">
    <h3>✨ ${esc(t('insights.title'))}</h3>
    <p>${esc(ins.summary)}</p>
    ${ins.mvp || ins.bestBluff ? `<div class="badge-row">${ins.mvp ? `<span class="badge-chip">🏆 ${esc(t('insights.mvp'))}: ${esc(ins.mvp)}</span>` : ''}${ins.bestBluff ? `<span class="badge-chip">🎭 ${esc(t('insights.bluff'))}: ${esc(ins.bestBluff)}</span>` : ''}</div>` : ''}
    ${ins.moments.length ? `<ul class="insight-moments">${ins.moments.map(m => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}
    ${ins.players.length ? `<ul class="insight-players">${ins.players.map(line).join('')}</ul>` : ''}
    ${ins.pairs && ins.pairs.length ? `<div class="rn-block"><span class="rn-label">${esc(t('rounds.realPairs'))}</span><ul>${ins.pairs.map(p => `<li><b>${p.players.map(esc).join(' + ')}</b> — ${esc(p.note)}</li>`).join('')}</ul></div>` : ''}
    <p class="muted small-text">${esc(t('insights.note'))}</p>
  </section>`;
}
// all of a game's round notes, with the AI's look back at each day once roles are known
function roundsHtml(notes, ins) {
  if (!notes || !notes.length) return '';
  const retro = day => ins && ins.rounds && (ins.rounds.find(r => r.day === day) || {}).note;
  return `<details class="transcript rounds-details"><summary>${esc(t('rounds.title', { n: notes.length }))}</summary><div class="rounds-list">${notes.map(r => roundNoteHtml(r, retro(r.day))).join('')}</div></details>`;
}
function transcriptHtml(lines) {
  if (!lines || !lines.length) return '';
  const tag = l => (l.channel === 'mafia' ? ` <span class="tag mafia">${esc(t('voice.ch.mafia'))}</span>` : l.channel === 'dead' ? ` <span class="tag">${esc(t('voice.ch.out'))}</span>` : '');
  let last = '';
  const rows = lines.map(l => {
    const head = `${l.phase}:${l.day}`;
    const sep = head !== last ? `<li class="tr-sep">${esc(t(l.phase === 'night' ? 'archive.night' : 'archive.day', { n: l.day }))}</li>` : '';
    last = head;
    return `${sep}<li><b>${esc(l.name)}</b>${tag(l)}: ${esc(l.text)}</li>`;
  }).join('');
  return `<details class="transcript"><summary>${esc(t('transcript.title', { n: lines.length }))}</summary><ol class="tr-lines">${rows}</ol></details>`;
}

// ---------- the game night archive ----------
document.body.insertAdjacentHTML('beforeend', `<div id="archive" class="overlay hidden" role="dialog" aria-modal="true">
  <div class="sheet player-sheet archive-sheet"><div class="sheet-head"><h2 id="archiveTitle"></h2><button id="archiveClose" class="ghost small" data-i18n="ui.close"></button></div>
  <div id="archiveBody" class="sheet-body archive-body"></div></div></div>`);
$('#archiveClose').onclick = () => closeOverlay('archive');
$('#archive').addEventListener('pointerdown', e => { if (e.target.id === 'archive') closeOverlay('archive'); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeOverlay('archive'); });
let archiveData = null;
let archiveOpen = 0; // the night shown expanded

async function openArchive(tableId) {
  const res = await api('archive' + (tableId ? `?table=${encodeURIComponent(tableId)}` : ''));
  if (!res.ok) return;
  archiveData = res;
  archiveOpen = 0;
  $('#archiveTitle').textContent = tableId ? t('archive.titleOf', { name: res.table }) : t('archive.mine');
  renderArchive();
  $('#archive').classList.remove('hidden');
}

const fmtNightDate = ts => new Date(ts).toLocaleDateString(lang === 'ru' ? 'ru-RU' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtTime = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const mins = ms => Math.max(1, Math.round(ms / 60000));

// Facts about one night: the MVP, who kept dying first, the biggest rent, the longest game.
function nightFacts(night) {
  const wins = {}, played = {}, firstOut = {};
  let longest = null, bigRent = null, mafiaWins = 0, townWins = 0;
  for (const g of night.games) {
    for (const p of g.players) { played[p.name] = (played[p.name] || 0) + 1; if (p.won) wins[p.name] = (wins[p.name] || 0) + 1; }
    const len = g.endedAt - (g.startedAt || g.endedAt);
    if (!longest || len > longest.len) longest = { len, game: g.game };
    if (g.game === 'mafia') {
      if (g.winner === 'mafia') mafiaWins++; else townWins++;
      const first = (g.timeline || []).find(e => e.killed || e.out);
      if (first) { const n = first.killed || first.out; firstOut[n] = (firstOut[n] || 0) + 1; }
    }
    if (g.highlights && g.highlights.rent && (!bigRent || g.highlights.rent.amount > bigRent.amount)) bigRent = g.highlights.rent;
  }
  const top = obj => { const best = Math.max(0, ...Object.values(obj)); return best ? [Object.keys(obj).filter(k => obj[k] === best), best] : null; };
  const facts = [];
  const mvp = top(wins);
  if (mvp) facts.push(['🏆', t('archive.mvp'), `${mvp[0].join(', ')} · ${t('archive.wins', { n: mvp[1] })}`]);
  const unlucky = top(firstOut);
  if (unlucky && unlucky[1] >= 2) facts.push(['💀', t(i18nVariant === 'family' ? 'archive.firstOutFamily' : 'archive.firstOut'), `${unlucky[0].join(', ')} · ${t('archive.times', { n: unlucky[1] })}`]);
  if (mafiaWins + townWins) facts.push(['🎩', t('archive.mafiaScore'), t('archive.mafiaScoreLine', { town: townWins, mafia: mafiaWins })]);
  if (bigRent) facts.push(['💸', t('mono.sum.bigRent'), `${money(bigRent.amount)} · ${bigRent.from} → ${bigRent.to}`]);
  if (longest && night.games.length > 1) facts.push(['⏱️', t('archive.longest'), `${gameTitle(longest.game)} · ${t('archive.minutes', { n: mins(longest.len) })}`]);
  return facts;
}

function gameHtml(g) {
  const length = t('archive.minutes', { n: mins(g.endedAt - (g.startedAt || g.endedAt)) });
  if (g.game === 'mafia') {
    const win = g.winner === 'mafia' ? t('archive.mafiaWon') : t('archive.townWon');
    const players = g.players.map(p => `<span class="tag ${p.team === 'mafia' ? 'mafia' : 'town'} ${p.won ? '' : 'lost'}" title="${esc(t('role.' + p.role))}">${esc(p.name)} · ${esc(t('role.' + p.role))}${p.survived ? '' : ' ✝'}</span>`).join('');
    const tl = (g.timeline || []).map(e => (e.type === 'night'
      ? `<li>${esc(t('archive.night', { n: e.day }))}: ${e.killed ? esc(t(g.family ? 'archive.outFamily' : 'archive.killed', { name: e.killed })) : esc(t(e.saved ? 'archive.saved' : 'archive.quietNight'))}</li>`
      : `<li>${esc(t('archive.day', { n: e.day }))}: ${e.out ? esc(t('archive.votedOut', { name: e.out })) : esc(t('archive.noVote'))}</li>`)).join('');
    return `<div class="arch-game"><div class="arch-head">${ico('hat')}<b>${esc(t('site.mafia'))}</b><span class="tag ${g.winner === 'mafia' ? 'mafia' : 'town'}">${esc(win)}</span>
      <span class="muted small-text">${fmtTime(g.startedAt || g.endedAt)} · ${esc(length)} · ${esc(t('archive.days', { n: g.days }))}</span></div>
      <div class="arch-players">${players}</div>${tl ? `<ol class="arch-timeline">${tl}</ol>` : ''}
      ${roundsHtml(g.roundNotes, g.insights)}${insightsHtml(g.insights)}${transcriptHtml(g.transcript)}</div>`;
  }
  if (g.game === 'spy') {
    const ranked = g.players.map(p => `<li><b>${esc(p.name)}</b><span class="spacer"></span><span>${esc(t('spy.points', { n: p.points }))}</span></li>`).join('');
    const rounds = g.rounds.map(r => `<li>${esc(t('spy.round', { n: r.n }))}: ${esc(t('spy.spyWas', { name: r.spy }))} — <span class="tag ${r.winner === 'spy' ? 'mafia' : 'town'}">${esc(t('spy.reason.' + r.reason))}</span></li>`).join('');
    return `<div class="arch-game"><div class="arch-head">${ico('spy')}<b>${esc(t('site.spyfall'))}</b>${g.winner ? `<span class="tag town">${esc(t('archive.winner', { name: g.winner }))}</span>` : ''}
      <span class="muted small-text">${fmtTime(g.startedAt || g.endedAt)} · ${esc(length)}</span></div>
      <ol class="arch-standings">${ranked}</ol><ol class="arch-timeline">${rounds}</ol></div>`;
  }
  if (g.game === 'poker') {
    const ranked = g.players.map((p, i) => `<li><span class="board-rank">${['🥇', '🥈', '🥉'][i] || i + 1}</span><b>${esc(p.name)}</b><span class="spacer"></span><span>${p.net > 0 ? '+' : ''}${p.net}</span></li>`).join('');
    return `<div class="arch-game"><div class="arch-head">${ico('chip')}<b>${esc(t('site.poker'))}</b>${g.winner ? `<span class="tag town">${esc(t('archive.winner', { name: g.winner }))}</span>` : ''}
      <span class="muted small-text">${fmtTime(g.startedAt || g.endedAt)} · ${esc(length)} · ${esc(t('pk.handsN', { n: g.hands }))}</span></div>
      <ol class="arch-standings">${ranked}</ol></div>`;
  }
  if (g.game === 'cit') {
    const ranked = g.players.map((p, i) => `<li><span class="board-rank">${['🥇', '🥈', '🥉'][i] || i + 1}</span><b>${esc(p.name)}</b><span class="spacer"></span><span>${esc(t('cit.points', { n: p.points }))}</span></li>`).join('');
    return `<div class="arch-game"><div class="arch-head">${ico('castle')}<b>${esc(t('site.citadels'))}</b>${g.winner ? `<span class="tag town">${esc(t('archive.winner', { name: g.winner }))}</span>` : ''}
      <span class="muted small-text">${fmtTime(g.startedAt || g.endedAt)} · ${esc(length)} · ${esc(t('cit.rounds', { n: g.rounds }))}</span></div>
      <ol class="arch-standings">${ranked}</ol></div>`;
  }
  const rows = g.players.map(p => `<li><span class="board-rank">${['🥇', '🥈', '🥉'][p.place - 1] || p.place}</span><b>${esc(p.name)}</b><span class="spacer"></span>${p.bankrupt ? `<span class="tag mafia">${esc(t('mono.bankrupt'))}</span>` : `<span>${money(p.netWorth)}</span>`}</li>`).join('');
  return `<div class="arch-game"><div class="arch-head">${ico('dice')}<b>${esc(t('site.monopoly'))}</b>${g.winner ? `<span class="tag town">${esc(t('archive.winner', { name: g.winner }))}</span>` : ''}
    <span class="muted small-text">${fmtTime(g.startedAt || g.endedAt)} · ${esc(length)} · ${esc(t('mono.sum.rounds', { n: g.rounds }))}</span></div>
    <ol class="arch-standings">${rows}</ol></div>`;
}

function nightSummaryText(night) {
  const lines = [`${fmtNightDate(night.start)} — ${t('archive.gamesN', { n: night.games.length })}`];
  for (const [ico_, label, value] of nightFacts(night)) lines.push(`${ico_} ${label}: ${value}`);
  for (const g of night.games) lines.push(g.game === 'mafia'
    ? `🎩 ${t('site.mafia')}: ${g.winner === 'mafia' ? t('archive.mafiaWon') : t('archive.townWon')}`
    : `${{ spy: '🕵️', cit: '🏰', poker: '♠️' }[g.game] || '🎲'} ${gameTitle(g.game)}: ${t('archive.winner', { name: g.winner || '—' })}`);
  return lines.join('\n');
}

function renderArchive() {
  const nights = archiveData.nights;
  if (!nights.length) { $('#archiveBody').innerHTML = `<p class="muted">${esc(t('archive.empty'))}</p>`; return; }
  $('#archiveBody').innerHTML = nights.map((n, i) => {
    const open = i === archiveOpen;
    const facts = nightFacts(n);
    return `<section class="night ${open ? 'open' : ''}">
      <button class="night-head" data-night="${i}"><span class="night-date">${esc(fmtNightDate(n.start))}</span>
        <span class="muted small-text">${fmtTime(n.start)}–${fmtTime(n.end)} · ${esc(t('archive.gamesN', { n: n.games.length }))}</span>
        <span class="night-icons">${n.games.map(g => gameIcon(g.game)).join('')}</span></button>
      ${open ? `<div class="night-body">
        ${facts.length ? `<div class="highlights">${facts.map(([ic, label, value]) => `<div class="hl"><span class="hl-ico">${ic}</span><span class="hl-text"><span class="muted small-text">${esc(label)}</span><b>${esc(value)}</b></span></div>`).join('')}</div>` : ''}
        ${n.games.slice().reverse().map(gameHtml).join('')}
        <button class="small" data-copy-night="${i}">${esc(t('archive.copy'))}</button>
      </div>` : ''}
    </section>`;
  }).join('');
  for (const b of $$('#archiveBody [data-night]')) b.onclick = () => { archiveOpen = archiveOpen === +b.dataset.night ? -1 : +b.dataset.night; renderArchive(); };
  for (const b of $$('#archiveBody [data-copy-night]')) b.onclick = () => copyText(nightSummaryText(nights[+b.dataset.copyNight]));
}

// ---------- host renames people (only inside the room; account names stay) ----------
let renameFor = null;
function openRename(pid, anchor, name) {
  renameFor = pid;
  const menu = $('#renameMenu');
  $('#renameTitle').textContent = t('rename.title', { name });
  $('#renameInput').value = name;
  menu.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${window.scrollX + Math.min(window.innerWidth - menu.offsetWidth - 12, Math.max(12, r.left))}px`;
  menu.style.top = `${window.scrollY + r.bottom + 6}px`;
  $('#renameInput').focus();
  $('#renameInput').select();
}
const closeRename = () => { renameFor = null; $('#renameMenu').classList.add('hidden'); };
$('#renameForm').addEventListener('submit', async e => {
  e.preventDefault();
  const res = await send('rename', { playerId: renameFor, name: $('#renameInput').value });
  if (res && res.ok) closeRename();
});
document.addEventListener('pointerdown', e => {
  if (renameFor && !e.target.closest('#renameMenu') && !e.target.closest('[data-rename]')) closeRename();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeRename(); });

// ---------- language ----------
const langSelect = $('#langSelect');
langSelect.innerHTML = Object.entries(LANGS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
langSelect.value = lang;
langSelect.onchange = () => {
  setLang(langSelect.value);
  applyStaticTranslations();
  renderAuthMode();
  renderAlertsBtn();
  renderFooter();
  renderDecor();
  renderAccount();
  if (!$('#profile').classList.contains('hidden')) renderProfile();
  if (!$('#admin').classList.contains('hidden')) renderAdmin();
  Site.hooks.onLang();
};

// ---------- start-up: the page hands over its socket and hooks ----------
Site.init = function init({ game, socket, urlRoom, hooks }) {
  Site.game = game;
  Site.socket = socket;
  Site.urlRoom = urlRoom;
  Object.assign(Site.hooks, hooks);
  socket.on('gift', refreshAccount);
  renderInvite();
  socket.on('tableGame', call => { loadTables(); followTable(call, account && call.byId === account.id); });
  // the admin reset this account's password: every open page goes back to the login form
  socket.on('loggedOut', () => { store.set(AUTH_KEY, null); account = null; renderAccount(); toast(t('toast.loggedOut')); });
  renderAuthMode();
  renderAlertsBtn();
  (async () => {
    if (store.get(AUTH_KEY)) {
      const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${store.get(AUTH_KEY)}` } }).then(r => r.json()).catch(() => null);
      if (res && res.ok) {
        account = res.user;
        // the first visit of the day pays the site-chips bonus
        if (res.daily) setTimeout(() => toast(t('chips.daily', res.daily), 'info'), 800);
      } else if (res) store.set(AUTH_KEY, null); // expired or logged out elsewhere
    }
    if (!account && qs.get('table')) toast(t('table.loginFirst'), 'info');
    Site.ready = true;
    renderAccount();
    // the name field gets the focus on a game page (it's in the first screen), not on the home page
    if (!account) { if (Site.game !== 'hub') $('#authUser').focus({ preventScroll: true }); return; }
    // a table link (?table=…), possibly kept from before logging in
    const table = await joinPendingTable();
    // following a table into its new room (?room=…&join=1)
    const code = (qs.get('room') || '').toUpperCase();
    if (qs.get('join') === '1' && code) send('join', { code });
    if (table || qs.get('join')) history.replaceState(null, '', location.pathname + (code ? `?room=${code}` : ''));
  })();
};
const PENDING_TABLE_KEY = 'site.pendingTable';
async function joinPendingTable() {
  let table = null;
  try { table = sessionStorage.getItem(PENDING_TABLE_KEY); sessionStorage.removeItem(PENDING_TABLE_KEY); } catch {}
  if (!table) return null;
  const r = await api('tables/join', { id: table });
  if (r.ok) { toast(t('table.joined', { name: r.table.name }), 'info'); loadTables(); }
  return table;
}
const qs = new URLSearchParams(location.search);
// an invite link (?invite=…) opens the registration form with the code filled in
if (qs.get('invite')) {
  authMode = 'register';
  $('#authInvite').value = qs.get('invite').toUpperCase().slice(0, 12);
}
// the links every home screen ends with, and what signing up means
const REPO_URL = 'https://github.com/bluepe4u/MafiaGame';
function renderFooter() {
  const home = document.getElementById('home');
  if (!home) return;
  let el = document.getElementById('siteFooter');
  if (!el) { el = document.createElement('footer'); el.id = 'siteFooter'; el.className = 'site-footer'; home.append(el); }
  el.innerHTML = [['/blog/', 'footer.blog'], ['/terms/', 'footer.terms'], ['/privacy/', 'footer.privacy'], ['/poker/fair.html', 'footer.fair'], [REPO_URL, 'footer.source']]
    .map(([href, key]) => `<a href="${href}"${href.startsWith('http') ? ' target="_blank" rel="noopener"' : ''}>${esc(t(key))}</a>`).join(' · ');
  const hint = document.querySelector('#authCard .auth-hint');
  if (hint) {
    let legal = document.getElementById('authLegal');
    if (!legal) { legal = document.createElement('p'); legal.id = 'authLegal'; legal.className = 'muted small-text auth-legal'; hint.after(legal); }
    legal.innerHTML = legalHtml(authMode);
    legal.classList.toggle('hidden', authMode !== 'register' && authMode !== 'guest');
  }
}
renderFooter();
// drawn icons and player counts in the page's own markup (game pages, the home page)
function renderDecor() {
  for (const el of document.querySelectorAll('[data-ico]')) el.innerHTML = ico(el.dataset.ico);
  for (const el of document.querySelectorAll('[data-players]')) el.textContent = t('hub.players', { n: el.dataset.players });
}
renderDecor();
// remember a table link through logging in / registering
try { if (qs.get('table')) sessionStorage.setItem(PENDING_TABLE_KEY, qs.get('table')); } catch {}

// The page tells us whether its home screen is showing (for the "back to my game" banner).
Site.setHome = function setHome(home) {
  document.body.classList.toggle('at-home', !!home); // the games show in the top bar on the home screen
  if (home === Site.home) return;
  Site.home = home;
  refreshHome();
};
