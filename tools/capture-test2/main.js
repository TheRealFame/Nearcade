const { app, BrowserWindow, desktopCapturer, ipcMain } = require('electron');
const path = require('path');

app.commandLine.appendSwitch('enable-features', 'WinrtScreenCapture');

let win;
let selectedSourceId = null;

function sendLog(msg) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('main-log', msg);
  }
}

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  win.loadFile('index.html');

  ipcMain.handle('get-sources', async () => {
    const sources = await desktopCapturer.getSources({ types: ['window', 'screen'] });
    return sources.map(s => ({ id: s.id, name: s.name }));
  });

  ipcMain.on('set-source', (e, id) => {
    selectedSourceId = id;
    sendLog('Main process received selected source ID: ' + id);
  });

  // setDisplayMediaRequestHandler removed for testing native portal
});
