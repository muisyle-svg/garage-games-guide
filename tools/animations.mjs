// Generates the animated event illustrations in content/images/ (one SVG per event).
// Every scene shares the same garage backdrop, palette and yellow stick figure, so the set reads as one style.
// Usage: node tools/animations.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'content', 'images');

const C = {
  wall: '#2b2925', wallLine: '#34312c', floor: '#3a362f', ink: '#1f1d19', yellow: '#f2b705',
  steel: '#9aa1ab', steelDark: '#6c737d', grey: '#4c525a', cream: '#f3e7c9', white: '#f3efe6',
  red: '#c0392b', green: '#2e9d5f', orange: '#e2532d', blue: '#2f6fb5', wood: '#a8743f', woodDark: '#7a5230',
  purple: '#7d5ba6', turf: '#3f6b3a', rubber: '#262422',
};

// ---------- helpers ----------

const pc = p => `${+Math.min(100, Math.max(0, p)).toFixed(2)}%`;
const tr = (x, y, more = '') => `transform:translate(${+x.toFixed(2)}px,${+y.toFixed(2)}px)${more ? ' ' + more : ''}`;
const rot = a => `transform:rotate(${+a.toFixed(2)}deg)`;
const op = v => `opacity:${v}`;

// A CSS animation bound to class `name`. frames: [[percent, declarations], ...]
function kf(name, frames, { timing = 'linear', origin } = {}) {
  const sorted = [...frames].sort((a, b) => a[0] - b[0]);
  const body = sorted.map(([p, v]) => `${pc(p)}{${v}}`).join('');
  return `.${name}{animation-name:${name};animation-timing-function:${timing};${origin ? `transform-origin:${origin};` : ''}}@keyframes ${name}{${body}}`;
}

// Opacity that is `on` inside any of the [start, end) windows, off elsewhere (hard switches).
function windows(name, wins, { on = 1, off = 0 } = {}) {
  const frames = [[0, op(off)]];
  for (const [a, b] of wins) frames.push([a, op(on)], [b, op(off)]);
  frames.push([100, op(off)]);
  return kf(name, frames, { timing: 'steps(1,end)' });
}

function svg({ title, dur, css, body, defs = '' }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400" role="img" aria-labelledby="t">
<title id="t">${title}</title>
<style>
.a{animation-duration:${dur}s;animation-iteration-count:infinite;animation-timing-function:linear}
.stride,.stride2{animation:stride .6s ease-in-out infinite alternate;transform-origin:-2px 245px}
.stride2{animation-delay:-.6s}
@keyframes stride{from{transform:rotate(-16deg)}to{transform:rotate(16deg)}}
.label{font:700 13px system-ui,sans-serif;fill:${C.white}}
${css}
@media (prefers-reduced-motion: reduce){*{animation:none!important}}
</style>
<defs>
<pattern id="hazard" width="24" height="24" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="24" height="24" fill="${C.ink}"/><rect width="12" height="24" fill="${C.yellow}"/></pattern>
${defs}
</defs>
${body}
</svg>
`;
}

// Garage wall, floor and the hazard-stripe edge every scene shares.
function room({ floor = C.floor, floorLeft } = {}) {
  return `<rect width="640" height="400" fill="${C.wall}"/>
<g fill="${C.wallLine}"><rect y="40" width="640" height="2"/><rect y="110" width="640" height="2"/><rect y="180" width="640" height="2"/><rect y="250" width="640" height="2"/></g>
<rect y="340" width="640" height="60" fill="${floor}"/>
${floorLeft ? `<rect y="340" width="${floorLeft.w}" height="60" fill="${floorLeft.fill}"/>` : ''}
<rect y="336" width="640" height="8" fill="url(#hazard)"/>`;
}

// The competitor, drawn facing right with feet at (0, 336). Arms are added by each scene.
function figure({ legs = 'stand', eye = true, goggles = false, offArm = true } = {}) {
  const leg = {
    stand: `<path d="M-2 245 L-18 290 L-24 336"/><path d="M-2 245 L20 288 L26 336"/>`,
    walk: `<g class="stride"><path d="M-2 245 L-6 290 L-4 336"/></g><g class="stride2"><path d="M-2 245 L-6 290 L-4 336"/></g>`,
    kneel: `<path d="M-2 245 L-28 281 L-62 281"/><path d="M-2 245 L36 250 L38 281"/>`, // translate the figure down 55px so knee and foot rest on the floor
  }[legs];
  return `<g stroke="${C.yellow}" stroke-width="11" stroke-linecap="round" stroke-linejoin="round" fill="none">
<path d="M0 160 L-2 245"/>${leg}${offArm ? `<path d="M0 168 L-18 200 L-30 228"/>` : ''}
</g>
<circle cx="2" cy="128" r="20" fill="${C.yellow}"/>
${eye ? `<path d="M14 120 h8" stroke="${C.ink}" stroke-width="3" stroke-linecap="round"/>` : `<path d="M-17 124 a20 20 0 0 1 38 0 a22 14 0 0 0 -38 0" fill="${C.woodDark}"/>`}
${goggles ? `<path d="M-17 124 h38" stroke="${C.ink}" stroke-width="4"/><rect x="8" y="116" width="17" height="11" rx="4" fill="#8fd3f0" stroke="${C.ink}" stroke-width="2"/>` : ''}`;
}

// A straight arm from the shoulder, pointing right before rotation.
const arm = (len = 50, extra = '') =>
  `<path d="M2 150 H${2 + len}" stroke="${C.yellow}" stroke-width="10" stroke-linecap="round" fill="none"/>${extra}`;

// A two-part arm (upper arm + forearm) whose hand follows a path, solved with simple inverse kinematics.
// frames: [[percent, dx, dy], ...] = hand position relative to the shoulder in the figure's own (facing-right) space.
function arm2(name, frames, { L1 = 50, L2 = 50, timing = 'ease-in-out', hand = '' } = {}) {
  const deg = r => (r * 180) / Math.PI;
  let prev = null;
  const solved = frames.map(([p, dx, dy]) => {
    let d = Math.hypot(dx, dy);
    d = Math.min(Math.max(d, Math.abs(L1 - L2) + 0.5), L1 + L2 - 0.5);
    const th = Math.atan2(dy, dx), c = (d * d - L1 * L1 - L2 * L2) / (2 * L1 * L2);
    // Of the two elbow solutions, keep the one with the elbow lower down (more natural).
    const [best] = [1, -1].map(sg => {
      const a2 = sg * Math.acos(Math.max(-1, Math.min(1, c)));
      const a1 = th - Math.atan2(L2 * Math.sin(a2), L1 + L2 * Math.cos(a2));
      return { a1: deg(a1), a2: deg(a2), ey: Math.sin(a1) };
    }).sort((a, b) => b.ey - a.ey);
    if (prev) { // keep angles continuous so the arm never spins the long way round
      while (best.a1 - prev.a1 > 180) best.a1 -= 360;
      while (best.a1 - prev.a1 < -180) best.a1 += 360;
    }
    prev = best;
    return [p, best.a1, best.a2];
  });
  const css = kf(`${name}u`, solved.map(([p, a1]) => [p, rot(a1)]), { timing, origin: '2px 150px' })
    + kf(`${name}f`, solved.map(([p, , a2]) => [p, rot(a2)]), { timing, origin: `${2 + L1}px 150px` });
  const stroke = `stroke="${C.yellow}" stroke-width="10" stroke-linecap="round" fill="none"`;
  const svgArm = `<g class="a ${name}u"><path d="M2 150 H${2 + L1}" ${stroke}/><g class="a ${name}f"><path d="M${2 + L1} 150 H${2 + L1 + L2}" ${stroke}/><circle cx="${2 + L1 + L2}" cy="150" r="7" fill="${C.yellow}"/>${hand}</g></g>`;
  return { css, svg: svgArm };
}

const scenes = {};

// ---------- Four Hand: four forehand throws, one from behind each line, into a disc golf basket ----------
scenes['four-hand'] = () => {
  const dur = 8, spots = [230, 190, 150, 110], basket = 520;
  const colors = [C.orange, C.blue, C.green, C.purple];
  let css = '';
  const walk = [[0, tr(spots[0], 0)]];
  const armF = [];
  spots.forEach((x, i) => {
    const o = i * 25;
    walk.push([o + 19, tr(x, 0)]);
    if (i < 3) walk.push([o + 23, tr(spots[i + 1], 0)]);
    armF.push([o, rot(75)], [o + 3, rot(75)], [o + 8, rot(165)], [o + 11, rot(-5)], [o + 14, rot(-15)], [o + 19, rot(75)]);
  });
  walk.push([96, tr(spots[3], 0)], [100, tr(spots[0], 0)]);
  css += kf('walk', walk, { timing: 'ease-in-out' });
  css += kf('arm', armF, { timing: 'ease-in-out', origin: '2px 150px' });
  css += windows('held', spots.map((_, i) => [i * 25, i * 25 + 11]));
  let discs = '';
  spots.forEach((x, i) => {
    const o = i * 25, sx = x + 54, sy = 148, ex = basket, ey = 214 - 4 * i;
    css += kf(`disc${i}`, [
      [0, tr(sx, sy)], [o + 11, tr(sx, sy)], [o + 14.5, tr((sx + ex) / 2, 104)], [o + 18, tr(ex, ey)], [100, tr(ex, ey)],
    ], { timing: 'linear' });
    css += windows(`discv${i}`, [[o + 11, 97]]);
    discs += `<g class="a discv${i}"><g class="a disc${i}"><ellipse rx="17" ry="5" fill="${colors[i]}"/><ellipse rx="10" ry="2" fill="#fff" opacity=".35"/></g></g>`;
  });
  const lines = spots.map(x => `<rect x="${x + 26}" y="346" width="4" height="50" fill="${C.white}" opacity=".8"/>`).join('');
  const chains = Array.from({ length: 8 }, (_, k) => `<path d="M${485 + k * 10} 150 L${basket} 206" stroke="${C.steel}" stroke-width="2" opacity=".8"/>`).join('');
  return svg({
    title: 'A competitor makes four forehand disc golf throws into a basket, stepping back a line after each one',
    dur, css,
    body: `${room()}${lines}
<rect x="${basket - 3}" y="140" width="6" height="196" fill="${C.steelDark}"/>
<rect x="500" y="330" width="40" height="8" rx="3" fill="${C.steelDark}"/>
<rect x="478" y="140" width="84" height="9" rx="4" fill="${C.steel}"/>${chains}
<path d="M476 206 H564 L555 242 H485 Z" fill="${C.grey}"/>
${discs}
<path d="M476 204 H564 L560 216 H480 Z" fill="${C.steel}" opacity=".9"/>
<g class="a walk">${figure()}<g class="a arm">${arm(50)}<g class="a held"><ellipse cx="56" cy="150" rx="15" ry="5" fill="${C.orange}"/></g></g></g>`,
  });
};

// ---------- Ring Toss: underhand bag throw through a swinging gymnastics ring onto a cornhole board ----------
scenes['ring-toss'] = () => {
  const dur = 4;
  let css = kf('swing', [[0, rot(-5)], [50, rot(5)], [100, rot(-5)]], { timing: 'ease-in-out', origin: '330px 0px' });
  css += kf('arm', [[0, rot(85)], [50, rot(85)], [60, rot(145)], [65, rot(15)], [72, rot(5)], [85, rot(85)], [100, rot(85)]], { timing: 'ease-in-out', origin: '2px 150px' });
  css += windows('held', [[0, 65]]);
  const path = [[65, 158, 168], [68.3, 215, 146], [71.6, 275, 150], [75, 330, 170], [78.3, 395, 205], [81.6, 455, 255], [85, 505, 294], [88, 515, 295]];
  css += kf('bag', [[0, tr(158, 168)], ...path.map(([p, x, y], i) => [p, tr(x, y, `rotate(${i * 50}deg)`)]), [100, tr(515, 295, 'rotate(350deg)')]]);
  css += windows('bagv', [[65, 97]]);
  return svg({
    title: 'A competitor throws a cornhole bag underhand up through a hanging gymnastics ring and onto a cornhole board',
    dur, css,
    body: `${room()}
<rect x="196" y="346" width="5" height="50" fill="${C.white}" opacity=".85"/>
<path d="M420 336 L600 336 L600 282 L420 322 Z" fill="${C.woodDark}"/>
<path d="M420 322 L600 282 L600 288 L420 328 Z" fill="${C.wood}"/>
<ellipse cx="560" cy="292" rx="13" ry="4" fill="${C.ink}"/>
<g class="a bagv"><g class="a bag"><rect x="-12" y="-8" width="24" height="16" rx="5" fill="${C.red}"/><path d="M-8 0 h16" stroke="#fff" stroke-width="1.5" opacity=".4"/></g></g>
<g class="a swing"><path d="M330 0 V144" stroke="${C.cream}" stroke-width="3"/><circle cx="330" cy="170" r="26" fill="none" stroke="#c8a165" stroke-width="8"/></g>
<g transform="translate(110 0)">${figure()}<g class="a arm">${arm(50)}<g class="a held"><rect x="46" y="142" width="20" height="14" rx="4" fill="${C.red}"/></g></g></g>`,
  });
};

// ---------- Row Darts III: dart thrown at a board riding the rower seat as it rolls left to right ----------
scenes['row-darts-iii'] = () => {
  const dur = 4;
  let css = kf('seat', [[0, tr(0, 0)], [50, tr(240, 0)], [80, tr(240, 0)], [100, tr(0, 0)]], { timing: 'linear' });
  css += kf('arm', [[0, rot(-20)], [18, rot(-150)], [25, rot(-15)], [40, rot(12)], [60, rot(-20)], [100, rot(-20)]], { timing: 'ease-in-out', origin: '72px 150px' });
  css += windows('held', [[0, 25]]);
  css += kf('dart', [
    [0, tr(122, 135, 'rotate(-22deg)')], [25, tr(122, 135, 'rotate(-22deg)')], [28.75, tr(189.5, 95, 'rotate(-12deg)')],
    [32.5, tr(257, 82.5, 'rotate(0deg)')], [36.25, tr(324.5, 97.5, 'rotate(12deg)')], [40, tr(392, 140, 'rotate(15deg)')],
    [50, tr(440, 140, 'rotate(15deg)')], [80, tr(440, 140, 'rotate(15deg)')], [100, tr(200, 140, 'rotate(15deg)')],
  ]);
  css += windows('dartv', [[25, 94]]);
  css += windows('whoosh', [[29, 37]], { on: 0.5 });
  const dart = `<path d="M0 0 L-9 -2 L-9 2 Z" fill="#c9ccd1"/><rect x="-26" y="-2.5" width="17" height="5" rx="2" fill="#5a6270"/><rect x="-36" y="-1.5" width="10" height="3" fill="#8a929e"/><path d="M-34 0 L-46 -9 L-50 -9 L-42 0 L-50 9 L-46 9 Z" fill="${C.orange}"/>`;
  return svg({
    title: 'A competitor throws a dart at a dartboard mounted on the sliding seat of a rowing machine as it rolls left to right',
    dur, css, defs: `<symbol id="dart" overflow="visible">${dart}</symbol>`,
    body: `${room()}
<rect x="18" y="340" width="120" height="14" rx="3" fill="#6b3a2e"/>
<rect x="140" y="296" width="420" height="9" rx="4" fill="${C.steel}"/>
<rect x="146" y="300" width="10" height="38" rx="3" fill="${C.steelDark}"/><rect x="128" y="332" width="46" height="8" rx="4" fill="${C.steelDark}"/>
<rect x="466" y="284" width="8" height="14" rx="2" fill="${C.red}"/>
<path d="M522 296 L536 254 L550 258 L540 298 Z" fill="${C.grey}"/>
<circle cx="588" cy="282" r="40" fill="${C.ink}" stroke="${C.grey}" stroke-width="6"/><circle cx="588" cy="282" r="12" fill="${C.grey}"/>
<rect x="566" y="318" width="44" height="22" rx="4" fill="${C.grey}"/>
<path d="M588 244 L566 190" stroke="${C.steelDark}" stroke-width="6" stroke-linecap="round"/>
<rect x="548" y="168" width="34" height="26" rx="4" fill="${C.ink}" stroke="${C.steelDark}" stroke-width="3"/><rect x="553" y="173" width="24" height="16" rx="2" fill="#3f8f6a"/>
<g class="a seat">
<circle cx="186" cy="294" r="5" fill="${C.ink}"/><circle cx="214" cy="294" r="5" fill="${C.ink}"/>
<rect x="176" y="278" width="48" height="13" rx="6" fill="#d8d2c4"/><rect x="196" y="203" width="8" height="77" fill="#8a929e"/>
<g transform="translate(200 145)"><circle r="58" fill="${C.ink}"/><circle r="46" fill="${C.cream}"/><circle r="38" fill="${C.red}"/><circle r="30" fill="${C.cream}"/><circle r="21" fill="${C.green}"/><circle r="13" fill="${C.cream}"/><circle r="6" fill="${C.red}"/>
<path d="M-46 0 H46 M0 -46 V46 M-32.5 -32.5 L32.5 32.5 M-32.5 32.5 L32.5 -32.5" stroke="${C.ink}" stroke-width="1.5" opacity=".55"/></g>
</g>
<path class="a whoosh" d="M130 128 Q 260 60 380 128" fill="none" stroke="${C.white}" stroke-width="2" stroke-dasharray="4 10" stroke-linecap="round" opacity="0"/>
<g transform="translate(70 0)">${figure()}</g>
<g class="a arm"><path d="M72 150 H122" stroke="${C.yellow}" stroke-width="10" stroke-linecap="round"/><use href="#dart" class="a held" transform="translate(134 150)"/></g>
<g class="a dartv"><g class="a dart"><use href="#dart"/></g></g>`,
  });
};

// ---------- Wall-D: a disc on the wall grid lights up and the competitor keys in its coordinates ----------
scenes['wall-d'] = () => {
  const dur = 6, rows = 'ABCD', palette = [C.orange, C.blue, C.green, C.purple, C.red, C.cream, C.yellow];
  const cx = c => 216 + 26.5 * (c - 1), cy = r => 78 + 58 * r;
  let grid = '';
  for (let r = 0; r < 4; r++) {
    grid += `<text class="label" x="200" y="${cy(r) + 5}" text-anchor="middle">${rows[r]}</text>`;
    for (let c = 1; c <= 15; c++) grid += `<circle cx="${cx(c)}" cy="${cy(r)}" r="11" fill="${palette[(r * 7 + c * 3) % palette.length]}"/><circle cx="${cx(c)}" cy="${cy(r)}" r="3.5" fill="${C.ink}" opacity=".25"/>`;
  }
  for (let c = 1; c <= 15; c++) grid += `<text class="label" x="${cx(c)}" y="50" text-anchor="middle" style="font-size:11px">${c}</text>`;
  const keys = [['1', '2', '3', 'A'], ['4', '5', '6', 'B'], ['7', '8', '9', 'C'], ['*', '0', '#', 'D']];
  const kx = c => 70 + 22 * c, ky = r => 142 + 22 * r;
  let pad = `<rect x="56" y="128" width="94" height="92" rx="8" fill="${C.ink}" stroke="${C.grey}" stroke-width="3"/>`;
  keys.forEach((row, r) => row.forEach((k, c) => {
    pad += `<rect x="${kx(c) - 9}" y="${ky(r) - 9}" width="18" height="18" rx="4" fill="${/[A-D]/.test(k) ? C.red : C.grey}"/><text x="${kx(c)}" y="${ky(r) + 4}" text-anchor="middle" style="font:700 11px system-ui,sans-serif;fill:${C.white}">${k}</text>`;
  }));
  const presses = [[3, 0, 22], [1, 1, 36], [0, 3, 50]]; // [col, row, percent] for A, 5, *
  let css = windows('pulse', [[8, 92]]);
  css += kf('ring', [[0, 'transform:scale(1)'], [50, 'transform:scale(1.25)'], [100, 'transform:scale(1)']], { timing: 'ease-in-out', origin: `${cx(5)}px ${cy(0)}px` });
  presses.forEach(([c, r, p], i) => { css += windows(`k${i}`, [[p, p + 4]], { on: 0.85 }); pad += `<rect class="a k${i}" x="${kx(c) - 10}" y="${ky(r) - 10}" width="20" height="20" rx="5" fill="${C.yellow}" opacity="0"/>`; });
  // The competitor stands right of the keypad, facing it (mirrored), so local x runs leftwards.
  const px = 172, local = (x, y) => [px - x - 2, y - 150];
  const rest = [20, 70];
  const hf = [[0, ...rest]];
  presses.forEach(([c, r, p]) => {
    const [hx, hy] = local(kx(c), ky(r));
    hf.push([p - 5, hx - 6, hy - 8], [p, hx, hy], [p + 4, hx - 6, hy - 8]);
  });
  hf.push([62, ...rest], [100, ...rest]);
  const a = arm2('typing', hf, { L1: 58, L2: 58 });
  css += a.css;
  css += windows('find', [[0, 24]]) + windows('t1', [[24, 38]]) + windows('t2', [[38, 52]]) + windows('ok', [[52, 96]]);
  return svg({
    title: 'A disc on the wall grid is highlighted, and the competitor enters its row and column on a keypad',
    dur, css,
    body: `${room()}
<rect x="186" y="30" width="440" height="268" rx="6" fill="#24221f" stroke="${C.wallLine}" stroke-width="3"/>
${grid}
<g class="a pulse"><circle class="a ring" cx="${cx(5)}" cy="${cy(0)}" r="17" fill="none" stroke="${C.yellow}" stroke-width="5"/></g>
<rect x="24" y="24" width="132" height="82" rx="6" fill="${C.ink}" stroke="${C.steelDark}" stroke-width="4"/>
<g class="a find"><text class="label" x="90" y="54" text-anchor="middle">FIND</text><circle cx="90" cy="80" r="12" fill="${palette[(0 * 7 + 5 * 3) % palette.length]}"/></g>
<g style="font:800 24px ui-monospace,monospace;fill:#7ee2a8">
<text class="a t1" x="90" y="74" text-anchor="middle" opacity="0">A</text><text class="a t2" x="90" y="74" text-anchor="middle" opacity="0">A5</text>
</g>
<g class="a ok" opacity="0"><text x="90" y="62" text-anchor="middle" style="font:800 22px ui-monospace,monospace;fill:#7ee2a8">A5 ✓</text><text x="90" y="88" text-anchor="middle" style="font:800 13px system-ui,sans-serif;fill:${C.green}">COMPLETE</text></g>
${pad}
<rect x="97" y="220" width="12" height="118" fill="${C.grey}"/><rect x="84" y="330" width="38" height="8" rx="3" fill="${C.grey}"/>
<g transform="translate(${px} 0) scale(-1 1)">${figure({ offArm: true })}${a.svg}</g>`,
  });
};

// ---------- Measure Up: kneeling by the tape, releasing the lock and locking it with the end between two lines ----------
scenes['measure-up'] = () => {
  const dur = 5, full = 410, stopAt = 346, scale = (stopAt - 150) / full;
  let css = kf('blade', [[0, 'transform:scaleX(1)'], [15, 'transform:scaleX(1)'], [45, `transform:scaleX(${scale.toFixed(3)})`], [80, `transform:scaleX(${scale.toFixed(3)})`], [95, 'transform:scaleX(1)'], [100, 'transform:scaleX(1)']], { timing: 'ease-in', origin: '150px 0px' });
  css += kf('hook', [[0, tr(0, 0)], [15, tr(0, 0)], [45, tr(stopAt - 560, 0)], [80, tr(stopAt - 560, 0)], [95, tr(0, 0)], [100, tr(0, 0)]], { timing: 'ease-in' });
  css += windows('locked', [[45, 80]]);
  // Kneeling competitor behind the tape body; hand hovers over the lock button and presses it twice.
  const ox = 34, oy = 85, local = (x, y) => [x - ox - 2, y - oy - 150];
  const up = local(111, 296), down = local(111, 312);
  const a = arm2('press', [[0, ...up], [12, ...up], [15, ...down], [19, ...up], [42, ...up], [45, ...down], [50, ...up], [100, ...up]], { L1: 58, L2: 58 });
  css += a.css;
  return svg({
    title: 'A kneeling competitor releases a tape measure lock and locks it again when the end stops between two lines on the floor',
    dur, css,
    body: `${room()}
<rect x="574" y="350" width="5" height="46" fill="${C.white}" opacity=".85"/>
<rect x="330" y="350" width="34" height="46" fill="${C.green}" opacity=".25"/>
<rect x="330" y="350" width="4" height="46" fill="${C.white}"/><rect x="360" y="350" width="4" height="46" fill="${C.white}"/>
<g transform="translate(${ox} ${oy})">${figure({ legs: 'kneel', offArm: true })}</g>
<g class="a blade"><rect x="150" y="364" width="${full}" height="7" fill="#e8c547"/><path d="M150 367.5 H560" stroke="${C.ink}" stroke-width="3" stroke-dasharray="1.5 9" opacity=".7"/></g>
<g class="a hook"><rect x="558" y="358" width="6" height="16" rx="1" fill="${C.steelDark}"/></g>
<rect x="76" y="324" width="78" height="52" rx="12" fill="${C.yellow}" stroke="${C.ink}" stroke-width="3"/>
<circle cx="110" cy="350" r="13" fill="${C.ink}" opacity=".85"/><circle cx="110" cy="350" r="5" fill="${C.steelDark}"/>
<rect x="98" y="314" width="26" height="12" rx="3" fill="${C.red}"/>
<g class="a locked"><circle cx="140" cy="334" r="4" fill="${C.green}"/></g>
<g transform="translate(${ox} ${oy})">${a.svg}</g>`,
  });
};

// ---------- Paddle Peril: balancing a paddle on one finger through the squat rack and back ----------
scenes['paddle-peril'] = () => {
  const dur = 8;
  let css = kf('walk', [[0, tr(150, 0)], [6, tr(150, 0)], [44, tr(585, 0)], [50, tr(585, 0)], [88, tr(150, 0)], [100, tr(150, 0)]], { timing: 'ease-in-out' });
  css += kf('flip', [[0, 'transform:scaleX(1)'], [47, 'transform:scaleX(1)'], [47.01, 'transform:scaleX(-1)'], [91, 'transform:scaleX(-1)'], [91.01, 'transform:scaleX(1)'], [100, 'transform:scaleX(1)']], { timing: 'steps(1,end)' });
  css += `.wobble{animation:wobble 1.3s ease-in-out infinite alternate;transform-origin:26px 104px}@keyframes wobble{from{transform:rotate(-5deg)}to{transform:rotate(5deg)}}`;
  return svg({
    title: 'A competitor balances a paddle upright on one finger while walking through a squat rack and back',
    dur, css,
    body: `${room({ floor: C.rubber, floorLeft: { w: 250, fill: C.turf } })}
<rect x="226" y="346" width="5" height="50" fill="${C.white}" opacity=".85"/>
<g fill="${C.grey}"><rect x="400" y="24" width="14" height="314"/><rect x="500" y="24" width="14" height="314"/><rect x="396" y="18" width="122" height="12" rx="3"/>
<rect x="388" y="330" width="38" height="8" rx="3"/><rect x="488" y="330" width="38" height="8" rx="3"/></g>
<g fill="${C.steelDark}"><rect x="414" y="140" width="10" height="8"/><rect x="490" y="140" width="10" height="8"/></g>
<g class="a walk"><g class="a flip">${figure({ legs: 'walk' })}
<path d="M2 150 L22 132 L26 108" stroke="${C.yellow}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
<g class="wobble"><path d="M26 104 V20" stroke="${C.wood}" stroke-width="6" stroke-linecap="round"/><ellipse cx="26" cy="34" rx="10" ry="24" fill="${C.wood}" stroke="${C.woodDark}" stroke-width="2"/></g>
</g></g>`,
  });
};

// ---------- Sort & Sweet: the competitor, behind the table, sorts four of each candy into its own small bowl ----------
scenes['sort-and-sweet'] = () => {
  const dur = 10, table = 250;
  const bowls = [110, 195, 445, 530];
  const candy = [
    c => `<circle r="6" fill="${c}"/><text y="2.5" text-anchor="middle" style="font:700 6px sans-serif;fill:#fff">S</text>`,
    () => `<rect x="-9" y="-4" width="18" height="8" rx="2" fill="#4a2c1d"/><rect x="-3" y="-4" width="6" height="8" fill="#3f8f6a"/>`,
    () => `<rect x="-9" y="-4" width="18" height="8" rx="2" fill="#c99a2e"/><rect x="-9" y="-1" width="18" height="2" fill="${C.red}"/>`,
    c => `<ellipse cy="2" rx="5" ry="6" fill="${c}"/><circle cy="-5" r="4" fill="${c}"/>`,
  ];
  const tint = [C.red, C.purple, C.orange, C.green];
  let seed = 7; const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  let css = '', pieces = '';
  const hand = [[0, 320, 196]]; // [percent, x, y] of the hand in the scene
  let n = 0;
  for (let k = 0; k < 4; k++) for (let t = 0; t < 4; t++) {
    const sx = 262 + rnd() * 116, sy = 194 + rnd() * 12, ex = bowls[t] - 18 + k * 12, ey = 216;
    const s = 4 + n * 5;
    css += kf(`c${n}`, [[0, tr(sx, sy)], [s, tr(sx, sy)], [s + 2, tr((sx + ex) / 2, 160)], [s + 4, tr(ex, ey)], [100, tr(ex, ey)]], { timing: 'ease-in-out' });
    hand.push([s - 1.5, sx, sy - 4], [s, sx, sy - 4], [s + 2, (sx + ex) / 2, 156], [s + 4, ex, ey - 4]);
    pieces += `<g class="a c${n}">${candy[t](tint[(k + t) % 4])}</g>`;
    n++;
  }
  hand.push([90, 320, 196], [100, 320, 196]);
  // The competitor side-steps behind the table to stay just left of the hand.
  const reach = 56;
  css += kf('step', hand.map(([p, x]) => [p, tr(x - reach, 0)]), { timing: 'ease-in-out' });
  const a = arm2('sort', hand.map(([p, , y]) => [p, reach - 2, y - 150]), { L1: 48, L2: 48 });
  css += a.css;
  css += windows('fade', [[0, 96]]);
  let decoys = '';
  for (let d = 0; d < 8; d++) decoys += `<g transform="translate(${(262 + rnd() * 116).toFixed(1)} ${(196 + rnd() * 10).toFixed(1)})">${candy[d % 4](tint[d % 4])}</g>`;
  const smallBowl = x => `<path d="M${x - 34} 222 H${x + 34} Q${x + 30} ${table} ${x} ${table} Q${x - 30} ${table} ${x - 34} 222 Z" fill="${C.cream}" stroke="${C.ink}" stroke-width="2"/>`;
  return svg({
    title: 'Standing behind a table, a competitor sorts candy out of a big bowl into four small bowls, four of the same candy in each',
    dur, css,
    body: `${room()}
<g class="a step">${figure({ legs: 'walk' })}</g>
<rect x="50" y="${table}" width="540" height="12" rx="3" fill="${C.wood}"/>
<rect x="70" y="262" width="12" height="74" fill="${C.woodDark}"/><rect x="558" y="262" width="12" height="74" fill="${C.woodDark}"/>
${decoys}<g class="a fade">${pieces}</g>
<path d="M240 204 H400 Q395 ${table} 320 ${table} Q245 ${table} 240 204 Z" fill="${C.blue}" stroke="${C.ink}" stroke-width="2"/>
${bowls.map(smallBowl).join('')}
<g class="a step">${a.svg}</g>`,
  });
};

// ---------- Spice Slide: sliding a shaker down the bar to stop on the blue tape ----------
scenes['spice-slide'] = () => {
  const dur = 5, top = 230;
  let css = kf('slide', [[0, tr(0, 0)], [15, tr(0, 0)], [55, tr(424, 0)], [100, tr(424, 0)]], { timing: 'cubic-bezier(.2,.75,.35,1)' });
  css += windows('slidev', [[0, 92]]);
  css += kf('arm', [[0, rot(62)], [10, rot(62)], [15, rot(30)], [25, rot(62)], [100, rot(62)]], { timing: 'ease-in-out', origin: '2px 150px' });
  const shaker = (x, body, cap) => `<rect x="${x - 9}" y="${top - 34}" width="18" height="30" rx="5" fill="${body}" stroke="${C.ink}" stroke-width="1.5"/><rect x="${x - 8}" y="${top - 42}" width="16" height="10" rx="4" fill="${cap}"/><rect x="${x - 10}" y="${top - 5}" width="20" height="5" rx="2" fill="${C.ink}" opacity=".5"/>`;
  return svg({
    title: 'A competitor slides a spice shaker down a long bar so it stops in the blue-tape scoring zone',
    dur, css,
    body: `${room()}
<g transform="translate(46 0)">${figure()}<g class="a arm">${arm(72)}</g></g>
<rect x="30" y="${top}" width="590" height="14" rx="3" fill="${C.wood}"/><rect x="40" y="${top + 14}" width="570" height="92" fill="${C.woodDark}"/>
<rect x="490" y="${top - 1}" width="56" height="5" fill="${C.blue}"/><rect x="490" y="${top + 14}" width="56" height="6" fill="${C.blue}"/>
${shaker(150, C.cream, C.steel)}
<g class="a slidev"><g class="a slide">${shaker(94, C.white, C.red)}</g></g>`,
  });
};

// ---------- Hook, Line, and Winner: swinging the ring on its line until it catches the hook ----------
scenes['hook-line-and-winner'] = () => {
  const dur = 5, hold = 55, caught = -60.8;
  let css = kf('ring', [[0, rot(hold)], [20, rot(hold)], [46, rot(caught)], [85, rot(caught)], [100, rot(hold)]], { timing: 'ease-in-out', origin: '400px 20px' });
  css += kf('arm', [[0, rot(-27)], [20, rot(-27)], [26, rot(70)], [86, rot(70)], [100, rot(-27)]], { timing: 'ease-in-out', origin: '2px 150px' });
  css += windows('flash', [[47, 60]]);
  return svg({
    title: 'A competitor lets go of a ring on a string and it swings across to catch on a hook on the wall',
    dur, css,
    body: `${room()}
<rect x="226" y="346" width="5" height="50" fill="${C.white}" opacity=".85"/>
<rect x="380" y="10" width="40" height="10" rx="3" fill="${C.steelDark}"/>
<rect x="546" y="70" width="28" height="70" rx="4" fill="${C.wood}"/>
<path d="M558 96 v14 q0 8 7 8 q6 0 6 -6" fill="none" stroke="${C.steel}" stroke-width="4" stroke-linecap="round"/>
<g class="a flash"><circle cx="565" cy="114" r="24" fill="none" stroke="${C.yellow}" stroke-width="3" stroke-dasharray="4 6"/></g>
<g class="a ring"><path d="M400 20 V197" stroke="${C.cream}" stroke-width="2.5"/><circle cx="400" cy="209" r="12" fill="none" stroke="${C.steel}" stroke-width="4"/></g>
<g transform="translate(200 0)">${figure()}<g class="a arm">${arm(48)}</g></g>`,
  });
};

// ---------- Top Shelf Shot: from behind, ping pong balls tossed up into cups on the top shelf ----------
scenes['top-shelf-shot'] = () => {
  const dur = 6, cups = [210, 265, 320, 375, 430];
  let css = kf('arm', [[0, rot(80)], [6, rot(80)], [11, rot(-60)], [14, rot(-85)], [26, rot(80)], [56, rot(80)], [61, rot(-60)], [64, rot(-85)], [76, rot(80)], [100, rot(80)]], { timing: 'ease-in-out', origin: '2px 150px' });
  css += windows('held', [[0, 14], [40, 64]]);
  css += kf('b1', [[0, tr(326, 140)], [14, tr(326, 140)], [17, tr(330, 82)], [20, tr(334, 74)], [23, tr(338, 94)], [26, tr(362, 78)], [31, tr(410, 150)], [36, tr(440, 260)], [100, tr(440, 260)]]);
  css += windows('b1v', [[14, 36]]);
  css += kf('b2', [[0, tr(326, 140)], [64, tr(326, 140)], [67, tr(346, 72)], [70, tr(364, 62)], [73, tr(375, 88)], [75, tr(375, 108)], [100, tr(375, 108)]]);
  css += windows('b2v', [[64, 76]]);
  css += kf('jiggle', [[0, rot(0)], [74, rot(0)], [76, rot(6)], [78, rot(-5)], [80, rot(3)], [82, rot(0)], [100, rot(0)]], { origin: '375px 120px' });
  css += windows('star', [[76, 92]]);
  const cup = x => `<path d="M${x - 14} 94 H${x + 14} L${x + 10} 120 H${x - 10} Z" fill="${C.red}" stroke="${C.ink}" stroke-width="1.5"/><rect x="${x - 15}" y="92" width="30" height="5" rx="2" fill="${C.white}"/>`;
  const ball = `<circle r="6" fill="${C.white}" stroke="${C.ink}" stroke-width="1"/>`;
  return svg({
    title: 'Seen from behind, a competitor tosses ping pong balls up into cups on the top shelf behind the bar',
    dur, css,
    body: `${room()}
<rect x="170" y="120" width="300" height="9" rx="2" fill="${C.wood}"/><rect x="180" y="129" width="8" height="20" fill="${C.woodDark}"/><rect x="452" y="129" width="8" height="20" fill="${C.woodDark}"/>
<g class="a b1v"><g class="a b1">${ball}</g></g><g class="a b2v"><g class="a b2">${ball}</g></g>
${cups.filter(x => x !== 375).map(cup).join('')}<g class="a jiggle">${cup(375)}</g>
<g class="a star"><path d="M375 70 l4 10 10 1 -8 6 3 10 -9 -6 -9 6 3 -10 -8 -6 10 -1z" fill="${C.yellow}"/></g>
<rect x="40" y="244" width="560" height="10" rx="3" fill="${C.wood}"/><rect x="50" y="254" width="540" height="84" fill="${C.woodDark}"/>
<g transform="translate(320 40)">${figure({ eye: false })}<g class="a arm">${arm(50)}<g class="a held"><circle cx="54" cy="150" r="6" fill="${C.white}"/></g></g></g>`,
  });
};

// ---------- Bocce the Moon: "Shoot the Moon" — guiding a steel ball up the rods from the low far end toward the player ----------
scenes['bocce-the-moon'] = () => {
  const dur = 8;
  // Looking down the board from behind the player: far (low) end at the top of the frame, near (high) end at the bottom.
  const farY = 64, nearY = 300, at = t => farY + (nearY - farY) * t, size = t => 0.5 + 0.7 * t;
  const half = t => 60 + 120 * t; // half-width of the board at depth t
  const holes = [[0.3, '10', C.red], [0.5, '25', C.cream], [0.7, '50', C.blue], [0.9, '100', C.green]];
  let board = `<path d="M${320 - half(0)} ${farY - 8} H${320 + half(0)} L${320 + half(1)} ${nearY + 10} H${320 - half(1)} Z" fill="${C.wood}" stroke="${C.woodDark}" stroke-width="4" stroke-linejoin="round"/>`;
  holes.forEach(([t, label, ring]) => {
    const y = at(t), k = size(t);
    board += `<ellipse cx="320" cy="${y}" rx="${17 * k}" ry="${8 * k}" fill="${ring}"/><ellipse cx="320" cy="${y}" rx="${11 * k}" ry="${5 * k}" fill="${C.ink}"/>`
      + `<text x="${320 + half(t) * 0.55}" y="${y + 6 * k}" text-anchor="middle" style="font:800 ${(20 * k).toFixed(1)}px system-ui,sans-serif;fill:${C.ink}" opacity=".75">${label}</text>`;
  });
  // The rods pivot together at the far end; spreading the handles widens the gap so the ball rolls toward the player.
  const spread = [[0, 0], [6, 0], [12, 3], [17, 0], [22, 0], [28, 3], [33, 0], [38, 0], [44, 3], [49, 0], [54, 0], [60, 3], [65, 0], [70, 0], [74, 6], [90, 6], [95, 0], [100, 0]];
  let css = kf('lrod', spread.map(([p, a]) => [p, rot(a)]), { timing: 'ease-in-out', origin: `316px ${farY - 4}px` });
  css += kf('rrod', spread.map(([p, a]) => [p, rot(-a)]), { timing: 'ease-in-out', origin: `324px ${farY - 4}px` });
  const ts = [[0, 0.04], [6, 0.04], [12, 0.22], [22, 0.22], [28, 0.42], [38, 0.42], [44, 0.62], [54, 0.62], [60, 0.9], [100, 0.9]];
  css += kf('ball', ts.map(([p, t]) => [p, tr(0, at(t), `scale(${size(t).toFixed(3)})`)]), { timing: 'ease-in-out' });
  css += '.ball{transform-box:fill-box;transform-origin:center}';
  css += kf('drop', [[0, op(1)], [72, op(1)], [76, op(0)], [100, op(0)]]);
  css += windows('glow', [[76, 92]]);
  const nearL = 300, nearR = 340; // rod x positions at the handles
  const rod = (x0, x1) => `<path d="M${x0} ${farY - 4} L${x1} ${nearY + 18}" stroke="${C.steel}" stroke-width="5" stroke-linecap="round"/><path d="M${x0} ${farY - 4} L${x1} ${nearY + 18}" stroke="#fff" stroke-width="1.5" opacity=".5"/>`;
  const handle = (x, dx) => `<rect x="${x - 9}" y="${nearY + 14}" width="18" height="40" rx="7" fill="${C.woodDark}" transform="rotate(${dx} ${x} ${nearY + 14})"/>`;
  // The player, seen from behind at the near end: head and shoulders, both hands on the handles.
  const armPath = (hx, sx) => `<path d="M${hx} ${nearY + 40} Q${(hx + sx) / 2 + (sx > 320 ? 14 : -14)} ${nearY + 70} ${sx} 392" stroke="${C.yellow}" stroke-width="12" stroke-linecap="round" fill="none"/><circle cx="${hx}" cy="${nearY + 38}" r="9" fill="${C.yellow}"/>`;
  return svg({
    title: 'Shoot the Moon: a competitor at the raised near end of a wooden board spreads two steel rods so a ball rolls up from the far low end toward them, then drops it into the 100 hole',
    dur, css,
    body: `<rect width="640" height="400" fill="${C.floor}"/>
<rect width="640" height="40" fill="${C.wall}"/><rect y="36" width="640" height="8" fill="url(#hazard)"/>
<g fill="${C.ink}" opacity=".35"><ellipse cx="320" cy="${farY - 2}" rx="80" ry="8"/></g>
<path d="M${320 - half(1) + 18} ${nearY + 10} l-8 90 h16 l4 -90 Z M${320 + half(1) - 18} ${nearY + 10} l8 90 h-16 l-4 -90 Z" fill="${C.woodDark}"/>
${board}
<g class="a glow"><ellipse cx="320" cy="${at(0.9)}" rx="${26 * size(0.9)}" ry="${13 * size(0.9)}" fill="none" stroke="${C.green}" stroke-width="4"/></g>
<g class="a drop"><circle class="a ball" cx="320" cy="0" r="10" fill="${C.steel}" stroke="${C.ink}" stroke-width="1.5"/><circle class="a ball" cx="317" cy="-3" r="2.5" fill="#fff" opacity=".8"/></g>
<rect x="306" y="${farY - 12}" width="28" height="12" rx="3" fill="${C.grey}"/>
<g class="a lrod">${rod(316, nearL)}${handle(nearL, 8)}${armPath(nearL - 2, 270)}</g>
<g class="a rrod">${rod(324, nearR)}${handle(nearR, -8)}${armPath(nearR + 2, 370)}</g>
<path d="M262 400 Q262 372 320 368 Q378 372 378 400 Z" fill="${C.yellow}"/>
<circle cx="320" cy="372" r="24" fill="${C.yellow}"/><path d="M297 368 a23 23 0 0 1 46 0 a26 16 0 0 0 -46 0" fill="${C.woodDark}"/>`,
  });
};

// ---------- Hammer Head: goggles on, nail from the box, hammered flush ----------
scenes['hammer-head'] = () => {
  const dur = 6, top = 232, nx = 340, len = 34;
  let css = kf('reach', [[0, rot(80)], [6, rot(80)], [10, rot(47.8)], [22, rot(30)], [28, rot(80)], [100, rot(80)]], { timing: 'ease-in-out', origin: '2px 150px' });
  const hits = [[40, 31], [52, 35], [64, 40], [76, 45]];
  const hf = [[0, rot(60)], [30, rot(60)]];
  hits.forEach(([p, a]) => hf.push([p - 6, rot(-45)], [p, rot(a)]));
  hf.push([84, rot(60)], [100, rot(60)]);
  css += kf('hammer', hf, { timing: 'ease-in', origin: '2px 150px' });
  const nf = [[0, tr(315, 196)], [10, tr(315, 196)], [22, tr(nx, top - len)]];
  hits.forEach(([p], i) => nf.push([p - 0.5, tr(nx, top - len + (len / 4) * i)], [p + 0.5, tr(nx, top - len + (len / 4) * (i + 1))]));
  nf.push([100, tr(nx, top)]);
  css += kf('nail', nf, { timing: 'linear' });
  css += windows('nailv', [[10, 95]]);
  return svg({
    title: 'A competitor in safety glasses takes a nail from a box and hammers it flush into a plank',
    dur, css,
    defs: `<clipPath id="above"><rect width="640" height="${top + 3}"/></clipPath>`,
    body: `${room()}
<rect x="300" y="${top}" width="220" height="18" rx="2" fill="${C.wood}"/>
<path d="M320 ${top + 18} L306 336 M330 ${top + 18} L344 336 M490 ${top + 18} L476 336 M500 ${top + 18} L514 336" stroke="${C.woodDark}" stroke-width="8"/>
<rect x="300" y="${top - 18}" width="34" height="18" rx="2" fill="${C.grey}"/>
<g stroke="${C.steel}" stroke-width="2"><path d="M306 ${top - 22} v6 M312 ${top - 24} v8 M318 ${top - 21} v6 M325 ${top - 23} v8"/></g>
<g clip-path="url(#above)"><g class="a nailv"><g class="a nail"><rect x="-1.5" y="0" width="3" height="${len}" fill="${C.steel}"/><path d="M-1.5 ${len} L0 ${len + 5} L1.5 ${len} Z" fill="${C.steel}"/><rect x="-6" y="-3" width="12" height="4" rx="1" fill="${C.steelDark}"/></g></g></g>
<g transform="translate(255 0)">${figure({ goggles: true, offArm: false })}
<g class="a reach">${arm(88)}</g>
<g class="a hammer">${arm(60)}<path d="M62 150 H112" stroke="${C.woodDark}" stroke-width="7" stroke-linecap="round"/><rect x="106" y="138" width="14" height="26" rx="2" fill="${C.steelDark}"/></g></g>`,
  });
};

// ---------- Chaos Heist: kneeling at the arcade cabinet feeding in 20 rings ----------
scenes['chaos-heist'] = () => {
  const dur = 8, count = 20;
  const af = [[0, rot(60)]], coin = [], nums = [];
  for (let k = 0; k < count; k++) {
    const s = 4 + k * 4;
    af.push([s, rot(60)], [s + 2, rot(27.6)], [s + 3.2, rot(60)]);
    coin.push([s - 1, s + 2]);
  }
  af.push([100, rot(60)]);
  let css = kf('arm', af, { timing: 'ease-in-out', origin: '2px 150px' });
  css += windows('coin', coin);
  for (let n = 0; n <= count; n++) {
    const a = n === 0 ? 0 : 4 + (n - 1) * 4 + 2, b = n === count ? 100 : 4 + n * 4 + 2;
    css += windows(`n${n}`, [[a, b]]);
    nums.push(`<text class="a n${n}" x="512" y="146" text-anchor="middle" opacity="0">${n}</text>`);
  }
  css += windows('win', [[84, 97]]);
  return svg({
    title: 'A competitor kneels at an arcade cabinet and feeds coin after coin into the coin slot',
    dur, css,
    body: `${room()}
<path d="M440 40 H566 V336 H440 Z" fill="#3b2a5a"/>
<rect x="446" y="46" width="114" height="24" rx="3" fill="${C.ink}"/><text x="503" y="63" text-anchor="middle" style="font:800 13px system-ui,sans-serif;fill:${C.yellow}">CHAOS HEIST</text>
<rect x="452" y="80" width="102" height="86" rx="6" fill="#101418" stroke="${C.grey}" stroke-width="4"/>
<circle cx="475" cy="134" r="12" fill="none" stroke="${C.yellow}" stroke-width="5"/>
<g style="font:800 28px ui-monospace,monospace;fill:${C.white}">${nums.join('')}</g>
<g class="a win"><rect x="456" y="84" width="94" height="78" rx="4" fill="${C.green}"/><text x="503" y="130" text-anchor="middle" style="font:800 20px system-ui,sans-serif;fill:${C.white}">YOU WIN</text></g>
<path d="M434 180 H572 L566 200 H440 Z" fill="${C.grey}"/><path d="M470 184 v-14" stroke="${C.ink}" stroke-width="4"/><circle cx="470" cy="168" r="6" fill="${C.red}"/>
<rect x="450" y="228" width="64" height="72" rx="4" fill="${C.steelDark}"/>
<rect x="458" y="246" width="16" height="7" rx="2" fill="${C.ink}"/><rect x="488" y="246" width="16" height="7" rx="2" fill="${C.ink}"/>
<rect x="470" y="276" width="24" height="12" rx="2" fill="${C.ink}"/>
<path d="M404 336 L408 314 H436 L440 336 Z" fill="${C.grey}"/>${[412, 420, 428].map(x => `<circle cx="${x}" cy="316" r="5" fill="${C.yellow}" stroke="${C.ink}" stroke-width="1"/>`).join('')}
<g transform="translate(374 55)">${figure({ legs: 'kneel', offArm: false })}<g class="a arm">${arm(100)}<g class="a coin"><circle cx="104" cy="150" r="6" fill="${C.yellow}" stroke="${C.ink}" stroke-width="1.5"/></g></g></g>`,
  });
};

// ---------- Sonic Dash: running to whichever wall button is blinking and hitting it ----------
scenes['sonic-dash'] = () => {
  const dur = 8, xs = [90, 250, 410, 570], order = [2, 0, 3, 1], y = 210;
  let css = '', at = 320, facing = 1;
  const walk = [[0, tr(at, 0)]], flip = [], armF = [[0, rot(85)]];
  const lights = xs.map(() => []);
  order.forEach((b, k) => {
    const o = k * 25, target = xs[b];
    const dir = target > at ? 1 : -1;
    const stand = target - dir * 24;
    flip.push([o, `transform:scaleX(${dir})`]);
    walk.push([o + 2, tr(at, 0)], [o + 12, tr(stand, 0)]);
    armF.push([o + 12, rot(85)], [o + 15, rot(60)], [o + 19, rot(85)]);
    lights[b].push([o, o + 15]);
    at = stand; facing = dir;
  });
  walk.push([100, tr(320, 0)]);
  flip.push([100, `transform:scaleX(${facing})`]);
  css += kf('run', walk, { timing: 'ease-in-out' });
  css += kf('face', flip, { timing: 'steps(1,end)' });
  css += kf('arm', armF, { timing: 'ease-in-out', origin: '2px 150px' });
  let boxes = '';
  xs.forEach((x, b) => {
    const blinks = [], greens = [];
    lights[b].forEach(([a, p]) => { for (let t = a; t < p; t += 3) blinks.push([t, t + 1.5]); greens.push([p, p + 7]); });
    css += windows(`red${b}`, blinks) + windows(`grn${b}`, greens);
    css += kf(`pts${b}`, [[0, tr(0, 0)], ...lights[b].flatMap(([, p]) => [[p, tr(0, 0)], [p + 8, tr(0, -30)], [p + 8.01, tr(0, 0)]]), [100, tr(0, 0)]]);
    css += windows(`ptsv${b}`, lights[b].map(([, p]) => [p, p + 8]));
    boxes += `<rect x="${x - 34}" y="128" width="68" height="34" rx="4" fill="${C.wood}"/><circle cx="${x - 24}" cy="124" r="4" fill="${C.steelDark}"/><circle cx="${x + 24}" cy="124" r="4" fill="${C.steelDark}"/>
<text x="${x}" y="151" text-anchor="middle" style="font:800 15px system-ui,sans-serif;fill:${C.ink}">${b + 1}</text>
<rect x="${x - 24}" y="${y - 18}" width="48" height="40" rx="6" fill="${C.ink}" stroke="${C.grey}" stroke-width="3"/>
<circle cx="${x}" cy="${y + 2}" r="13" fill="${C.grey}"/><circle class="a red${b}" cx="${x}" cy="${y + 2}" r="13" fill="${C.red}" opacity="0"/><circle class="a grn${b}" cx="${x}" cy="${y + 2}" r="13" fill="${C.green}" opacity="0"/>
<g class="a ptsv${b}" opacity="0"><text class="a pts${b}" x="${x}" y="${y - 28}" text-anchor="middle" style="font:800 18px system-ui,sans-serif;fill:${C.yellow}">+5</text></g>`;
  });
  return svg({
    title: 'A competitor runs to whichever wall button is blinking and presses it, and the next button starts blinking',
    dur, css,
    body: `${room()}${boxes}
<g class="a run"><g class="a face">${figure({ legs: 'walk' })}<g class="a arm">${arm(50)}</g></g></g>`,
  });
};

await fs.mkdir(OUT, { recursive: true });
for (const [slug, make] of Object.entries(scenes)) {
  await fs.writeFile(path.join(OUT, `${slug}.svg`), make());
}
console.log(`Wrote ${Object.keys(scenes).length} animations to content/images/`);
