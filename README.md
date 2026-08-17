# comfyuiWATCHER

A small desktop widget that watches every ComfyUI box (and ai-toolkit LoRA trainer) on your
network and shows what each one is doing right now: which job, step X/Y, speed, elapsed time,
and — the number you actually care about — how much longer.

I built it because checking on a long video render meant alt-tabbing into a browser tab, finding
the node that was running, and doing the ETA math in my head. Now it's a window in the corner of
a second monitor: one card per machine, live needles, and I only look up when something finishes.

## What it shows

Each host gets a rack-module card:

- **Steps left** on a seven-segment readout, and the node that's running ("KSampler", or whatever
  you titled it).
- **A moving-coil rate dial** — log scale, both s/it and it/s, with real needle ballistics. Image,
  video and training jobs each get a face scaled to what those jobs actually run at, picked
  automatically from the running graph (15 s/it is healthy for a video sampler and terrible for
  SDXL — one scale can't judge both).
- **ETA that ticks down** between steps and holds honestly during a stall, plus elapsed and queue
  depth.
- **Batch position** ("Image 3 / 28") on dataset-style workflows that run one sampler over a list
  of prompts, with a whole-batch ETA measured from what the previous items actually cost.
- **Job identity** — model name, resolution, frame count or batch size — read from the workflow's
  metadata only. It never reads your prompts.
- **Training cards** for [ai-toolkit](https://github.com/ostris/ai-toolkit): step, s/it, ETA,
  loss, base model, rank, and what the run is doing while it hasn't stepped yet ("Loading
  dataset").
- Five looks (brushed rack, two glass ones, two control-room panels), three sizes, drag to
  reorder, hide hosts without deleting them.

One rule everywhere: **it never makes a number up.** No step data reads N/A, an unknown elapsed
reads `--`, and there is no ETA until a rate has actually been measured. A dead readout is honest;
a fabricated one isn't.

## Install

Grab the latest release from the [releases page](https://github.com/an80sPWNstar/ComfyUIWatcher/releases):
Windows installer, Linux AppImage or deb.

Point it at your hosts via the gear button — a host is just a URL (`http://machine:8188` for
ComfyUI started with `--listen`, `http://machine:8675` for ai-toolkit's UI). No SSH, no agents on
the machines being watched.

## The one manual step: the relay node

ComfyUI only sends progress messages to the client that submitted the job. A passive watcher never
sees step counts for jobs you queue from the web UI — that's ComfyUI's design, not a bug here.

The fix ships with the app: a small custom node that re-broadcasts those messages under a name
ComfyUI's own UI ignores. The app's first-run panel shows where the folder landed and opens it for
you; copy it into each ComfyUI's `custom_nodes/` and restart. The panel then reports per host
whether the relay is actually being heard, so "did it work?" is observed, not assumed.

Without the relay a card still shows the host, queue, running job and model — just no step X/Y,
rate or ETA for jobs submitted elsewhere.

The same folder also adds **Watcher canvas nodes** to ComfyUI itself — step, rate, elapsed, ETA
and VRAM drawn on a display-only node you park in the corner of your graph. Those are also
published separately as [comfyui-watcher-nodes](https://github.com/an80sPWNstar/comfyui-watcher-nodes)
if you only want the in-browser half.

## Building from source

```
npm install
npm start        # run
npm test         # no-framework unit tests
npx electron-builder --win   # or --linux
```

Plain Electron: main process owns one collector per host (WebSocket + a 1s REST poll for ComfyUI,
REST only for ai-toolkit), pushes snapshots over IPC, and the renderer is framework-free
HTML/CSS/JS with a CSP that allows nothing off disk. The only runtime dependency is `ws`.

## Privacy

Everything stays on your LAN. The app talks only to the hosts you configure, sends nothing
anywhere else, and reads workflow metadata only — model filenames and latent dimensions, never
prompt text or images.

## License

MIT.
