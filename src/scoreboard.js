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

  // ---------- comparisons ----------

  // Event names differ slightly between the scorekeeper and the guide ("Sort & Sweet"), so
  // match them loosely.
  const nameKey = name => String(name || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');

  // Every leaderboard row that has a run, as something a visitor can pick to compare. A
  // player in the playoffs appears twice: once for their standings run and once for the playoff.
  function comparables(data) {
    const runs = new Map((data.runs || []).map(r => [r.id, r]));
    const out = [];
    for (const row of data.leaderboard || []) {
      const run = row.runId && runs.get(row.runId);
      if (!run) continue;
      const name = row.displayName || row.competitorName;
      const suffix = row.category === 'official' ? '' : ` (${CATEGORY[row.category] || row.category})`;
      out.push({ key: row.runId, name, label: name + suffix, category: row.category, rank: row.rank ?? null, points: row.points, run });
    }
    return out;
  }

  // Event by event results for the picked runs, with who did best on each (most points,
  // then the faster time; the bonus round by points alone). A dead heat has no winner.
  function compareEvents(data, picked) {
    const rows = (data.events || []).map(event => {
      const pointsOnly = event.type === 'bonusRound';
      const results = picked.map(p => {
        const r = (p.run.events || []).find(e => e.eventId === event.eventId);
        const done = r?.status === 'completed';
        return { done, points: done ? Number(r.points || 0) : null, durationMs: done && !pointsOnly ? durationOf(r) : null };
      });
      let best = -1;
      let tied = false;
      results.forEach((r, i) => {
        if (!r.done) return;
        if (best < 0) { best = i; return; }
        const b = results[best];
        const cmp = r.points !== b.points ? r.points - b.points
          : pointsOnly || r.durationMs === null || b.durationMs === null ? 0 : b.durationMs - r.durationMs;
        if (cmp > 0) { best = i; tied = false; } else if (cmp === 0) tied = true;
      });
      return { event, pointsOnly, results, winner: tied || picked.length < 2 ? -1 : best };
    });
    const wins = picked.map((_, i) => rows.filter(r => r.winner === i).length);
    return { rows, wins };
  }

  // A run's running total: one step each time an event finishes, in the order they finished.
  function raceSteps(data, run) {
    const names = new Map((data.events || []).map(e => [e.eventId, e.name]));
    const limitMs = (Number(run.durationLimitSeconds) || 300) * 1000;
    const done = (run.events || []).filter(e => e.status === 'completed')
      .map(e => ({ eventId: e.eventId, name: names.get(e.eventId) || e.eventId, gained: Number(e.points || 0),
        t: Number.isFinite(e.finishElapsedMs) ? Math.min(e.finishElapsedMs, limitMs) : limitMs }))
      .sort((a, b) => a.t - b.t);
    let total = 0;
    const steps = done.map(s => ({ ...s, total: (total += s.gained) }));
    // Scorecard corrections that aren't tied to an event land at the end of the run.
    const extra = Number(run.totalPoints ?? total) - total;
    if (extra) steps.push({ eventId: null, name: 'Adjustment', gained: extra, t: steps.length ? steps[steps.length - 1].t : limitMs, total: total + extra });
    return { limitMs, steps };
  }

  const median = values => {
    if (!values.length) return null;
    const v = [...values].sort((a, b) => a - b);
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  };

  // How each event played across the standings (official and exhibition runs; playoff
  // reruns would count the same people twice). Events start at different points, so the
  // fair measure is the share of the event's starting points that finishers kept.
  function eventStats(data, guideEvents = []) {
    const guide = new Map(guideEvents.map(g => [nameKey(g.name), g]));
    const runs = comparables(data).filter(c => c.category !== 'playoff');
    return (data.events || []).map(event => {
      const pointsOnly = event.type === 'bonusRound';
      const g = guide.get(nameKey(event.name));
      const start = Number.isFinite(g?.points) && g.points > 0 ? g.points : null;
      const finishes = [];
      let started = 0;
      for (const c of runs) {
        const r = (c.run.events || []).find(e => e.eventId === event.eventId);
        if (!r) continue;
        if (r.status !== 'pending') started++;
        if (r.status === 'completed') finishes.push({ name: c.name, points: Number(r.points || 0), durationMs: pointsOnly ? null : durationOf(r) });
      }
      const timed = finishes.filter(f => f.durationMs !== null).sort((a, b) => a.durationMs - b.durationMs);
      const kept = start ? finishes.map(f => Math.min(f.points / start, 1)) : [];
      return {
        eventId: event.eventId,
        name: event.name,
        slug: g?.slug || null,
        pointsOnly,
        startPoints: start,
        runs: runs.length,
        started,
        finished: finishes.length,
        finishRate: runs.length ? finishes.length / runs.length : null,
        medianMs: median(timed.map(f => f.durationMs)),
        fastest: timed[0] || null,
        avgPoints: finishes.length ? finishes.reduce((s, f) => s + f.points, 0) / finishes.length : null,
        keptShare: kept.length ? kept.reduce((s, k) => s + k, 0) / kept.length : null,
        // Points earned per run as a share of the starting points, counting a run that didn't
        // finish the event as zero: one number for both how often and how well it went.
        scoreShare: start && runs.length ? kept.reduce((s, k) => s + k, 0) / runs.length : null,
      };
    });
  }

  const api = { buildEventBoards, scorecard, formatClock, comparables, compareEvents, raceSteps, eventStats, nameKey };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }

  // ---------- page ----------

  const root = document.querySelector('[data-scoreboard]');
  if (!root) return;
  const base = document.body.dataset.base || './';
  const statusEl = root.querySelector('[data-scoreboard-status]');
  const overallEl = root.querySelector('[data-overall]');
  const eventsEl = root.querySelector('[data-event-boards]');
  const compareEl = root.querySelector('[data-compare]');
  const difficultyEl = root.querySelector('[data-difficulty]');
  let guideEvents = [];
  try { guideEvents = JSON.parse(root.dataset.guideEvents || '[]'); } catch { /* compare by points alone */ }
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

  // ---------- compare players ----------

  const SVG = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs = {}) => {
    const n = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n;
  };
  const MAX_PICKS = 4;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let picks = null;       // run ids being compared, in slot order (slot = color)
  let compareMode = 'points';
  let raceTimer = 0;
  let raceFocus = null;   // the run whose events are labeled on the race chart
  let raceWidth = 0;
  addEventListener('resize', () => {
    if (lastData && picks && Math.abs(compareEl.clientWidth - raceWidth) > 40) renderCompare(lastData);
  });

  // Links like ?compare=abc123,def456 (the end of each run id) open with those players picked.
  const shortId = key => String(key).slice(-6);
  function picksFromUrl(options) {
    const want = (new URLSearchParams(location.search).get('compare') || '').split(',').filter(Boolean);
    return want.map(s => options.find(o => shortId(o.key) === s)?.key).filter(Boolean).slice(0, MAX_PICKS);
  }
  function savePicksToUrl() {
    try {
      const url = new URL(location.href);
      const ids = picks.filter(Boolean).map(shortId);
      if (ids.length) url.searchParams.set('compare', ids.join(',')); else url.searchParams.delete('compare');
      history.replaceState(null, '', url);
    } catch { /* the page still works without a shareable link */ }
  }

  function renderCompare(data) {
    const options = comparables(data);
    if (options.length < 1) {
      compareEl.replaceChildren(el('p', 'sb-empty', 'Comparisons appear once runs are recorded.'));
      return;
    }
    const known = new Set(options.map(o => o.key));
    if (!picks) {
      const fromUrl = picksFromUrl(options);
      // Start with the top two of the standings.
      picks = fromUrl.length ? fromUrl : options.filter(o => o.category === 'official').slice(0, 2).map(o => o.key);
    }
    picks = picks.map(k => (k && known.has(k) ? k : null));
    while (picks.length < MAX_PICKS) picks.push(null);

    const wrap = el('div', 'sb-compare');
    const pickers = el('div', 'sb-pickers');
    picks.forEach((key, slot) => {
      const label = el('label', `sb-picker sb-slot-${slot + 1}`);
      label.append(el('span', 'sb-swatch'), el('span', 'visually-hidden', `Player ${slot + 1}`));
      const select = el('select');
      select.append(new Option(slot < 2 ? 'Pick a player' : 'Add a player', ''));
      for (const o of options) select.append(new Option(o.label, o.key, false, o.key === key));
      select.addEventListener('change', () => {
        picks[slot] = select.value || null;
        savePicksToUrl();
        renderCompare(lastData);
      });
      label.append(select);
      pickers.append(label);
    });
    wrap.append(pickers);

    const slots = picks.map((key, slot) => ({ slot, entry: key ? options.find(o => o.key === key) : null })).filter(s => s.entry);
    if (!slots.length) {
      wrap.append(el('p', 'sb-empty', 'Pick a player above to see their results here.'));
      compareEl.replaceChildren(wrap);
      return;
    }
    const picked = slots.map(s => s.entry);
    const { rows, wins } = compareEvents(data, picked);

    // Who's who: total points and events won against each other.
    const summary = el('ul', 'sb-summary');
    slots.forEach(({ slot, entry }, i) => {
      const li = el('li', `sb-slot-${slot + 1}`);
      li.append(el('span', 'sb-swatch'));
      const text = el('span', 'sb-summary-text');
      text.append(el('span', 'sb-name', entry.label), el('span', 'sb-summary-pts', `${entry.points} pts`));
      if (picked.length > 1) text.append(el('span', 'sb-summary-wins', `${wins[i]} event${wins[i] === 1 ? '' : 's'} won`));
      li.append(text);
      summary.append(li);
    });
    wrap.append(summary);

    // Event by event bars.
    const head = el('div', 'sb-chart-head');
    head.append(el('h3', '', 'Event by event'));
    const toggle = el('div', 'sb-toggle');
    toggle.setAttribute('role', 'group');
    toggle.setAttribute('aria-label', 'Show');
    for (const [mode, text] of [['points', 'Points'], ['time', 'Time']]) {
      const b = el('button', '', text);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(compareMode === mode));
      b.addEventListener('click', () => { compareMode = mode; renderCompare(lastData); });
      toggle.append(b);
    }
    head.append(toggle);
    wrap.append(head);
    wrap.append(el('p', 'sb-help', compareMode === 'points'
      ? 'Bars share one scale, so events worth more points have longer bars. Bold marks the best result.'
      : 'Time to finish each event; shorter is faster. Bold marks the best result.'));

    const maxPoints = Math.max(1, ...rows.flatMap(r => r.results.map(x => x.points || 0)));
    const maxTime = Math.max(1, ...rows.flatMap(r => r.results.map(x => x.durationMs || 0)));
    const list = el('div', 'sb-bars');
    for (const row of rows) {
      if (compareMode === 'time' && row.pointsOnly) continue;
      const group = el('div', 'sb-bar-group');
      group.append(el('div', 'sb-bar-event', row.event.name));
      row.results.forEach((r, i) => {
        const line = el('div', `sb-bar-row sb-slot-${slots[i].slot + 1}${row.winner === i ? ' sb-best' : ''}`);
        const value = compareMode === 'points' ? r.points : r.durationMs;
        const track = el('div', 'sb-track');
        if (r.done && value !== null) {
          const bar = el('div', 'sb-bar');
          bar.style.width = `${Math.max(1.5, (value / (compareMode === 'points' ? maxPoints : maxTime)) * 100)}%`;
          track.append(bar);
        }
        const text = !r.done ? 'DNF' : compareMode === 'points' ? `${r.points}` : formatClock(r.durationMs);
        const val = el('span', 'sb-bar-value', text);
        line.title = `${picked[i].label}: ${!r.done ? 'did not finish' : compareMode === 'points' ? `${r.points} pts` : formatClock(r.durationMs)}`;
        line.append(el('span', 'visually-hidden', `${picked[i].label}: `), track, val);
        group.append(line);
      });
      list.append(group);
    }
    wrap.append(list);

    wrap.append(renderRace(data, slots));
    compareEl.replaceChildren(wrap);
  }

  // Running points over the run, one line per player, with a crosshair to read any moment.
  function renderRace(data, slots) {
    cancelAnimationFrame(raceTimer);
    const box = el('div', 'sb-race');
    const head = el('div', 'sb-chart-head');
    head.append(el('h3', '', 'Run race'));
    const play = el('button', 'sb-play', 'Replay');
    play.type = 'button';
    head.append(play);
    box.append(head);
    box.append(el('p', 'sb-help', slots.length > 1
      ? 'Points over each run, a step for every event finished, labeled with the share of that event\'s starting points earned. Tap a name under the chart to label their events instead. Drag across the chart to compare any moment.'
      : 'Points over the run, a step for every event finished, labeled with the share of that event\'s starting points earned. Drag across the chart to read any moment.'));

    const guide = new Map(guideEvents.map(g => [nameKey(g.name), g]));
    const share = st => {
      const g = st.eventId ? guide.get(nameKey(st.name)) : null;
      return Number.isFinite(g?.points) && g.points > 0 ? st.gained / g.points : null;
    };
    const series = slots.map(s => ({ ...s, ...raceSteps(data, s.entry.run) }));
    for (const s of series) for (const st of s.steps) st.share = share(st);
    if (!series.some(s => s.entry.key === raceFocus)) raceFocus = series[0].entry.key;
    const stepText = st => st.share !== null ? `${st.name} ${pct(st.share)}` : `${st.name} +${st.gained}`;
    const limitMs = Math.max(...series.map(s => s.limitMs));
    const top = Math.max(1, ...series.map(s => s.steps.length ? s.steps[s.steps.length - 1].total : 0));
    const yStep = top > 600 ? 200 : top > 250 ? 100 : 50;
    const yMax = Math.ceil(top / yStep) * yStep;
    // Drawn at the size it's shown, so the labels stay readable on a phone.
    const W = Math.round(Math.max(280, Math.min(900, (compareEl.clientWidth || 640) - 30)));
    const H = W < 500 ? 320 : 360, L = 40, R = 10, T = 12, B = 30;
    raceWidth = compareEl.clientWidth;
    const x = t => L + (t / limitMs) * (W - L - R);
    const y = p => T + (1 - p / yMax) * (H - T - B);

    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'sb-race-svg', role: 'img',
      'aria-label': `Running points over the run for ${slots.map(s => s.entry.label).join(', ')}.` });
    const grid = svgEl('g', { class: 'sb-grid' });
    for (let p = 0; p <= yMax; p += yStep) {
      grid.append(svgEl('line', { x1: L, x2: W - R, y1: y(p), y2: y(p) }));
      const t = svgEl('text', { x: L - 6, y: y(p) + 4, 'text-anchor': 'end' });
      t.textContent = p;
      grid.append(t);
    }
    for (let m = 0; m * 60000 <= limitMs; m++) {
      const t = svgEl('text', { x: x(m * 60000), y: H - 8, 'text-anchor': m === 0 ? 'start' : (m + 1) * 60000 > limitMs ? 'end' : 'middle' });
      t.textContent = `${m}:00`;
      grid.append(t);
    }
    svg.append(grid);

    const clipId = `sb-clip-${Math.random().toString(36).slice(2, 8)}`;
    const clipRect = svgEl('rect', { x: 0, y: 0, width: W, height: H });
    const clip = svgEl('clipPath', { id: clipId });
    clip.append(clipRect);
    const defs = svgEl('defs');
    defs.append(clip);
    svg.append(defs);

    // The labeled run is drawn last so it sits on top of the others.
    const lines = svgEl('g', { 'clip-path': `url(#${clipId})` });
    const ordered = [...series].sort((a, b) => (a.entry.key === raceFocus) - (b.entry.key === raceFocus));
    for (const s of ordered) {
      const focused = s.entry.key === raceFocus;
      let d = `M${x(0)},${y(0)}`;
      for (const st of s.steps) d += `H${x(st.t)}V${y(st.total)}`;
      const g = svgEl('g', { class: `sb-slot-${s.slot + 1}${focused ? ' sb-race-focus' : series.length > 1 ? ' sb-race-dim' : ''}` });
      g.append(svgEl('path', { d, class: 'sb-race-line' }));
      for (const st of s.steps) {
        const c = svgEl('circle', { cx: x(st.t), cy: y(st.total), r: focused ? 5 : 3.5, class: 'sb-race-dot' });
        const tip = svgEl('title');
        tip.textContent = `${s.entry.label}: ${stepText(st)} (+${st.gained}) at ${formatClock(st.t)}, ${st.total} pts total`;
        c.append(tip);
        g.append(c);
      }
      if (focused) g.append(raceLabels(s.steps));
      lines.append(g);
    }
    svg.append(lines);

    // Each event's name and share of its starting points, written upright beside its step:
    // above the line while there's room, below it once the line has climbed. Events that
    // finish close together are nudged apart so their labels don't overlap.
    function raceLabels(steps) {
      const g = svgEl('g', { class: 'sb-race-labels' });
      const GAP = 12;
      const lastX = { above: -Infinity, below: -Infinity };
      const charW = 6.1;
      for (const st of steps) {
        if (!st.eventId) continue;
        const px = x(st.t), py = y(st.total);
        const roomAbove = py - T - 8;
        const roomBelow = (H - B) - py - 10;
        let text = stepText(st);
        const need = text.length * charW;
        let side = roomAbove >= need || roomAbove >= roomBelow ? 'above' : 'below';
        if (px - lastX[side] < GAP) {
          const other = side === 'above' ? 'below' : 'above';
          const otherRoom = other === 'above' ? roomAbove : roomBelow;
          if (px - lastX[other] >= GAP && otherRoom >= Math.min(need, 60)) side = other;
        }
        const lx = Math.max(px, lastX[side] + GAP);
        lastX[side] = lx;
        const room = side === 'above' ? roomAbove : roomBelow;
        if (need > room) {
          // Keep the percentage; shorten the event name to fit.
          const tail = st.share !== null ? ` ${pct(st.share)}` : ` +${st.gained}`;
          const keep = Math.max(0, Math.floor(room / charW) - tail.length - 1);
          text = keep >= 3 ? `${st.name.slice(0, keep).trimEnd()}…${tail}` : tail.trim();
        }
        const ly = side === 'above' ? py - 8 : py + 10;
        const label = svgEl('text', { x: lx + 4, y: ly, transform: `rotate(-90 ${lx + 4} ${ly})`,
          'text-anchor': side === 'above' ? 'start' : 'end', class: 'sb-race-label' });
        label.textContent = text;
        g.append(label);
      }
      return g;
    }

    const cross = svgEl('line', { class: 'sb-cross', y1: T, y2: H - B, x1: 0, x2: 0 });
    cross.style.display = 'none';
    svg.append(cross);
    const frame = el('div', 'sb-race-frame');
    const tip = el('div', 'sb-tip');
    tip.hidden = true;
    frame.append(svg, tip);
    box.append(frame);

    const at = (s, t) => {
      let total = 0;
      let last = null;
      for (const st of s.steps) { if (st.t <= t) { total = st.total; last = st; } }
      return { total, last };
    };
    const show = clientX => {
      const r = svg.getBoundingClientRect();
      const px = ((clientX - r.left) / r.width) * W;
      const t = Math.max(0, Math.min(limitMs, ((px - L) / (W - L - R)) * limitMs));
      cross.setAttribute('x1', x(t));
      cross.setAttribute('x2', x(t));
      cross.style.display = '';
      tip.replaceChildren(el('div', 'sb-tip-time', formatClock(t)));
      const now = series.map(s => ({ s, ...at(s, t) })).sort((a, b) => b.total - a.total);
      for (const n of now) {
        const row = el('div', `sb-tip-row sb-slot-${n.s.slot + 1}`);
        row.append(el('span', 'sb-swatch'), el('span', 'sb-tip-name', n.s.entry.label), el('span', 'sb-tip-pts', String(n.total)));
        tip.append(row);
        if (n.last?.eventId) tip.append(el('div', 'sb-tip-last', `Last: ${stepText(n.last)}`));
      }
      tip.hidden = false;
      const left = (x(t) / W) * r.width;
      tip.style.left = `${left}px`;
      tip.classList.toggle('sb-tip-left', left > r.width / 2);
    };
    const hide = () => { cross.style.display = 'none'; tip.hidden = true; };
    svg.addEventListener('pointermove', e => show(e.clientX));
    svg.addEventListener('pointerdown', e => show(e.clientX));
    svg.addEventListener('pointerleave', hide);

    // Draw the lines left to right, like watching the runs side by side.
    const replay = () => {
      cancelAnimationFrame(raceTimer);
      if (reduceMotion) { clipRect.setAttribute('width', W); return; }
      const started = performance.now();
      const step = now => {
        const f = Math.min(1, (now - started) / 9000);
        clipRect.setAttribute('width', L + f * (W - L - R) + 6);
        if (f < 1) raceTimer = requestAnimationFrame(step); else clipRect.setAttribute('width', W);
      };
      raceTimer = requestAnimationFrame(step);
    };
    play.addEventListener('click', replay);

    // With more than one player, the legend picks whose events are labeled.
    const legend = el('ul', 'sb-legend');
    for (const s of series) {
      const li = el('li', `sb-slot-${s.slot + 1}`);
      if (series.length > 1) {
        const b = el('button', 'sb-legend-btn');
        b.type = 'button';
        b.setAttribute('aria-pressed', String(s.entry.key === raceFocus));
        b.append(el('span', 'sb-swatch'), el('span', '', s.entry.label));
        b.addEventListener('click', () => {
          raceFocus = s.entry.key;
          const old = box;
          old.replaceWith(renderRace(data, slots));
        });
        li.append(b);
      } else li.append(el('span', 'sb-swatch'), el('span', '', s.entry.label));
      legend.append(li);
    }
    box.append(legend);
    return box;
  }

  // ---------- how the events compare ----------

  const DIFFICULTY_SORTS = [
    { key: 'scoreShare', label: 'Score rate', value: s => s.scoreShare, dir: 1 },
    { key: 'finishRate', label: 'Finish rate', value: s => s.finishRate, dir: 1 },
    { key: 'keptShare', label: 'Points kept', value: s => s.keptShare, dir: 1 },
    { key: 'medianMs', label: 'Typical time', value: s => s.medianMs, dir: -1 },
  ];
  let difficultySort = 'scoreShare';
  const pct = v => `${Math.round(v * 100)}%`;

  function renderDifficulty(data) {
    const stats = eventStats(data, guideEvents);
    if (!stats.length || !stats[0].runs) {
      difficultyEl.replaceChildren(el('p', 'sb-empty', 'Event comparisons appear once the first run is recorded.'));
      return;
    }
    const sort = DIFFICULTY_SORTS.find(c => c.key === difficultySort) || DIFFICULTY_SORTS[0];
    // Hardest first; events without the measure (the bonus round) go last.
    const sorted = [...stats].sort((a, b) => {
      const av = sort.value(a), bv = sort.value(b);
      if (av === null || bv === null) return av === bv ? a.name.localeCompare(b.name) : av === null ? 1 : -1;
      return (av - bv) * sort.dir || a.name.localeCompare(b.name);
    });

    const box = el('div', 'sb-difficulty');
    const head = el('div', 'sb-chart-head');
    const label = el('label', 'sb-sort-label');
    label.append(el('span', '', 'Hardest first by '));
    const select = el('select');
    for (const c of DIFFICULTY_SORTS) select.append(new Option(c.label, c.key, false, c.key === sort.key));
    select.addEventListener('change', () => { difficultySort = select.value; renderDifficulty(lastData); });
    label.append(select);
    head.append(label);
    box.append(head);

    const list = el('ol', 'sb-diff-list');
    for (const s of sorted) {
      const li = el('li', 'sb-diff-item');
      const top = el('div', 'sb-diff-top');
      const name = el('span', 'sb-diff-name');
      if (s.slug) {
        const a = el('a', '', s.name);
        a.href = `${base}events/${s.slug}/`;
        name.append(a);
      } else name.append(s.name);
      const main = sort.value(s);
      const mainText = main === null ? (s.avgPoints === null ? '—' : `${Math.round(s.avgPoints)} pts avg`)
        : sort.key === 'medianMs' ? formatClock(main) : pct(main);
      top.append(name, el('span', 'sb-diff-value', mainText));
      li.append(top);
      if (main !== null) {
        const maxTime = Math.max(1, ...stats.map(x => x.medianMs || 0));
        const meter = el('span', 'sb-meter');
        const fill = el('span', 'sb-meter-fill');
        fill.style.width = `${Math.max(1, Math.round((sort.key === 'medianMs' ? main / maxTime : main) * 100))}%`;
        meter.append(fill);
        li.append(meter);
      }
      const facts = [
        s.startPoints ? `Starts at ${s.startPoints}` : s.pointsOnly ? 'Bonus round' : null,
        `${s.finished} of ${s.runs} finished`,
        s.keptShare !== null ? `finishers kept ${pct(s.keptShare)}` : null,
        !s.pointsOnly && s.medianMs !== null ? `typical ${formatClock(s.medianMs)}` : null,
        s.fastest ? `fastest ${formatClock(s.fastest.durationMs)} (${s.fastest.name})` : null,
      ].filter(Boolean);
      li.append(el('p', 'sb-diff-facts', facts.join(' · ')));
      list.append(li);
    }
    box.append(list);
    difficultyEl.replaceChildren(box, el('p', 'sb-help sb-note',
      `From ${stats[0].runs} standings runs (playoffs not counted). Events start at different points, so they're compared as shares of each event's starting points. Score rate is the average points per run as a share of the starting points, with a run that didn't finish counted as zero. Points kept is the same for finishers only (finishing is always worth at least half).`));
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
          compareEl.replaceChildren();
          difficultyEl.replaceChildren();
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
        renderCompare(data);
        renderDifficulty(data);
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
