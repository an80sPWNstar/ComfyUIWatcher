# HANDOFF

Append-only session log. Newest entry wins; older entries are history, not instructions.

## 2026-08-11 09:55 -- v0.1 build-out session
- v0.1 works, verified live against New Main (8188) + Secondary (8189): WS broadcast msgs +
  1s REST poller (/queue, /history), host add/remove UI, finished-hold state, indeterminate
  progress bar for foreign jobs, packaged exe at dist/win-unpacked/comfyuiWATCHER.exe.
- CORE PROTOCOL FACT: ComfyUI 0.31.1 targets ALL execution messages (progress/executing/
  execution_*) at the submitting clientId only. Passive watchers get status + crystools only.
  See CLAUDE.md "WebSocket Message Handling" for file:line evidence. Do not re-litigate.
- Electron 31 main = Node 20.18 → NO global WebSocket → `ws` dependency added with global fallback.
- IN FLIGHT: comfyui-relay/ custom node written but NOT yet installed/verified — classifier
  blocks writing into D:\ComfyUI_Installs. Bryan to copy comfyui-relay/ →
  custom_nodes/comfyui-watcher-relay/ on BOTH instances + restart. Then verify watcher.progress
  arrives and update CLAUDE.md's "Unverified" line.
- Machine quirk: electron postinstall exits 0 but dist/ gets stripped to locales/ only (AV?).
  Manual fix documented in CLAUDE.md Commands table.
- Unexplained (parked): an own-clientId /prompt submission received zero progress messages
  even though history shows the job ran under that client_id. Relay makes it moot for the app.

## 2026-08-11 09:40 -- v0.1 wrap-up (same session, after Bryan approvals)
- Bryan approved writes into D:\ComfyUI_Installs: relay copied to BOTH installs' custom_nodes/.
  NOT loaded yet — both instances last restarted before the copy. Restart pending (8188 had a
  job running at 09:40; do not restart under a running job). Verify watcher.progress after.
- Version set 0.0.1 per Bryan ("low build number"); NSIS installer built clean:
  dist/comfyuiWATCHER Setup 0.0.1.exe (78MB). build.publish=null added to stop publish errors.
- Both instances crashed ~09:28 during Bryan's MiniMax H3 video job (log stops mid-sampler, no
  traceback; same signature as the morning LTX 22B crash). NOT the watcher — read-only HTTP/WS.
  Heavy-video-model loads crash this box; watch for it.
- Bryan privacy rule (also in auto-memory): pass job METADATA only. Never fetch/view his
  generated images or prompt text. Relay intentionally does not rebroadcast preview frames.

## 2026-08-11 12:57 -- relay verified + polish
- Relay VERIFIED live on New Main (log line 09:50:49; watcher.progress observed; card showed
  Step 9/20 -> 10/20, 13.93 s/it, ETA for Bryan's real video job). Secondary still down, its
  relay copy loads whenever it starts.
- Node display names: _applyQueue caches id->(_meta.title ?? class_type) from the running
  graph; composite subgraph ids ("105:14") fall back per segment. Verified live
  (CheckpointLoaderSimple / Negative Prompt / KSampler).
- Obsidian Glass theme adapted from guiTOP styles/main.css tokens (bg #060A12, glass gradient
  cards, glow pills). Topbar is now a drag region.
- Installer rebuilt: dist/comfyuiWATCHER Setup 0.0.1.exe (12:56). 19 test assertions pass.

## 2026-08-11 14:15 -- v0.0.2 shipped to GitHub
- Bryan approved the app live, bumped to 0.0.2. Repo synced: github.com/an80sPWNstar/ComfyUIWatcher
  (main; merged their initial README/LICENSE; repo-local git identity an80sPWNstar set here).
- Release v0.0.2 published with 3 assets: Windows NSIS exe (built on Windows), AppImage + deb
  (built in WSL Ubuntu at ~/cw-build — AppImage/deb CANNOT build on native Windows, mksquashfs/
  fpm are Linux binaries; deb also requires "homepage" in package.json, now set).
- WSL build dir ~/cw-build left in place for future Linux builds (copy source + package.json in,
  npx electron-builder --linux).

## 2026-08-12 10:2x -- visual rebuild (hardware strip out, steps-left readout in)
- Bryan: crystools hardware stats at card bottom REMOVED (distracting). Replaced by hero readout:
  arc gauge (progress) + seven-segment STEPS REMAINING for current node, "N/A" when no step data.
  `snapshot.system` still collected, just not rendered -- leave it collected.
- New `renderer/widgets/lcd.js` (seven-seg + arc gauge, ported from tempsLCD-web design_system).
  Fonts vendored to `assets/fonts/` (ShareTechMono, Orbitron); CSP gained `font-src 'self'`.
  main.css largely rewritten; stats are now label/value rows, progress bar is LED-segmented.
- Verified live against New Main + 6 mock cards (all states incl. 4-digit steps). 19 assertions pass.
- NOT DONE: installer/AppImage not rebuilt, version still 0.0.2, nothing committed or pushed.
- Screenshot recipe traps documented in CLAUDE.md (slow script parse on E:, fullPage screenshot
  hangs -> use webContents.capturePage).

## 2026-08-12 12:3x -- "1U" rack redesign (frontend-design skill)
- BUG FIXED (was live, shipped in 0.0.2): #cards squashed every card to 83px once content
  exceeded window height -- cards set overflow:hidden -> automatic min-size 0 -> auto grid rows
  split the space instead of scrolling. Fix = `grid-auto-rows: max-content`. Do not remove.
- Visual direction changed on Bryan's pick: rack module per host (bolted faceplate, engraved
  nameplate, jewel lamp, recessed wells, LED bargraph). Arc gauge REPLACED by a moving-coil
  rate meter with real needle ballistics (shared rAF loop); Orbitron dropped for Rajdhani
  (vendored from tempsLCD-web into assets/fonts/). See CLAUDE.md "Card Visuals" for the rules.
- Two behaviour changes worth knowing: the meter face only lights when there IS a rate (idle rack
  stays dark), and hosts with no job collapse to a slim blanking panel. Layout responds to CARD
  width via container queries, not viewport.
- `destroyCard()` added and called from renderer.js -- a removed card must unregister its needle.
- Verified by launching the real app + 7 mock states at 380 / 660 / 760px; 19 test assertions
  pass; needle swing measured gradual (-31.2deg -> 21.7deg over ~1.5s, matches the log scale).
- BUILT 0.0.3 (version bumped): dist/comfyuiWATCHER Setup 0.0.3.exe (78.5MB, NSIS) +
  dist/win-unpacked/comfyuiWATCHER.exe. Verified by LAUNCHING THE PACKAGED EXE, not by exit code:
  skin select present with both options, skins.css rules live inside the asar, Rajdhani renders,
  card draws.
- Linux 0.0.3 built too, in WSL Ubuntu 26.04 (~/cw-build, source rsync'd from /mnt/e first):
  comfyuiWATCHER-0.0.3.AppImage (107MB) + comfyuiwatcher_0.0.3_amd64.deb (74MB). Both COPIED into
  the Windows dist/ so all four artifacts sit together. Verified: skins.css + Rajdhani + the
  skin-select markup are inside the AppImage's app.asar, deb reports Version 0.0.3, and the
  extracted binary runs under WSLg for 12s+ (the viz_main_impl GPU errors are WSL software-
  rendering noise, not a crash). Note the Linux binary is lowercase `comfyuiwatcher`.
  Gotcha for next time: calling wsl.exe from Git Bash mangles /mnt/... paths -- prefix
  MSYS_NO_PATHCONV=1, and use `bash -l` or node is not on PATH.
- SHIPPED: pushed to main (9170251 + c8a55cb) and released v0.0.3 with all three installers
  attached -- github.com/an80sPWNstar/ComfyUIWatcher/releases/tag/v0.0.3, now marked Latest.
- STANDING INSTRUCTION from Bryan: "build the installers and do a full commit/push" means the
  whole chain through a published GitHub release, every platform attached. Checklist is in
  CLAUDE.md under "Ship checklist" -- follow it without being asked for the individual steps.
- Also dropped the now-unused Orbitron font and added assets/fonts/NOTICE.md (OFL 1.1 attribution
  for Rajdhani + Share Tech Mono, since the repo is public and the binaries are committed). If
  strict compliance matters, the full OFL text should replace the link in that file.
- Still uncommitted. ELAPSED/ETA
  legends and the exact-rate RATE legend still duplicate what the meter shows in magnitude --
  left deliberately (needle can't give an exact figure), revisit if Bryan finds it noisy.
- Bryan approved the look; the meter face took 4 rounds. FINAL: face split at the 1:1 mark, left
  half graduated in s/it and right half in it/s, labels 100/10/1/10/100 (all whole numbers), and
  the unit word for the half the needle is in lights pointer-red. Same 1.0 cutover as fmtRate(),
  so face and RATE legend always agree. Needle+hub are now red, distinct from the dark scale ink.
  Rejected en route (do not retry): both unit words over one it/s row; a second rust s/it row;
  single it/s scale with 0.01/0.1 labels; SI prefixes (10m/100m reads as minutes, not milli).
- SKINS added (guiTOP pattern: body class + localStorage + topbar select). 'rack' = new default,
  'glass' = the 0.0.2 look kept as an alternate, in styles/skins.css. Pure CSS over one DOM --
  see CLAUDE.md "Skins" for what a skin is and is not allowed to change.
- Readout well gained a job-identity plate (MODEL / SIZE) in the empty space right of the digits.
  New pure fns describeModel()/describeSize() in comfyui-client.js read the running graph the
  /queue poll already fetches -- metadata only, no prompt text. Rows hide when unknown.
  8 new assertions cover them. NOT YET SEEN AGAINST A LIVE JOB (both hosts down at the time) --
  check the model line on the next real run before trusting it.

## 2026-08-13 02:00 -- AI-Toolkit (LoRA trainer) support

- Decision: trainers live in THIS app, not a new project. `host.kind` (`comfyui` | `aitoolkit`)
  picks a collector via new `src/collectors/index.js`; the snapshot contract is the seam and
  nothing above the collector knows the kind. Repo/app name kept as-is even though it is now
  narrower than the app.
- New: `src/collectors/aitoolkit-client.js` (REST-only poller for ai-toolkit's UI server, default
  port 8675), kind filter in the top bar (All/Generation/Training, persisted), kind-aware card
  (training face, BASE MODEL/RESOLUTION/RANK, LOSS legend), settings panel kind picker.
  24 assertions in `test/aitoolkit-client.test.js`; full suite passes.
- Dial: training cards get a NEW face -- 60..1 s/it, single unit -- chosen by Bryan from a live
  mockup (`renderer/mock-train-dial.html`). Scaled from his six recorded runs (2.17..30.07 s/it);
  nothing he has trained ever exceeded 1 it/s. Both faces stay it/s underneath so needle-right
  always means faster. Rejected: unchanged sampling face, loss-on-the-needle face.
- VERIFIED against a stub serving REAL rows from `D:\ai-toolkit\aitk_db.db` (both ComfyUI hosts
  AND the ai-toolkit UI were down all session). NOT yet seen against the live UI server -- that is
  the next check when Bryan starts a run.
- `%APPDATA%\comfyuiwatcher\hosts.json` was rewritten to add the AI-Toolkit host and `kind` fields.
  Previous file saved beside it as `hosts.json.bak-claude`.
- Local-LLM review of the new collector (.70) found one real defect: `fetch` with no timeout would
  wedge `_pollInFlight` forever on a half-open connection. Fixed with `AbortSignal.timeout(8000)`.
  NOTE: `comfyui-client.js` `_poll()` has the SAME unbounded-fetch pattern -- left alone as out of
  scope, worth fixing.
- Not done: version bump, installers, release. Still 0.0.3.

## 2026-08-13 02:55 -- live verification against the real ai-toolkit server

- Bryan started the UI (8675) and a real H3 run. Three rate bugs surfaced that the stub could not:
  1. 131s model-load stall poisoned the window -> median of per-step intervals.
  2. 1s poll quantises intervals to whole seconds -> trim >3x median, then AVERAGE the rest
     (median alone read 3.02 s/it on a 2.55-2.85 job).
  3. WORST: `_applyJob` ran on BOTH the 5s-cached list row and the fresh by-id row, so the window
     filled with "+2 steps in 5ms" pairs -> 200 steps/sec, 0.005 s/it, 3-second ETA. Only the
     uncached `?id=` read may sample now; the stale row also cannot rewind `job.step`.
  Bryan caught #3 by looking at the card ("not sure it's reading the lora job correctly"), not any
  test. LESSON: a stub serving one number to both endpoints cannot expose cache skew. Measure a
  new collector against the real server before trusting a rate.
- Added `job.phase` -> `.jc-phase` top-right of the faceplate, from ai-toolkit's `info` column
  (observed live: "Model Loaded", "Loading dataset", "Training"). A run is silent for minutes
  while loading; without it the card is indistinguishable from a stall.
- Also learned: the python trainer writes `step` straight into the sqlite DB, so `updated_at`
  (Prisma @updatedAt) can be DAYS stale on a live row. Never use it for freshness.
- Training can run headless with no UI server; the collector needs the UI up. Bryan says that will
  be fixed on his side, so no DB-reading fallback was built.
- All tests pass (30+ assertions). App left running. Still uncommitted, still 0.0.3.

## 2026-08-13 03:20 -- shipped v0.0.4

- Bryan approved the bigger dial ("keep it for now so I can use it and form an opinion") -- the
  empty lower third of the meter face is NOT settled; he may want the face cropped later.
- Version 0.0.4. Built + verified + released:
  - Windows NSIS `dist/comfyuiWATCHER Setup 0.0.4.exe` -- asar checked for src/collectors/*
    (aitoolkit-client.js present, renderer/mock-*.html excluded via a new files rule), and the
    packaged exe was LAUNCHED and confirmed running, not just built.
  - Linux built in WSL at ~/cw-build (rsync, then `npx electron-builder --linux`), AppImage + deb
    copied back into dist/.
- Commit 9dd1b65 pushed to main. Release v0.0.4 published with all three installers attached:
  https://github.com/an80sPWNstar/ComfyUIWatcher/releases/tag/v0.0.4
- Still unverified live: queued / finished / stopped transitions on a training host. Everything
  else was watched against the real H3 run.
- Known and deliberately not done: `comfyui-client.js` `_poll()` still has the unbounded-fetch
  pattern that was fixed in the ai-toolkit collector.

## 2026-08-13 03:45 -- v0.0.5: relay ships with the installer

- Found while answering Bryan: v0.0.4's installer contained NO copy of comfyui-relay (resources/
  held only app.asar + elevate.exe), so an installer user could not do the one manual step that
  makes ComfyUI step progress work, and nothing told them it existed.
- Fix: `extraResources` puts comfyui-relay at resources/comfyui-relay (NOT in the asar -- you
  cannot copy a file out of an archive). `relayDir()` in main.js resolves packaged vs dev.
- New first-run setup panel (renderer/widgets/setup-panel.js): the 4 steps, the real on-disk path,
  an Open-folder button (shell.openPath), dismissed into the (i) button afterwards.
- Relay detection: comfyui-client sets relaySeen on any watcher.* message; snapshot.relay is
  true/false/null and false is only claimed 10s into a running job. Panel shows it per host.
- VERIFIED IN THE PACKAGED BUILD, not just the source: attached over CDP (playwright's _electron
  driver cannot launch a packaged app) and confirmed relay.dir -> resources\comfyui-relay,
  exists:true, panel visible on first run.
- Linux built in WSL; resources/comfyui-relay present in linux-unpacked too.

## 2026-08-13 12:xx -- rack order, hide, sizing, batch-rate bug (session: opus/CLI)
- Bryan's 4 asks off a live screenshot, all done and looked at in the real app; NOT committed,
  NOT released. Version still 0.0.5. Tree is dirty: main.js, service.js, hosts.js,
  comfyui-client.js, renderer.js, settings-panel.js, index.html, main.css, skins.css, CLAUDE.md,
  + new test/hosts.test.js. `npm test` = 4 files passing.
- REAL BUG FIXED, root-caused off a live WS tap: a batch workflow re-runs the same sampler node so
  progress `value` restarts (8 -> 1) under one prompt_id. The old (last-first)/window rate went
  negative for ~15s of every image => needle dead until ~2 steps left while STEPS LEFT was right.
  Window is now reset on a bar restart / node change, duplicates skipped, per-interval trimmed
  average, last 4 samples kept regardless of age (H3 video at 30 s/it never had a rate before).
- `hidden: true` in hosts.json = keep the entry, stop collecting (no card, no reconnect loop).
  List order = rack order, applied as CSS `order` from snapshot.host.order.
- WatcherService now refreshes client.host on kept hosts (a collector emitted its stale host object,
  so reorders never reached the renderer) and restarts on a URL change.
- I DID write to Bryan's real %APPDATA%/comfyuiwatcher/hosts.json while driving the UI; restored to
  New Main / Secondary / AI-Toolkit, nothing hidden.
- Next session: nothing in flight. If he signs off, this is a 0.0.6 release (see ship checklist).

## 2026-08-13 (later) -- dial ranges + SIZE control actually scales
- Sampling dial default is now +/-20 (was +/-100); ranges 5/20/100 selectable in the hosts panel
  under "Dials", training 10/30/60 (default 60). Faces are hand-written mark tables in lcd.js and
  reprint IN PLACE via meter.refreshFace() -- no card rebuild, needle keeps its reading.
- SIZE (Compact/Normal/Large) now also sets --card-zoom (0.82/1/1.18) applied as `zoom` on the card.
  Column count alone was invisible at ~785px windows, where all three settings fit one column.
- TRAP: getBoundingClientRect on a zoomed card is in the card's own scaled space, event.clientX is
  viewport px. The drag midpoint needed `/ zoom` -- without it, right-half drops moved cards left on
  Compact and Large. Verified both halves at all three zooms with synthetic DragEvents (playwright
  dragAndDrop cannot settle a zoomed element).
- Still uncommitted, still 0.0.5. App left running for Bryan to test.

## 2026-08-13 (later still) -- batch counter + the dial stops blinking
- Card shows "Image 3 / 28" in the bargraph meta row. Count = observed bar restarts per node; TOTAL
  comes from a new relay broadcast (watcher.batch) because nothing in ComfyUI's protocol carries it.
  Relay wraps execution._async_map_node_over_list (fails into a no-op if that signature changes).
  RELAY COPIED into both installs; ComfyUI must be RESTARTED before the "/ 28" part appears. Until
  then the card reads "Image 3", which is the honest fallback.
- Dial no longer flashes: the lamp follows the job (.meter--dark) and is separate from "no reading"
  (.meter--nosignal). Also: a known rate is never overwritten with null inside one job, which is what
  actually caused most of the blinking (window emptied at each batch item).
- NO SIGNAL legend now switches to dark ink on a lit face.
- 4 test files pass, incl. new pass-counting / watcher.batch / rate-held-across-item assertions.
- Bryan's zimage dataset workflows had flux2-vae (128ch) against a 16ch Z-Image latent -> both
  dataset_zimage_turbo.json and dataset_zimage_base.json now use ae.safetensors (.bak beside each).
  Re-ran the failed prompt: success, 28 images.
- Still uncommitted, still 0.0.5.

## 2026-08-13 20:05 -- batch ETA + Flux.2 attention benchmark

- **Batch ETA shipped in the card.** Legend row is now Elapsed / ETA / Batch ETA / Rate. ETA stays
  per-image; Batch ETA covers every remaining item. Per-item cost is MEASURED (bar restart to bar
  restart, so it includes decode + save + model shuffle), median of last 8, falling back to
  maxSteps/rate only until the first item completes. Null -> slot hidden unless the relay supplied
  the item total, same honesty rule as the batch counter.
- SCOPE LIMIT, deliberate: covers the current NODE's remaining items. ComfyUI runs a list-expanded
  graph node by node (28 samples, THEN 28 decodes), so a later stage is not in the figure and it
  reads slightly short near the end of sampling. Hence "Batch ETA", not "Job ETA".
- setJobEta hides the .jc-legend WRAPPER, not the value span -- legendValue() nests the value inside
  a wrapper that also holds the label, so hiding the span strands the label.
- New consts: ITEM_SAMPLES_KEPT = 8; _itemDurations resets everywhere _batchTotals resets.
- 4 test files pass, incl. a new case for null-without-total, the fallback, and the switch to
  measured timing once an item completes.
- Still uncommitted, still 0.0.5. 16 modified + several untracked mock html files.

Outside this repo, same session (context for whoever picks it up):
- **Flux.2 Klein bf16 + 2 reference images was faulting** in comfy_aimdo (`Fault failed: 2`).
  FIX = `--disable-dynamic-vram` on New Main (already in Comfy Desktop's installations.json).
  NOT pinned memory, NOT the 0.33.1 update, NOT the NVIDIA sysmem-fallback policy -- all tested and
  eliminated. See memory project-h3-comfy-aimdo-crash for the elimination table.
- Attention benchmark on the 5070 Ti (Flux.2 Klein 9B bf16, 6 steps, 896x1152, 2 refs, 2 runs each
  after a discarded warm-up): pytorch 17.75s, sage 13.85s, comfy-kitchen 13.81s. Sage and CK are a
  dead heat (0.3% apart, ~1.28x over baseline). Same-seed pixel diff vs pytorch: 35-49 dB PSNR.
- NEW MAIN WAS LEFT STOPPED at session end (benchmark owned port 8188). Restart it from the Comfy
  Desktop app. Stimma-5060Ti on 8189 is a separate install and was never touched.
- Known broken, pre-existing: ComfyUI-TeaCache fails to import on 0.33.1
  (`precompute_freqs_cis` gone from comfy.ldm.lightricks.model). ~20 saved workflow JSONs fail a
  startup scan with cp1252 UnicodeDecodeError (scanner opens them without encoding='utf-8').

## 2026-08-13 20:20 -- note for the skin session

If you are working on new skins, read this first -- the card gained an element tonight:

- **New legend slot `.jc-jobeta` ("Batch ETA")**, sitting between `.jc-eta` and `.jc-rate`. Same
  structure as its neighbours: a `.jc-legend` wrapper holding `.jc-legend-label` +
  `.jc-legend-value .jc-jobeta`.
- **`styles/skins.css` was NOT touched** -- it inherits generic `.jc-legend-value` styling in both
  skins. If it needs per-skin treatment, that is unwritten work, not a regression.
- **The legend row is now 3 OR 4 items wide.** `setJobEta()` hides the whole wrapper on any job with
  no batch total (single-image jobs, and any run where the relay did not report one), so a skin must
  look right at both counts -- do not style the row by fixed position or assume a count.
- Nothing else in the card DOM changed.

## 2026-08-13 21:41 -- skin session (Obsidian Halo + reactor-panel design)

- SHIPPED IN-TREE: third skin **Obsidian Halo** (`body.skin-halo`), all styling in `styles/skins.css`.
  Registered in `renderer/renderer.js` (SKINS array) and `renderer/index.html` (one <option>).
- `renderer/widgets/lcd.js`: `createRateMeter()` now also emits `.meter-arc-track` + `.meter-arc-value`
  (two paths on the tick circle) and drives the value path from `state.apply()`. Every skin gets them;
  `styles/skins.css` hides both by default and only skin-halo paints them. No behaviour change to the
  needle, ballistics or honesty rules. NOT job-card.js -- that file is untouched by me.
- `styles/main.css`: ONE line added, `.jc-legend[hidden] { display: none; }`. `setJobEta()` sets
  `.hidden` on the wrapper, but the author rule `.jc-legend { display: flex }` beats the UA
  `[hidden]` rule, so Batch ETA never actually hid -- every non-batch card printed "BATCH ETA --".
  PLEASE KEEP THIS LINE if you rewrite main.css.
- Verified all three skins at 3-item and 4-item legend rows; `.jc-jobeta` needs no per-skin styling.
- DESIGN ONLY, nothing wired: reactor control-panel direction (annunciator bank, twin cluster dials,
  LED bulb banks, split-flap / nixie step counters) lives in new `renderer/mock-*.html` files. It is a
  new CARD WIDGET, not a skin -- see the report to the other session before anyone edits job-card.js.
- Did not commit. Tree left as found plus the above.

## 2026-08-13 21:55 -- correction to my 20:05 / 20:20 entries

- My claim that `.jc-jobeta` "hides itself on non-batch jobs" was FALSE as shipped. `setJobEta()`
  set `.hidden` on the `.jc-legend` wrapper, but the author rule `.jc-legend { display: flex }`
  (main.css:833) beats the UA stylesheet's `[hidden] { display: none }` regardless of specificity,
  so every non-batch card printed a permanent "BATCH ETA --". The skin session found it and added
  `.jc-legend[hidden] { display: none; }` at main.css:844. Verified present; keep that line.
- I asserted the hide worked without ever looking at a rendered card. Treat the behaviour notes in
  my 20:05 entry as reasoned-from-code, not observed.
- Verified after the skin session's changes: 4 test files still pass, and the meter arc paths are
  `display: none` by default in skins.css so rack/glass are unaffected.

## 2026-08-13 21:55 -- skin session, design record before sign-off

Decisions Bryan made tonight on the REACTOR PANEL direction. Nothing below is wired into the app;
it is a scope decision for him. The live record is `renderer/mock-reactor-panel.html` (both idioms,
moving fake data, heavily commented) plus `mock-step-counter.html` (the counter comparison).

- TWO IDIOMS, ONE LAYOUT: `pan--room` (1960s painted steel, ivory faces, incandescent lamps) and
  `pan--console` (glass + xenon). Same DOM, per-idiom CSS.
- ANNUNCIATOR BANK, 8 tiles in 2 rows of 4: Reactor Run / Queued / Batch Run / No Step Data /
  Relay Absent / Cycle Done / Fault / Offline. Every one is a REAL collector condition; unlit means
  "not true", never "no room left". A tile flashes 3x on first becoming true, then holds.
  `relay: false` is the only snapshot field today's card ignores.
- TWIN RATE DIALS, one movement per half of the log scale, split at 1:1 for sampling and at 6 s/it
  (coarse/fine) for training. Pivot on the vertical centreline, each quadrant 90 degrees centred on
  the horizontal. Two facings built and switchable in the mock (`#facing-select`): 'out' = pivots
  inboard, arcs to the outer edges (back to back); 'in' = pivots outboard, arcs closing on the
  middle. BRYAN HAD NOT PICKED ONE at sign-off.
  - NO NUMBERS on the arcs, like a fuel gauge: ticks, end words (SLOW / 1:1 / FAST), and the exact
    figure printed in the tell-tale column between the two movements.
  - Only the half holding the reading lights; the other rests at its stop at 0.16 opacity.
  - The console needle is a dash-clipped beam -- the dash figures are tied to the needle LENGTH, so
    changing the radius without retuning them hides the needle.
- LED BULB BANKS replace the old progress bar entirely (the bar was the same fact in a weaker
  language). Row 1 = step progress, 20 bulbs. Row 2 = workflow, ONE BULB PER IMAGE, and it exists
  only when the relay reported a batch total, so the socket count is itself measured. `Step X/Y . %`
  moved onto row 1. P1 bulbs are amber domes in chromed collars in a punched strip, with a filament,
  a specular pip, out-of-phase mains flicker and a strike (dim -> overshoot -> settle); P2 are
  rounded-square emitters with an instant snap.
- STEP COUNTER, Bryan's pick: SPLIT-FLAP in the control room, NIXIE in the console. Fixed width
  (4 digits for a trainer, 2 for a sampler), LEADING ZEROS -- a mechanical counter always shows
  something. No step data still blanks the mechanism and prints N/A; zeros never mean "unknown".
  Nixie draws all ten cathodes with the unlit ones faintly visible at slightly different depths --
  that ghosting is why a nixie cannot be done with a font.
- ALSO HELD, not dead: "alpha cluster" full-card layout in `mock-card-redesign.html` (two glass
  domes + fact grid), which Bryan liked before the reactor idea arrived.
- Rate recorder (60 s strip chart), 4 digital counters and the identity plate round out the panel.
  Cost: ~490px tall per host. A compact variant would drop the recorder and keep the annunciators.

Working tree at sign-off: unchanged from the other session's state plus my skin work. Nothing
committed. `npm test` 4/4 green.

## 2026-08-13 22:00 -- skin session, dial facing decided

Correction to my 21:55 entry: Bryan HAS now picked the twin-dial facing. It is **'in'** — pivots at
the outer edges, both arcs closing toward the middle around the readout. `mock-reactor-panel.html`
now defaults to it (`let FACING = 'in'`); 'out' stays in the selector for comparison only.

## 2026-08-14 11:35 -- reactor panel BUILT (session: opus/CLI)

- The reactor-panel design from last night is now REAL CODE, not a mock. New files:
  `renderer/widgets/reactor-panel.js` + `styles/reactor.css`. Nothing else on the panel was
  invented -- it follows the 21:55 and 22:00 design entries item for item (annunciator bank,
  twin dials facing 'in', no numbers on the arcs, split-flap in the room idiom / nixie in the
  console one, LED bulb banks replacing the bar, 60s rate recorder, 4 counters, identity plate).
- IT IS A SECOND CARD WIDGET, NOT A SKIN. `renderer.js` now holds a `WIDGETS` map and rebuilds a
  card only when its widget FAMILY changes; skins, filter, size and rack order still never rebuild.
  Both idioms sit in the existing skin dropdown ("Control Room", "Reactor Console"), same
  localStorage key. `job-card.js` is UNTOUCHED.
- Shared-code edits, both additive: `lcd.js` exports `createNeedle()` (panels put their 3 pointers
  on the ONE rAF loop) and `faceSpec()` (the panel graduates off the same hand-written tables, so
  the Dials range setting still governs). `main.css` kind-filter selector generalised from
  `.job-card[data-kind=...]` to `#cards > [data-kind=...]` -- one line, both widgets.
- `renderer/mock-skins.html` now covers all five looks and dispatches like renderer.js does. It is
  the surface to judge this on: `npx http-server . -p 8791`, then /renderer/mock-skins.html.
- Verified in the REAL app (playwright _electron, both idioms, live New Main job: Flux2-Klein,
  rate 6.11 s/it, steps 0/6, relay active) and across all 8 states in the mock. Two bugs found by
  looking and fixed: an empty step mechanism collapsed the N/A window on an idle host, and the
  progress movement's hub painted over its own legend (SVG now clipped).
- Panel is ~545px tall per host at Normal, so reactor.css raises --card-min to 480/540/660 per size
  class. The COMPACT VARIANT (drop the recorder) discussed last night is NOT built.
- `npm test` 4/4 green (renderer widgets have no test harness in this repo -- verification is by
  eye, as usual here). Version still 0.0.5, nothing committed, nothing released.

## 2026-08-14 15:30 -- reactor panel: real-estate pass + the recorder now reads

Bryan's feedback on the shipped panel: loves the look, wants the space used better, and could not
interpret the rate recorder. Both addressed, verified in the mock and the real app:

- STEPS LEFT no longer sits alone in a dial-height well. The instrument row's third column is now a
  STACK: step counter over the four digital counters (ETA / Elapsed / Batch ETA or Loss / Queue),
  which deletes the old full-width counters row entirely.
- Annunciators go 8-across (4x2 only below ~620px of panel content); identity plate is one row.
- **Instruments are capped** (`max-height` on the dial + progress SVGs, fixed 58px recorder strip).
  Before this the panel got TALLER the wider the window was, because every SVG was width:100%.
- Recorder is labelled: scale ends down the left edge in the dial's own units, dashed 1:1 line where
  the face spans it, and the caption states the time axis (`60 s ago -> now`). Labels are HTML over
  the SVG, never SVG <text> -- the plot is preserveAspectRatio="none" and text would smear.
- Net: running panel 545px -> ~500px at 618 wide, and no longer inflates with window width.
- Files touched: `renderer/widgets/reactor-panel.js`, `styles/reactor.css`, CLAUDE.md. Nothing else,
  and no collector or honesty rule changed. `npm test` 4/4. Still 0.0.5, still uncommitted.

## 2026-08-14 18:20 -- reactor panel: build-info windows (ComfyUI/PyTorch/CUDA/driver)

- Bryan asked for the four windows under STEPS LEFT to show the host's build instead of job figures.
  Done for `comfyui` panels: ComfyUI / PyTorch / CUDA / NVIDIA driver, in plate ink (facts, not
  readings). A window with no value is REMOVED, not dashed. `aitoolkit` panels keep ETA / Elapsed /
  Loss / Queue there -- no trainer endpoint reports versions.
- The live figures those windows held are NOT lost: new one-line tell-tale strip under the bulb
  banks (Elapsed / ETA / Batch ETA / Queue) on generation panels, ~18px vs the 83px of windows.
- Collector: `comfyui-client.js` probes `/system_stats` on connect + every 5 min and emits
  `snapshot.versions`. CUDA comes off the torch build tag (2.13.0+cu130 -> 13.0). `parseSystemStats`
  is exported and unit-tested against New Main's real payload (test/comfyui-client.test.js).
- **DRIVER NEEDS A RELAY UPDATE.** No ComfyUI endpoint reports the NVIDIA driver and no installed
  node pack exposes it (Crystools' /crystools/monitor/GPU is index+name only). So
  `comfyui-relay/__init__.py` gained a `GET /watcher/host_info` route (pynvml, falling back to
  nvidia-smi, cached). The copies in D:\ComfyUI_Installs\{New Main,Secondary} are the OLD relay, so
  the driver window is currently hidden in the real app -- re-copy the folder into both
  custom_nodes\comfyui-watcher-relay\ AND restart ComfyUI to light it up. Not done: writing to those
  installs needs Bryan's approval and a restart would interrupt his queue.
- Also fixed: fmtSec printed "3m60s" at 239.6s. Same bug existed in job-card.js; fixed in both.
- Verified in the real app (COMFYUI 0.33.1 / PYTORCH 2.13.0 / CUDA 13.0 read live, driver window
  correctly absent) and across all 8 mock states. `npm test` 4/4. Still 0.0.5, still uncommitted.

## 2026-08-14 18:35 -- relay copied to both installs (restart pending)

- With Bryan's approval, `comfyui-relay/__init__.py` (124 lines, with /watcher/host_info) copied over
  D:\ComfyUI_Installs\{New Main,Secondary}\ComfyUI\custom_nodes\comfyui-watcher-relay\. Hashes match
  the repo copy. NOT restarted -- his call. The DRIVER window lights on the next ComfyUI restart of
  each instance; the watcher re-probes on WS reconnect, so no action needed in the widget.

## 2026-08-14 19:10 -- accelerator auto-detect (CUDA / ROCm) + window order

- The third build-info window now NAMES ITSELF: CUDA 13.0 on an NVIDIA box, ROCm 6.2 on an AMD one,
  XPU / CPU where that is what the build is. `detectAccelerator()` in comfyui-client.js reads the
  torch build tag, because that is the only reliable tell -- ROCm's PyTorch reports torch.cuda,
  device.type 'cuda' and a 'cuda:0' device name, so /system_stats otherwise looks identical on both
  stacks. Untagged build => match the card name, report the stack with a NULL version (panel prints
  "Backend / ROCm"; a name never yields a version).
- Windows reordered at Bryan's request: ComfyUI | Driver on top, PyTorch | CUDA under them.
  COMFY_WINDOWS order IS the layout.
- Relay now probes both vendors for the driver, ordered by torch.version.hip: pynvml/nvidia-smi for
  NVIDIA, /sys/module/amdgpu/version then rocm-smi for AMD. **Re-copied to both installs again**
  (hashes match) -- still needs a ComfyUI restart to load, same as before.
- ROCm is covered by unit tests against synthetic /system_stats payloads only. There is no AMD box
  on this rack, so nothing on that path has been seen running.
- `npm test` 4/4 (comfyui-client.test.js now pins CUDA, ROCm, untagged-with-AMD-name, CPU, XPU and
  the nothing-to-go-on case). Verified in the real app and in the mock, which now carries a ROCm
  host and a no-version host. Still 0.0.5, still uncommitted.

## 2026-08-14 20:00 -- v0.0.6 SHIPPED (reactor panel)

- Version bumped 0.0.5 -> 0.0.6. Everything uncommitted since v0.0.5 goes out in one commit: rack
  order/drag, hide-a-host, SIZE zoom, dial ranges + training face, batch counter + batch ETA, the
  batch-rate fix, Obsidian Halo, the reactor panel (both idioms), build-info windows with CUDA/ROCm
  auto-detect, and the relay's /watcher/host_info route.
- Windows installer built and VERIFIED BY RUNNING IT (not by exit code): dist/win-unpacked launched
  under the playwright driver, Control Room look, live New Main panel showing a real finished job
  (CYCLE DONE, 175/175, minimax_h3) and the build windows reading 0.33.1 / 2.13.0 / CUDA 13.0. Zero
  console errors. asar confirmed to contain renderer/widgets/reactor-panel.js + styles/reactor.css
  and NOT the mocks; resources/comfyui-relay/__init__.py carries host_info + the amdgpu path.
- Linux AppImage + deb built in WSL (~/cw-build) and copied into dist/.
- The mock-*.html files are now COMMITTED as the design record / judging surface. They are excluded
  from the packaged build by the existing "!renderer/mock-*.html" glob.
- Released: https://github.com/an80sPWNstar/ComfyUIWatcher/releases/tag/v0.0.6 with all three
  installers attached (exe 78.6MB, AppImage 107.6MB, deb 74.5MB). Commit 3d99385 pushed to main.

## 2026-08-14 (session close) -- state at sign-off

- main = ebe944e, clean tree, pushed. v0.0.6 released with all three installers.
- App left running from source (node_modules electron), Reactor Console look.
- OPEN, nothing blocking: (1) restart both ComfyUI instances to load the updated relay -- the copies
  in D:\ComfyUI_Installs are current on disk but the running processes still have the old module, so
  the DRIVER window shows 3 of 4 build windows until then; (2) ROCm detection is unit-tested only,
  there is no AMD box on this rack to prove it against; (3) the compact reactor variant (drop the
  recorder) was discussed and deliberately not built.
- Not started, still the standing backlog: window state persistence + tray, a UI for EDITING a host
  (only add/remove/hide/reorder exist), and other trainers (Musubi needs log tailing, no job API).
