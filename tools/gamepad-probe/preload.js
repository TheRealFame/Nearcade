'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('probe', {
  loadConfig: () => ipcRenderer.invoke('probe:load-config'),
  saveLog: (defaultName, content) => ipcRenderer.invoke('probe:save-log', defaultName, content),
  copyText: (text) => ipcRenderer.invoke('probe:copy-text', text)
});
