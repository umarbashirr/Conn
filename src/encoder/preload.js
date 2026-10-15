'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('encoder', {
  on: (kind, cb) => ipcRenderer.on(`encoder:${kind}`, (_e, payload) => cb(payload)),
  ready: (info) => ipcRenderer.invoke('encoder:ready', info),
  done: (result) => ipcRenderer.invoke('encoder:done', result),
  fail: (message) => ipcRenderer.invoke('encoder:fail', String(message)),
});
