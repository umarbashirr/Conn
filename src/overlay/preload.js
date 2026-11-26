'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('connOverlay', {
  take: () => ipcRenderer.send('overlay:take'),
  handBack: () => ipcRenderer.send('overlay:handBack'),
  onState: (cb) => ipcRenderer.on('overlay:state', (_e, state) => cb(state)),
});
