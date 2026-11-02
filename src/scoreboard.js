// Live scoreboard: reads scores.json (uploaded by the scorekeeper app) and shows the same
// leaderboards as the scorekeeper's Leaderboards tab. Refreshes itself every 30 seconds.
// The ranking rules mirror the scorekeeper (garage_games: wwwroot/mvp-leaderboards.js and
// mvp-scorecard-order.js); keep them in step if those change.
(() => {
  'use strict';

  const CATEGORY = { official: 'Official', playoff: 'Playoff', exhibition: 'Exhibition' };

  // m:ss, like the scorekeeper.
  function formatClock(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function durationOf(result) {
    return result && Number.isFinite(result.startElapsedMs) && Number.isFinite(result.finishElapsedMs)
      && result.finishElapsedMs >= result.startElapsedMs ? result.finishElapsedMs - result.startElapsedMs : null;
  }

  // One board per event: most points first, then the faster time (the bonus round by points
  // alone); equal results share a rank; everyone without a result follows as DNF, by name.
  function buildEventBoards(data) {
    const runs = new Map((data.runs || []).map(r => [r.id, r]));
    return (data.events || []).map(event => {
      const pointsOnly = event.type === 'bonusRound';
      const rows = [];
      const dnf = [];
      for (const lb of data.leaderboard || []) {
        const run = lb.runId && runs.get(lb.runId);
        if (!run || run.category !== lb.category) continue;
        const name = lb.displayName || lb.competitorName;
        const result = (run.events || []).find(e => e.eventId === event.eventId);
        if (!result || result.status !== 'completed') {
          dnf.push({ name, category: lb.category, dnf: true, rank: null, points: null, durationMs: null });
          continue;
        }
        rows.push({ name, category: lb.category, dnf: false, points: Number(result.points || 0), durationMs: durationOf(result) });
      }
      rows.sort((a, b) => {
        if (a.points !== b.points) return b.points - a.points;
        if (pointsOnly) return a.name.localeCompare(b.name);
        if (a.durationMs !== null && b.durationMs !== null && a.durationMs !== b.durationMs) return a.durationMs - b.durationMs;
        if ((a.durationMs === null) !== (b.durationMs === null)) return a.durationMs === null ? 1 : -1;
        return a.name.localeCompare(b.name);
      });
      rows.forEach((row, i) => {
        const prev = rows[i - 1];
        const tied = prev && row.points === prev.points && (pointsOnly || row.durationMs === prev.durationMs);
        row.rank = tied ? prev.rank : i + 1;
      });
      dnf.sort((a, b) => a.name.localeCompare(b.name));
      return { eventId: event.eventId, name: event.name, pointsOnly, rows: [...rows, ...dnf] };
    });
  }

  // A run's scorecard: completed events in the order they were finished, then the rest in
  // course order.
  function scorecard(data, run) {
    const results = new Map((run.events || []).map(e => [e.eventId, e]));
    return (data.events || []).map((definition, index) => ({ definition, result: results.get(definition.eventId) || null, index }))
      .sort((a, b) => {
        const ac = a.result?.status === 'completed';
        const bc = b.result?.status === 'completed';
        if (ac !== bc) return ac ? -1 : 1;
        if (!ac) return a.index - b.index;
        const af = a.result.finishElapsedMs;
        const bf = b.result.finishElapsedMs;
        const ah = Number.isFinite(af) && af >= 0;
        const bh = Number.isFinite(bf) && bf >= 0;
        if (ah !== bh) return ah ? -1 : 1;
        if (!ah || af === bf) return a.index - b.index;
        return af - bf;
      });
  }

  const api = { buildEventBoards, scorecard, formatClock };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }

  // ---------- page ----------

  const root = document.querySelector('[data-scoreboard]');
  if (!root) return;
  const base = document.body.dataset.base || './';
  const statusEl = root.querySelector('[data-scoreboard-status]');
  const overallEl = root.querySelector('[data-overall]');
  const eventsEl = root.querySelector('[data-event-boards]');
  const openRuns = new Set();
  const openEvents = new Set();
  let lastText = '';
  let lastData = null;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  };
  const badge = category => category && category !== 'official'
    ? el('span', `sb-badge sb-${category}`, CATEGORY[category] || category) : null;

  function playerCell(name, category) {
    const td = el('td', 'sb-player');
    td.append(el('span', 'sb-name', name));
    const b = badge(category);
    if (b) td.append(' ', b);
    return td;
  }

  function renderOverall(data) {
    const rows = data.leaderboard || [];
    const runs = new Map((data.runs || []).map(r => [r.id, r]));
    if (!rows.length) {
      overallEl.replaceChildren(el('p', 'sb-empty', 'No results yet. Scores appear here as runs are recorded.'));
      return;
    }
    const table = el('table', 'sb-table sb-overall');
    table.innerHTML = '<thead><tr><th scope="col" class="sb-rank">Rank</th><th scope="col">Player</th><th scope="col" class="sb-num">Points</th></tr></thead>';
    const tbody = el('tbody');
    let section = null;
    const hasPlayoffs = rows.some(r => r.category === 'playoff');
    rows.forEach((row, i) => {
      const group = row.category === 'playoff' ? 'Playoffs' : 'Standings';
      if (hasPlayoffs && group !== section) {
        section = group;
        const tr = el('tr', 'sb-group');
        const th = el('th', '', group);
        th.colSpan = 3; th.scope = 'colgroup';
        tr.append(th);
        tbody.append(tr);
      }
      const run = row.runId && runs.get(row.runId);
      const key = row.runId || `row-${i}`;
      const tr = el('tr', 'sb-row');
      tr.append(el('td', 'sb-rank', row.rank == null ? '' : String(row.rank)));
      const name = playerCell(row.displayName || row.competitorName, row.category === 'playoff' ? null : row.category);
      tr.append(name, el('td', 'sb-num sb-points', String(row.points)));
      tbody.append(tr);
      if (!run) return;
      // Tap a player to see their scorecard.
      const button = el('button', 'sb-expand');
      button.type = 'button';
      button.setAttribute('aria-expanded', String(openRuns.has(key)));
      button.append(...name.childNodes);
      name.replaceChildren(button);
      const detail = el('tr', 'sb-detail');
      detail.hidden = !openRuns.has(key);
      const cell = el('td');
      cell.colSpan = 3;
      cell.append(renderScorecard(data, run));
      detail.append(cell);
      tbody.append(detail);
      button.addEventListener('click', () => {
        const open = detail.hidden;
        detail.hidden = !open;
        button.setAttribute('aria-expanded', String(open));
        if (open) openRuns.add(key); else openRuns.delete(key);
      });
    });
    table.append(tbody);
    overallEl.replaceChildren(table);
  }

  function renderScorecard(data, run) {
    const table = el('table', 'sb-table sb-card');
    table.innerHTML = '<thead><tr><th scope="col">Event</th><th scope="col" class="sb-num">Time</th><th scope="col" class="sb-num">Points</th></tr></thead>';
    const tbody = el('tbody');
    for (const { definition, result } of scorecard(data, run)) {
      const done = result?.status === 'completed';
      const tr = el('tr', done ? '' : 'sb-dnf');
      tr.append(
        el('td', '', definition.name),
        el('td', 'sb-num', done && definition.type !== 'bonusRound' ? formatClock(durationOf(result)) : '—'),
        el('td', 'sb-num', done || result?.points ? String(result.points) : '—'),
      );
      tbody.append(tr);
    }
    const foot = el('tfoot');
    const tr = el('tr');
    const th = el('th', '', 'Total');
    th.scope = 'row'; th.colSpan = 2;
    tr.append(th, el('td', 'sb-num', String(run.totalPoints ?? '')));
    foot.append(tr);
    table.append(tbody, foot);
    return table;
  }

  function renderEvents(data) {
    const boards = buildEventBoards(data);
    if (!boards.length || !(data.leaderboard || []).length) {
      eventsEl.replaceChildren(el('p', 'sb-empty', 'Event leaderboards appear once the first run is recorded.'));
      return;
    }
    const frag = document.createDocumentFragment();
    boards.forEach((board, i) => {
      const box = el('details', 'guideline-section sb-event');
      box.open = openEvents.has(board.eventId);
      box.addEventListener('toggle', () => { if (box.open) openEvents.add(board.eventId); else openEvents.delete(board.eventId); });
      const summary = el('summary');
      summary.append(el('span', 'sb-event-name', `${i + 1}. ${board.name}`));
      const leader = board.rows.find(r => !r.dnf);
      summary.append(el('span', 'sb-leader', leader ? `${leader.name} · ${leader.points} pts` : 'No finishes yet'));
      box.append(summary);
      const body = el('div', 'guideline-body');
      const table = el('table', 'sb-table');
      table.innerHTML = `<thead><tr><th scope="col" class="sb-rank">Rank</th><th scope="col">Player</th>${board.pointsOnly ? '' : '<th scope="col" class="sb-num">Time</th>'}<th scope="col" class="sb-num">Points</th></tr></thead>`;
      const tbody = el('tbody');
      for (const row of board.rows) {
        const tr = el('tr', row.dnf ? 'sb-dnf' : '');
        tr.append(el('td', 'sb-rank', row.dnf ? 'DNF' : String(row.rank)), playerCell(row.name, row.category));
        if (!board.pointsOnly) tr.append(el('td', 'sb-num', row.dnf ? '—' : formatClock(row.durationMs)));
        tr.append(el('td', 'sb-num sb-points', row.dnf ? '—' : String(row.points)));
        tbody.append(tr);
      }
      table.append(tbody);
      body.append(table);
      box.append(body);
      frag.append(box);
    });
    eventsEl.replaceChildren(frag);
  }

  function showStatus() {
    if (!lastData) return;
    const at = lastData.publishedAt ? new Date(lastData.publishedAt) : null;
    const when = at && Number.isFinite(at.getTime())
      ? at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : null;
    statusEl.textContent = [
      when ? `Updated ${when}.` : '',
      navigator.onLine ? '' : 'You are offline; these may be out of date.',
    ].filter(Boolean).join(' ');
  }

  async function load() {
    try {
      const res = await fetch(`${base}scores.json?t=${Date.now()}`, { cache: 'no-store' });
      if (res.status === 404) {
        if (!lastData) {
          statusEl.textContent = '';
          overallEl.replaceChildren(el('p', 'sb-empty', 'Scores appear here once the games begin.'));
          eventsEl.replaceChildren();
        }
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const text = await res.text();
      if (text !== lastText) {
        const data = JSON.parse(text);
        lastText = text;
        lastData = data;
        renderOverall(data);
        renderEvents(data);
      }
      showStatus();
    } catch {
      if (!lastData) {
        statusEl.textContent = navigator.onLine ? "Couldn't load the scores. Trying again shortly." : 'You are offline. Scores load when you reconnect.';
      } else {
        showStatus();
      }
    }
  }

  load();
  setInterval(() => { if (!document.hidden) load(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  addEventListener('online', load);
})();
