// One long-lived WebSocket connection per configured ComfyUI host, PLUS a 1s REST poll of
// /queue + /history. Reconnects with backoff so a single unreachable host never blocks the
// others — same principle guiTOP's per-host polling follows for GPU backends.
//
// WHY BOTH TRANSPORTS (verified against source AND live, 2026-08-11, ComfyUI 0.31.1):
// ComfyUI sends ALL execution messages — "progress", "executing", "execution_start",
// "execution_success"/"execution_error", "progress_state" — ONLY to the client that submitted
// the prompt (server.send_sync(..., server.client_id); sid=None would broadcast but is never
// used for these — see ComfyUI server.py:1382-1390, execution.py:496/684, main.py:450).
// A passive watcher with its own clientId receives ONLY the broadcast messages:
//   - "status": {"type":"status","data":{"status":{"exec_info":{"queue_remaining":N}},"sid":"..."}}
//   - "crystools.monitor" (every ~1s, only if ComfyUI-Crystools is installed): per-GPU
//     utilization/VRAM, host RAM. Absence = "no system panel", not an error.
// Confirmed empirically: two 120s taps during running jobs received zero execution messages.
//
// So for FOREIGN jobs (submitted by the ComfyUI web UI or any other client) the poller provides:
// job presence + prompt_id from /queue, and success/error + exact server-side start/finish
// timestamps from /history/<prompt_id>. Step X/Y, it/s and ETA are only available when this
// client's WS actually receives progress messages (e.g. a future ComfyUI that broadcasts, or a
// job submitted under our clientId) — the card shows "--" rather than a fabricated number.

const TICK_MS = 500; // how often we push a snapshot even with no new WS message (for live elapsed/ETA)
const POLL_MS = 1000; // how often we poll /queue for job presence (execution WS messages are targeted, see above)

// Rate window: recent rate, not the job's lifetime average (caching/EasyCache-style skips make
// early steps unrepresentative). 20s covers ~6 steps of a typical sampler.
const RATE_WINDOW_MS = 20000;
// ...but a window alone reports "no rate" on a slow sampler, which is exactly the job that most
// needs one: MiniMax H3 video runs 14-30 s/it, so a 20s window would hold ONE sample and the
// needle would never leave its stop for the whole run. Always keep the last few samples whatever
// their age — old-but-real beats nothing, and a sampler's step time is stable.
const RATE_MIN_SAMPLES_KEPT = 4;
// Per-item durations kept for the whole-batch ETA. Enough to ride out one slow item without the
// median chasing every wobble; short enough that a run which genuinely slows down is reflected.
const ITEM_SAMPLES_KEPT = 8;

// Electron 31's main process embeds Node 20.18, which has NO global WebSocket (that landed in
// Node 22) — discovered live 2026-08-11 when every card sat "offline" against a running server.
// The `ws` package exposes the same onopen/onmessage/onerror/onclose API, so prefer the global
// when a future Electron/Node provides it and fall back to `ws` otherwise.
const WebSocketImpl = globalThis.WebSocket ?? require('ws');
const FINISHED_HOLD_MS = 10000; // how long a finished job stays on the card before it clears to Idle
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 10000]; // caps at 10s
// How long a job must have been running, with no watcher.* traffic, before we will say the relay
// is missing. A relay speaks within a step of the job starting; this is generous on purpose.
// How long a job must run with no watcher.* traffic before we call the relay absent.
//
// 10s was WRONG and produced a false "no relay — steps unavailable" against a host whose relay was
// verifiably working (Secondary, 2026-08-15: a WS tap saw watcher.progress, the card said absent).
// The relay only speaks when ComfyUI does, and a MiniMax-H3 sampler emits one progress message
// every 20-30 seconds — so a 10s window routinely holds none of them on exactly the slow video job
// this widget exists to watch. 90s clears his slowest recorded step time (30 s/it) with room, and
// the cost of waiting is only that an honestly-missing relay is reported a minute later.
const RELAY_VERDICT_MS = 90000;
// How often the host's own build info is re-read. These change when ComfyUI restarts, not while it
// runs, so this is a "did the box get updated" poll, not a monitor — 5 minutes is generous.
const INFO_POLL_MS = 300000;

/**
 * What a ComfyUI instance says it is built from. `/system_stats` is stock ComfyUI (verified against
 * 0.33.1) and carries the first three; the NVIDIA driver is in none of its endpoints and none of
 * the installed node packs expose it either (checked 2026-08-14, including Crystools, whose
 * `/crystools/monitor/GPU` returns index+name only), so it comes from OUR relay node's
 * `/watcher/host_info` route. No relay, no driver — the field stays null and the panel hides it
 * rather than printing a placeholder for a number nobody can know.
 *
 * CUDA is read off the pytorch build tag (`2.13.0+cu130` → `13.0`): that is the CUDA the running
 * ComfyUI is actually built against, which is the useful one next to a torch version. The driver's
 * own max CUDA is a different number and is deliberately not conflated with it.
 *
 * Exported for the unit test — parsing a payload shape is exactly the part worth pinning.
 */
function parseSystemStats(payload) {
  const sys = payload?.system;
  if (!sys || typeof sys !== 'object') return null;
  const torch = typeof sys.pytorch_version === 'string' ? sys.pytorch_version : null;
  const accel = detectAccelerator(torch, payload?.devices);
  return {
    comfyui: typeof sys.comfyui_version === 'string' ? sys.comfyui_version : null,
    // "2.13.0+cu130" -> "2.13.0". The build tag is read as the accelerator, not printed twice.
    pytorch: torch ? torch.split('+')[0] : null,
    accel: accel.name,
    accelVersion: accel.version,
    // 3.13.12 (main, ...) -> 3.13.12. Not shown on the panel today; kept because it costs nothing
    // and the same probe answers it.
    python: typeof sys.python_version === 'string' ? sys.python_version.split(' ')[0] : null,
  };
}

// Which GPU stack this instance is actually running on. The panel window relabels itself from this
// — CUDA on Bryan's boxes, ROCm on an AMD one — because "CUDA 6.2" on a Radeon would be a wrong
// label on a right number.
//
// THE BUILD TAG IS THE ANSWER, not the device list: PyTorch's ROCm wheels report `torch.cuda`,
// `device.type === 'cuda'` and even a `cuda:0` device name, so ComfyUI's /system_stats looks
// identical on both stacks apart from `pytorch_version` (2.5.1+rocm6.2 vs 2.13.0+cu130) and the
// card's own name. Tags seen in the wild: +cu130 / +cu118 (CUDA), +rocm6.2 (ROCm), +xpu (Intel),
// +cpu (no GPU at all).
const GPU_NAME_HINTS = [
  { re: /\b(amd|radeon|instinct|gfx\d|mi\d{2,3})\b/i, name: 'ROCm' },
  { re: /\b(nvidia|geforce|rtx|gtx|quadro|tesla|titan)\b/i, name: 'CUDA' },
];

function detectAccelerator(torchVersion, devices) {
  const tag = typeof torchVersion === 'string' ? torchVersion.split('+')[1] ?? null : null;
  if (tag) {
    // rocm6.2 -> ROCm 6.2. The version is written plainly in the tag, no digit-splitting needed.
    const rocm = tag.match(/^rocm([\d.]+)$/i);
    if (rocm) return { name: 'ROCm', version: rocm[1] || null };
    // cu130 -> CUDA 13.0: a two-digit major followed by the minor.
    const cu = tag.match(/^cu(\d{2,4})$/i);
    if (cu) return { name: 'CUDA', version: `${cu[1].slice(0, 2)}.${cu[1].slice(2)}` };
    if (/^xpu$/i.test(tag)) return { name: 'XPU', version: null };
    if (/^cpu$/i.test(tag)) return { name: 'CPU', version: null };
  }
  // No tag — a source or conda build. The card's name still says which stack it must be, but not
  // which version of it, so the panel prints the stack alone rather than inventing a number.
  const name = Array.isArray(devices) ? devices.map((d) => d?.name ?? '').join(' ') : '';
  for (const hint of GPU_NAME_HINTS) {
    if (hint.re.test(name)) return { name: hint.name, version: null };
  }
  return { name: null, version: null };
}

class ComfyUIClient {
  /**
   * @param {{name: string, url: string}} host
   * @param {(hostName: string, snapshot: object) => void} onUpdate
   */
  constructor(host, onUpdate) {
    this.host = host;
    this.onUpdate = onUpdate;
    this.ws = null;
    this.status = 'connecting'; // connecting | online | offline
    this.lastError = null;
    this.queueRemaining = null;
    this.currentJob = null; // {promptId, node, step, maxSteps, stepsPerSec, startedAt, etaSec}
    this.system = null; // crystools.monitor payload, or null if not installed
    this.versions = null; // {comfyui, pytorch, cuda, driver, python} — see parseSystemStats
    this._progressHistory = []; // [{value, atMs, node}] recent samples for the step-rate estimate
    this._nodeNames = {}; // node id -> _meta.title || class_type, from the running prompt's graph
    this._batchTotals = {}; // node id -> how many list items that node will run (relay only)
    this._itemDurations = []; // seconds per completed batch item, for the whole-batch ETA
    this.relaySeen = false; // has this host ever sent a watcher.* message (i.e. relay installed)
    this._firstJobSeenAtMs = null; // when this host was first seen running anything
    this._reconnectAttempt = 0;
    this._tickTimer = null;
    this._pollTimer = null;
    this._infoTimer = null;
    this._pollInFlight = false;
    this._closed = false;
  }

  start() {
    this._closed = false;
    this._connect();
    this._tickTimer = setInterval(() => this._emit(), TICK_MS);
    this._pollTimer = setInterval(() => this._poll(), POLL_MS);
    this._infoTimer = setInterval(() => this._probeInfo(), INFO_POLL_MS);
  }

  stop() {
    this._closed = true;
    clearInterval(this._tickTimer);
    clearInterval(this._pollTimer);
    clearInterval(this._infoTimer);
    if (this.ws) {
      try { this.ws.close(); } catch { /* already closed */ }
    }
  }

  // ---- REST poll: the only way to see FOREIGN jobs (see header comment) ----

  async _poll() {
    if (this.status !== 'online' || this._pollInFlight || this._closed) return;
    this._pollInFlight = true;
    try {
      const res = await fetch(this.host.url + '/queue');
      if (!res.ok) return;
      const q = await res.json();
      const finishedId = this._applyQueue(q);
      if (finishedId) {
        const hres = await fetch(`${this.host.url}/history/${finishedId}`);
        if (hres.ok) {
          const h = await hres.json();
          this._applyHistory(finishedId, h?.[finishedId]);
        } else {
          // No history entry (e.g. interrupted before it committed) — just stop showing it.
          if (this.currentJob && this.currentJob.promptId === finishedId) this.currentJob = null;
        }
        this._emit();
      }
    } catch {
      // Transient REST failure — the WS reconnect path owns online/offline state.
    } finally {
      this._pollInFlight = false;
    }
  }

  /**
   * Read what this instance is built from: ComfyUI / PyTorch / CUDA from stock `/system_stats`, the
   * NVIDIA driver from the relay node's `/watcher/host_info`. Both are best-effort and independent —
   * a host without the relay still gets the first three, and a failed probe leaves the previous
   * answer standing rather than blanking a panel over one dropped request.
   */
  async _probeInfo() {
    if (this.status !== 'online' || this._closed) return;
    const next = { ...(this.versions ?? {}) };
    try {
      const res = await fetch(this.host.url + '/system_stats');
      if (res.ok) Object.assign(next, parseSystemStats(await res.json()) ?? {});
    } catch { /* transient — keep whatever we already had */ }
    try {
      const res = await fetch(this.host.url + '/watcher/host_info');
      // 404 is the normal answer from a host whose relay predates this route: not an error, just no
      // driver version. Anything else that parses gets used.
      if (res.ok) {
        const info = await res.json();
        next.driver = typeof info?.driver === 'string' ? info.driver : null;
      }
    } catch { /* same */ }
    if (this._closed) return;
    this.versions = Object.keys(next).length ? next : null;
    this._emit();
  }

  /**
   * Reconcile /queue against currentJob. Queue entries are arrays:
   * [number, prompt_id, prompt, extra_data, outputs_to_execute].
   * Returns a prompt_id that needs a /history lookup (the shown job stopped running), or null.
   */
  _applyQueue(q) {
    const running = q?.queue_running?.[0] ?? null;
    const runningId = running?.[1] ?? null;
    if (runningId) {
      // The running entry carries the full node graph — remember id -> human name so the card
      // can show "KSampler" (or the user's node title) instead of a bare id like "105:14".
      const graph = running[2];
      if (graph && typeof graph === 'object') {
        const names = {};
        for (const [id, node] of Object.entries(graph)) {
          if (node && typeof node === 'object') names[id] = node._meta?.title ?? node.class_type ?? null;
        }
        this._nodeNames = names;
      }
      // First time we have seen this host actually execute anything. Timestamped so _relayState()
      // can tell "idle, nothing to learn" from "a job ran and the relay stayed silent".
      if (!this._firstJobSeenAtMs) this._firstJobSeenAtMs = Date.now();
      if (!this.currentJob || this.currentJob.promptId !== runningId) {
        // A job we did not know about (foreign, or ours after a missed message) — start fresh.
        this.currentJob = { promptId: runningId, startedAtMs: Date.now() };
        this._progressHistory = [];
        this._batchTotals = {}; // batch sizes belong to one prompt's graph
        this._itemDurations = [];
      }
      // Identity of the job, read off the same graph. METADATA ONLY — model filename and latent
      // dimensions. Prompt text is never read, here or anywhere else (Bryan's standing rule).
      if (graph && typeof graph === 'object') {
        const latent = describeLatent(graph);
        this.currentJob.model = describeModel(graph);
        this.currentJob.size = latent.size;
        this.currentJob.frames = latent.frames;
        this.currentJob.batch = latent.batch;
        // What KIND of work this is, so the card can print a scale the job actually fits on. See
        // detectMedia: a video sampler and an image sampler differ by two orders of magnitude.
        this.currentJob.media = detectMedia(graph);
      }
      return null;
    }
    // Nothing running. If we were showing a live job, it just stopped — resolve via history.
    if (this.currentJob && !this.currentJob.finished && this.currentJob.promptId) {
      return this.currentJob.promptId;
    }
    return null;
  }

  /**
   * Fold one /history/<prompt_id> entry into currentJob: success/error plus the job's exact
   * duration from ComfyUI's own execution_start/success/error message timestamps (server clock —
   * only used as a delta, never mixed with local Date.now()).
   */
  _applyHistory(promptId, entry) {
    if (!this.currentJob || this.currentJob.promptId !== promptId) return;
    if (!entry || !entry.status) {
      this.currentJob = null;
      return;
    }
    this.currentJob.finished = entry.status.status_str === 'success' ? 'success' : 'error';
    this.currentJob.finishedAtMs = Date.now(); // local clock: drives the FINISHED_HOLD_MS timer
    const ts = {};
    for (const m of entry.status.messages || []) {
      if (Array.isArray(m) && m[1] && typeof m[1].timestamp === 'number') ts[m[0]] = m[1].timestamp;
    }
    const start = ts.execution_start;
    const end = ts.execution_success ?? ts.execution_error;
    if (start != null && end != null && end >= start) {
      this.currentJob.finalElapsedSec = (end - start) / 1000;
    }
  }

  _wsUrl() {
    const clientId = `comfyuiwatcher-${Math.random().toString(36).slice(2)}`;
    return this.host.url.replace(/^http/, 'ws') + `/ws?clientId=${clientId}`;
  }

  _connect() {
    if (this._closed) return;
    let ws;
    try {
      ws = new WebSocketImpl(this._wsUrl());
    } catch (err) {
      this._onDisconnect(err);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this._reconnectAttempt = 0;
      this.status = 'online';
      this.lastError = null;
      this._emit();
      // Build info is read on connect, not on a schedule alone: a host that just came back may be a
      // host that was just updated, and waiting five minutes to notice would be silly.
      this._probeInfo();
    };
    ws.onmessage = (ev) => this._handleMessage(ev.data);
    ws.onerror = (err) => { this.lastError = String(err && err.message ? err.message : err); };
    ws.onclose = () => this._onDisconnect();
  }

  _onDisconnect(err) {
    if (err) this.lastError = String(err && err.message ? err.message : err);
    this.status = 'offline';
    this.currentJob = null;
    this._emit();
    if (this._closed) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this._reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this._reconnectAttempt++;
    setTimeout(() => this._connect(), delay);
  }

  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    let { type } = msg;
    const { data } = msg;
    // Our optional comfyui-relay custom node rebroadcasts the targeted execution messages to
    // everyone under a "watcher." prefix — treat them exactly like the originals. (Own-clientId
    // jobs then arrive twice, original + relay copy; the handlers are idempotent for that.)
    if (typeof type === 'string' && type.startsWith('watcher.')) {
      type = type.slice(8);
      // Seeing one of these is PROOF the relay node is installed and loaded on this host — it is
      // the only source of watcher.* traffic. The setup panel reports it, so the answer to "did
      // my copy-into-custom_nodes work?" is observed, not assumed.
      this.relaySeen = true;
    }
    switch (type) {
      case 'status': {
        this.queueRemaining = data?.status?.exec_info?.queue_remaining ?? null;
        break;
      }
      case 'crystools.monitor': {
        this.system = data;
        break;
      }
      case 'batch': {
        // watcher.batch — relay only, and only for a node ComfyUI is running over a list. Nothing in
        // ComfyUI's own protocol carries this count, so a host with an older relay simply never
        // learns the total and the card shows the pass number alone.
        if (this.currentJob && data?.total > 1) {
          this._batchTotals[String(data.node)] = data.total;
        }
        break;
      }
      case 'progress': {
        this._onProgress(data);
        break;
      }
      case 'executing': {
        this._onExecuting(data);
        break;
      }
      case 'execution_start': {
        // A new prompt always starts a fresh job object — never inherit step/maxSteps/finished
        // from a previous (possibly still-displayed finished) job.
        this.currentJob = { promptId: data?.prompt_id ?? null, startedAtMs: Date.now() };
        this._progressHistory = [];
        this._batchTotals = {};
        this._itemDurations = [];
        break;
      }
      case 'execution_success':
      case 'execution_error': {
        // Mark finished and let the FINISHED_HOLD_MS timer in _emit() clear it — the card shows
        // a distinct "finished" state for a few seconds instead of vanishing instantly.
        if (this.currentJob) {
          this.currentJob.finished = type === 'execution_success' ? 'success' : 'error';
          this.currentJob.finishedAtMs = Date.now();
        }
        break;
      }
      default:
        break; // execution_cached, execution_interrupted, b64 previews, etc. — not needed yet
    }
    this._emit();
  }

  _onProgress(data) {
    if (!data) return;
    const now = Date.now();
    // Progress for a new prompt while a finished job is still being held on screen (or when we
    // never saw execution_start, e.g. we connected mid-job): start fresh.
    if (this.currentJob && this.currentJob.finished) {
      this.currentJob = null;
      this._progressHistory = [];
    }
    this.currentJob = this.currentJob || {};
    this.currentJob.promptId = data.prompt_id ?? this.currentJob.promptId;
    this.currentJob.node = data.node ?? this.currentJob.node;
    this.currentJob.step = data.value;
    this.currentJob.maxSteps = data.max;
    if (!this.currentJob.startedAtMs) this.currentJob.startedAtMs = now;

    // A PROGRESS BAR THAT RESTARTS IS A DIFFERENT MEASUREMENT — throw the window away.
    // Measured live 2026-08-13 on Bryan's Flux2-Klein dataset workflow (a batch job): the SAME
    // sampler node emits value 1..8, then immediately 1..8 again for the next image, under one
    // prompt_id. The old estimator took (last - first) across the window, so for the first ~15s of
    // every image the window still held 6,7,8 from the previous one and the delta was NEGATIVE →
    // rate null, needle at the stop, NO SIGNAL. It only recovered once those samples aged out,
    // around step 6 of 8 — the "dial only registers with 2 steps left" report. Steps Left was
    // right throughout, because it reads `value` and never the window.
    // Same reset for a change of node: a tiled VAE decode runs its own bar with its own max, and
    // splicing two bars together measures nothing.
    const prev = this._progressHistory[this._progressHistory.length - 1];
    const nodeKey = data.node ?? null;
    const sameNode = prev && nodeKey === prev.node;
    const restarted = sameNode && data.value < prev.value;
    if (prev && !sameNode) this._progressHistory = [];
    else if (restarted) this._progressHistory = [];

    // A restarted bar on the same node is the NEXT ITEM of a batch: ComfyUI runs a list-expanded
    // node once per item, back to back (28 sampler runs, then 28 decodes). Counting the restarts is
    // the only way to know which item is running — nothing in the protocol says so. The total comes
    // from the relay when it is new enough to send watcher.batch; without it the card shows the
    // count alone rather than inventing a denominator.
    if (nodeKey !== this.currentJob.passNode) {
      this.currentJob.passNode = nodeKey;
      this.currentJob.pass = 1;
      this.currentJob.passStartedAtMs = now;
      this._itemDurations = [];
    } else if (restarted) {
      this.currentJob.pass = (this.currentJob.pass ?? 1) + 1;
      // A restart is the only moment we learn what one whole item COSTS — steps alone miss the
      // decode, the save and the model shuffle between items. Measure it rather than deriving it
      // from maxSteps/rate, which undercounts by everything that is not sampling.
      if (this.currentJob.passStartedAtMs) {
        this._itemDurations.push((now - this.currentJob.passStartedAtMs) / 1000);
        if (this._itemDurations.length > ITEM_SAMPLES_KEPT) this._itemDurations.shift();
      }
      this.currentJob.passStartedAtMs = now;
    }

    // A repeat of the value we already have is a DUPLICATE, not a stalled step: a job submitted
    // under our own clientId arrives twice, once as ComfyUI's targeted message and once as the
    // relay's broadcast copy. Recording both puts a "+0 steps in 3ms" pair in the window.
    const duplicate = sameNode && data.value === prev.value;
    if (!duplicate) this._progressHistory.push({ value: data.value, atMs: now, node: nodeKey });
    const cutoff = now - RATE_WINDOW_MS;
    const windowed = this._progressHistory.filter((p) => p.atMs >= cutoff);
    // Keep the tail even when it is older than the window — see RATE_MIN_SAMPLES_KEPT.
    this._progressHistory = windowed.length >= RATE_MIN_SAMPLES_KEPT
      ? windowed
      : this._progressHistory.slice(-RATE_MIN_SAMPLES_KEPT);

    // A KNOWN RATE IS NEVER REPLACED BY null WITHIN ONE JOB. Emptying the window at each batch item
    // left the first step of every image with no measurable interval, so the rate went null for ~3s
    // out of every ~28s — the meter's backlight went bright/dark/bright/dark right through a run,
    // which Bryan (rightly) called distracting. The last measurement is still the honest answer to
    // "how fast is this going": the item that just started is the same work at the same size on the
    // same model. It is cleared only when the job itself changes (execution_start, a new prompt_id
    // from the poller, or a change of node above), never mid-run.
    const stepsPerSec = this._estimateStepsPerSec();
    if (stepsPerSec != null || this.currentJob.stepsPerSec == null) {
      this.currentJob.stepsPerSec = stepsPerSec;
    }
    // `data.max > 0`, not `!= null`: a bar reporting a max of 0 has nothing to count down to, and
    // (0 - value) / rate clamped at zero would print "ETA 0.0s" on a job that just started.
    //
    // Recorded at the moment of the step, and DRAINED between steps by _etaSec() below — the raw
    // figure only changes when a step lands, which on a 20-30 s/it video sampler means a card that
    // sits frozen for half a minute and then jumps.
    //
    // IT READS THE HELD RATE, not the fresh estimate. On the first step of every batch item the
    // window was just emptied, so `stepsPerSec` above is null while `currentJob.stepsPerSec` still
    // carries the measurement being held by the rule right above this. Using the local one blanked
    // the ETA for one step in every item while the RATE beside it kept reading — the same
    // bright/dark flicker the hold rule exists to stop, in the other well.
    const rate = this.currentJob.stepsPerSec;
    this.currentJob.etaAtStepSec = rate > 0 && data.max > 0
      ? Math.max(0, (data.max - data.value) / rate)
      : null;
    this.currentJob.etaStepAtMs = now;
    this.currentJob.etaSec = this._etaSec();
    this.currentJob.jobEtaSec = this._estimateJobEtaSec();
  }

  /**
   * ETA for every REMAINING ITEM of the batch, not just the one being sampled.
   *
   * "Steps Left 4, ETA 0.9s" answers "when does this image land" — on a 28-image dataset run the
   * question actually being asked is "when do I get my dataset". That needs a per-item cost, and
   * the only honest source is a measured one: an item is timed from one bar restart to the next
   * (see _onProgress), so it includes the decode, the save and any model shuffle. Median, not mean
   * — the first item of a run carries the model load and would drag a mean up for the whole job.
   *
   * Returns null unless the relay told us the total. Counting restarts gives the item we are ON,
   * never how many there are, and a countdown to an invented denominator is worse than no
   * countdown — the house rule is N/A over a fabricated number.
   *
   * SCOPE: this covers the current node's remaining items. ComfyUI runs a list-expanded graph node
   * by node (28 samples, THEN 28 decodes), so a later stage's time is not in here and the figure
   * reads slightly short near the end of sampling. Sampling dominates by an order of magnitude on
   * every workflow measured, so it is close; it is deliberately labelled per-batch, not per-prompt.
   */
  _estimateJobEtaSec() {
    const job = this.currentJob;
    if (!job || job.etaSec == null || job.pass == null) return null;
    const total = job.passNode != null ? this._batchTotals[String(job.passNode)] : null;
    if (!(total > 0)) return null;
    const remaining = total - job.pass;
    if (remaining <= 0) return job.etaSec;

    let perItem = null;
    if (this._itemDurations.length) {
      const s = [...this._itemDurations].sort((a, b) => a - b);
      perItem = s[Math.floor(s.length / 2)];
    } else if (job.stepsPerSec > 0 && job.maxSteps > 0) {
      // Nothing measured yet — item one is still running. Sampling time is a floor, not the truth,
      // and it is replaced by a measurement the moment the second item starts.
      perItem = job.maxSteps / job.stepsPerSec;
    }
    if (!(perItem > 0)) return null;
    return job.etaSec + remaining * perItem;
  }

  /**
   * Resolve a node id to a display name via the running prompt's graph. Subgraph expansion
   * produces composite ids like "105:14" that aren't graph keys — fall back segment by segment
   * ("105:14" -> "105" is the subgraph node the user actually placed), then to the raw id.
   */
  _nodeName(id) {
    if (id == null) return null;
    const key = String(id);
    if (this._nodeNames[key]) return this._nodeNames[key];
    for (const part of key.split(':')) {
      if (this._nodeNames[part]) return this._nodeNames[part];
    }
    return null;
  }

  /**
   * it/s from PER-STEP INTERVALS, not (last - first) / elapsed over the window.
   *
   * Both forms agree on a steady sampler; they disagree when the run pauses (a VRAM shuffle
   * between models, a tiled decode, the OS swapping) — one 40s gap inside the window halves a
   * first-to-last figure and the ETA with it. Intervals longer than 3x the median are dropped as
   * pauses and the surviving ones are averaged, which is the same shape the ai-toolkit collector
   * settled on after measuring it against a real trainer (see aitoolkit-client.js).
   *
   * TWO samples is enough here, unlike the trainer's three: a sampler's steps are uniform, its
   * poll is push-driven rather than a 1s poll (so no whole-second quantisation), and the window is
   * reset by `_onProgress` whenever the bar restarts — so an interval is a real step, not a stall.
   * That is what makes the needle come alive one step into a run instead of six.
   */
  _estimateStepsPerSec() {
    const h = this._progressHistory;
    if (h.length < 2) return null;
    const perStep = [];
    for (let i = 1; i < h.length; i++) {
      const dtSec = (h[i].atMs - h[i - 1].atMs) / 1000;
      const dSteps = h[i].value - h[i - 1].value;
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
    for (let i = 1; i < h.length; i++) {
      const dtSec = (h[i].atMs - h[i - 1].atMs) / 1000;
      const dSteps = h[i].value - h[i - 1].value;
      if (dtSec <= 0 || dSteps <= 0) continue;
      if (dtSec / dSteps > median * 3) continue; // a pause, not a step
      steps += dSteps;
      secs += dtSec;
    }
    if (steps <= 0 || secs <= 0) return null;
    return steps / secs;
  }

  _onExecuting(data) {
    if (!data) return;
    if (data.node === null) {
      // node:null mid-job (between nodes) must not blank the UI, and a finished job stays
      // visible for FINISHED_HOLD_MS — the hold timer in _emit() does the clearing.
    } else {
      this.currentJob = this.currentJob || {};
      this.currentJob.promptId = data.prompt_id ?? this.currentJob.promptId;
      this.currentJob.node = data.node;
    }
  }

  /**
   * ETA that ticks down between steps.
   *
   * The step in flight is counted apart from the ones after it: each later step is worth a full
   * step-time, and the running one is worth whatever is left of its own. That drains at one second
   * per second instead of standing still and then jumping.
   *
   * IT STOPS AT THE END OF THE CURRENT STEP. If the job stalls, the in-flight term floors at zero
   * and the figure holds at the whole steps remaining — a countdown that kept running through a
   * stall would promise a finish that is not coming. Same rule as the canvas node's job-state.js;
   * if one changes, change both.
   */
  _etaSec() {
    const job = this.currentJob;
    if (!job || job.etaAtStepSec == null || !(job.stepsPerSec > 0)) return null;
    const stepTime = 1 / job.stepsPerSec;
    const since = job.etaStepAtMs ? Math.max(0, (Date.now() - job.etaStepAtMs) / 1000) : 0;
    const whole = Math.max(0, job.etaAtStepSec - stepTime); // the steps after the one in flight
    return whole + Math.max(0, stepTime - since);
  }

  /**
   * true / false / null for "is the relay node installed on this host".
   *
   * true is proof: only the relay emits watcher.* traffic. false is a claim, so it is only made
   * once a job has been running for RELAY_VERDICT_MS without a single watcher.* message — long
   * enough that a relay would certainly have spoken. Until then it is null (unknown), because an
   * idle host proves nothing either way and "your relay is missing" is the kind of thing this
   * widget should not say on a guess.
   */
  _relayState() {
    if (this.relaySeen) return true;
    if (this._firstJobSeenAtMs && Date.now() - this._firstJobSeenAtMs > RELAY_VERDICT_MS) return false;
    return null;
  }

  _emit() {
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
      system: this.system,
      versions: this.versions,
      relay: this._relayState(),
      currentJob: job
        ? {
            promptId: job.promptId ?? null,
            node: job.node ?? null,
            nodeName: this._nodeName(job.node),
            model: job.model ?? null,
            size: job.size ?? null,
            frames: job.frames ?? null,
            batch: job.batch ?? null,
            // 'video' | 'image' | null — which rate scale the card prints. This payload is an
            // explicit whitelist, so a field the collector sets but does not list here simply never
            // reaches the renderer: detectMedia worked and every card still read the image face
            // (found 2026-08-14 by running the packaged build against a live H3 job).
            media: job.media ?? null,
            step: job.step ?? null,
            maxSteps: job.maxSteps ?? null,
            // Which item of a batch is running, and how many there are if the relay told us.
            // `pass` alone (no total) is still worth printing: on a 28-image dataset run it is the
            // difference between "something is happening" and "we are 3 in".
            pass: job.pass ?? null,
            passTotal: job.passNode != null ? this._batchTotals[String(job.passNode)] ?? null : null,
            stepsPerSec: job.stepsPerSec ?? null,
            etaSec: job.finished ? null : this._etaSec(),
            // Whole-batch ETA. Null on a single-image job and on any run where the relay never
            // sent a total — the card hides the slot rather than showing a dash beside a live one.
            jobEtaSec: job.finished ? null : job.jobEtaSec ?? null,
            // Elapsed freezes at the moment the job finished instead of ticking on. When the
            // poller resolved the job via /history, finalElapsedSec (server-timestamp delta) is
            // more accurate than our first-seen clock — prefer it.
            elapsedSec: job.finalElapsedSec
              ?? (job.startedAtMs ? ((job.finishedAtMs ?? now) - job.startedAtMs) / 1000 : null),
            finished: job.finished ?? null,
          }
        : null,
    });
  }
}

// ---- Job identity, read from the running graph (metadata only) ----

// Loader class_types worth naming a job after, most specific first: the diffusion model is what
// the user thinks of as "the model", so a UNET/checkpoint loader beats a VAE or CLIP loader.
// Matching is on the input key, not the class name, because the ecosystem invents loader nodes
// faster than anyone can enumerate them (UnetLoaderGGUF, NunchakuFluxDiTLoader, ...).
const MODEL_KEYS = ['unet_name', 'ckpt_name', 'model_name', 'model_path', 'diffusion_model'];
const MODEL_FILE_RE = /\.(safetensors|ckpt|gguf|sft|pt|pth|bin)$/i;

/**
 * Best-effort model name for a running prompt graph. Returns null when nothing matches — an
 * unknown graph shows no model rather than a guessed one.
 */
function describeModel(graph) {
  const found = new Map(); // key -> first value seen, in MODEL_KEYS priority order
  for (const node of Object.values(graph)) {
    const inputs = node && typeof node === 'object' ? node.inputs : null;
    if (!inputs || typeof inputs !== 'object') continue;
    for (const key of MODEL_KEYS) {
      const v = inputs[key];
      // A wired input is ["nodeId", slot] — only a literal filename is a model name.
      if (typeof v === 'string' && MODEL_FILE_RE.test(v) && !found.has(key)) found.set(key, v);
    }
  }
  for (const key of MODEL_KEYS) {
    if (found.has(key)) return trimModelName(found.get(key));
  }
  return null;
}

/** "SDXL\juggernautXL_v9.safetensors" -> "juggernautXL_v9". Path and extension are noise here. */
function trimModelName(raw) {
  const base = String(raw).split(/[\\/]/).pop() ?? '';
  return base.replace(MODEL_FILE_RE, '') || null;
}

/**
 * The job's latent node: dimensions and, for video, the frame count. Both are returned raw and
 * unlabelled — the card gives each its own silkscreen label, so neither carries a unit suffix
 * ("121f") that a label would say better.
 * Only width/height on a node whose class_type mentions "latent" count: an ImageScale node has
 * width/height too and is not the job's output size.
 */
// How many frames a node says it makes, whatever it calls that input. Every video pack spells it
// differently and none of them are going to agree.
const FRAME_KEYS = ['length', 'num_frames', 'video_frames', 'frame_count', 'batch_size_frames'];

// Node classes that only exist in a video pipeline, and model-name families that only ship video
// weights. Both lists are deliberately about the WORK, never the prompt.
const VIDEO_CLASS_RE = /(video|img2vid|vid2vid|animatediff|svd|framepack|wanimage|wanvideo)/i;
const VIDEO_MODEL_RE = /(wan\d|wan2|hunyuanvideo|minimax|ltxv?|mochi|cosmos|svd|animatediff|framepack|cogvideo|h3_)/i;

function frameCount(inputs) {
  for (const k of FRAME_KEYS) {
    if (Number.isFinite(inputs[k])) return inputs[k];
  }
  return null;
}

function describeLatent(graph) {
  // TWO passes, latent-class nodes first. A dedicated latent node is the authoritative statement of
  // the output size; a video node carrying width/height is the fallback for the graphs that have no
  // latent node at all (Wan/HunyuanVideo image-to-video builds the latent inside the node that also
  // takes the conditioning). Interleaving them would let whichever node happened to come first in
  // the object win.
  // The second pass uses the SAME class list the media detector uses, so a graph that is judged
  // video always has somewhere to read its size from — two regexes drifting apart is how the SVD
  // conditioning node ended up detected as video with no size or frame count to show for it.
  for (const re of [/latent/i, VIDEO_CLASS_RE]) {
    for (const node of Object.values(graph)) {
      const inputs = node && typeof node === 'object' ? node.inputs : null;
      if (!inputs) continue;
      const w = inputs.width;
      const h = inputs.height;
      if (!Number.isFinite(w) || !Number.isFinite(h)) continue;
      if (!re.test(String(node.class_type ?? ''))) continue;
      const frames = frameCount(inputs);
      return {
        size: `${w}x${h}`,
        // 1 frame is an image latent — a "1 frame" row is noise, so only a real video counts.
        frames: frames != null && frames > 1 ? frames : null,
        // Batch size is shown for image jobs in the slot a video job uses for frames. Unlike
        // frames, a batch of 1 is worth printing: "how many images is this" is a real answer.
        batch: Number.isFinite(inputs.batch_size) ? inputs.batch_size : null,
      };
    }
  }
  return { size: null, frames: null, batch: null };
}

/**
 * Is the running graph making video or stills?
 *
 * This exists because the rate instrument is a log scale with fixed ends, and a video sampler and
 * an image sampler are two orders of magnitude apart: 15 s/it is a healthy MiniMax-H3 run and a
 * catastrophic SDXL one. No single face can call both correctly, so the card asks the graph what it
 * is looking at and prints the matching scale. ("15.75 s/it is not slow for video" — Bryan,
 * 2026-08-14.)
 *
 * THREE SIGNALS, structural ones first, because a filename is the weakest evidence in the graph:
 *  1. a node class that only exists in a video pipeline;
 *  2. any node asking for more than one frame, under any of the names the packs use for it;
 *  3. a model filename from a known video family — last, and only if 1 and 2 found nothing.
 *
 * @returns {'video'|'image'|null} null when there is no graph to judge, never a guess.
 */
function detectMedia(graph) {
  if (!graph || typeof graph !== 'object') return null;
  let sawNode = false;
  for (const node of Object.values(graph)) {
    if (!node || typeof node !== 'object') continue;
    sawNode = true;
    const cls = String(node.class_type ?? '');
    if (VIDEO_CLASS_RE.test(cls)) return 'video';
    const inputs = node.inputs;
    if (inputs && typeof inputs === 'object') {
      const frames = frameCount(inputs);
      if (frames != null && frames > 1) return 'video';
    }
  }
  if (!sawNode) return null;
  const model = describeModel(graph);
  if (model && VIDEO_MODEL_RE.test(model)) return 'video';
  return 'image';
}

module.exports = { ComfyUIClient, describeModel, describeLatent, detectMedia, parseSystemStats };
