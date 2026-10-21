// The standalone fair deal check: paste a session's log, every deck is recomputed here.
'use strict';
applyStaticTranslations();
document.title = `${t('pk.fair.page.title')} · ${t('site.poker')}`;
const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const card = c => `<span class="fair-card s-${c[1]}">${c[0] === 'T' ? '10' : c[0]}${SUIT[c[1]]}</span>`;

document.getElementById('fairRun').onclick = async () => {
  const out = document.getElementById('fairOut');
  let hands;
  try {
    const log = JSON.parse(document.getElementById('fairLog').value);
    hands = Array.isArray(log) ? log : log.hands;
    if (!Array.isArray(hands) || !hands.every(e => e && typeof e.seed === 'string' && Array.isArray(e.clients))) throw new Error();
  } catch {
    out.innerHTML = `<p class="neg">${esc(t('pk.fair.page.badJson'))}</p>`;
    return;
  }
  out.innerHTML = `<p class="muted">${esc(t('pk.fair.checking'))}</p>`;
  const rows = [];
  for (const e of hands) {
    const v = await PokerFair.verify(e);
    const players = (e.players || []).map((name, k) => `<li><b>${esc(name)}</b> ${v.hole[k].map(card).join(' ')}</li>`).join('');
    rows.push(`<section class="fair-hand ${v.commitOk ? '' : 'bad'}">
      <h3>${esc(t('pk.handN', { n: e.n }))} · <span class="${v.commitOk ? 'pos' : 'neg'}">${esc(t(v.commitOk ? 'pk.fair.page.okHand' : 'pk.fair.page.badHand'))}</span></h3>
      <p class="small-text muted"><code>${esc(e.commit)}</code></p>
      <ul>${players}</ul><p>${v.board.map(card).join(' ')}</p></section>`);
  }
  const bad = hands.length - rows.filter(r => !r.includes('fair-hand bad')).length;
  out.innerHTML = `<p class="${bad ? 'neg' : 'pos'}"><b>${esc(bad ? t('pk.fair.bad', { n: bad }) : t('pk.fair.page.allOk', { n: hands.length }))}</b></p>${rows.join('')}`;
};
