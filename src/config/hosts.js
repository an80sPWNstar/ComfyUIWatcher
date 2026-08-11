// Host list: { name, url } where url is a bare http(s) origin, e.g. "http://127.0.0.1:8188".
// No SSH needed here (unlike guiTOP) — ComfyUI already listens on the network directly when
// launched with --listen 0.0.0.0, so a remote host is just a different origin to fetch/connect to.

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

function configPath() {
  return path.join(app.getPath('userData'), 'hosts.json');
}

const DEFAULT_HOSTS = [
  { name: 'New Main', url: 'http://127.0.0.1:8188' },
  { name: 'Secondary', url: 'http://127.0.0.1:8189' },
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
    out.push({ name, url: normalizeUrl(h.url) });
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
  fs.writeFileSync(configPath(), JSON.stringify(validated, null, 2));
  return validated;
}

module.exports = { load, save, validate, DEFAULT_HOSTS };
