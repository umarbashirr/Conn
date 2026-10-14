'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// All the encoder page can do: hear the three things main tells it, and report
// back. Nothing else of Electron reaches it.
contextBridge.exposeInMainWorld('encoder', {
  on: (kind, cb) => ipcRenderer.on(`encoder:${kind}`, (_e, payload) => cb(payload)),
  ready: (info) => ipcRenderer.invoke('encoder:ready', info),
  done: (result) => ipcRenderer.invoke('encoder:done', result),
  fail: (message) => ipcRenderer.invoke('encoder:fail', String(message)),
});
