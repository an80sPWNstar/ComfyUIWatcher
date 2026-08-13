const assert = require('assert');
const { AIToolkitClient, parseJobConfig } = require('../src/collectors/aitoolkit-client');

function makeClient() {
  return new AIToolkitClient({ name: 'test', url: 'http://127.0.0.1:1', kind: 'aitoolkit' }, () => {});
}

// A job_config as ai-toolkit actually stores it — shape taken from Bryan's own rows in
// D:\ai-toolkit\aitk_db.db, not invented.
function jobConfig(overrides = {}) {
  return JSON.stringify({
    config: {
      process: [
        {
          model: { name_or_path: 'krea/Krea-2-Raw' },
          network: { type: 'lora', linear: 32 },
          train: { steps: 3000, batch_size: 1 },
          datasets: [{ resolution: [512, 768, 1024] }],
          ...overrides,
        },
      ],
    },
  });
}

// ---- parseJobConfig ----
{
  const cfg = parseJobConfig(jobConfig());
  assert.strictEqual(cfg.model, 'Krea-2-Raw', 'model name is the basename of name_or_path');
  assert.strictEqual(cfg.rank, 32);
  assert.strictEqual(cfg.steps, 3000);
  assert.strictEqual(cfg.resolution, '512/768/1024', 'multi-resolution buckets are all shown');
}

// Garbage in, nulls out — the card hides a row it has no value for rather than guessing.
{
  for (const bad of ['', 'not json', '{}', JSON.stringify({ config: {} })]) {
    const cfg = parseJobConfig(bad);
    assert.strictEqual(cfg.model, null, `model must be null for ${JSON.stringify(bad)}`);
    assert.strictEqual(cfg.rank, null);
    assert.strictEqual(cfg.steps, null);
    assert.strictEqual(cfg.resolution, null);
  }
}

// A single resolution and an alternate rank key still resolve.
{
  const cfg = parseJobConfig(jobConfig({ network: { lora_rank: 64 }, datasets: [{ resolution: 1024 }] }));
  assert.strictEqual(cfg.rank, 64, 'lora_rank is accepted when linear is absent');
  assert.strictEqual(cfg.resolution, '1024');
}

// A local path model, as SimpleTuner-style configs and local checkpoints produce.
{
  const cfg = parseJobConfig(jobConfig({ model: { name_or_path: 'D:\\models\\flux1-dev.safetensors' } }));
  assert.strictEqual(cfg.model, 'flux1-dev', 'path and extension are stripped');
}

// ---- steps: job_config beats the total_steps column ----
// The live H3 job reads step 4204 / total_steps 2500 while its config says 5000. Trusting the
// column would show a job 168% complete with negative steps remaining.
{
  const client = makeClient();
  client.currentJob = { jobId: 'j1' };
  client._applyJob({ id: 'j1', name: 'w1f3y_h3_v1', status: 'running', step: 4204, total_steps: 2500, job_config: jobConfig({ train: { steps: 5000 } }) });
  assert.strictEqual(client.currentJob.maxSteps, 5000, 'job_config.steps wins over total_steps');
  assert.strictEqual(client.currentJob.step, 4204);
}

// ...but the column is still the fallback when the config has no step count.
{
  const client = makeClient();
  client.currentJob = { jobId: 'j1' };
  client._applyJob({ id: 'j1', status: 'running', step: 10, total_steps: 2500, job_config: '{}' });
  assert.strictEqual(client.currentJob.maxSteps, 2500, 'total_steps is the fallback, not ignored');
}

// ---- rate estimation ----
// Only a CHANGED step is a sample. Polling at 1s while a step takes 30s (Bryan's LoKr run) would
// otherwise fill the window with duplicates.
{
  const client = makeClient();
  client.currentJob = { jobId: 'j1' };
  const row = { id: 'j1', status: 'running', step: 100, total_steps: 3000, job_config: jobConfig() };
  client._applyJob(row, true);
  client._applyJob(row, true);
  client._applyJob(row, true);
  assert.strictEqual(client._stepHistory.length, 1, 'repeated identical steps are one sample');
  assert.strictEqual(client.currentJob.stepsPerSec, null, 'one sample yields no rate');
  assert.strictEqual(client.currentJob.phase, null, 'a row with no info has no phase');
  assert.strictEqual(client.currentJob.etaSec, null, 'no rate means no ETA, never a fabricated 0');
}

{
  const client = makeClient();
  const t0 = 1_000_000;
  client._stepHistory = [
    { value: 100, atMs: t0 },
    { value: 101, atMs: t0 + 2000 },
    { value: 102, atMs: t0 + 4000 },
    { value: 103, atMs: t0 + 6000 },
  ];
  const rate = client._estimateStepsPerSec();
  assert.ok(rate > 0.49 && rate < 0.51, `expected ~0.5 steps/sec (2 s/it), got ${rate}`);
}

// THE REGRESSION THIS METHOD EXISTS FOR. Real numbers, measured live 2026-08-13: the run sat on
// step 5250 for 131s loading its model, then stepped every ~2s. First-to-last across the window
// reported 45.07 s/it and a 9h21m ETA on a job ~25 minutes from done.
{
  const client = makeClient();
  const t0 = 1_000_000;
  client._stepHistory = [
    { value: 5250, atMs: t0 },
    { value: 5251, atMs: t0 + 131000 },
    { value: 5252, atMs: t0 + 133000 },
    { value: 5253, atMs: t0 + 135000 },
  ];
  const rate = client._estimateStepsPerSec();
  assert.ok(rate > 0.49 && rate < 0.51, `startup stall must not poison the rate, got ${1 / rate} s/it`);
}

// A checkpoint pause mid-window (save_every: 250) is the same shape and must also be ignored.
{
  const client = makeClient();
  const t0 = 1_000_000;
  client._stepHistory = [
    { value: 500, atMs: t0 },
    { value: 501, atMs: t0 + 2000 },
    { value: 502, atMs: t0 + 62000 }, // 60s writing a checkpoint
    { value: 503, atMs: t0 + 64000 },
    { value: 504, atMs: t0 + 66000 },
  ];
  const rate = client._estimateStepsPerSec();
  assert.ok(rate > 0.49 && rate < 0.51, `checkpoint pause must not poison the rate, got ${1 / rate} s/it`);
}

// Poll quantisation: a real 2.7 s/it run polled once a second yields 2s and 3s intervals. Taking
// one interval (a median) snaps to 3.00; averaging the non-outliers recovers the true figure.
{
  const client = makeClient();
  const t0 = 1_000_000;
  client._stepHistory = [
    { value: 100, atMs: t0 },
    { value: 101, atMs: t0 + 3000 },
    { value: 102, atMs: t0 + 5000 },
    { value: 103, atMs: t0 + 8000 },
    { value: 104, atMs: t0 + 11000 },
    { value: 105, atMs: t0 + 13000 },
  ];
  const sPerIt = 1 / client._estimateStepsPerSec();
  assert.ok(Math.abs(sPerIt - 2.6) < 0.05, `expected ~2.6 s/it from mixed 2s/3s intervals, got ${sPerIt}`);
}

// A genuinely slow run is reported slow — the estimate must not flatter it.
{
  const client = makeClient();
  const t0 = 1_000_000;
  client._stepHistory = [
    { value: 10, atMs: t0 },
    { value: 11, atMs: t0 + 30000 },
    { value: 12, atMs: t0 + 60000 },
    { value: 13, atMs: t0 + 90000 },
  ];
  const rate = client._estimateStepsPerSec();
  assert.ok(Math.abs(1 / rate - 30) < 0.5, `expected ~30 s/it, got ${1 / rate}`);
}

// A poll that misses steps still measures correctly — intervals normalise by steps passed.
{
  const client = makeClient();
  const t0 = 1_000_000;
  client._stepHistory = [
    { value: 10, atMs: t0 },
    { value: 14, atMs: t0 + 8000 }, // 4 steps in 8s
    { value: 18, atMs: t0 + 16000 },
    { value: 22, atMs: t0 + 24000 },
  ];
  const rate = client._estimateStepsPerSec();
  assert.ok(Math.abs(1 / rate - 2) < 0.1, `expected ~2 s/it, got ${1 / rate}`);
}

{
  const client = makeClient();
  client._stepHistory = [{ value: 5, atMs: 1000 }];
  assert.strictEqual(client._estimateStepsPerSec(), null, 'single sample must be null');
  client._stepHistory = [{ value: 5, atMs: 1000 }, { value: 6, atMs: 3000 }];
  assert.strictEqual(client._estimateStepsPerSec(), null, 'one interval cannot outvote a stall');
  client._stepHistory = [{ value: 5, atMs: 1000 }, { value: 5, atMs: 9000 }, { value: 5, atMs: 11000 }];
  assert.strictEqual(client._estimateStepsPerSec(), null, 'zero step delta must be null');
}

// ---- active-list reconciliation ----
// The oldest running job owns the instrument; everything else active counts as queued.
{
  const client = makeClient();
  client._applyActive([
    { id: 'b', status: 'running', created_at: '2026-08-13T02:00:00Z', step: 5, job_config: jobConfig() },
    { id: 'a', status: 'running', created_at: '2026-08-13T01:00:00Z', step: 9, job_config: jobConfig() },
    { id: 'c', status: 'queued', created_at: '2026-08-13T03:00:00Z', step: 0, job_config: jobConfig() },
  ]);
  assert.strictEqual(client.currentJob.jobId, 'a', 'oldest running job is the one shown');
  assert.strictEqual(client.queueRemaining, 2, 'the other running job and the queued one both count as waiting');
}

// Switching to a different job resets the rate window — otherwise the first sample of the new job
// would be measured against the last sample of the old one.
{
  const client = makeClient();
  client._applyActive([{ id: 'a', status: 'running', created_at: '1', step: 900, job_config: jobConfig() }]);
  client._applyJob({ id: 'a', status: 'running', step: 900, job_config: jobConfig() }, true);
  assert.strictEqual(client._stepHistory.length, 1);
  client._applyActive([{ id: 'z', status: 'running', created_at: '2', step: 3, job_config: jobConfig() }]);
  assert.strictEqual(client.currentJob.jobId, 'z');
  assert.strictEqual(client._stepHistory.length, 0, 'the new job starts with an empty window');
  client._applyJob({ id: 'z', status: 'running', step: 3, job_config: jobConfig() }, true);
  assert.strictEqual(client._stepHistory[0].value, 3);
}

// THE BUG THE LIVE RUN EXPOSED AND THE STUB COULD NOT.
// Each poll applies the 5s-cached list row and then the fresh by-id row. They disagree by a step
// or two and land milliseconds apart. When BOTH fed the window it filled with "+2 steps in 5ms"
// pairs, and the median landed on them: 200 steps/sec, 0.005 s/it, 3-second ETA on a job half an
// hour from finishing. Only the fresh read may sample.
{
  const client = makeClient();
  const cfg = jobConfig({ train: { steps: 6000 } });
  // Six poll cycles at ~2.5 s/it, each delivering a stale list row then a fresh one.
  for (let i = 0; i < 6; i++) {
    const fresh = 5300 + i * 2;
    client._applyActive([{ id: 'h3', status: 'running', created_at: '1', step: fresh - 2, job_config: cfg }]);
    client._applyJob({ id: 'h3', status: 'running', step: fresh, job_config: cfg }, true);
    // Advance the clock the way the poll loop would.
    for (const p of client._stepHistory) p.atMs -= 0; // no-op; timestamps come from Date.now()
  }
  // The window must contain only fresh-read samples — never one per row.
  assert.ok(client._stepHistory.length <= 6, `expected <=6 samples, got ${client._stepHistory.length}`);
  assert.ok(
    client._stepHistory.every((p) => p.value % 2 === 0 && p.value >= 5300),
    'every sample must come from the fresh read, not the stale list row',
  );
}

// A stale list row must never drag the displayed step backwards.
{
  const client = makeClient();
  const cfg = jobConfig();
  client._applyActive([{ id: 'h3', status: 'running', created_at: '1', step: 5300, job_config: cfg }]);
  client._applyJob({ id: 'h3', status: 'running', step: 5310, job_config: cfg }, true);
  assert.strictEqual(client.currentJob.step, 5310);
  client._applyActive([{ id: 'h3', status: 'running', created_at: '1', step: 5302, job_config: cfg }]);
  assert.strictEqual(client.currentJob.step, 5310, 'a 5s-stale row must not rewind the counter');
}

// An empty active list with nothing tracked is simply an idle host, not an error.
{
  const client = makeClient();
  client._applyActive([]);
  assert.strictEqual(client.currentJob, null);
  assert.strictEqual(client.queueRemaining, 0);
}

// ---- phase (ai-toolkit's own `info` field) ----
// Real values observed on the live server during a restart: "Model Loaded", "Loading dataset".
// This is the only readout a run has before its first step lands.
{
  const client = makeClient();
  client.currentJob = { jobId: 'j1' };
  client._applyJob({ id: 'j1', status: 'running', step: 0, info: 'Loading dataset', job_config: jobConfig() }, true);
  assert.strictEqual(client.currentJob.phase, 'Loading dataset');

  client._applyJob({ id: 'j1', status: 'running', step: 0, info: '   ', job_config: jobConfig() }, true);
  assert.strictEqual(client.currentJob.phase, null, 'whitespace-only info is no phase at all');
}

// A finished run reports no phase — the last thing it was doing is not what it is doing.
{
  let snap = null;
  const client = new AIToolkitClient({ name: 't', url: 'http://x' }, (_n, s) => { snap = s; });
  client.status = 'online';
  client.currentJob = { jobId: 'j1', phase: 'Saving', finished: 'success', finishedAtMs: Date.now(), stateText: 'Trained' };
  client._emit();
  assert.strictEqual(snap.currentJob.phase, null);
}

// ---- elapsed honesty ----
// ai-toolkit stores no training start time, so a run already in progress when the widget starts
// has no honest elapsed figure. It must emit null, not time-since-we-noticed.
{
  let snap = null;
  const client = new AIToolkitClient({ name: 'test', url: 'http://x', kind: 'aitoolkit' }, (_n, s) => { snap = s; });
  client.status = 'online';
  client._applyActive([{ id: 'a', status: 'running', created_at: '1', step: 4204, job_config: jobConfig() }]);
  client._emit();
  assert.strictEqual(snap.currentJob.elapsedSec, null, 'a run first seen mid-flight has unknown elapsed');

  const fresh = makeClient();
  fresh.status = 'online';
  fresh._applyActive([{ id: 'b', status: 'running', created_at: '1', step: 0, job_config: jobConfig() }]);
  fresh._applyJob({ id: 'b', status: 'running', step: 0, job_config: jobConfig() }, true);
  assert.strictEqual(fresh.currentJob.firstSeenStep, 0, 'a run watched from step 0 can be timed');
}

// ---- finished states (async: _resolveFinished re-reads the row) ----
// Awaited in one IIFE rather than left as floating .then()s — an assertion inside an unawaited
// promise reports as an unhandled rejection, which is a much worse failure message.
async function finishedStates() {
  // "stopped" is a user action, not a failure: the card clears rather than turning red.
  {
    const client = makeClient();
    client.currentJob = { jobId: 'j1', step: 500 };
    client._get = async () => ({ id: 'j1', status: 'stopped', step: 500 });
    await client._resolveFinished('j1');
    assert.strictEqual(client.currentJob, null, 'a stopped run clears instead of showing a fault');
  }
  {
    const client = makeClient();
    client.currentJob = { jobId: 'j1', step: 3000 };
    client._get = async () => ({ id: 'j1', status: 'completed', step: 3000 });
    await client._resolveFinished('j1');
    assert.strictEqual(client.currentJob.finished, 'success');
    assert.strictEqual(client.currentJob.stateText, 'Trained');
  }
  {
    const client = makeClient();
    client.currentJob = { jobId: 'j1', step: 12 };
    client._get = async () => ({ id: 'j1', status: 'error', step: 12 });
    await client._resolveFinished('j1');
    assert.strictEqual(client.currentJob.finished, 'error');
    assert.strictEqual(client.currentJob.stateText, 'Failed');
  }
  // A run that vanishes from the API entirely (row deleted mid-poll) clears rather than sticking.
  {
    const client = makeClient();
    client.currentJob = { jobId: 'j1', step: 12 };
    client._get = async () => { throw new Error('HTTP 404'); };
    await client._resolveFinished('j1');
    assert.strictEqual(client.currentJob, null);
  }
}

// ---- snapshot contract ----
// The renderer only knows the shared shape; a training snapshot must fill the same fields plus
// its own extras, and must never invent the generation-only ones.
{
  let snap = null;
  const client = new AIToolkitClient({ name: 'trainer', url: 'http://x', kind: 'aitoolkit' }, (_n, s) => { snap = s; });
  client.status = 'online';
  client._applyActive([{ id: 'a', status: 'running', created_at: '1', step: 100, job_config: jobConfig() }]);
  client.currentJob.loss = 0.0412;
  client._emit();
  assert.strictEqual(snap.status, 'online');
  assert.strictEqual(snap.currentJob.model, 'Krea-2-Raw');
  assert.strictEqual(snap.currentJob.rank, 32);
  assert.strictEqual(snap.currentJob.size, '512/768/1024');
  assert.strictEqual(snap.currentJob.loss, 0.0412);
  assert.strictEqual(snap.currentJob.maxSteps, 3000);
  assert.strictEqual(snap.system, null, 'training hosts have no crystools panel');
  assert.strictEqual(snap.currentJob.phase, null, 'no info field means no phase, not an empty string');
  assert.ok(snap.currentJob.nodeName.startsWith('Training'), 'node strip names the run');
}

finishedStates().then(() => {
  console.log('aitoolkit-client tests passed');
});
