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
