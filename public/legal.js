// Pages without the games' scripts (Terms, Privacy, the fair-deal check): the language the site is
// in, and the EN/RU switch in the top bar. Terms and Privacy hold both languages and show one.
'use strict';
(() => {
  let lang = '';
  try { lang = localStorage.getItem('mafia.lang') || ''; } catch {}
  if (!lang) lang = (navigator.language || '').toLowerCase().startsWith('ru') ? 'ru' : 'en';
  lang = lang === 'ru' ? 'ru' : 'en';
  document.body.dataset.lang = lang;
  document.documentElement.lang = lang;
  for (const a of document.querySelectorAll('[data-set-lang]')) {
    a.classList.toggle('on', a.dataset.setLang === lang);
    a.onclick = e => {
      e.preventDefault();
      try { localStorage.setItem('mafia.lang', a.dataset.setLang); } catch {}
      location.reload();
    };
  }
})();
