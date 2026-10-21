'use strict';

// The home page: the five games, joining any room by its code, and the shared account (log in,
// tables, the game you were in). It has no game of its own; the socket is only there for the
// shared code (common.js) and talks to the main namespace like the Mafia page does.

const socket = io('/', { auth: cb => cb({ token: store.get(AUTH_KEY) }) });
const GAME_ICONS = { mafia: 'hat', poker: 'chip', spy: 'spy', tycoon: 'dice', kingdoms: 'castle' };

function renderGames() {
  for (const card of $$('[data-game-ico]')) card.querySelector('.hub-game-ico').innerHTML = ico(GAME_ICONS[card.dataset.gameIco] || 'hat');
  for (const el of $$('[data-players]')) el.textContent = t('hub.players', { n: el.dataset.players });
}

// "Start a room" on the home page: pick the game first
$('#createBtn').onclick = () => $('#games').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });

// a room code from any game: find which game it belongs to and go there
async function joinByCode() {
  const code = $('#joinCode').value.trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) return toast(t('err.roomNotFound'));
  const res = await fetch(`/api/whereis?code=${encodeURIComponent(code)}`).then(r => r.json()).catch(() => null);
  if (!res || !res.path) return toast(t('err.roomNotFound'));
  location.href = `${res.path}?room=${code}&join=1`;
}
$('#joinBtn').onclick = joinByCode;
$('#joinCode').addEventListener('keydown', e => { if (e.key === 'Enter') joinByCode(); });

Site.setHome(true);
Site.init({
  game: 'hub',
  socket,
  urlRoom: () => '',
  hooks: { onLang: renderGames },
});
applyStaticTranslations();
renderGames();
