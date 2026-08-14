// Owns one collector per configured host and forwards snapshots to a single callback.
// Mirrors guiTOP's per-host service loop: one broken host must never affect the others.
// Which collector a host gets is decided by its `kind` — see collectors/index.js.

const { createCollector } = require('./index');

class WatcherService {
  /**
   * @param {(snapshots: Record<string, object>) => void} onData
   */
  constructor(onData) {
    this.onData = onData;
    this.clients = new Map(); // hostName -> collector instance
    this.kinds = new Map(); // hostName -> kind, so a kind change restarts the right collector
    this.latest = {}; // hostName -> last snapshot
  }

  setHosts(hosts) {
    const byName = new Map(hosts.map((h) => [h.name, h]));
    // Stop clients for hosts no longer configured — and for hosts whose kind or URL changed, since
    // the collector class (or its whole connection) is then wrong. Editing a host in place keeps
    // its name, so name alone cannot decide this.
    for (const [name, client] of this.clients) {
      const host = byName.get(name);
      if (!host || (host.kind ?? 'comfyui') !== this.kinds.get(name) || host.url !== client.host.url) {
        client.stop();
        this.clients.delete(name);
        this.kinds.delete(name);
        delete this.latest[name];
      } else {
        // Same host, same collector — but the ENTRY may have changed in ways that need no restart
        // (its rack position, a token). A collector emits `host: this.host` with every snapshot, so
        // without this the renderer keeps being told the old position and a reorder appears to do
        // nothing for every host that was already running. Found 2026-08-13 by dragging a card in
        // the real app: hosts.json was right, the rack did not move.
        client.host = host;
      }
    }
    // Start clients for newly configured hosts.
    for (const host of hosts) {
      if (!this.clients.has(host.name)) {
        const client = createCollector(host, (name, snapshot) => {
          this.latest[name] = snapshot;
          this.onData({ ...this.latest });
        });
        this.clients.set(host.name, client);
        this.kinds.set(host.name, host.kind ?? 'comfyui');
        client.start();
      }
    }
  }

  stopAll() {
    for (const client of this.clients.values()) client.stop();
    this.clients.clear();
    this.kinds.clear();
    this.latest = {};
  }
}

module.exports = { WatcherService };
