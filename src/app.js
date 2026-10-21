// Garage Games event guide: search, expand/collapse, offline support. No dependencies.
(() => {
  const base = document.body.dataset.base || './';
  const explicitIndex = document.body.dataset.explicitIndex === 'true';
  const href = u => base + (explicitIndex ? u.replace(/\/$/, '/index.html') : u);

  // ---- Expand / collapse all rule sections ----
  const toggle = document.querySelector('[data-toggle-all]');
  if (toggle) {
    const sections = [...document.querySelectorAll('details.rule-section')];
    const sync = () => { toggle.textContent = sections.every(d => d.open) ? 'Collapse all' : 'Expand all'; };
    toggle.addEventListener('click', () => {
      const open = !sections.every(d => d.open);
      sections.forEach(d => { d.open = open; });
      sync();
    });
    sections.forEach(d => d.addEventListener('toggle', sync));
    sync();
  }

  // Open a collapsed section when linked to directly (e.g. from a search result).
  const openTarget = () => {
    const el = location.hash && document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (el && el.tagName === 'DETAILS') { el.open = true; el.scrollIntoView(); }
  };
  addEventListener('hashchange', openTarget);
  openTarget();

  // ---- Search ----
  const input = document.getElementById('q');
  if (input) {
    const status = document.getElementById('search-status');
    const results = document.getElementById('search-results');
    const cards = [...document.querySelectorAll('#cards .card')];
    let index = null;
    let loading = null;

    const norm = s => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’‘]/g, "'");
    const escapeHtml = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const load = () => loading ||= fetch(base + 'search-index.json')
      .then(r => r.json())
      .then(docs => {
        index = docs.map(d => ({ ...d, nt: norm(d.t), s: d.s.map(s => ({ ...s, nx: norm(s.x) })) }));
      })
      .catch(() => { status.textContent = 'Search is unavailable right now.'; });

    // Highlight query terms in a short excerpt around the first hit.
    const snippet = (text, ntext, terms) => {
      let at = Math.min(...terms.map(t => ntext.indexOf(t)).filter(i => i >= 0));
      if (!isFinite(at)) at = 0;
      const start = Math.max(0, at - 50);
      const end = Math.min(text.length, at + 110);
      let out = escapeHtml(text.slice(start, end));
      for (const t of terms) {
        const re = new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
        out = out.replace(re, '<mark>$1</mark>');
      }
      return (start > 0 ? '…' : '') + out + (end < text.length ? '…' : '');
    };

    const run = () => {
      const q = input.value.trim();
      const terms = norm(q).split(/\s+/).filter(Boolean);
      const url = new URL(location.href);
      if (q) url.searchParams.set('q', q); else url.searchParams.delete('q');
      history.replaceState(null, '', url);

      if (!terms.length) {
        results.hidden = true; results.innerHTML = ''; status.textContent = '';
        cards.forEach(c => { c.hidden = false; });
        return;
      }
      if (!index) { status.textContent = 'Loading…'; load().then(run); return; }

      const hits = [];
      for (const d of index) {
        const all = d.nt + ' ' + d.s.map(s => s.nx).join(' ');
        if (!terms.every(t => all.includes(t))) continue;
        const titleHit = terms.some(t => d.nt.includes(t));
        const best = d.s.find(s => terms.some(t => s.nx.includes(t)));
        hits.push({ d, best, score: (titleHit ? 10 : 0) + d.s.filter(s => terms.some(t => s.nx.includes(t))).length });
      }
      hits.sort((a, b) => b.score - a.score);

      const slugs = new Set(hits.map(h => h.d.u));
      cards.forEach(c => { c.hidden = !slugs.has(`events/${c.dataset.slug}/`); });
      results.innerHTML = hits.map(({ d, best }) => `<li><a href="${href(d.u)}${best ? '#' + best.a : ''}">
        <strong>${escapeHtml(d.t)}</strong>
        ${best ? `<span class="where">${escapeHtml(best.h)}</span><span class="snip">${snippet(best.x, best.nx, terms)}</span>` : ''}
      </a></li>`).join('');
      results.hidden = !hits.length;
      status.textContent = hits.length
        ? `${hits.length} ${hits.length === 1 ? 'match' : 'matches'} for “${q}”`
        : `No matches for “${q}”. Try a shorter word.`;
    };

    let timer;
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 120); });
    input.addEventListener('focus', load, { once: true });
    const initial = new URLSearchParams(location.search).get('q');
    if (initial) { input.value = initial; run(); }
  }

  // ---- Offline caching ----
  const offline = document.querySelector('.offline-status');
  const showStatus = () => { if (offline) offline.textContent = navigator.onLine ? '' : 'You are offline. Showing the saved guide.'; };
  addEventListener('online', showStatus);
  addEventListener('offline', showStatus);
  showStatus();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    // When a new version of the guide has been saved offline, reload once so it shows straight away.
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !reloaded) { reloaded = true; location.reload(); }
    });
    navigator.serviceWorker.register(base + 'sw.js', { scope: base, updateViaCache: 'none' }).catch(() => {});
  }
})();
