'use strict';

// Poker stickers: drawn table talk instead of emoji ("nice hand", "ship it", "fish", "tilt"…).
// Each is a 64×64 SVG on a coloured disc; the part with class "st-a" is animated by poker.css.
// The captions are translations (pk.st.<id>).
const PK_STICKERS = (() => {
  const chip = (x, y, c, rx = 11) => `<ellipse cx="${x}" cy="${y + 3}" rx="${rx}" ry="4.2" fill="rgba(0,0,0,.35)"/><ellipse cx="${x}" cy="${y}" rx="${rx}" ry="4.2" fill="${c}"/>
    <ellipse cx="${x}" cy="${y}" rx="${rx * 0.55}" ry="2.2" fill="none" stroke="#fff" stroke-width="1.4" stroke-dasharray="2.4 2"/>`;
  const face = (fill = '#fcd34d') => `<circle cx="32" cy="34" r="17" fill="${fill}" stroke="rgba(0,0,0,.25)" stroke-width="1.5"/>`;
  const S = {
    nh: { bg: ['#4ade80', '#15803d'], art: `<g class="st-a"><g transform="translate(13 12) scale(1.6)"><path d="M7 10v11H4V10zM7 10l4-7c1.7 0 2.6 1.2 2.2 2.8L12.5 9H19a2 2 0 0 1 2 2.3l-1.3 7.5A2.5 2.5 0 0 1 17.3 21H7z" fill="#fff" stroke="#14532d" stroke-width="1.2" stroke-linejoin="round"/></g></g>` },
    gg: { bg: ['#c084fc', '#6d28d9'], art: `<text x="32" y="41" text-anchor="middle" font-family="Geist, system-ui, sans-serif" font-weight="800" font-size="25" fill="#fff" stroke="#4c1d95" stroke-width="1.2">GG</text>
      <g class="st-a"><path d="M14 16l1.5 3.5L19 21l-3.5 1.5L14 26l-1.5-3.5L9 21l3.5-1.5z" fill="#fde68a"/><path d="M50 40l1 2.4 2.4 1-2.4 1-1 2.4-1-2.4-2.4-1 2.4-1z" fill="#fde68a"/></g>` },
    ship: { bg: ['#fbbf24', '#b45309'], art: `<g class="st-a">${chip(24, 44, '#dc2626')}${chip(24, 38, '#2563eb')}${chip(24, 32, '#16a34a')}${chip(40, 44, '#111827')}${chip(40, 38, '#dc2626')}</g>
      <path d="M44 14h8v8M52 14L40 26" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>` },
    fish: { bg: ['#38bdf8', '#1d4ed8'], art: `<g class="st-a"><path d="M14 32c6-9 18-11 28-4l8-6v20l-8-6c-10 7-22 5-28-4z" fill="#fb923c" stroke="#9a3412" stroke-width="1.5" stroke-linejoin="round"/>
      <circle cx="22" cy="30" r="2.6" fill="#111827"/><circle cx="21.2" cy="29.2" r=".9" fill="#fff"/><path d="M30 26c2 4 2 8 0 12" fill="none" stroke="#9a3412" stroke-width="1.4"/></g>
      <circle cx="47" cy="14" r="2.4" fill="none" stroke="#e0f2fe" stroke-width="1.4"/><circle cx="52" cy="20" r="1.6" fill="none" stroke="#e0f2fe" stroke-width="1.2"/>` },
    tilt: { bg: ['#f87171', '#991b1b'], art: `${face('#fb923c')}<path d="M22 28l7 3M42 28l-7 3" stroke="#431407" stroke-width="2.6" stroke-linecap="round"/>
      <circle cx="26" cy="34" r="2.2" fill="#431407"/><circle cx="38" cy="34" r="2.2" fill="#431407"/><path d="M25 44c4-3 10-3 14 0" fill="none" stroke="#431407" stroke-width="2.6" stroke-linecap="round"/>
      <g class="st-a" fill="#fff" opacity=".9"><circle cx="14" cy="16" r="4"/><circle cx="19" cy="12" r="3"/><circle cx="50" cy="16" r="4"/><circle cx="45" cy="12" r="3"/></g>` },
    bluff: { bg: ['#2dd4bf', '#0f766e'], art: `<path d="M10 33s8-12 22-12 22 12 22 12-8 12-22 12-22-12-22-12z" fill="#fff" stroke="#134e4a" stroke-width="1.6"/>
      <g class="st-a"><circle cx="32" cy="33" r="7.5" fill="#134e4a"/><circle cx="34.5" cy="30.5" r="2.2" fill="#fff"/></g>
      <text x="51" y="20" text-anchor="middle" font-family="Geist, system-ui, sans-serif" font-weight="800" font-size="17" fill="#fde68a" stroke="#134e4a" stroke-width="1">?</text>` },
    snap: { bg: ['#fde047', '#ca8a04'], art: `<path class="st-a" d="M36 8L18 36h12l-4 20 20-30H33z" fill="#fff" stroke="#713f12" stroke-width="2" stroke-linejoin="round"/>` },
    cry: { bg: ['#93c5fd', '#3730a3'], art: `${face('#fde68a')}<path d="M22 30c2-2 5-2 7 0M35 30c2-2 5-2 7 0" fill="none" stroke="#422006" stroke-width="2.4" stroke-linecap="round"/>
      <path d="M25 45c4-4 10-4 14 0" fill="none" stroke="#422006" stroke-width="2.6" stroke-linecap="round"/>
      <g class="st-a" fill="#38bdf8"><path d="M24 34c-2 4-3 6-3 7.5a3 3 0 0 0 6 0c0-1.5-1-3.5-3-7.5z"/><path d="M40 34c-2 4-3 6-3 7.5a3 3 0 0 0 6 0c0-1.5-1-3.5-3-7.5z"/></g>` },
    lucky: { bg: ['#86efac', '#166534'], art: `<g class="st-a"><g fill="#22c55e" stroke="#14532d" stroke-width="1.5">
      <path d="M32 30c-8-2-12-10-6-14 3-2 6 0 6 4 0-4 3-6 6-4 6 4 2 12-6 14z"/><path d="M32 30c-8 2-12 10-6 14 3 2 6 0 6-4 0 4 3 6 6 4 6-4 2-12-6-14z"/>
      <path d="M32 30c-2-8-10-12-14-6-2 3 0 6 4 6-4 0-6 3-4 6 4 6 12 2 14-6z"/><path d="M32 30c2-8 10-12 14-6 2 3 0 6-4 6 4 0 6 3 4 6-4 6-12 2-14-6z"/></g>
      <circle cx="32" cy="30" r="2.6" fill="#bbf7d0"/></g><path d="M32 32c1 8 4 14 9 20" fill="none" stroke="#14532d" stroke-width="2.6" stroke-linecap="round"/>` },
    think: { bg: ['#a5b4fc', '#3730a3'], art: `<g class="st-a"><path d="M20 12h24M20 52h24" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/>
      <path d="M22 12c0 10 8 14 10 20-2 6-10 10-10 20h20c0-10-8-14-10-20 2-6 10-10 10-20z" fill="rgba(255,255,255,.18)" stroke="#fff" stroke-width="2.4" stroke-linejoin="round"/>
      <path d="M26 49c2-4 4-6 6-7 2 1 4 3 6 7z" fill="#fde68a"/><path d="M27 18h10l-5 7z" fill="#fde68a"/></g>` },
    allin: { bg: ['#fb923c', '#b91c1c'], art: `<path class="st-b" d="M8 46h8M6 38h9M9 30h7" stroke="#fff" stroke-width="2.4" stroke-linecap="round" opacity=".8"/>
      <g class="st-a">${chip(30, 46, '#111827')}${chip(30, 40, '#dc2626')}${chip(30, 34, '#2563eb')}${chip(30, 28, '#16a34a')}${chip(46, 46, '#dc2626')}${chip(46, 40, '#111827')}${chip(46, 34, '#fbbf24')}</g>
      <text x="38" y="17" text-anchor="middle" font-family="Geist, system-ui, sans-serif" font-weight="800" font-size="11" fill="#fff" stroke="#7f1d1d" stroke-width=".8">ALL IN</text>` },
    cooler: { bg: ['#a5f3fc', '#0e7490'], art: `<g class="st-a" stroke="#fff" stroke-width="2.8" stroke-linecap="round" fill="none">
      <path d="M32 12v40M14.7 22l34.6 20M14.7 42l34.6-20"/><path d="M27 15l5 4 5-4M27 49l5-4 5 4M14 28l6-1-2-6M50 36l-6 1 2 6M14 36l6 1-2 6M50 28l-6-1 2-6"/></g>
      <circle cx="32" cy="32" r="4" fill="#ecfeff"/>` },
  };
  const svg = id => {
    const s = S[id];
    if (!s) return '';
    return `<svg class="st st-${id}" viewBox="0 0 64 64" aria-hidden="true"><defs><radialGradient id="stg-${id}" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="${s.bg[0]}"/><stop offset="1" stop-color="${s.bg[1]}"/></radialGradient></defs>
      <circle cx="32" cy="32" r="30" fill="url(#stg-${id})"/><circle cx="32" cy="32" r="29" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="1.5"/>${s.art}</svg>`;
  };
  return { ids: Object.keys(S), svg };
})();
