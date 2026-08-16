// What the watcher nodes draw.
//
// TWO AXES, deliberately kept apart:
//   - LAYOUT (Wells / Plate / Bar / Trace / VRAM) — what is on the face and where.
//   - STYLE (rack / glass) — what it is made of. A style may repaint a surface, change a shape or
//     add an ornament; it must never hide a value or change what a number means. Same rule the
//     desktop widget's skins follow, and the reason a style is a WIDGET on the node rather than a
//     second node: switching it must never cost you the node you already wired into a canvas.
// Every layout renders in both styles from one code path — there is no "glass Plate" function to
// drift from the plain one.
//
// Every face shows the same job facts: step, rate, elapsed, ETA. Unknowns read N/A (steps) or `--`
// (a clock), never a fabricated zero and never an ETA without a measured rate.
//
// PURE CANVAS: no ComfyUI imports, so a recording 2D context can unit-test what each face prints
// (test/watcher-node.test.js). Drawn in the node's own space: (0,0) is the top-left of the node
// BODY, ComfyUI's title bar sits above it. The rack style draws on the node's own faceplate; the
// glass style lays its own dome over it first.

import { fmtRate, fmtSec, TRACE_WINDOW_MS } from './job-state.js';
import { deviceLabel, deviceVram, shortDeviceName, fmtGiB } from './devices.js';

export const C = {
  ink: '#cfcfcf',
  dim: '#7c7c7c',
  faint: '#565656',
  well: '#252525',
  amber: '#ffb648', // running
  jade: '#7fd6a0', // finished clean
  red: '#e06c5b', // failed
  // Glass runs its own palette: xenon over obsidian, deliberately not the amber the rack uses.
  glassInk: '#e8eef5',
  // Measured against a REAL ComfyUI canvas, 2026-08-15: these were .45 / .24, tuned on the mock's
  // near-black page. ComfyUI's node body is mid-grey (#353535), so light ink at those alphas turned
  // into a smear at anything under 100% canvas zoom. A palette is only correct against the surface
  // it is actually drawn on.
  glassDim: 'rgba(236,242,250,.78)',
  glassFaint: 'rgba(236,242,250,.62)',
  xenon: '#7fc7ff',
  xenonJade: '#7ff0c4',
  xenonRed: '#ff8f7a',
};

/** The lit colour follows the JOB's state, the way the widget's `--lit` variable does. */
export function litColour(state, glass) {
  if (state === 'success') return glass ? C.xenonJade : C.jade;
  if (state === 'error') return glass ? C.xenonRed : C.red;
  return glass ? C.xenon : C.amber;
}

export const THEMES = {
  rack: {
    key: 'rack',
    glass: false,
    ink: C.ink,
    dim: C.dim,
    faint: C.faint,
    pad: 12,
    top: 0,
    // A glass dome needs air around its content and a foot for its progress capsule; the rack
    // faceplate needs neither, so it adds no height.
    extraH: 0,
  },
  glass: {
    key: 'glass',
    glass: true,
    ink: C.glassInk,
    dim: C.glassDim,
    faint: C.glassFaint,
    pad: 24,
    top: 10,
    extraH: 24,
  },
};
export const themeFor = (style) => THEMES[style] || THEMES.rack;

// A canvas font string falls back silently, so a face designed in Share Tech Mono would render in
// whatever sans-serif the box has. The node loads the shipped ttf files and flips this.
let fontsReady = false;
export function setFontsReady(v) {
  fontsReady = !!v;
}
const mono = (px) => `400 ${px}px ${fontsReady ? 'WatcherMono, ' : ''}monospace`;
const legendFont = (px, weight = 600) =>
  `${weight} ${px}px ${fontsReady ? 'WatcherLegend, ' : ''}sans-serif`;

// ── shared drawing helpers ─────────────────────────────────────────────────
function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** A readout's container: milled well on the rack, floating pane under the dome. */
function panel(ctx, x, y, w, h, t) {
  if (t.glass) {
    // OPAQUE ENOUGH TO BEAT THE SHEEN. At .28 the dome's specular band shone straight through the
    // top row of panes and the STEP/RATE readings came out visibly dimmer than ELAPSED/ETA below
    // them (both hosts, 2026-08-15) — a reading must not depend on where the reflection happens to
    // fall. The pane is its own dark surface under the glass, not a tint of it.
    ctx.fillStyle = 'rgba(8,12,18,.62)';
    rrect(ctx, x, y, w, h, 7);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.14)';
    ctx.lineWidth = 1;
    rrect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 7);
    ctx.stroke();
    return;
  }
  ctx.fillStyle = C.well;
  rrect(ctx, x, y, w, h, 4);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,.5)';
  ctx.lineWidth = 1;
  rrect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 4);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,.05)';
  ctx.beginPath();
  ctx.moveTo(x + 4, y + h - 0.5);
  ctx.lineTo(x + w - 4, y + h - 0.5);
  ctx.stroke();
}

function legend(ctx, text, x, y, color, px = 10, track = '1.6px') {
  ctx.fillStyle = color;
  ctx.font = legendFont(px);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const prev = ctx.letterSpacing;
  ctx.letterSpacing = track;
  ctx.fillText(text, x, y);
  ctx.letterSpacing = prev || '0px';
}

const unknownValue = (v) => v === 'N/A' || v === '--';

/**
 * The step position, or — while the graph is in a node that reports no steps — the name of that
 * node. A run spends its first minute loading a checkpoint and encoding text, and a readout that
 * says only N/A through all of it looks broken instead of busy. The name is a FACT off the canvas,
 * not a guess: when the id is not on this graph (a job queued elsewhere) it falls back to N/A.
 */
export function stepReading(snap) {
  if (snap.steps) return { value: `${snap.step}/${snap.max}`, lit: true };
  if (snap.running && snap.nodeName) return { value: String(snap.nodeName), name: true };
  return { value: 'N/A' };
}

/** Long node titles get cut to the width they have, in the font they are drawn in. */
function fitText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(cut + '…').width > maxW) cut = cut.slice(0, -1);
  return cut + '…';
}

/**
 * The fourth well RELABELS ITSELF once the run is over.
 *
 * A finished job has no ETA, so that well printed `--` and was the one dead readout on a node whose
 * other three all still carried the run's final numbers. It says how the run ENDED instead — the
 * same idiom as the rack card's FRAMES/BATCH SIZE slot, which relabels rather than sitting empty.
 * An idle node that has never run keeps the ETA legend: there is no end state to report, and a well
 * reading N/A under an ETA label is honest.
 */
const END_WORDS = { success: 'FINISHED', error: 'FAILED', interrupted: 'STOPPED' };
export function endCell(snap) {
  if (snap.running || !END_WORDS[snap.state]) {
    return { label: 'ETA', value: fmtSec(snap.eta), lit: snap.eta != null };
  }
  return { label: 'STATE', value: END_WORDS[snap.state], lit: true, word: true };
}

/** What the four readouts say. Separated from the drawing so a test can assert the strings. */
export function faceCells(snap) {
  const rate = fmtRate(snap.rate);
  const step = stepReading(snap);
  return [
    { label: 'STEP', value: step.value, lit: step.lit, name: step.name },
    { label: 'RATE', value: rate ? rate.value : 'N/A', unit: rate ? rate.unit : '' },
    { label: 'ELAPSED', value: fmtSec(snap.elapsed) },
    endCell(snap),
  ];
}

const stepsLeft = (snap) => (snap.steps ? String(snap.max - snap.step) : 'N/A');
const clockCells = (snap) => [
  { label: 'STEP', value: snap.steps ? `${snap.step}/${snap.max}` : 'N/A' },
  { label: 'ELAPSED', value: fmtSec(snap.elapsed) },
  endCell(snap),
];

/** A row of labelled figures, used by Plate, Bar and Trace. */
function strip(ctx, x, y, w, items, lit, t, sunken) {
  const h = 30;
  if (sunken) panel(ctx, x, y, w, h, t);
  const cw = w / items.length;
  items.forEach((it, i) => {
    const cx = x + i * cw + 9;
    legend(ctx, it.label, cx, y + 12, t.faint);
    ctx.textAlign = 'left';
    ctx.fillStyle = unknownValue(it.value) ? t.faint : it.lit ? lit : t.ink;
    // The strip's cells are a third of a narrow node wide, and a state word ("FINISHED") is longer
    // than any figure that has ever been in one — cut it to its cell rather than letting it run
    // through the divider into the next reading.
    ctx.font = it.word ? legendFont(13, 600) : mono(14);
    ctx.fillText(fitText(ctx, it.value, cw - 18), cx, y + 25);
    if (i) {
      ctx.strokeStyle = t.glass ? 'rgba(255,255,255,.10)' : 'rgba(255,255,255,.06)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + i * cw, y + 6);
      ctx.lineTo(x + i * cw, y + h - 6);
      ctx.stroke();
    }
  });
}

/**
 * The rate trace, used by the Trace layout. Log height (0.05..20 it/s) so a 15 s/it video sampler
 * and a 5 it/s SDXL run are both on the chart, and higher always means faster — the same rule the
 * widget's dials follow. The pen LIFTS across a gap rather than drawing a straight line through it:
 * an interpolated line across a 40s model load is a measurement nobody took.
 */
function trace(ctx, x, y, w, h, history, colour) {
  if (!history || history.length < 2) return;
  const now = history[history.length - 1].atMs;
  const lo = Math.log(0.05);
  const hi = Math.log(20);
  const px = (s) => x + 3 + (w - 6) * (1 - Math.min(1, (now - s.atMs) / TRACE_WINDOW_MS));
  const py = (s) =>
    y + h - 3 - (h - 6) * Math.min(1, Math.max(0, (Math.log(s.rate) - lo) / (hi - lo)));
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  let open = false;
  for (let i = 0; i < history.length; i++) {
    const gap = i > 0 && history[i].atMs - history[i - 1].atMs > 5000;
    if (!open || gap) {
      ctx.moveTo(px(history[i]), py(history[i]));
      open = true;
    } else {
      ctx.lineTo(px(history[i]), py(history[i]));
    }
  }
  ctx.stroke();
  const last = history[history.length - 1];
  ctx.beginPath();
  ctx.arc(px(last), py(last), 2.5, 0, Math.PI * 2);
  ctx.fillStyle = colour;
  ctx.fill();
  ctx.restore();
}

// ── the glass dome ─────────────────────────────────────────────────────────
// Not a flat pane: a curved cover sitting OVER the readouts. Four cues do the work, and all four
// are needed — any one alone reads as "a slightly lighter rectangle":
//   1. a body tint lightest at the top, pooling blue at the bottom (thickness);
//   2. a broad specular bloom in the upper left, where the light is;
//   3. a hard sheen streak across the top third — the giveaway that a surface is glossy;
//   4. a bright rim on the top edge and a refracted line inside the foot, because a dome is
//      thickest where you look through it edge-on.
function drawDome(ctx, w, h) {
  const x = 10;
  const y = 6;
  const pw = w - 20;
  const ph = h - 14;

  // SMOKED, not clear. The tint goes down first and it is DARK: a dome over a mid-grey node has to
  // give the light ink something to sit against, and the sheen and bloom that follow only read as
  // reflections if there is something darker under them.
  rrect(ctx, x, y, pw, ph, 14);
  ctx.fillStyle = 'rgba(10,14,20,.62)';
  ctx.fill();
  const g = ctx.createLinearGradient(0, y, 0, y + ph);
  g.addColorStop(0, 'rgba(255,255,255,.10)');
  g.addColorStop(0.45, 'rgba(255,255,255,.030)');
  g.addColorStop(0.85, 'rgba(120,160,200,.045)');
  g.addColorStop(1, 'rgba(150,190,230,.085)');
  rrect(ctx, x, y, pw, ph, 14);
  ctx.fillStyle = g;
  ctx.fill();

  ctx.save();
  rrect(ctx, x, y, pw, ph, 14);
  ctx.clip();

  const bloom = ctx.createRadialGradient(
    x + pw * 0.28,
    y + ph * 0.18,
    2,
    x + pw * 0.28,
    y + ph * 0.18,
    Math.max(pw, ph) * 0.62,
  );
  bloom.addColorStop(0, 'rgba(255,255,255,.13)');
  bloom.addColorStop(0.45, 'rgba(255,255,255,.035)');
  bloom.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = bloom;
  ctx.fillRect(x, y, pw, ph);

  const sheen = ctx.createLinearGradient(x, y, x + pw, y + ph * 0.5);
  sheen.addColorStop(0, 'rgba(255,255,255,.18)');
  sheen.addColorStop(0.55, 'rgba(255,255,255,.05)');
  sheen.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.beginPath();
  ctx.moveTo(x + 6, y + ph * 0.34);
  ctx.quadraticCurveTo(x + pw * 0.42, y - ph * 0.16, x + pw - 6, y + ph * 0.2);
  ctx.lineTo(x + pw - 6, y + 2);
  ctx.lineTo(x + 6, y + 2);
  ctx.closePath();
  ctx.fillStyle = sheen;
  ctx.fill();

  const foot = ctx.createLinearGradient(0, y + ph - 18, 0, y + ph);
  foot.addColorStop(0, 'rgba(160,200,240,0)');
  foot.addColorStop(1, 'rgba(190,220,255,.10)');
  ctx.fillStyle = foot;
  ctx.fillRect(x, y + ph - 18, pw, 18);
  ctx.restore();

  ctx.strokeStyle = 'rgba(255,255,255,.16)';
  ctx.lineWidth = 1;
  rrect(ctx, x + 0.5, y + 0.5, pw - 1, ph - 1, 14);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,.42)';
  ctx.beginPath();
  ctx.moveTo(x + 16, y + 1);
  ctx.lineTo(x + pw - 16, y + 1);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(210,235,255,.16)';
  ctx.beginPath();
  ctx.moveTo(x + 20, y + ph - 1.5);
  ctx.lineTo(x + pw - 20, y + ph - 1.5);
  ctx.stroke();
}

/** The dome's own progress ornament: a lit capsule along its foot. No ticks, no numbers. */
function domeProgress(ctx, w, h, snap) {
  const lit = litColour(snap.state, true);
  const cy = h - 15;
  ctx.strokeStyle = 'rgba(255,255,255,.10)';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(26, cy);
  ctx.lineTo(w - 26, cy);
  ctx.stroke();
  if (snap.progress != null && snap.progress > 0.005) {
    ctx.strokeStyle = lit;
    ctx.shadowColor = lit;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(26, cy);
    ctx.lineTo(26 + (w - 52) * snap.progress, cy);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
}

// ── LAYOUT: four wells ─────────────────────────────────────────────────────
function drawWells(ctx, w, h, snap, t) {
  const pad = t.pad;
  const gap = 8;
  const cellW = (w - pad * 2 - gap) / 2;
  const cellH = 46;
  const lit = litColour(snap.state, t.glass);

  faceCells(snap).forEach((cell, i) => {
    const x = pad + (i % 2) * (cellW + gap);
    const y = t.top + 8 + Math.floor(i / 2) * (cellH + gap);
    panel(ctx, x, y, cellW, cellH, t);
    legend(ctx, cell.label, x + 10, y + 16, snap.running || snap.steps ? t.dim : t.faint);
    // An unknown is set smaller and in the faint ink: N/A and `--` are not readings, and printing
    // them at value size makes a dead node look like a busy one. A node NAME is a reading, but it
    // is prose — set smaller still, in the legend face, and cut to the well it has to live in.
    const unknown = unknownValue(cell.value);
    ctx.fillStyle = unknown ? t.faint : cell.lit ? lit : t.ink;
    // A state word is a word, not a figure: it is set in the legend face like the node name, one
    // size up because it is the well's whole reading rather than a caption for one.
    ctx.font = cell.name ? legendFont(13, 500) : cell.word ? legendFont(17, 600) : mono(unknown ? 18 : 22);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const valueY = y + cellH - 8;
    const prose = cell.name || cell.word;
    ctx.fillText(prose ? fitText(ctx, cell.value, cellW - 20) : cell.value, x + 10, valueY);
    if (cell.unit) {
      // Measure the VALUE in the font it was drawn in, before switching to the legend face — a
      // fudge factor here is how the unit ends up sitting on top of the number it belongs to.
      const vw = ctx.measureText(cell.value).width;
      ctx.fillStyle = t.dim;
      ctx.font = legendFont(11);
      ctx.fillText(cell.unit, x + 10 + vw + 7, valueY);
    }
  });
}

// ── LAYOUT: plate — hero steps-left, rate, tell-tale strip ─────────────────
function drawPlate(ctx, w, h, snap, t) {
  const lit = litColour(snap.state, t.glass);
  const rate = fmtRate(snap.rate);
  const pad = t.pad + 4;
  const top = t.top;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  const heroStep = stepReading(snap);
  legend(ctx, heroStep.name ? 'RUNNING' : 'STEPS LEFT', pad, top + 26, snap.steps ? t.dim : t.faint);
  ctx.fillStyle = snap.steps ? lit : t.faint;
  // Under the dome the reading is the only bright thing, so it is the only thing that glows.
  ctx.shadowColor = t.glass && snap.steps ? lit : 'transparent';
  ctx.shadowBlur = t.glass && snap.steps ? 16 : 0;
  if (heroStep.name) {
    // No steps yet, but we know which node is working: say so instead of a big N/A.
    ctx.fillStyle = t.dim;
    ctx.font = legendFont(15, 500);
    ctx.fillText(fitText(ctx, heroStep.value, w / 2 - pad), pad, top + 62);
  } else {
    ctx.font = mono(snap.steps ? 42 : 30);
    ctx.fillText(stepsLeft(snap), pad, top + 70);
  }
  ctx.shadowBlur = 0;

  legend(ctx, 'RATE', w - pad - 62, top + 26, rate ? t.dim : t.faint);
  ctx.textAlign = 'right';
  ctx.fillStyle = rate ? t.ink : t.faint;
  ctx.font = mono(26);
  ctx.fillText(rate ? rate.value : 'N/A', w - pad, top + 60);
  ctx.font = legendFont(11);
  ctx.fillStyle = rate ? t.dim : t.faint;
  ctx.fillText(rate ? rate.unit : '', w - pad, top + 74);
  ctx.textAlign = 'left';

  strip(ctx, t.pad, top + 84, w - t.pad * 2, clockCells(snap), lit, t, !t.glass);

  // The rack's own progress ornament: a hairline on the node's bottom edge. (The dome has its
  // capsule instead — one progress ornament per style, never both.)
  if (!t.glass) {
    ctx.fillStyle = 'rgba(0,0,0,.45)';
    ctx.fillRect(0, h - 4, w, 3);
    if (snap.progress != null) {
      ctx.fillStyle = lit;
      ctx.fillRect(0, h - 4, w * snap.progress, 3);
    }
  }
}

// ── LAYOUT: bar — the body IS the progress bar ─────────────────────────────
function drawBar(ctx, w, h, snap, t) {
  const pad = t.pad;
  const lit = litColour(snap.state, t.glass);
  const bh = 34;
  const by = t.top + 12;
  const bw = w - pad * 2;
  panel(ctx, pad, by, bw, bh, t);
  if (snap.progress != null) {
    const fw = Math.max(3, bw * snap.progress);
    ctx.save();
    rrect(ctx, pad, by, bw, bh, t.glass ? 7 : 4);
    ctx.clip();
    const g = ctx.createLinearGradient(0, by, 0, by + bh);
    if (t.glass) {
      g.addColorStop(0, 'rgba(127,199,255,.42)');
      g.addColorStop(1, 'rgba(127,199,255,.14)');
    } else {
      g.addColorStop(0, 'rgba(255,182,72,.55)');
      g.addColorStop(1, 'rgba(255,182,72,.22)');
    }
    ctx.fillStyle = snap.state === 'running' ? g : 'rgba(255,255,255,.10)';
    ctx.fillRect(pad, by, fw, bh);
    ctx.fillStyle = lit;
    ctx.fillRect(pad + fw - 2, by, 2, bh);
    ctx.restore();
  }
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const barStep = stepReading(snap);
  ctx.fillStyle = snap.steps ? (t.glass ? C.glassInk : '#fff') : barStep.name ? t.dim : t.faint;
  ctx.font = barStep.name ? legendFont(14, 500) : mono(20);
  ctx.fillText(
    barStep.name ? fitText(ctx, barStep.value, bw - 70) : snap.steps ? `${snap.step} / ${snap.max}` : 'N/A',
    pad + 10,
    by + bh / 2 + 1,
  );
  if (snap.progress != null) {
    ctx.textAlign = 'right';
    ctx.fillStyle = t.glass ? C.glassDim : 'rgba(255,255,255,.75)';
    ctx.font = mono(15);
    ctx.fillText(`${Math.round(snap.progress * 100)}%`, pad + bw - 10, by + bh / 2 + 1);
  }
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  const rate = fmtRate(snap.rate);
  strip(
    ctx,
    pad,
    by + bh + 8,
    bw,
    [
      { label: 'RATE', value: rate ? `${rate.value} ${rate.unit}` : 'N/A' },
      { label: 'ELAPSED', value: fmtSec(snap.elapsed) },
      endCell(snap),
    ],
    lit,
    t,
    false,
  );
}

// ── LAYOUT: trace — figures plus 60s of measured rate ──────────────────────
function drawTrace(ctx, w, h, snap, t) {
  const pad = t.pad;
  const top = t.top;
  const lit = litColour(snap.state, t.glass);
  const rate = fmtRate(snap.rate);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  const traceStep = stepReading(snap);
  legend(ctx, traceStep.name ? 'RUNNING' : 'STEPS LEFT', pad + 2, top + 24, snap.steps ? t.dim : t.faint);
  if (traceStep.name) {
    ctx.fillStyle = t.dim;
    ctx.font = legendFont(14, 500);
    ctx.fillText(fitText(ctx, traceStep.value, w / 2 - pad), pad + 2, top + 50);
  } else {
    ctx.fillStyle = snap.steps ? lit : t.faint;
    ctx.font = mono(snap.steps ? 34 : 24);
    ctx.fillText(stepsLeft(snap), pad + 2, top + 56);
  }

  // Value and unit share one line here (there is no room for a stacked unit above the trace), so
  // the unit's width is measured first and the value is right-aligned to clear it. `legend()` sets
  // its own textAlign, which is why the label is positioned by x rather than by alignment.
  legend(ctx, 'RATE', w - pad - 64, top + 24, rate ? t.dim : t.faint);
  ctx.font = legendFont(11);
  const unitW = rate ? ctx.measureText(rate.unit).width + 6 : 0;
  ctx.textAlign = 'right';
  ctx.fillStyle = rate ? t.ink : t.faint;
  ctx.font = mono(22);
  ctx.fillText(rate ? rate.value : 'N/A', w - pad - unitW, top + 54);
  if (rate) {
    ctx.textAlign = 'left';
    ctx.fillStyle = t.dim;
    ctx.font = legendFont(11);
    ctx.fillText(rate.unit, w - pad - unitW + 6, top + 54);
  }
  ctx.textAlign = 'left';

  const tx = pad;
  const ty = top + 62;
  const tw = w - pad * 2;
  const th = 42;
  panel(ctx, tx, ty, tw, th, t);
  trace(ctx, tx, ty, tw, th, snap.rateHistory, lit);
  legend(ctx, '60 S AGO', tx + 5, ty + th - 5, t.faint, 9, '1px');
  ctx.textAlign = 'right';
  ctx.fillStyle = t.faint;
  ctx.font = legendFont(9);
  ctx.fillText('NOW', tx + tw - 5, ty + th - 5);
  ctx.textAlign = 'left';

  strip(ctx, pad, ty + th + 6, tw, clockCells(snap), lit, t, false);
}

// ── VRAM ───────────────────────────────────────────────────────────────────
// The selection lives in devices.js; this only draws it. The SOURCE of the selection is printed
// next to the header, because "one card" means two different things on a four-card box: the graph
// pinned it, or nothing pinned anything so this is simply where ComfyUI runs.
const VRAM_ROW_H = 38;
const VRAM_HEAD_H = 26;
const VRAM_STRIP_ROW_H = 26;

export function vramHeight(gpu, t = THEMES.rack) {
  const rows = Math.max(1, gpu?.devices?.length || 1);
  return VRAM_HEAD_H + rows * VRAM_ROW_H + 8 + t.extraH;
}

export function vramStripHeight(gpu) {
  const rows = Math.max(1, gpu?.devices?.length || 1);
  return rows * VRAM_STRIP_ROW_H + 10;
}

function vramNote(gpu) {
  if (gpu?.error) return 'UNREACHABLE';
  if (gpu?.source === 'workflow') return 'SELECTED IN WORKFLOW';
  if (gpu?.source === 'primary') return 'COMFYUI DEVICE';
  if (gpu?.source === 'all') return 'ALL DEVICES';
  return gpu?.devices?.length ? '' : 'NO DATA';
}

/** One card on one line, for the strip bolted under another layout. */
function vramStripRow(ctx, x, y, w, device, t) {
  const vram = deviceVram(device);
  const label = (deviceLabel(device) || '?').toUpperCase();
  const name = shortDeviceName(device?.name);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = t.ink;
  ctx.font = mono(12);
  ctx.fillText(label, x, y + 10);
  const labelW = ctx.measureText(label).width;
  if (name) {
    ctx.fillStyle = t.faint;
    ctx.font = legendFont(9);
    ctx.fillText(name, x + labelW + 8, y + 10);
  }
  ctx.textAlign = 'right';
  ctx.fillStyle = vram ? t.ink : t.faint;
  ctx.font = mono(12);
  ctx.fillText(vram ? `${fmtGiB(vram.used)} / ${fmtGiB(vram.total)} GB` : 'N/A', x + w, y + 10);
  ctx.textAlign = 'left';

  const by = y + 15;
  ctx.fillStyle = t.glass ? 'rgba(255,255,255,.08)' : C.well;
  rrect(ctx, x, by, w, 5, 2.5);
  ctx.fill();
  if (vram) {
    ctx.save();
    rrect(ctx, x, by, w, 5, 2.5);
    ctx.clip();
    // Over 85% is the fault condition this readout exists to warn about — unlike a slow sampler,
    // "nearly full" on a card really is a problem, so it is the one place red is allowed.
    ctx.fillStyle = vram.fraction > 0.85 ? (t.glass ? C.xenonRed : C.red) : t.glass ? C.xenon : C.amber;
    ctx.fillRect(x, by, Math.max(2, w * vram.fraction), 5);
    ctx.restore();
  }
}

/** The strip: every selected card, under a layout that is otherwise about the job. */
export function drawVramStrip(ctx, w, y, gpu, t) {
  const pad = t.pad + 2;
  const devices = gpu?.devices || [];
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  if (!devices.length) {
    legend(ctx, 'VRAM', pad, y + 12, t.faint, 9, '1.6px');
    ctx.fillStyle = t.faint;
    ctx.font = mono(12);
    ctx.fillText('N/A', pad + 44, y + 12);
    return;
  }
  devices.forEach((device, i) => {
    vramStripRow(ctx, pad, y + 4 + i * VRAM_STRIP_ROW_H, w - pad * 2, device, t);
  });
}

/** The standalone VRAM layout: header, then a full row per card. */
function drawVram(ctx, w, h, snap, t) {
  const pad = t.pad;
  const top = t.top;
  const gpu = snap.gpu || {};
  const devices = gpu.devices || [];
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  legend(ctx, 'VRAM', pad + 2, top + 20, t.dim);
  // The accelerator is named because "CUDA:0" is what torch calls an AMD card too — a ROCm build
  // reports type "cuda" for a Radeon. The label stays as reported (it is what the workflow's own
  // device widget uses), and the stack is printed here so the row is not misread as an NVIDIA one.
  const note = [gpu.accel, vramNote(gpu)].filter(Boolean).join(' · ');
  ctx.textAlign = 'right';
  ctx.fillStyle = t.faint;
  ctx.font = legendFont(9);
  const prev = ctx.letterSpacing;
  ctx.letterSpacing = '1.4px';
  ctx.fillText(note, w - pad - 2, top + 20);
  ctx.letterSpacing = prev || '0px';
  ctx.textAlign = 'left';

  if (!devices.length) {
    panel(ctx, pad, top + VRAM_HEAD_H, w - pad * 2, VRAM_ROW_H - 6, t);
    ctx.fillStyle = t.faint;
    ctx.font = mono(18);
    ctx.fillText('N/A', pad + 10, top + VRAM_HEAD_H + 20);
    return;
  }

  devices.forEach((device, i) => {
    const y = top + VRAM_HEAD_H + i * VRAM_ROW_H;
    const vram = deviceVram(device);
    const label = (deviceLabel(device) || '?').toUpperCase();
    const name = shortDeviceName(device.name);

    ctx.fillStyle = t.ink;
    ctx.font = mono(13);
    ctx.fillText(label, pad + 2, y + 11);
    const labelW = ctx.measureText(label).width;
    if (name) {
      ctx.fillStyle = t.faint;
      ctx.font = legendFont(10);
      ctx.fillText(name, pad + 4 + labelW + 10, y + 11);
    }
    ctx.textAlign = 'right';
    ctx.fillStyle = vram ? t.ink : t.faint;
    ctx.font = mono(13);
    ctx.fillText(vram ? `${fmtGiB(vram.used)} / ${fmtGiB(vram.total)} GB` : 'N/A', w - pad - 2, y + 11);
    ctx.textAlign = 'left';

    const bx = pad + 2;
    const bw = w - pad * 2 - 4;
    const by = y + 17;
    ctx.fillStyle = t.glass ? 'rgba(255,255,255,.08)' : C.well;
    rrect(ctx, bx, by, bw, 8, t.glass ? 4 : 3);
    ctx.fill();
    if (!t.glass) {
      ctx.strokeStyle = 'rgba(0,0,0,.5)';
      ctx.lineWidth = 1;
      rrect(ctx, bx + 0.5, by + 0.5, bw - 1, 7, 3);
      ctx.stroke();
    }
    if (vram) {
      ctx.save();
      rrect(ctx, bx, by, bw, 8, t.glass ? 4 : 3);
      ctx.clip();
      ctx.fillStyle = vram.fraction > 0.85 ? (t.glass ? C.xenonRed : C.red) : t.glass ? C.xenon : C.amber;
      ctx.fillRect(bx, by, Math.max(2, bw * vram.fraction), 8);
      ctx.restore();
      ctx.fillStyle = t.faint;
      ctx.font = legendFont(9);
      ctx.textAlign = 'right';
      ctx.fillText(`${Math.round(vram.fraction * 100)}%`, w - pad - 2, y + 36);
      ctx.textAlign = 'left';
    }
  });
}

// ── the pack ───────────────────────────────────────────────────────────────
// One entry per node type. The keys MUST match NODE_CLASS_MAPPINGS in __init__.py — a name in one
// and not the other is a node that registers and then draws nothing, with no error to say why.
//
// `vram: true` bolts the card strip under the layout; the standalone VRAM node is its own layout.
// Style is a widget on the node, not a node of its own, so switching it keeps every wire.
const LAYOUTS = [
  { id: 'WatcherStepsWells', title: 'Four Wells', h: 116, draw: drawWells },
  { id: 'WatcherStepsPlate', title: 'Plate', h: 124, draw: drawPlate },
  { id: 'WatcherStepsBar', title: 'Bar', h: 96, draw: drawBar },
  { id: 'WatcherStepsTrace', title: 'Trace', h: 150, draw: drawTrace },
];

function makeFace(layout, withVram) {
  const height = (snap) => {
    const t = themeFor(snap?.style);
    return layout.h + t.extraH + (withVram ? vramStripHeight(snap?.gpu) : 0);
  };
  return {
    id: withVram ? `${layout.id}Vram` : layout.id,
    title: withVram ? `${layout.title} + VRAM` : layout.title,
    w: 300,
    h: layout.h,
    needsDevices: withVram,
    heightFor: height,
    draw(ctx, w, h, snap) {
      const t = themeFor(snap?.style);
      if (t.glass) drawDome(ctx, w, h);
      // The layout always gets its OWN height, never the node's: a taller node (a second card in
      // the strip) must not stretch the job readouts into it.
      layout.draw(ctx, w, layout.h + t.extraH, snap, t);
      if (withVram) drawVramStrip(ctx, w, layout.h + t.extraH - (t.glass ? 14 : 0), snap?.gpu, t);
      if (t.glass) domeProgress(ctx, w, h, snap);
    },
  };
}

export const FACES = {};
for (const layout of LAYOUTS) {
  for (const withVram of [false, true]) {
    const face = makeFace(layout, withVram);
    FACES[face.id] = face;
  }
}
// Two VRAM nodes, and the difference is WHICH CARDS, never how they are drawn: the scoped one
// answers "what is this job filling up", the other "what is this box doing". `allDevices` tells
// watcher-steps.js which device list to hand the face; the face itself cannot tell them apart, and
// prints the source so the viewer can.
function makeVramFace(id, title, allDevices) {
  return {
    id,
    title,
    w: 300,
    h: vramHeight(null),
    needsDevices: true,
    allDevices,
    heightFor: (snap) => vramHeight(snap?.gpu, themeFor(snap?.style)),
    draw(ctx, w, h, snap) {
      const t = themeFor(snap?.style);
      if (t.glass) drawDome(ctx, w, h);
      drawVram(ctx, w, h, snap, t);
    },
  };
}
FACES.WatcherVram = makeVramFace('WatcherVram', 'VRAM', false);
FACES.WatcherVramAll = makeVramFace('WatcherVramAll', 'VRAM (All GPUs)', true);
