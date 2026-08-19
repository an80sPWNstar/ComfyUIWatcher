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
│       ├── reactor-panel.js         # SECOND card widget: control-panel layout, two idioms
│       │                            # (annunciators, twin dials, bulb banks, split-flap/nixie)
│       └── settings-panel.js        # Host add/remove UI over hosts:get/hosts:set IPC
├── styles/main.css                  # Dark theme, CSS custom properties for future skinning
├── styles/reactor.css               # Reactor panel only — touches nothing the rack card uses
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

### Video is detected, not configured (added 2026-08-14)
`detectMedia(graph)` in `comfyui-client.js` decides whether the running job is making video or
stills, and the card prints the matching face. This is a *scale* decision, nothing else: a video
sampler and an image sampler are two orders of magnitude apart, so one face cannot read both, and
the split face was calling a perfectly healthy MiniMax-H3 run SLOW.

**Three signals, structural first, filename last** — the answer is `'video' | 'image' | null`, and
`null` (no graph yet) is never turned into a guess:
1. a node class that only exists in a video pipeline (`VIDEO_CLASS_RE` — video, img2vid, vid2vid,
   animatediff, svd, framepack, wan*);
2. any node asking for more than one frame, under any of the five names the packs use for it
   (`FRAME_KEYS`: length, num_frames, video_frames, frame_count, batch_size_frames);
3. a model filename from a known video family (`VIDEO_MODEL_RE`), only if 1 and 2 found nothing.

Verified against Bryan's real H3 graph pulled from `/history`: matched on
`MiniMaxH3ReferenceToVideo` at signal 1. **That graph also proves why the frame count cannot be the
detector**: its `width`/`height`/`length` are all wired links (`["115",0]`), not numbers, so
`describeLatent` reports nothing and the SIZE/FRAMES rows stay hidden — the honest answer, since the
real values only exist once the graph runs.

`describeLatent` now takes a second pass over `VIDEO_CLASS_RE` nodes when no latent node has the
numbers, because Wan/HunyuanVideo image-to-video builds the latent inside the conditioning node.
**The two regexes are deliberately the same constant**: when they drifted, an SVD graph was detected
as video with no size or frames to show for it (caught by a test, not by eye).

**The face follows the JOB, and unknown media KEEPS THE CURRENT FACE** (`faceFor` in `job-card.js`,
mirrored in `updateReactorPanel`). The gap between two video jobs is not evidence that the next one
is stills, and a face that flips on every gap is worse than one that is a job behind. Switching is a
**reprint** (`meter.setFace` → `refreshFace`), never a rebuild — the needle swings to its new
position with its own ballistics instead of dropping to the stop mid-job, same rule as skins and
dial ranges.

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

**Shipping the relay (0.0.5, 2026-08-13).** `comfyui-relay/` is an **extraResource**, NOT part of
the asar — the user has to copy the folder into `custom_nodes/`, and you cannot drag a file out of
an archive. It lands at `resources/comfyui-relay/`; `relayDir()` in `main.js` returns that when
packaged and the repo folder in dev. Before this, an installer user had no copy of the relay at
all and no way to know they needed one, which meant the exe silently shipped without half its
ComfyUI functionality.
- **First-run setup panel** (`renderer/widgets/setup-panel.js`) explains the one manual step, prints
  the on-disk path, and opens it in Explorer via `shell.openPath`. Shown automatically until
  dismissed (`localStorage['comfyuiwatcher-setup-seen']`), then lives behind the (i) button.
- **Relay detection is observed, not assumed.** `comfyui-client.js` sets `relaySeen` when any
  `watcher.*` message arrives — only the relay emits those — and the snapshot carries
  `relay: true | false | null`. **false is only claimed after a job has been running for 10s with
  no relay traffic**; an idle host stays `null`, because "your relay is missing" is not something
  to say on a guess. The panel prints the verdict per host, so "did my copy work?" is answered by
  observation.

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
  a fault. There are **three faces, and the card is not the one that decides between the first two**
  — see "Video is detected, not configured" below:
  - `sampling` — split at 1:1 (below), **end stops selectable in the hosts panel → Dials: 5 / 20 /
    60 / 100, default 60** (selectable since 2026-08-13, replacing a fixed ±100 — "100 is too far in
    both directions"; everything Bryan generates sat within a few degrees of centre). The wide face
    is kept for a genuinely fast run rather than deleted.
  - **A sampling range is keyed by its SLOW end and carries its own fast end** — `SAMPLING_FAST_END`
    in `widgets/lcd.js`, absent = symmetric. **The 60 face is 60 s/it … 5 it/s, not ±60**, and it is
    the default as of 2026-08-14. Symmetry was an assumption, never a requirement, and it is what put
    a 15.7 s/it MiniMax-H3 run four degrees off the slow stop on the 20 face while half the arc
    covered speeds no video sampler reaches ("14 s/it is actually pretty fast for minimax h3"). On
    the 60 face that same reading sits about a quarter up the arc, a 42 s/it 720p job is still ON the
    face instead of pegged, and an SDXL run at 4 it/s still reads. Verified live against New Main at
    15.75 s/it. The settings dropdown prints each face's own two ends (`dialRangeLabel`) rather than
    one number twice.
  - `video` — **60…1 s/it, one unit, no split** (added 2026-08-14), ranges 30 / 60 / 120, default 60.
    Same construction as the training face and for the same reason: nothing on this rack generates
    video above 1 it/s. **The split face's SLOW/FAST words were the actual complaint** — "15.75 s/it
    is not slow for video!!!!" — and no absolute scale is entitled to that judgement, because
    whether 15 s/it is good depends entirely on the model. A single-unit face has no such words, and
    it puts that reading at 43% of the arc instead of 4%.
  - `training` — **60…1 s/it, one unit, no split** (added 2026-08-13). Scaled from Bryan's six
    recorded ai-toolkit runs: 2.17, 3.66, 4.41, 5.09, 6.08 and 30.07 s/it. **Nothing he has ever
    trained ran faster than 1 it/s**, so on the sampling face all six pile up within a few degrees
    of centre while half the arc covers speeds no trainer reaches. Picked from a live side-by-side
    mockup (`renderer/mock-train-dial.html`, "face B") against two rejected alternatives: the
    unchanged sampling face, and a loss face (needle on loss, .001–1, with a trace) — the loss
    face's trace carried more than its needle did, and it made training cards taller than
    generation ones.
  - **Ranges are hand-written tables, not generated** (`SAMPLING_MARKS` / `TRAINING_MARKS` in
    `widgets/lcd.js`, keyed by end stop; training offers 10 / 30 / 60 s/it, default 60). Which marks
    carry a label is the difference between a readable dial and a wall of numbers, and every label
    has to stay a whole number — see the four rejected schemes below.
  - `renderer/mock-sample-dial.html` is the judging surface for a sampling scale: candidate faces
    side by side, each carrying four real workloads at their real speeds, in either widget family.
    It works because **both widgets read their face through `window.Widgets.faceSpec`** — the rack
    meter was calling this file's local `faceSpec` directly, so a mock could patch the panel and not
    the card. One seam, so a candidate scale is a table in the mock, not a second meter
    implementation (which is what `mock-train-dial.html` had to do).
  - **A range change REPRINTS the face in place** (`meter.refreshFace()` → `Widgets.refreshCardFace`
    → a `comfyuiwatcher:dial-range` event that `renderer.js` listens for). The graduations live in
    their own `<g class="meter-grads">` inserted before the needle so paint order survives a
    redraw. Rebuilding the card instead would drop the needle to its stop and re-run its ballistics
    mid-job — same reason skins and the kind filter are pure CSS over one DOM. `setRate` remembers
    its last value so the needle re-points at the same reading on the new scale.
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
- **The face is backlit, and the lamp follows the JOB — not the reading** (revised 2026-08-13).
  Two independent states, and keeping them apart is the point:
  - `.meter--nosignal` — no reading: needle parked at the stop, NO SIGNAL legend. Honesty rule
    unchanged, a resting needle must never look like a measurement.
  - `.meter--dark` — lamp off, set only when there is no reading AND no job running
    (`meter.setPowered()` from `updateCard`). A rack of idle hosts still goes quiet, so exactly one
    face glows.
  They used to be one class, which meant the backlight blinked off in every gap where the rate was
  unknown — on a 28-image batch run the face flashed bright/dark 28 times, which Bryan called out
  as the most distracting thing on screen. **Both skins must override both classes**; overriding
  only `--nosignal` reintroduces the blink in that skin.
  The NO SIGNAL legend is light ink on an unlit face and **dark ink on a lit one**
  (`.meter--nosignal:not(.meter--dark)`) — written for the dark face only, it washed out to nothing
  once the lamp stayed on.
- **CONNECTED IS A LIT STATE, AND IT IS SAID TWICE** (added 2026-08-18, Bryan: "it's too easy to
  think comfyui isn't running and that causes issues"). Two independent changes, because they
  answer two different questions and one lamp cannot mean two things:
  - `--lit` goes **jade** for a reachable host (`[data-status='online']`), so the jewel, numerals
    and node strip all say "this box is there". It was slate — **the exact same slate an OFFLINE
    card shows**, measured `#7C8A94` on both — which is what made a healthy idle instance look
    down. What a host is DOING still outranks it: the rule carries
    `:not(.job-card--running):not(.job-card--finished-success):not(.job-card--finished-error)`,
    because written as a bare attribute selector it beats `.job-card--running` on specificity and
    repaints a running card jade. The reactor's `.pan[data-status='online']` rule needs the same
    `:not()` chain for the same reason, and there it also lights the STANDBY word, which reads
    `--lit`.
  - **A LINK lamp with its own silkscreen** (`.jc-link`) sits left of the status word: dark lens =
    nothing on the other end, jade = a server is answering, amber blink = still connecting. The
    jewel carries job state and cannot also carry link state. Its reactor equivalent is the
    **LINK UP annunciator** — see the reactor section.
- **Only a host that is NOT THERE collapses to a blanking panel** (`.job-card--blank`): offline,
  unreachable, still connecting — nameplate, lamp, one state word, no instruments. **An ONLINE host
  keeps its instruments even when idle** (revised 2026-08-13 at Bryan's request; the earlier rule
  blanked idle-but-online too and he called it "the default look of nothing being connected or
  active"). A reachable instance is the thing he is waiting on, so its card should already read as
  an instrument — dark face, NO SIGNAL, N/A steps — not as a lid. The lever for a host he does not
  want on screen is Hide, not auto-collapse.
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

### Host build info — versions (added 2026-08-14)
`comfyui-client.js` probes on WS connect and every 5 min (`INFO_POLL_MS`), emitting
`snapshot.versions = {comfyui, pytorch, cuda, driver, python}`:
- `GET /system_stats` — stock ComfyUI, verified against 0.33.1. Carries `comfyui_version`,
  `python_version` and `pytorch_version`. `parseSystemStats()` is exported and unit-tested against
  the real payload.
- **The GPU stack is detected, not assumed — `detectAccelerator()`.** `snapshot.versions` carries
  `{accel, accelVersion}`: `+cu130` → CUDA 13.0 (two-digit major then minor), `+rocm6.2` → ROCm 6.2
  (that tag spells its version out), `+xpu` → XPU, `+cpu` → CPU. **THE BUILD TAG IS THE ONLY
  RELIABLE TELL:** PyTorch's ROCm wheels report `torch.cuda`, `device.type === 'cuda'` and even a
  `cuda:0` device name, so `/system_stats` looks identical on both stacks apart from
  `pytorch_version` and the card's own name. An untagged build (source/conda) falls back to matching
  the device name (AMD/Radeon/Instinct/gfx → ROCm, NVIDIA/GeForce/RTX/… → CUDA) and reports the
  stack with a **null version** — a name never yields a version, and the panel prints `Backend /
  ROCm` rather than inventing one. Note the CUDA figure is the CUDA the instance is BUILT against;
  the driver's own max CUDA is a different fact and is deliberately not conflated with it.
- `GET /watcher/host_info` — **our relay node**, because the driver version is in NO ComfyUI endpoint
  and no installed node pack exposes it: Crystools reads it internally (`gpu.py`
  `systemGetDriverVersion`) but its `/crystools/monitor/GPU` route returns index + name only
  (checked against the live install 2026-08-14). The relay probes **both vendors**, ordered by
  `torch.version.hip` (set only on a ROCm build) so a box is never asked about a driver it does not
  have: NVIDIA via `pynvml` then `nvidia-smi`; AMD via `/sys/module/amdgpu/version` then `rocm-smi
  --showdriverversion`. The answer is cached for the life of the process. A 404 from a host whose
  relay predates the route is normal, not an error — driver stays null and the panel drops that
  window. **The AMD paths are unit-tested at the parse level only; nothing here has run against a
  real ROCm box** (there isn't one on this rack).
- A failed probe leaves the previous answer standing rather than blanking a panel over one dropped
  request.

### Rack order, hiding a host (added 2026-08-13)
The host list in `hosts.json` **IS the rack order** — `main.js`'s `watchedHosts()` stamps each
visible host with `order`, the collector emits it in every snapshot, and `renderer.js` sets CSS
`order` on the card. CSS order on a grid item, never DOM reshuffling: a card is never rebuilt, so a
reorder cannot interrupt a running job's readout or its needle. Two ways to move a module, both
writing the same file: drag the card (whole faceplate is the handle — nothing inside it is
interactive), or the ↑/↓ buttons in the settings panel, which are also the only way to move a
**hidden** host, since it has no card to grab.
- **`hidden: true` stops collecting, not just drawing.** A hidden host gets no collector at all —
  it is hidden because the machine is off, and reconnect-looping against a dead address every 10s
  is worse than useless. This is the opposite of the kind filter, which is a pure view (a
  filtered-out host keeps collecting and is instantly correct when unfiltered). Do not "unify"
  them.
- `validate()` keeps `hidden` only when it is literally `true`, so a visible host carries no flag
  and hosts.json stays readable. An all-hidden list must NOT fall back to `DEFAULT_HOSTS` (that
  would resurrect hosts the user hid) — `test/hosts.test.js` pins this.
- **`WatcherService.setHosts` must refresh `client.host` on hosts it keeps.** A collector emits
  `host: this.host` with every snapshot, so without that assignment the renderer keeps being told
  the *old* rack position and a drag appears to do nothing for every host already running — the
  hosts.json write was correct and the rack did not move. Found 2026-08-13 by dragging a card in
  the real app; no test caught it because it lives in the gap between the two processes. A URL
  change now also forces a restart (it always should have — the old code kept the stale connection).

### Card sizing (revised 2026-08-13)
Bryan's report was "the entry is not scaling properly at all; very difficult to find a good size
that fits the window." Three separate causes, all fixed:
1. **The awkward band.** Track minimum was 330px while the wells stack below ~430px of card, so
   every window width between roughly 700 and 900 gave two *stacked* (double-height) cards. The
   track minimum is now the side-by-side threshold itself (`--card-min`, default 470px): a second
   column only forms when both cards can keep their instruments abreast. Stacking is left for a
   genuinely narrow window, where it is the only option.
2. **`align-items: start` on `#cards`.** A blanking panel beside a running module was being
   stretched to the running card's height — an empty graphite slab three times taller than the one
   word on it. Idle cards are 81px now regardless of their neighbours.
3. **`minmax(min(var(--card-min), 100%), 1fr)`.** A bare `470px` minimum is a hard floor, so at a
   340px window every card stayed 470px wide and the whole rack scrolled sideways. The `min()`
   lets the last column collapse to whatever is actually there.

**Top bar `SIZE` control** (persisted to `localStorage['comfyuiwatcher-card-size']`) sets TWO things
per body class: `--card-min` (400 / 470 / 620px — how many modules fit across) and **`--card-zoom`
(0.82 / 1 / 1.18), applied as `zoom` on `.job-card`**.
- **The zoom is what makes the control work at all.** Column count alone was invisible at Bryan's
  own window size: at 785px wide all three settings still fit exactly one column, so his verdict
  was "the compact, normal and large dropdown does not appear to do anything" (2026-08-13). Zoom
  scales the whole faceplate — dial, numerals, silkscreen, bolts — at any window width.
- `zoom`, not `transform: scale()`: zoom scales layout space, so the card still fills its track,
  still sets its own height, and its container-query width becomes track/zoom (which is what keeps
  a zoomed-out module side by side instead of stacking). A transform would leave the original box
  reserved and overlap its neighbours.
- **Anything comparing a mouse coordinate to a card rect must divide by the zoom.** In this
  Chromium `getBoundingClientRect()` on a zoomed element reports its own scaled space (a card in a
  736px track measures 898 at zoom 0.82) while `event.clientX` stays in viewport pixels. The
  drag-to-reorder midpoint got this wrong at first: dropping on the right half moved the module
  left on every size except Normal. Verified after the fix at all three zooms, both halves.
- Playwright's `dragAndDrop` cannot settle a zoomed element ("visible and stable" then retries
  forever). Drive drag tests with synthetic `DragEvent`s at a computed VISUAL x
  (`(rect.left + rect.width * f) * zoom`) instead.
- **A container query on `container-type: inline-size` measures the CONTENT box.** The stacking
  breakpoint of 358px is therefore about a 392px card once padding and border are counted, and
  every `--card-min` has to clear it *in those terms* or a size setting would stack its own default
  width. This cost one wrong pass at 385px.
- The meter well centres its dial (`justify-content: center`): the well is as tall as the readout
  beside it, and on a narrow module the instrument otherwise sat with a hand's width of empty well
  under it.
- Every top-bar dropdown is styled by `#topbar-controls select`, not by id. `#kind-select` had
  never been styled and sat in the rack faceplate as a raw blue Windows combobox. Same trap in the
  settings panel: **a flat `background-color` does not displace the native `<select>` widget, a
  gradient does** (`appearance: none` would too, but it drops the caret and the CSP here forbids
  the `data:` URI a replacement glyph needs).
- The title strip yields before the controls do (`min-width: 0` + ellipsis, gone below 580px) — a
  third dropdown made it print straight through the selects at ~560px.

### Step-Rate and ETA Estimation (rewritten 2026-08-13 against a live batch job)
`_progressHistory` keeps `{value, atMs, node}` samples over a 20s window; `stepsPerSec` is the
**average of the per-step intervals** in it, with anything over 3x the median dropped as a pause —
the same shape `aitoolkit-client.js` arrived at, for the same reason (one 40s gap inside the window
otherwise halves the figure and the ETA with it). Recent rate, not a lifetime average: a job's early
steps are not representative once caching/skip-style techniques are in play (see the EasyCache
findings in [[project-minimax-h3-attention-setup]]). `etaSec` is `null` unless there is a rate AND
`max > 0`, never a fabricated number, same principle guiTOP's `host-stats.js` follows for CPU
percent.

**THE WINDOW MUST BE THROWN AWAY WHEN THE PROGRESS BAR RESTARTS.** This was the bug behind Bryan's
"the sync is not working, the dial only starts to register when there's 2 steps left" (2026-08-13).
His Flux2-Klein dataset workflow is a **batch**: the same sampler node emits `value` 1..8, then
immediately 1..8 again for the next image, all under **one prompt_id** — verified by tapping the WS
directly (`watcher.progress value=8 max=8 node=9` at t+80.2s, `value=1` at t+84.0s). The old
estimator took `(last - first)` across the window, so for the first ~15s of every image the window
still held 6,7,8 from the previous one, the delta was negative, and the rate was `null` — needle at
the stop under NO SIGNAL. It recovered only once those samples aged out, around step 6 of 8. STEPS
LEFT was right the whole time because it reads `value` and never the window, which is exactly why
the two readouts disagreed.
- A **node change** resets the window too: a tiled VAE decode runs its own bar with its own max, and
  splicing two bars together measures nothing.
- A **repeated value** is a duplicate, not a stalled step — a job submitted under our own clientId
  arrives twice (ComfyUI's targeted message plus the relay's broadcast copy). Skip the sample; do
  NOT treat it as a restart.
- **The window keeps its last 4 samples however old they are** (`RATE_MIN_SAMPLES_KEPT`). A time
  window alone reports "no rate" on the job that most needs one: MiniMax H3 video runs 14-30 s/it,
  so a 20s window would hold a single sample and the needle would never move for the entire run.
- Two samples (one interval) is enough to publish a rate here, unlike the trainer's three: sampler
  steps are uniform, the samples are push-driven rather than 1s-polled (no whole-second
  quantisation), and a restart empties the window instead of poisoning it. That is what makes the
  needle come alive one step into a run rather than six.
- **A stub cannot find this class of bug and neither can a unit test written from the docs** — it
  took a WS tap against the real server while Bryan's own workflow ran. Same lesson as the
  ai-toolkit cached-row skew: measure a rate against the actual server before believing it.

### Batch position — "Image 3 / 28" (added 2026-08-13)
A dataset workflow is ONE prompt that runs the sampler once per prompt line, so "Step 3 / 8" repeats
for every image with nothing saying where in the run you are.
- **The count is observed, not told to us**: `pass` increments on every bar restart for the same node
  (`_onProgress`), resets on a new prompt or a change of node. Nothing in ComfyUI's protocol marks a
  list-expanded item.
- **The total needs the relay.** `execution._async_map_node_over_list` knows it (`max_len_input`), so
  `comfyui-relay/__init__.py` wraps that internal function and broadcasts `watcher.batch`
  `{prompt_id, node, total}` once per node run. It is written to fail into a no-op: if the signature
  changes, ComfyUI's execution is untouched and the widget simply loses the denominator. **Editing
  the relay means re-copying it into both installs AND restarting ComfyUI** — until then a host
  shows `Image 3` with no total, which is the honest fallback, never a guessed `/ 1`.
- Totals are keyed by node id (`_batchTotals`) and cleared per prompt: a decode node's 28 is not the
  sampler's 28 by coincidence, and showing one against the other would be luck, not logic.
- **A known rate is never replaced by `null` inside one job.** Emptying the rate window at each item
  boundary left the first step of every image unmeasurable, so `stepsPerSec` went null for ~3s out of
  every ~28s. That is what actually made the dial blink; holding the last measurement is honest
  (same work, same size, same model) and it is cleared on `execution_start`, a new prompt_id, or a
  node change.
- The bargraph and STEPS LEFT stay **per item** on purpose. They answer "how far through this image",
  and the batch line answers "which image" — mixing the two into one overall percentage would make
  the step count and the bar disagree.

### `executing` with `node: null`
Only clears `currentJob` if it was already marked `finished` (by a prior `execution_success` /
`execution_error`). A `node: null` between two nodes mid-job is normal and must not blank the UI —
this was wrong in an early version of this project's own test, not the collector; fixed 2026-08-11,
see `test/comfyui-client.test.js`.

## Reactor panel — the second card widget (added 2026-08-14)
`renderer/widgets/reactor-panel.js` + `styles/reactor.css`. **Not a skin**: skins are pure CSS over
the rack card's one DOM, this has its own markup and instruments, so it is its own module the way
guiTOP carries `GpuCardBars` alongside `GpuCardCorvette`. `renderer.js` holds a `WIDGETS` map
(`card` / `reactor`); a card is rebuilt when its **widget family** changes, never when only the
paint does. One layout, two idioms picked at build time: **`room`** (P1 control room — painted
steel, ivory faces, incandescent lamps, split-flap counter) and **`console`** (P2 reactor console —
glass and xenon, lit arcs, nixie tubes). Both live in the same top-bar dropdown as the three skins,
because from the desk "what does the rack look like" is one question.

Everything on the panel is driven by a field a collector actually reports — that is what makes the
density honest, and it is the rule to hold any addition to:
- **Annunciator bank, ONE ROW OF FOUR**: Reactor Run / Cycle Done / Fault / Offline (cut from nine
  on 2026-08-18 — "waaay too many long rectangle boxes"). An unlit tile is still a real "not true".
  The bank now carries only states with no other voice on the panel; what was dropped still speaks:
  Queued → the QUEUE figure on the tell-tale line, Batch Run → the WORKFLOW bulb row (which exists
  only on a batch job), No Step Data → STEPS LEFT already printing N/A, Link Up → the header pill
  below. **Relay Absent is the one that lost its only surface here** and is now reported per host
  only in the (i) setup panel; if it needs a lamp again it needs one of these four slots, not a
  fifth. Tiles are **capped at 186px and clustered left**, not stretched to `1fr`: four tiles across
  a wide panel are 270px slabs, which is fewer boxes but longer ones — the same complaint. The
  panel's width belongs to the instruments.
- **The link lives in the header, not the bank** (`.p-link`, hard right): a lit pill reading
  **LINK UP** jade / **LINKING** amber / **OFFLINE** red. Exactly one is always lit, so an unlit
  header is not a state a reachable host can produce. It is in the header because it is a fact
  about the *connection*, not about the run — and in the bank it was just one more long rectangle.
- **The status word is an instrument, not a label.** `.p-hstat` (ONLINE/OFFLINE/CONNECTING) never
  changed appearance once painted; it now **ticks jade on every snapshot the collector pushes**
  ("make the ONLINE do something other than do nothing", 2026-08-18). That is a claim the pill
  cannot make: the pill says a link exists, the tick proves data is still arriving, so a link that
  died without closing shows a frozen word. Implemented as **two alternating class names**
  (`--beat-a`/`--beat-b`) so the animation restarts on a changed name rather than a forced reflow
  twice a second per panel. Both are disabled under `prefers-reduced-motion`.
- **Twin rate dials** — the rack card's single face split at the crossover and mirrored, pivots at
  the outer edges, both arcs closing inward around the readout (Bryan picked this facing over
  back-to-back on 2026-08-13). Both movements read UP for more; "further right is faster" cannot
  survive a mirrored pair. **NO NUMBERS on the arcs** — ticks, two end words, and the exact figure
  in the tell-tale column between them, like a fuel gauge. Only the half holding the reading lights;
  the other rests at its stop at 0.16 opacity. Marks come from lcd.js's hand-written tables via the
  exported `faceSpec()`, so the **Dials** range setting still governs, and sampling splits at 1:1
  while training splits at the geometric middle of its range (its end word prints that, e.g. `8s`).
- **Cycle progress movement** (linear 0–100%) and a **step counter**: split-flap in the room idiom,
  nixie in the console one. Fixed width, LEADING ZEROS — a mechanical counter has a wheel in every
  position — but it **grows** if a job needs more digits than the kind's default (2 sampler /
  4 trainer), because truncating a real number to fit the mechanism would be a lie. No step data
  blanks the mechanism and prints N/A; zeros are for positions a real number does not reach.
  **Build the wheels at construction**, not on first reading: the N/A overlay is positioned over the
  window, and an empty mechanism gives it no height, so an idle host showed an empty box.
- **LED bulb banks replace the progress bar outright** (the bar was the same fact in a weaker
  language, and `Step X/Y · %` moved onto the bank). Row 1 is 20 bulbs across the current node. Row 2
  is one bulb per image and **exists only when the relay reported an item total**, so the socket
  count is itself a measurement — capped at 40 sockets.
- **Rate recorder**, 60s of measured rate: time left→right, the pen is now, height is the dials' own
  log scale, so higher is faster on both. The pen lifts on a gap rather than interpolating across a
  stall. **It has to say what it is** — unlabelled it reads as a level gauge, not a rate over time
  ("I don't know how to interpret it", Bryan 2026-08-14). So: both ends of the scale printed down the
  left edge in the units the dial prints (`20 it/s` / `20 s/it`), a dashed line at the 1:1 crossover
  when the face spans one, and the time axis stated in the caption (`60 s ago → now`) rather than
  tagged inside the plot, where the right-hand label sits on the trace exactly when the trace is
  interesting. Labels are HTML over the SVG: the chart is drawn `preserveAspectRatio="none"` so it can
  stretch, and any `<text>` inside it stretches too.
- **Four windows under the step counter, and what they hold depends on the kind** (2026-08-14, Bryan
  asked for the versions):
  - **`comfyui`: what the host is BUILT FROM**, laid out two per row as **ComfyUI | Driver** over
    **PyTorch | CUDA** (Bryan's arrangement — the app and the driver on top, what the app is built
    against underneath; `COMFY_WINDOWS` order IS the layout). The third window **relabels itself**
    from the detected GPU stack: CUDA, ROCm, XPU or CPU. Host
    facts, not readings, so they are set in plate ink with no glow (`.p-count-val--static`), and a
    window with nothing behind it is **removed**, not dashed — `wrap.hidden`, with
    `.p-count-wrap[hidden] { display: none }` in reactor.css, because an author `display` beats the
    UA `[hidden]` rule (the exact trap that left a permanent "BATCH ETA --" on the rack card).
  - **`aitoolkit`: ETA / Elapsed / Loss / Queue**, the live figures — a trainer has no endpoint that
    reports versions, so it keeps the counters. Same column, different contents; the panel structure
    does not fork.
- **Tell-tale line** (`.p-tell`, generation panels only): Elapsed / ETA / Batch ETA / Queue in one
  strip under the bulb banks, ~18px against the 83px the windows cost. The live figures were NOT
  dropped when the windows became build info — ETA is the most-asked question of a watcher, and a
  panel that prints a driver version but not "when is it done" is a worse instrument. Batch ETA
  hides on a non-batch job, same rule as the rack card.
- The identity plate is metadata only. **The counters/windows live in the third column of the
  instrument row, under the step counter** — a small mechanism in a dial-height well left a third of
  the panel empty, and a separate full-width counters row cost another 50px. One change fixed both.
- **INSTRUMENTS DO NOT GROW WITHOUT LIMIT** (`max-height` on the dial and progress SVGs, a fixed
  height on the recorder strip). At `width: 100%` an SVG scales with the panel, so a single module in
  a wide window drew a foot-wide dial and a 150px recorder — the panel got taller the more room it
  was given, which is the opposite of what the SIZE control is for. Past the cap the instrument
  centres in its well, which reads as gear mounted in a panel cutout.
- Layout is one row of eight annunciators and a one-row identity plate above ~620px of panel content,
  4x2 and two rows below it. Tightening those two plus the counter move took a running panel from
  545px to ~500 at 618px wide (and it no longer inflates with window width).
- **The pointers register with lcd.js's shared rAF loop** via the exported `createNeedle()` — three
  needles per panel × N hosts is exactly the per-card timer problem that loop exists to avoid, and
  `destroyReactorPanel` must give them back.
- A panel collapses to header + annunciators (`.pan--blank`) only when the unit is NOT THERE; an
  online-idle host keeps its instruments, same call as the rack card. The **cycle-progress SVG is
  clipped** (`overflow: hidden`) because its pivot sits below the face and the hub otherwise paints a
  red blob over the legend.
- Cost: **~500px tall per host** at Normal (was 545 before the 2026-08-14 tightening pass), so
  `--card-min` is raised per size class in reactor.css (480/540/660). A compact variant dropping the
  recorder was discussed and is NOT built.

## Skins (added 2026-08-12)
Same mechanism as [[project-guitop]]: a `skin-*` class on `<body>`, persisted to
`localStorage['comfyuiwatcher-skin']`, switched from a `<select id="skin-select">` in the top bar.
`renderer.js` owns the three lines that do it; `styles/main.css` holds STRUCTURE plus the default
**1U Rack** look, and `styles/skins.css` holds alternates as token/surface overrides.

`renderer/mock-skins.html` is the live mockup for judging one — and since 2026-08-14 for judging
**all five looks**, reactor panels included: it dispatches on widget family exactly the way
renderer.js does. Real stylesheets, real widgets, fake data that MOVES (steps advance, a batch
restarts its bar, rates wander), every card state on one page — running with steps, running with
none (and `relay: false`, the one host that lights RELAY ABSENT), training, finished, failed,
online-idle, offline.
Serve the repo (`npx http-server . -p 8791`) rather than opening it as `file://`; a skin decided off
a static card is a skin decided off the one frame that happened to look good.
- **`rack`** (default) — bolted graphite faceplate, ivory printed dial, amber lamps.
- **`halo`** (added 2026-08-14, Bryan asked for "obsidian glass but not a retro dial — ultra
  modern, borderline futuristic, glass and metal") — obsidian field, smoked-glass panes in a
  machined frame, xenon-azure light. Nothing printed, engraved or bolted. **The instrument is the
  signature and the only bright thing on the card:** the dial pane and the hub are gone, and the
  rate reads off a **lit arc** — a dim titanium track over the full sweep whose measured part
  lights in xenon, crossed at the reading by the needle, which is dashed down to its outer 26
  units so it shows as a floating beam rather than a pointer on a pivot. The backlight is a pool
  of light rising from the pivot (`.meter` background), tied to `.meter--dark` — the lamp, never
  the reading. Palette is deliberately not glass's cyan and not rack's amber: two skins glowing the
  same colour make the dropdown feel like a brightness control.
  - **The arc is drawn by `lcd.js` for every skin and hidden in `main.css`** (`.meter-arc-track` /
    `.meter-arc-value`); only this skin paints it. It carries no information the needle does not —
    it is a second rendering of one value, which is why hiding it elsewhere is a skin decision and
    not a lost readout, and why every skin still shares ONE DOM. The value path is driven from
    `state.apply()`, so it swings with the same ballistics and parks at zero length. **It is hidden
    below a hair of length on purpose** — round caps on a zero-length dash paint a lit dot, the
    same trap the old arc gauge hit, and a dot at the stop would read as a measurement.
  - Also a modern rewrite of the ornaments: jewel lamps become slivers of edge light, the LED
    bargraph becomes a hairline capsule (`.jc-bar-cells` hidden — cells are a segmented-display
    idea), dial numbers are set in the mono face because on this instrument they are data, not
    silkscreen.
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

## LEAVE THE APP RUNNING when the work is done
Bryan signs off by using the app, not by reading a diff or a screenshot. A playwright/CDP-driven
instance dies with its driver, so after the screenshot pass **relaunch detached and confirm the
window is up** before reporting:
`Start-Process E:\vs_code_projects\comfyuiWATCHER\node_modules\electron\dist\electron.exe
E:\vs_code_projects\comfyuiWATCHER` (with `ELECTRON_RUN_AS_NODE` cleared), then
`Get-Process electron` should show one with `MainWindowTitle` = comfyuiWATCHER.
Do not ask about shipping until he has had the running build to try. He has had to ask for this
more than once — 2026-08-13 was the second time.

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

## Status (2026-08-13 PM, rack order + sizing + the batch-rate bug)
Four things Bryan asked for off a screenshot of the running app, all verified in the real app rather
than by test alone (`test/` is at 4 files, all passing):
1. **Reorder** — drag a card, or the settings-panel arrows. Driven end to end via playwright:
   visual order, `hosts.json` order and the settings list all agree after a drag.
2. **Hide without removing** — `hidden: true`, card gone and collector stopped, entry kept.
3. **Sizing** — see "Card sizing" above. Measured at 340/430/520/640/785/850/900/1400 wide.
4. **The dial lagging the digits** — see "Step-Rate and ETA Estimation". Root cause was the batch
   job restarting the progress bar; found with a live WS tap, fixed, and the live card then read
   `3.51 s/it` at step 7/8 with the needle just left of centre.

Version still 0.0.5, nothing rebuilt or released for this yet.

**Not built yet / next:**
1. Window state persistence, tray/minimize (guiTOP playbook).
2. No UI for *editing* a host (name/url/kind) — only add, remove, hide, reorder. `hosts.json` in
   `userData` (`%APPDATA%/comfyuiwatcher`) is still the way to change a URL.
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
