# Dev notes

Things worth knowing before changing this folder. The user-facing README is deliberately free of
all of it.

## Files

| File | What |
|------|------|
| `__init__.py` | The relay patches + the node class registrations. Nothing draws here. |
| `web/job-state.js` | `JobTracker`: message handling, rate estimation, snapshots. Pure, no DOM. |
| `web/devices.js` | Which GPU(s) a workflow uses, VRAM maths, accelerator detection. Pure. |
| `web/face.js` | Every layout and both styles. Pure canvas — takes a 2D context, nothing else. |
| `web/watcher-steps.js` | The only file that imports ComfyUI (`app`, `api`) and the only one with timers. |
| `web/package.json` | Marks these as ES modules so node's test runner loads them like the browser does. ComfyUI only serves them statically. |

Tests: `test/watcher-node.test.js` in the parent repo, run with `npm test`. The face tests use a
recording 2D context, so they assert the strings each face prints without a canvas.

## Rules that are load-bearing

- **The keys in `FACES` (face.js) must match `NODE_CLASS_MAPPINGS` (`__init__.py`).** A name in one
  and not the other registers a node that draws nothing, with no error anywhere. There is a
  cross-check script in the repo's handoff notes; run something like it after adding a layout.
- **LiteGraph draws widgets from the top of the node body, and it draws them BEFORE
  `onDrawForeground`.** The face is translated down by `widgetSpace(node)` and the node grows by
  the same amount. Remove that and the style combo disappears under the face.
- **Layout and style are separate axes.** A style may repaint a surface, change a shape or add an
  ornament (the dome's progress capsule, the rack's hairline). It must never hide a value or change
  what a number means. The tests assert every reading in both styles for exactly this reason.
- **Style is a widget, not a node type.** Switching a look must never cost someone the node they
  already wired and positioned.
- **One `JobTracker` per page, not per node.** The job is a property of the server; ten nodes are
  ten views of one thing.
- **`/system_stats` is polled only while a VRAM node is on the canvas**, and the interval stops
  when the last one is deleted.

## VRAM: whose number is it (2026-08-17)

The node showed 3.7 GB on a card nvitop and guiTOP both showed at 9.5 — a six-gigabyte disagreement,
and the widget was the only tool on the box that could not be corroborated. Two separate causes,
both fixed, and the order matters:

1. **`vram_free` from `/system_stats` is not the card's free memory.** ComfyUI's
   `model_management.get_free_memory` returns `mem_free_cuda + (reserved - active)` — the driver's
   free memory plus torch's own idle allocator cache — because cache is memory ComfyUI can reuse
   without asking the driver. Correct for its purpose, wrong to print. `torch_vram_free` is that
   cache term and ships in the same entry, so subtracting it back out recovers the driver's figure.
2. **Even then, cudaMemGetInfo and NVML disagree by about a gigabyte** on the same card at the same
   instant (10.52 GiB vs 9.49, New Main, measured three times a second apart). So the number is now
   taken from where nvitop takes it: `/watcher/vram`, an NVML read inside the ComfyUI process.
   `deviceVram` prefers it and keeps the arithmetic as the fallback for an AMD box, a missing
   `pynvml`, or a relay copy older than the route (404 → fall back, not an error).

**The index is not the join.** On this box torch's device 0 is the card nvidia-smi calls 2 — CUDA
orders by capability, NVML by PCI bus. Index-to-index would have printed the 3090's memory on the
5070 Ti's row and looked entirely plausible. The join is the UUID, and the answer is keyed by TORCH
index because that is what `/system_stats` entries carry and what a workflow's `cuda:1` widget means.

**NVML's UUID lookup is case-sensitive**, and torch spells the UUID lowercase. Upper-casing it
answers `NVMLError_NotFound`, which silently dropped every card to the nvidia-smi fallback — a
subprocess every couple of seconds for a number NVML had ready.

## The stage line — which part of the workflow is running (2026-08-17)

`STEP 7/20` is a position inside ONE node. A graph spends most of its wall clock in the nodes either
side of the sampler, and nothing on the face said which of them was running. Every job layout now
carries an 18px `NODE` line under it.

- **The position is counted, never told to us**: one entry per node id seen executing this run
  (`JobTracker.stage`). ComfyUI has no message for "node 4 of 21".
- **The denominator needs the relay**, exactly like the batch total does: `watcher.prompt_nodes`,
  broadcast from a wrapper around `PromptExecutor.execute_async`. `len(prompt)` is NOT the answer —
  it counts every node on the canvas including the watcher's own display nodes, so a run would end
  at "18 / 21" and look stuck. It is the count REACHABLE from the outputs being executed, minus the
  ones `execution_cached` says will be skipped. No relay → a bare position, never a guessed total.
- **The total floors at the position.** A subgraph or a list expansion can run nodes the prompt never
  listed, and "9 / 7" is a broken instrument.
- The node's NAME is printed on this line only when the hero readout is showing step numbers: with
  no steps, `stepReading()` already puts the title in the big well, and the same words twice on a
  300px node wastes the row.

## Two bugs that only a real server found

Both are the same lesson: a stub agrees with whatever you assumed when you wrote it.

1. **The batch restart.** One prompt runs the same sampler once per image, so `value` counts 1..8
   then restarts at 1. Measuring across that boundary gives a negative delta and reports no rate at
   all — the readout went dead for the first half of every image. The window is thrown away on a
   restart, and the last known rate is held across the gap.
2. **The device name.** ComfyUI's `get_torch_device_name` returns
   `"cuda:0 NVIDIA GeForce RTX 3090 : cudaMallocAsync"` — label in front, allocator behind. Splitting
   on the first colon (the obvious thing) prints the string `cuda` beside every card. Found by
   pointing it at a live instance, not by testing.

## Editing this while it is installed

The folder in `custom_nodes/` is a COPY. Editing the repo does nothing until you copy it over
again, and Python changes need a ComfyUI restart (JS changes only need a hard refresh, since
`web/` is served statically).

`renderer/mock-canvas-node.html` in the parent repo imports the shipped `face.js` directly and
drives it with a real `JobTracker` fed synthetic messages — every node, both styles, data that
moves. Serve it with `npx http-server . -c-1`; without `-c-1` you get a cached module and will
chase a bug you already fixed.
