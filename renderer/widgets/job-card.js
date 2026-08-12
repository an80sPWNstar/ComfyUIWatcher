// One card per configured ComfyUI host. Plain function, no framework — same pattern as
// guiTOP's renderer/widgets: build/update DOM directly, escape all text content.
//
// Layout (2026-08-12 rack rebuild, Bryan picked the direction): each host is a module in a
// rack — bolted faceplate, engraved nameplate, jewel lamp, two recessed instrument wells, and
// an LED bargraph along the bottom. The wells are the two things worth reading across a room:
// a moving-coil meter for sampling rate (left) and the seven-segment count of steps remaining
// in the current node (right). Primitives live in widgets/lcd.js.
//
// The honesty rules from the previous build are unchanged and are the reason for the odd-looking
// branches below: no step data means the numerals read "N/A", never a fabricated 0, and no rate
// means the needle sits at its stop under a NO SIGNAL legend rather than resting at some value.

// Compact on purpose — "3m35s", not "3m 35s". These sit in a narrow legend row where a space
// cost the tail of the value to an ellipsis at the 330px minimum card width.
function fmtSec(s) {
  if (s == null || !Number.isFinite(s)) return '--';
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  if (m < 60) return `${m}m${rem}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

// The meter shows the rate; this is the same number in words, for the one case a needle can't
// serve — reading the exact figure. ComfyUI flips its own readout at 1 it/s, so this does too.
function fmtRate(stepsPerSec) {
  if (stepsPerSec == null || !Number.isFinite(stepsPerSec) || stepsPerSec <= 0) return '--';
  if (stepsPerSec >= 1) return `${stepsPerSec.toFixed(2)} it/s`;
  return `${(1 / stepsPerSec).toFixed(2)} s/it`;
}

const SEGMENT_COUNT = 28; // LED cells in the bargraph

function legendValue(label, valueClass) {
  const wrap = document.createElement('div');
  wrap.className = 'jc-legend';
  const l = document.createElement('span');
  l.className = 'jc-legend-label';
  l.textContent = label;
  const v = document.createElement('span');
  v.className = `jc-legend-value ${valueClass}`;
  v.textContent = '--';
  wrap.append(l, v);
  return wrap;
}

// Job-identity row: silkscreen label over the value, stacked, so a long model name gets the
// full width of the plate to itself before it has to ellipsise.
function identRow(label, valueClass) {
  const row = document.createElement('div');
  row.className = 'jc-ident-row';
  const l = document.createElement('span');
  l.className = 'jc-ident-label';
  l.textContent = label;
  const v = document.createElement('span');
  v.className = `jc-ident-value ${valueClass}`;
  row.append(l, v);
  return row;
}

function createCard(hostName) {
  const card = document.createElement('div');
  card.className = 'job-card';
  card.dataset.host = hostName;

  // Four corner screws. Decorative, but they are what makes the card read as a bolted-in
  // module rather than another rounded panel — the whole direction rests on them.
  for (const corner of ['tl', 'tr', 'bl', 'br']) {
    const bolt = document.createElement('span');
    bolt.className = `jc-bolt jc-bolt--${corner}`;
    card.appendChild(bolt);
  }

  // ── Faceplate header: jewel lamp + engraved nameplate + queue counter + status ──
  const head = document.createElement('div');
  head.className = 'jc-head';
  const jewel = document.createElement('span');
  jewel.className = 'jc-jewel';
  const name = document.createElement('span');
  name.className = 'jc-name';
  name.textContent = hostName;
  const queue = document.createElement('span');
  queue.className = 'jc-queue';
  queue.title = 'Prompts waiting in this host’s queue';
  const status = document.createElement('span');
  status.className = 'jc-status';
  head.append(jewel, name, queue, status);

  // ── Instrument wells ──
  const body = document.createElement('div');
  body.className = 'jc-body';

  const meterWell = document.createElement('div');
  meterWell.className = 'jc-well jc-well--meter';
  const meter = window.Widgets.createRateMeter();
  const meterLegend = document.createElement('div');
  meterLegend.className = 'jc-well-legend';
  meterLegend.textContent = 'Sampling Rate';
  meterWell.append(meter.el, meterLegend);

  const readWell = document.createElement('div');
  readWell.className = 'jc-well jc-well--readout';
  const lcd = window.Widgets.createSevenSeg(3);
  const lcdLegend = document.createElement('div');
  lcdLegend.className = 'jc-well-legend jc-well-legend--over';
  lcdLegend.textContent = 'Steps Left';
  // Legend sits directly above its own numerals, left-aligned with them. Parked to the right of
  // the digits it read as a caption for the meter in the next well over.
  const readoutMain = document.createElement('div');
  readoutMain.className = 'jc-readout-main';
  readoutMain.append(lcdLegend, lcd.el);

  // Right of the numerals: what this job actually IS, so two running hosts are tellable apart
  // at a glance. Metadata only — model filename and latent size, never prompt text.
  // Model gets the full width (names are long); size and frames share the row below, each with
  // its own label — a frame count is its own quantity, not a suffix on the dimensions.
  const ident = document.createElement('div');
  ident.className = 'jc-ident';
  const identPair = document.createElement('div');
  identPair.className = 'jc-ident-pair';
  // Second slot is the count, and what it counts depends on the job: frames for a video latent,
  // batch size for an image one. One row, relabelled — two rows would leave a dead label on
  // every job, since no job has both.
  identPair.append(identRow('Size', 'jc-size'), identRow('Frames', 'jc-count'));
  ident.append(identRow('Model', 'jc-model'), identPair);

  const readout = document.createElement('div');
  readout.className = 'jc-readout';
  readout.append(readoutMain, ident);

  const node = document.createElement('div');
  node.className = 'jc-node';
  const times = document.createElement('div');
  times.className = 'jc-times';
  times.append(
    legendValue('Elapsed', 'jc-elapsed'),
    legendValue('ETA', 'jc-eta'),
    legendValue('Rate', 'jc-rate'),
  );
  readWell.append(readout, node, times);

  body.append(meterWell, readWell);

  // ── LED bargraph ──
  const bar = document.createElement('div');
  bar.className = 'jc-bar';
  const track = document.createElement('div');
  track.className = 'jc-bar-track';
  const fill = document.createElement('div');
  fill.className = 'jc-bar-fill';
  const cells = document.createElement('div');
  cells.className = 'jc-bar-cells';
  cells.style.setProperty('--cells', String(SEGMENT_COUNT));
  track.append(fill, cells);
  const meta = document.createElement('div');
  meta.className = 'jc-bar-meta';
  const step = document.createElement('span');
  step.className = 'jc-step';
  const pct = document.createElement('span');
  pct.className = 'jc-pct';
  meta.append(step, pct);
  bar.append(track, meta);

  card.append(head, body, bar);

  // Handles the update path needs but can't cheaply re-query (both instruments own internal nodes).
  card._parts = { meter, lcd };
  return card;
}

function updateCard(card, hostName, snapshot) {
  const { meter, lcd } = card._parts;
  card.querySelector('.jc-name').textContent = hostName;

  const status = snapshot?.status ?? 'offline';
  const statusEl = card.querySelector('.jc-status');
  statusEl.textContent = status;
  statusEl.className = `jc-status jc-status--${status}`;
  card.dataset.status = status;

  const job = snapshot?.currentJob;
  const nodeEl = card.querySelector('.jc-node');
  const fill = card.querySelector('.jc-bar-fill');
  const stepEl = card.querySelector('.jc-step');
  const pctEl = card.querySelector('.jc-pct');

  card.classList.toggle('job-card--finished-success', job?.finished === 'success');
  card.classList.toggle('job-card--finished-error', job?.finished === 'error');
  card.classList.toggle('job-card--running', !!job && !job.finished);
  // No job at all: the module collapses to a blanking panel — nameplate, lamp, one state word.
  // A dark meter and an N/A readout would be three rows of furniture reporting nothing, and a
  // watcher is normally looking at a rack where most hosts are idle.
  card.classList.toggle('job-card--blank', !job);

  // Real step data means a numeric max AND a step to subtract from it. Anything else is N/A —
  // never a fabricated 0. Foreign jobs on a host without the relay node land here by design.
  const hasSteps = job != null && job.maxSteps != null && Number.isFinite(job.maxSteps) && job.maxSteps > 0;
  const done = hasSteps ? Math.min(job.maxSteps, job.step ?? 0) : null;
  const ratio = hasSteps ? done / job.maxSteps : null;
  // Running, but nothing to fill the bargraph with (model load, or a host without the relay
  // node): the track sweeps instead of sitting dead-empty.
  card.classList.toggle('job-card--stepless', !!job && !job.finished && !hasSteps);

  if (job && job.finished) {
    // Held "just finished" state — the collector keeps it ~10s, elapsed is frozen. The needle
    // falls back to its stop because nothing is sampling any more.
    const ok = job.finished === 'success';
    meter.setRate(null);
    if (ok) lcd.setValue(0);
    else if (hasSteps) lcd.setValue(job.maxSteps - done);
    else lcd.setText('N/A');
    nodeEl.textContent = ok ? 'Finished' : 'Failed';
    fill.style.width = ok ? '100%' : `${hasSteps ? ratio * 100 : 0}%`;
    stepEl.textContent = hasSteps ? `Step ${done} / ${job.maxSteps}` : '';
    pctEl.textContent = ok ? '100%' : hasSteps ? `${Math.round(ratio * 100)}%` : '';
    setLegend(card, '.jc-elapsed', fmtSec(job.elapsedSec));
    setLegend(card, '.jc-eta', '--');
    setLegend(card, '.jc-rate', '--');
  } else if (job) {
    meter.setRate(job.stepsPerSec ?? null);
    if (hasSteps) lcd.setValue(job.maxSteps - done);
    else lcd.setText('N/A');
    nodeEl.textContent = job.node ? job.nodeName ?? job.node : 'Running';
    fill.style.width = hasSteps ? `${ratio * 100}%` : '0%';
    stepEl.textContent = hasSteps ? `Step ${done} / ${job.maxSteps}` : 'No step data';
    pctEl.textContent = hasSteps ? `${Math.round(ratio * 100)}%` : '';
    setLegend(card, '.jc-elapsed', fmtSec(job.elapsedSec));
    setLegend(card, '.jc-eta', job.etaSec != null ? fmtSec(job.etaSec) : '--');
    setLegend(card, '.jc-rate', fmtRate(job.stepsPerSec));
  } else {
    meter.setRate(null);
    lcd.setText('N/A');
    nodeEl.textContent = status === 'online' ? 'Idle' : snapshot?.lastError ? 'Unreachable' : '--';
    fill.style.width = '0%';
    stepEl.textContent = '';
    pctEl.textContent = '';
    setLegend(card, '.jc-elapsed', '--');
    setLegend(card, '.jc-eta', '--');
    setLegend(card, '.jc-rate', '--');
  }

  // Job identity. Absent on a graph whose loader nodes we don't recognise, and on any host
  // where the poller hasn't seen the running graph yet — the row hides rather than showing "--",
  // because an empty label is quieter than a placeholder that never fills in.
  setIdent(card, '.jc-model', job?.model ?? null);
  setIdent(card, '.jc-size', job?.size ?? null);
  if (job?.frames != null) setIdent(card, '.jc-count', String(job.frames), 'Frames');
  else setIdent(card, '.jc-count', job?.batch != null ? String(job.batch) : null, 'Batch Size');

  // A well's legend lights in the card colour only while that instrument is actually reading
  // something — steps present for the readout, a rate for the meter. Same honesty rule as the
  // numerals: lit means live, not merely present.
  const rateLive = !!job && !job.finished && Number.isFinite(job.stepsPerSec) && job.stepsPerSec > 0;
  card.querySelector('.jc-well--readout').classList.toggle('jc-well--live', hasSteps);
  card.querySelector('.jc-well--meter').classList.toggle('jc-well--live', rateLive);

  const queueEl = card.querySelector('.jc-queue');
  const q = snapshot?.queueRemaining;
  queueEl.textContent = q != null ? `Queue ${q}` : '';
  queueEl.classList.toggle('jc-queue--active', !!q);
}

// Cards are removed when a host leaves the config. The meter registers itself with the shared
// needle-animation loop, so a dropped card has to say so or it animates forever.
function destroyCard(card) {
  card._parts?.meter?.destroy();
}

function setIdent(card, sel, text, label) {
  const el = card.querySelector(sel);
  el.textContent = text ?? '';
  el.title = text ?? ''; // full value on hover — the plate ellipsises long model names
  const row = el.closest('.jc-ident-row');
  if (label) row.querySelector('.jc-ident-label').textContent = label;
  row.classList.toggle('jc-ident-row--empty', !text);
}

function setLegend(card, sel, text) {
  const el = card.querySelector(sel);
  el.textContent = text;
  el.classList.toggle('jc-legend-value--empty', text === '--' || text === '');
}

// Plain <script> include (no bundler, no CommonJS in the renderer) — same pattern guiTOP's
// widgets use. Expose via a small global namespace instead of module.exports.
window.Widgets = window.Widgets || {};
window.Widgets.createCard = createCard;
window.Widgets.updateCard = updateCard;
window.Widgets.destroyCard = destroyCard;
