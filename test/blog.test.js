'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BlogStore, renderPost, renderIndex, rss, slugify } = require('../src/blog');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'blog-'));
const BASE = 'https://bluepeau.club';

test('blog: slugs, drafts, publishing, translations', () => {
  assert.strictEqual(slugify('Правила игры в Мафию: все роли!'), 'pravila-igry-v-mafiyu-vse-roli');
  const blog = new BlogStore(tmp());
  const en = blog.upsert({ title: 'Poker hand rankings', lang: 'en', body: 'Intro text.\n\n## Hands', group: 'poker-hands', game: 'poker' }, 'u1');
  assert.strictEqual(en.slug, 'poker-hand-rankings');
  assert.strictEqual(en.status, 'draft');
  assert.strictEqual(en.description, 'Intro text. Hands');
  assert.deepStrictEqual(blog.published(), []);
  assert.throws(() => blog.upsert({ title: 'Other', slug: 'poker-hand-rankings' }), /slugTaken/);
  assert.throws(() => blog.upsert({ title: '  ' }), /err\.blog\.title/);
  const live = blog.upsert({ ...en, status: 'published' });
  assert.ok(live.publishedAt);
  const ru = blog.upsert({ title: 'Комбинации в покере', lang: 'ru', body: 'Текст', group: 'poker-hands', status: 'published' });
  assert.deepStrictEqual(blog.translations(live).map(p => p.id), [ru.id]);
  // the page links its translation for search engines, with x-default on the English one
  const html = renderPost(blog, live, BASE);
  assert.match(html, /hreflang="ru" href="https:\/\/bluepeau.club\/blog\/kombinatsii-v-pokere\/"/);
  assert.match(html, /hreflang="x-default" href="https:\/\/bluepeau.club\/blog\/poker-hand-rankings\/"/);
  assert.match(html, /"@type":"BlogPosting"/);
  assert.match(html, /href="\/poker\/"/); // the call to play
  assert.match(renderIndex(blog, BASE), /Комбинации в покере/);
  assert.match(rss(blog, BASE), /<link>https:\/\/bluepeau.club\/blog\/poker-hand-rankings\/<\/link>/);
});

test('blog: an article can\'t carry scripts', () => {
  const blog = new BlogStore(tmp());
  const p = blog.upsert({ title: 'X', status: 'published', body: '<script>alert(1)</script>\n\n[click](javascript:alert(1)) [out](https://example.com) [in](/poker/)\n\n</script><img src=x onerror=alert(1)>' });
  const html = renderPost(blog, p, BASE);
  const body = html.slice(html.indexOf('blog-body'));
  assert.ok(!body.includes('<script>'));
  assert.ok(!body.includes('<img src=x'));
  assert.ok(!body.includes('javascript:'));
  assert.match(body, /<a href="https:\/\/example.com" rel="noopener" target="_blank">out<\/a>/);
  assert.match(body, /<a href="\/poker\/">in<\/a>/);
  // a title with markup is text
  const q = blog.upsert({ title: '<b>"bold"</b>', status: 'published', body: 'x' });
  assert.ok(renderPost(blog, q, BASE).includes('&lt;b&gt;&quot;bold&quot;&lt;/b&gt;'));
});

test('blog: articles from content/blog are added once, and stay deleted', () => {
  const dir = tmp();
  const content = path.join(dir, 'content');
  fs.mkdirSync(content);
  fs.writeFileSync(path.join(content, 'a.md'), '---\nslug: first-post\nlang: ru\ntitle: Первая\ngame: mafia\ntags: a, b\n---\nТекст статьи.\n');
  const blog = new BlogStore(dir);
  assert.strictEqual(blog.seedFrom(content), 1);
  const p = blog.bySlug('first-post');
  assert.strictEqual(p.status, 'published');
  assert.deepStrictEqual(p.tags, ['a', 'b']);
  assert.strictEqual(blog.seedFrom(content), 0);
  blog.remove(p.id);
  blog.saveNow();
  const again = new BlogStore(dir);
  assert.strictEqual(again.seedFrom(content), 0);
  assert.strictEqual(again.bySlug('first-post'), undefined);
});

test('blog: the real articles in content/blog parse and publish', () => {
  const blog = new BlogStore(tmp());
  const n = blog.seedFrom(path.join(__dirname, '..', 'content', 'blog'));
  assert.ok(n >= 4);
  for (const p of blog.published()) {
    assert.ok(p.title && p.description.length > 50 && p.body.length > 1000, p.slug);
    assert.ok(['en', 'ru'].includes(p.lang));
    assert.strictEqual(blog.translations(p).length, 1, `${p.slug} has its translation`);
  }
});
