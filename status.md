# comfyuiWATCHER — Session Handoff

_Created 2026-08-11. Read this + `CLAUDE.md` once at session start._

## RESUME HERE

**Brand new, never run.** Source is fully written (main.js, preload.js, collectors, renderer,
styles, one test file) but `npm install` has never executed and the app has never opened a window.

**First thing next session:**
1. `npm install` (Electron 31, electron-builder — same versions as guiTOP).
2. `npm start`, point the default host list (New Main `:8188`, Secondary `:8189`) at whichever of
   those is actually running — see [[comfyui-hardware-config]] for current state.
3. **Real smoke test, not assumed:** queue an actual job on one of those instances and confirm the
   `progress`/`executing`/`execution_start`/`execution_success` WS messages arrive in the shape
   `CLAUDE.md` documents. Only the `status` and `crystools.monitor` shapes were checked against a
   live server this session (via a throwaway `node -e "new WebSocket(...)"` probe, no job running)
   — the step-progress messages that the whole point of this app depends on are still an assumption
   borrowed from ComfyUI's public protocol, not something this codebase has watched fire yet.

**Written but unverified end-to-end:**
- `src/collectors/comfyui-client.js` — WS client, reconnect w/ backoff, step-rate/ETA estimation.
  Pure logic (`_estimateStepsPerSec`, the finished/not-finished branch of `_onExecuting`) is unit
  tested and passes reliably (`node test/comfyui-client.test.js`, reran 5x clean). The WS message
  handling around it has never seen a real message from a real running job.
- `src/collectors/service.js` — per-host client lifecycle, add/remove on host-list change. Never
  exercised with more than the two default hosts, never exercised with a host actually going
  offline mid-session (the reconnect backoff path is unverified).
- `renderer/` — plain-JS, no bundler, widgets on `window.Widgets`. Never rendered in an actual
  Electron window; CSS is a first guess at "readable dark dashboard," not iterated against a
  screenshot.
- `main.js` IPC handlers `hosts:get`/`hosts:set` exist; nothing in the renderer calls them yet —
  there is no host-management UI, only the two hardcoded defaults.

## Why This Exists

Built the same night as a long MiniMax H3 video-generation session (see [[project-minimax-h3-lora]],
[[project-minimax-h3-attention-setup]], [[project-h3-wifey-character-conventions]]) where the user
kept having to manually poll `/queue` and `/history` via curl to know whether a render was still
running, how far along it was, or whether the box had silently crashed (which it did, twice, on
two different GPUs, that same night — see the crash notes in
[[project-h3-wifey-character-conventions]]). The ask: "a widget that links with any comfyui
instances and shows the steps, speed, time spent and time remaining," explicitly modeled on
[[guiTOP]] (which itself evolved from [[tempsLCD-web]]'s pattern) rather than built from scratch.

## Design Decisions Worth Remembering
- **No SSH, unlike guiTOP.** guiTOP needs `ssh2` because `nvidia-smi` is a local shell command with
  no network story of its own. ComfyUI already listens on the network when launched with
  `--listen 0.0.0.0` (which both New Main and Secondary are), so a "remote host" here is just a
  different URL, not a different transport. This is a real simplification, not a corner cut.
- **WebSocket, not polling.** ComfyUI's REST API (`/queue`, `/history`) has no per-step progress
  field — only the WS `progress` message does. A polling-only design (which is what every one-off
  submit script from tonight's H3 session used) cannot show live step/speed at all, only
  before/after state. This is the actual reason this project needs a different data-source
  pattern than guiTOP's poll loop, not a stylistic choice.
- **Rolling 15s window for the rate estimate, not an all-session average.** A job's first few steps
  are frequently unrepresentative once caching techniques are involved (see the EasyCache findings
  from the same night) — the estimator should reflect "how fast is it going right now," matching
  what a user actually wants from an ETA.

## Open Questions For Next Session
- Does `crystools.monitor` exist on Secondary too, or only on New Main? Only checked New Main live.
- What does a `progress` message actually look like when EasyCache or Sol-Attn are active and
  skipping steps — does `value` still increment monotonically, or can it jump/skip in a way the
  rolling-window estimator would mishandle? Untested; both those nodes exist in this same user's
  H3 workflows.
- Multi-host layout: right now `renderer.js` just stacks cards in a CSS grid. guiTOP has a
  Single/Multi tab distinction for exactly this — worth porting that pattern once there's more
  than 2 hosts to actually look at.

## Disk Layout
- **Source**: `E:\vs_code_projects\comfyuiWATCHER\`
- **Git**: initialized locally this session, **no commits yet, no remote** — ask before pushing
  anywhere, same as every other project's convention here.
- **Sibling/template projects**: [[guiTOP]] at `E:\vs_code_projects\guiTOP\` (primary
  architectural template), [[tempsLCD-web]] at `E:\vs_code_projects\tempsLCD-web\` (the earlier
  Electron-widget pattern guiTOP itself evolved from).
