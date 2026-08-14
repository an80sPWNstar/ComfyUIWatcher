const assert = require('assert');
const {
  ComfyUIClient, describeModel, describeLatent, parseSystemStats,
} = require('../src/collectors/comfyui-client');

function makeClient() {
  return new ComfyUIClient({ name: 'test', url: 'http://127.0.0.1:1' }, () => {});
}

// _estimateStepsPerSec is pure given _progressHistory — test it directly rather than racing
// real Date.now() through _onProgress, which always appends its own fresh-timestamped sample
// and made an earlier version of this test flaky (occasionally sub-millisecond dt => null).
{
  const client = makeClient();
  const t0 = 1_000_000;
  client._progressHistory = [
    { value: 0, atMs: t0 },
    { value: 5, atMs: t0 + 2000 },
  ];
  const rate = client._estimateStepsPerSec();
  assert.ok(rate > 2.4 && rate < 2.6, `expected ~2.5 steps/sec, got ${rate}`);
}

// Fewer than 2 samples, or no time/step delta => null, never a divide-by-zero or fabricated rate.
{
  const client = makeClient();
  client._progressHistory = [{ value: 0, atMs: 1000 }];
  assert.strictEqual(client._estimateStepsPerSec(), null, 'single sample must be null');

  client._progressHistory = [{ value: 5, atMs: 1000 }, { value: 5, atMs: 2000 }];
  assert.strictEqual(client._estimateStepsPerSec(), null, 'zero step delta must be null');
}

// _onProgress wires the estimate into currentJob.stepsPerSec/etaSec end to end.
{
  const client = makeClient();
  client._onProgress({ value: 0, max: 20, prompt_id: 'p1', node: 'n1' });
  assert.strictEqual(client.currentJob.stepsPerSec, null, 'first sample alone has no rate yet');
  assert.strictEqual(client.currentJob.etaSec, null);
}

// executing with node:null must NOT blank the UI on an ordinary gap between nodes — only once
// execution_success/error has actually marked the job finished.
{
  const client = makeClient();
  client._onProgress({ value: 1, max: 20, prompt_id: 'p1', node: 'n1' });
  client._onExecuting({ node: null, prompt_id: 'p1' });
  assert.ok(client.currentJob, 'node:null between nodes (not yet finished) should not clear the job');
}
// A finished job is HELD on screen (FINISHED_HOLD_MS) — node:null must not clear it either;
// the hold timer in _emit() does the clearing once finishedAtMs is old enough.
{
  const client = makeClient();
  client._onProgress({ value: 20, max: 20, prompt_id: 'p1', node: 'n1' });
  client.currentJob.finished = 'success';
  client.currentJob.finishedAtMs = Date.now();
  client._onExecuting({ node: null, prompt_id: 'p1' });
  assert.ok(client.currentJob, 'node:null right after finished must keep the held job visible');

  client._emit();
  assert.ok(client.currentJob, 'a just-finished job survives an immediate tick');

  client.currentJob.finishedAtMs = Date.now() - 60_000; // pretend it finished a minute ago
  client._emit();
  assert.strictEqual(client.currentJob, null, 'hold expiry must clear the finished job');
}

// execution_start always begins a FRESH job — no step/maxSteps/finished inherited from the
// previous (possibly still-held finished) job.
{
  const client = makeClient();
  client._onProgress({ value: 20, max: 20, prompt_id: 'p1', node: 'n1' });
  client.currentJob.finished = 'success';
  client.currentJob.finishedAtMs = Date.now();
  client._handleMessage(JSON.stringify({ type: 'execution_start', data: { prompt_id: 'p2', timestamp: 1 } }));
  assert.strictEqual(client.currentJob.promptId, 'p2');
  assert.strictEqual(client.currentJob.finished, undefined, 'new job must not inherit finished');
  assert.strictEqual(client.currentJob.maxSteps, undefined, 'new job must not inherit maxSteps');
}

// progress for a new prompt while a finished job is still held also starts fresh (covers
// connecting mid-job / missing execution_start).
{
  const client = makeClient();
  client._onProgress({ value: 20, max: 20, prompt_id: 'p1', node: 'n1' });
  client.currentJob.finished = 'success';
  client.currentJob.finishedAtMs = Date.now();
  client._onProgress({ value: 1, max: 30, prompt_id: 'p2', node: 'n9' });
  assert.strictEqual(client.currentJob.finished, undefined, 'progress after finished starts a fresh job');
  assert.strictEqual(client.currentJob.maxSteps, 30);
}

// "watcher."-prefixed relay copies (from our comfyui-relay custom node) must behave exactly
// like the original targeted messages.
{
  const client = makeClient();
  client._handleMessage(JSON.stringify({
    type: 'watcher.progress',
    data: { value: 3, max: 20, prompt_id: 'pr1', node: 'n5' },
  }));
  assert.strictEqual(client.currentJob.step, 3, 'watcher.progress must feed _onProgress');
  assert.strictEqual(client.currentJob.maxSteps, 20);
  client._handleMessage(JSON.stringify({ type: 'watcher.execution_success', data: { prompt_id: 'pr1' } }));
  assert.strictEqual(client.currentJob.finished, 'success', 'watcher.execution_success must mark finished');
}

// Node id -> display name from the running prompt's graph, incl. composite subgraph ids.
{
  const client = makeClient();
  client._applyQueue({
    queue_running: [[0, 'pn1', {
      3: { class_type: 'KSampler', inputs: {} },
      105: { class_type: 'SubgraphNode', _meta: { title: 'My Video Stage' }, inputs: {} },
    }, {}, []]],
  });
  assert.strictEqual(client._nodeName('3'), 'KSampler');
  assert.strictEqual(client._nodeName('105'), 'My Video Stage', '_meta.title wins over class_type');
  assert.strictEqual(client._nodeName('105:14'), 'My Video Stage', 'composite id falls back to subgraph node');
  assert.strictEqual(client._nodeName('999'), null, 'unknown id resolves to null (renderer shows raw id)');
}

// ---- REST poller reconciliation (_applyQueue / _applyHistory are pure state methods) ----

// A running foreign job appears in /queue → a fresh poll-sourced job is created.
{
  const client = makeClient();
  const out = client._applyQueue({ queue_running: [[0, 'pf1', {}, {}, []]], queue_pending: [] });
  assert.strictEqual(out, null, 'nothing to resolve while a job is running');
  assert.strictEqual(client.currentJob.promptId, 'pf1');
  assert.ok(client.currentJob.startedAtMs, 'poll-discovered job gets a first-seen timestamp');
}

// Same prompt still running on the next poll → job object untouched (WS enrichment survives).
{
  const client = makeClient();
  client._applyQueue({ queue_running: [[0, 'pf1', {}, {}, []]] });
  client.currentJob.step = 7; // pretend WS progress enriched it
  client._applyQueue({ queue_running: [[0, 'pf1', {}, {}, []]] });
  assert.strictEqual(client.currentJob.step, 7, 'repeat poll must not reset an in-progress job');
}

// Queue goes empty while we show an unfinished job → its prompt_id is returned for /history.
{
  const client = makeClient();
  client._applyQueue({ queue_running: [[0, 'pf1', {}, {}, []]] });
  const out = client._applyQueue({ queue_running: [], queue_pending: [] });
  assert.strictEqual(out, 'pf1', 'stopped job must be resolved via history');
}

// _applyHistory: success + exact duration from ComfyUI's own message timestamps.
{
  const client = makeClient();
  client._applyQueue({ queue_running: [[0, 'pf1', {}, {}, []]] });
  client._applyHistory('pf1', {
    status: {
      status_str: 'success',
      completed: true,
      messages: [
        ['execution_start', { prompt_id: 'pf1', timestamp: 1786461241785 }],
        ['execution_success', { prompt_id: 'pf1', timestamp: 1786461256847 }],
      ],
    },
  });
  assert.strictEqual(client.currentJob.finished, 'success');
  assert.ok(Math.abs(client.currentJob.finalElapsedSec - 15.062) < 0.001, 'duration from server timestamps');
  assert.ok(client.currentJob.finishedAtMs, 'local finishedAtMs drives the hold timer');
}

// _applyHistory: error status and a missing entry.
{
  const client = makeClient();
  client._applyQueue({ queue_running: [[0, 'pf1', {}, {}, []]] });
  client._applyHistory('pf1', { status: { status_str: 'error', completed: false, messages: [] } });
  assert.strictEqual(client.currentJob.finished, 'error');

  const client2 = makeClient();
  client2._applyQueue({ queue_running: [[0, 'pf2', {}, {}, []]] });
  client2._applyHistory('pf2', undefined);
  assert.strictEqual(client2.currentJob, null, 'no history entry clears the job');
}

// describeModel: the diffusion model wins over other loaders, path and extension are stripped,
// and a wired input (["12", 0]) is never mistaken for a filename.
{
  const graph = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'SDXL/juggernautXL_v9.safetensors' } },
    '2': { class_type: 'VAELoader', inputs: { vae_name: 'sdxl_vae.safetensors' } },
    '3': { class_type: 'KSampler', inputs: { model: ['1', 0], steps: 20 } },
  };
  assert.strictEqual(describeModel(graph), 'juggernautXL_v9');

  const gguf = {
    '1': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'flux1-dev-Q8_0.gguf' } },
    '2': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd15.safetensors' } },
  };
  assert.strictEqual(describeModel(gguf), 'flux1-dev-Q8_0', 'unet_name outranks ckpt_name');

  assert.strictEqual(describeModel({}), null, 'empty graph => null, never a guess');
  assert.strictEqual(
    describeModel({ '1': { class_type: 'KSampler', inputs: { model: ['9', 0] } } }),
    null,
    'a wired input is not a model name',
  );
  assert.strictEqual(
    describeModel({ '1': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat.safetensors' } } }),
    null,
    'only known model keys are read — prompt text is never touched',
  );
}

// describeLatent: size and frames are separate values — the card labels each one.
{
  const img = { '5': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 4 } } };
  assert.deepStrictEqual(describeLatent(img), { size: '1024x1024', frames: null, batch: 4 });

  const vid = { '5': { class_type: 'EmptyHunyuanLatentVideo', inputs: { width: 1280, height: 720, length: 121 } } };
  assert.deepStrictEqual(describeLatent(vid), { size: '1280x720', frames: 121, batch: null });

  const oneFrame = { '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, length: 1, batch_size: 1 } } };
  assert.strictEqual(describeLatent(oneFrame).frames, null, 'length 1 is not a video, no frames row');
  assert.strictEqual(describeLatent(oneFrame).batch, 1, 'a batch of 1 is still worth printing');

  const noLatent = { '5': { class_type: 'ImageScale', inputs: { width: 512, height: 512 } } };
  assert.strictEqual(describeLatent(noLatent).size, null, 'width/height on a non-latent node is not the job size');
  assert.deepStrictEqual(describeLatent({}), { size: null, frames: null, batch: null });
}

// _applyQueue folds identity onto the job it starts.
{
  const client = makeClient();
  client._applyQueue({
    queue_running: [[0, 'pid1', {
      '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'models/dreamshaper_8.safetensors' } },
      '5': { class_type: 'EmptyLatentImage', inputs: { width: 832, height: 1216 } },
    }, {}, []]],
  });
  assert.strictEqual(client.currentJob.model, 'dreamshaper_8');
  assert.strictEqual(client.currentJob.size, '832x1216');
}

// ── Rate window resets: the batch-job bug (found live 2026-08-13) ──
// A batch job runs the SAME sampler node over and over: value 1..8, then 1..8 again for the next
// image, all under one prompt_id. The window must be thrown away when the bar restarts, or the
// stale high values make the delta negative and the rate reads null for most of every image —
// which is what "the dial only registers with 2 steps left" was.
{
  const client = makeClient();
  for (let v = 1; v <= 8; v++) client._onProgress({ value: v, max: 8, prompt_id: 'p1', node: '9' });
  assert.ok(client._progressHistory.length >= 2, 'a run of steps builds a window');

  client._onProgress({ value: 1, max: 8, prompt_id: 'p1', node: '9' });
  assert.strictEqual(client._progressHistory.length, 1, 'a restarted bar starts a fresh window');
  assert.strictEqual(client._progressHistory[0].value, 1);
  assert.strictEqual(client.currentJob.stepsPerSec, null, 'no rate from one sample after a restart');

  // ...and the very next step gives a rate again, rather than waiting for the old samples to age
  // out of the window.
  client._progressHistory[0].atMs -= 4000; // pretend that step took 4s
  client._onProgress({ value: 2, max: 8, prompt_id: 'p1', node: '9' });
  const rate = client.currentJob.stepsPerSec;
  assert.ok(rate > 0.2 && rate < 0.3, `expected ~0.25 it/s one step into the new image, got ${rate}`);
}

// A different node is a different progress bar (a tiled VAE decode has its own max) — splicing
// two bars together measures nothing.
{
  const client = makeClient();
  client._onProgress({ value: 4, max: 20, prompt_id: 'p1', node: '9' });
  client._onProgress({ value: 5, max: 20, prompt_id: 'p1', node: '9' });
  client._onProgress({ value: 1, max: 6, prompt_id: 'p1', node: '12' });
  assert.deepStrictEqual(
    client._progressHistory.map((p) => [p.value, p.node]),
    [[1, '12']],
    'a change of node starts a fresh window',
  );
}

// A job submitted under our own clientId arrives twice (ComfyUI's targeted message + the relay's
// broadcast copy). The duplicate must be ignored, not recorded as a zero-step interval and not
// treated as a restarted bar.
{
  const client = makeClient();
  client._onProgress({ value: 3, max: 20, prompt_id: 'p1', node: '9' });
  client._onProgress({ value: 3, max: 20, prompt_id: 'p1', node: '9' });
  assert.strictEqual(client._progressHistory.length, 1, 'a duplicate message adds no sample');
  client._progressHistory[0].atMs -= 2000;
  client._onProgress({ value: 4, max: 20, prompt_id: 'p1', node: '9' });
  assert.ok(client.currentJob.stepsPerSec > 0, 'the step after a duplicate still yields a rate');
}

// A slow sampler (H3 video: 14-30 s/it) must still get a rate. Samples older than the 20s window
// are kept while there are fewer than RATE_MIN_SAMPLES_KEPT of them — a window that empties itself
// would park the needle for the entire run, which is the job that most needs the reading.
{
  const client = makeClient();
  const t0 = 1_000_000;
  client._progressHistory = [
    { value: 1, atMs: t0, node: '9' },
    { value: 2, atMs: t0 + 30000, node: '9' },
  ];
  const rate = client._estimateStepsPerSec();
  assert.ok(rate > 0.03 && rate < 0.04, `expected ~0.033 it/s (30 s/it), got ${rate}`);
}

// One long pause inside the window must not drag the estimate: intervals over 3x the median are
// dropped as pauses, and what is left is averaged.
{
  const client = makeClient();
  const t0 = 1_000_000;
  client._progressHistory = [
    { value: 1, atMs: t0, node: '9' },
    { value: 2, atMs: t0 + 2000, node: '9' },
    { value: 3, atMs: t0 + 4000, node: '9' },
    { value: 4, atMs: t0 + 44000, node: '9' }, // 40s stall (model swap, tiled decode, OS swap)
    { value: 5, atMs: t0 + 46000, node: '9' },
  ];
  const rate = client._estimateStepsPerSec();
  assert.ok(rate > 0.45 && rate < 0.55, `expected ~0.5 it/s ignoring the stall, got ${rate}`);
}

// ── Batch position, and the rate surviving a batch item boundary ──
{
  const client = makeClient();
  // Item 1 of a batch. Every call lands in the same millisecond, so age the window by 2s after each
  // one — otherwise no interval is measurable and the test proves nothing about the rate.
  for (let v = 1; v <= 8; v++) {
    client._onProgress({ value: v, max: 8, prompt_id: 'p1', node: '9' });
    for (const p of client._progressHistory) p.atMs -= 2000;
  }
  client._onProgress({ value: 8, max: 8, prompt_id: 'p1', node: '9' }); // duplicate: recomputes only
  assert.strictEqual(client.currentJob.pass, 1, 'first item is pass 1');
  const rateAtEndOfItem1 = client.currentJob.stepsPerSec;
  assert.ok(rateAtEndOfItem1 > 0, 'a rate was measured during the first item');

  // Item 2 starts: the window is emptied, so no interval can be measured from one sample — but the
  // last known rate must be HELD, or the meter's backlight blinks once per image.
  client._onProgress({ value: 1, max: 8, prompt_id: 'p1', node: '9' });
  assert.strictEqual(client.currentJob.pass, 2, 'a restarted bar is the next item');
  assert.strictEqual(client.currentJob.stepsPerSec, rateAtEndOfItem1, 'rate is held across the item boundary');
  assert.strictEqual(client._progressHistory.length, 1, 'the window itself still restarts');

  // A new prompt clears the count.
  client._handleMessage(JSON.stringify({ type: 'execution_start', data: { prompt_id: 'p2' } }));
  client._onProgress({ value: 1, max: 8, prompt_id: 'p2', node: '9' });
  assert.strictEqual(client.currentJob.pass, 1, 'a new prompt starts counting again');
  assert.strictEqual(client.currentJob.stepsPerSec, null, 'a new prompt does NOT inherit the old rate');
}

// watcher.batch (relay only) supplies the total; without it the snapshot carries pass and a null
// total rather than a guessed denominator.
{
  const client = makeClient();
  client._onProgress({ value: 1, max: 8, prompt_id: 'p1', node: '9' });
  let snap = null;
  client.onUpdate = (_name, s) => { snap = s; };
  client._emit();
  assert.strictEqual(snap.currentJob.pass, 1);
  assert.strictEqual(snap.currentJob.passTotal, null, 'no relay total => null, never a fabricated 1');

  client._handleMessage(JSON.stringify({ type: 'watcher.batch', data: { prompt_id: 'p1', node: '9', total: 28 } }));
  client._emit();
  assert.strictEqual(snap.currentJob.passTotal, 28, 'the relay total lands on the job');
  assert.strictEqual(client.relaySeen, true, 'a watcher.* message also proves the relay is installed');

  // A total for some other node must not be shown against this one.
  client._handleMessage(JSON.stringify({ type: 'watcher.batch', data: { prompt_id: 'p1', node: '12', total: 4 } }));
  client._emit();
  assert.strictEqual(snap.currentJob.passTotal, 28, 'totals are per node');
}


// ---- whole-batch ETA ----
// The per-image ETA answers "when does this image land"; jobEtaSec answers "when is the run done".
// It needs a relay total, so it stays null without one rather than counting down to a guess.
{
  const client = makeClient();
  let snap = null;
  client.onUpdate = (_name, s) => { snap = s; };

  let t = 1000;
  const at = (ms, value) => { t = ms; client._onProgress({ value, max: 8, prompt_id: 'p1', node: '9' }); };
  const origNow = Date.now;
  Date.now = () => t;
  try {
    at(1000, 1); at(2000, 2); at(3000, 3);
    client._emit();
    assert.strictEqual(snap.currentJob.jobEtaSec, null, 'no relay total => no batch ETA, never a guess');

    client._handleMessage(JSON.stringify({ type: 'watcher.batch', data: { prompt_id: 'p1', node: '9', total: 4 } }));
    at(4000, 4);
    client._emit();
    // 1 step/s measured, 4 steps left on this item, 3 items after it. Before any item has
    // completed the per-item cost falls back to maxSteps/rate = 8s, so 4 + 3*8 = 28.
    assert.ok(snap.currentJob.jobEtaSec > snap.currentJob.etaSec, 'batch ETA exceeds the per-image one');
    assert.strictEqual(Math.round(snap.currentJob.jobEtaSec), 28, 'falls back to sampling time before an item completes');

    // Item 2 starts: the bar restarts, which is when a real per-item duration is learned (9s).
    at(10000, 1);
    client._emit();
    assert.strictEqual(snap.currentJob.pass, 2, 'a restarted bar is the next item');
    assert.deepStrictEqual(client._itemDurations, [9], 'the measured item includes decode and save, not just steps');

    at(11000, 2);
    client._emit();
    // 6 steps left at 1/s, 2 items after this one at the measured 9s each = 6 + 18 = 24.
    assert.strictEqual(Math.round(snap.currentJob.jobEtaSec), 24, 'measurement replaces the fallback');
  } finally {
    Date.now = origNow;
  }
}

// parseSystemStats: the build info the reactor panel's windows print. The payload below is the
// REAL response from Bryan's New Main (ComfyUI 0.33.1), trimmed — parsing a shape that came off a
// live server is the only version of this test worth having.
{
  const live = {
    system: {
      os: 'win32',
      comfyui_version: '0.33.1',
      python_version: '3.13.12 (main, Feb 12 2026, 00:38:53) [MSC v.1944 64 bit (AMD64)]',
      pytorch_version: '2.13.0+cu130',
      embedded_python: false,
    },
    devices: [{ name: 'cuda:0 NVIDIA GeForce RTX 5070 Ti : cudaMallocAsync', type: 'cuda', index: 0 }],
  };
  const v = parseSystemStats(live);
  assert.strictEqual(v.comfyui, '0.33.1');
  assert.strictEqual(v.pytorch, '2.13.0', 'the +cu build tag is not part of the torch version');
  assert.strictEqual(v.accel, 'CUDA');
  assert.strictEqual(v.accelVersion, '13.0', 'cu130 is CUDA 13.0, read off the torch build tag');
  assert.strictEqual(v.python, '3.13.12', 'the compiler banner is dropped');
  assert.strictEqual(v.driver, undefined, 'the driver is never in /system_stats — it needs the relay');

  const cu118 = parseSystemStats({ system: { pytorch_version: '2.4.1+cu118' } });
  assert.strictEqual(cu118.accelVersion, '11.8');

  // ── ROCm. A PyTorch ROCm build reports torch.cuda, device.type 'cuda' and a 'cuda:0' device name,
  // so the ONLY reliable tell in /system_stats is the build tag (plus the card's own name as a
  // backup). Labelling an AMD box "CUDA" would be the wrong label on a right number.
  const rocm = parseSystemStats({
    system: { comfyui_version: '0.33.1', pytorch_version: '2.5.1+rocm6.2' },
    devices: [{ name: 'cuda:0 AMD Radeon RX 7900 XTX', type: 'cuda', index: 0 }],
  });
  assert.strictEqual(rocm.accel, 'ROCm');
  assert.strictEqual(rocm.accelVersion, '6.2', 'the rocm tag carries its version plainly');
  assert.strictEqual(rocm.pytorch, '2.5.1');

  // No build tag at all (source/conda build): the card's name still says which stack it must be,
  // but not which version — so the stack is named and the version stays null.
  const untagged = parseSystemStats({
    system: { pytorch_version: '2.6.0' },
    devices: [{ name: 'AMD Instinct MI300X', type: 'cuda', index: 0 }],
  });
  assert.strictEqual(untagged.accel, 'ROCm');
  assert.strictEqual(untagged.accelVersion, null, 'never invent a version off a device name');
  assert.strictEqual(
    parseSystemStats({ system: { pytorch_version: '2.6.0' }, devices: [{ name: 'NVIDIA GeForce RTX 4090' }] }).accel,
    'CUDA',
  );

  const cpu = parseSystemStats({ system: { pytorch_version: '2.4.1+cpu' } });
  assert.strictEqual(cpu.accel, 'CPU');
  assert.strictEqual(cpu.accelVersion, null);
  assert.strictEqual(parseSystemStats({ system: { pytorch_version: '2.5.1+xpu' } }).accel, 'XPU');

  // Nothing to go on: no tag, no devices. The window disappears rather than guessing a stack.
  assert.strictEqual(parseSystemStats({ system: { pytorch_version: '2.6.0' } }).accel, null);
  assert.strictEqual(parseSystemStats({ system: {} }).comfyui, null, 'a field that is not there is null');
  assert.strictEqual(parseSystemStats({}), null, 'no system block => nothing claimed');
  assert.strictEqual(parseSystemStats(null), null);
}

console.log('comfyui-client.test.js: all assertions passed');
