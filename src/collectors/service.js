// Owns one ComfyUIClient per configured host and forwards snapshots to a single callback.
// Mirrors guiTOP's per-host service loop: one broken host must never affect the others.

const { ComfyUIClient } = require('./comfyui-client');

class WatcherService {
  /**
   * @param {(snapshots: Record<string, object>) => void} onData
   */
  constructor(onData) {
    this.onData = onData;
    this.clients = new Map(); // hostName -> ComfyUIClient
    this.latest = {}; // hostName -> last snapshot
  }

  setHosts(hosts) {
    const wanted = new Set(hosts.map((h) => h.name));
    // Stop clients for hosts no longer configured.
    for (const [name, client] of this.clients) {
      if (!wanted.has(name)) {
        client.stop();
        this.clients.delete(name);
        delete this.latest[name];
      }
    }
    // Start clients for newly configured hosts.
    for (const host of hosts) {
      if (!this.clients.has(host.name)) {
        const client = new ComfyUIClient(host, (name, snapshot) => {
          this.latest[name] = snapshot;
          this.onData({ ...this.latest });
        });
        this.clients.set(host.name, client);
        client.start();
      }
    }
  }

  stopAll() {
    for (const client of this.clients.values()) client.stop();
    this.clients.clear();
    this.latest = {};
  }
}

module.exports = { WatcherService };
