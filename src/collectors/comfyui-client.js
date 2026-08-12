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

// Electron 31's main process embeds Node 20.18, which has NO global WebSocket (that landed in
// Node 22) — discovered live 2026-08-11 when every card sat "offline" against a running server.
// The `ws` package exposes the same onopen/onmessage/onerror/onclose API, so prefer the global
// when a future Electron/Node provides it and fall back to `ws` otherwise.
const WebSocketImpl = globalThis.WebSocket ?? require('ws');
const FINISHED_HOLD_MS = 10000; // how long a finished job stays on the card before it clears to Idle
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 10000]; // caps at 10s

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
    this._progressHistory = []; // [{value, atMs}] recent samples for the step-rate EMA
    this._nodeNames = {}; // node id -> _meta.title || class_type, from the running prompt's graph
    this._reconnectAttempt = 0;
    this._tickTimer = null;
    this._pollTimer = null;
    this._pollInFlight = false;
    this._closed = false;
  }

  start() {
    this._closed = false;
    this._connect();
    this._tickTimer = setInterval(() => this._emit(), TICK_MS);
    this._pollTimer = setInterval(() => this._poll(), POLL_MS);
  }

  stop() {
    this._closed = true;
    clearInterval(this._tickTimer);
    clearInterval(this._pollTimer);
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
      if (!this.currentJob || this.currentJob.promptId !== runningId) {
        // A job we did not know about (foreign, or ours after a missed message) — start fresh.
        this.currentJob = { promptId: runningId, startedAtMs: Date.now() };
        this._progressHistory = [];
      }
      // Identity of the job, read off the same graph. METADATA ONLY — model filename and latent
      // dimensions. Prompt text is never read, here or anywhere else (Bryan's standing rule).
      if (graph && typeof graph === 'object') {
        const latent = describeLatent(graph);
        this.currentJob.model = describeModel(graph);
        this.currentJob.size = latent.size;
        this.currentJob.frames = latent.frames;
        this.currentJob.batch = latent.batch;
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
    if (typeof type === 'string' && type.startsWith('watcher.')) type = type.slice(8);
    switch (type) {
      case 'status': {
        this.queueRemaining = data?.status?.exec_info?.queue_remaining ?? null;
        break;
      }
      case 'crystools.monitor': {
        this.system = data;
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

    this._progressHistory.push({ value: data.value, atMs: now });
    // Keep a short rolling window — recent rate matters more than the whole job's average,
    // especially once caching/EasyCache-style skips make early steps unrepresentative.
    const cutoff = now - 15000;
    this._progressHistory = this._progressHistory.filter((p) => p.atMs >= cutoff);

    const stepsPerSec = this._estimateStepsPerSec();
    this.currentJob.stepsPerSec = stepsPerSec;
    this.currentJob.etaSec = stepsPerSec > 0 && data.max != null
      ? Math.max(0, (data.max - data.value) / stepsPerSec)
      : null;
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

  _estimateStepsPerSec() {
    const h = this._progressHistory;
    if (h.length < 2) return null;
    const first = h[0];
    const last = h[h.length - 1];
    const dtSec = (last.atMs - first.atMs) / 1000;
    const dSteps = last.value - first.value;
    if (dtSec <= 0 || dSteps <= 0) return null;
    return dSteps / dtSec;
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
      currentJob: job
        ? {
            promptId: job.promptId ?? null,
            node: job.node ?? null,
            nodeName: this._nodeName(job.node),
            model: job.model ?? null,
            size: job.size ?? null,
            frames: job.frames ?? null,
            batch: job.batch ?? null,
            step: job.step ?? null,
            maxSteps: job.maxSteps ?? null,
            stepsPerSec: job.stepsPerSec ?? null,
            etaSec: job.finished ? null : job.etaSec ?? null,
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
function describeLatent(graph) {
  for (const node of Object.values(graph)) {
    const inputs = node && typeof node === 'object' ? node.inputs : null;
    if (!inputs) continue;
    const w = inputs.width;
    const h = inputs.height;
    if (!Number.isFinite(w) || !Number.isFinite(h)) continue;
    if (!/latent/i.test(String(node.class_type ?? ''))) continue;
    return {
      size: `${w}x${h}`,
      // length is 1 on image latents — a "1 frame" row is noise, so only a real video counts.
      frames: Number.isFinite(inputs.length) && inputs.length > 1 ? inputs.length : null,
      // Batch size is shown for image jobs in the slot a video job uses for frames. Unlike
      // frames, a batch of 1 is worth printing: "how many images is this" is a real answer.
      batch: Number.isFinite(inputs.batch_size) ? inputs.batch_size : null,
    };
  }
  return { size: null, frames: null, batch: null };
}

module.exports = { ComfyUIClient, describeModel, describeLatent };
