const assert = require('assert');
const {
  ComfyUIClient, describeModel, describeLatent, detectMedia, parseSystemStats,
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

// _etaSec drains BETWEEN steps. Same three cases the canvas node's job-state.js is pinned on
// (test/watcher-node.test.js) — the two implementations are required to agree, so if one moves the
// other must. Fields are set directly rather than driven through _onProgress for the reason given
// at the top of this file: _onProgress stamps its own Date.now() and the drain is measured against
// that stamp.
{
  const client = makeClient();
  // 20-step job, 1 it/s, step 1 just landed => 19 steps left.
  client.currentJob = { stepsPerSec: 1, etaAtStepSec: 19, etaStepAtMs: Date.now() };
  assert.ok(Math.abs(client._etaSec() - 19) < 0.05, `at the step, 19s; got ${client._etaSec()}`);

  client.currentJob.etaStepAtMs = Date.now() - 500;
  assert.ok(Math.abs(client._etaSec() - 18.5) < 0.05, `half a step in, 18.5s; got ${client._etaSec()}`);

  // A STALL HOLDS at the whole steps remaining instead of counting on to zero — the in-flight
  // term floors, so a job that stopped stepping never promises a finish that is not coming.
  client.currentJob.etaStepAtMs = Date.now() - 5000;
  assert.ok(Math.abs(client._etaSec() - 18) < 0.05, `stalled holds at 18s; got ${client._etaSec()}`);
}

// No measured rate, or no recorded figure to drain, is null — never a fabricated countdown.
{
  const client = makeClient();
  client.currentJob = { stepsPerSec: null, etaAtStepSec: 19, etaStepAtMs: Date.now() };
  assert.strictEqual(client._etaSec(), null, 'no rate means no ETA');
  client.currentJob = { stepsPerSec: 1, etaAtStepSec: null, etaStepAtMs: Date.now() };
  assert.strictEqual(client._etaSec(), null, 'no recorded ETA means no ETA');
  client.currentJob = null;
  assert.strictEqual(client._etaSec(), null, 'no job means no ETA');
}

// The DRAINED figure has to reach the renderer, not the one frozen at the last step. _emit()'s
// currentJob payload is an explicit whitelist, which is exactly how `media` was computed correctly
// and never shown (2026-08-14) — assert on the emitted snapshot, not on client.currentJob.
{
  let snap = null;
  const client = new ComfyUIClient({ name: 'test', url: 'http://127.0.0.1:1' }, (_h, s) => { snap = s; });
  client.currentJob = {
    promptId: 'p1', step: 1, maxSteps: 20,
    stepsPerSec: 1, etaAtStepSec: 19, etaStepAtMs: Date.now() - 500,
  };
  client._emit();
  assert.ok(Math.abs(snap.currentJob.etaSec - 18.5) < 0.05,
    `emitted ETA must be the drained one, got ${snap.currentJob.etaSec}`);

  // A finished job has no ETA at all, drain or no drain.
  client.currentJob.finished = 'success';
  client.currentJob.finishedAtMs = Date.now();
  client._emit();
  assert.strictEqual(snap.currentJob.etaSec, null, 'a finished job emits no ETA');
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

// The snapshot payload is an explicit whitelist of fields, so anything the collector works out and
// forgets to list there never reaches a card. detectMedia shipped that way once: it was right about
// every graph and every card still printed the image face, because `media` was not in this object.
{
  const emitted = [];
  const client = new ComfyUIClient({ name: 'test', url: 'http://127.0.0.1:1' }, (_h, snap) => emitted.push(snap));
  client._applyQueue({
    queue_running: [[0, 'pv1', {
      '12': { class_type: 'UNETLoader', inputs: { unet_name: 'wan2.2_i2v_high_noise_14B_fp8.safetensors' } },
      '7': { class_type: 'WanImageToVideo', inputs: { width: 832, height: 480, length: 121 } },
    }, {}, []]],
  });
  client._emit();
  const job = emitted.at(-1).currentJob;
  assert.strictEqual(job.media, 'video', 'media must survive into the emitted snapshot');
  assert.strictEqual(job.size, '832x480');
  assert.strictEqual(job.frames, 121);

  const stills = [];
  const still = new ComfyUIClient({ name: 'test', url: 'http://127.0.0.1:1' }, (_h, snap) => stills.push(snap));
  still._applyQueue({
    queue_running: [[0, 'pi1', {
      '5': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 2 } },
    }, {}, []]],
  });
  still._emit();
  assert.strictEqual(stills.at(-1).currentJob.media, 'image');
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

  // A graph with NO latent node at all: Wan/HunyuanVideo image-to-video builds the latent inside
  // the node that takes the conditioning, so the size lived nowhere the old rule looked and the
  // card showed neither SIZE nor FRAMES for the exact jobs that need them most.
  const wan = { '7': { class_type: 'WanImageToVideo', inputs: { width: 832, height: 480, length: 121, batch_size: 1 } } };
  assert.deepStrictEqual(describeLatent(wan), { size: '832x480', frames: 121, batch: 1 });

  // Every pack names the frame input differently.
  const svd = { '7': { class_type: 'SVD_img2vid_Conditioning', inputs: { width: 1024, height: 576, video_frames: 25 } } };
  assert.strictEqual(describeLatent(svd).frames, 25, 'video_frames counts as frames');

  // A real latent node WINS over a video node carrying the same fields — it is the authoritative
  // statement of the output size, whatever order the graph object happens to be in.
  const both = {
    '7': { class_type: 'WanImageToVideo', inputs: { width: 512, height: 512, length: 49 } },
    '5': { class_type: 'EmptyHunyuanLatentVideo', inputs: { width: 1280, height: 720, length: 121 } },
  };
  assert.strictEqual(describeLatent(both).size, '1280x720', 'the latent node is the size of record');
}

// detectMedia: which SCALE the rate instrument should print. Video and image sampling are two
// orders of magnitude apart, so this is what stops a healthy 15 s/it video run reading as SLOW.
{
  const sdxl = {
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 4 } },
    '3': { class_type: 'KSampler', inputs: { steps: 30 } },
  };
  assert.strictEqual(detectMedia(sdxl), 'image');

  // Signal 1: a node class that only exists in a video pipeline.
  assert.strictEqual(detectMedia({ '7': { class_type: 'WanImageToVideo', inputs: {} } }), 'video');
  assert.strictEqual(detectMedia({ '7': { class_type: 'VHS_VideoCombine', inputs: {} } }), 'video');

  // Signal 2: more than one frame, under any of the names the packs use.
  assert.strictEqual(detectMedia({ '5': { class_type: 'EmptyLatentImage', inputs: { length: 81 } } }), 'video');
  assert.strictEqual(detectMedia({ '5': { class_type: 'SomeNode', inputs: { num_frames: 49 } } }), 'video');
  assert.strictEqual(
    detectMedia({ '5': { class_type: 'EmptyLatentImage', inputs: { length: 1, batch_size: 8 } } }),
    'image',
    'one frame and a batch of 8 is eight stills, not a video',
  );

  // Signal 3, last resort: the model family. Bryan's H3 workflow is exactly this case — a
  // SamplerCustomAdvanced graph whose video-ness is only visible in the checkpoint name.
  const h3 = {
    '12': { class_type: 'UNETLoader', inputs: { unet_name: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors' } },
    '9': { class_type: 'SamplerCustomAdvanced', inputs: {} },
  };
  assert.strictEqual(detectMedia(h3), 'video');

  // No graph is not a guess.
  assert.strictEqual(detectMedia(null), null);
  assert.strictEqual(detectMedia({}), null, 'an empty graph says nothing either way');
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
// THE CLOCK IS STUBBED HERE ON PURPOSE. Driven by the real one, the 8-step loop below runs inside
// a millisecond or two, so whether a rate exists at all depends on machine load — and the version
// of this test that asserted `stepsPerSec === null` after the restart was passing for the wrong
// reason (no interval, so no rate had ever been measured) and failed roughly 1 run in 10 under a
// parallel suite, reporting 1000 it/s from a 1ms interval.
{
  const client = makeClient();
  let t = 1_000_000;
  const origNow = Date.now;
  Date.now = () => t;
  try {
    for (let v = 1; v <= 8; v++) {
      client._onProgress({ value: v, max: 8, prompt_id: 'p1', node: '9' });
      t += 4000; // 4s per step => 0.25 it/s
    }
    assert.ok(client._progressHistory.length >= 2, 'a run of steps builds a window');
    assert.ok(Math.abs(client.currentJob.stepsPerSec - 0.25) < 0.01,
      `8 steps at 4s each is 0.25 it/s, got ${client.currentJob.stepsPerSec}`);

    client._onProgress({ value: 1, max: 8, prompt_id: 'p1', node: '9' });
    assert.strictEqual(client._progressHistory.length, 1, 'a restarted bar starts a fresh window');
    assert.strictEqual(client._progressHistory[0].value, 1);
    // The WINDOW is emptied, the RATE is not: the next image is the same work at the same size on
    // the same model, and blanking the figure for one step in every item is what used to make the
    // meter's backlight flicker through a batch run.
    assert.ok(Math.abs(client.currentJob.stepsPerSec - 0.25) < 0.01,
      `the measured rate is held across an item boundary, got ${client.currentJob.stepsPerSec}`);
    // ...and so is the ETA, which reads the held rate. It used to read the fresh estimate, which is
    // null here, so ETA blanked for one step of every item while RATE beside it kept reading.
    assert.ok(Math.abs(client.currentJob.etaSec - 28) < 0.1,
      `7 steps left at 0.25 it/s is 28s, got ${client.currentJob.etaSec}`);

    // ...and the very next step measures again, rather than waiting for old samples to age out.
    t += 4000;
    client._onProgress({ value: 2, max: 8, prompt_id: 'p1', node: '9' });
    const rate = client.currentJob.stepsPerSec;
    assert.ok(rate > 0.2 && rate < 0.3, `expected ~0.25 it/s one step into the new image, got ${rate}`);
  } finally {
    Date.now = origNow;
  }
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
