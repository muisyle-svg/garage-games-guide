// Garage Games event guide: expand/collapse, photo slideshow, offline support. No dependencies.
(() => {
  const base = document.body.dataset.base || './';
  const explicitIndex = document.body.dataset.explicitIndex === 'true';
  const href = u => base + (explicitIndex ? u.replace(/\/$/, '/index.html') : u);

  // ---- Expand / collapse all guideline sections ----
  const toggle = document.querySelector('[data-toggle-all]');
  if (toggle) {
    const sections = [...document.querySelectorAll('details.guideline-section')];
    const sync = () => { toggle.textContent = sections.every(d => d.open) ? 'Collapse all' : 'Expand all'; };
    toggle.addEventListener('click', () => {
      const open = !sections.every(d => d.open);
      sections.forEach(d => { d.open = open; });
      sync();
    });
    sections.forEach(d => d.addEventListener('toggle', sync));
    sync();
  }

  // Open a collapsed section when linked to directly.
  const openTarget = () => {
    const el = location.hash && document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (el && el.tagName === 'DETAILS') { el.open = true; el.scrollIntoView(); }
  };
  addEventListener('hashchange', openTarget);
  openTarget();

  // ---- Photo slideshow ----
  for (const box of document.querySelectorAll('[data-slideshow]')) {
    const slides = JSON.parse(box.querySelector('[data-slides]').textContent);
    const img = box.querySelector('.slide-photo img');
    const cap = box.querySelector('.slide-caption');
    const num = box.querySelector('[data-slide-num]');
    let i = 0;
    const preload = k => { new Image().src = slides[(k + slides.length) % slides.length].src; };
    const show = k => {
      i = (k + slides.length) % slides.length;
      img.src = slides[i].src; img.alt = slides[i].caption;
      cap.textContent = slides[i].caption; num.textContent = i + 1;
      preload(i + 1); preload(i - 1);
    };
    const step = d => show(i + d);
    box.querySelector('[data-slide="prev"]').addEventListener('click', () => step(-1));
    box.querySelector('[data-slide="next"]').addEventListener('click', () => step(1));
    box.addEventListener('keydown', ev => {
      if (ev.key === 'ArrowLeft') step(-1);
      if (ev.key === 'ArrowRight') step(1);
    });
    // Swipe left or right on the photo.
    let x0 = null;
    img.addEventListener('pointerdown', ev => { x0 = ev.clientX; });
    img.addEventListener('pointerup', ev => {
      if (x0 !== null && Math.abs(ev.clientX - x0) > 40) step(ev.clientX < x0 ? 1 : -1);
      x0 = null;
    });
    preload(1);
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
