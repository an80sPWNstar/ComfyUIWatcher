// Job state for the "Watcher · Steps" canvas node.
//
// PURE: no DOM, no ComfyUI imports, no timers — it is fed events and asked for a snapshot, so the
// same file is unit-tested from node (test/watcher-node.test.js) and runs in the ComfyUI frontend.
//
// The rate rules are the ones src/collectors/comfyui-client.js arrived at against a live server;
// they are restated here rather than shared, because this file has to run inside ComfyUI's page
// where the widget's collector does not exist. If one changes, change both:
//   - a 20s window, but ALWAYS keep the last 4 samples however old (a 15-30 s/it video sampler
//     would otherwise hold one sample and never report a rate at all);
//   - a repeated value is a duplicate message, not a stalled step (our own job arrives twice:
//     ComfyUI's targeted copy plus the relay's broadcast one) — skip it;
//   - a bar that RESTARTS on the same node is the next item of a batch: throw the window away,
//     or the first ~15s of every image measures a negative delta and reports no rate;
//   - a node change throws it away too (a tiled decode runs its own bar with its own max);
//   - but a KNOWN RATE IS NEVER REPLACED BY null inside one job — the last measurement is still
//     the honest answer while the next item's first interval is being measured.

/**
 * The node as the CANVAS knows it. A subgraph runs under ids like `193:120` — ComfyUI's DynamicPrompt
 * expansion, where 193 is the node you can actually see and 120 is one of the nodes it expanded into.
 * The execution messages carry `display_node` for exactly this, and fall back to splitting the id.
 *
 * The stage counter has to key on THIS, not on the raw id: the denominator counts workflow nodes, so
 * counting three expanded children as three stages inflates the position past its own total. Seen
 * live on Bryan's own graph the first time this ran (2026-08-17): `193:120`, `193:119` and `193:128`
 * were three stages of a 24-node run that only had one node 193 in it.
 *
 * The rate window still keys on the RAW id — each expanded child runs its own progress bar with its
 * own max, and splicing two of them together measures nothing.
 */
export function realNodeId(data) {
  const id = data?.display_node ?? data?.node;
  return id == null ? null : String(id).split(':')[0];
}

export const RATE_WINDOW_MS = 20000;
export const RATE_MIN_SAMPLES_KEPT = 4;
// How much rate history the Trace face plots. Per job, not per session: a trace that spans two
// different models is a chart of nothing.
export const TRACE_WINDOW_MS = 60000;

export class JobTracker {
  constructor() {
    this.reset();
    this.queueRemaining = null;
    // NOT cleared by reset(): the relay broadcasts the prompt's size BEFORE ComfyUI sends
    // execution_start, so a reset on that message would throw the denominator away every time.
    // It carries its own prompt_id and is only believed for the job it names.
    this._promptSize = null;
  }

  reset() {
    this.promptId = null;
    this.node = null;
    this.displayNode = null;
    this.step = null;
    this.max = null;
    // WHICH PART OF THE WORKFLOW IS RUNNING. A set, not a counter: a node that reports progress and
    // then reports it again is one node, and a subgraph can hand the same id back more than once.
    this._nodesRun = new Set();
    this.cachedNodes = 0;
    this.startedAtMs = null; // null when we never saw the job start: elapsed is then unknowable
    this.endedAtMs = null;
    this.state = 'idle'; // idle | running | success | error | interrupted
    this._samples = []; // {value, atMs, node}
    this._lastRate = null;
    this.rateHistory = []; // {atMs, rate} for the Trace face
  }

  /** A new prompt began (ours, or a foreign one seen through the relay's watcher.* copy). */
  onExecutionStart(data, now) {
    this.reset();
    this.promptId = data?.prompt_id ?? null;
    this.startedAtMs = now;
    this.state = 'running';
  }

  /** progress: {value, max, node, prompt_id} */
  onProgress(data, now) {
    if (!data || typeof data.value !== 'number') return;
    const promptId = data.prompt_id ?? null;
    // Progress for a different prompt, or the first progress after a finished job: start fresh.
    // Note the previous run's numbers stay on the node until this happens — a finished job's step
    // count and total time are worth reading, and blanking them the instant it ends is worse.
    if (this.state !== 'running' || (promptId && this.promptId && promptId !== this.promptId)) {
      const startedAt = promptId && promptId === this.promptId ? this.startedAtMs : null;
      this.reset();
      this.promptId = promptId;
      // We may have joined mid-job (page opened while something was running). Then there is no
      // start time and elapsed must read `--` rather than count from when we happened to look.
      this.startedAtMs = startedAt;
      this.state = 'running';
    }
    this.promptId = promptId ?? this.promptId;
    this.node = data.node ?? this.node;
    const real = realNodeId(data);
    if (real != null) {
      this._nodesRun.add(real);
      this.displayNode = real;
    }
    this.step = data.value;
    this.max = typeof data.max === 'number' ? data.max : this.max;

    const prev = this._samples[this._samples.length - 1];
    const nodeKey = data.node ?? null;
    const sameNode = prev && nodeKey === prev.node;
    if (prev && !sameNode) this._samples = [];
    else if (sameNode && data.value < prev.value) this._samples = []; // next batch item
    const dup = prev && sameNode && data.value === prev.value;
    if (!dup) this._samples.push({ value: data.value, atMs: now, node: nodeKey });

    const cutoff = now - RATE_WINDOW_MS;
    const windowed = this._samples.filter((s) => s.atMs >= cutoff);
    this._samples = windowed.length >= RATE_MIN_SAMPLES_KEPT
      ? windowed
      : this._samples.slice(-RATE_MIN_SAMPLES_KEPT);

    const rate = estimateRate(this._samples);
    if (rate != null) this._lastRate = rate;
    // The trace records what was MEASURED, at the moment it was measured. Nothing is recorded
    // before the first interval exists, so the pen starts where the readings start rather than at
    // a made-up zero.
    if (this._lastRate != null) {
      this.rateHistory.push({ atMs: now, rate: this._lastRate });
      const cut = now - TRACE_WINDOW_MS;
      while (this.rateHistory.length && this.rateHistory[0].atMs < cut) this.rateHistory.shift();
    }
  }

  /**
   * progress_state: {prompt_id, nodes: {id: {value, max, state}}} — what newer ComfyUI frontends
   * emit alongside (or instead of) `progress`. Take the node that is actually running; a finished
   * entry sits at value === max and would hold the readout at "done" for the whole graph.
   */
  onProgressState(data, now) {
    const nodes = data?.nodes;
    if (!nodes || typeof nodes !== 'object') return;
    let pick = null;
    for (const [id, n] of Object.entries(nodes)) {
      if (!n || typeof n.value !== 'number' || !(n.max > 0)) continue;
      if (n.state && n.state !== 'running') continue;
      if (!pick || n.value < n.max) pick = { id, n };
      if (n.value < n.max) break;
    }
    if (!pick) return;
    this.onProgress(
      {
        value: pick.n.value,
        max: pick.n.max,
        node: String(pick.id),
        // Its entries carry `real_node_id` for the same reason `executing` carries `display_node`:
        // the key is a DynamicPrompt id, which for a subgraph is not a node anyone can see.
        display_node: pick.n.real_node_id,
        prompt_id: data.prompt_id,
      },
      now,
    );
  }

  /** executing: {node, prompt_id}. node:null between two nodes is normal — it must not blank. */
  onExecuting(data, now) {
    if (!data) return;
    if (data.node == null) return;
    if (this.state !== 'running') {
      this.reset();
      this.promptId = data.prompt_id ?? null;
      this.startedAtMs = now;
      this.state = 'running';
    }
    if (data.node !== this.node) {
      // A new node runs its own bar; the old one's step count says nothing about this one.
      this._samples = [];
      this.step = null;
      this.max = null;
    }
    this.node = data.node;
    this.displayNode = realNodeId(data) ?? this.displayNode;
    if (this.displayNode != null) this._nodesRun.add(this.displayNode);
  }

  /**
   * execution_cached: {nodes: [id...], prompt_id} — the nodes this run will SKIP because their
   * output is already in the cache. They never emit `executing` (execution.py returns before that
   * send), so they are subtracted from the workflow size rather than counted as done: a second run
   * of the same graph would otherwise sit at "3 / 21" and finish there.
   */
  onExecutionCached(data, _now) {
    if (!Array.isArray(data?.nodes)) return;
    const promptId = data.prompt_id ?? null;
    if (promptId && this.promptId && promptId !== this.promptId) return;
    this.cachedNodes = data.nodes.length;
  }

  /**
   * watcher.prompt_nodes: {prompt_id, total} — OUR relay's message, and the only source of a
   * denominator. Nothing in ComfyUI's own protocol says how many nodes a run will execute; the
   * relay walks the prompt from its outputs and counts what is reachable (see __init__.py).
   * Without the relay this never arrives and the stage line honestly shows a position with no total.
   */
  onPromptNodes(data, _now) {
    const promptId = data?.prompt_id ?? null;
    const total = Number(data?.total);
    if (!promptId || !Number.isFinite(total) || total <= 0) return;
    this._promptSize = { promptId, total };
  }

  onExecutionEnd(kind, data, now) {
    if (data?.prompt_id && this.promptId && data.prompt_id !== this.promptId) return;
    this.state = kind; // success | error | interrupted
    this.endedAtMs = now;
    this._samples = [];
  }

  onStatus(data) {
    const n = data?.status?.exec_info?.queue_remaining;
    if (typeof n === 'number') this.queueRemaining = n;
  }

  isRunning() {
    return this.state === 'running';
  }

  /**
   * HOW FAR THROUGH THE WORKFLOW — the question the step count cannot answer. "STEP 7/20" is a
   * position inside ONE node; a graph that loads a checkpoint, encodes text, samples, upscales and
   * decodes spends most of its wall clock outside the sampler, and nothing on the face said which
   * of those was happening (Bryan, 2026-08-17).
   *
   * The position is COUNTED, never told to us: one entry per node seen executing this run. The
   * total needs the relay, exactly like the batch denominator does, so it is null on a stock
   * install and the face prints a bare position rather than inventing a graph size.
   *
   * The total FLOORS AT THE POSITION: a subgraph or a list expansion can run nodes the prompt never
   * listed, and "9 / 7" is a broken instrument. Null when nothing has run, so an idle node shows a
   * dash instead of "0".
   */
  stage() {
    const index = this._nodesRun.size;
    if (!index) return null;
    const size = this._promptSize?.promptId === this.promptId ? this._promptSize.total : null;
    const total = size == null ? null : Math.max(size - this.cachedNodes, index);
    return { index, total };
  }

  /**
   * Everything the face prints. Unknowns are null and the face prints N/A or `--` for them —
   * never a fabricated 0, and never an ETA without a measured rate.
   */
  snapshot(now) {
    const running = this.state === 'running';
    // max > 1, NOT max > 0. ComfyUI reports whole-node progress as 0/1 for everything that is not
    // a sampler — a checkpoint load, a text encode, a VAE decode — so `max > 0` painted "STEP 0/1"
    // over a 44-second model load, which reads as a one-step job that is stuck. A one-step bar is a
    // node saying "I am busy", not a step count, and the honest reading of it is no step data.
    const steps = typeof this.step === 'number' && this.max > 1;
    // THE LAST MEASURED RATE SURVIVES THE END OF THE JOB. The node is read after a run as often as
    // during one — "what did that take" is the question you ask when you come back to the machine —
    // and blanking the rate to N/A the instant the run ended threw away the one figure the node had
    // just spent the whole job measuring, while the step count and the elapsed time beside it stayed
    // (Bryan, 2026-08-16, off a finished 192/192 run). It is not passed off as live: the fourth well
    // says FINISHED, and the lit colour has already changed to the end state's.
    // It is still cleared by reset(), so a new run never inherits the old run's rate.
    const rate = this._lastRate;
    const elapsed = this.startedAtMs == null
      ? null
      : ((running ? now : this.endedAtMs ?? now) - this.startedAtMs) / 1000;
    // ETA COUNTS DOWN BETWEEN STEPS. `stepsLeft / rate` only changes when a step lands, so on a
    // MiniMax-H3 sampler at 20-30 s/it the figure sat frozen for half a minute and then jumped —
    // which reads as a stuck widget, not a slow job (Bryan, 2026-08-15).
    //
    // The step in flight is counted separately from the ones after it: the steps AFTER this one are
    // worth a full step-time each, and the one running right now is worth whatever is left of its
    // step-time. That drains smoothly at 1 second per second.
    //
    // AND IT STOPS AT THE END OF THE CURRENT STEP RATHER THAN RUNNING TO ZERO. If the job stalls,
    // the in-flight term floors at 0 and the ETA holds at the remaining whole steps — a countdown
    // that keeps ticking through a stall would promise a finish that is not coming.
    let eta = null;
    if (running && steps && rate) {
      const left = Math.max(0, this.max - this.step);
      const stepTime = 1 / rate;
      const last = this._samples.length ? this._samples[this._samples.length - 1].atMs : null;
      const since = last == null ? 0 : Math.max(0, (now - last) / 1000);
      eta = left === 0 ? 0 : (left - 1) * stepTime + Math.max(0, stepTime - since);
    }
    return {
      state: this.state,
      running,
      steps,
      step: this.step,
      max: this.max,
      node: this.node,
      // The id to look up on the canvas: a subgraph child is not on it, its parent is.
      displayNode: this.displayNode,
      stage: this.stage(),
      rate,
      elapsed,
      eta,
      progress: steps ? this.step / this.max : null,
      rateHistory: this.rateHistory,
      queueRemaining: this.queueRemaining,
    };
  }
}

/**
 * Average of the per-step intervals, dropping anything over 3x the median as a pause rather than
 * a step. A checkpoint write or a model load inside the window otherwise halves the figure and
 * the ETA with it; a plain (last - first) / elapsed cannot tell the two apart.
 */
export function estimateRate(samples) {
  if (!samples || samples.length < 2) return null;
  const perStep = [];
  for (let i = 1; i < samples.length; i++) {
    const dtSec = (samples[i].atMs - samples[i - 1].atMs) / 1000;
    const dSteps = samples[i].value - samples[i - 1].value;
    if (dtSec <= 0 || dSteps <= 0) continue;
    perStep.push(dtSec / dSteps);
  }
  if (!perStep.length) return null;
  const sorted = [...perStep].sort((a, b) => a - b);
  // Lower of the two middles on an even count, on purpose: the pathological interval is always
  // the long one, so discarding the larger side is the correction wanted.
  const median = sorted[Math.floor((sorted.length - 1) / 2)];
  let steps = 0;
  let secs = 0;
  for (let i = 1; i < samples.length; i++) {
    const dtSec = (samples[i].atMs - samples[i - 1].atMs) / 1000;
    const dSteps = samples[i].value - samples[i - 1].value;
    if (dtSec <= 0 || dSteps <= 0) continue;
    if (dtSec / dSteps > median * 3) continue; // a pause, not a step
    steps += dSteps;
    secs += dtSec;
  }
  if (steps <= 0 || secs <= 0) return null;
  return steps / secs;
}

/** it/s above 1, s/it below — the same cutover the widget's RATE legend uses. */
export function fmtRate(r) {
  if (r == null) return null;
  return r >= 1 ? { value: r.toFixed(2), unit: 'it/s' } : { value: (1 / r).toFixed(2), unit: 's/it' };
}

export function fmtSec(s) {
  if (s == null) return '--';
  s = Math.round(s);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm' + String(s % 60).padStart(2, '0') + 's';
  return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm';
}
