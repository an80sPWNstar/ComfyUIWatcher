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
