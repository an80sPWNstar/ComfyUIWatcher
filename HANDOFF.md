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
