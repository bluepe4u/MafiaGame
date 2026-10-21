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

const SITE = 'bluepeau.club';
const LANGS = ['en', 'ru'];
const GAMES = { mafia: '/', poker: '/poker/', tycoon: '/tycoon/', spy: '/spy/', kingdoms: '/kingdoms/' };
const MAX_BODY = 100000;
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
    if (!slug) throw new GameError('err.blog.slug');
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
      if (!slug || this.store.db.meta(key) || this.bySlug(slug)) continue;
      this.upsert({ ...meta, slug, body: m[2].trim(), status: 'published' }, null);
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
const T = {
  en: { blog: 'Blog', all: 'All articles', play: 'Play now', min: 'min read', also: 'Also in', home: 'Games', read: 'Read', empty: 'No articles yet.', lang: 'English', tagline: 'Rules, strategy and ideas for game night with friends.', cta: { mafia: 'Play Mafia with friends — free, in the browser', poker: "Play Texas hold'em with friends — free", tycoon: 'Play Tycoon with friends — free', spy: 'Play Find the spy — free', kingdoms: 'Play Kingdoms — free' } },
  ru: { blog: 'Блог', all: 'Все статьи', play: 'Играть', min: 'мин чтения', also: 'Читать на', home: 'Игры', read: 'Читать', empty: 'Статей пока нет.', lang: 'Русский', tagline: 'Правила, стратегия и идеи для игровых вечеров с друзьями.', cta: { mafia: 'Сыграть в Мафию с друзьями — бесплатно, в браузере', poker: 'Сыграть в холдем с друзьями — бесплатно', tycoon: 'Сыграть в Магната — бесплатно', spy: 'Сыграть в Шпиона — бесплатно', kingdoms: 'Сыграть в Королевства — бесплатно' } },
};
const dateOf = (ts, lang) => new Date(ts).toLocaleDateString(lang === 'ru' ? 'ru-RU' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

function page({ base, lang, title, description, canonical, ogImage, alternates = [], jsonLd = [], body, type = 'website', extraHead = '' }) {
  const alt = alternates.map(a => `<link rel="alternate" hreflang="${a.lang}" href="${base}${a.path}">`).join('\n  ');
  return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0a0a0f">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${base}${canonical}">
  ${alt}
  <meta property="og:type" content="${type}">
  <meta property="og:site_name" content="${SITE}">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${base}${canonical}">
  <meta property="og:image" content="${base}${ogImage || '/og/site.png'}">
  <meta property="og:locale" content="${lang === 'ru' ? 'ru_RU' : 'en_US'}">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="alternate" type="application/rss+xml" title="${SITE} blog" href="${base}/blog/rss.xml">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="preload" href="/fonts/geist-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/fonts/fonts.css">
  <link rel="stylesheet" href="/style.css">
  ${extraHead}
  ${jsonLd.map(j => `<script type="application/ld+json">${JSON.stringify(j).replace(/</g, '\\u003c')}</script>`).join('\n  ')}
</head>
<body class="legal-page blog-page">
  <main class="legal blog">
    <nav class="legal-nav blog-nav"><a href="/">${SITE}</a> · <a href="/blog/">${esc(T[lang].blog)}</a> · <a href="/poker/">Poker</a> · <a href="/">Mafia</a> · <a href="/spy/">${lang === 'ru' ? 'Шпион' : 'Find the spy'}</a></nav>
    ${body}
    <footer class="site-footer"><a href="/terms/">Terms</a> · <a href="/privacy/">Privacy</a> · <a href="/blog/rss.xml">RSS</a> · <a href="https://github.com/bluepe4u/MafiaGame" rel="noopener" target="_blank">Open source</a></footer>
  </main>
</body>
</html>`;
}

function renderPost(blog, post, base) {
  const tr = T[post.lang];
  const others = blog.translations(post);
  const url = `/blog/${post.slug}/`;
  const alternates = [{ lang: post.lang, path: url }, ...others.map(o => ({ lang: o.lang, path: `/blog/${o.slug}/` }))];
  if (others.length) alternates.push({ lang: 'x-default', path: `/blog/${(others.find(o => o.lang === 'en') || post).slug}/` });
  const cta = post.game ? `<a class="blog-cta" href="${GAMES[post.game]}">${esc(tr.cta[post.game])} →</a>` : '';
  const ld = {
    '@context': 'https://schema.org', '@type': 'BlogPosting', headline: post.title, description: post.description, inLanguage: post.lang,
    datePublished: new Date(post.publishedAt || post.createdAt).toISOString(), dateModified: new Date(post.updatedAt).toISOString(),
    mainEntityOfPage: base + url, image: base + (post.cover || '/og/site.png'), author: { '@type': 'Organization', name: SITE }, publisher: { '@type': 'Organization', name: SITE, logo: { '@type': 'ImageObject', url: `${base}/icon-512.png` } },
    keywords: post.tags.join(', ') || undefined,
  };
  const crumbs = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: tr.blog, item: `${base}/blog/` }, { '@type': 'ListItem', position: 2, name: post.title, item: base + url }] };
  return page({
    base, lang: post.lang, title: `${post.title} · ${SITE}`, description: post.description, canonical: url, ogImage: post.cover, alternates, type: 'article', jsonLd: [ld, crumbs],
    extraHead: post.status !== 'published' ? '<meta name="robots" content="noindex">' : '',
    body: `<article class="blog-post">
      <p class="muted small-text">${dateOf(post.publishedAt || post.createdAt, post.lang)} · ${minutesToRead(post.body)} ${esc(tr.min)}${others.map(o => ` · <a href="/blog/${o.slug}/" hreflang="${o.lang}">${esc(T[o.lang].lang)}</a>`).join('')}</p>
      <h1>${esc(post.title)}</h1>
      ${post.cover ? `<img class="blog-cover" src="${esc(post.cover)}" alt="">` : ''}
      <div class="blog-body">${md.parse(post.body)}</div>
      ${cta}
      <p><a href="/blog/">← ${esc(tr.all)}</a></p>
    </article>`,
  });
}

function renderIndex(blog, base, lang = 'en') {
  const posts = blog.published();
  const tr = T[lang];
  const ld = { '@context': 'https://schema.org', '@type': 'Blog', name: `${SITE} — ${tr.blog}`, url: `${base}/blog/`, blogPost: posts.slice(0, 20).map(p => ({ '@type': 'BlogPosting', headline: p.title, url: `${base}/blog/${p.slug}/`, inLanguage: p.lang, datePublished: new Date(p.publishedAt).toISOString() })) };
  const card = p => `<li class="blog-card" lang="${p.lang}"><a href="/blog/${p.slug}/"><b>${esc(p.title)}</b></a>
    <span class="muted small-text">${dateOf(p.publishedAt, p.lang)} · ${esc(T[p.lang].lang)}</span><p>${esc(p.description)}</p></li>`;
  return page({
    base, lang, title: `${tr.blog} · ${SITE}`, description: `${tr.tagline} ${T.ru.tagline}`, canonical: '/blog/', jsonLd: [ld],
    body: `<h1>${esc(tr.blog)}</h1><p class="muted">${esc(T.en.tagline)} ${esc(T.ru.tagline)}</p>
      ${posts.length ? `<ul class="blog-list">${posts.map(card).join('')}</ul>` : `<p>${esc(tr.empty)}</p>`}`,
  });
}

function rss(blog, base) {
  const items = blog.published().slice(0, 50).map(p => `  <item>
    <title>${esc(p.title)}</title>
    <link>${base}/blog/${p.slug}/</link>
    <guid isPermaLink="true">${base}/blog/${p.slug}/</guid>
    <pubDate>${new Date(p.publishedAt).toUTCString()}</pubDate>
    <description>${esc(p.description)}</description>
  </item>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>${SITE} blog</title>
  <link>${base}/blog/</link>
  <description>${esc(T.en.tagline)}</description>
${items}
</channel>
</rss>
`;
}

module.exports = { BlogStore, renderPost, renderIndex, rss, slugify, md, GAMES, LANGS };
