const { app, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const hostsConfig = require('./src/config/hosts');
const { WatcherService } = require('./src/collectors/service');

// The relay custom node ships as an extraResource, NOT inside the asar: the whole point is that
// the user copies this folder into ComfyUI/custom_nodes, and you cannot copy a file out of an
// archive with Explorer. Packaged it lands in resources/comfyui-relay; in dev it is just the
// folder in the repo.
function relayDir() {
  const packaged = path.join(process.resourcesPath || '', 'comfyui-relay');
  if (app.isPackaged || fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, 'comfyui-relay');
}

// The name ComfyUI will show in its log, and the folder name the instructions tell people to use.
const RELAY_FOLDER_NAME = 'comfyui-watcher-relay';

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

ipcMain.handle('relay:info', () => {
  const dir = relayDir();
  return { dir, folderName: RELAY_FOLDER_NAME, exists: fs.existsSync(dir) };
});

// Opens the folder in Explorer/Finder/the desktop file manager so the copy is a drag, not a
// retyped path. Returns whatever error string the OS gave rather than failing silently.
ipcMain.handle('relay:reveal', async () => {
  const dir = relayDir();
  if (!fs.existsSync(dir)) return { ok: false, error: 'not found: ' + dir };
  const err = await shell.openPath(dir);
  return err ? { ok: false, error: err } : { ok: true };
});

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
