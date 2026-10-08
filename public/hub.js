'use strict';

// The hub (/): one home for every game — your tables and the games you're in, a card per game,
// one "join by code" box for any game, the leaderboard, the archive. Rooms live on the game pages.

const socket = io({ auth: cb => cb({ token: store.get(AUTH_KEY) }) }); // for table calls, gifts, logout

const GAMES = [
  { id: 'mafia', icon: 'hat', players: '4–12' },
  { id: 'mono', icon: 'dice', players: '2–8' },
];

function renderGameCards() {
  $('#gameCards').innerHTML = GAMES.map(g => `
    <article class="game-card g-${g.id}">
      <div class="gc-art">${ico(g.icon)}</div>
      <div class="gc-body">
        <h3>${esc(t(g.id === 'mono' ? 'site.monopoly' : 'site.mafia'))}</h3>
        <p class="muted">${esc(t('hub.desc.' + g.id))}</p>
        <span class="muted small-text">${esc(t('hub.players', { n: g.players }))}</span>
      </div>
      <div class="gc-actions">
        <a class="btn-link gc-create" href="${gamePath(g.id)}?create=1">${esc(t('hub.create'))}</a>
        <button class="ghost small" data-rules-game="${g.id}">${esc(t('rules.title'))}</button>
        <button class="ghost small" data-board-game="${g.id}">${esc(t('lb.short'))}</button>
      </div>
    </article>`).join('');
  for (const b of $$('[data-rules-game]')) b.onclick = () => openRules(b.dataset.rulesGame);
  for (const b of $$('[data-board-game]')) b.onclick = () => openLeaderboard(b.dataset.boardGame);
}

// one box for any game: the server says which game the code belongs to
async function joinByCode(spectate) {
  const code = $('#joinCode').value.trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) { toast(t('err.roomNotFound')); return; }
  const r = await api('room/' + code);
  if (r.ok) location.href = `${gamePath(r.game)}?room=${code}${spectate ? '&watch=1' : ''}`;
}
$('#hubJoin').addEventListener('submit', e => { e.preventDefault(); joinByCode(false); });
$('#watchBtn').onclick = () => joinByCode(true);
$('#hubBoard').onclick = () => openLeaderboard();
$('#hubArchive').onclick = () => openArchive(null);
$('#hubRules').onclick = () => openRules();
$('#homeProfile').onclick = () => openProfile();
$('#profileBtn').onclick = () => openProfile();

Site.init({
  game: 'hub',
  socket,
  urlRoom: () => '',
  hooks: {
    onAccount: () => $('#hubMain').classList.toggle('hidden', !account || !Site.ready),
    onLang: () => renderGameCards(),
  },
});
Site.setHome(true);
renderGameCards();
applyStaticTranslations();
