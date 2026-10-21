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
// `aliases` are other "## " headings an event file may use for the same section.
const SECTIONS = [
  { key: 'objective', heading: 'Objective', open: true },
  { key: 'gameplay', heading: 'Gameplay', open: true },
  { key: 'additional-guidelines', heading: 'Additional Guidelines and Clarifications', open: true, aliases: ['additional-guidelines-and-clarifications'] },
  { key: 'setup', heading: 'Setup/Reset', open: false, aliases: ['setup-reset', 'reset'] },
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
    const known = new Map(SECTIONS.flatMap(s => [s.key, ...(s.aliases || [])].map(k => [k, s])));
    const sections = SECTIONS.map(s => ({ ...s, md: null }));
    const extra = [];
    for (const p of parts) {
      const key = p.heading ? slugify(p.heading) : null;
      const target = key && known.has(key) ? sections.find(s => s.key === known.get(key).key) : null;
      if (target) target.md = p.md.trim();
      else if (p.heading) extra.push({ key, heading: p.heading, md: p.md.trim(), open: false });
      else console.warn(`${f}: text before the first "## " heading is ignored`);
    }
    for (const x of extra) console.warn(`${f}: extra section "${x.heading}" shown after the standard ones`);
    const objective = sections.find(s => s.key === 'objective').md;
    events.push({ ...data, slug, file: f, objective, sections: [...sections, ...extra].filter(s => s.md) });
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

// Short content hash used as a ?v= query, so browsers and the offline cache fetch an image again whenever it changes.
async function fileVersion(rel) {
  return crypto.createHash('sha1').update(await fs.readFile(path.join(OUT, rel))).digest('hex').slice(0, 8);
}

// Images placed in content/site.md as images/<file>: point them at the right folder with a ?v= version.
const IMAGE_VERSIONS = new Map();
const siteImages = (html, base) => html.replace(/<a href="images\/([^"?]+)"/g, (m, f) =>
  `<a href="${base}images/${f}${IMAGE_VERSIONS.has(f) ? `?v=${IMAGE_VERSIONS.get(f)}` : ''}"`).replace(/(<img[^>]*?) src="images\/([^"?]+)"/g, (m, pre, f) =>
  `${pre} src="${base}images/${f}${IMAGE_VERSIONS.has(f) ? `?v=${IMAGE_VERSIONS.get(f)}` : ''}" loading="lazy" decoding="async"`);

async function prepareImages(events) {
  await fs.mkdir(path.join(OUT, 'images'), { recursive: true });
  const srcDir = path.join(CONTENT, 'images');
  if (await exists(srcDir)) await fs.cp(srcDir, path.join(OUT, 'images'), { recursive: true });
  for (const f of await fs.readdir(path.join(OUT, 'images'))) {
    if (/\.(jpe?g|png|webp|gif|svg|avif)$/i.test(f)) IMAGE_VERSIONS.set(f, await fileVersion(`images/${f}`));
  }
  for (const [i, e] of events.entries()) {
    if (e.image && await exists(path.join(srcDir, e.image))) {
      e.imageUrl = `images/${e.image}?v=${await fileVersion(`images/${e.image}`)}`;
      e.imageIsPlaceholder = false;
    } else {
      if (e.image) console.warn(`${e.file}: image "${e.image}" not found in content/images, using a placeholder`);
      const name = `placeholder-${e.slug}.svg`;
      await fs.writeFile(path.join(OUT, 'images', name), placeholderSvg(e.title, i));
      e.imageUrl = `images/${name}?v=${await fileVersion(`images/${name}`)}`;
      e.imageIsPlaceholder = true;
    }
    if (e.slideshow) e.slides = await loadSlideshow(e);
  }
}

// A photo slideshow (content/slideshows/<name>.md): its captions pair up, in order, with the
// photos in content/images/<folder>/ sorted by file name.
async function loadSlideshow(e) {
  const file = path.join(CONTENT, 'slideshows', `${e.slideshow}.md`);
  const { data, body } = parseFrontMatter(await fs.readFile(file, 'utf8'), `slideshows/${e.slideshow}.md`);
  const folder = data.folder || e.slideshow;
  const photos = (await fs.readdir(path.join(CONTENT, 'images', folder)))
    .filter(f => /\.(jpe?g|png|webp|gif|avif)$/i.test(f)).sort();
  const captions = data.captions || [];
  if (photos.length !== captions.length) console.warn(`slideshows/${e.slideshow}.md: ${captions.length} captions for ${photos.length} photos`);
  const items = [];
  for (const [i, f] of photos.entries()) {
    items.push({ src: `images/${folder}/${f}?v=${await fileVersion(`images/${folder}/${f}`)}`, caption: String(captions[i] ?? '') });
  }
  return { title: data.title || 'Photos', intro: body.trim(), items };
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
    <li><a href="${link(base, 'guidelines/')}"${current === 'guidelines' ? ' aria-current="page"' : ''}>How it works</a></li>
    <li><a href="${link(base, '')}#events"${current === 'home' ? ' aria-current="page"' : ''}>Events</a></li>
  </ul></nav>
</header>
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

function pill(e, big = false) {
  const cls = `points${big ? ' big' : ''}`;
  if (e.bonus) return `<span class="${cls} bonus">Bonus</span>`;
  if (e.points == null) return '';
  return `<span class="${cls}"><span class="visually-hidden">Worth </span>${e.points}<span class="unit"> pts</span></span>`;
}

// Small line icons for the scoring badges; they take the badge's text color.
const ICON = {
  grace: '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 13.5V9.5M10 2.5h4M12 2.5v3.5M18.5 6.5l1.5-1.5"/>',
  decay: '<path d="M3 6l6 6 4-3 8 8"/><path d="M21 11v6h-6"/>',
  auto: '<circle cx="12" cy="12" r="8.5"/><path d="M8 12.5l2.7 2.7L16 9.5"/>',
  hit: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5"/>',
};
const icon = k => `<svg class="stat-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${ICON[k]}</svg>`;
const stat = (k, value, label, title) => `<li class="stat stat-${k}" title="${esc(title)}">${icon(k)}<span class="stat-text"><span class="stat-value">${value}</span><span class="stat-label">${label}</span></span></li>`;

// Points bubble plus scoring badges for the top of an event page.
function stats(e, compact = false) {
  const out = [`<li>${pill(e, !compact)}</li>`];
  if (e.points_label) out.push(stat('hit', esc(e.points_label), 'per hit', `Each button hit is worth ${e.points_label}`));
  if (e.grace_period != null) out.push(stat('grace', `${e.grace_period} s`, 'grace', `Grace period: finish within ${e.grace_period} seconds to keep every point`));
  if (e.points_per_second != null) out.push(stat('decay', `−${e.points_per_second}/s`, 'after grace', `After the grace period you lose ${e.points_per_second} ${e.points_per_second === 1 ? 'point' : 'points'} every second`));
  if (e.finish === 'auto') out.push(stat('auto', 'Auto', 'stop', 'Your time is recorded automatically. No need to press the button at the end.'));
  return `<ul class="stats${compact ? ' compact' : ''}" aria-label="Scoring">${out.join('')}</ul>`;
}

function card(e, base) {
  return `<li class="card" data-slug="${esc(e.slug)}">
  <a href="${link(base, `events/${e.slug}/`)}">
    <img src="${base}${e.imageUrl}" alt="" width="640" height="400" loading="lazy" decoding="async">
    <span class="card-body">
      <span class="card-title">${esc(e.title)}</span>
      ${pill(e)}
    </span>
  </a>
</li>`;
}

function homePage(site, events) {
  const base = './';
  const facts = (site.facts || []).map(f => `<li>${esc(f)}</li>`).join('');
  const steps = (site.steps || []).map(st => `<li><span>${mdInline(st)}</span></li>`).join("");
  const body = `
<section class="hero">
  <h1>${esc(site.title)}</h1>
  <p class="tagline">${esc(site.tagline)}</p>
  ${facts ? `<ul class="facts">${facts}</ul>` : ''}
</section>

<section class="howto" aria-labelledby="howto-h">
  <h2 id="howto-h">How it works</h2>
  <ol class="steps">${steps}</ol>
  <p><a class="button" href="${link(base, 'guidelines/')}">Read the full guidelines</a></p>
</section>

<section id="events" aria-labelledby="events-h">
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
    const inner = md(s.md);
    return `<details class="guideline-section" id="${id}"${s.open ? ' open' : ''}>
<summary><h2>${esc(s.heading)}</h2></summary>
<div class="guideline-body">${inner}</div>
</details>`;
  }).join('\n');

  const body = `
<article class="event">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="${link(base, '')}">All events</a></nav>
  <header class="event-head">
    ${e.subtitle ? `<p class="eyebrow">${esc(e.subtitle)}</p>` : ''}
    <h1>${esc(e.title)}</h1>
    ${stats(e)}
  </header>
  <figure class="event-figure">
    <img src="${base}${e.imageUrl}" alt="${esc(e.imageIsPlaceholder ? '' : e.image_alt || `Animation: ${plain(md(e.objective || e.title))}`)}" width="640" height="400" decoding="async">
    ${e.caption ? `<figcaption>${mdInline(e.caption)}</figcaption>` : ''}
  </figure>
  <div class="section-tools">
    <button type="button" class="link-button" data-toggle-all>Expand all</button>
  </div>
  ${sections}
  ${e.slides ? slideshow(e.slides, base) : ''}
  <nav class="pager" aria-label="More events">
    ${prev ? `<a rel="prev" href="${link(base, `events/${prev.slug}/`)}"><span>Previous</span>${esc(prev.title)}</a>` : '<span></span>'}
    ${next ? `<a rel="next" href="${link(base, `events/${next.slug}/`)}"><span>Next</span>${esc(next.title)}</a>` : '<span></span>'}
  </nav>
</article>`;
  const desc = plain(md(e.objective || '')).slice(0, 155);
  return layout({ site, base, title: e.title, description: desc, body, current: 'event' });
}

function slideshow(show, base) {
  const first = show.items[0];
  if (!first) return '';
  const n = show.items.length;
  return `<details class="guideline-section slideshow" id="slideshow">
<summary><h2>${esc(show.title)}</h2></summary>
<div class="guideline-body" aria-roledescription="carousel" aria-label="${esc(show.title)}" data-slideshow>
  ${show.intro ? `<div class="slideshow-intro">${md(show.intro)}</div>` : ''}
  <figure class="slide" aria-live="polite">
    <div class="slide-photo"><img src="${base}${first.src}" alt="${esc(first.caption)}" width="800" height="800" decoding="async"></div>
    <figcaption class="slide-caption">${esc(first.caption)}</figcaption>
  </figure>
  <div class="slide-controls">
    <button type="button" class="slide-btn" data-slide="prev" aria-label="Previous photo">&#8249;</button>
    <span class="slide-count"><span data-slide-num>1</span> / ${n}</span>
    <button type="button" class="slide-btn" data-slide="next" aria-label="Next photo">&#8250;</button>
  </div>
  <script type="application/json" data-slides>${JSON.stringify(show.items.map(s => ({ src: base + s.src, caption: s.caption }))).replace(/</g, '\\u003c')}</script>
</div>
</details>`;
}

// A collapsible box, open to start (the same style as the sections on event pages).
const box = (id, heading, html, open = true) => `<details class="guideline-section" id="${id}"${open ? ' open' : ''}>
<summary><h2>${esc(heading)}</h2></summary>
<div class="guideline-body">${html}</div>
</details>`;

function guidelinesPage(site, siteSections, events) {
  const base = '../';
  const items = events.map(e => `<li class="lineup-item">
  <a class="lineup-title" href="${link(base, `events/${e.slug}/`)}">${esc(e.title)}</a>
  ${e.objective ? `<div class="lineup-objective">${md(e.objective)}</div>` : ''}
  ${stats(e, true)}
</li>`).join('\n');
  const body = `
<article class="guidelines">
  <h1>How it works</h1>
  <div class="section-tools">
    <button type="button" class="link-button" data-toggle-all>Collapse all</button>
  </div>
  ${[
    ...siteSections.map(s => box(slugify(s.heading), s.heading, siteImages(md(s.md), base))),
    box('event-list', 'Event list', `<ol class="lineup">${items}</ol>`),
  ].join('\n')}
</article>`;
  return layout({ site, base, title: 'How it works', body, current: 'guidelines' });
}

function notFoundPage(site) {
  // GitHub Pages serves 404.html at any URL depth, so relative links would break. A <base> tag
  // pointing at the site root (first path segment on *.github.io project sites) fixes them.
  const body = `<section class="hero"><h1>Not found</h1><p>That page isn't in the guide.</p>
<p><a class="button" href="${link('./', '')}">See all events</a></p></section>`;
  return layout({ site, base: './', title: 'Not found', body, current: '' }).replace('<head>\n',
    `<head>\n<script>document.write('<base href="' + (location.hostname.endsWith('github.io') ? '/' + location.pathname.split('/')[1] + '/' : '/') + '">')</script>\n`);
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

  await writeFile('index.html', homePage(site, events));
  await writeFile('guidelines/index.html', guidelinesPage(site, siteSections, events));
  await writeFile('404.html', notFoundPage(site));
  // The How it works page moved from rules/ to guidelines/; send old links and bookmarks there.
  await writeFile('rules/index.html', '<!doctype html><meta charset="utf-8"><title>Moved</title><meta name="robots" content="noindex"><meta http-equiv="refresh" content="0; url=../guidelines/"><link rel="canonical" href="../guidelines/"><a href="../guidelines/">How it works</a>');
  for (const [i, e] of events.entries()) {
    await writeFile(`events/${e.slug}/index.html`, eventPage(site, e, events[i - 1], events[i + 1]));
  }
  await writeFile('.nojekyll', '');

  // Service worker: precache every built file; the cache name changes whenever any file does.
  const files = (await listFiles(OUT)).filter(f => !f.startsWith('.') && f !== '404.html' && f !== 'rules/index.html').sort();
  const hash = crypto.createHash('sha1');
  for (const f of files) hash.update(f).update(await fs.readFile(path.join(OUT, f)));
  const precache = [];
  for (const f of files) {
    if (f.endsWith('index.html') && !EXPLICIT_INDEX) precache.push(f.slice(0, -'index.html'.length) || './');
    else if (f === 'style.css' || f === 'app.js') precache.push(`${f}?v=${ASSET_VERSION}`);
    else if (f.startsWith('images/')) precache.push(`${f}?v=${await fileVersion(f)}`);
    else precache.push(f);
  }
  const sw = (await fs.readFile(path.join(SRC, 'sw.js'), 'utf8'))
    .replace('__CACHE_VERSION__', hash.digest('hex').slice(0, 10))
    .replace('__PRECACHE__', JSON.stringify(precache, null, 2));
  await writeFile('sw.js', sw);

  console.log(`Built ${events.length} events, ${files.length + 1} files into dist/`);
}

main().catch(err => { console.error(err.message || err); process.exit(1); });
