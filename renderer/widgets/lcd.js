// Display primitives ported from tempsLCD-web's design system
// (design_system/components/core/SevenSegment.jsx + SensorGauge.jsx): React -> plain DOM/SVG,
// because this renderer has no bundler and no require(). Colors are NOT baked in — every fill
// and stroke is `currentColor` or a CSS custom property, so card state classes
// (.job-card--finished-error etc.) recolor the whole readout from stylesheet alone.

const SVG_NS = 'http://www.w3.org/2000/svg';

// SVG gradient references are document-global, so every meter needs its own id — two cards
// sharing one would be fine today but breaks the moment their fills differ.
let uidSeq = 0;
function uid(prefix) {
  uidSeq += 1;
  return `${prefix}-${uidSeq}`;
}

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
  return el;
}

// ── Seven-segment numerals ──────────────────────────────────────────────────
//   ┌─a─┐
//   f   b
//   ├─g─┤
//   e   c
//   └─d─┘
// Polygon geometry verbatim from SevenSegment.jsx (20x36 viewBox).
const SEG_POINTS = {
  a: '4,2.5 5.6,0.9 14.4,0.9 16,2.5 14.4,4.1 5.6,4.1',
  b: '17.3,4 15.7,5.6 15.7,15.6 17.3,17.2 18.9,15.6 18.9,5.6',
  c: '17.3,18.8 15.7,20.4 15.7,30.4 17.3,32 18.9,30.4 18.9,20.4',
  d: '4,33.5 5.6,31.9 14.4,31.9 16,33.5 14.4,35.1 5.6,35.1',
  e: '2.7,18.8 1.1,20.4 1.1,30.4 2.7,32 4.3,30.4 4.3,20.4',
  f: '2.7,4 1.1,5.6 1.1,15.6 2.7,17.2 4.3,15.6 4.3,5.6',
  g: '4,18 5.6,16.4 14.4,16.4 16,18 14.4,19.6 5.6,19.6',
};

const DIGIT_SEGS = {
  '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc',
  '5': 'afgcd', '6': 'afgecd', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg',
  '-': 'g', ' ': '',
};

const SEG_KEYS = Object.keys(SEG_POINTS);

function buildDigit() {
  const el = svgEl('svg', { viewBox: '0 0 20 36', class: 'lcd-digit' });
  const lit = {};
  // Ghost layer first: an unlit real display still shows faint segments.
  for (const k of SEG_KEYS) {
    el.appendChild(svgEl('polygon', { points: SEG_POINTS[k], class: 'lcd-seg lcd-seg--ghost' }));
  }
  const onGroup = svgEl('g', { class: 'lcd-lit' });
  for (const k of SEG_KEYS) {
    const p = svgEl('polygon', { points: SEG_POINTS[k], class: 'lcd-seg' });
    onGroup.appendChild(p);
    lit[k] = p;
  }
  el.appendChild(onGroup);

  return {
    el,
    set(ch) {
      const on = DIGIT_SEGS[ch] ?? '';
      for (const k of SEG_KEYS) lit[k].classList.toggle('lcd-seg--on', on.includes(k));
    },
  };
}

/**
 * Seven-segment readout, `digitCount` wide. Right-aligned, leading positions blanked to ghost
 * segments (real-display behaviour, and it keeps the card width from twitching). The field grows
 * if a value needs more digits than it has — truncating instead would render 1000 as "000".
 * `setText()` swaps to a plain-text layer for values a numeral field can't express — "N/A".
 */
function createSevenSeg(digitCount) {
  const minCount = digitCount || 3;
  const el = document.createElement('div');
  el.className = 'lcd';

  const digitsEl = document.createElement('div');
  digitsEl.className = 'lcd-digits';
  const digits = [];
  function grow(n) {
    while (digits.length < n) {
      const d = buildDigit();
      digitsEl.appendChild(d.el);
      digits.push(d);
    }
  }
  grow(minCount);
  el.appendChild(digitsEl);

  const textEl = document.createElement('div');
  textEl.className = 'lcd-text';
  el.appendChild(textEl);

  return {
    el,
    setValue(num) {
      el.classList.remove('lcd--text');
      const raw = String(num);
      grow(Math.max(minCount, raw.length));
      // 4+ digits crowd the gauge ring at the default glyph size.
      el.classList.toggle('lcd--wide', digits.length > 3);
      const str = raw.padStart(digits.length, ' ');
      for (let i = 0; i < digits.length; i++) digits[i].set(str[i]);
    },
    setText(str) {
      el.classList.add('lcd--text');
      textEl.textContent = str;
    },
  };
}

// ── Rate meter (moving-coil, log scale) ─────────────────────────────────────
// The card's one analog instrument: sampling rate on a 4-decade log scale, 0.01 -> 100 it/s.
// Log, because this widget watches everything from a 20-step SDXL image (>5 it/s) to a MiniMax
// H3 video sampler (~0.07 it/s = 13.9 s/it) and a linear face would pin the needle at one end
// for whichever it wasn't scaled for. The face carries both units because ComfyUI itself flips
// its own readout at 1.0 — s/it is what a slow job is read in, it/s a fast one.
//
// No "red zone": on real gear that marks overload, and there is nothing wrong with a slow
// sampler — Bryan's video jobs live below 0.1 it/s by nature.

const SWEEP_DEG = 96;

// Every face is graduated in it/s underneath, whatever its labels say. That is what keeps
// needle direction meaning ONE thing in a rack that mixes generation and training modules:
// further right is always faster. Only the printed numbers change.
const FACES = {
  // Sampling: four decades, 0.01..100 it/s, split at the 1:1 centre. Left half labelled in s/it
  // (the reciprocal), right half in it/s, so every label is a whole number and the unit word for
  // the half being read lights up.
  sampling: {
    minLog: -2,
    maxLog: 2,
    units: { slow: 's/it', fast: 'it/s' },
    marks: [
      { v: 0.01, label: '100' }, { v: 0.02 }, { v: 0.05 },
      { v: 0.1, label: '10' }, { v: 0.2 }, { v: 0.5 },
      { v: 1, label: '1', centre: true }, { v: 2 }, { v: 5 },
      { v: 10, label: '10' }, { v: 20 }, { v: 50 }, { v: 100, label: '100' },
    ],
  },
  // Training: 60..1 s/it, one unit, no dead half. Scaled from Bryan's own recorded ai-toolkit
  // runs — 2.17, 3.66, 4.41, 5.09, 6.08 and 30.07 s/it. NOTHING he has ever trained ran faster
  // than 1 it/s, so on the sampling face all six jobs pile up within a few degrees of centre and
  // half the arc is spent on speeds no trainer reaches. Chosen from a live side-by-side mockup,
  // 2026-08-13 (renderer/mock-train-dial.html, "face B").
  //
  // Labels descend left to right (60 … 1) BECAUSE the underlying scale is still it/s. Drawing it
  // the other way round — 1 on the left, 60 on the right — was tried and rejected: it reads more
  // naturally alone, but in a mixed rack needle-right would mean "fast" on a generation module
  // and "slow" on the training module beside it.
  training: {
    minLog: -Math.log10(60),
    maxLog: 0,
    units: { slow: 'sec/iter', single: true },
    marks: [
      { v: 1 / 60, label: '60' }, { v: 1 / 40 }, { v: 1 / 30 },
      { v: 1 / 20, label: '20' }, { v: 1 / 15 },
      { v: 1 / 10, label: '10' }, { v: 1 / 7 },
      { v: 1 / 5, label: '5' }, { v: 1 / 4 }, { v: 1 / 3 },
      { v: 1 / 2, label: '2' }, { v: 1 / 1.5 },
      { v: 1, label: '1' },
    ],
  },
};

/** it/s -> 0..1 across the face. Clamped: a rate off the end parks the needle at the stop. */
function meterPos(face, itPerSec) {
  const lg = Math.log10(itPerSec);
  return Math.max(0, Math.min(1, (lg - face.minLog) / (face.maxLog - face.minLog)));
}

function posToAngle(pos) {
  return -SWEEP_DEG / 2 + pos * SWEEP_DEG;
}

// One rAF loop drives every needle on screen. Per-meter loops would mean one timer per host
// card, all doing the same 60Hz integration.
const needles = new Set();
let needleFrame = 0;
let lastFrameMs = 0;

function tickNeedles(nowMs) {
  const dt = Math.min(64, nowMs - (lastFrameMs || nowMs)) / 16.667; // in 60fps frames
  lastFrameMs = nowMs;
  let moving = false;
  for (const n of needles) {
    // Moving-coil ballistics: spring pull toward the target, damped. The slight overshoot on a
    // big swing is the point — it reads as a physical pointer, not a CSS transition.
    const err = n.target - n.angle;
    n.vel += (err * 0.085 - n.vel * 0.42) * dt;
    n.angle += n.vel * dt;
    if (Math.abs(err) < 0.02 && Math.abs(n.vel) < 0.02) {
      n.angle = n.target;
      n.vel = 0;
    } else {
      moving = true;
    }
    n.apply(n.angle);
  }
  needleFrame = moving ? requestAnimationFrame(tickNeedles) : 0;
}

function wakeNeedles() {
  if (!needleFrame) {
    lastFrameMs = 0;
    needleFrame = requestAnimationFrame(tickNeedles);
  }
}

/** @param {'sampling'|'training'} [faceName] which graduation to print. */
function createRateMeter(faceName) {
  const face = FACES[faceName] ?? FACES.sampling;
  const wrap = document.createElement('div');
  wrap.className = `meter meter--${faceName && FACES[faceName] ? faceName : 'sampling'}`;

  const svg = svgEl('svg', { viewBox: '0 0 200 92', class: 'meter-svg' });
  const cx = 100;
  const cy = 96; // pivot at the bottom edge — only the top of the swing shows, as on real gear
  const rTick = 60;
  const toRad = (a) => ((a - 90) * Math.PI) / 180;

  svg.appendChild(svgEl('rect', { x: 2, y: 2, width: 196, height: 88, rx: 3, class: 'meter-face' }));

  // Graduations. A face's marks are listed explicitly (in it/s) rather than generated per decade:
  // the training face is not decade-aligned, and hand-picking which marks carry a label is the
  // difference between a readable dial and a wall of numbers.
  for (const m of face.marks) {
    const a = posToAngle(meterPos(face, m.v));
    const len = m.centre ? 13 : m.label ? 9 : 5;
    svg.appendChild(svgEl('line', {
      x1: cx + (m.centre ? rTick - 5 : rTick) * Math.cos(toRad(a)),
      y1: cy + (m.centre ? rTick - 5 : rTick) * Math.sin(toRad(a)),
      x2: cx + (rTick + len) * Math.cos(toRad(a)),
      y2: cy + (rTick + len) * Math.sin(toRad(a)),
      class: `meter-tick${m.label ? ' meter-tick--major' : ''}${m.centre ? ' meter-tick--centre' : ''}`,
    }));
    if (m.label) {
      const rl = rTick + len + 7;
      const t = svgEl('text', {
        x: cx + rl * Math.cos(toRad(a)),
        y: cy + rl * Math.sin(toRad(a)) + 3,
        class: 'meter-label',
      });
      t.textContent = m.label;
      svg.appendChild(t);
    }
  }

  // ONE scale, one unit per half. This face has been wrong twice in the other direction: first
  // both "s/it" and "it/s" printed beside a single row of it/s numbers (a unit pointing at a
  // scale that wasn't drawn), then a real second s/it row in a second ink — correct, but two rows
  // of numbers on a 196px instrument is more than anyone reads at a glance. The exact figure,
  // flipped to s/it below 1 the way ComfyUI does it, lives in the RATE legend under the readout.
  //
  // The words sit off bottom-centre because the needle pivots there and draws straight through
  // anything printed at centre — a single-unit face keeps the same left slot for that reason,
  // NOT the middle of the dial (moving it up to clear the pivot put it through the top
  // graduations instead). The word for the half being read lights up in pointer red.
  const unitSlow = svgEl('text', { x: 44, y: 84, class: 'meter-unit meter-unit--slow' });
  unitSlow.textContent = face.units.slow ?? '';
  svg.appendChild(unitSlow);
  if (!face.units.single) {
    const unitFast = svgEl('text', { x: 156, y: 84, class: 'meter-unit meter-unit--fast' });
    unitFast.textContent = face.units.fast ?? '';
    svg.appendChild(unitFast);
  }

  const needle = svgEl('line', {
    x1: cx, y1: cy, x2: cx, y2: cy - (rTick + 3), class: 'meter-needle',
  });
  const hub = svgEl('circle', { cx, cy, r: 6, class: 'meter-hub' });
  svg.append(needle, hub);

  // Glass: one soft sheen down the upper left, fading out — the way light falls on a curved
  // lens. Flat white read as a paper wedge stuck to the face; the gradient is what makes it
  // look like a reflection.
  const defs = svgEl('defs', {});
  const grad = svgEl('linearGradient', { id: uid('sheen'), x1: 0, y1: 0, x2: 0.7, y2: 1 });
  const stop1 = svgEl('stop', { offset: '0', class: 'meter-sheen-hi' });
  const stop2 = svgEl('stop', { offset: '1', class: 'meter-sheen-lo' });
  grad.append(stop1, stop2);
  defs.appendChild(grad);
  svg.appendChild(defs);
  svg.appendChild(svgEl('path', {
    d: 'M3 3 L 78 3 Q 34 34 3 66 Z',
    class: 'meter-glass',
    fill: `url(#${grad.getAttribute('id')})`,
  }));

  const noSignal = svgEl('text', { x: 100, y: 58, class: 'meter-nosignal' });
  noSignal.textContent = 'NO SIGNAL';
  svg.appendChild(noSignal);

  wrap.appendChild(svg);

  const state = {
    angle: -SWEEP_DEG / 2,
    vel: 0,
    target: -SWEEP_DEG / 2,
    apply(deg) {
      needle.setAttribute('transform', `rotate(${deg.toFixed(2)} ${cx} ${cy})`);
    },
  };
  state.apply(state.angle);
  needles.add(state);

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  return {
    el: wrap,
    /** @param {number|null} itPerSec — null/0 parks the needle at the stop and lights NO SIGNAL. */
    setRate(itPerSec) {
      const live = itPerSec != null && Number.isFinite(itPerSec) && itPerSec > 0;
      wrap.classList.toggle('meter--nosignal', !live);
      // Which half is being read — lights that half's unit word, and it is the same 1.0 cutover
      // the RATE legend under the readout uses, so face and figure never disagree. A single-unit
      // face has only one word, so it lights whenever the instrument reads anything at all.
      const slow = face.units.single || itPerSec < 1;
      wrap.classList.toggle('meter--reading-slow', live && slow);
      wrap.classList.toggle('meter--reading-fast', live && !slow);
      state.target = live ? posToAngle(meterPos(face, itPerSec)) : -SWEEP_DEG / 2;
      if (reduceMotion.matches) {
        state.angle = state.target;
        state.vel = 0;
        state.apply(state.angle);
      } else {
        wakeNeedles();
      }
    },
    destroy() {
      needles.delete(state);
    },
  };
}

window.Widgets = window.Widgets || {};
window.Widgets.createSevenSeg = createSevenSeg;
window.Widgets.createRateMeter = createRateMeter;
