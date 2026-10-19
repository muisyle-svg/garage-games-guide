// Builds the static event guide from content/ into dist/.
// Usage: node build.mjs [--explicit-index]
//   --explicit-index  link to ".../index.html" instead of ".../" (for hosts without directory indexes)
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONTENT = path.join(ROOT, 'content');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'dist');
const EXPLICIT_INDEX = process.argv.includes('--explicit-index');

// The fixed section order every event page follows.
const SECTIONS = [
  { key: 'objective', heading: 'Objective', open: true },
  { key: 'setup', heading: 'Setup', open: true },
  { key: 'gameplay', heading: 'Gameplay', open: true },
  { key: 'scoring', heading: 'Scoring', open: true },
  { key: 'additional-rules', heading: 'Additional rules', open: false },
];

// ---------- content parsing ----------

// Front matter: a small YAML subset (key: value, and lists of "- item").
function parseFrontMatter(text, file) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: text };
  const data = {};
  let listKey = null;
  for (const raw of m[1].split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const item = raw.match(/^\s+-\s+(.*)$/);
    if (item && listKey) { data[listKey].push(scalar(item[1])); continue; }
    const kv = raw.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) throw new Error(`${file}: can't read front matter line: ${raw}`);
    if (kv[2] === '') { listKey = kv[1]; data[listKey] = []; }
    else { listKey = null; data[kv[1]] = scalar(kv[2]); }
  }
  return { data, body: text.slice(m[0].length) };
}

function scalar(v) {
  v = v.trim();
  if (!/^['"]/.test(v)) v = v.replace(/\s+#.*$/, ''); // trailing comment on an unquoted value
  if (/^'.*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
  if (/^".*"$/.test(v)) return v.slice(1, -1);
  if (v === 'true' || v === 'false') return v === 'true';
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

// Splits Markdown into { heading -> markdown } on "## " headings.
function splitSections(body) {
  const out = [];
  let cur = { heading: null, md: '' };
  for (const line of body.split(/\r?\n/)) {
    const h = line.match(/^##\s+(.*)$/);
    if (h) { out.push(cur); cur = { heading: h[1].trim(), md: '' }; }
    else cur.md += line + '\n';
  }
  out.push(cur);
  return out.filter(s => s.heading || s.md.trim());
}

const slugify = s => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const md = s => marked.parse(s, { gfm: true });
const mdInline = s => marked.parseInline(s, { gfm: true });
const plain = html => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
const fmtPoints = p => (typeof p === 'number' ? p.toFixed(1) : '');

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

async function loadEvents() {
  const dir = path.join(CONTENT, 'events');
  const files = (await fs.readdir(dir)).filter(f => f.endsWith('.md'));
  const events = [];
  for (const f of files) {
    const { data, body } = parseFrontMatter(await fs.readFile(path.join(dir, f), 'utf8'), f);
    if (!data.title) throw new Error(`${f}: missing title`);
    const slug = data.slug || path.basename(f, '.md');
    const parts = splitSections(body);
    const known = new Map(SECTIONS.map(s => [s.key, s]));
    const sections = SECTIONS.map(s => ({ ...s, md: null }));
    const extra = [];
    for (const p of parts) {
      const key = p.heading ? slugify(p.heading) : null;
      const target = key && known.has(key) ? sections.find(s => s.key === key) : null;
      if (target) target.md = p.md.trim();
      else if (p.heading) extra.push({ key, heading: p.heading, md: p.md.trim(), open: false });
      else console.warn(`${f}: text before the first "## " heading is ignored`);
    }
    for (const x of extra) console.warn(`${f}: extra section "${x.heading}" shown after the standard ones`);
    events.push({ ...data, slug, file: f, sections: [...sections, ...extra], flags: data.flags || [] });
  }
  events.sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.title.localeCompare(b.title));
  return events;
}

// ---------- images ----------

// Placeholder illustration for an event with no image yet.
function placeholderSvg(title, i) {
  const hues = [18, 42, 190, 265, 330, 150, 210];
  const h = hues[i % hues.length];
  const initials = title.split(/\s+/).filter(w => /^[A-Za-z]/.test(w) && !/^(the|a|and|of)$/i.test(w))
    .slice(0, 2).map(w => w[0].toUpperCase()).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400" role="img" aria-label="${esc(title)}">
<defs><pattern id="s" width="40" height="40" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
<rect width="20" height="40" fill="hsl(${h} 70% 50% / .16)"/></pattern></defs>
<rect width="640" height="400" fill="hsl(${h} 45% 22%)"/><rect width="640" height="400" fill="url(#s)"/>
<circle cx="320" cy="200" r="118" fill="hsl(${h} 80% 60%)"/>
<text x="320" y="200" dy=".35em" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="800" font-size="104" fill="hsl(${h} 50% 14%)">${esc(initials)}</text>
</svg>`;
}

async function prepareImages(events) {
  await fs.mkdir(path.join(OUT, 'images'), { recursive: true });
  const srcDir = path.join(CONTENT, 'images');
  if (await exists(srcDir)) await fs.cp(srcDir, path.join(OUT, 'images'), { recursive: true });
  for (const [i, e] of events.entries()) {
    if (e.image && await exists(path.join(srcDir, e.image))) {
      e.imageUrl = `images/${e.image}`;
      e.imageIsPlaceholder = false;
    } else {
      if (e.image) console.warn(`${e.file}: image "${e.image}" not found in content/images, using a placeholder`);
      const name = `placeholder-${e.slug}.svg`;
      await fs.writeFile(path.join(OUT, 'images', name), placeholderSvg(e.title, i));
      e.imageUrl = `images/${name}`;
      e.imageIsPlaceholder = true;
    }
  }
}

// ---------- templates ----------

const link = (base, p) => base + (p === '' ? (EXPLICIT_INDEX ? 'index.html' : '')
  : EXPLICIT_INDEX ? p.replace(/\/$/, '/index.html') : p);

function layout({ site, base, title, description, body, current }) {
  const full = title ? `${title} · ${site.title}` : `${site.title}: ${site.tagline}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(full)}</title>
<meta name="description" content="${esc(description || site.description)}">
<meta name="theme-color" content="#1b1a17" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#f6f3ec" media="(prefers-color-scheme: light)">
<link rel="manifest" href="${base}manifest.webmanifest">
<link rel="icon" href="${base}icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${base}style.css?v=${ASSET_VERSION}">
<script src="${base}app.js?v=${ASSET_VERSION}" defer></script>
</head>
<body data-base="${esc(base)}" data-explicit-index="${EXPLICIT_INDEX}">
<a class="skip" href="#main">Skip to content</a>
<header class="topbar">
  <a class="brand" href="${link(base, '')}"><span class="brand-mark" aria-hidden="true"></span>${esc(site.title)}</a>
  <nav aria-label="Main"><ul>
    <li><a href="${link(base, '')}"${current === 'home' ? ' aria-current="page"' : ''}>Events</a></li>
    <li><a href="${link(base, 'rules/')}"${current === 'rules' ? ' aria-current="page"' : ''}>How it works</a></li>
  </ul></nav>
</header>
${site.wording !== 'verbatim' || site.anyDraft ? `<p class="draft-banner" role="note">Prototype: the wording here is a close paraphrase of the slides, waiting on the exact text.</p>` : ''}
<main id="main" tabindex="-1">
${body}
</main>
<footer class="footer">
  <p>${esc(site.title)} · ${esc(site.tagline)}</p>
  <p class="offline-status" aria-live="polite"></p>
</footer>
</body>
</html>
`;
}

function flagsBox(flags, site) {
  if (!site.show_flags || !flags?.length) return '';
  return `<aside class="flags" aria-labelledby="flags-h">
<h2 id="flags-h">Needs clarification</h2>
<p class="flags-note">These points are missing or unclear in the original guide. Nothing has been invented to fill them.</p>
<ul>${flags.map(f => `<li>${mdInline(f)}</li>`).join('')}</ul>
</aside>`;
}

function card(e, base) {
  return `<li class="card" data-slug="${esc(e.slug)}">
  <a href="${link(base, `events/${e.slug}/`)}">
    <img src="${base}${e.imageUrl}" alt="" width="640" height="400" loading="lazy" decoding="async">
    <span class="card-body">
      <span class="card-title">${esc(e.title)}</span>
      <span class="points"><span class="visually-hidden">Worth </span>${fmtPoints(e.points)}<span class="unit"> pts</span></span>
    </span>
  </a>
</li>`;
}

function homePage(site, events) {
  const base = './';
  const facts = (site.facts || []).map(f => `<li>${esc(f)}</li>`).join('');
  const body = `
<section class="hero">
  <h1>${esc(site.title)}</h1>
  <p class="tagline">${esc(site.tagline)}</p>
  ${facts ? `<ul class="facts">${facts}</ul>` : ''}
  <p><a class="button" href="${link(base, 'rules/')}">How it works</a></p>
</section>

<section class="search" role="search" aria-label="Search events and rules">
  <label for="q">Search events and rules</label>
  <div class="search-field">
    <input id="q" type="search" placeholder="Try “darts”, “green hole”, “No Rep”" autocomplete="off" spellcheck="false">
  </div>
  <p id="search-status" class="search-status" aria-live="polite"></p>
  <ol id="search-results" class="search-results" hidden></ol>
</section>

<section aria-labelledby="events-h">
  <h2 id="events-h" class="section-title">Events</h2>
  <ul class="cards" id="cards">
    ${events.map(e => card(e, base)).join('\n')}
  </ul>
</section>`;
  return layout({ site, base, title: '', body, current: 'home' });
}

function eventPage(site, e, prev, next) {
  const base = '../../';
  const sections = e.sections.map(s => {
    const id = s.key;
    let inner;
    if (s.key === 'scoring') {
      inner = `${e.points != null ? `<p class="points-line"><strong>${fmtPoints(e.points)} points</strong> for completing this event.</p>` : ''}
${s.md ? md(s.md) : ''}`;
      if (!s.md && e.points == null) inner = `<p class="missing">Not stated in the original guide.</p>`;
    } else {
      inner = s.md ? md(s.md) : `<p class="missing">Not stated in the original guide.</p>`;
    }
    return `<details class="rule-section" id="${id}"${s.open ? ' open' : ''}>
<summary><h2>${esc(s.heading)}</h2></summary>
<div class="rule-body">${inner}</div>
</details>`;
  }).join('\n');

  const body = `
<article class="event">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="${link(base, '')}">All events</a></nav>
  <header class="event-head">
    <h1>${esc(e.title)}</h1>
    ${e.points != null ? `<p class="points big">${fmtPoints(e.points)}<span class="unit"> pts</span></p>` : ''}
  </header>
  <figure class="event-figure">
    <img src="${base}${e.imageUrl}" alt="${esc(e.imageIsPlaceholder ? '' : e.image_alt || '')}" width="640" height="400" decoding="async">
    ${e.caption ? `<figcaption>${mdInline(e.caption)}</figcaption>` : ''}
  </figure>
  <div class="section-tools">
    <button type="button" class="link-button" data-toggle-all>Expand all</button>
  </div>
  ${sections}
  ${flagsBox(e.flags, site)}
  <nav class="pager" aria-label="More events">
    ${prev ? `<a rel="prev" href="${link(base, `events/${prev.slug}/`)}"><span>Previous</span>${esc(prev.title)}</a>` : '<span></span>'}
    ${next ? `<a rel="next" href="${link(base, `events/${next.slug}/`)}"><span>Next</span>${esc(next.title)}</a>` : '<span></span>'}
  </nav>
</article>`;
  const desc = plain(md(e.sections.find(s => s.key === 'objective')?.md || '')).slice(0, 155);
  return layout({ site, base, title: e.title, description: desc, body, current: 'event' });
}

function rulesPage(site, siteSections, lineup, events) {
  const base = '../';
  const bySlug = new Map(events.map(e => [e.slug, e]));
  const rows = lineup.map(l => {
    const e = bySlug.get(slugify(l.title));
    const name = e ? `<a href="${link(base, `events/${e.slug}/`)}">${esc(l.title)}</a>` : esc(l.title);
    return `<tr><td>${name}</td><td class="num">${fmtPoints(l.points)}</td></tr>`;
  }).join('');
  const body = `
<article class="rules">
  <h1>How it works</h1>
  ${siteSections.map(s => `<section id="${slugify(s.heading)}"><h2>${esc(s.heading)}</h2>${md(s.md)}</section>`).join('\n')}
  <section id="event-list">
    <h2>Event list</h2>
    <table class="lineup"><caption class="visually-hidden">Events and their point values</caption>
    <thead><tr><th scope="col">Event</th><th scope="col" class="num">Points</th></tr></thead>
    <tbody>${rows}</tbody></table>
  </section>
  ${flagsBox(site.flags, site)}
</article>`;
  return layout({ site, base, title: 'How it works', body, current: 'rules' });
}

function notFoundPage(site) {
  // GitHub Pages serves 404.html at any URL depth, so relative links would break. A <base> tag
  // pointing at the site root (first path segment on *.github.io project sites) fixes them.
  const body = `<section class="hero"><h1>Not found</h1><p>That page isn't in the guide.</p>
<p><a class="button" href="${link('./', '')}">See all events</a></p></section>`;
  return layout({ site, base: './', title: 'Not found', body, current: '' }).replace('<head>\n',
    `<head>\n<script>document.write('<base href="' + (location.hostname.endsWith('github.io') ? '/' + location.pathname.split('/')[1] + '/' : '/') + '">')</script>\n`);
}

// ---------- search index ----------

function searchIndex(site, siteSections, events) {
  const docs = events.map(e => ({
    t: e.title,
    u: `events/${e.slug}/`,
    p: e.points ?? null,
    s: e.sections.filter(s => s.md).map(s => ({ h: s.heading, a: s.key, x: plain(md(s.md)) })),
  }));
  docs.push({
    t: 'How it works',
    u: 'rules/',
    p: null,
    s: siteSections.map(s => ({ h: s.heading, a: slugify(s.heading), x: plain(md(s.md)) })),
  });
  return docs;
}

// ---------- build ----------

let ASSET_VERSION = 'dev';

async function writeFile(rel, content) {
  const p = path.join(OUT, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
}

async function listFiles(dir, prefix = '') {
  const out = [];
  for (const d of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = prefix + d.name;
    if (d.isDirectory()) out.push(...await listFiles(path.join(dir, d.name), rel + '/'));
    else out.push(rel);
  }
  return out;
}

async function main() {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });

  const { data: site, body: siteBody } = parseFrontMatter(await fs.readFile(path.join(CONTENT, 'site.md'), 'utf8'), 'site.md');
  const siteSections = splitSections(siteBody).filter(s => s.heading);
  const events = await loadEvents();
  site.anyDraft = events.some(e => e.wording !== 'verbatim');

  const lineupFile = path.join(CONTENT, 'lineup.json');
  const lineup = await exists(lineupFile)
    ? JSON.parse(await fs.readFile(lineupFile, 'utf8')).events
    : events.map(e => ({ title: e.title, points: e.points }));

  const css = await fs.readFile(path.join(SRC, 'style.css'), 'utf8');
  const js = await fs.readFile(path.join(SRC, 'app.js'), 'utf8');
  ASSET_VERSION = crypto.createHash('sha1').update(css + js).digest('hex').slice(0, 8);

  await prepareImages(events);
  await writeFile('style.css', css);
  await writeFile('app.js', js);
  await fs.copyFile(path.join(SRC, 'icon.svg'), path.join(OUT, 'icon.svg'));
  await writeFile('manifest.webmanifest', JSON.stringify({
    name: site.title, short_name: 'Garage Games', description: site.description,
    start_url: './', scope: './', display: 'standalone',
    background_color: '#1b1a17', theme_color: '#1b1a17',
    icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
  }, null, 2));
  await writeFile('search-index.json', JSON.stringify(searchIndex(site, siteSections, events)));

  await writeFile('index.html', homePage(site, events));
  await writeFile('rules/index.html', rulesPage(site, siteSections, lineup, events));
  await writeFile('404.html', notFoundPage(site));
  for (const [i, e] of events.entries()) {
    await writeFile(`events/${e.slug}/index.html`, eventPage(site, e, events[i - 1], events[i + 1]));
  }
  await writeFile('.nojekyll', '');

  // Service worker: precache every built file; the cache name changes whenever any file does.
  const files = (await listFiles(OUT)).filter(f => !f.startsWith('.') && f !== '404.html').sort();
  const hash = crypto.createHash('sha1');
  for (const f of files) hash.update(f).update(await fs.readFile(path.join(OUT, f)));
  const precache = files.map(f => f.endsWith('index.html') && !EXPLICIT_INDEX ? f.slice(0, -'index.html'.length) || './' : f)
    .map(f => f.replace(/^(style\.css|app\.js)$/, `$1?v=${ASSET_VERSION}`));
  const sw = (await fs.readFile(path.join(SRC, 'sw.js'), 'utf8'))
    .replace('__CACHE_VERSION__', hash.digest('hex').slice(0, 10))
    .replace('__PRECACHE__', JSON.stringify(precache, null, 2));
  await writeFile('sw.js', sw);

  console.log(`Built ${events.length} events, ${files.length + 1} files into dist/`);
}

main().catch(err => { console.error(err.message || err); process.exit(1); });
