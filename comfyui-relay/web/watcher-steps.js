// The watcher nodes: display-only nodes that draw the running job's step count, rate, elapsed time
// and ETA — and, on the VRAM nodes, how full the cards are — straight onto the ComfyUI canvas.
// This file is the ONLY one that imports ComfyUI; the layouts live in face.js, the job maths in
// job-state.js, the device selection in devices.js, and all three are testable without a browser.
//
// It executes nothing: it has no inputs and no outputs, so ComfyUI never runs it. Everything it
// shows comes from the WebSocket messages the page is already receiving.
//
// TWO SOURCES, and the difference matters:
//   - jobs queued from THIS ComfyUI page: the frontend IS the submitting client, so it gets
//     progress/executing/execution_* directly. No relay needed.
//   - jobs queued by anything else (the widget, another browser, an API script): those messages are
//     targeted at the submitter only. They arrive here as the relay's broadcast copies
//     (watcher.progress etc.) — same shapes, so the prefix is stripped and they take the same path.
//     Without the relay installed, a foreign job honestly reads N/A rather than a guess.
// Our own jobs therefore arrive TWICE (targeted + relay copy); JobTracker drops the duplicate.

import { app } from '../../scripts/app.js';
import { api } from '../../scripts/api.js';
import { JobTracker } from './job-state.js';
import { FACES, setFontsReady } from './face.js';
import {
  selectedDeviceLabels,
  splitDeviceCount,
  pickDevices,
  allDevices,
  acceleratorFromStats,
  mergeDriverVram,
} from './devices.js';

const TICK_MS = 250; // elapsed/ETA are clocks: they must tick between messages, like the widget's

// ONE tracker for the whole page, not one per node. The job state is a property of the SERVER, so
// two watcher nodes on the same canvas are two views of one thing — and dropping ten of them on a
// graph must not cost ten copies of the same arithmetic.

const tracker = new JobTracker();

// ── fonts ──────────────────────────────────────────────────────────────────
// Shipped with the node: a canvas font string falls back silently, so a face designed in Share
// Tech Mono would render in whatever sans-serif the box has and look nothing like the thing that
// was approved. Loaded from the extension's own URL, so the folder can be renamed on the way into
// custom_nodes/ without breaking anything.
async function loadFonts() {
  if (!globalThis.FontFace || !document.fonts) return;
  const face = (family, file, weight) =>
    new FontFace(family, `url(${new URL(`./fonts/${file}`, import.meta.url)})`, { weight });
  const faces = [
    face('WatcherMono', 'ShareTechMono-Regular.ttf', '400'),
    face('WatcherLegend', 'Rajdhani-Medium.ttf', '500'),
    face('WatcherLegend', 'Rajdhani-SemiBold.ttf', '600'),
  ];
  try {
    await Promise.all(faces.map(async (f) => document.fonts.add(await f.load())));
    setFontsReady(true);
    redraw();
  } catch (err) {
    console.warn('[comfyuiWATCHER] node fonts failed to load, falling back to system faces', err);
  }
}

// ── redraw pacing ──────────────────────────────────────────────────────────
// LiteGraph only repaints on demand. Mark dirty on every message, and while a job is running keep
// a slow timer going so the two CLOCKS (elapsed, ETA) advance between messages — a 15 s/it video
// sampler sends one progress message every 15 seconds, and a frozen elapsed reads as a hang.
let timer = null;
function redraw() {
  app.graph?.setDirtyCanvas(true, false);
}
function ensureTicking() {
  if (timer) return;
  timer = setInterval(() => {
    if (!tracker.isRunning()) {
      clearInterval(timer);
      timer = null;
    }
    redraw();
  }, TICK_MS);
}

// ── devices (the VRAM face only) ───────────────────────────────────────────
// /system_stats is stock ComfyUI and needs no relay, but it is a real request: poll it ONLY while a
// VRAM node is actually on the canvas, and stop the moment the last one is deleted. A watcher that
// keeps hitting an endpoint for a node nobody has is the kind of thing that gets a node pack
// blamed for someone's server load.
// 1s, which is what nvidia-smi-based monitors use — at 2s the row visibly trailed guiTOP sitting
// next to it (Bryan, 2026-08-17). The NVML read behind /watcher/vram costs microseconds and
// /system_stats is a dictionary lookup, so a second a poll is not a load on anything.
const DEVICE_POLL_MS = 1000;
// EXCEPT when the host has no NVML and the relay is shelling out to nvidia-smi for every answer.
// That is a process spawn, per open tab, and one a second is a real cost for a cosmetic row — a
// host answering from that path keeps the old cadence. It says which path it used, so this is
// observed rather than assumed.
const DEVICE_POLL_SLOW_MS = 2000;
let devicePollMs = DEVICE_POLL_MS;
// Both views come out of ONE poll: the cards this workflow will use, and every card on the box.
// Two nodes asking the same endpoint twice a second for the same JSON would be silly.
let gpu = { devices: [], source: 'none', error: null };
let gpuAll = { devices: [], source: 'none', error: null };
let devicePollTimer = null;
let devicePollActive = false;

function graphDevices() {
  // Flatten LiteGraph's nodes into the shape devices.js understands. Widget VALUES are read, never
  // written; this never touches the graph. The node TYPE comes too, because core's CFG Split node
  // says how many cards it will use without naming any of them.
  const nodes = (app.graph?._nodes || []).map((n) => ({
    type: n.type,
    mode: n.mode,
    values: (n.widgets || []).map((w) => ({ name: w.name, value: w.value })),
  }));
  return { labels: selectedDeviceLabels(nodes), splitCount: splitDeviceCount(nodes) };
}

function hasVramNode() {
  return (app.graph?._nodes || []).some((n) => FACES[n.type]?.needsDevices);
}

// THE START CANNOT BE GATED ON THE GRAPH. onNodeCreated fires while the node is still being built —
// LiteGraph adds it to the graph AFTERWARDS — so a "is a VRAM node on the canvas?" test at that
// moment answers no, and the poller cancelled itself before its first reading. The node then sat on
// "VRAM N/A" forever with /system_stats never once requested (found against the live :8189, 2026-08-15;
// no error anywhere, because nothing failed — it just never ran).
//
// So: the first poll is forced, and stopping needs TWO consecutive empty ticks. Loading a workflow,
// undoing, or dragging a node between graphs all momentarily show an empty canvas.
/**
 * The driver's own VRAM figures, from our relay's /watcher/vram (NVML — the same source nvitop
 * reads). A 404 is the normal answer from a host running a relay copy older than this route, and an
 * AMD box answers with an empty list: both mean "fall back to the torch arithmetic", not "error".
 */
async function driverVram() {
  try {
    const res = await api.fetchApi('/watcher/vram');
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

let missTicks = 0;
/** Returns false when the poller should stop: the last VRAM node is gone. */
async function pollDevices(force) {
  if (!force) {
    if (!hasVramNode()) return ++missTicks < 2;
    missTicks = 0;
  }
  try {
    // Concurrently: the row is only as fresh as the slower of the two, and they are independent.
    const [res, driver] = await Promise.all([api.fetchApi('/system_stats'), driverVram()]);
    devicePollMs = driver?.source === 'nvidia-smi' ? DEVICE_POLL_SLOW_MS : DEVICE_POLL_MS;
    const stats = mergeDriverVram(await res.json(), driver);
    const accel = acceleratorFromStats(stats);
    const { labels, splitCount } = graphDevices();
    gpu = { ...pickDevices(stats, labels, splitCount), accel, error: null };
    gpuAll = { ...allDevices(stats), accel, error: null };
  } catch (err) {
    // Keep the last good reading rather than blanking the node over one dropped request; say so.
    const error = String(err?.message || err);
    gpu = { ...gpu, error };
    gpuAll = { ...gpuAll, error };
  }
  redraw();
  return true;
}

/**
 * A CHAIN, not an interval: the gap has to be changeable (see DEVICE_POLL_SLOW_MS), and an
 * interval shorter than a slow answer stacks requests on a host that is already struggling.
 *
 * `devicePollActive` is what onDrawForeground tests, NOT the timer handle — the handle is null while
 * a poll is in flight, so testing it would start a second chain on the very next frame, and this is
 * called from every frame.
 */
async function runDevicePoll(force) {
  devicePollTimer = null;
  if (!(await pollDevices(force))) {
    devicePollActive = false;
    return;
  }
  devicePollTimer = setTimeout(() => runDevicePoll(false), devicePollMs);
}

function ensureDevicePolling() {
  if (devicePollActive) return;
  devicePollActive = true;
  missTicks = 0;
  runDevicePoll(true);
}

// ── wiring ─────────────────────────────────────────────────────────────────
function on(event, handler) {
  // Both the targeted message and the relay's broadcast copy of it. Identical payloads, so one
  // handler; the tracker drops the duplicate rather than counting it as a step.
  const wrapped = (e) => {
    handler(e.detail, Date.now());
    redraw();
  };
  api.addEventListener(event, wrapped);
  api.addEventListener('watcher.' + event, wrapped);
}

on('execution_start', (d, now) => {
  tracker.onExecutionStart(d, now);
  ensureTicking();
});
on('progress', (d, now) => {
  tracker.onProgress(d, now);
  ensureTicking();
});
on('progress_state', (d, now) => {
  tracker.onProgressState(d, now);
  ensureTicking();
});
on('executing', (d, now) => {
  tracker.onExecuting(d, now);
  ensureTicking();
});
on('execution_cached', (d, now) => tracker.onExecutionCached(d, now));
// Relay-only, and always broadcast: there is no targeted twin to listen for. It is what turns the
// stage line's bare position into "4 / 21" — see JobTracker.onPromptNodes.
api.addEventListener('watcher.prompt_nodes', (e) => {
  tracker.onPromptNodes(e.detail, Date.now());
  redraw();
});
on('execution_success', (d, now) => tracker.onExecutionEnd('success', d, now));
on('execution_error', (d, now) => tracker.onExecutionEnd('error', d, now));
on('execution_interrupted', (d, now) => tracker.onExecutionEnd('interrupted', d, now));
api.addEventListener('status', (e) => {
  tracker.onStatus(e.detail);
});

/**
 * Everything a face can read: the job, the device list the VRAM faces need, and the node's own
 * style. Style is per NODE — two nodes on one canvas can wear different looks.
 */
function snapshot(node, face) {
  const snap = tracker.snapshot(Date.now());
  return {
    ...snap,
    // The DISPLAY id, not the raw one: a subgraph runs under `193:120`, and the node on the canvas
    // is 193. Looking up the raw id finds nothing and the name silently disappears for the whole
    // subgraph — which on Bryan's graph was most of the run (2026-08-17).
    nodeName: runningNodeTitle(snap.displayNode ?? snap.node),
    gpu: face?.allDevices ? gpuAll : gpu,
    style: styleOf(node),
  };
}

/**
 * What the server is chewing on, in the words on your own canvas.
 *
 * A graph spends its first minute in nodes that report no steps — loaders, encoders — and a face
 * that can only say N/A through all of it looks broken rather than busy. The page already has the
 * graph, so the node's own title costs nothing to look up.
 *
 * Returns null when the id is not on this canvas, which is the normal case for a job queued
 * somewhere else: their node 42 is not our node 42, and naming the wrong node is worse than
 * naming none.
 */
function runningNodeTitle(id) {
  if (id == null) return null;
  const node = app.graph?.getNodeById?.(Number(id)) || app.graph?.getNodeById?.(id);
  if (!node) return null;
  return node.title || node.type || null;
}
const STYLES = ['rack', 'glass'];
const styleOf = (node) => {
  const w = (node?.widgets || []).find((x) => x.name === 'style');
  return STYLES.includes(w?.value) ? w.value : 'rack';
};
const faceHeight = (face, node) =>
  face.heightFor ? face.heightFor(snapshot(node, face)) : face.h;

/**
 * LiteGraph lays its widgets out from the TOP of the node body and draws them before
 * onDrawForeground — so a face drawn at y=0 would paint straight over the style combo. Reserve the
 * strip the widgets occupy and draw below it; the node grows by exactly that much.
 */
function widgetSpace(node) {
  const rowH = globalThis.LiteGraph?.NODE_WIDGET_HEIGHT || 20;
  const count = node?.widgets?.length || 0;
  return count ? count * (rowH + 4) + 6 : 0;
}
const nodeHeight = (face, node) => faceHeight(face, node) + widgetSpace(node);

app.registerExtension({
  name: 'comfyuiWATCHER.steps',
  async nodeCreated(node) {
    // Covers loading a saved workflow, where nodes appear without onNodeCreated being useful yet.
    if (FACES[node?.type]?.needsDevices) ensureDevicePolling();
  },
  async setup() {
    loadFonts();
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    const face = FACES[nodeData.name];
    if (!face) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      // The style widget is the node's only control, and it IS serialised — a saved workflow must
      // come back looking the way it was left. (It is drawn by LiteGraph in the strip under the
      // face; the faces lay out from the top and never reach it.)
      this.addWidget('combo', 'style', 'rack', () => redraw(), { values: STYLES });
      this.serialize_widgets = true;
      this.size = [face.w, nodeHeight(face, this)];
      if (face.needsDevices) ensureDevicePolling();
      return r;
    };

    // A node can be dragged wider — the readouts split the extra width — but never shorter than
    // its face: every face is laid out from the top in fixed rows, so a squashed one clips. The
    // VRAM face's height follows how many cards it is showing.
    const computeSize = nodeType.prototype.computeSize;
    nodeType.prototype.computeSize = function () {
      const size = computeSize?.apply(this, arguments) || [face.w, face.h];
      return [Math.max(face.w * 0.7, size[0]), nodeHeight(face, this)];
    };

    const onDrawForeground = nodeType.prototype.onDrawForeground;
    nodeType.prototype.onDrawForeground = function (ctx) {
      onDrawForeground?.apply(this, arguments);
      if (this.flags?.collapsed) return;
      if (face.needsDevices) ensureDevicePolling();
      const snap = snapshot(this, face);
      const h = faceHeight(face, this);
      const top = widgetSpace(this);
      // A card added or removed, or a switch to the glass style, changes how tall this node has to
      // be. Resize before drawing, or the extra row is painted outside the node's own body.
      if (Math.abs(this.size[1] - (h + top)) > 0.5) this.setSize([this.size[0], h + top]);
      ctx.save();
      try {
        ctx.translate(0, top);
        face.draw(ctx, this.size[0], h, snap);
      } finally {
        ctx.restore();
      }
    };
  },
});
