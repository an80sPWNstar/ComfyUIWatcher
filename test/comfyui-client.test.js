const assert = require('assert');
const { ComfyUIClient, describeModel, describeLatent } = require('../src/collectors/comfyui-client');

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

console.log('comfyui-client.test.js: all assertions passed');
