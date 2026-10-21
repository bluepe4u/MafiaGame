'use strict';

// The blog: articles written by the admin in Markdown, served as plain HTML pages at /blog/ (fast,
// readable without scripts, so search engines and AI assistants can read them). Posts are in English
// or Russian; translations of the same article share a `group`, and the pages link to each other.
// Saved in the site database; pictures are files in DATA_DIR/blog.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Marked } = require('marked');
const { GameError } = require('./game');
const { Saved } = require('./db');

const SITE = 'Anytable';
const LANGS = ['en', 'ru'];
const GAMES = { mafia: '/mafia/', poker: '/poker/', tycoon: '/tycoon/', spy: '/spy/', kingdoms: '/kingdoms/' };
const MAX_BODY = 100000;
const RESERVED = ['ru', 'en', 'rss', 'img']; // paths of the blog itself
const MAX_IMAGE = 3 * 1024 * 1024;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Markdown with raw HTML shown as text (an article can't carry scripts or styles), links out of the
// site opened safely, pictures lazy-loaded
const md = new Marked({
  gfm: true,
  renderer: {
    html({ text }) { return esc(text); },
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      const out = /^https?:\/\//i.test(href) && !href.includes(SITE);
      if (/^\s*javascript:/i.test(href)) return label;
      return `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ''}${out ? ' rel="noopener" target="_blank"' : ''}>${label}</a>`;
    },
    image({ href, title, text }) {
      return `<img src="${esc(href)}" alt="${esc(text)}"${title ? ` title="${esc(title)}"` : ''} loading="lazy">`;
    },
  },
});

// a URL slug from a title, Cyrillic spelled in Latin letters
const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
function slugify(text) {
  return String(text || '').toLowerCase().split('').map(c => TRANSLIT[c] ?? c).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

// the first paragraph as plain text, for descriptions and feeds
const plain = s => String(s || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[#*_>`~|-]/g, '').replace(/\s+/g, ' ').trim();
const minutesToRead = body => Math.max(1, Math.round(plain(body).split(' ').length / 200));

class BlogStore {
  constructor(dir) {
    this.store = new Saved(dir, 'blog', { posts: 'map' });
    this.posts = this.store.load().posts || {}; // id -> post
    this.imageDir = path.join(dir, 'blog');
    this.saveTimer = null;
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try { this.store.save({ posts: this.posts }); } catch (e) { console.error('Saving the blog failed:', e.message); }
  }

  save() { if (!this.saveTimer) this.saveTimer = setTimeout(() => this.saveNow(), 300); }

  bySlug(slug) { return Object.values(this.posts).find(p => p.slug === slug); }

  // published, newest first (optionally one language)
  published(lang = null) {
    return Object.values(this.posts).filter(p => p.status === 'published' && (!lang || p.lang === lang))
      .sort((a, b) => b.publishedAt - a.publishedAt);
  }

  all() { return Object.values(this.posts).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)); }

  // the same article in its other languages
  translations(post) {
    return post.group ? this.published().filter(p => p.group === post.group && p.id !== post.id) : [];
  }

  // create or update; returns the post. Publishing stamps the date once.
  upsert(input, authorId) {
    const now = Date.now();
    const post = input.id ? this.posts[input.id] : null;
    if (input.id && !post) throw new GameError('err.invalidTarget');
    const title = String(input.title || '').trim().slice(0, 140);
    if (!title) throw new GameError('err.blog.title');
    const lang = LANGS.includes(input.lang) ? input.lang : 'en';
    const slug = slugify(input.slug || title);
    if (!slug || RESERVED.includes(slug)) throw new GameError('err.blog.slug');
    const other = this.bySlug(slug);
    if (other && other !== post) throw new GameError('err.blog.slugTaken');
    const body = String(input.body || '').slice(0, MAX_BODY);
    const status = input.status === 'published' ? 'published' : 'draft';
    const next = {
      ...(post || { id: crypto.randomBytes(6).toString('hex'), createdAt: now, author: authorId }),
      title, slug, lang, body, status,
      description: String(input.description || '').trim().slice(0, 300) || plain(body).slice(0, 160),
      game: GAMES[input.game] !== undefined ? input.game : null,
      group: slugify(input.group || '') || null,
      cover: /^\/blog\/img\/[\w.-]+$/.test(input.cover || '') ? input.cover : null,
      tags: String(input.tags || '').split(',').map(t => t.trim()).filter(Boolean).slice(0, 8),
      updatedAt: now,
    };
    if (status === 'published' && !next.publishedAt) next.publishedAt = now;
    this.posts[next.id] = next;
    this.save();
    return next;
  }

  remove(id) {
    if (!this.posts[id]) throw new GameError('err.invalidTarget');
    delete this.posts[id];
    this.save();
  }

  // Articles that ship with the code (content/blog/*.md, with a front matter block of "key: value"
  // lines between ---): each is added once, published; after that it's edited (or deleted) in the
  // admin panel like any other article and never comes back on its own.
  seedFrom(dir) {
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort(); } catch { return 0; }
    let added = 0;
    for (const f of files) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
      if (!m) continue;
      const meta = Object.fromEntries(m[1].split('\n').map(l => l.match(/^(\w+):\s*(.*)$/)).filter(Boolean).map(x => [x[1], x[2].trim()]));
      const slug = slugify(meta.slug || meta.title);
      const key = `seeded:blog:${slug}`;
      if (!slug) continue;
      const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
      const have = this.bySlug(slug);
      // a shipped article nobody has edited in the admin panel follows its file when the file changes
      const untouched = have && have.author === null && (have.seedHash ? have.updatedAt === have.seededAt : have.updatedAt === have.publishedAt);
      if (have && untouched && have.seedHash !== hash) {
        const next = this.upsert({ ...have, ...meta, id: have.id, slug, body: m[2].trim(), status: have.status }, null);
        Object.assign(next, { seedHash: hash, seededAt: next.updatedAt });
        added += 1;
        continue;
      }
      if (this.store.db.meta(key) || have) continue;
      const post = this.upsert({ ...meta, slug, body: m[2].trim(), status: 'published' }, null);
      Object.assign(post, { seedHash: hash, seededAt: post.updatedAt });
      this.store.db.meta(key, Date.now());
      added += 1;
    }
    if (added) this.saveNow();
    return added;
  }

  // a picture for an article: JPEG / PNG / WebP only, recognised by its first bytes
  addImage(buf) {
    if (buf.length > MAX_IMAGE) throw new GameError('err.blog.imageSize', { mb: MAX_IMAGE / 1024 / 1024 });
    const ext = buf[0] === 0xff && buf[1] === 0xd8 ? 'jpg' : buf.subarray(1, 4).toString() === 'PNG' ? 'png' : buf.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : null;
    if (!ext) throw new GameError('err.avatarType');
    fs.mkdirSync(this.imageDir, { recursive: true });
    const file = `${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 20)}.${ext}`;
    fs.writeFileSync(path.join(this.imageDir, file), buf);
    return `/blog/img/${file}`;
  }
}

// ---------- pages ----------
// Plain HTML in the site's own look (the top bar, the glow, cards), no scripts. Each language has
// its own index: /blog/ in English, /blog/ru/ in Russian; an article links its translation.
const T = {
  en: {
    blog: 'Blog', index: '/blog/', eyebrow: 'The Anytable blog', h1a: 'Game night,', h1b: 'explained.',
    tagline: 'Rules, strategy and ideas for playing Mafia, poker and party games with friends.',
    min: 'min read', all: 'All articles', more: 'More articles', empty: 'No articles yet: check back soon.',
    play: 'Play', otherLang: 'Читать по-русски', hasOther: 'Есть статьи на русском', rss: 'RSS',
    games: { mafia: 'Mafia', poker: 'Poker', tycoon: 'Tycoon', spy: 'Find the spy', kingdoms: 'Kingdoms' },
    cta: { mafia: 'Play Mafia with friends', poker: "Play Texas hold'em with friends", tycoon: 'Play Tycoon with friends', spy: 'Play Find the spy', kingdoms: 'Play Kingdoms' },
    ctaSub: 'Free, in the browser, one link for everyone.',
  },
  ru: {
    blog: 'Блог', index: '/blog/ru/', eyebrow: 'Блог Anytable', h1a: 'Игровой вечер —', h1b: 'по правилам.',
    tagline: 'Правила, стратегия и идеи для Мафии, покера и игр с друзьями.',
    min: 'мин чтения', all: 'Все статьи', more: 'Ещё статьи', empty: 'Статей пока нет — загляните позже.',
    play: 'Играть', otherLang: 'Read in English', hasOther: 'Articles in English', rss: 'RSS',
    games: { mafia: 'Мафия', poker: 'Покер', tycoon: 'Магнат', spy: 'Шпион', kingdoms: 'Королевства' },
    cta: { mafia: 'Сыграть в Мафию с друзьями', poker: 'Сыграть в холдем с друзьями', tycoon: 'Сыграть в Магната с друзьями', spy: 'Сыграть в Шпиона', kingdoms: 'Сыграть в Королевства' },
    ctaSub: 'Бесплатно, в браузере, одна ссылка для всех.',
  },
};
const otherOf = lang => (lang === 'ru' ? 'en' : 'ru');
const dateOf = (ts, lang) => new Date(ts).toLocaleDateString(lang === 'ru' ? 'ru-RU' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const MARK = '<svg class="brand-mark at-mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9"/><g transform="rotate(-8 16 16)"><rect x="9" y="5" width="14.5" height="22" rx="2.6" fill="#fff"/><path d="M16.25 10.5L12.6 20.5M16.25 10.5l3.65 10M13.9 17.2h4.7" fill="none" stroke="#d93b40" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></g></svg>';

function page({ base, lang, title, description, canonical, ogImage, alternates = [], jsonLd = [], body, type = 'website', robots = '', switchTo }) {
  const tr = T[lang];
  const alt = alternates.map(a => `<link rel="alternate" hreflang="${a.lang}" href="${base}${a.path}">`).join('\n  ');
  const games = Object.entries(GAMES).map(([g, href]) => `<a href="${href}">${esc(tr.games[g])}</a>`).join('');
  return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#08080c">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${base}${canonical}">
  ${alt}
  ${robots}
  <meta property="og:type" content="${type}">
  <meta property="og:site_name" content="${SITE}">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${base}${canonical}">
  <meta property="og:image" content="${base}${ogImage || '/og/site.png'}">
  <meta property="og:locale" content="${lang === 'ru' ? 'ru_RU' : 'en_US'}">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="alternate" type="application/rss+xml" title="${SITE} — ${esc(tr.blog)}" href="${base}${tr.index}rss.xml">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="preload" href="/fonts/geist-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="/fonts/geist-cyrillic-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/fonts/fonts.css">
  <link rel="stylesheet" href="/style.css">
  ${jsonLd.map(j => `<script type="application/ld+json">${JSON.stringify(j).replace(/</g, '\\u003c')}</script>`).join('\n  ')}
</head>
<body class="blog-page" data-phase="home">
  <div class="backdrop" aria-hidden="true"><div class="orb orb-a"></div><div class="orb orb-b"></div><div class="grain"></div></div>
  <header class="topbar blog-top">
    <a class="brand" href="/">${MARK}<span>Anytable</span></a>
    <a class="blog-top-link" href="${tr.index}">${esc(tr.blog)}</a>
    <nav class="blog-games" aria-label="Games">${games}</nav>
    <span class="spacer"></span>
    <nav class="blog-lang" aria-label="Language">${['en', 'ru'].map(l => `<a href="${l === lang ? canonical : switchTo}" hreflang="${l}" class="${l === lang ? 'on' : ''}"${l === lang ? ' aria-current="true"' : ''}>${l.toUpperCase()}</a>`).join('')}</nav>
    <a class="blog-play" href="/">${esc(tr.play)}</a>
  </header>
  <main class="blog">
    ${body}
  </main>
  <footer class="site-footer"><a href="/">${SITE}</a> · <a href="/terms/">Terms</a> · <a href="/privacy/">Privacy</a> · <a href="${tr.index}rss.xml">${tr.rss}</a> · <a href="https://github.com/bluepe4u/MafiaGame" rel="noopener" target="_blank">Open source</a></footer>
</body>
</html>`;
}

// an article in the list: the game it's about, the title, the summary, the date
function card(p) {
  const tr = T[p.lang];
  return `<a class="card blog-card${p.game ? ` g-${p.game}` : ''}" href="/blog/${p.slug}/">
      ${p.cover ? `<img class="blog-card-cover" src="${esc(p.cover)}" alt="" loading="lazy">` : ''}
      <span class="blog-card-meta">${p.game ? `<span class="tag blog-game">${esc(tr.games[p.game])}</span>` : ''}<span>${dateOf(p.publishedAt, p.lang)} · ${minutesToRead(p.body)} ${esc(tr.min)}</span></span>
      <b class="blog-card-title">${esc(p.title)}</b>
      <span class="blog-card-text">${esc(p.description)}</span>
    </a>`;
}

function renderPost(blog, post, base) {
  const tr = T[post.lang];
  const others = blog.translations(post);
  const url = `/blog/${post.slug}/`;
  const alternates = [{ lang: post.lang, path: url }, ...others.map(o => ({ lang: o.lang, path: `/blog/${o.slug}/` }))];
  if (others.length) alternates.push({ lang: 'x-default', path: `/blog/${(others.find(o => o.lang === 'en') || post).slug}/` });
  const other = others.find(o => o.lang === otherOf(post.lang));
  const related = blog.published(post.lang).filter(p => p.id !== post.id)
    .sort((a, b) => (b.game === post.game) - (a.game === post.game) || b.publishedAt - a.publishedAt).slice(0, 3);
  const ld = {
    '@context': 'https://schema.org', '@type': 'BlogPosting', headline: post.title, description: post.description, inLanguage: post.lang,
    datePublished: new Date(post.publishedAt || post.createdAt).toISOString(), dateModified: new Date(post.updatedAt).toISOString(),
    mainEntityOfPage: base + url, image: base + (post.cover || '/og/site.png'), author: { '@type': 'Organization', name: SITE },
    publisher: { '@type': 'Organization', name: SITE, logo: { '@type': 'ImageObject', url: `${base}/icon-512.png` } },
    keywords: post.tags.join(', ') || undefined,
  };
  const crumbs = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: tr.blog, item: base + tr.index }, { '@type': 'ListItem', position: 2, name: post.title, item: base + url }] };
  const cta = post.game ? `<a class="blog-cta g-${post.game}" href="${GAMES[post.game]}"><b>${esc(tr.cta[post.game])} →</b><span>${esc(tr.ctaSub)}</span></a>` : '';
  return page({
    base, lang: post.lang, title: `${post.title} · ${SITE}`, description: post.description, canonical: url, ogImage: post.cover, alternates, type: 'article', jsonLd: [ld, crumbs],
    robots: post.status !== 'published' ? '<meta name="robots" content="noindex">' : '',
    switchTo: other ? `/blog/${other.slug}/` : T[otherOf(post.lang)].index,
    body: `<article class="card blog-post${post.game ? ` g-${post.game}` : ''}">
      <p class="blog-crumbs"><a href="${tr.index}">← ${esc(tr.all)}</a></p>
      <p class="blog-card-meta">${post.game ? `<span class="tag blog-game">${esc(tr.games[post.game])}</span>` : ''}<span>${dateOf(post.publishedAt || post.createdAt, post.lang)} · ${minutesToRead(post.body)} ${esc(tr.min)}</span>${other ? `<a class="blog-other" href="/blog/${other.slug}/" hreflang="${other.lang}">${esc(tr.otherLang)}</a>` : ''}</p>
      <h1>${esc(post.title)}</h1>
      ${post.cover ? `<img class="blog-cover" src="${esc(post.cover)}" alt="">` : ''}
      <div class="blog-body">${md.parse(post.body)}</div>
      ${cta}
    </article>
    ${related.length ? `<section class="blog-related"><h3>${esc(tr.more)}</h3><div class="blog-grid">${related.map(card).join('')}</div></section>` : ''}`,
  });
}

function renderIndex(blog, base, lang = 'en', { notFound = false } = {}) {
  const tr = T[lang];
  const posts = blog.published(lang);
  const otherCount = blog.published(otherOf(lang)).length;
  const ld = { '@context': 'https://schema.org', '@type': 'Blog', name: `${SITE} — ${tr.blog}`, url: base + tr.index, inLanguage: lang, blogPost: posts.slice(0, 20).map(p => ({ '@type': 'BlogPosting', headline: p.title, url: `${base}/blog/${p.slug}/`, datePublished: new Date(p.publishedAt).toISOString() })) };
  return page({
    base, lang, title: `${tr.blog} · ${SITE}`, description: tr.tagline, canonical: tr.index, jsonLd: [ld],
    alternates: [{ lang: 'en', path: T.en.index }, { lang: 'ru', path: T.ru.index }, { lang: 'x-default', path: T.en.index }],
    robots: notFound ? '<meta name="robots" content="noindex">' : '', switchTo: T[otherOf(lang)].index,
    body: `<section class="hero blog-hero">
      <p class="eyebrow">${esc(tr.eyebrow)}</p>
      <h1>${esc(tr.h1a)} <em>${esc(tr.h1b)}</em></h1>
      <p class="muted hero-sub">${esc(tr.tagline)}</p>
      ${otherCount ? `<p class="blog-hero-other"><a href="${T[otherOf(lang)].index}" hreflang="${otherOf(lang)}">${esc(tr.hasOther)} (${otherCount}) →</a></p>` : ''}
    </section>
    ${notFound ? '<p class="card blog-404">404</p>' : ''}
    ${posts.length ? `<div class="blog-grid">${posts.map(card).join('')}</div>` : `<p class="muted blog-empty">${esc(tr.empty)}</p>`}`,
  });
}

function rss(blog, base, lang = 'en') {
  const tr = T[lang];
  const items = blog.published(lang).slice(0, 50).map(p => `  <item>
    <title>${esc(p.title)}</title>
    <link>${base}/blog/${p.slug}/</link>
    <guid isPermaLink="true">${base}/blog/${p.slug}/</guid>
    <pubDate>${new Date(p.publishedAt).toUTCString()}</pubDate>
    <description>${esc(p.description)}</description>
  </item>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>${SITE} — ${esc(tr.blog)}</title>
  <link>${base}${tr.index}</link>
  <language>${lang}</language>
  <description>${esc(tr.tagline)}</description>
${items}
</channel>
</rss>
`;
}

module.exports = { BlogStore, renderPost, renderIndex, rss, slugify, md, GAMES, LANGS };
