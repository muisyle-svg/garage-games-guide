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

  // ---------- course map ----------

  // Where each event's name bubble sits on content/images/course.jpg (800 x 800 pixels).
  // If that image changes, update these centers to match.
  const COURSE = {
    image: 'images/course.jpg',
    size: 800,
    radius: 40,
    start: 'Paddle Peril',
    bubbles: [
      ['Four Hand', 79, 122], ['Row Darts III', 295, 130], ['Bocce the Moon', 691, 128],
      ['Measure Up', 608, 216], ['Ring Toss', 471, 292], ['Wall-D', 751, 336],
      ['Paddle Peril', 321, 343], ['Sort & Sweet', 106, 352], ['Chaos Heist', 616, 544],
      ['Top Shelf Shot', 320, 560], ['Hook, Line, and Winner', 119, 572], ['Spice Slide', 436, 620],
      ['Hammer Head', 597, 669],
    ].map(([name, x, y]) => ({ name, key: nameKey(name), x, y })),
  };

  let courseGrid = null;   // grid cells covered by a bubble, shared by every route

  // Small seeded random numbers, so a run's wavy paths look the same every time it's drawn.
  function seededRandom(seedText) {
    let h = 2166136261;
    for (const ch of String(seedText)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    return () => {
      h += 0x6D2B79F5;
      let t = h;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Where a player sits on a bubble (on its rim, along the top, one spot per player) and
  // where their finished/unfinished badge goes (along the bottom rim).
  const SEAT_ANGLES = [-160, -115, -65, -20];
  const BADGE_ANGLES = [150, 110, 70, 30];
  const onRim = (b, deg, r = COURSE.radius) => ({ x: b.x + r * Math.cos(deg * Math.PI / 180), y: b.y + r * Math.sin(deg * Math.PI / 180) });

  // Is every point of a path clear of every bubble (with a margin)?
  function pathClear(points, margin) {
    const lim = COURSE.radius + margin;
    for (const p of points) {
      if (p.x < 6 || p.y < 6 || p.x > COURSE.size - 6 || p.y > COURSE.size - 6) return false;
      for (const b of COURSE.bubbles) if (Math.hypot(p.x - b.x, p.y - b.y) < lim) return false;
    }
    return true;
  }
  const lerpPts = (a, b, step = 4) => {
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    return Array.from({ length: n + 1 }, (_, i) => ({ x: a.x + (b.x - a.x) * i / n, y: a.y + (b.y - a.y) * i / n }));
  };
  const lineClear = (a, b, margin) => pathClear(lerpPts(a, b), margin);

  // A walking route between two points that never crosses a bubble: a grid search around the
  // bubbles (with a little random cost so routes vary), pulled tight, then smoothed into a
  // curve with a gentle random wave. Each step falls back to a plainer route if the fancier
  // one would clip a bubble.
  function planPath(from, to, seed) {
    const rand = seededRandom(seed);
    const CELL = 10, N = Math.ceil(COURSE.size / CELL);
    if (!courseGrid) {
      courseGrid = new Uint8Array(N * N);
      for (let gy = 0; gy < N; gy++) for (let gx = 0; gx < N; gx++) {
        const cx = gx * CELL + CELL / 2, cy = gy * CELL + CELL / 2;
        if (cx < 10 || cy < 10 || cx > COURSE.size - 10 || cy > COURSE.size - 10) courseGrid[gy * N + gx] = 1;
        for (const b of COURSE.bubbles) if (Math.hypot(cx - b.x, cy - b.y) < COURSE.radius + 10) courseGrid[gy * N + gx] = 1;
      }
    }
    const blocked = courseGrid.slice();
    const noise = new Float32Array(N * N);
    for (let i = 0; i < noise.length; i++) noise[i] = rand() * 0.8;
    const cellOf = p => [Math.min(N - 1, Math.max(0, Math.floor(p.x / CELL))), Math.min(N - 1, Math.max(0, Math.floor(p.y / CELL)))];
    const [sx, sy] = cellOf(from), [tx, ty] = cellOf(to);
    const start = sy * N + sx, goal = ty * N + tx;
    blocked[start] = 0; blocked[goal] = 0;
    // A* over 8 neighbours, with a small binary heap for the open set.
    const heap = [];
    const push = (f, i) => {
      heap.push([f, i]);
      let k = heap.length - 1;
      while (k > 0) { const pk = (k - 1) >> 1; if (heap[pk][0] <= heap[k][0]) break; [heap[pk], heap[k]] = [heap[k], heap[pk]]; k = pk; }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let k = 0;
        for (;;) {
          const l = 2 * k + 1, r = l + 1;
          let m = k;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === k) break;
          [heap[m], heap[k]] = [heap[k], heap[m]];
          k = m;
        }
      }
      return top;
    };
    const g = new Float32Array(N * N).fill(Infinity);
    const came = new Int32Array(N * N).fill(-1);
    const closed = new Uint8Array(N * N);
    g[start] = 0;
    const h = i => Math.hypot((i % N) - tx, Math.floor(i / N) - ty);
    push(h(start), start);
    while (heap.length) {
      const [, cur] = pop();
      if (closed[cur]) continue;
      closed[cur] = 1;
      if (cur === goal) break;
      const cx = cur % N, cy = Math.floor(cur / N);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
        const ni = ny * N + nx;
        if (blocked[ni] || closed[ni]) continue;
        const cost = g[cur] + Math.hypot(dx, dy) * (1 + noise[ni]);
        if (cost < g[ni]) { g[ni] = cost; came[ni] = cur; push(cost + h(ni), ni); }
      }
    }
    let route;
    if (came[goal] === -1 && start !== goal) route = [from, to];
    else {
      const cells = [];
      for (let i = goal; i !== -1; i = came[i]) cells.push({ x: (i % N) * CELL + CELL / 2, y: Math.floor(i / N) * CELL + CELL / 2 });
      cells.reverse();
      cells[0] = from; cells[cells.length - 1] = to;
      // Pull the route tight: from each point, jump to the furthest one in plain sight.
      route = [cells[0]];
      let i = 0;
      while (i < cells.length - 1) {
        let j = i + 1;
        while (j + 1 < cells.length && lineClear(cells[i], cells[j + 1], 4)) j++;
        route.push(cells[j]);
        i = j;
      }
    }
    const safe = route.flatMap((p, k) => (k ? lerpPts(route[k - 1], p).slice(1) : [p]));
    // Bend each straight leg through a randomly nudged midpoint, then smooth and add a wave.
    const curvy = amp => {
      const pts = [route[0]];
      for (let k = 1; k < route.length; k++) {
        const a = route[k - 1], b = route[k];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len > 60) {
          const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len, off = (rand() * 2 - 1) * Math.min(40, len * 0.18) * amp;
          pts.push({ x: (a.x + b.x) / 2 + nx * off, y: (a.y + b.y) / 2 + ny * off });
        }
        pts.push(b);
      }
      // Catmull-Rom through the points, sampled every few pixels.
      const out = [];
      for (let k = 0; k < pts.length - 1; k++) {
        const p0 = pts[Math.max(0, k - 1)], p1 = pts[k], p2 = pts[k + 1], p3 = pts[Math.min(pts.length - 1, k + 2)];
        const n = Math.max(2, Math.ceil(Math.hypot(p2.x - p1.x, p2.y - p1.y) / 4));
        for (let s = 0; s < n; s++) {
          const t = s / n, t2 = t * t, t3 = t2 * t;
          out.push({
            x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
            y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
          });
        }
      }
      out.push(pts[pts.length - 1]);
      // A wave across the direction of travel, fading in and out at the ends.
      const waveAmp = (2 + rand() * 5) * amp, waveLen = 45 + rand() * 50, phase = rand() * Math.PI * 2;
      let dist = 0;
      const total = out.reduce((s, p, k) => s + (k ? Math.hypot(p.x - out[k - 1].x, p.y - out[k - 1].y) : 0), 0);
      return out.map((p, k) => {
        if (k) dist += Math.hypot(p.x - out[k - 1].x, p.y - out[k - 1].y);
        const a = out[Math.max(0, k - 1)], b = out[Math.min(out.length - 1, k + 1)];
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const fade = Math.min(1, dist / 30, (total - dist) / 30);
        const w = Math.sin((dist / waveLen) * Math.PI * 2 + phase) * waveAmp * Math.max(0, fade);
        return { x: p.x - (b.y - a.y) / len * w, y: p.y + (b.x - a.x) / len * w };
      });
    };
    for (const amp of [1, 0.5, 0.2]) {
      const pts = curvy(amp);
      if (pathClear(pts.slice(1, -1), 2)) return pts;
    }
    return safe;
  }

  // A run as moves around the course: where the player is at each moment, and each
  // event's state over time. Every button press is a visit: starting an event means the
  // player is there; finishing one means they're there (perhaps having come back to it).
  function courseTimeline(data, run) {
    const names = new Map((data.events || []).map(e => [e.eventId, e]));
    const bubbleFor = new Map(COURSE.bubbles.map(b => [b.key, b]));
    const limitMs = (Number(run.durationLimitSeconds) || 300) * 1000;
    const visits = [];
    let bonus = null;
    const events = [];
    for (const r of run.events || []) {
      const def = names.get(r.eventId);
      if (!def) continue;
      if (def.type === 'bonusRound') { bonus = { name: def.name, result: r }; continue; }
      const bubble = bubbleFor.get(nameKey(def.name));
      if (!bubble) continue;
      const start = Number.isFinite(r.startElapsedMs) ? Math.min(r.startElapsedMs, limitMs) : null;
      const finish = r.status === 'completed' ? (Number.isFinite(r.finishElapsedMs) ? Math.min(r.finishElapsedMs, limitMs) : limitMs) : null;
      events.push({ eventId: r.eventId, name: def.name, bubble, start, finish, points: Number(r.points || 0),
        durationMs: start !== null && finish !== null ? finish - start : null });
      if (start !== null) visits.push({ t: start, bubble, eventId: r.eventId, kind: 'start' });
      if (finish !== null) visits.push({ t: finish, bubble, eventId: r.eventId, kind: 'finish' });
    }
    visits.sort((a, b) => a.t - b.t || (a.kind === 'finish' ? -1 : 1));
    const allDone = events.length > 0 && events.every(e => e.finish !== null) && (!bonus || bonus.result.status === 'completed' || bonus.result.status === 'pending');
    const lastPress = Math.max(0, ...visits.map(v => v.t), bonus && Number.isFinite(bonus.result.finishElapsedMs) ? bonus.result.finishElapsedMs : 0);
    const endMs = allDone ? Math.min(limitMs, lastPress) : limitMs;
    return { visits, events, bonus, endMs, limitMs };
  }

  const api = { planPath, courseTimeline, COURSE, buildEventBoards, scorecard, formatClock, comparables, compareEvents, raceSteps, eventStats, nameKey };
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
  const pinned = new Set();   // race chart callouts tapped open, as "runId|eventId"
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
    wrap.append(renderCourse(data, slots));
    compareEl.replaceChildren(wrap);
  }

  // Running points over the run, one line per player. The chart stays clean: event callouts
  // pop up as each line reaches an event during Replay and then fade, and tapping a dot pins
  // its callout (tap again to hide it). A crosshair reads everyone's total at any moment.
  function renderRace(data, slots) {
    cancelAnimationFrame(raceTimer);
    const box = el('div', 'sb-race');
    const head = el('div', 'sb-chart-head');
    head.append(el('h3', '', 'Run race'));
    const buttons = el('div', 'sb-race-buttons');
    const allBtn = el('button', 'sb-play', 'Clear labels');
    allBtn.type = 'button';
    allBtn.hidden = true;
    const play = el('button', 'sb-play', 'Replay');
    play.type = 'button';
    buttons.append(allBtn, play);
    head.append(buttons);
    box.append(head);
    box.append(el('p', 'sb-help', 'A step for every event finished. Tap a dot to see the event and the share of its starting points earned (tap again to hide). Replay shows each one as it happens.'));

    const guide = new Map(guideEvents.map(g => [nameKey(g.name), g]));
    const share = st => {
      const g = st.eventId ? guide.get(nameKey(st.name)) : null;
      return Number.isFinite(g?.points) && g.points > 0 ? st.gained / g.points : null;
    };
    const series = slots.map(s => ({ ...s, ...raceSteps(data, s.entry.run) }));
    for (const s of series) for (const st of s.steps) { st.share = share(st); st.pin = `${s.entry.key}|${st.eventId}`; }
    const limitMs = Math.max(...series.map(s => s.limitMs));
    const top = Math.max(1, ...series.map(s => s.steps.length ? s.steps[s.steps.length - 1].total : 0));
    const yStep = top > 600 ? 200 : top > 250 ? 100 : 50;
    const yMax = Math.ceil(top / yStep) * yStep;
    // Drawn at the size it's shown, so the text stays readable on a phone.
    const W = Math.round(Math.max(280, Math.min(900, (compareEl.clientWidth || 640) - 30)));
    const H = W < 500 ? 280 : 340, L = 40, R = 10, T = 12, B = 30;
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

    const leaders = svgEl('g', { class: 'sb-leaders' });
    const lines = svgEl('g', { 'clip-path': `url(#${clipId})` });
    const dotsByPin = new Map();
    const targets = [];
    const togglePin = pin => {
      if (pinned.has(pin)) pinned.delete(pin); else pinned.add(pin);
      drawCallouts();
    };
    for (const s of series) {
      let d = `M${x(0)},${y(0)}`;
      for (const st of s.steps) d += `H${x(st.t)}V${y(st.total)}`;
      const g = svgEl('g', { class: `sb-slot-${s.slot + 1}` });
      g.append(svgEl('path', { d, class: 'sb-race-line' }));
      for (const st of s.steps) {
        const dot = svgEl('circle', { cx: x(st.t), cy: y(st.total), r: 4, class: 'sb-race-dot' });
        g.append(dot);
        if (!st.eventId) continue;
        dotsByPin.set(st.pin, dot);
        // Taps go to the nearest dot (see below); this ring is for keyboard users.
        const hit = svgEl('circle', { cx: x(st.t), cy: y(st.total), r: 8, class: 'sb-race-hit', tabindex: 0, role: 'button',
          'aria-label': `${s.entry.label}: ${calloutTitle(st)}. ${pinned.has(st.pin) ? 'Hide' : 'Show'} label.` });
        const toggle = () => togglePin(st.pin);
        targets.push({ px: x(st.t), py: y(st.total), pin: st.pin });
        hit.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
        g.append(hit);
      }
      lines.append(g);
    }
    svg.append(leaders, lines);

    const cross = svgEl('line', { class: 'sb-cross', y1: T, y2: H - B, x1: 0, x2: 0 });
    cross.style.display = 'none';
    svg.append(cross);
    const frame = el('div', 'sb-race-frame');
    const layer = el('div', 'sb-callouts');
    const tip = el('div', 'sb-tip');
    tip.hidden = true;
    frame.append(svg, layer, tip);
    box.append(frame);

    // ----- callouts -----
    const transient = new Map();   // series slot -> the callout Replay is showing for it
    const calloutEls = new Map();  // pin -> callout element on screen
    function calloutTitle(st) { return st.share !== null ? `${st.name} · ${pct(st.share)}` : `${st.name} · +${st.gained}`; }

    // Places every visible callout beside its dot, upright, trying spots above then below
    // (then further out) until it clears the others, and joins it to the dot with a line.
    function drawCallouts() {
      const wanted = [];
      for (const s of series) {
        for (const st of s.steps) if (st.eventId && pinned.has(st.pin)) wanted.push({ s, st, fading: false });
        const tr = transient.get(s.slot);
        if (tr && !pinned.has(tr.st.pin)) wanted.push({ s, st: tr.st, fading: tr.fading, live: true });
      }
      leaders.replaceChildren();
      for (const [pin, dot] of dotsByPin) dot.classList.toggle('sb-race-dot-on', pinned.has(pin));
      allBtn.hidden = !series.some(s => s.steps.some(st => st.eventId && pinned.has(st.pin)));
      // Reuse the callouts already on screen so only new ones pop in.
      const keep = new Set(wanted.map(w => w.st.pin));
      for (const [pin, node] of calloutEls) if (!keep.has(pin)) { node.remove(); calloutEls.delete(pin); }
      if (!wanted.length) return;
      const rect = frame.getBoundingClientRect();
      const scale = (rect.width || W) / W;
      const placed = [];
      const plotTop = 0, plotBottom = (H - B) * scale;
      for (const w of wanted) {
        let c = calloutEls.get(w.st.pin);
        if (!c) {
          c = el('div', `sb-callout sb-slot-${w.s.slot + 1}`);
          c.append(el('span', 'sb-callout-event', calloutTitle(w.st)));
          c.append(el('span', 'sb-callout-meta', `+${w.st.gained} at ${formatClock(w.st.t)}${series.length > 1 && W >= 500 ? ` · ${w.s.entry.name}` : ''}`));
          layer.append(c);
          calloutEls.set(w.st.pin, c);
        }
        c.classList.toggle('sb-callout-fade', w.fading);
        const cw = c.offsetWidth, ch = c.offsetHeight;
        const dx = x(w.st.t) * scale, dy = y(w.st.total) * scale;
        let spot = null;
        // During Replay the lines grow rightward, so callouts lean right, over what's not drawn yet.
        const shifts = w.live ? [0.1, 0, -0.5, -1, 0.5, 1, 1.5] : [0.5, 0.15, 0.85, 0, 1, -0.5, 1.5, -1, 2];
        for (let off = 0; off < 16; off++) {
          for (const dir of [-1, 1]) {
            const top = dir < 0 ? dy - 14 - ch - off * (ch + 6) / 2 : dy + 14 + off * (ch + 6) / 2;
            if (top < plotTop || top + ch > plotBottom + 4) continue;
            for (const shift of shifts) {
              const left = Math.max(0, Math.min((rect.width || W) - cw, dx - cw * shift));
              const box2 = { left, top, right: left + cw, bottom: top + ch };
              if (!placed.some(p => box2.left < p.right + 4 && box2.right > p.left - 4 && box2.top < p.bottom + 4 && box2.bottom > p.top - 4)) {
                spot = box2;
                break;
              }
            }
            if (spot) break;
          }
          if (spot) break;
        }
        if (!spot) {
          const top = Math.max(plotTop, dy - 14 - ch);
          const left = Math.max(0, Math.min((rect.width || W) - cw, dx - cw / 2));
          spot = { left, top, right: left + cw, bottom: top + ch };
        }
        placed.push(spot);
        c.style.left = `${spot.left}px`;
        c.style.top = `${spot.top}px`;
        // Leader line from the dot to the nearest edge of the callout.
        const ex = Math.max(spot.left, Math.min(spot.right, dx));
        const ey = spot.bottom < dy ? spot.bottom : spot.top;
        const line = svgEl('line', { x1: dx / scale, y1: dy / scale, x2: ex / scale, y2: ey / scale,
          class: `sb-leader sb-slot-${w.s.slot + 1}${w.fading ? ' sb-callout-fade' : ''}` });
        leaders.append(line);
      }
    }

    allBtn.addEventListener('click', () => {
      for (const s of series) for (const st of s.steps) pinned.delete(st.pin);
      drawCallouts();
    });

    // ----- crosshair -----
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
        if (n.last?.eventId) tip.append(el('div', 'sb-tip-last', `Last: ${calloutTitle(n.last)}`));
      }
      tip.hidden = false;
      const left = (x(t) / W) * r.width;
      tip.style.left = `${left}px`;
      tip.classList.toggle('sb-tip-left', left > r.width / 2);
    };
    const hide = () => { cross.style.display = 'none'; tip.hidden = true; };
    // The dot nearest the pointer, if it's close enough to mean that dot (dots can sit
    // closer together than a fingertip, so this beats per-dot hit areas).
    const nearestDot = e => {
      const r = svg.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * W;
      const py = ((e.clientY - r.top) / r.height) * H;
      const reach = (e.pointerType === 'mouse' ? 9 : 16) * (W / r.width);
      let best = null, bestD = reach;
      for (const tg of targets) {
        const d = Math.hypot(tg.px - px, tg.py - py);
        if (d <= bestD) { best = tg; bestD = d; }
      }
      return best;
    };
    svg.addEventListener('pointermove', e => {
      const near = nearestDot(e);
      svg.style.cursor = near ? 'pointer' : '';
      if (e.pointerType === 'mouse') { if (near) hide(); else show(e.clientX); }
      else if (!near) show(e.clientX);
    });
    svg.addEventListener('pointerdown', e => { if (!nearestDot(e)) show(e.clientX); });
    svg.addEventListener('click', e => {
      const near = nearestDot(e);
      if (near) { hide(); togglePin(near.pin); }
    });
    svg.addEventListener('pointerleave', hide);

    // ----- replay -----
    // Draws the lines left to right; as each line reaches an event its callout pops up and
    // fades, one per player at a time.
    const REPLAY_MS = 20000;
    const HOLD_MS = 1600;
    let playing = false;
    const shown = new Map();   // series slot -> the last step Replay popped up
    const stop = () => {
      cancelAnimationFrame(raceTimer);
      playing = false;
      play.textContent = 'Replay';
      clipRect.setAttribute('width', W);
      transient.clear();
      drawCallouts();
    };
    const replay = () => {
      if (playing) { stop(); return; }
      cancelAnimationFrame(raceTimer);
      transient.clear();
      shown.clear();
      if (reduceMotion) { clipRect.setAttribute('width', W); return; }
      playing = true;
      play.textContent = 'Stop';
      const started = performance.now();
      const step = now => {
        if (!box.isConnected) { cancelAnimationFrame(raceTimer); return; }
        const elapsed = now - started;
        const f = Math.min(1, elapsed / REPLAY_MS);
        const t = f * limitMs;
        clipRect.setAttribute('width', x(t) + 6);
        let changed = false;
        for (const s of series) {
          const reached = s.steps.filter(st => st.eventId && st.t <= t);
          const latest = reached[reached.length - 1];
          const cur = transient.get(s.slot);
          // Pop each event once: after its callout fades, wait for the player's next event.
          if (latest && shown.get(s.slot) !== latest) {
            shown.set(s.slot, latest);
            transient.set(s.slot, { st: latest, shownAt: elapsed, fading: false });
            changed = true;
          } else if (cur && !cur.fading && elapsed - cur.shownAt > HOLD_MS) { cur.fading = true; changed = true; }
          else if (cur && cur.fading && elapsed - cur.shownAt > HOLD_MS + 500) { transient.delete(s.slot); changed = true; }
        }
        if (changed) drawCallouts();
        if (f < 1 || transient.size) raceTimer = requestAnimationFrame(step); else stop();
      };
      raceTimer = requestAnimationFrame(step);
    };
    play.addEventListener('click', replay);

    const legend = el('ul', 'sb-legend');
    for (const s of series) {
      const li = el('li', `sb-slot-${s.slot + 1}`);
      li.append(el('span', 'sb-swatch'), el('span', '', s.entry.label));
      legend.append(li);
    }
    box.append(legend);
    // Callouts need the chart's on-screen size, so draw them once it's in the page.
    requestAnimationFrame(drawCallouts);
    return box;
  }

  // ---------- on the course ----------

  // Plays the picked runs on the course map: each player is a dot that walks from event to
  // event, with popups for results, badges for finished and unfinished events, and optional
  // trails. Everything shown is worked out from the run time, so the slider can jump around.
  const course = { t: 0, playing: false, speed: 10, trails: false };
  let courseTimer = 0;
  const coursePaths = new Map();   // "runId|segment" -> route, so routes stay put on redraw
  const WALK_MS_PER_PX = 12;
  // On-screen sizes (pixels) of the player dots and the finished/unfinished badges.
  const DOT_PX = { wide: 52, narrow: 30 }, BADGE_PX = { wide: 14, narrow: 9 };
  let courseSeat = 30;             // how far outside a bubble's rim players wait, in map units       // run time to walk one map pixel (about 4 s across the garage)

  function buildCourseRun(data, slot, index, entry) {
    const tl = courseTimeline(data, entry.run);
    const startBubble = COURSE.bubbles.find(b => b.key === nameKey(COURSE.start)) || COURSE.bubbles[0];
    const seatDeg = SEAT_ANGLES[index % SEAT_ANGLES.length];
    // Players wait just outside the bubble's rim, so their big dots don't cover the name.
    const seat = b => onRim(b, seatDeg, COURSE.radius + courseSeat);
    const segments = [];
    let at = startBubble, prevT = 0;
    tl.visits.forEach((v, i) => {
      if (v.bubble !== at) {
        const key = `${entry.key}|${i}|${courseSeat}`;
        if (!coursePaths.has(key)) {
          const a = onRim(at, seatDeg, COURSE.radius + courseSeat + 8), b = onRim(v.bubble, seatDeg, COURSE.radius + courseSeat + 8);
          coursePaths.set(key, [seat(at), ...planPath(a, b, key), seat(v.bubble)]);
        }
        const path = coursePaths.get(key);
        const lengths = [0];
        for (let k = 1; k < path.length; k++) lengths.push(lengths[k - 1] + Math.hypot(path[k].x - path[k - 1].x, path[k].y - path[k - 1].y));
        const total = lengths[lengths.length - 1];
        const walk = Math.min(total * WALK_MS_PER_PX, Math.max(0, v.t - prevT) * 0.9);
        segments.push({ from: at, to: v.bubble, depart: v.t - walk, arrive: v.t, path, lengths, total });
        at = v.bubble;
      }
      prevT = v.t;
    });
    // When a player walked away from an event they'd started but not finished.
    for (const e of tl.events) {
      e.leftAt = null;
      if (e.start === null) continue;
      const leave = segments.find(s => s.from === e.bubble && s.depart >= e.start && (e.finish === null || s.depart < e.finish));
      if (leave) e.leftAt = leave.depart;
    }
    return { slot, index, entry, tl, startBubble, segments, seat };
  }

  function positionAt(pr, t) {
    let here = pr.startBubble;
    for (const s of pr.segments) {
      if (t < s.depart) return { ...pr.seat(here), bubble: here, moving: false };
      if (t < s.arrive) {
        const f = s.arrive > s.depart ? (t - s.depart) / (s.arrive - s.depart) : 1;
        const eased = f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2;
        const d = eased * s.total;
        let k = 1;
        while (k < s.lengths.length - 1 && s.lengths[k] < d) k++;
        const a = s.path[k - 1], b = s.path[k], seg = (s.lengths[k] - s.lengths[k - 1]) || 1;
        const u = Math.min(1, Math.max(0, (d - s.lengths[k - 1]) / seg));
        return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, bubble: null, moving: true, seg: s, dist: d };
      }
      here = s.to;
    }
    return { ...pr.seat(here), bubble: here, moving: false };
  }

  // The route walked so far, for the trail.
  function trailAt(pr, t) {
    const pts = [pr.seat(pr.startBubble)];
    for (const s of pr.segments) {
      if (t <= s.depart) break;
      if (t >= s.arrive) { pts.push(...s.path); continue; }
      const pos = positionAt(pr, t);
      for (let k = 0; k < s.path.length && s.lengths[k] <= pos.dist; k++) pts.push(s.path[k]);
      pts.push(pos);
      break;
    }
    return pts;
  }

  function eventState(pr, e, t, pos) {
    if (e.finish !== null && e.finish <= t) return 'done';
    if (e.start !== null && e.start <= t) {
      if (t >= pr.tl.endMs) return 'missed';
      return pos.bubble === e.bubble ? 'active' : 'left';
    }
    return t >= pr.tl.endMs ? 'missed' : null;
  }

  function renderCourse(data, slots) {
    cancelAnimationFrame(courseTimer);
    const box = el('div', 'sb-course');
    const head = el('div', 'sb-chart-head');
    head.append(el('h3', '', 'On the course'));
    const controls = el('div', 'sb-race-buttons');
    const playBtn = el('button', 'sb-play');
    playBtn.type = 'button';
    const speed = el('select', 'sb-speed');
    speed.setAttribute('aria-label', 'Playback speed');
    for (const [v, text] of [[5, '5×'], [10, '10×'], [20, '20×']]) speed.append(new Option(text, v, false, v === course.speed));
    controls.append(speed, playBtn);
    head.append(controls);
    box.append(head);
    box.append(el('p', 'sb-help', 'Each run played on the course map, sped up, so longer stops show which events took a while. Everyone starts at Paddle Peril.'));

    // Players wait just outside the rim, far enough out that their dots clear the bubble.
    const mapWidth = Math.max(200, (compareEl.clientWidth || COURSE.size) - 30);
    const narrow = mapWidth < 520;
    courseSeat = Math.round((narrow ? DOT_PX.narrow : DOT_PX.wide) / 2 / (Math.min(mapWidth, 900) / COURSE.size)) + 2;
    const runs = slots.map(({ slot, entry }, i) => buildCourseRun(data, slot, i, entry));
    const firstNames = runs.map(r => r.entry.name.split(/\s+/)[0]);
    const tagFor = (r, i) => firstNames.filter(n => n === firstNames[i]).length > 1
      ? `${firstNames[i]}${r.entry.category === 'official' ? '' : ` (${(CATEGORY[r.entry.category] || r.entry.category)[0]})`}`
      : firstNames[i];
    const endMs = Math.max(...runs.map(r => r.tl.endMs));
    course.t = Math.min(course.t, endMs);

    const frame = el('div', 'sb-course-frame');
    const img = el('img');
    img.src = `${base}${COURSE.image}`;
    img.alt = 'Overhead map of the course with each event in a bubble';
    const svg = svgEl('svg', { viewBox: `0 0 ${COURSE.size} ${COURSE.size}`, class: 'sb-course-svg', 'aria-hidden': 'true' });
    const trailG = svgEl('g', { class: 'sb-course-trails' });
    const badgeG = svgEl('g');
    const playerG = svgEl('g');
    svg.append(trailG, badgeG, playerG);
    const layer = el('div', 'sb-callouts');
    frame.append(img, svg, layer);
    box.append(frame);

    const bar = el('div', 'sb-course-bar');
    const scrub = el('input');
    scrub.type = 'range';
    scrub.min = 0; scrub.max = endMs; scrub.step = 100;
    scrub.setAttribute('aria-label', 'Run time');
    const clock = el('span', 'sb-course-clock');
    const trailsLabel = el('label', 'sb-course-trails-toggle');
    const trailsBox = el('input');
    trailsBox.type = 'checkbox';
    trailsBox.checked = course.trails;
    trailsLabel.append(trailsBox, ' Trails');
    bar.append(scrub, clock, trailsLabel);
    box.append(bar);

    const key = el('ul', 'sb-course-key');
    runs.forEach((r, i) => {
      const li = el('li', `sb-slot-${r.slot + 1}`);
      li.append(el('span', 'sb-swatch sb-swatch-dot'), el('span', '', r.entry.label));
      key.append(li);
    });
    for (const [cls, text] of [['done', 'Finished'], ['left', 'Left before finishing'], ['missed', 'Not finished']]) {
      const li = el('li', 'sb-course-key-badge');
      const s = svgEl('svg', { viewBox: '-10 -10 20 20', width: 16, height: 16, 'aria-hidden': 'true' });
      s.append(badgeShape(cls, 8));
      li.append(s, el('span', '', text));
      key.append(li);
    }
    box.append(key);

    // Sizes in map units that come out the same on screen whatever the map's width.
    let k = 1;
    const px = n => n / k;

    function badgeShape(state, r) {
      const g = svgEl('g', { class: `sb-badge-${state}` });
      g.style.setProperty('--badge-stroke', `${r * 0.2}px`);
      g.style.setProperty('--badge-mark', `${r * 0.27}px`);
      g.append(svgEl('circle', { r, class: 'sb-badge-ring' }));
      const s = r * 0.5;
      if (state === 'done') g.append(svgEl('path', { d: `M${-s},0 L${-s * 0.25},${s * 0.75} L${s},${-s * 0.7}`, class: 'sb-badge-mark' }));
      else if (state === 'missed') g.append(svgEl('path', { d: `M${-s},${-s} L${s},${s} M${s},${-s} L${-s},${s}`, class: 'sb-badge-mark' }));
      else if (state === 'left') g.append(svgEl('path', { d: `M${-s * 0.4},${-s} V${s} M${s * 0.4},${-s} V${s}`, class: 'sb-badge-mark' }));
      else g.append(svgEl('circle', { r: r * 0.3, class: 'sb-badge-pip' }));
      return g;
    }

    const badgeEls = new Map();
    const popupEls = new Map();
    const floatEls = new Map();
    const dots = runs.map((r, i) => {
      const g = svgEl('g', { class: `sb-course-player sb-slot-${r.slot + 1}` });
      const dot = svgEl('circle', { class: 'sb-course-dot' });
      const initial = svgEl('text', { class: 'sb-course-initial', 'text-anchor': 'middle' });
      initial.textContent = (r.entry.name.trim()[0] || '?').toUpperCase();
      const tag = svgEl('text', { class: 'sb-course-tag', 'text-anchor': 'middle' });
      tag.textContent = tagFor(r, i);
      g.append(dot, initial, tag);
      playerG.append(g);
      return { g, dot, initial, tag };
    });
    const trails = runs.map(r => {
      const pl = svgEl('polyline', { class: `sb-course-trail sb-slot-${r.slot + 1}` });
      trailG.append(pl);
      return pl;
    });

    // What pops up at time t. Results float up from the event as big "+45 / 12s" text in
    // the player's color and fade; once a run is over, only its final score shows.
    const shortTime = ms => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))}s` : formatClock(ms));
    function popupsAt(t) {
      const hold = 1600 * course.speed;
      const cards = [], floats = [];
      runs.forEach((r, i) => {
        const doneAt = Math.min(r.tl.endMs + 1200 * course.speed, endMs);
        if (t >= doneAt) {
          const done = r.tl.events.filter(e => e.finish !== null).length;
          cards.push({ id: `${r.entry.key}|end`, r, title: `${runs.length > 1 ? `${tagFor(r, i)}: ` : ''}${r.entry.run.totalPoints ?? ''} pts`,
            meta: `${done} of ${r.tl.events.length} events finished` });
          return;
        }
        const spread = (i - (runs.length - 1) / 2) * 40;
        const float = (id, t0, at, big, small) => {
          if (t < t0 || t >= t0 + hold) return;
          floats.push({ id: `${r.entry.key}|${id}`, r, x: at.x, y: at.y, big, small, age: (t - t0) / hold });
        };
        for (const e of r.tl.events) {
          const over = { x: e.bubble.x + spread, y: e.bubble.y - COURSE.radius * 0.2 };
          if (e.finish !== null) float(`${e.eventId}|f`, e.finish, over, `+${e.points}`, e.durationMs !== null ? shortTime(e.durationMs) : '');
          if (e.leftAt !== null) float(`${e.eventId}|l`, e.leftAt, over, 'left', shortTime(e.leftAt - e.start));
        }
        const bonus = r.tl.bonus?.result;
        if (bonus?.status === 'completed' && Number.isFinite(bonus.finishElapsedMs)) {
          float('bonus', bonus.finishElapsedMs, positionAt(r, bonus.finishElapsedMs), `+${bonus.points}`, 'bonus');
        }
      });
      return { cards, floats };
    }

    function draw() {
      const t = course.t;
      const rect = frame.getBoundingClientRect();
      k = (rect.width || COURSE.size) / COURSE.size;
      const positions = runs.map(r => positionAt(r, t));
      const compactMap = (rect.width || COURSE.size) < 520;

      // Badges along the bottom rim of each bubble, one spot per player.
      runs.forEach((r, i) => {
        for (const e of r.tl.events) {
          const state = eventState(r, e, t, positions[i]);
          const id = `${r.entry.key}|${e.eventId}`;
          const cur = badgeEls.get(id);
          if (cur?.state === state) continue;
          cur?.node.remove();
          badgeEls.delete(id);
          if (!state) continue;
          // Badges straddle the lower rim, sitting mostly outside so the event name stays readable.
          const p = onRim(e.bubble, BADGE_ANGLES[i % BADGE_ANGLES.length], COURSE.radius + px(compactMap ? BADGE_PX.narrow : BADGE_PX.wide) * 0.6);
          const node = svgEl('g', { class: `sb-slot-${r.slot + 1}`, transform: `translate(${p.x} ${p.y})` });
          node.append(badgeShape(state, px(compactMap ? BADGE_PX.narrow : BADGE_PX.wide)));
          badgeG.append(node);
          badgeEls.set(id, { state, node });
        }
      });

      // Players: a big dot with their initial, and their name beside it.
      runs.forEach((r, i) => {
        const p = positions[i];
        const d = dots[i];
        d.dot.setAttribute('cx', p.x); d.dot.setAttribute('cy', p.y); const dotR = (compactMap ? DOT_PX.narrow : DOT_PX.wide) / 2;
        d.dot.setAttribute('r', px(dotR));
        d.dot.style.strokeWidth = px(compactMap ? 3 : 4);
        d.initial.setAttribute('x', p.x); d.initial.setAttribute('y', p.y + px(dotR * 0.38));
        d.initial.style.fontSize = `${px(dotR * 1.1)}px`;
        // The name sits outward from the bubble, so players sharing a bubble don't overlap,
        // and is kept inside the map.
        const deg = SEAT_ANGLES[i % SEAT_ANGLES.length] * Math.PI / 180;
        const ux = p.moving ? 0 : Math.cos(deg), uy = p.moving ? -1 : Math.sin(deg);
        const anchor = ux < -0.3 ? 'end' : ux > 0.3 ? 'start' : 'middle';
        const width = px(d.tag.textContent.length * (compactMap ? 7.2 : 9.6));
        const gap = dotR + 6;
        let tx = p.x + ux * px(gap), ty = p.y + uy * px(gap) + (uy > -0.5 ? px(5) : 0);
        const left = anchor === 'end' ? tx - width : anchor === 'middle' ? tx - width / 2 : tx;
        if (left < 4) tx += 4 - left;
        if (left + width > COURSE.size - 4) tx -= left + width - (COURSE.size - 4);
        d.tag.setAttribute('text-anchor', anchor);
        d.tag.setAttribute('x', tx); d.tag.setAttribute('y', ty);
        d.tag.style.fontSize = `${px(compactMap ? 12 : 16)}px`;
        d.tag.style.strokeWidth = `${px(4)}px`;
      });

      // Trails.
      runs.forEach((r, i) => {
        const pl = trails[i];
        pl.style.display = course.trails ? '' : 'none';
        pl.style.strokeWidth = px(2.5);
        if (course.trails) pl.setAttribute('points', trailAt(r, t).map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
      });

      // Popups beside the event (or the player), placed so they don't cover each other.
      const { cards: wanted, floats } = popupsAt(t);

      // Floating results: rise and fade, with no box around them.
      const keepFloat = new Set(floats.map(f => f.id));
      for (const [id, node] of floatEls) if (!keepFloat.has(id)) { node.remove(); floatEls.delete(id); }
      const floatBoxes = [];
      for (const f of floats) {
        let n = floatEls.get(f.id);
        if (!n) {
          n = el('div', `sb-float sb-slot-${f.r.slot + 1}${compactMap ? ' sb-float-small' : ''}`);
          n.append(el('span', 'sb-float-big', f.big));
          if (f.small) n.append(el('span', 'sb-float-sub', f.small));
          layer.append(n);
          floatEls.set(f.id, n);
        }
        const rise = f.age * (compactMap ? 22 : 40);
        const scale = f.age < 0.08 ? 0.6 + f.age * 5 : 1;
        // Kept inside the map, and stacked upward if another result is already there.
        const fw = n.offsetWidth, fh = n.offsetHeight;
        const FW = rect.width || COURSE.size;
        const FH = rect.height || COURSE.size;
        const baseX = f.x * k, baseY = f.y * k - rise;
        const fits = (x, y) => x - fw / 2 >= 0 && x + fw / 2 <= FW && y - fh >= 0 && y <= FH &&
          !floatBoxes.some(o => x - fw / 2 < o.right && x + fw / 2 > o.left && y - fh < o.bottom && y > o.top);
        let cx = Math.max(fw / 2 + 2, Math.min(FW - fw / 2 - 2, baseX)), bottom = Math.max(fh + 2, baseY);
        for (const [dx, dy] of [[0, 0], [0, -1], [1, 0], [-1, 0], [0, 1], [1, 1], [-1, 1], [2, 0], [-2, 0], [0, 2]]) {
          const x = Math.max(fw / 2 + 2, Math.min(FW - fw / 2 - 2, baseX + dx * (fw + 4)));
          const y = Math.max(fh + 2, baseY + dy * (fh + 2));
          if (fits(x, y)) { cx = x; bottom = y; break; }
        }
        floatBoxes.push({ left: cx - fw / 2, right: cx + fw / 2, top: bottom - fh, bottom });
        n.style.left = `${cx}px`;
        n.style.top = `${bottom}px`;
        n.style.opacity = String(f.age < 0.6 ? 1 : Math.max(0, 1 - (f.age - 0.6) / 0.4));
        n.style.transform = `translate(-50%, -100%) scale(${scale})`;
      }
      const W0 = rect.width || COURSE.size;
      const keep = new Set(wanted.map(w => `${w.id}|${W0 < 520 ? 'c' : 'f'}`));
      for (const [id, node] of popupEls) if (!keep.has(id)) { node.remove(); popupEls.delete(id); }
      // Popups steer clear of the player dots as well as each other.
      const dotHalf = (compactMap ? DOT_PX.narrow : DOT_PX.wide) / 2;
      const placed = positions.map(p => ({ left: p.x * k - dotHalf, top: p.y * k - dotHalf, right: p.x * k + dotHalf, bottom: p.y * k + dotHalf }));
      const W = rect.width || COURSE.size, H = rect.height || COURSE.size;
      // On a phone the popups shrink to one short line so they don't bury the map.
      const compact = W < 520;
      for (const w of wanted) {
        const id = `${w.id}|${compact ? 'c' : 'f'}`;
        w.id = id;
        let c = popupEls.get(id);
        if (!c) {
          c = el('div', `sb-callout sb-slot-${w.r.slot + 1}${compact ? ' sb-callout-compact' : ''}`);
          if (compact) c.append(el('span', 'sb-callout-event', w.short ? `${w.title} ${w.short}` : w.title));
          else c.append(el('span', 'sb-callout-event', w.title), el('span', 'sb-callout-meta', w.meta));
          layer.append(c);
          popupEls.set(id, c);
        }
        c.classList.toggle('sb-callout-fade', !!w.fade);
        const cw = c.offsetWidth, ch = c.offsetHeight;
        const anchor = w.anchor || positions[runs.indexOf(w.r)];
        const ax = anchor.x * k, ay = anchor.y * k, gap = w.anchor ? (COURSE.radius + 6) * k : (compactMap ? DOT_PX.narrow : DOT_PX.wide) / 2 + 6;
        let spot = null;
        for (let off = 0; off < 12 && !spot; off++) {
          for (const [dx, dy] of [[0, -1], [0, 1], [1, 0], [-1, 0]]) {
            const step = off * (ch + 4);
            let left = dx > 0 ? ax + gap + (dy ? 0 : 0) : dx < 0 ? ax - gap - cw : ax - cw / 2;
            let top = dy < 0 ? ay - gap - ch - step : dy > 0 ? ay + gap + step : ay - ch / 2 + (off % 2 ? 1 : -1) * Math.ceil(off / 2) * (ch + 4);
            left = Math.max(0, Math.min(W - cw, left));
            if (top < 0 || top + ch > H) continue;
            const b = { left, top, right: left + cw, bottom: top + ch };
            if (!placed.some(p => b.left < p.right + 3 && b.right > p.left - 3 && b.top < p.bottom + 3 && b.bottom > p.top - 3)) { spot = b; break; }
          }
        }
        if (!spot) {
          const left = Math.max(0, Math.min(W - cw, ax - cw / 2)), top = Math.max(0, Math.min(H - ch, ay - gap - ch));
          spot = { left, top, right: left + cw, bottom: top + ch };
        }
        placed.push(spot);
        c.style.left = `${spot.left}px`;
        c.style.top = `${spot.top}px`;
      }

      scrub.value = String(Math.round(t));
      clock.textContent = `${formatClock(t)} / ${formatClock(endMs)}`;
      playBtn.textContent = course.playing ? 'Pause' : t >= endMs ? 'Replay' : t > 0 ? 'Play' : 'Play';
    }

    let lastFrame = 0;
    const tick = now => {
      if (!box.isConnected) { course.playing = false; return; }
      const dt = lastFrame ? now - lastFrame : 0;
      lastFrame = now;
      course.t = Math.min(endMs, course.t + dt * course.speed);
      if (course.t >= endMs) course.playing = false;
      draw();
      if (course.playing) courseTimer = requestAnimationFrame(tick);
    };
    const start = () => {
      if (course.t >= endMs) course.t = 0;
      course.playing = true;
      lastFrame = 0;
      cancelAnimationFrame(courseTimer);
      courseTimer = requestAnimationFrame(tick);
    };
    const pause = () => { course.playing = false; cancelAnimationFrame(courseTimer); draw(); };
    playBtn.addEventListener('click', () => (course.playing ? pause() : start()));
    speed.addEventListener('change', () => { course.speed = Number(speed.value) || 10; draw(); });
    scrub.addEventListener('input', () => { course.t = Number(scrub.value) || 0; draw(); });
    trailsBox.addEventListener('change', () => { course.trails = trailsBox.checked; draw(); });
    img.addEventListener('load', draw);
    requestAnimationFrame(() => { draw(); if (course.playing) start(); });
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
