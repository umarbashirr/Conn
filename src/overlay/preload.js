'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('connOverlay', {
  take: () => ipcRenderer.send('overlay:take'),
  onState: (cb) => ipcRenderer.on('overlay:state', (_e, state) => cb(state)),
});
