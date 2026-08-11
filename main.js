const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const hostsConfig = require('./src/config/hosts');
const { WatcherService } = require('./src/collectors/service');

let mainWindow = null;
let service = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 640,
    minWidth: 320,
    minHeight: 200,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  service = new WatcherService((snapshots) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('watcher-data', snapshots);
    }
  });
  service.setHosts(hostsConfig.load());

  mainWindow.on('closed', () => {
    if (service) service.stopAll();
    mainWindow = null;
  });
}

ipcMain.handle('hosts:get', () => hostsConfig.load());
ipcMain.handle('hosts:set', (_event, hosts) => {
  const saved = hostsConfig.save(hosts);
  if (service) service.setHosts(saved);
  return saved;
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (service) service.stopAll();
  app.quit();
});
