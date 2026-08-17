// Host list: { name, url, kind, hidden?, token? } where url is a bare http(s) origin, e.g.
//
// The ARRAY ORDER IS THE RACK ORDER — the renderer lays cards out by it, and drag-reordering a
// card rewrites this file. So save() must preserve order exactly and never sort.
// `hidden: true` keeps an entry but stops watching it (no collector, no card); see validate().
// "http://127.0.0.1:8188". No SSH needed here (unlike guiTOP) — both ComfyUI and ai-toolkit's UI
// already listen on the network directly, so a remote host is just a different origin.
//
// `kind` selects the collector (see collectors/index.js): "comfyui" watches a generation server,
// "aitoolkit" watches a LoRA trainer. It defaults to "comfyui" so a hosts.json written by an
// earlier version keeps working untouched.
// `token` is only used by aitoolkit hosts, and only when that UI was started with
// AI_TOOLKIT_AUTH set.

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

function configPath() {
  return path.join(app.getPath('userData'), 'hosts.json');
}

const KINDS = ['comfyui', 'aitoolkit'];

const DEFAULT_HOSTS = [
  { name: 'New Main', url: 'http://127.0.0.1:8188', kind: 'comfyui' },
  { name: 'Secondary', url: 'http://127.0.0.1:8189', kind: 'comfyui' },
  // ai-toolkit's UI server, default port from its own package.json start script.
  { name: 'AI-Toolkit', url: 'http://127.0.0.1:8675', kind: 'aitoolkit' },
];

function normalizeUrl(url) {
  return String(url).trim().replace(/\/+$/, '');
}

function validate(hosts) {
  if (!Array.isArray(hosts)) return DEFAULT_HOSTS;
  const out = [];
  for (const h of hosts) {
    if (!h || typeof h.url !== 'string') continue;
    let url;
    try {
      url = new URL(normalizeUrl(h.url));
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    // Names must be unique — WatcherService keys clients by name and the renderer keys cards
    // by name, so a duplicate would silently collapse two hosts into one.
    let name = String(h.name || url.host);
    const taken = new Set(out.map((o) => o.name));
    if (taken.has(name)) {
      let i = 2;
      while (taken.has(`${name} (${i})`)) i++;
      name = `${name} (${i})`;
    }
    // An unrecognised kind falls back to comfyui rather than dropping the host: a typo in
    // hosts.json should not silently make a server disappear from the rack.
    const kind = KINDS.includes(h.kind) ? h.kind : 'comfyui';
    const entry = { name, url: normalizeUrl(h.url), kind };
    if (typeof h.token === 'string' && h.token) entry.token = h.token;
    // Hidden = "keep the entry, stop watching it". A machine that is switched off for weeks
    // should not cost a card in the rack or a reconnect loop, and removing it would lose the URL.
    // Only ever written true; a visible host carries no flag, so hosts.json stays readable.
    if (h.hidden === true) entry.hidden = true;
    out.push(entry);
  }
  return out.length ? out : DEFAULT_HOSTS;
}

function load() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    return validate(JSON.parse(raw));
  } catch {
    return DEFAULT_HOSTS;
  }
}

function save(hosts) {
  const validated = validate(hosts);
  // Write-then-rename, so a crash mid-write cannot leave a half-written hosts.json — load() treats
  // an unparseable file as "no config" and would silently reset the whole rack to the defaults.
  const file = configPath();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(validated, null, 2));
  fs.renameSync(tmp, file);
  return validated;
}

module.exports = { load, save, validate, DEFAULT_HOSTS, KINDS };
