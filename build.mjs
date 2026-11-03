// Builds the static event guide from content/ into dist/.
// Every year in content/years/<year>/ becomes its own guide at /<year>/; the addresses without a
// year (/, /guidelines/, /scoreboard/, /events/<slug>/) send visitors to the current year.
// Usage: node build.mjs [--explicit-index] [--live-year]
//   --explicit-index  link to ".../index.html" instead of ".../" (for hosts without directory indexes)
//   --live-year       print the year that gets the scorekeeper's live scores, and stop
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONTENT = path.join(ROOT, 'content');
const YEARS = path.join(CONTENT, 'years');
const SHARED_IMAGES = path.join(CONTENT, 'shared', 'images');
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

// Reads a Markdown file of a year's content. `from: 2026` in its front matter reuses the same
// file from that year (`from: 2026/wall-d` names a different file in the same folder): its
// front matter fields are the starting point, fields set here replace them, and its text is used
// unless this file has text of its own.
async function readContent(year, rel, seen = []) {
  const file = path.join(YEARS, String(year), rel);
  const label = `${year}/${rel}`;
  if (seen.includes(label)) throw new Error(`${label}: "from:" loops back on itself`);
  const { data, body } = parseFrontMatter(await fs.readFile(file, 'utf8'), label);
  if (data.from == null) return { data, body, label };
  const [fromYear, name] = String(data.from).split('/');
  const fromRel = name ? path.join(path.dirname(rel), `${name}.md`) : rel;
  if (!await exists(path.join(YEARS, fromYear, fromRel))) throw new Error(`${label}: from: ${data.from} — there's no ${fromYear}/${fromRel}`);
  const src = await readContent(fromYear, fromRel, [...seen, label]);
  const { from, ...own } = data;
  return { data: { ...src.data, ...own }, body: body.trim() ? body : src.body, label, from: src.from || fromYear };
}

// The year's own copy of a file, or else the newest earlier year that has one.
async function findContent(year, rel) {
  for (const y of [year, ...ALL_YEARS.filter(y => y < year).reverse()]) {
    if (await exists(path.join(YEARS, String(y), rel))) return readContent(y, rel);
  }
  return null;
}

async function loadEvents(year) {
  const dir = path.join(YEARS, String(year), 'events');
  const files = (await exists(dir) ? await fs.readdir(dir) : []).filter(f => f.endsWith('.md'));
  const events = [];
  for (const f of files) {
    const { data, body, from } = await readContent(year, `events/${f}`);
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
      else console.warn(`${year}/events/${f}: text before the first "## " heading is ignored`);
    }
    for (const x of extra) console.warn(`${year}/events/${f}: extra section "${x.heading}" shown after the standard ones`);
    const objective = sections.find(s => s.key === 'objective').md;
    events.push({ ...data, slug, file: `${year}/events/${f}`, from, objective, sections: [...sections, ...extra].filter(s => s.md) });
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

// Each year's images end up in dist/<year>/images/: first content/shared/images/, then the
// year's own content/years/<year>/images/ (a file there replaces a shared one of the same name).
// An image the year's text names but doesn't have is copied from the newest earlier year that
// has it, so a reused event keeps its animation without copying files by hand.
const IMAGE_FILE = /\.(jpe?g|png|webp|gif|svg|avif)$/i;
const imageRefs = text => [...String(text).matchAll(/images\/([^\s)"'?#]+)/g)].map(m => m[1]);

async function ensureImage(year, rel) {
  const dest = path.join(OUT, String(year), 'images', rel);
  if (await exists(dest)) return true;
  for (const y of ALL_YEARS.filter(y => y < year).reverse()) {
    const src = path.join(YEARS, String(y), 'images', rel);
    if (await exists(src)) {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.cp(src, dest, { recursive: true });
      return true;
    }
  }
  return false;
}

// Images placed in site.md or an event page as images/<file>: point them at the year's folder with a ?v= version.
const siteImages = (html, base, versions) => html.replace(/<a href="images\/([^"?]+)"/g, (m, f) =>
  `<a href="${base}images/${f}${versions.has(f) ? `?v=${versions.get(f)}` : ''}"`).replace(/(<img[^>]*?) src="images\/([^"?]+)"/g, (m, pre, f) =>
  `${pre} src="${base}images/${f}${versions.has(f) ? `?v=${versions.get(f)}` : ''}" loading="lazy" decoding="async"`);

async function prepareImages(Y) {
  const { year, events } = Y;
  const out = path.join(OUT, String(year), 'images');
  await fs.mkdir(out, { recursive: true });
  for (const dir of [SHARED_IMAGES, path.join(YEARS, String(year), 'images')]) {
    if (await exists(dir)) await fs.cp(dir, out, { recursive: true });
  }
  const wanted = [...imageRefs(Y.siteBody), ...events.flatMap(e => [e.image, ...e.sections.flatMap(s => imageRefs(s.md))]), Y.course?.image];
  for (const f of new Set(wanted.filter(Boolean))) {
    if (!await ensureImage(year, f)) console.warn(`${year}: image "${f}" not found in ${year}/images, shared/images or an earlier year`);
  }
  Y.imageVersions = new Map();
  for (const f of await fs.readdir(out)) {
    if (IMAGE_FILE.test(f)) Y.imageVersions.set(f, await fileVersion(`${year}/images/${f}`));
  }
  for (const [i, e] of events.entries()) {
    if (e.image && await exists(path.join(out, e.image))) {
      e.imageUrl = `images/${e.image}?v=${await fileVersion(`${year}/images/${e.image}`)}`;
      e.imageIsPlaceholder = false;
    } else {
      const name = `placeholder-${e.slug}.svg`;
      await fs.writeFile(path.join(out, name), placeholderSvg(e.title, i));
      e.imageUrl = `images/${name}?v=${await fileVersion(`${year}/images/${name}`)}`;
      e.imageIsPlaceholder = true;
    }
    if (e.slideshow) e.slides = await loadSlideshow(year, e);
  }
}

// A photo slideshow (slideshows/<name>.md, this year's or an earlier year's): its captions pair
// up, in order, with the photos in images/<folder>/ sorted by file name.
async function loadSlideshow(year, e) {
  const show = await findContent(year, `slideshows/${e.slideshow}.md`);
  if (!show) throw new Error(`${e.file}: slideshow "${e.slideshow}" not found in slideshows/`);
  const { data, body, label } = show;
  const folder = data.folder || e.slideshow;
  if (!await ensureImage(year, folder)) throw new Error(`${label}: photo folder images/${folder}/ not found`);
  const photos = (await fs.readdir(path.join(OUT, String(year), 'images', folder))).filter(f => IMAGE_FILE.test(f) && !/\.svg$/i.test(f)).sort();
  const captions = data.captions || [];
  if (photos.length !== captions.length) console.warn(`${label}: ${captions.length} captions for ${photos.length} photos`);
  const items = [];
  for (const [i, f] of photos.entries()) {
    items.push({ src: `images/${folder}/${f}?v=${await fileVersion(`${year}/images/${folder}/${f}`)}`, caption: String(captions[i] ?? '') });
  }
  return { title: data.title || 'Photos', intro: body.trim(), items };
}

// ---------- templates ----------

// `root` is the way from a page back to the site root (shared files: style, scripts, icon);
// `yb` is the way to its year's folder (that year's pages and images).
const link = (base, p) => base + (p === '' ? (EXPLICIT_INDEX ? 'index.html' : '')
  : EXPLICIT_INDEX ? p.replace(/\/$/, '/index.html') : p);

// The same page in another year: an event page goes to that year's page for the event, or
// to its event list when the event wasn't on that year.
function samePageIn(Y, kind, slug) {
  if (kind === 'guidelines') return 'guidelines/';
  if (kind === 'scoreboard') return 'scoreboard/';
  if (kind === 'event') return Y.events.some(e => e.slug === slug) ? `events/${slug}/` : '';
  return '';
}

function yearMenu(Y, root, kind, slug) {
  const years = [...SITE.listed, ...(Y.hidden ? [Y] : [])].sort((a, b) => b.year - a.year);
  const items = years.map(o => {
    const p = samePageIn(o, kind, slug);
    const href = link(`${root}${o.year}/`, p) + (kind === 'event' && !p ? '#events' : '');
    return `<li><a href="${href}"${o.year === Y.year ? ' aria-current="true"' : ''}>${o.year}${o.year === SITE.current ? '<span class="year-now"> · current</span>' : ''}</a></li>`;
  }).join('');
  return `<details class="year-menu">
    <summary aria-label="Event year: ${Y.year}. Change year">${Y.year}</summary>
    <ul aria-label="Event year">${items}</ul>
  </details>`;
}

function layout({ Y, root, yb, kind, slug, title, description, body, scripts = [] }) {
  const site = Y.site;
  const full = title ? `${title} · ${site.title}` : `${site.title}: ${site.tagline}`;
  const brand = String(site.title).replace(/\s*\d{4}$/, '');
  const current = SITE.byYear.get(SITE.current);
  const note = Y.year === SITE.current ? '' : `<p class="year-note">${Y.year > SITE.current ? 'This is a preview of' : "You're looking at"} the ${Y.year} guide. <a href="${link(`${root}${SITE.current}/`, samePageIn(current, kind, slug))}">See ${SITE.current}</a></p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(full)}</title>
<meta name="description" content="${esc(description || site.description)}">
<meta name="theme-color" content="#1b1a17" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#f6f3ec" media="(prefers-color-scheme: light)">
<link rel="manifest" href="${root}manifest.webmanifest">
<link rel="icon" href="${root}icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${root}style.css?v=${ASSET_VERSION}">
<script src="${root}app.js?v=${ASSET_VERSION}" defer></script>
${scripts.map(s => `<script src="${root}${s}?v=${ASSET_VERSION}" defer></script>\n`).join('')}</head>
<body data-base="${esc(root)}" data-year="${Y.year}" data-explicit-index="${EXPLICIT_INDEX}">
<a class="skip" href="#main">Skip to content</a>
<header class="topbar">
  <div class="brand-wrap">
    <a class="brand" href="${link(yb, '')}"><span class="brand-mark" aria-hidden="true"></span><span class="brand-text">${esc(brand)}</span></a>
    ${yearMenu(Y, root, kind, slug)}
  </div>
  <nav aria-label="Main"><ul>
    <li><a href="${link(yb, 'guidelines/')}"${kind === 'guidelines' ? ' aria-current="page"' : ''}>How it works</a></li>
    <li><a href="${link(yb, '')}#events"${kind === 'home' ? ' aria-current="page"' : ''}>Events</a></li>
    <li><a href="${link(yb, 'scoreboard/')}"${kind === 'scoreboard' ? ' aria-current="page"' : ''}>Scores</a></li>
  </ul></nav>
</header>
<main id="main" tabindex="-1">
${note}${body}
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

function card(e, yb) {
  return `<li class="card" data-slug="${esc(e.slug)}">
  <a href="${link(yb, `events/${e.slug}/`)}">
    <img src="${yb}${e.imageUrl}" alt="" width="640" height="400" loading="lazy" decoding="async">
    <span class="card-body">
      <span class="card-title">${esc(e.title)}</span>
      ${pill(e)}
    </span>
  </a>
</li>`;
}

// A year's home page, at /<year>/.
function homePage(Y) {
  const { site, events } = Y;
  const root = '../', yb = './';
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
  <p><a class="button" href="${link(yb, 'guidelines/')}">Read the full guidelines</a></p>
</section>

<section id="events" aria-labelledby="events-h">
  <h2 id="events-h" class="section-title">Events</h2>
  <ul class="cards" id="cards">
    ${events.map(e => card(e, yb)).join('\n')}
  </ul>
</section>`;
  return layout({ Y, root, yb, kind: 'home', title: '', body });
}

function eventPage(Y, e, prev, next) {
  const root = '../../../', yb = '../../';
  const sections = e.sections.map(s => {
    const id = s.key;
    const inner = siteImages(md(s.md), yb, Y.imageVersions);
    return `<details class="guideline-section" id="${id}"${s.open ? ' open' : ''}>
<summary><h2>${esc(s.heading)}</h2></summary>
<div class="guideline-body">${inner}</div>
</details>`;
  }).join('\n');

  const body = `
<article class="event">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="${link(yb, '')}">All events</a></nav>
  <header class="event-head">
    ${e.subtitle ? `<p class="eyebrow">${esc(e.subtitle)}</p>` : ''}
    <h1>${esc(e.title)}</h1>
    ${stats(e)}
  </header>
  <figure class="event-figure">
    <img src="${yb}${e.imageUrl}" alt="${esc(e.imageIsPlaceholder ? '' : e.image_alt || `Animation: ${plain(md(e.objective || e.title))}`)}" width="640" height="400" decoding="async">
    ${e.caption ? `<figcaption>${mdInline(e.caption)}</figcaption>` : ''}
  </figure>
  <div class="section-tools">
    <button type="button" class="link-button" data-toggle-all>Expand all</button>
  </div>
  ${sections}
  ${e.slides ? slideshow(e.slides, yb) : ''}
  <nav class="pager" aria-label="More events">
    ${prev ? `<a rel="prev" href="${link(yb, `events/${prev.slug}/`)}"><span>Previous</span>${esc(prev.title)}</a>` : '<span></span>'}
    ${next ? `<a rel="next" href="${link(yb, `events/${next.slug}/`)}"><span>Next</span>${esc(next.title)}</a>` : '<span></span>'}
  </nav>
  ${box('all-events', 'All events', lineup(Y.events, yb, e.slug), false)}
</article>`;
  const desc = plain(md(e.objective || '')).slice(0, 155);
  return layout({ Y, root, yb, kind: 'event', slug: e.slug, title: e.title, description: desc, body });
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

// Every event on one row each: name, objective, scoring badges. `current` marks the page you're on.
const lineup = (events, base, current) => `<ol class="lineup">${events.map(e => `<li class="lineup-item">
  <a class="lineup-title" href="${link(base, `events/${e.slug}/`)}"${e.slug === current ? ' aria-current="page"' : ''}>${esc(e.title).replace(/-/g, '\u2011')}</a>
  ${e.objective ? `<div class="lineup-objective">${md(e.objective)}</div>` : ''}
  ${stats(e, true)}
</li>`).join('\n')}</ol>`;


function guidelinesPage(Y) {
  const root = '../../', yb = '../';
  const body = `
<article class="guidelines">
  <h1>How it works</h1>
  <div class="section-tools">
    <button type="button" class="link-button" data-toggle-all>Collapse all</button>
  </div>
  ${[
    ...Y.siteSections.map(s => box(slugify(s.heading), s.heading, siteImages(md(s.md), yb, Y.imageVersions))),
    box('event-list', 'Event list', lineup(Y.events, yb)),
  ].join('\n')}
</article>`;
  return layout({ Y, root, yb, kind: 'guidelines', title: 'How it works', body });
}

// Standings, filled in by scoreboard.js from the year's scores.json (uploaded by the scorekeeper
// for the current year, kept in content/years/<year>/scores.json for past years).
// Each event's starting points and page come from the guide's own event files, so the
// event comparison can score events that start at different points fairly.
function scoreboardPage(Y) {
  const root = '../../', yb = '../';
  const guide = Y.events.map(e => ({ name: e.title, slug: e.slug, points: e.points ?? null }));
  const body = `
<article class="scoreboard" data-scoreboard data-year-base="${yb}" data-guide-events="${esc(JSON.stringify(guide))}"${Y.course ? ` data-course="${esc(JSON.stringify(Y.course))}"` : ''}>
  <h1>Scores</h1>
  <p class="sb-status" data-scoreboard-status aria-live="polite">Loading scores…</p>
  <section aria-labelledby="overall-h">
    <h2 id="overall-h">Leaderboard</h2>
    <p class="sb-help">Tap a name to see their scorecard. Exhibition runs are listed by points without a rank.</p>
    <div class="table-wrap" data-overall></div>
  </section>
  <section aria-labelledby="compare-h">
    <h2 id="compare-h">Compare players</h2>
    <p class="sb-help">Pick up to four players to compare event by event and see how their runs unfolded.</p>
    <div data-compare></div>
  </section>
  <section aria-labelledby="difficulty-h">
    <h2 id="difficulty-h">How the events compare</h2>
    <p class="sb-help">Events start at different points, so they're compared by share of starting points. Pick how to rank them.</p>
    <div data-difficulty></div>
  </section>
  <section aria-labelledby="event-boards-h">
    <h2 id="event-boards-h">Event leaderboards</h2>
    <div data-event-boards></div>
  </section>
</article>`;
  return layout({ Y, root, yb, kind: 'scoreboard', title: 'Scores', description: `${Y.site.title} leaderboards.`, body, scripts: ['scoreboard.js'] });
}

function notFoundPage() {
  // GitHub Pages serves 404.html at any URL depth, so relative links would break. A <base> tag
  // pointing at the site root (first path segment on *.github.io project sites) fixes them.
  const Y = SITE.byYear.get(SITE.current);
  const yb = `${Y.year}/`;
  const body = `<section class="hero"><h1>Not found</h1><p>That page isn't in the guide.</p>
<p><a class="button" href="${link(yb, '')}">See all events</a></p></section>`;
  return layout({ Y, root: './', yb, kind: 'notfound', title: 'Not found', body }).replace('<head>\n',
    `<head>\n<script>document.write('<base href="' + (location.hostname.endsWith('github.io') ? '/' + location.pathname.split('/')[1] + '/' : '/') + '">')</script>\n`);
}

// An address without a year: sends visitors on to the same page in a year's folder, keeping
// anything after the address (?compare=… on the Scores page, #section links).
function redirectPage(fromRel, to) {
  const up = '../'.repeat(fromRel.split('/').length - 1);
  const href = link(up, to);
  return `<!doctype html><meta charset="utf-8"><title>Garage Games</title><meta name="robots" content="noindex">
<script>location.replace(${JSON.stringify(href)} + location.search + location.hash)</script>
<meta http-equiv="refresh" content="0; url=${esc(href)}"><link rel="canonical" href="${esc(href)}"><a href="${esc(href)}">Continue to the guide</a>
`;
}

// ---------- build ----------

let ASSET_VERSION = 'dev';
let ALL_YEARS = [];   // every folder in content/years/, oldest first
let SITE = null;      // { current, listed, byYear }

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

async function loadSettings() {
  ALL_YEARS = (await fs.readdir(YEARS, { withFileTypes: true }))
    .filter(d => d.isDirectory() && /^\d{4}$/.test(d.name)).map(d => Number(d.name)).sort((a, b) => a - b);
  if (!ALL_YEARS.length) throw new Error('No years in content/years/');
  const file = path.join(CONTENT, 'settings.md');
  const { data } = await exists(file) ? parseFrontMatter(await fs.readFile(file, 'utf8'), 'settings.md') : { data: {} };
  const current = Number(data.current_year || ALL_YEARS[ALL_YEARS.length - 1]);
  if (!ALL_YEARS.includes(current)) throw new Error(`settings.md: current_year ${current} has no folder in content/years/`);
  return current;
}

async function loadYear(year) {
  const { data: site, body: siteBody } = await readContent(year, 'site.md');
  const siteSections = splitSections(siteBody).filter(s => s.heading);
  const events = await loadEvents(year);
  const courseFile = path.join(YEARS, String(year), 'course.json');
  const course = await exists(courseFile) ? JSON.parse(await fs.readFile(courseFile, 'utf8')) : null;
  return { year, site, siteBody, siteSections, events, course, hidden: site.hidden === true };
}

async function main() {
  const current = await loadSettings();
  if (process.argv.includes('--live-year')) { console.log(current); return; }

  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });

  const years = [];
  for (const y of ALL_YEARS) years.push(await loadYear(y));
  const byYear = new Map(years.map(Y => [Y.year, Y]));
  SITE = { current, byYear, listed: years.filter(Y => !Y.hidden || Y.year === current) };

  const css = await fs.readFile(path.join(SRC, 'style.css'), 'utf8');
  const js = await fs.readFile(path.join(SRC, 'app.js'), 'utf8');
  const scoreboardJs = await fs.readFile(path.join(SRC, 'scoreboard.js'), 'utf8');
  ASSET_VERSION = crypto.createHash('sha1').update(css + js + scoreboardJs).digest('hex').slice(0, 8);

  await writeFile('style.css', css);
  await writeFile('app.js', js);
  await writeFile('scoreboard.js', scoreboardJs);
  await fs.copyFile(path.join(SRC, 'icon.svg'), path.join(OUT, 'icon.svg'));
  const now = byYear.get(current).site;
  await writeFile('manifest.webmanifest', JSON.stringify({
    name: 'Garage Games', short_name: 'Garage Games', description: now.description,
    start_url: './', scope: './', display: 'standalone',
    background_color: '#1b1a17', theme_color: '#1b1a17',
    icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
  }, null, 2));

  for (const Y of years) {
    await prepareImages(Y);
    const y = Y.year;
    await writeFile(`${y}/index.html`, homePage(Y));
    await writeFile(`${y}/guidelines/index.html`, guidelinesPage(Y));
    await writeFile(`${y}/scoreboard/index.html`, scoreboardPage(Y));
    for (const [i, e] of Y.events.entries()) {
      await writeFile(`${y}/events/${e.slug}/index.html`, eventPage(Y, e, Y.events[i - 1], Y.events[i + 1]));
    }
    // A finished year's scores, saved into its folder (see README.md, "Adding a new year").
    const archived = path.join(YEARS, String(y), 'scores.json');
    if (await exists(archived)) await fs.copyFile(archived, path.join(OUT, String(y), 'scores.json'));
  }

  // Addresses without a year go to the current year, so old links, bookmarks and QR codes keep
  // working. An event the current year doesn't have goes to the newest year that had it.
  const redirects = new Map([
    ['index.html', `${current}/`],
    ['guidelines/index.html', `${current}/guidelines/`],
    ['rules/index.html', `${current}/guidelines/`],   // the old name of How it works
    ['scoreboard/index.html', `${current}/scoreboard/`],
  ]);
  for (const Y of [byYear.get(current), ...[...years].reverse()]) {
    if (Y.year > current) continue;
    for (const e of Y.events) {
      const rel = `events/${e.slug}/index.html`;
      if (!redirects.has(rel)) redirects.set(rel, `${Y.year}/events/${e.slug}/`);
    }
  }
  for (const [rel, to] of redirects) await writeFile(rel, redirectPage(rel, to));
  await writeFile('404.html', notFoundPage());
  await writeFile('.nojekyll', '');

  // Service worker: precache the shared files and the current year; other years are saved as
  // they're visited. The cache name changes whenever any file does. scores.json is live data
  // and is never precached.
  const files = (await listFiles(OUT)).filter(f => !f.startsWith('.') && f !== '404.html'
    && !(redirects.has(f) && f !== 'index.html') && !f.endsWith('scores.json')
    && (!/^\d{4}\//.test(f) || f.startsWith(`${current}/`))).sort();
  const hash = crypto.createHash('sha1');
  for (const f of files) hash.update(f).update(await fs.readFile(path.join(OUT, f)));
  const precache = [];
  for (const f of files) {
    if (f.endsWith('index.html') && !EXPLICIT_INDEX) precache.push(f.slice(0, -'index.html'.length) || './');
    else if (f === 'style.css' || f === 'app.js' || f === 'scoreboard.js') precache.push(`${f}?v=${ASSET_VERSION}`);
    else if (/^\d{4}\/images\//.test(f)) precache.push(`${f}?v=${await fileVersion(f)}`);
    else precache.push(f);
  }
  const sw = (await fs.readFile(path.join(SRC, 'sw.js'), 'utf8'))
    .replace('__CACHE_VERSION__', hash.digest('hex').slice(0, 10))
    .replace('__PRECACHE__', JSON.stringify(precache, null, 2));
  await writeFile('sw.js', sw);

  for (const Y of years) console.log(`${Y.year}${Y.year === current ? ' (current)' : ''}${Y.hidden ? ' (hidden)' : ''}: ${Y.events.length} events`);
  console.log(`Built ${files.length + 1} precached files into dist/`);
}

main().catch(err => { console.error(err.message || err); process.exit(1); });
