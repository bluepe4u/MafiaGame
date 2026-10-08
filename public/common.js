'use strict';

// Shared by both games (Mafia at /, Monopoly at /monopoly/): small helpers, the login,
// avatars and cosmetics, sounds and turn alerts, one profile window (stats for both games,
// wardrobe, account), the admin panel, gifts and the "back to my game" banner.
// A page loads i18n.js, then this file, then its own script, which calls Site.init().

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};
const AUTH_KEY = 'mafia.auth'; // one login for the whole site
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
};

// The page's settings and hooks (filled in by Site.init)
const Site = {
  game: 'mafia', // or 'mono'
  socket: null,
  baseTitle: document.title,
  home: false,
  urlRoom: () => '',
  hooks: { onAccount() {}, onLang() {}, onItems() {}, celebrate() {} },
};

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
const statusPill = score => score === null || score === undefined ? '' : `<span class="status t${tierOf(score)}">${esc(t('tier.' + tierOf(score)))}</span>`;

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
        </div>
        <div id="adminBody" class="admin-body"></div>
      </div>
    </div>
  </div>
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

// ---------- accounts ----------
let account = null; // the logged-in user's profile (see UserStore.publicProfile)
let authMode = 'login';

function setAccount(user, token) {
  if (token !== undefined) store.set(AUTH_KEY, token);
  account = user;
  // reconnect so the server knows who this socket belongs to
  Site.socket.disconnect().connect();
  renderAccount();
}

function renderAuthMode() {
  for (const b of $$('[data-auth-mode]')) b.classList.toggle('active', b.dataset.authMode === authMode);
  $('#authSubmit').textContent = t(authMode === 'login' ? 'auth.login' : 'auth.register');
  $('#authPass').autocomplete = authMode === 'login' ? 'current-password' : 'new-password';
}
for (const b of $$('[data-auth-mode]')) b.onclick = () => { authMode = b.dataset.authMode; renderAuthMode(); };
$('#authCard').addEventListener('submit', async e => {
  e.preventDefault();
  const res = await api(authMode, { username: $('#authUser').value, password: $('#authPass').value });
  if (!res.ok) return;
  $('#authPass').value = '';
  setAccount(res.user, res.token);
  toast(t('toast.welcome', { name: res.user.username }), 'info');
});

function renderAccount() {
  $('#authCard').classList.toggle('hidden', !!account);
  $('#playCard').classList.toggle('hidden', !account);
  $('#profileBtn').classList.toggle('hidden', !account);
  $('#boardBtn').classList.toggle('hidden', !account);
  if (account) {
    $('#profileBtn').innerHTML = avatar(account.username, account.avatar, account.equipped);
    $('#profileBtn').title = t('profile.open');
    $('#homeProfile').innerHTML = `${avatar(account.username, account.avatar, account.equipped)}
      <span class="me-text"><b class="${nameCls(account.equipped)}">${esc(account.username)}</b>${statusPill(account.score)}</span>`;
    queueGifts(account.gifts);
  }
  Site.hooks.onAccount();
  renderActive();
}

async function refreshAccount() {
  const res = await api('me');
  if (res.ok) { account = res.user; renderAccount(); }
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
async function renderActive() {
  let box = $('#activeGames');
  if (!box) {
    $('#playCard').insertAdjacentHTML('afterbegin', '<div id="activeGames" class="active-games hidden"></div>');
    box = $('#activeGames');
  }
  if (!account || !Site.home) { box.classList.add('hidden'); return; }
  const res = await fetch('/api/active', { headers: { Authorization: `Bearer ${store.get(AUTH_KEY)}` } }).then(r => r.json()).catch(() => null);
  activeRooms = (res && res.ok && res.rooms) || [];
  if (!Site.home) return;
  // an invite link to a room we're already in: go straight back in
  const here = activeRooms.find(r => r.game === Site.game && r.code === Site.urlRoom());
  if (here) { send('join', { code: here.code }); return; }
  box.classList.toggle('hidden', !activeRooms.length);
  box.innerHTML = activeRooms.map(r => `
    <a class="active-game g-${r.game}" href="${r.game === 'mono' ? '/monopoly/' : '/'}?room=${r.code}" data-active="${r.game}:${r.code}">
      <span class="ag-ico">${r.game === 'mono' ? '🎲' : '🎩'}</span>
      <span class="ag-text"><b>${esc(t('active.title', { game: t(r.game === 'mono' ? 'site.monopoly' : 'site.mafia') }))}</b>
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
      ${statusPill(u.score)}
      <div class="karma"><span class="karma-up">${COMMON_ICONS.up}${esc(t('profile.likes', { n: u.likes }))}</span><span class="karma-down">${COMMON_ICONS.down}${esc(t('profile.dislikes', { n: u.dislikes }))}</span></div>
    </div>`;
  const tabs = ['mafia', 'mono', ...(self ? ['wardrobe', 'account'] : [])];
  if (!tabs.includes(profileTab)) profileTab = Site.game;
  $('#profileTabs').innerHTML = tabs.map(k => `<button class="${k === profileTab ? 'active' : ''}" data-ptab="${k}">${esc(t('profile.tab.' + k))}</button>`).join('');
  for (const b of $$('#profileTabs [data-ptab]')) b.onclick = () => { profileTab = b.dataset.ptab; renderProfile(); };
  $('#profileBody').innerHTML = { mafia: mafiaStatsHtml, mono: monoStatsHtml, wardrobe: wardrobeHtml, account: accountHtml }[profileTab](u);
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
  return `<form id="passwordForm" class="password-form" autocomplete="on">
      <h3>${esc(t('profile.changePassword'))}</h3>
      <input type="text" name="username" autocomplete="username" value="${esc(account.username)}" hidden>
      <div class="row">
        <input id="oldPass" type="password" autocomplete="current-password" placeholder="${esc(t('profile.oldPassword'))}">
        <input id="newPass" type="password" autocomplete="new-password" placeholder="${esc(t('profile.newPassword'))}">
        <button type="submit">${esc(t('profile.save'))}</button>
      </div>
    </form>
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
const gameName = g => t(g === 'mono' ? 'site.monopoly' : 'site.mafia');

async function renderAdmin() {
  for (const b of $$('[data-admin-tab]')) b.classList.toggle('active', b.dataset.adminTab === adminTab);
  return adminTab === 'live' ? renderAdminLive() : renderAdminUsers();
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
        <span class="ag-ico">${r.game === 'mono' ? '🎲' : '🎩'}</span>
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
      if (!confirm(t('admin.endConfirm', { code }))) return;
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
        <button class="danger small" data-lowest>${esc(t('admin.lowest'))}</button>
      </div>
      <div class="muted small-text">${esc(t('admin.dislikedBy'))}: ${u.dislikedBy.length ? u.dislikedBy.map(esc).join(', ') : esc(t('admin.nobody'))}</div>
      <div class="admin-items">
        ${u.inventory.map(id => `<span class="admin-item">${itemPreview(id)}${esc(t('item.' + id))}<button class="ghost small" data-take="${id}" aria-label="×">×</button></span>`).join('')}
        <select data-give><option value="">${esc(t('admin.give'))}</option>${itemIds.filter(id => !u.inventory.includes(id)).map(id => `<option value="${id}">${ITEMS[id].emoji || ''} ${esc(t('item.' + id))}</option>`).join('')}</select>
      </div>
      <div class="admin-controls admin-account">
        <form class="row" data-rename><input value="${esc(u.username)}" maxlength="20" aria-label="${esc(t('admin.rename'))}"><button class="small" type="submit">${esc(t('admin.rename'))}</button></form>
        <button class="ghost small" data-reset>${esc(t('admin.resetPassword'))}</button>
      </div>
      <div class="temp-pass hidden" data-temp></div>
    </div>`).join('');
  for (const row of body.querySelectorAll('[data-user]')) {
    const userId = row.dataset.user;
    const after = r => { if (r.ok) renderAdmin(); };
    row.querySelector('[data-bonus]').onchange = e => api('admin/karma', { userId, bonus: e.target.value }).then(after);
    row.querySelector('[data-shield]').onchange = e => api('admin/karma', { userId, dislikeShield: e.target.checked }).then(after);
    row.querySelector('[data-lowest]').onclick = () => api('admin/karma', { userId, lowest: true }).then(after);
    row.querySelector('[data-give]').onchange = e => e.target.value && api('admin/gift', { userId, itemId: e.target.value }).then(r => {
      if (r.ok) toast(t('admin.gifted', { name: r.user.username }), 'info');
      after(r);
    });
    for (const b of row.querySelectorAll('[data-take]')) b.onclick = () => api('admin/take', { userId, itemId: b.dataset.take }).then(after);
    row.querySelector('[data-rename]').addEventListener('submit', async e => {
      e.preventDefault();
      const r = await api('admin/rename', { userId, username: e.target.querySelector('input').value });
      if (r.ok) { toast(t('admin.renamed', { name: r.user.username }), 'info'); if (account && userId === account.id) refreshAccount(); renderAdmin(); }
    });
    row.querySelector('[data-reset]').onclick = async () => {
      const name = row.querySelector('.admin-id b').textContent;
      if (!confirm(t('admin.resetConfirm', { name }))) return;
      const r = await api('admin/resetPassword', { userId });
      if (!r.ok) return;
      const box = row.querySelector('[data-temp]');
      box.innerHTML = `${esc(t('admin.tempPassword', { name }))} <code>${esc(r.password)}</code> <button class="small" type="button">${esc(t('ui.copy'))}</button>`;
      box.classList.remove('hidden');
      box.querySelector('button').onclick = () => navigator.clipboard.writeText(r.password).then(() => toast(t('toast.copiedText'), 'info'), () => {});
    };
  }
}

// ---------- language ----------
const langSelect = $('#langSelect');
langSelect.innerHTML = Object.entries(LANGS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
langSelect.value = lang;
langSelect.onchange = () => {
  setLang(langSelect.value);
  applyStaticTranslations();
  renderAuthMode();
  renderAlertsBtn();
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
  // the admin reset this account's password: every open page goes back to the login form
  socket.on('loggedOut', () => { store.set(AUTH_KEY, null); account = null; renderAccount(); toast(t('toast.loggedOut')); });
  renderAuthMode();
  renderAlertsBtn();
  (async () => {
    if (store.get(AUTH_KEY)) {
      const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${store.get(AUTH_KEY)}` } }).then(r => r.json()).catch(() => null);
      if (res && res.ok) account = res.user;
      else if (res) store.set(AUTH_KEY, null); // expired or logged out elsewhere
    }
    renderAccount();
    if (!account) $('#authUser').focus();
  })();
};

// The page tells us whether its home screen is showing (for the "back to my game" banner).
Site.setHome = function setHome(home) {
  if (home === Site.home) return;
  Site.home = home;
  renderActive();
};
