const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('comfyuiWatcher', {
  onData: (callback) => {
    ipcRenderer.on('watcher-data', (_event, snapshots) => callback(snapshots));
  },
  getHosts: () => ipcRenderer.invoke('hosts:get'),
  setHosts: (hosts) => ipcRenderer.invoke('hosts:set', hosts),
});
