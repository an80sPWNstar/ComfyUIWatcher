// One collector per configured AI-Toolkit host. Pure REST polling — unlike ComfyUI there is no
// WebSocket and none is needed: ai-toolkit's UI server (Next.js, default port 8675) keeps every
// job's live step count in its own SQLite row, and the API hands it over.
//
// Endpoints used (verified against D:\ai-toolkit\ui\src\app\api, 2026-08-13):
//   GET /api/jobs?only_active=true&job_type=train
//       -> {jobs: [...]} where a job row is the Prisma `Job` model: {id, name, status, step,
//          total_steps, speed_string, info, gpu_ids, job_config (JSON string), created_at, ...}.
//       SERVER-CACHED FOR 5s (ui/src/server/apiCache) — good enough for discovering jobs, too
//       stale to measure a rate from, hence the by-id call below.
//   GET /api/jobs?id=<id>            -> one job row, UNCACHED. This is what the rate comes from.
//   GET /api/jobs/<id>/loss?since_step=N -> {points: [{step, wall_time, value}]}, ascending.
//       Opens a per-job sqlite file server-side, so it is polled far more slowly than the rest.
//
// Auth: the UI only requires it when AI_TOOLKIT_AUTH is set in its environment (ui/src/
// middleware.ts); then every request needs `Authorization: Bearer <token>`. Host config carries
// an optional token for that case.
//
// TWO TRAPS, both found in Bryan's live DB rather than in the source:
//   1. `total_steps` LIES. The running H3 job reads step 4204 / total_steps 2500 while its own
//      job_config says 5000. Steps come from job_config first, the column only as a fallback.
//   2. Most rows are CAPTION jobs (11 of 17), tiny and irrelevant to a training watcher. Always
//      filter job_type=train.

const TICK_MS = 500; // snapshot push, so elapsed/ETA tick between polls (matches ComfyUIClient)
const POLL_MS = 1000; // job list + tracked job detail
const LOSS_POLL_MS = 10000; // loss opens a sqlite file server-side — poll it an order slower
// Longer than the poll interval on purpose: a slow answer is not a failure, a silent one is.
const REQUEST_TIMEOUT_MS = 8000;
const FINISHED_HOLD_MS = 10000; // how long a finished run stays on the card before clearing

// Training rate is measured over a MUCH longer window than sampling. A 30 s/it LoKr run (Bryan's
// slowest recorded job) advances one step per 30s, so ComfyUI's 15s window would usually contain
// zero step changes and report "no rate" on a perfectly healthy run. 180s holds ~6 samples even
// at that speed, and a trainer's rate is stable enough that the slower response costs nothing.
const RATE_WINDOW_MS = 180000;

const ACTIVE_STATUSES = new Set(['running', 'queued', 'stopping']);

class AIToolkitClient {
  /**
   * @param {{name: string, url: string, kind?: string, token?: string}} host
   * @param {(hostName: string, snapshot: object) => void} onUpdate
   */
  constructor(host, onUpdate) {
    this.host = host;
    this.onUpdate = onUpdate;
    this.status = 'connecting'; // connecting | online | offline
    this.lastError = null;
    this.queueRemaining = null;
    this.currentJob = null;
    this._stepHistory = []; // [{value, atMs}] — only pushed when the step actually changes
    this._tickTimer = null;
    this._pollTimer = null;
    this._lossTimer = null;
    this._pollInFlight = false;
    this._lossInFlight = false;
    this._closed = false;
  }

  start() {
    this._closed = false;
    this._poll();
    this._tickTimer = setInterval(() => this._emit(), TICK_MS);
    this._pollTimer = setInterval(() => this._poll(), POLL_MS);
    this._lossTimer = setInterval(() => this._pollLoss(), LOSS_POLL_MS);
  }

  stop() {
    this._closed = true;
    clearInterval(this._tickTimer);
    clearInterval(this._pollTimer);
    clearInterval(this._lossTimer);
  }

  _headers() {
    return this.host.token ? { Authorization: `Bearer ${this.host.token}` } : undefined;
  }

  async _get(path) {
    // Every request is bounded. Without this a half-open connection (host asleep, VPN dropped)
    // hangs the await forever, `_pollInFlight` never clears, and the card sits on stale data with
    // no path back — the one failure mode a poller cannot recover from by itself.
    const res = await fetch(this.host.url + path, {
      headers: this._headers(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async _poll() {
    if (this._pollInFlight || this._closed) return;
    this._pollInFlight = true;
    try {
      const list = await this._get('/api/jobs?only_active=true&job_type=train');
      this.status = 'online';
      this.lastError = null;
      const active = Array.isArray(list?.jobs) ? list.jobs.filter((j) => ACTIVE_STATUSES.has(j.status)) : [];
      this._applyActive(active);

      // The active list is served from a 5s cache, so a rate measured off it would quantise to
      // 5s buckets. Re-read the tracked job uncached.
      if (this.currentJob && !this.currentJob.finished && this.currentJob.jobId) {
        const fresh = await this._get(`/api/jobs?id=${encodeURIComponent(this.currentJob.jobId)}`);
        // sample: true — this is the ONE read the rate window is allowed to see.
        if (fresh && fresh.id === this.currentJob.jobId) this._applyJob(fresh, true);
      }
      this._emit();
    } catch (err) {
      // Any transport failure means the UI server is down or unreachable: this collector has no
      // second channel to fall back on, unlike the ComfyUI one.
      this.status = 'offline';
      this.lastError = String(err && err.message ? err.message : err);
      this.currentJob = null;
      this._stepHistory = [];
      this._emit();
    } finally {
      this._pollInFlight = false;
    }
  }

  /**
   * Reconcile the active-job list against what the card is showing.
   * One card shows ONE job. ai-toolkit can run several at once on different GPUs; the oldest
   * running job wins the instrument and the rest are counted into the queue figure, rather than
   * flickering between them.
   */
  _applyActive(active) {
    const running = active
      .filter((j) => j.status === 'running' || j.status === 'stopping')
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const shown = running[0] ?? null;
    // Everything active that is not on the instrument is "waiting", including any extra runs.
    this.queueRemaining = active.length - (shown ? 1 : 0);

    if (!shown) {
      // The tracked job left the active list. Resolve what happened to it — a training run ending
      // is the one moment worth holding on the card.
      if (this.currentJob && !this.currentJob.finished && this.currentJob.jobId) {
        this._resolveFinished(this.currentJob.jobId);
      }
      return;
    }
    if (!this.currentJob || this.currentJob.jobId !== shown.id) {
      this.currentJob = { jobId: shown.id };
      this._stepHistory = [];
    }
    // sample: false — this row came off the 5s-cached list. See _applyJob.
    this._applyJob(shown, false);
  }

  /**
   * Fold one job row into currentJob.
   *
   * @param sample whether this row may feed the rate window. ONLY the uncached `?id=` read may.
   *   _applyJob runs twice per poll — once on the cached list row, once on the fresh one — and
   *   those two disagree by a step or two while arriving milliseconds apart. Sampling both put
   *   pairs like "+2 steps in 5ms" into the window, and since half of all intervals were that
   *   shape the median sat right on them: measured live 2026-08-13 as 200 steps/sec (0.005 s/it)
   *   with a 3-second ETA on a run half an hour from done. A stub cannot catch this — it serves
   *   both endpoints from one number, so the skew that causes it does not exist.
   */
  _applyJob(row, sample = false) {
    const job = this.currentJob;
    if (!job || job.jobId !== row.id) return;
    const now = Date.now();
    const cfg = parseJobConfig(row.job_config);

    job.name = row.name ?? null;
    job.model = cfg.model;
    job.size = cfg.resolution;
    job.rank = cfg.rank;
    // job_config's step count is authoritative; the column disagrees on live jobs (see header).
    job.maxSteps = cfg.steps ?? (Number.isFinite(row.total_steps) ? row.total_steps : null);
    // The cached list row can be up to 5s behind the fresh one, so it must never drag the shown
    // step backwards — a counter that goes down once a second reads as a fault that isn't there.
    const step = Number.isFinite(row.step) ? row.step : null;
    if (step != null && (job.step == null || step >= job.step)) job.step = step;
    job.state = row.status;
    // ai-toolkit narrates itself in `info`: "Model Loaded", "Loading dataset", and so on. This is
    // the only account of what a run is doing during the minutes before the first step lands —
    // the whole card is otherwise "running, no data" through model load and dataset caching.
    job.phase = typeof row.info === 'string' && row.info.trim() ? row.info.trim() : null;

    if (sample && job.step != null) {
      const prev = this._stepHistory[this._stepHistory.length - 1];
      // Only a CHANGED step is a sample. Polling at 1s while a step takes 30s would otherwise
      // fill the window with duplicates and read as a rate of zero.
      if (!prev || prev.value !== job.step) {
        this._stepHistory.push({ value: job.step, atMs: now });
        if (job.firstSeenStep == null) {
          job.firstSeenStep = job.step;
          job.firstSeenAtMs = now;
        }
      }
      const cutoff = now - RATE_WINDOW_MS;
      this._stepHistory = this._stepHistory.filter((p) => p.atMs >= cutoff);
    }

    const rate = this._estimateStepsPerSec();
    job.stepsPerSec = rate;
    job.etaSec = rate > 0 && job.maxSteps != null && job.step != null
      ? Math.max(0, (job.maxSteps - job.step) / rate)
      : null;
  }

  /**
   * MEDIAN of the per-step intervals in the window, not (last - first) / elapsed.
   *
   * Measured live on 2026-08-13 against a real restarting H3 run: the job sat on step 5250 for
   * 131 seconds loading its model, then stepped every ~2s. First-to-last gave 45.07 s/it and a
   * 9h21m ETA on a run that was ~25 minutes from finishing. One stalled sample poisons an
   * average for the whole 180s window, and this is not an edge case — ai-toolkit pauses to write
   * a checkpoint every `save_every` steps (250 on his runs) and to render samples, so a long gap
   * lands in the window regularly.
   *
   * A median throws that gap away as long as most intervals are normal. Even-count medians take
   * the LOWER of the two middles on purpose: the pathological interval is always the long one, so
   * discarding the larger side is exactly the correction wanted.
   */
  _estimateStepsPerSec() {
    const h = this._stepHistory;
    // Two samples is one interval, and one interval cannot outvote a stall — wait for a third.
    // Rate reads "--" until then, which is the honest answer while a run is still loading.
    if (h.length < 3) return null;
    const perStep = [];
    for (let i = 1; i < h.length; i++) {
      const dtSec = (h[i].atMs - h[i - 1].atMs) / 1000;
      const dSteps = h[i].value - h[i - 1].value;
      // A poll can miss steps, so normalise by however many actually passed.
      if (dtSec > 0 && dSteps > 0) perStep.push(dtSec / dSteps);
    }
    if (perStep.length < 2) return null;
    const sorted = [...perStep].sort((a, b) => a - b);
    const median = sorted[Math.floor((sorted.length - 1) / 2)];
    // Throw out stalls, then AVERAGE what is left rather than taking the median itself. Polling
    // once a second quantises every interval to whole seconds, so a real 2.7 s/it run produces
    // 2s and 3s intervals and a median snaps to one of them — measured 3.02 s/it live against a
    // job the trainer itself reported at 2.55-2.85. Averaging many intervals cancels that; the
    // 3x-median cut is what keeps a 131s model load or a 60s checkpoint out of the average.
    let steps = 0;
    let secs = 0;
    for (let i = 1; i < h.length; i++) {
      const dtSec = (h[i].atMs - h[i - 1].atMs) / 1000;
      const dSteps = h[i].value - h[i - 1].value;
      if (dtSec <= 0 || dSteps <= 0) continue;
      if (dtSec / dSteps > median * 3) continue; // a pause, not a step
      steps += dSteps;
      secs += dtSec;
    }
    return secs > 0 && steps > 0 ? steps / secs : null;
  }

  /**
   * A tracked job disappeared from the active list: read its final row.
   * `completed` is a success. `error` is a failure. `stopped` is neither — the user pressed stop,
   * and painting the module red for that would be a lie, so it just clears.
   */
  async _resolveFinished(jobId) {
    try {
      const row = await this._get(`/api/jobs?id=${encodeURIComponent(jobId)}`);
      if (!this.currentJob || this.currentJob.jobId !== jobId) return;
      if (!row || row.status === 'stopped' || row.status === 'queued') {
        this.currentJob = null;
        return;
      }
      this.currentJob.finished = row.status === 'error' ? 'error' : 'success';
      this.currentJob.finishedAtMs = Date.now();
      this.currentJob.stateText = row.status === 'error' ? 'Failed' : 'Trained';
      if (Number.isFinite(row.step)) this.currentJob.step = row.step;
    } catch {
      this.currentJob = null;
    }
  }

  /**
   * Latest loss value. Asked for only what is new since the last sample, so the payload shrinks
   * to a handful of rows after the first call. The endpoint returns points ASCENDING, so the
   * newest is the last element.
   */
  async _pollLoss() {
    const job = this.currentJob;
    if (this._closed || this._lossInFlight || !job || job.finished || !job.jobId) return;
    this._lossInFlight = true;
    try {
      // First call: don't drag in an entire run's history, just the recent tail.
      const since = job.lossStep ?? Math.max(0, (job.step ?? 0) - 50);
      const data = await this._get(`/api/jobs/${encodeURIComponent(job.jobId)}/loss?since_step=${since}`);
      const points = Array.isArray(data?.points) ? data.points : [];
      const last = points[points.length - 1];
      if (last && Number.isFinite(last.value) && this.currentJob === job) {
        job.loss = last.value;
        job.lossStep = last.step;
      }
    } catch {
      // No loss_log.db yet (the run has not written one), or the job vanished. Not an error —
      // the LOSS legend simply stays "--".
    } finally {
      this._lossInFlight = false;
    }
  }

  _emit() {
    // A stopped collector must never speak again: an in-flight _poll can resolve after stop(),
    // when WatcherService has already deleted this host's snapshot — one late emit would re-add
    // it and leave a ghost card in the rack forever. Same guard as ComfyUIClient.
    if (this._closed) return;
    const now = Date.now();
    if (
      this.currentJob &&
      this.currentJob.finished &&
      this.currentJob.finishedAtMs &&
      now - this.currentJob.finishedAtMs >= FINISHED_HOLD_MS
    ) {
      this.currentJob = null;
    }
    const job = this.currentJob;
    this.onUpdate(this.host.name, {
      host: this.host,
      status: this.status,
      lastError: this.lastError,
      queueRemaining: this.queueRemaining,
      system: null,
      currentJob: job
        ? {
            jobId: job.jobId ?? null,
            node: job.jobId ?? null, // the card treats a truthy node as "there is something to name"
            nodeName: job.finished
              ? job.stateText ?? 'Finished'
              : job.state === 'stopping' ? 'Stopping' : jobLabel(job),
            phase: job.finished ? null : job.phase ?? null,
            model: job.model ?? null,
            size: job.size ?? null,
            rank: job.rank ?? null,
            loss: Number.isFinite(job.loss) ? job.loss : null,
            step: job.step ?? null,
            maxSteps: job.maxSteps ?? null,
            stepsPerSec: job.finished ? null : job.stepsPerSec ?? null,
            etaSec: job.finished ? null : job.etaSec ?? null,
            // ELAPSED IS ONLY KNOWN FOR A RUN WE WATCHED FROM THE START. ai-toolkit stores no
            // training start time (created_at is when the job was *made*, and a queued job can
            // sit for hours), so for a run already in progress when the widget launched there is
            // no honest number — the card shows "--" rather than time-since-we-noticed.
            elapsedSec: job.firstSeenStep === 0 && job.firstSeenAtMs
              ? ((job.finishedAtMs ?? now) - job.firstSeenAtMs) / 1000
              : null,
            finished: job.finished ?? null,
          }
        : null,
    });
  }
}

/** "w1f3y_h3_v1" is more use on the node strip than the word "Training" repeated on every card. */
function jobLabel(job) {
  return job.name ? `Training · ${job.name}` : 'Training';
}

// ---- job_config parsing (metadata only — never dataset contents or captions) ----

/**
 * ai-toolkit stores the whole job YAML as a JSON string:
 *   {config: {process: [{model: {name_or_path}, network: {linear|lora_rank, type},
 *                        train: {steps, batch_size}, datasets: [{resolution}]}]}}
 * Everything is best-effort: an unparseable or unfamiliar config yields nulls, and the card hides
 * the rows it has no value for rather than printing a guess.
 */
function parseJobConfig(raw) {
  const out = { model: null, resolution: null, rank: null, steps: null };
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    return out;
  }
  const p = cfg?.config?.process?.[0];
  if (!p || typeof p !== 'object') return out;

  const name = p.model?.name_or_path;
  if (typeof name === 'string' && name) out.model = trimModelName(name);

  const net = p.network ?? {};
  for (const key of ['linear', 'lora_rank', 'rank', 'dim']) {
    if (Number.isFinite(net[key])) { out.rank = net[key]; break; }
  }

  if (Number.isFinite(p.train?.steps)) out.steps = p.train.steps;

  const res = p.datasets?.[0]?.resolution;
  // Multi-resolution buckets are the norm here (Bryan's runs are all [512, 768, 1024]), so the
  // row shows the whole bucket list rather than pretending the job has one resolution.
  if (Array.isArray(res)) {
    const nums = res.filter(Number.isFinite);
    if (nums.length) out.resolution = nums.join('/');
  } else if (Number.isFinite(res)) {
    out.resolution = String(res);
  }
  return out;
}

/** "krea/Krea-2-Raw" -> "Krea-2-Raw"; "D:\models\flux1-dev.safetensors" -> "flux1-dev". */
function trimModelName(raw) {
  const base = String(raw).split(/[\\/]/).pop() ?? '';
  return base.replace(/\.(safetensors|ckpt|gguf|sft|pt|pth|bin)$/i, '') || null;
}

module.exports = { AIToolkitClient, parseJobConfig };
