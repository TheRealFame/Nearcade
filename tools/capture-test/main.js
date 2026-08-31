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

  win.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then(sources => {
      sendLog('Intercepted getDisplayMedia. Pending ID: ' + selectedSourceId);
      if (selectedSourceId) {
        const match = sources.find(s => s.id === selectedSourceId);
        if (match) {
          sendLog('Match found! Passing to callback: ' + match.name);
          if (process.platform === 'win32') {
            if (match.id.startsWith('window:')) callback({ video: match });
            else callback({ video: match, audio: 'loopback' });
          } else {
            callback({ video: match });
          }
        } else {
          sendLog('Match NOT found. Falling back to screen.');
          const screen = sources.find(s => s.id.startsWith('screen:'));
          if (process.platform === 'win32') {
            callback({ video: screen, audio: 'loopback' });
          } else {
            callback({ video: screen });
          }
        }
      } else {
        if (process.platform === 'win32') {
          callback({ video: sources[0], audio: 'loopback' });
        } else {
          callback({ video: sources[0] });
        }
      }
    });
  });
});
