// The ComfyUI canvas node pack: job tracking (comfyui-relay/web/job-state.js) and what each face
// prints (comfyui-relay/web/face.js). Both are pure — no ComfyUI, no DOM — which is the whole
// reason they are separate files from watcher-steps.js, whose imports only resolve inside the
// ComfyUI page.
//
// These are ES modules (comfyui-relay/web/package.json says so), so this CJS test loads them with
// dynamic import() through a file URL.
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

const webDir = path.join(__dirname, '..', 'comfyui-relay', 'web');
const load = (file) => import(pathToFileURL(path.join(webDir, file)).href);

/** A recording 2D context: enough surface for the faces, and it keeps every string drawn. */
function recorder() {
  const texts = [];
  const ctx = {
    texts,
    canvas: { width: 300, height: 150 },
    letterSpacing: '0px',
    save() {},
    restore() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    arcTo() {},
    fill() {},
    stroke() {},
    clip() {},
    fillRect() {},
    strokeRect() {},
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    quadraticCurveTo() {},
    measureText: (t) => ({ width: String(t).length * 7 }),
    fillText: (t) => texts.push(String(t)),
  };
  return ctx;
}

(async () => {
  const { JobTracker, estimateRate, fmtRate, fmtSec } = await load('job-state.js');
  const { FACES, faceCells, litColour, stepReading } = await load('face.js');

  // ── rate estimation ──────────────────────────────────────────────────────
  {
    const t0 = 1_000_000;
    const samples = [
      { value: 1, atMs: t0, node: '3' },
      { value: 2, atMs: t0 + 500, node: '3' },
      { value: 3, atMs: t0 + 1000, node: '3' },
    ];
    assert.strictEqual(estimateRate(samples), 2, 'two 500ms steps is 2 it/s');
    assert.strictEqual(estimateRate(samples.slice(0, 1)), null, 'one sample cannot be a rate');
  }

  // A pause (checkpoint write, model load) inside the window must not halve the rate: anything
  // over 3x the median is dropped as "not a step". This is the ai-toolkit lesson, and it applies
  // to a sampler too — a 40s VAE stall used to report half speed for the next 20 seconds.
  {
    const t0 = 2_000_000;
    const samples = [
      { value: 1, atMs: t0, node: '3' },
      { value: 2, atMs: t0 + 1000, node: '3' },
      { value: 3, atMs: t0 + 2000, node: '3' },
      { value: 4, atMs: t0 + 42000, node: '3' }, // a 40s stall
    ];
    assert.strictEqual(estimateRate(samples), 1, 'the stall is discarded, not averaged in');
  }

  // ── the tracker ──────────────────────────────────────────────────────────
  // THE BATCH BUG, pinned: one prompt runs the same sampler once per image, so `value` counts
  // 1..8 and then restarts at 1. Splicing the two together measures a negative delta and reports
  // no rate at all — which is what made the widget's dial only wake up two steps from the end.
  {
    const t0 = 3_000_000;
    const j = new JobTracker();
    j.onExecutionStart({ prompt_id: 'p1' }, t0);
    for (let i = 1; i <= 8; i++) j.onProgress({ value: i, max: 8, node: '9', prompt_id: 'p1' }, t0 + i * 1000);
    const before = j.snapshot(t0 + 8000);
    assert.strictEqual(before.step, 8);
    assert.ok(Math.abs(before.rate - 1) < 1e-9, 'a clean 1 it/s run reads 1 it/s');

    // next image: the bar restarts
    j.onProgress({ value: 1, max: 8, node: '9', prompt_id: 'p1' }, t0 + 12000);
    const after = j.snapshot(t0 + 12000);
    assert.strictEqual(after.step, 1, 'the restart is the next item, and the step count follows it');
    assert.ok(after.rate != null, 'A KNOWN RATE IS NEVER REPLACED BY null INSIDE ONE JOB');
  }

  // Our own job arrives twice — ComfyUI's targeted message plus the relay's broadcast copy. The
  // duplicate must not become a sample, or the estimator sees "+0 steps in 2ms".
  {
    const t0 = 4_000_000;
    const j = new JobTracker();
    j.onExecutionStart({ prompt_id: 'p1' }, t0);
    j.onProgress({ value: 1, max: 20, node: '3', prompt_id: 'p1' }, t0);
    j.onProgress({ value: 1, max: 20, node: '3', prompt_id: 'p1' }, t0 + 2); // relay copy
    j.onProgress({ value: 2, max: 20, node: '3', prompt_id: 'p1' }, t0 + 1000);
    j.onProgress({ value: 2, max: 20, node: '3', prompt_id: 'p1' }, t0 + 1002); // relay copy
    const s = j.snapshot(t0 + 1002);
    assert.ok(Math.abs(s.rate - 1) < 0.01, `duplicates are dropped, got ${s.rate}`);
  }

  // A node change is a different bar with a different max: the window is thrown away and the step
  // numbers go with it, rather than a tiled decode's 3/64 being read as the sampler's progress.
  {
    const t0 = 5_000_000;
    const j = new JobTracker();
    j.onExecutionStart({ prompt_id: 'p1' }, t0);
    j.onProgress({ value: 19, max: 20, node: '3', prompt_id: 'p1' }, t0 + 1000);
    j.onExecuting({ node: '8', prompt_id: 'p1' }, t0 + 1500);
    const s = j.snapshot(t0 + 1600);
    assert.strictEqual(s.steps, false, 'the new node has no step numbers yet');
    assert.strictEqual(faceCells(s)[0].value, 'N/A', 'so STEP reads N/A, not the old count');
  }

  // executing with node:null happens between two nodes mid-job and must not blank anything.
  {
    const t0 = 6_000_000;
    const j = new JobTracker();
    j.onExecutionStart({ prompt_id: 'p1' }, t0);
    j.onProgress({ value: 5, max: 20, node: '3', prompt_id: 'p1' }, t0 + 1000);
    j.onExecuting({ node: null, prompt_id: 'p1' }, t0 + 1100);
    const s = j.snapshot(t0 + 1200);
    assert.strictEqual(s.step, 5, 'node:null is not the end of the job');
    assert.strictEqual(s.running, true);
  }

  // A ONE-STEP BAR IS NOT A STEP COUNT. ComfyUI reports whole-node progress as 0/1 for everything
  // that is not a sampler, so a 44-second checkpoint load used to render as "STEP 0/1" — which
  // reads as a one-step job that is stuck. Seen on Bryan's own canvas, 2026-08-15.
  {
    const t0 = 15_000_000;
    const j = new JobTracker();
    j.onExecutionStart({ prompt_id: 'p1' }, t0);
    j.onProgress({ value: 0, max: 1, node: '4', prompt_id: 'p1' }, t0 + 1000);
    const s = j.snapshot(t0 + 44000);
    assert.strictEqual(s.steps, false, '0/1 is a node saying "busy", not a step count');
    assert.strictEqual(s.progress, null, 'and it drives no progress bar');
    assert.strictEqual(stepReading(s).value, 'N/A', 'with no node name, it reads N/A');

    // But the page knows what node 4 IS, so say that instead of N/A.
    const named = stepReading({ ...s, nodeName: 'Load Checkpoint' });
    assert.strictEqual(named.value, 'Load Checkpoint');
    assert.strictEqual(named.name, true, 'and it is flagged as prose, so it is not set in the numeral face');

    // A real sampler bar still reads as steps, and the name never overrides it.
    j.onProgress({ value: 3, max: 25, node: '9', prompt_id: 'p1' }, t0 + 45000);
    const running = j.snapshot(t0 + 45000);
    assert.strictEqual(running.steps, true);
    assert.strictEqual(stepReading({ ...running, nodeName: 'KSampler' }).value, '3/25');
  }

  // Elapsed is only claimed when the start was actually seen. Joining mid-job (the page was opened
  // while something was already running) has no start time — time-since-we-looked is a fabricated
  // number, so the face prints `--`.
  {
    const t0 = 7_000_000;
    const j = new JobTracker();
    j.onProgress({ value: 3, max: 20, node: '3', prompt_id: 'p9' }, t0);
    const s = j.snapshot(t0 + 5000);
    assert.strictEqual(s.elapsed, null, 'no start seen, no elapsed claimed');
    assert.strictEqual(fmtSec(s.elapsed), '--');
    assert.strictEqual(s.steps, true, 'but the step count is real and is shown');
  }

  // ETA needs BOTH a rate and a max. One step in, there is no interval yet and no ETA.
  {
    const t0 = 8_000_000;
    const j = new JobTracker();
    j.onExecutionStart({ prompt_id: 'p1' }, t0);
    j.onProgress({ value: 1, max: 21, node: '3', prompt_id: 'p1' }, t0 + 1000);
    assert.strictEqual(j.snapshot(t0 + 1000).eta, null, 'no rate yet, so no ETA');
    j.onProgress({ value: 2, max: 21, node: '3', prompt_id: 'p1' }, t0 + 2000);
    const s = j.snapshot(t0 + 2000);
    assert.ok(Math.abs(s.eta - 19) < 0.01, `19 steps left at 1 it/s is 19s, got ${s.eta}`);
    assert.strictEqual(fmtSec(s.eta), '19s');

    // Half a second later, with no new step, it must have drained half a second — a figure that
    // only moves when a step lands looks frozen on a 20 s/it video sampler.
    const half = j.snapshot(t0 + 2500);
    assert.ok(Math.abs(half.eta - 18.5) < 0.01, `ETA ticks down between steps, got ${half.eta}`);

    // ...but it stops at the end of the step in flight. A stall must not count down to zero and
    // promise a finish that is not coming.
    const stalled = j.snapshot(t0 + 40000);
    assert.ok(Math.abs(stalled.eta - 18) < 0.01, `a stall holds at the whole steps left, got ${stalled.eta}`);
  }

  // A finished job keeps its numbers on the canvas (the total time is worth reading) but stops
  // claiming an ETA, and the lit colour changes to the end state's.
  {
    const t0 = 9_000_000;
    const j = new JobTracker();
    j.onExecutionStart({ prompt_id: 'p1' }, t0);
    j.onProgress({ value: 20, max: 20, node: '3', prompt_id: 'p1' }, t0 + 20000);
    j.onExecutionEnd('success', { prompt_id: 'p1' }, t0 + 21000);
    const s = j.snapshot(t0 + 60000);
    assert.strictEqual(s.state, 'success');
    assert.strictEqual(s.running, false);
    assert.strictEqual(s.eta, null, 'a finished job has no ETA');
    assert.strictEqual(s.elapsed, 21, 'elapsed freezes at the real duration, it does not keep counting');
    assert.strictEqual(litColour('success'), '#7fd6a0');
    assert.strictEqual(litColour('error'), '#e06c5b');
  }

  // A FINISHED RUN KEEPS ITS RATE. The three numbers that describe what just happened — steps,
  // rate, elapsed — all stay on the node; only the ETA well changes, and it changes into the word
  // for how the run ended rather than sitting on a dash (Bryan, 2026-08-16).
  {
    const t0 = 9_500_000;
    const j = new JobTracker();
    j.onExecutionStart({ prompt_id: 'p1' }, t0);
    j.onProgress({ value: 1, max: 192, node: '3', prompt_id: 'p1' }, t0 + 1000);
    j.onProgress({ value: 192, max: 192, node: '3', prompt_id: 'p1' }, t0 + 2000);
    const live = j.snapshot(t0 + 2000);
    assert.ok(live.rate > 190 && live.rate < 192, `rate measured while running, got ${live.rate}`);

    j.onExecutionEnd('success', { prompt_id: 'p1' }, t0 + 3000);
    const done = j.snapshot(t0 + 90000);
    assert.strictEqual(done.rate, live.rate, 'the last measured rate survives the end of the run');
    const cells = faceCells(done);
    assert.strictEqual(cells[0].value, '192/192', 'the step count stays');
    assert.notStrictEqual(cells[1].value, 'N/A', 'the rate well is not blanked');
    assert.strictEqual(cells[2].value, '3s', 'elapsed stays at the real duration');
    assert.strictEqual(cells[3].label, 'STATE', 'the ETA well relabels itself once there is no ETA');
    assert.strictEqual(cells[3].value, 'FINISHED');
    assert.strictEqual(cells[3].lit, true, 'the end word carries the end state colour');

    // ...and the other two end states name themselves rather than all reading FINISHED.
    j.onExecutionEnd('error', { prompt_id: 'p1' }, t0 + 3000);
    assert.strictEqual(faceCells(j.snapshot(t0 + 4000))[3].value, 'FAILED');
    j.onExecutionEnd('interrupted', { prompt_id: 'p1' }, t0 + 3000);
    assert.strictEqual(faceCells(j.snapshot(t0 + 4000))[3].value, 'STOPPED');

    // A node that has never run has no end state to report, so that well is still the ETA well.
    const fresh = new JobTracker();
    const idle = faceCells(fresh.snapshot(t0));
    assert.strictEqual(idle[3].label, 'ETA');
    assert.strictEqual(idle[1].value, 'N/A', 'idle invents no rate — the hold is per run, not forever');

    // The next run starts from nothing: a held rate must never be inherited across prompts.
    j.onExecutionStart({ prompt_id: 'p2' }, t0 + 10000);
    assert.strictEqual(j.snapshot(t0 + 10000).rate, null, 'a new prompt clears the held rate');
  }

  // A new prompt clears the previous run rather than continuing its counts.
  {
    const t0 = 10_000_000;
    const j = new JobTracker();
    j.onExecutionStart({ prompt_id: 'p1' }, t0);
    j.onProgress({ value: 18, max: 20, node: '3', prompt_id: 'p1' }, t0 + 1000);
    j.onExecutionEnd('success', { prompt_id: 'p1' }, t0 + 2000);
    j.onExecutionStart({ prompt_id: 'p2' }, t0 + 3000);
    const s = j.snapshot(t0 + 3000);
    assert.strictEqual(s.steps, false, 'the new job has no step numbers yet');
    assert.strictEqual(s.rate, null, 'and no rate carried over from the last one');
    assert.strictEqual(s.elapsed, 0, 'elapsed restarts from the new job');
  }

  // progress_state (newer frontends) picks the node that is RUNNING, not a finished entry sitting
  // at value === max, which would hold the readout at "done" for the rest of the graph.
  {
    const t0 = 11_000_000;
    const j = new JobTracker();
    j.onExecutionStart({ prompt_id: 'p1' }, t0);
    j.onProgressState(
      {
        prompt_id: 'p1',
        nodes: {
          4: { value: 10, max: 10, state: 'finished' },
          9: { value: 3, max: 20, state: 'running' },
        },
      },
      t0 + 1000,
    );
    const s = j.snapshot(t0 + 1000);
    assert.strictEqual(s.step, 3, 'the running node is the one being watched');
    assert.strictEqual(s.max, 20);
  }

  // The trace's history records measurements only, and is per job.
  {
    const t0 = 12_000_000;
    const j = new JobTracker();
    j.onExecutionStart({ prompt_id: 'p1' }, t0);
    j.onProgress({ value: 1, max: 20, node: '3', prompt_id: 'p1' }, t0);
    assert.strictEqual(j.snapshot(t0).rateHistory.length, 0, 'nothing recorded before a rate exists');
    j.onProgress({ value: 2, max: 20, node: '3', prompt_id: 'p1' }, t0 + 1000);
    assert.strictEqual(j.snapshot(t0 + 1000).rateHistory.length, 1);
    j.onExecutionStart({ prompt_id: 'p2' }, t0 + 5000);
    assert.strictEqual(j.snapshot(t0 + 5000).rateHistory.length, 0, 'a new job starts a new trace');
  }

  // ── formatting ───────────────────────────────────────────────────────────
  {
    assert.deepStrictEqual(fmtRate(2.5), { value: '2.50', unit: 'it/s' });
    assert.deepStrictEqual(fmtRate(0.5), { value: '2.00', unit: 's/it' }, 'below 1 flips to s/it');
    assert.strictEqual(fmtRate(null), null);
    assert.strictEqual(fmtSec(95), '1m35s');
    assert.strictEqual(fmtSec(3700), '1h01m');
    assert.strictEqual(fmtSec(null), '--');
  }

  // ── every face, in both states ───────────────────────────────────────────
  const idle = new JobTracker().snapshot(13_000_000);
  const runningTracker = new JobTracker();
  runningTracker.onExecutionStart({ prompt_id: 'p1' }, 14_000_000);
  runningTracker.onProgress({ value: 6, max: 20, node: '3', prompt_id: 'p1' }, 14_001_000);
  runningTracker.onProgress({ value: 7, max: 20, node: '3', prompt_id: 'p1' }, 14_002_000);
  const running = runningTracker.snapshot(14_002_000);

  // ── which GPU(s) a workflow uses ─────────────────────────────────────────
  {
    const { selectedDeviceLabels, pickDevices, allDevices, deviceVram, shortDeviceName } = await load('devices.js');

    const stats = {
      devices: [
        { name: 'NVIDIA GeForce RTX 3090 : cudaMallocAsync', type: 'cuda', index: 0, vram_total: 24e9, vram_free: 6e9 },
        { name: 'NVIDIA GeForce RTX 3060', type: 'cuda', index: 1, vram_total: 12e9, vram_free: 11e9 },
        { name: 'cpu', type: 'cpu', index: null, vram_total: 64e9, vram_free: 32e9 },
      ],
    };

    // Nothing in the graph names a device: ComfyUI runs on its own primary device, which
    // /system_stats deliberately puts first. ONE row, not three.
    const none = pickDevices(stats, selectedDeviceLabels([{ mode: 0, values: [{ name: 'seed', value: 42 }] }]));
    assert.strictEqual(none.devices.length, 1, 'no selection shows one card, not every card');
    assert.strictEqual(none.devices[0].index, 0);
    assert.strictEqual(none.source, 'primary');

    // A MultiGPU node pins the second card: that one, and only that one.
    const labels = selectedDeviceLabels([
      { mode: 0, values: [{ name: 'device', value: 'cuda:1' }] },
      { mode: 0, values: [{ name: 'unet_name', value: 'flux2-klein.safetensors' }] },
    ]);
    assert.deepStrictEqual(labels, ['cuda:1']);
    const picked = pickDevices(stats, labels);
    assert.strictEqual(picked.source, 'workflow');
    assert.deepStrictEqual(picked.devices.map((d) => d.index), [1]);

    // Two loaders, two cards — both shown, in the server's order.
    const two = pickDevices(
      stats,
      selectedDeviceLabels([
        { mode: 0, values: [{ name: 'device', value: 'cuda:1' }] },
        { mode: 0, values: [{ name: 'device', value: 'cuda:0' }] },
      ]),
    );
    assert.deepStrictEqual(two.devices.map((d) => d.index), [0, 1]);

    // A bypassed or muted loader will not run, so its card must not light up.
    assert.deepStrictEqual(
      selectedDeviceLabels([
        { mode: 4, values: [{ name: 'device', value: 'cuda:1' }] },
        { mode: 2, values: [{ name: 'device', value: 'cuda:1' }] },
      ]),
      [],
      'bypassed and muted nodes select nothing',
    );

    // A workflow that pins something to the CPU gets no meaningless "cpu VRAM" row; it falls back
    // to the device ComfyUI actually runs on.
    const cpuOnly = pickDevices(stats, ['cpu']);
    assert.strictEqual(cpuOnly.source, 'primary');
    assert.deepStrictEqual(cpuOnly.devices.map((d) => d.type), ['cuda']);

    // Used is the CARD's used memory, not torch's: total - free.
    const vram = deviceVram(stats.devices[0]);
    assert.strictEqual(vram.used, 18e9);
    assert.ok(Math.abs(vram.fraction - 0.75) < 1e-9);
    assert.strictEqual(deviceVram({ vram_total: 0, vram_free: 0 }), null, 'no total, no reading');
    // THE REAL STRING, copied from the live :8189 instance's /system_stats. ComfyUI puts the device
    // label in front and the allocator on the back, so a naive split on ':' yields "cuda" — which is
    // exactly what it printed beside every card until this was checked against a running server.
    assert.strictEqual(
      shortDeviceName('cuda:0 NVIDIA GeForce RTX 3090 : cudaMallocAsync'),
      'RTX 3090',
    );
    assert.strictEqual(shortDeviceName('NVIDIA GeForce RTX 3090 : cudaMallocAsync'), 'RTX 3090');
    assert.strictEqual(shortDeviceName('cuda:1 AMD Radeon RX 7900 XTX'), 'Radeon RX 7900 XTX');

    // The face: one row per selected card, and an empty selection says N/A rather than drawing an
    // empty bar that looks like a card with no memory in use.
    const vramFace = FACES.WatcherVram;
    const withCards = recorder();
    vramFace.draw(withCards, vramFace.w, vramFace.heightFor({ gpu: picked }), { gpu: picked });
    const shown = withCards.texts.join(' | ');
    assert.ok(shown.includes('CUDA:1'), `names the card it is showing — ${shown}`);
    assert.ok(!shown.includes('CUDA:0'), 'and shows no card the workflow does not use');
    assert.ok(shown.includes('SELECTED IN WORKFLOW'), 'and says why that card is the one shown');

    const noCards = recorder();
    const empty = { devices: [], source: 'none' };
    vramFace.draw(noCards, vramFace.w, vramFace.heightFor({ gpu: empty }), { gpu: empty });
    assert.ok(noCards.texts.includes('N/A'), 'no device data reads N/A');

    // ── CORE ComfyUI's own multi-GPU nodes (comfy_extras/nodes_multigpu.py) ──
    // These are NOT the custom pack, and they do not speak its language. Select Model/CLIP/VAE
    // Device offer "default" / "cpu" / "gpu:0" / "gpu:1" from model_management, where the index is
    // into get_all_torch_devices() — so gpu:1 is the device with index 1.
    {
      const { splitDeviceCount } = await load('devices.js');

      const coreLabels = selectedDeviceLabels([
        { type: 'SelectModelDevice', mode: 0, values: [{ name: 'device', value: 'gpu:1' }] },
      ]);
      assert.deepStrictEqual(coreLabels, ['gpu:1']);
      const corePick = pickDevices(stats, coreLabels);
      assert.strictEqual(corePick.source, 'workflow');
      assert.deepStrictEqual(corePick.devices.map((d) => d.index), [1], 'gpu:1 is the index-1 card');

      // "default" means "wherever ComfyUI would have put it", which is not a selection at all.
      const dflt = pickDevices(stats, selectedDeviceLabels([
        { type: 'SelectVAEDevice', mode: 0, values: [{ name: 'device', value: 'default' }] },
      ]));
      assert.strictEqual(dflt.source, 'primary', '"default" selects nothing');

      // MultiGPU CFG Split names NO device — it takes a count, and uses the primary plus the next
      // (max_gpus - 1) cards. Without this the node would show one card while two were working.
      const splitNodes = [
        { type: 'MultiGPU_WorkUnits', mode: 0, values: [{ name: 'max_gpus', value: 2 }] },
      ];
      assert.strictEqual(splitDeviceCount(splitNodes), 2);
      const split = pickDevices(stats, selectedDeviceLabels(splitNodes), splitDeviceCount(splitNodes));
      assert.strictEqual(split.source, 'workflow');
      assert.deepStrictEqual(split.devices.map((d) => d.index), [0, 1], 'primary + one more');

      // max_gpus 1 is not a split, and a bypassed split node splits nothing.
      assert.strictEqual(splitDeviceCount([{ type: 'MultiGPU_WorkUnits', mode: 0, values: [{ name: 'max_gpus', value: 1 }] }]), 1);
      assert.strictEqual(
        pickDevices(stats, [], splitDeviceCount([{ type: 'MultiGPU_WorkUnits', mode: 0, values: [{ name: 'max_gpus', value: 1 }] }])).source,
        'primary',
      );
      assert.strictEqual(splitDeviceCount([{ type: 'MultiGPU_WorkUnits', mode: 4, values: [{ name: 'max_gpus', value: 4 }] }]), 0);

      // A split PLUS an explicit pick is a union, still in the server's order.
      const both = pickDevices(stats, ['cuda:1'], 2);
      assert.deepStrictEqual(both.devices.map((d) => d.index), [0, 1]);
    }

    // The All-GPUs node ignores the selection entirely and lists every card — but still no CPU row,
    // since a row that can only ever read "n/a" is furniture.
    const everything = allDevices(stats);
    assert.strictEqual(everything.source, 'all');
    assert.deepStrictEqual(everything.devices.map((d) => d.index), [0, 1]);
    assert.ok(!everything.devices.some((d) => d.type === 'cpu'), 'the CPU is not a VRAM row');
    assert.strictEqual(allDevices({ devices: [{ type: 'cpu', index: null }] }).source, 'none');

    const allFace = FACES.WatcherVramAll;
    assert.strictEqual(allFace.allDevices, true, 'and it is flagged so the poller feeds it the full list');
    assert.strictEqual(FACES.WatcherVram.allDevices, false, 'while the scoped node is not');
    const allShot = recorder();
    allFace.draw(allShot, allFace.w, allFace.heightFor({ gpu: everything }), { gpu: everything });
    const allText = allShot.texts.join(' | ');
    assert.ok(allText.includes('CUDA:0') && allText.includes('CUDA:1'), `lists every card — ${allText}`);
    assert.ok(allText.includes('ALL DEVICES'), 'and says that is what it is doing');

    // Height follows the number of cards — two rows must not be painted outside the node.
    assert.ok(
      vramFace.heightFor({ gpu: two }) > vramFace.heightFor({ gpu: picked }),
      'two cards make a taller node than one',
    );
  }

  // ── the GPU stack ────────────────────────────────────────────────────────
  // THE BUILD TAG IS THE ONLY RELIABLE TELL: a ROCm build reports devices of type "cuda" with
  // cuda:N labels, so /system_stats looks identical to an NVIDIA box apart from pytorch_version.
  {
    const { acceleratorFromStats } = await load('devices.js');
    assert.strictEqual(acceleratorFromStats({ system: { pytorch_version: '2.13.0+rocm6.2' } }), 'ROCm');
    assert.strictEqual(acceleratorFromStats({ system: { pytorch_version: '2.13.0+cu130' } }), 'CUDA');
    assert.strictEqual(acceleratorFromStats({ system: { pytorch_version: '2.9.0+xpu' } }), 'XPU');
    // An untagged (source/conda) build falls back to the card's own name.
    assert.strictEqual(
      acceleratorFromStats({ system: { pytorch_version: '2.13.0' }, devices: [{ name: 'AMD Radeon RX 7900 XTX' }] }),
      'ROCm',
    );
    assert.strictEqual(acceleratorFromStats({}), null, 'unknown stays unknown, it is not guessed');
  }

  for (const [nodeId, face] of Object.entries(FACES)) {
    if (face.allDevices !== undefined) continue; // the VRAM nodes show no job facts; asserted above
    // BOTH STYLES draw every value. A style may repaint a surface or add an ornament; it may never
    // drop a reading, so each assertion below runs twice.
    for (const style of ['rack', 'glass']) {
      const idleStyled = { ...idle, style, gpu: { devices: [], source: 'none' } };
      const runStyled = { ...running, style, gpu: { devices: [], source: 'none' } };

      // Idle: NOTHING is invented. No zero step count, no 0.00 rate, no 0s ETA — the honesty rule
      // the whole widget is built on, restated per face because each prints its own strings.
      const a = recorder();
      face.draw(a, face.w, face.heightFor(idleStyled), idleStyled);
      assert.ok(a.texts.includes('N/A'), `${nodeId}/${style}: idle prints N/A`);
      assert.ok(a.texts.includes('--'), `${nodeId}/${style}: idle prints -- for its clocks`);
      assert.ok(!a.texts.some((t) => /^0(\.00)?$/.test(t)), `${nodeId}/${style}: invents no zero`);
      assert.ok(!a.texts.some((t) => t === '0/0'), `${nodeId}/${style}: invents no step count`);

      const b = recorder();
      face.draw(b, face.w, face.heightFor(runStyled), runStyled);
      const styled = b.texts.join(' | ');
      assert.ok(styled.includes('1.00'), `${nodeId}/${style}: shows the measured rate`);
      assert.ok(styled.includes('13s'), `${nodeId}/${style}: shows the ETA`);
    }

    // Running: the four facts are all on the face somewhere.
    const b = recorder();
    face.draw(b, face.w, face.heightFor(running), running);
    const joined = b.texts.join(' | ');
    assert.ok(/\b7\s*\/\s*20\b/.test(joined) || joined.includes('13'), `${nodeId}: shows the step position`);
    assert.ok(joined.includes('1.00'), `${nodeId}: shows the measured rate — ${joined}`);
    assert.ok(joined.includes('it/s') || joined.includes('IT/S'), `${nodeId}: names the rate's unit`);
    assert.ok(joined.includes('13s'), `${nodeId}: shows the ETA — ${joined}`);
    assert.ok(joined.includes('2s'), `${nodeId}: shows elapsed — ${joined}`);
  }

  console.log('watcher-node: all assertions passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
