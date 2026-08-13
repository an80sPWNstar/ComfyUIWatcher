# comfyuiWATCHER

## What This Is
A Windows desktop widget that watches a rack of machines doing long-running GPU work and shows
live per-host job state: what it is working on, step X/Y, speed, elapsed time, and ETA. Two kinds
of host are supported, in one window:
- **`comfyui`** — a ComfyUI instance (local or remote; one launched with `--listen 0.0.0.0` is
  just a network address, no SSH needed).
- **`aitoolkit`** — an [ai-toolkit](https://github.com/ostris/ai-toolkit) LoRA trainer, watched
  through its own UI server's REST API.

The name is now narrower than the app. Kept deliberately as of 2026-08-13 — renaming means a new
repo name, app id and release line, and Bryan chose to keep the existing one.

Scaffolded 2026-08-11, modeled directly on [[guiTOP]]'s architecture (which itself evolved from
[[tempsLCD-web]]'s Electron widget pattern): Electron main owns one long-lived collector per host,
pushes structured payloads over IPC, a plain-JS renderer (no framework, no bundler) draws widgets
from those payloads. guiTOP polls `nvidia-smi`; this project's equivalent data source is ComfyUI's
own WebSocket protocol at `/ws`.

## Tech Stack
- **Runtime:** Electron 31 (matches guiTOP's version pin)
- **Language:** JavaScript. Renderer is plain HTML/CSS/JS — **no bundler, no `require()` in the
  renderer.** Widget files attach to `window.Widgets`, loaded via plain `<script>` tags in
  `index.html`, in dependency order. This bit guiTOP too: `contextIsolation: true` +
  `nodeIntegration: false` means the renderer has no CommonJS `module`/`require` at all.
- **Main process:** `main.js` — BrowserWindow, owns the `WatcherService`, IPC.
- **IPC bridge:** `preload.js` — `contextBridge` exposes `window.comfyuiWatcher.{onData, getHosts,
  setHosts}`.
- **Data source (revised 2026-08-11 after source + live verification):** BOTH transports per host.
  WS (`ws://host:port/ws?clientId=...`) carries only the broadcast messages (`status`,
  `crystools.monitor`) for a passive watcher — ComfyUI targets ALL execution messages at the
  submitting client only (see "WebSocket Message Handling" below). A 1s REST poll of `/queue` +
  `/history/<prompt_id>` provides foreign-job presence, success/error, and exact durations.
- **Dependencies:** `ws` (runtime). Electron 31's main process embeds **Node 20.18, which has NO
  global `WebSocket`** (that landed in Node 22) — the original "no ws package needed" plan was
  wrong and cost a silent every-card-offline failure on first launch. `comfyui-client.js` prefers
  `globalThis.WebSocket` when a future Electron provides it, falls back to `require('ws')`.

## Project Structure
```
comfyuiWATCHER/
├── package.json
├── main.js                          # Electron main — window, service, IPC
├── preload.js                       # contextBridge: window.comfyuiWatcher.*
├── src/
│   ├── collectors/
│   │   ├── index.js                 # Collector registry: host.kind -> collector class
│   │   ├── comfyui-client.js        # One WS connection per host, reconnect w/ backoff,
│   │   │                            # derives stepsPerSec/etaSec from a rolling progress window
│   │   ├── aitoolkit-client.js      # REST-only poller for an ai-toolkit UI server (no WS)
│   │   └── service.js               # Owns one collector per configured host
│   └── config/
│       └── hosts.js                 # Host list, persisted to userData/hosts.json
├── comfyui-relay/
│   └── __init__.py                  # OPTIONAL ComfyUI custom node: rebroadcasts targeted
│                                    # execution msgs as watcher.* so passive watchers get steps
├── assets/fonts/                    # Vendored from tempsLCD-web: ShareTechMono + Orbitron
│                                    # (CSP is self-only — nothing may load off the network)
├── renderer/
│   ├── index.html                   # CSP-locked shell (topbar + gear button)
│   ├── renderer.js                  # Subscribes via onData, creates/updates one card per host
│   └── widgets/
│       ├── lcd.js                   # Seven-segment readout + arc gauge, ported from
│       │                            # tempsLCD-web's design_system (React -> plain DOM/SVG)
│       ├── job-card.js              # Per-host card: steps-left hero readout, node, LED bar
│       └── settings-panel.js        # Host add/remove UI over hosts:get/hosts:set IPC
├── styles/main.css                  # Dark theme, CSS custom properties for future skinning
└── test/
    ├── run.js                       # No-framework runner, spawns each *.test.js in its own process
    └── comfyui-client.test.js       # Pure logic: step-rate estimation, executing/finished edge cases
```

## Architecture

### Collectors and the snapshot contract (added 2026-08-13)
`src/collectors/index.js` maps `host.kind` to a collector class. Every collector honours the same
contract and **nothing above it knows which kind a host is**:

```
new Collector(host, onUpdate); .start(); .stop()
onUpdate(hostName, {host, status, lastError, queueRemaining, system, currentJob})
currentJob: null | {step, maxSteps, stepsPerSec, etaSec, elapsedSec, finished, node, nodeName,
                    model, size, ...kind extras}
```

The kind-specific extras are the ONLY difference the card sees: `frames`/`batch` for generation,
`rank`/`loss` for training. `stepsPerSec` is always **it/s**, even for a trainer that is only ever
read in s/it — the card's meter and `fmtRate()` both do the reciprocal, and having two units in
the contract would mean every consumer needs to ask which one it got.

Adding another trainer (Kohya, Musubi, OneTrainer) = one new file + one line in `index.js`. Note
that the two already on this machine are harder targets than ai-toolkit: Musubi's SECourses GUI
is Gradio with no job API, so it would need log tailing.

### AI-Toolkit collector (`aitoolkit-client.js`)
Pure REST, no WebSocket — ai-toolkit keeps every job's live step count in its own SQLite row and
its Next.js UI (default port **8675**) serves it. Endpoints: `/api/jobs?only_active=true&
job_type=train` to discover (**server-cached 5s**, too stale to measure a rate from),
`/api/jobs?id=<id>` uncached for the tracked job, `/api/jobs/<id>/loss?since_step=N` for the loss
tail. Auth only when that UI was started with `AI_TOOLKIT_AUTH` set — then the host entry needs a
`token` and every request sends `Authorization: Bearer`.

Four things that were only discoverable from Bryan's live DB (`D:\ai-toolkit\aitk_db.db`):
1. **`total_steps` lies.** A running job read `step 4204 / total_steps 2500` while its own
   `job_config` said 5000. Steps come from `job_config.config.process[0].train.steps`; the column
   is the fallback only.
2. **Most rows are caption jobs** (11 of 17), 18–187 steps each. Always filter `job_type=train`.
3. **The rate window is 180s, not 15s.** His slowest recorded run is 30.07 s/it, so ComfyUI's 15s
   window would usually hold zero step changes and report "no rate" on a healthy run. Only a
   *changed* step is a sample — polling at 1s would otherwise fill the window with duplicates.
   **And the estimate is a MEDIAN of per-step intervals, not (last - first) / elapsed.** Measured
   live 2026-08-13 on a restarting H3 run: it sat on step 5250 for 131s loading its model, then
   stepped every ~2s, and first-to-last reported **45.07 s/it with a 9h21m ETA on a job 25 minutes
   from done**. This is not an edge case — ai-toolkit pauses to write a checkpoint every
   `save_every` steps (250 on his runs) and to render samples, so a long gap lands in the window
   routinely. Three samples minimum, because one interval cannot outvote a stall.
   **Then AVERAGE the surviving intervals — do not report the median itself.** A 1s poll quantises
   every interval to whole seconds, so a true 2.7 s/it run yields 2s and 3s intervals and a median
   snaps to 3.02 (measured live against a trainer reporting 2.55–2.85). The rule is: cut anything
   over 3x the median as a pause, then `steps / seconds` over what is left.
4. **ONLY the uncached `?id=` read may feed the rate window.** `_applyJob` runs twice per poll —
   the 5s-cached list row, then the fresh one. They disagree by a step or two and land
   milliseconds apart, so sampling both filled the window with "+2 steps in 5ms" pairs and the
   estimate landed on them: **200 steps/sec, 0.005 s/it, a 3-second ETA on a job half an hour from
   done** (found 2026-08-13 only because Bryan said the card looked wrong). The cached row also
   must never drag `job.step` backwards. **A stub cannot catch this class of bug** — it serves
   both endpoints from one number, so the skew does not exist. The stub verification was real but
   it was not sufficient, and the same caveat applies to any future collector: measure it against
   the actual server before believing a rate.
4. **Elapsed is often unknowable.** ai-toolkit stores no training start time (`created_at` is when
   the job was *made*, and a queued job can sit for hours), so a run already in progress when the
   widget launches emits `elapsedSec: null` → the card prints `--`. Time-since-we-noticed would be
   a fabricated number. Only a run watched from step 0 gets a real elapsed.

`stopped` is mapped to neither success nor error — the user pressed stop, and painting the module
red for that is a lie. The card just clears.

### Data Flow
1. `main.js` loads the host list (`src/config/hosts.js`, defaults to New Main `:8188` and
   Secondary `:8189` — see [[comfyui-hardware-config]]) and starts one `ComfyUIClient` per host via
   `WatcherService`.
2. Each client opens `ws://<host>/ws?clientId=<random>` and reconnects with backoff
   (1s→2s→5s→10s, capped) on any close/error — one broken host must never affect the others, same
   principle as guiTOP's per-host GPU backend fallback.
3. A client also pushes a snapshot on a fixed 500ms timer, independent of message arrival, so
   elapsed/ETA visibly tick even between WS messages.
4. `WatcherService` forwards `{hostName: snapshot}` to `main.js`'s callback, which
   `webContents.send('watcher-data', ...)`s it to the renderer.
5. `renderer.js` creates one `.job-card` per host name it's ever seen and calls
   `Widgets.updateCard()` on every payload; a card disappears if its host stops appearing in the
   snapshot map (host removed from config).

### WebSocket Message Handling (`comfyui-client.js`)
**THE CENTRAL PROTOCOL FACT (verified 2026-08-11, both in source and empirically):** ComfyUI
0.31.1 sends every execution message — `progress`, `executing`, `execution_start`,
`execution_success`/`execution_error`, `execution_cached`, `executed`, `progress_state` — **only
to the client that submitted the prompt**: `send_json` broadcasts when `sid is None`
(server.py:1382-1390) but every execution send passes `server.client_id` (execution.py:496/684,
main.py:450 `hijack_progress`, comfy_execution/progress.py:183). Source: `D:\ComfyUI_Installs\New
Main\ComfyUI`. Empirical: three separate 120s taps during running jobs received ZERO execution
messages. **A passive watcher can never see step counts for jobs queued by the web UI or any
other client.** No feature flag changes this in 0.31.1 (only `supports_preview_metadata` exists).
Do NOT "fix" this by connecting with the submitter's clientId — server.py:273-281 REPLACES the
socket registered under that sid, silently cutting off the real client's updates.

A passive watcher receives only the broadcast messages (verified live):
- `status`: `{"type":"status","data":{"status":{"exec_info":{"queue_remaining":N}},"sid":"..."}}`
- `crystools.monitor`: every ~1s **only if ComfyUI-Crystools is installed** — per-GPU
  utilization/VRAM, host RAM. Absence = "no system panel," not an error.

The targeted messages (shapes verified via source; the derivation path unit-tested and exercised
live via an own-clientId submission) still matter for jobs submitted under OUR clientId:
- `progress`: `{"type":"progress","data":{"value":N,"max":M,"prompt_id":"...","node":"..."}}`
- `executing`: `{"type":"executing","data":{"node":"<id>"|null,"prompt_id":"..."}}`
- `execution_start` / `execution_success` / `execution_error`: `{prompt_id, timestamp}`

### REST Poller (same file — how foreign jobs are watched)
Every 1s while online: `GET /queue` → running entry is `[number, prompt_id, prompt, extra_data,
outputs_to_execute]`; a prompt_id we aren't already tracking starts a fresh `currentJob` (elapsed
ticks from first-seen). When the shown job leaves the queue, `GET /history/<prompt_id>` resolves
`success`/`error` plus the exact duration from ComfyUI's own `execution_start`→`execution_success`
message timestamps (server clock, used only as a delta — `finalElapsedSec`). History is
**in-memory** — it wipes on server restart, so a missing entry just clears the card. The card
shows an animated indeterminate bar when running with no step data; step X/Y + ETA appear only
when real progress messages arrive. Never fabricate a rate.

**True step progress for all jobs — `comfyui-relay/` (built 2026-08-11, Bryan asked for it):**
a custom node that wraps `PromptServer.send_sync` and re-emits each targeted execution message
as a broadcast copy under a `watcher.`-prefixed type (so ComfyUI's own frontends ignore it).
`comfyui-client.js` strips the prefix and treats them as the originals. **Installed 2026-08-11
(with Bryan's explicit approval — the auto-mode classifier blocks `D:\ComfyUI_Installs\` writes
by default) into BOTH installs' `custom_nodes/comfyui-watcher-relay/`, and VERIFIED live on New
Main**: relay log line at 09:50:49, `watcher.progress` observed by an independent tap, and the
card showed Step 9/20 → 10/20 with rate + ETA for a foreign video job. Secondary's copy loads
whenever that instance next starts (was down at verification time). Editing
`comfyui-relay/__init__.py` later requires re-copying to both installs.

### Card Visuals (rebuilt again 2026-08-12 PM — "1U" rack direction, Bryan picked it)
Each host is a **module bolted into a rack**: graphite faceplate (`--face #272B30`, brushed 1px
grain), four corner screws, engraved nameplate, jewel lamp, two recessed instrument wells, LED
bargraph. Typography is **Rajdhani** uppercase+tracked as the silkscreen legend face and Share
Tech Mono for values; **Orbitron is gone** (it was the generic sci-fi default and made every card
read as a spaceship HUD). The old arc gauge is gone too.
- **The signature is the moving-coil rate meter** (`createRateMeter(face)` in `widgets/lcd.js`):
  ivory face, log scale across 96°. **Log, not linear** — this widget watches both a 5 it/s SDXL
  image and a 0.07 it/s H3 video sampler, and a linear face pins the needle for whichever it
  wasn't scaled for. **No red zone**: on real gear that means overload, and a slow sampler is not
  a fault. There are two faces, chosen by card kind:
  - `sampling` — 0.01→100 it/s, split at 1:1 (below).
  - `training` — **60…1 s/it, one unit, no split** (added 2026-08-13). Scaled from Bryan's six
    recorded ai-toolkit runs: 2.17, 3.66, 4.41, 5.09, 6.08 and 30.07 s/it. **Nothing he has ever
    trained ran faster than 1 it/s**, so on the sampling face all six pile up within a few degrees
    of centre while half the arc covers speeds no trainer reaches. Picked from a live side-by-side
    mockup (`renderer/mock-train-dial.html`, "face B") against two rejected alternatives: the
    unchanged sampling face, and a loss face (needle on loss, .001–1, with a trace) — the loss
    face's trace carried more than its needle did, and it made training cards taller than
    generation ones.
  - **Both faces are graduated in it/s underneath, whatever they print.** That is what keeps
    needle direction meaning one thing in a mixed rack: further right is always faster. The
    training face's labels descend 60→1 for exactly this reason. Drawing it the intuitive way
    (1 left, 60 right) was tried and rejected — needle-right would then mean "fast" on a
    generation module and "slow" on the training module beside it.
  - A single-unit face keeps its unit word in the same **bottom-left** slot the two-unit face
    uses. Moving it to centre to clear the needle pivot put it straight through the top
    graduations instead (tried, unreadable).
- **The face is split at the 1:1 mark: left half graduated in s/it, right half in it/s** (settled
  2026-08-12 with Bryan after three rejected versions, see below). One log scale, whose left half
  is labelled with the reciprocal — which is legitimate, s/it IS 1/(it/s) — so every label on the
  face is a whole number: `100 10 1 10 100`, symmetric about a longer centre tick.
- **The unit word for the half the needle is in lights up in pointer red**; the other stays faint.
  The cutover is 1.0, the same one `fmtRate()` uses for the RATE legend, so the face and the
  printed figure can never disagree about which unit is being read. If you change one cutover,
  change both.
- Rejected on the way here, do not retry: (1) both unit words printed beside a single row of it/s
  numbers — a unit pointing at a scale that was never drawn; (2) a second full s/it row in rust
  ink underneath the first — correct but two rows of numbers is more than anyone reads at a
  glance on a 196px instrument; (3) single it/s scale labelled `0.01 0.1 1 10 100` — Bryan's
  objection was the mix of fractions and whole numbers, and it is a fair one, since his video
  work lives entirely below 1 it/s; (4) SI prefixes (`10m`, `100m`) — reads as minutes, not milli.
- Unit words sit off bottom-centre because the needle pivots at bottom centre and draws straight
  through anything printed there (centred, `it/s` rendered as "t/s"). They are set at 14px — the
  first pass at 9.5px was unreadable at real widget size; these two words are the face's key, not
  a footnote, so do not shrink them back to legend size.
- **A well's legend lights in `--lit` only while its instrument is reading something real**
  (`.jc-well--live`, set in `updateCard`): STEPS LEFT lights when there are real step numbers,
  SAMPLING RATE when there is a rate. Dim legend + N/A + resting needle is the honest "nothing to
  report" state, and it is the normal one for a foreign job on a host without the relay node.
- **STEPS LEFT is printed directly above its own numerals, left-aligned with them.** Parked to
  the right of the digits it read as a caption for the meter in the next well over.
- **Job identity plate** fills the well right of the numerals: MODEL on its own line, then SIZE
  and a count beside it — **every value gets its own silkscreen label**. The count slot is one
  row that relabels itself: **FRAMES** for a video latent, **BATCH SIZE** for an image one (no
  job has both, so two rows would leave a dead label on every card). A batch of 1 IS printed,
  unlike a frame count of 1 — "how many images" is a real answer, "1 frame" is a video-ism. The first version
  packed the frame count into the size value as a "121f" suffix, which was the one field on the
  card explaining itself with a unit letter instead of a label; don't reintroduce that. Values
  come from `describeModel()` / `describeLatent()` in
  `comfyui-client.js`, read off the running graph the `/queue` poll already returns — **metadata
  only, never prompt text** (standing rule). `describeModel` matches on the *input key*
  (`unet_name` > `ckpt_name` > ...), not the class name, because the ecosystem invents loader
  nodes faster than anyone can enumerate them, and it ignores wired inputs (`["12", 0]`) so a
  connection is never mistaken for a filename. Unknown graph → `null` → **the row hides**, rather
  than a guessed model or a permanent `--`. `describeLatent` only trusts width/height on a node
  whose class_type contains "latent" (an ImageScale node has both and is not the job's output
  size), and returns `frames: null` for `length <= 1`, so image jobs get no FRAMES row at all.
  Unit-tested against synthetic graphs; **not yet verified against a live ComfyUI job** (both
  hosts were down) — first real job on New Main is the check.
- **Needle ballistics are real**, not a CSS transition: one shared rAF loop integrates
  `vel += (err*0.085 - vel*0.42)*dt` for every needle on screen (per-card loops would mean one
  timer per host). It parks itself when everything settles, and `destroyCard()` must be called
  when a card is removed or its needle animates forever — `renderer.js` does this.
- **The face is backlit, and only lights when there is a signal.** No rate → dark face, needle at
  the stop, NO SIGNAL legend. This is what keeps a rack of idle hosts quiet: exactly one ivory
  face glows, the module that is actually sampling. Same honesty rule as everywhere else — a
  resting needle must never look like a measurement.
- **Idle/offline hosts collapse to a blanking panel** (`.job-card--blank`): nameplate, lamp, one
  state word, no instruments, no bar. A watcher normally stares at a rack where most hosts idle;
  a dark meter and an N/A readout would be three rows of furniture reporting nothing.
- `--lit` is one CSS variable per card holding its live colour (amber running / jade success /
  red fault / slate idle); jewel, numerals, node strip and bargraph all read from it. Add new lit
  elements the same way rather than hardcoding a colour.
- **Responsive on `container-type: inline-size`, not viewport width** — at 700px the grid runs two
  columns, so a card can be narrow inside a wide window. Below 430px of *card* width the two wells
  stack.
- `#cards` uses **`repeat(auto-fill, ...)`, never `auto-fit`** (fixed 2026-08-13). `auto-fit`
  collapses empty tracks, so a rack showing a single card — every other host idle, or the kind
  filter on — stretched that one card to 863px at the default 900x640 window and left its
  instruments floating in empty faceplate. That was the "too much dead space to the right", not
  the dial size.
- The meter well is **`flex: 0 0 clamp(210px, 38%, 340px)`**, not a fixed 196px, and the stacked
  layout no longer caps the dial at 232px. The dial is the instrument the card exists for; it
  scales with the card. Measured after: 371x171 at a 426px card, up from 176x81.
- `#cards` needs **`grid-auto-rows: max-content`**. Cards set `overflow: hidden`, which zeroes
  their automatic minimum size, so `auto` rows in a definite-height scroll container squash every
  card to an equal share instead of overflowing into the scrollbar (measured: 9 cards at 620x1000
  → 83px each, everything below the node row clipped). Do not remove that line.

### Card Visuals (previous, 2026-08-12 AM — superseded by the rack rebuild above)
The crystools hardware strip at the bottom of each card is **gone** — Bryan found it distracting,
and monitoring GPUs is guiTOP's job, not this widget's. `snapshot.system` is still collected (the
`crystools.monitor` handler is untouched) but nothing renders it; leave it that way unless asked.

Its replacement is the hero readout, and it is the point of the card: an **arc gauge** (fill =
job progress) wrapped around a **seven-segment count of steps REMAINING in the current node**
(`maxSteps - step`), labeled STEPS LEFT.
- **No real step data -> the numerals are replaced by the literal text "N/A"**, never a
  fabricated 0 — same honesty rule as `etaSec`. This is the normal case for a foreign job on a
  host without the relay node, so it must read as "unknown", not "zero left".
- The field is 3 digits wide and **grows** past that (a 3-digit field would render 1000 as "000",
  since the string is right-aligned into fixed slots); 4+ digits shrink the glyphs via `.lcd--wide`.
- Running with no step numbers: the gauge runs a chasing arc and the bar sweeps
  (`.job-card--stepless`), instead of showing a dead-empty bar.
- `--lit` is one CSS variable per card holding its live colour; card state classes
  (`--running`, `--finished-success`, `--finished-error`, `[data-status=offline]`) set it once and
  the gauge, LCD, bar, LED and node chip all recolor from it. Add new lit elements the same way
  rather than hardcoding a colour.
- Everything visual comes from **tempsLCD-web's design system**, ported not copied:
  `renderer/widgets/lcd.js` holds the seven-segment geometry (`SEG_POINTS`/`DIGIT_SEGS` verbatim
  from `design_system/components/core/SevenSegment.jsx`) and the arc math from `SensorGauge.jsx`;
  the stat rows are `SensorRow`'s label-left/value-right shape; the bar is `SensorBar` in
  segmented mode; glow/scanline/transition tokens come from `design_system/tokens/effects.css`.
  Two changes were deliberate: the gauge's value arc reuses the track path with `pathLength="1"`
  so progress animates as `stroke-dasharray` (no per-frame path rebuild), and colors are
  `currentColor`/CSS vars instead of props.
- Two rendering traps, both hit and fixed: a `stroke-linecap: round` arc at 0% still paints a lit
  **dot** (hence `.gauge--empty { visibility: hidden }`), and three stat values across a 330px
  card ellipsised every real number — hence rows, and `fmtSec` emitting `3m35s` with no space.

### Step-Rate and ETA Estimation
`_progressHistory` keeps a 15-second rolling window of `{value, atMs}` samples; `stepsPerSec` is
the slope between the oldest and newest sample in that window, not an all-time average — a job's
early steps are not representative once caching/skip-style techniques are in play (see the
EasyCache quality findings in [[project-minimax-h3-attention-setup]]; irrelevant to this project's
own correctness, but it's why "recent rate, not lifetime average" was the deliberate choice here
too). `etaSec = (max - value) / stepsPerSec`, `null` whenever there's fewer than 2 samples or no
positive time/step delta — **never** a fabricated `0%`-style number from a single sample, same
principle guiTOP's `host-stats.js` follows for CPU percent.

### `executing` with `node: null`
Only clears `currentJob` if it was already marked `finished` (by a prior `execution_success` /
`execution_error`). A `node: null` between two nodes mid-job is normal and must not blank the UI —
this was wrong in an early version of this project's own test, not the collector; fixed 2026-08-11,
see `test/comfyui-client.test.js`.

## Skins (added 2026-08-12)
Same mechanism as [[project-guitop]]: a `skin-*` class on `<body>`, persisted to
`localStorage['comfyuiwatcher-skin']`, switched from a `<select id="skin-select">` in the top bar.
`renderer.js` owns the three lines that do it; `styles/main.css` holds STRUCTURE plus the default
**1U Rack** look, and `styles/skins.css` holds alternates as token/surface overrides.
- **`rack`** (default) — bolted graphite faceplate, ivory printed dial, amber lamps.
- **`glass`** — the look that shipped as 0.0.2: near-black blue field, translucent gradient cards,
  cyan glow, no bolts, no engraving. The instruments stay (the meter is what this app *is* now)
  but render as a **backlit** dial: dark glass face, cyan graduations, glowing pointer. Note it
  must re-invert `--meter-ink`, since the rack's dark-ink-on-ivory becomes light-on-dark here.
- **A skin may repaint a surface, change a shape, or hide an ornament. It must never hide a
  value, change what a number means, or break an honesty rule** (N/A for unknown steps, resting
  needle for no rate, hidden rows for unknown job identity). Skins here are pure CSS over one
  DOM, so switching never rebuilds a card or interrupts a running job's readout. If a future skin
  needs different markup it needs its own widget module, the way guiTOP carries `GpuCardBars` and
  `GpuCardCorvette` — do not fake it with `content:` or `display` tricks on values.
- Gotcha already hit: a skin overriding `.jc-node` re-armed the border that `.job-card--blank`
  deliberately strips, putting a lit bracket beside the word IDLE. When overriding a shared
  element, check it in the blank state too.

### Card kinds (added 2026-08-13)
`createCard(hostName, kind)` builds the card for its kind; `KINDS` in `job-card.js` holds the
whole difference — meter face, well legend ("Sampling Rate" vs "Training Rate"), the three
identity labels, and whether a LOSS legend exists. A card carries `data-kind`, and `renderer.js`
**rebuilds** a card whose host changed kind rather than relabelling it.
- Training identity plate: **BASE MODEL / RESOLUTION / RANK**, from `job_config` (metadata only —
  never dataset contents or captions). Rank is fixed for a run, so unlike frames/batch that slot
  never relabels itself. Resolution prints the whole bucket list (`512/768/1024`), because
  multi-resolution training is the norm and picking one would misreport the job.
- **Loss is a legend value, not an instrument.** It moves every step, but its absolute value is
  not comparable between models — it is something to read, not to gauge. `--` until the run writes
  its first sample; `0.0000` would be a lie.
- `job.stateText` lets a collector name its own end state ("Trained"), since a finished training
  run is not "Finished" in the sense a 20-step sampler job is.
- **`job.phase` → `.jc-phase`, top right of the faceplate** (added 2026-08-13 at Bryan's request).
  ai-toolkit narrates itself in its `info` column — observed live: `Model Loaded`, `Loading
  dataset`, `Training`. A run spends MINUTES loading a model and caching a dataset before its
  first step, and without this the card reads "running, no numbers" throughout, which is
  indistinguishable from a stall. Shown verbatim, lit in `--lit`, hidden when absent — never
  invented from `status`, and dropped entirely once the run finishes (the last thing it was doing
  is not what it is doing). ComfyUI has no equivalent field, so those cards simply never show one.

### Kind filter
Top bar `Show` → All / Generation / Training, persisted to
`localStorage['comfyuiwatcher-kind-filter']`, applied as a class on `#cards` that hides cards by
`data-kind`. **Filter, not tabs** — a watcher's question is "what is this machine doing", and both
kinds answer it the same way; tabs would hide half the rack behind a click. Hiding is `display:
none`, never a rebuild, so a filtered-out host keeps collecting and is instantly correct when it
comes back.

## Host Config
`src/config/hosts.js` persists `{name, url, kind, token?}[]` to `userData/hosts.json`, defaulting
to New Main `:8188` + Secondary `:8189` (both `comfyui`, see [[comfyui-hardware-config]]) and
AI-Toolkit `:8675` (`aitoolkit`). `validate()` drops anything that isn't a well-formed `http(s)`
URL rather than crashing on a malformed hosts file; an **unrecognised or missing `kind` falls back
to `comfyui`** rather than dropping the host, so a hosts.json written by an earlier version keeps
working and a typo never makes a server silently vanish from the rack. `token` is only read by
aitoolkit hosts and has no UI — it lives in hosts.json, because `AI_TOOLKIT_AUTH` is rarely set.

## Commands
| Command | What |
|---------|------|
| `npm install` | **Beware on this machine:** electron's postinstall "succeeds" (exit 0) but something (AV?) strips everything except `locales/` from `node_modules/electron/dist` when extract-zip writes to E:. Workaround that worked 2026-08-11: `Expand-Archive` the cached zip from `%LOCALAPPDATA%\electron\Cache` to a C: temp dir, copy into `dist`, write `path.txt` containing `electron.exe`. Verify with `Test-Path node_modules/electron/dist/electron.exe`. |
| `npm start` | Run |
| `npm run dev` | Run with DevTools |
| `npm test` | Run `test/*.test.js` (no framework, no deps) |
| `npx electron-builder --dir` | Portable build → `dist/win-unpacked/comfyuiWATCHER.exe` (worked 2026-08-11) |

## Ship checklist — what "build the installers and commit/push" means here
Bryan's standing instruction (2026-08-12): that phrase is one job, not three, and it ends at a
**published GitHub release**. Do all of it without being asked for each step:
1. `npm test`, and launch the app to look at the change — this project is judged by eye.
2. Bump `package.json` version.
3. **Windows**: `npx electron-builder --win` → `dist/comfyuiWATCHER Setup <v>.exe` + `win-unpacked/`.
4. **Linux**: build in WSL, do not hand this back as a "needs WSL" caveat. `rsync` the source into
   `~/cw-build` (its `node_modules` is already there), then `npx electron-builder --linux` →
   AppImage + deb. From Git Bash, `MSYS_NO_PATHCONV=1 wsl.exe -- bash -l <script>` or `/mnt/...`
   paths get mangled and node is off PATH. Copy both artifacts back into `dist/`.
5. **Verify by running the packaged build**, not by exit code: launch the exe and confirm the new
   work is actually inside it (check the asar for new files; electron-builder happily ships a
   stale `files` glob).
6. Commit + push to `main`, then `gh release create v<version>` with **all three installers**
   attached (exe, AppImage, deb) and real notes — what changed and what got fixed, written for
   someone who has not read the diff.
7. Update `HANDOFF.md`.

`dist/` is gitignored — the release is the only place the artifacts are published from.

## Screenshotting the running app (playwright-core `_electron`)
Three traps on this machine, all cost time on 2026-08-12 — copy the working recipe:
1. **Script parse off E: is slow.** `document.readyState` can still be `"loading"` ~2.5s after
   `firstWindow()` resolves, with only the first `<script>` executed — so `window.Widgets.createCard`
   is legitimately missing. Poll `evaluate(() => !!window.Widgets?.createCard)` until true instead
   of sleeping a fixed interval. `waitForFunction` timed out even when a plain `evaluate` poll
   worked; don't rely on it here.
2. **`page.screenshot({fullPage:true})` hangs** — the log reaches "fonts loaded" and then times
   out. Use Electron's own `webContents.capturePage()` through `app.evaluate`, returning
   `img.toPNG().toString('base64')` (there is no `require` inside `app.evaluate`, so write the
   file on the Node side).
3. Resize with `BrowserWindow.setSize()` in the main process, not `setViewportSize`.

## Status (2026-08-11, end of second session)
**Working v0.1, verified live.** Launched via playwright-core `_electron` driver against the real
New Main instance: card goes online, a foreign running job appears within 1s (poller), elapsed
ticks, queue count updates live, host add/remove UI works end-to-end (add → third card appears,
remove → gone), packaged exe launches and renders. Tests: 14 assertions incl. poller
reconciliation (`_applyQueue`/`_applyHistory`) and finished-hold. Two real bugs found only by
launching: the Node-20/no-WebSocket failure (see Tech Stack) and the targeted-messages protocol
fact (see WebSocket Message Handling).

## Status (2026-08-12, visual rebuild)
Card visuals rebuilt on tempsLCD-web primitives (see Card Visuals above); hardware strip removed.
Verified by launching the real app against New Main plus six mock cards covering
running-with-steps / running-without-steps / finished / failed / idle / offline / 4-digit steps —
all states render, the settings panel still works, 19 test assertions pass. Version still 0.0.2;
**no installer rebuilt for this change yet**.

## Status (2026-08-13, trainer support)
AI-Toolkit hosts work end to end. Verified by launching the real app against an API stub serving
the **real rows out of `aitk_db.db`** (both ComfyUI instances and the ai-toolkit UI were down):
card comes online, shows `Training · w1f3y_h3_v1`, MiniMax-H3 / 512-768-1024 / rank 16, 3790 steps
left, 2.21 s/it measured from step deltas against a recorded 2.17, ETA 2h19m, loss 0.0339, needle
just right of the `2` mark on the training face. Elapsed correctly reads `--` for a run first seen
mid-flight. 24 assertions in `test/aitoolkit-client.test.js`.

**Then verified against the live ai-toolkit UI server** once Bryan started it (`w1f3y_h3_v1`,
MiniMax-H3, rank 16, 6000 steps). That run found three bugs the stub could not:
1. Rate window poisoned by the 131s model-load stall → median of intervals.
2. Rate quantised by the 1s poll → trimmed average instead of the median value.
3. **Both the cached and the fresh row feeding the window → 0.005 s/it.** Bryan spotted this from
   the card, not from any test.
After the fixes the collector tracks the trainer's own figure (2.48–2.68 s/it against ai-toolkit's
reported 2.55–2.85) with a consistent ETA. Still unseen live: queued, finished and `stopped`
transitions. Version still 0.0.3, no installer rebuilt.

**Not built yet / next:**
1. Window state persistence, tray/minimize (guiTOP playbook).
2. `hosts.json` lives in `userData` (`%APPDATA%/comfyuiwatcher`); no UI for reordering hosts.
3. Installer/AppImage rebuild + release once Bryan signs off on the new look.
4. Watch the training card against the real ai-toolkit UI server on the next run he starts.
5. Other trainers (Musubi/EZ-Musubi are on this machine) — needs a log-tailing collector, since
   Gradio GUIs have no job API.

<!-- BEGIN LOCAL-LLM-DELEGATION v1 -- canonical block, identical in every project. Source of truth: ~/.claude/CLAUDE.md. Re-sync by replacing between these two markers. -->
## Local LLM Delegation

A project `CLAUDE.md` overrides the global one, so the operative rules are restated here rather
than left to be inherited. Full detail, measurements and history live in `~/.claude/CLAUDE.md`.

**Cost order, cheapest first: local Qwen boxes `.70` + `.100` (BOTH FREE) > Haiku > Opus.**
Latency does not matter — a slow free path beats a fast paid one. Delegate by default; keep on
Opus only final go/no-go gates, orchestration decisions, and ambiguous design calls. **Report
every delegation:** which box, what was sent, rough tokens in/out. State explicitly when a task
used no local LLM at all.

- `.100` = `http://192.168.50.100:8080` (1 slot, ~42 tok/s, **primary**). `.70` =
  `http://192.168.50.70:8080` (1 slot as of 2026-08-11 — 35B MoE swap dropped it from 2 slots,
  ~45 tok/s). 2 slots total; batch 3+ tasks in twos.
  Call with curl or node `fetch` — these are not pluggable into the Agent tool.
- **Always send `"chat_template_kwargs": {"enable_thinking": false}`** or the reply comes back
  empty (Qwen spends the whole `max_tokens` budget on `reasoning_content`).
- **The SessionStart probe reports four states: UP / LOADING / BUSY / DOWN.** Hold its result for
  the session; do not re-probe before each call. But:
  - **LOADING is not down.** llama.cpp binds its port immediately and answers **HTTP 503 until the
    model is resident** — minutes, for a 27B Q8_0. A box shown LOADING or DOWN gets **one**
    re-probe before the first real delegation. Never write off a box for a whole session on the
    strength of one probe line.
  - **`0/N slots idle` = BUSY**, not down: the call queues, and it is still free.
  - **Bryan asking why a box is unused IS a re-probe trigger.** Re-probe, then answer — do not
    explain the held result back to him.
- **DRY splits by literal density, not code-vs-prose.** Anything that must reproduce identifiers
  verbatim (codegen, diff and code review, error/log analysis): **no** `dry_multiplier`, **no**
  `repeat_penalty`, `temperature: 0`. Free-form prose with no repeated literals: `"dry_multiplier":
  0.8`. DRY corrupts repeated tokens — renamed identifiers, dropped tokens, mangled file paths.
- **CODEGEN = skeleton only.** Send the target file with real imports, signatures and comments and
  `// TODO:` bodies: *"fill only the TODO bodies, change nothing else, return the complete file."*
  Free-form "write this module" fails (restarts mid-file, duplicate imports). Prepend a
  ~100-token house-rules block for repo style — the model cannot know local lint/naming rules.
- **REVIEWS:** `max_tokens` 8192+, inputs <=3k (one sliced file or a plan — never a whole diff;
  value drops sharply as input grows). Force a line format, and **include one worked example line
  with REAL content**: a format made of bare field names gets echoed literally, e.g.
  `1. 138 -- problem -- fix -- confidence(high)`. **Never name a finding count**, not even
  "up to N, stop when out, never pad" — the number is the anchor and the model pads to it. Cap on
  my side, after the response.
- **Local review is a candidate generator, never a verdict** (~40% precision, sometimes 0 of 12).
  Verify every finding against the source before acting. **The same prompt on both boxes is not a
  second opinion** — same model and quant produce near-identical lists; vary the *lens* instead
  (correctness / boundary conditions / "what did the author verify on only one machine").
- **Vision** is reliable for transcription (read a table, a count, a value) and unreliable for
  judgement (it called by-design text truncation an overlap). Take and read screenshots myself
  regardless; never accept a model's description of an image as the finding.
- **Failure protocol:** if a result looks wrong, fix **my** prompt or params and retry first —
  every "the model can't do it" so far has turned out to be my setup. If it still fails, STOP and
  report exactly what was tried. Quietly doing the work myself instead is not an acceptable
  outcome. Same for transport errors: diagnose, retry once, then report.
<!-- END LOCAL-LLM-DELEGATION v1 -->
