# comfyuiWATCHER

## What This Is
A Windows desktop widget that connects to any number of ComfyUI instances (local or remote — a
ComfyUI launched with `--listen 0.0.0.0` is just a network address, no SSH needed) and shows live
per-host job state: current node, step X/Y, speed (it/s or s/it), elapsed time, and ETA.

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
│   │   ├── comfyui-client.js        # One WS connection per host, reconnect w/ backoff,
│   │   │                            # derives stepsPerSec/etaSec from a rolling progress window
│   │   └── service.js               # Owns one ComfyUIClient per configured host
│   └── config/
│       └── hosts.js                 # Host list, persisted to userData/hosts.json
├── comfyui-relay/
│   └── __init__.py                  # OPTIONAL ComfyUI custom node: rebroadcasts targeted
│                                    # execution msgs as watcher.* so passive watchers get steps
├── renderer/
│   ├── index.html                   # CSP-locked shell (topbar + gear button)
│   ├── renderer.js                  # Subscribes via onData, creates/updates one card per host
│   └── widgets/
│       ├── job-card.js              # Per-host card: node, progress bar, speed, elapsed, ETA
│       └── settings-panel.js        # Host add/remove UI over hosts:get/hosts:set IPC
├── styles/main.css                  # Dark theme, CSS custom properties for future skinning
└── test/
    ├── run.js                       # No-framework runner, spawns each *.test.js in its own process
    └── comfyui-client.test.js       # Pure logic: step-rate estimation, executing/finished edge cases
```

## Architecture

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
by default) into BOTH installs' `custom_nodes/comfyui-watcher-relay/`. NOT yet loaded**: both
instances were last (re)started before the copy landed. **Unverified until the first restart —
then confirm watcher.progress arrives (queue any job from the web UI, watch a card show step
X/Y) and update this line.** Editing `comfyui-relay/__init__.py` later requires re-copying to
both installs.

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

## Host Config
`src/config/hosts.js` persists `{name, url}[]` to `userData/hosts.json`, defaulting to
`[{name: "New Main", url: "http://127.0.0.1:8188"}, {name: "Secondary", url: "http://127.0.0.1:8189"}]`
— see [[comfyui-hardware-config]] for what's actually running on those ports. `validate()` drops
anything that isn't a well-formed `http(s)` URL rather than crashing on a malformed hosts file.

## Commands
| Command | What |
|---------|------|
| `npm install` | **Beware on this machine:** electron's postinstall "succeeds" (exit 0) but something (AV?) strips everything except `locales/` from `node_modules/electron/dist` when extract-zip writes to E:. Workaround that worked 2026-08-11: `Expand-Archive` the cached zip from `%LOCALAPPDATA%\electron\Cache` to a C: temp dir, copy into `dist`, write `path.txt` containing `electron.exe`. Verify with `Test-Path node_modules/electron/dist/electron.exe`. |
| `npm start` | Run |
| `npm run dev` | Run with DevTools |
| `npm test` | Run `test/*.test.js` (no framework, no deps) |
| `npx electron-builder --dir` | Portable build → `dist/win-unpacked/comfyuiWATCHER.exe` (worked 2026-08-11) |

## Status (2026-08-11, end of second session)
**Working v0.1, verified live.** Launched via playwright-core `_electron` driver against the real
New Main instance: card goes online, a foreign running job appears within 1s (poller), elapsed
ticks, queue count updates live, host add/remove UI works end-to-end (add → third card appears,
remove → gone), packaged exe launches and renders. Tests: 14 assertions incl. poller
reconciliation (`_applyQueue`/`_applyHistory`) and finished-hold. Two real bugs found only by
launching: the Node-20/no-WebSocket failure (see Tech Stack) and the targeted-messages protocol
fact (see WebSocket Message Handling).

**Not built yet / next:**
1. Optional progress-relay custom node for true step X/Y + ETA on foreign jobs (see above).
2. Window state persistence, tray/minimize (guiTOP playbook).
3. NSIS installer (only `--dir` build exercised).
4. `hosts.json` lives in `userData` (`%APPDATA%/comfyuiwatcher`); no UI for reordering hosts.

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
