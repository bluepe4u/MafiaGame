// The legal pages hold both languages; show the one the site is in (both stay in the page for search).
'use strict';
(() => {
  let lang = '';
  try { lang = localStorage.getItem('mafia.lang') || ''; } catch {}
  if (!lang) lang = (navigator.language || '').toLowerCase().startsWith('ru') ? 'ru' : 'en';
  document.body.dataset.lang = lang === 'ru' ? 'ru' : 'en';
  document.documentElement.lang = document.body.dataset.lang;
})();
