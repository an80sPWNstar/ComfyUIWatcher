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
    // Stop clients for hosts no longer configured — and for hosts whose kind changed, since the
    // collector class itself is then wrong (editing a host in place keeps its name).
    for (const [name, client] of this.clients) {
      const host = byName.get(name);
      if (!host || (host.kind ?? 'comfyui') !== this.kinds.get(name)) {
        client.stop();
        this.clients.delete(name);
        this.kinds.delete(name);
        delete this.latest[name];
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
