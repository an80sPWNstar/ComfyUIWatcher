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
// ── Selectable ranges (added 2026-08-13, Bryan's call) ─────────────────────
// One face never fits every job. His generation work sits between about 0.1 and 5 it/s, and on the
// old fixed ±100 face that is a few degrees either side of centre — "100 is too far in both
// directions". So the range is a setting (hosts panel → Dials), and 20 is the default. The wide
// face stays available for the rare fast run rather than being deleted.
//
// Each range is written out by hand, not generated: which marks carry a label is the difference
// between a readable dial and a wall of numbers, and every label has to be a whole number (see the
// rejected schemes in CLAUDE.md). Marks are ALWAYS in it/s, whatever the labels print.
//
// A sampling range is keyed by its SLOW end and carries its own fast end, because the two do not
// have to match: the 60 face stops at 5 it/s, not 60. Symmetry was never a requirement, it was an
// assumption — and it is what put a 15.7 s/it MiniMax-H3 run a hair off the slow stop on the 20
// face while half the arc covered speeds no video sampler reaches (Bryan, 2026-08-14: "14 s/it is
// actually pretty fast for minimax h3"). 60 s/it … 5 it/s is the default now: video work sits about
// a quarter up the arc, a 42 s/it 720p job is still ON the face rather than pegged, and an SDXL run
// at 4 it/s still reads.
const SAMPLING_RANGES = [5, 20, 60, 100];
const TRAINING_RANGES = [10, 30, 60];
// Video: one unit, no fast half, same shape as the training face. NOTHING that generates video on
// this rack runs above 1 it/s, and the split face's SLOW/FAST words are a judgement no absolute
// scale is entitled to make about a video sampler — 15.75 s/it is a healthy MiniMax-H3 run, and the
// face printed SLOW next to it. A single-unit face has no such words at all, and 60…1 s/it puts
// that reading at 43% of the arc instead of 4%.
const VIDEO_RANGES = [30, 60, 120];
const DEFAULT_SAMPLING = 60;
const DEFAULT_TRAINING = 60;
const DEFAULT_VIDEO = 60;
// Fast end per sampling range, in it/s. Absent = symmetric with the slow end.
const SAMPLING_FAST_END = { 60: 5 };
const DIAL_KEYS = {
  sampling: 'comfyuiwatcher-dial-sampling',
  training: 'comfyuiwatcher-dial-training',
  video: 'comfyuiwatcher-dial-video',
};

// Sampling: symmetric about the 1:1 centre, left half labelled in s/it (the reciprocal), right half
// in it/s — so every label is a whole number and the unit word for the half being read lights up.
const SAMPLING_MARKS = {
  5: [
    { v: 1 / 5, label: '5' }, { v: 1 / 4 }, { v: 1 / 3 },
    { v: 1 / 2, label: '2' }, { v: 1 / 1.5 },
    { v: 1, label: '1', centre: true },
    { v: 1.5 }, { v: 2, label: '2' },
    { v: 3 }, { v: 4 }, { v: 5, label: '5' },
  ],
  20: [
    { v: 1 / 20, label: '20' }, { v: 1 / 15 }, { v: 1 / 10, label: '10' }, { v: 1 / 7 },
    { v: 1 / 5, label: '5' }, { v: 1 / 3 }, { v: 1 / 2, label: '2' }, { v: 1 / 1.5 },
    { v: 1, label: '1', centre: true },
    { v: 1.5 }, { v: 2, label: '2' }, { v: 3 }, { v: 5, label: '5' },
    { v: 7 }, { v: 10, label: '10' }, { v: 15 }, { v: 20, label: '20' },
  ],
  // The video face, and the default. Asymmetric: the crossover sits about three quarters along, so
  // the s/it half gets the room it needs and the fast half keeps just enough scale for an image job.
  60: [
    { v: 1 / 60, label: '60' }, { v: 1 / 40 }, { v: 1 / 30, label: '30' },
    { v: 1 / 20, label: '20' }, { v: 1 / 15 }, { v: 1 / 10, label: '10' }, { v: 1 / 7 },
    { v: 1 / 5, label: '5' }, { v: 1 / 4 }, { v: 1 / 3 }, { v: 1 / 2, label: '2' }, { v: 1 / 1.5 },
    { v: 1, label: '1', centre: true },
    { v: 1.5 }, { v: 2, label: '2' }, { v: 3 }, { v: 5, label: '5' },
  ],
  100: [
    { v: 0.01, label: '100' }, { v: 0.02 }, { v: 0.05 },
    { v: 0.1, label: '10' }, { v: 0.2 }, { v: 0.5 },
    { v: 1, label: '1', centre: true }, { v: 2 }, { v: 5 },
    { v: 10, label: '10' }, { v: 20 }, { v: 50 }, { v: 100, label: '100' },
  ],
};

// Training: one unit, no split, labels DESCENDING left to right because the scale underneath is
// still it/s — further right is faster on every module in the rack.
const TRAINING_MARKS = {
  10: [
    { v: 1 / 10, label: '10' }, { v: 1 / 8 }, { v: 1 / 6 },
    { v: 1 / 5, label: '5' }, { v: 1 / 4 }, { v: 1 / 3, label: '3' },
    { v: 1 / 2, label: '2' }, { v: 1 / 1.5 }, { v: 1, label: '1' },
  ],
  30: [
    { v: 1 / 30, label: '30' }, { v: 1 / 20, label: '20' }, { v: 1 / 15 },
    { v: 1 / 10, label: '10' }, { v: 1 / 7 }, { v: 1 / 5, label: '5' },
    { v: 1 / 4 }, { v: 1 / 3 }, { v: 1 / 2, label: '2' }, { v: 1 / 1.5 },
    { v: 1, label: '1' },
  ],
  60: [
    { v: 1 / 60, label: '60' }, { v: 1 / 40 }, { v: 1 / 30 },
    { v: 1 / 20, label: '20' }, { v: 1 / 15 },
    { v: 1 / 10, label: '10' }, { v: 1 / 7 },
    { v: 1 / 5, label: '5' }, { v: 1 / 4 }, { v: 1 / 3 },
    { v: 1 / 2, label: '2' }, { v: 1 / 1.5 },
    { v: 1, label: '1' },
  ],
};

const RANGES = { sampling: SAMPLING_RANGES, training: TRAINING_RANGES, video: VIDEO_RANGES };
const DEFAULT_RANGE = { sampling: DEFAULT_SAMPLING, training: DEFAULT_TRAINING, video: DEFAULT_VIDEO };

/** An unknown face name reads as the sampling face — the same fallback hosts.js gives an odd kind. */
function faceKey(kind) {
  return RANGES[kind] ? kind : 'sampling';
}

// Video: same construction as the training face — labels DESCEND left to right because the scale
// underneath is still it/s, so needle-right is faster on every module in the rack. 60 is the default
// because Bryan's video work runs roughly 3-45 s/it (MiniMax-H3 at 832x480 sits near 15); 120 is for
// 720p work, 30 for a fast short clip.
const VIDEO_MARKS = {
  30: [
    { v: 1 / 30, label: '30' }, { v: 1 / 20, label: '20' }, { v: 1 / 15 },
    { v: 1 / 10, label: '10' }, { v: 1 / 7 }, { v: 1 / 5, label: '5' },
    { v: 1 / 4 }, { v: 1 / 3 }, { v: 1 / 2, label: '2' }, { v: 1 / 1.5 },
    { v: 1, label: '1' },
  ],
  60: [
    { v: 1 / 60, label: '60' }, { v: 1 / 40 }, { v: 1 / 30, label: '30' },
    { v: 1 / 20, label: '20' }, { v: 1 / 15 },
    { v: 1 / 10, label: '10' }, { v: 1 / 7 },
    { v: 1 / 5, label: '5' }, { v: 1 / 4 }, { v: 1 / 3 },
    { v: 1 / 2, label: '2' }, { v: 1 / 1.5 },
    { v: 1, label: '1' },
  ],
  120: [
    { v: 1 / 120, label: '120' }, { v: 1 / 80 }, { v: 1 / 60, label: '60' }, { v: 1 / 40 },
    { v: 1 / 30, label: '30' }, { v: 1 / 20, label: '20' }, { v: 1 / 15 },
    { v: 1 / 10, label: '10' }, { v: 1 / 7 }, { v: 1 / 5, label: '5' },
    { v: 1 / 3 }, { v: 1 / 2, label: '2' }, { v: 1, label: '1' },
  ],
};

/** The range a face is currently set to, from localStorage, falling back to the default. */
function dialRange(kind) {
  const key = faceKey(kind);
  const saved = Number(localStorage.getItem(DIAL_KEYS[key]));
  return RANGES[key].includes(saved) ? saved : DEFAULT_RANGE[key];
}

function setDialRange(kind, range) {
  localStorage.setItem(DIAL_KEYS[faceKey(kind)], String(range));
}

/** Build the face spec for a kind at its current range. */
function faceSpec(kind) {
  const key = faceKey(kind);
  const range = dialRange(key);
  if (key === 'training' || key === 'video') {
    const marks = key === 'video' ? VIDEO_MARKS : TRAINING_MARKS;
    return {
      minLog: -Math.log10(range),
      maxLog: 0,
      // The video face says s/it, the same words the RATE legend under the readout prints for the
      // same number. "sec/iter" is the trainer's own language and belongs to that face only.
      units: { slow: key === 'video' ? 's/it' : 'sec/iter', single: true },
      marks: marks[range] ?? marks[DEFAULT_RANGE[key]],
    };
  }
  return {
    minLog: -Math.log10(range),
    maxLog: Math.log10(samplingFastEnd(range)),
    units: { slow: 's/it', fast: 'it/s' },
    marks: SAMPLING_MARKS[range] ?? SAMPLING_MARKS[DEFAULT_SAMPLING],
  };
}

/** it/s at the fast stop of a sampling range. Symmetric unless the range says otherwise. */
function samplingFastEnd(range) {
  return SAMPLING_FAST_END[range] ?? range;
}

/**
 * What a range reads as on the dial, for the settings dropdown. The label is built from the face's
 * own two ends rather than assuming both are the same number — that assumption is exactly what the
 * 60 face breaks.
 */
function dialRangeLabel(kind, range) {
  if (faceKey(kind) !== 'sampling') return `${range} s/it`;
  return `${range} s/it  ―  ${samplingFastEnd(range)} it/s`;
}

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
  // The face can change under a running card: a host that was rendering stills starts a video job,
  // and the scale that fits one does not fit the other. It is a REPRINT, never a rebuild — see
  // setFace below.
  let kind = faceKey(faceName);
  // Read through the export, exactly as reactor-panel.js does, so there is ONE seam where the face
  // comes from: a mock comparing candidate scales patches window.Widgets.faceSpec and both widgets
  // print the candidate. Behaviour is identical — the export IS this file's faceSpec.
  let face = window.Widgets.faceSpec(kind);
  const wrap = document.createElement('div');
  wrap.className = `meter meter--${kind}`;

  const svg = svgEl('svg', { viewBox: '0 0 200 92', class: 'meter-svg' });
  const cx = 100;
  const cy = 96; // pivot at the bottom edge — only the top of the swing shows, as on real gear
  const rTick = 60;
  const toRad = (a) => ((a - 90) * Math.PI) / 180;

  svg.appendChild(svgEl('rect', { x: 2, y: 2, width: 196, height: 88, rx: 3, class: 'meter-face' }));

  // Graduations live in their own group so a range change can REPRINT the face in place. Rebuilding
  // the card instead would drop the needle back to the stop and re-run its ballistics mid-job,
  // which is the same reason skins and the kind filter are pure CSS over one DOM.
  // The group is inserted before the needle, so paint order stays face → ticks → needle → glass.
  const grads = svgEl('g', { class: 'meter-grads' });
  svg.appendChild(grads);

  function drawFace() {
    grads.replaceChildren();
    // A face's marks are listed explicitly (in it/s) rather than generated per decade: the training
    // face is not decade-aligned, and hand-picking which marks carry a label is the difference
    // between a readable dial and a wall of numbers.
    for (const m of face.marks) {
      const a = posToAngle(meterPos(face, m.v));
      const len = m.centre ? 13 : m.label ? 9 : 5;
      grads.appendChild(svgEl('line', {
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
        grads.appendChild(t);
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
    grads.appendChild(unitSlow);
    if (!face.units.single) {
      const unitFast = svgEl('text', { x: 156, y: 84, class: 'meter-unit meter-unit--fast' });
      unitFast.textContent = face.units.fast ?? '';
      grads.appendChild(unitFast);
    }
  }

  drawFace();

  // ── Halo arc: the same reading, drawn as a lit arc instead of a printed pointer ──
  // Two paths on the tick circle: a dim full-sweep track, and a value trace that fills from the
  // left stop to wherever the needle currently is. They carry NO information the needle does not
  // already carry — they are a second rendering of one value, which is why a skin may paint them
  // or leave them off. main.css hides both by default; only skins that want an instrument with no
  // printed face turn them on (skin-halo). Adding them here rather than in a skin-specific widget
  // keeps every skin on ONE DOM, so switching skin still never rebuilds a card mid-job.
  const rArc = rTick - 4;
  const arcPt = (a) => `${(cx + rArc * Math.cos(toRad(a))).toFixed(2)} ${(cy + rArc * Math.sin(toRad(a))).toFixed(2)}`;
  const arcPath = `M ${arcPt(-SWEEP_DEG / 2)} A ${rArc} ${rArc} 0 0 1 ${arcPt(SWEEP_DEG / 2)}`;
  svg.appendChild(svgEl('path', { d: arcPath, class: 'meter-arc-track', pathLength: 1 }));
  const arcValue = svgEl('path', {
    d: arcPath, class: 'meter-arc-value', pathLength: 1, 'stroke-dasharray': '0 1',
  });
  svg.appendChild(arcValue);

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
      // The trace follows the needle, not the raw rate — so it swings with the same ballistics
      // and parks at zero length when the pointer is at its stop.
      const f = (deg + SWEEP_DEG / 2) / SWEEP_DEG;
      arcValue.setAttribute('stroke-dasharray', `${f.toFixed(4)} 1`);
      // A rounded cap on a zero-length dash still paints a lit dot — the same trap the old arc
      // gauge hit — and a dot at the stop would read as a measurement.
      arcValue.style.visibility = f > 0.004 ? '' : 'hidden';
    },
  };
  state.apply(state.angle);
  needles.add(state);

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let lastRate = null;
  let powered = false;

  const isLive = () => lastRate != null && Number.isFinite(lastRate) && lastRate > 0;

  // TWO independent states, and keeping them apart is the whole point:
  //   .meter--nosignal — there is no reading. Parked needle, NO SIGNAL legend.
  //   .meter--dark     — the lamp is off. Only when there is no reading AND nothing is running.
  // So a running job with no rate yet shows a lit face with an honestly parked pointer, and an idle
  // host still goes properly dark (which is what keeps a rack of idle modules quiet).
  function applyLighting() {
    const live = isLive();
    wrap.classList.toggle('meter--nosignal', !live);
    wrap.classList.toggle('meter--dark', !live && !powered);
    // Which half is being read — lights that half's unit word, and it is the same 1.0 cutover the
    // RATE legend under the readout uses, so face and figure never disagree. A single-unit face has
    // only one word, so it lights whenever the instrument reads anything at all.
    const slow = face.units.single || lastRate < 1;
    wrap.classList.toggle('meter--reading-slow', live && slow);
    wrap.classList.toggle('meter--reading-fast', live && !slow);
  }

  applyLighting();

  return {
    el: wrap,
    /**
     * Reprint the face at whatever range is currently saved, and re-point the needle at the rate it
     * was already showing — the reading has not changed, only the scale it is read against.
     */
    refreshFace() {
      face = window.Widgets.faceSpec(kind);
      drawFace();
      this.setRate(lastRate);
    },
    /**
     * Print a different face on the same instrument — 'sampling' → 'video' when the job on this host
     * turns out to be making video. Reprinting keeps the needle where it is and lets it swing to the
     * new position with its own ballistics; rebuilding the card would drop it to the stop mid-job.
     * A no-op when the face is already the one asked for, so this is safe to call on every snapshot.
     */
    setFace(name) {
      const next = faceKey(name);
      if (next === kind) return;
      kind = next;
      wrap.classList.remove('meter--sampling', 'meter--training', 'meter--video');
      wrap.classList.add(`meter--${kind}`);
      this.refreshFace();
    },
    /**
     * Backlight, independent of the reading. A real instrument's lamp is on because the rack is
     * running, not because the pointer happens to be off zero — and a face that went dark for the
     * few seconds between batch items flashed bright/dark/bright/dark through a whole run, which was
     * the most distracting thing on screen (Bryan, 2026-08-13). `on` = a job is running on this
     * host. The needle and the NO SIGNAL legend still tell the truth about whether there is a
     * reading, so a lit face with a parked pointer cannot be misread as a measurement.
     */
    setPowered(on) {
      powered = !!on;
      applyLighting();
    },
    /** @param {number|null} itPerSec — null/0 parks the needle at the stop and lights NO SIGNAL. */
    setRate(itPerSec) {
      lastRate = itPerSec;
      applyLighting();
      const live = isLive();
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

/**
 * Register a pointer with the shared ballistics loop and get a handle back.
 *
 * The reactor panel draws its own instruments (twin dials, a progress movement) but must NOT run
 * its own rAF loop: with three needles per card that would be one timer per host per instrument,
 * all doing the same 60Hz integration this file already does for the rack meter. `apply(deg)` is
 * called with the current angle each frame; `setAngle` sets the target and `destroy` unregisters —
 * a needle left in the set animates forever after its card is removed.
 *
 * @param {(deg: number) => void} apply
 * @param {number} [start] resting angle, in degrees
 */
function createNeedle(apply, start = 0) {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const state = { angle: start, vel: 0, target: start, apply };
  state.apply(state.angle);
  needles.add(state);
  return {
    setAngle(deg) {
      state.target = deg;
      if (reduceMotion.matches) {
        state.angle = deg;
        state.vel = 0;
        state.apply(deg);
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
window.Widgets.createNeedle = createNeedle;
// The graduation tables, at whatever range the Dials setting is on. Exported so a second card
// widget reads the SAME hand-written marks rather than generating its own — see the four rejected
// labelling schemes in CLAUDE.md for why these are not computed.
window.Widgets.faceSpec = faceSpec;
// Dial ranges are display settings, like the skin: the settings panel writes them, renderer.js
// tells the cards to reprint. Exposed here because the faces live here.
window.Widgets.dialRanges = { sampling: SAMPLING_RANGES, training: TRAINING_RANGES, video: VIDEO_RANGES };
window.Widgets.dialRange = dialRange;
// The dropdown prints what each face actually reads — the ends are no longer symmetric.
window.Widgets.dialRangeLabel = dialRangeLabel;
window.Widgets.setDialRange = setDialRange;
window.Widgets.createRateMeter = createRateMeter;
