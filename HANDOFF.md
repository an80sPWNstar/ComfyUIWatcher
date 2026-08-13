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
