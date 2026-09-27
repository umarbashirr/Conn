// Renders the app icon with Electron itself, so the repo needs no image tooling.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const { VIEW, MARK, NODE } = require('../src/shared/conn-mark');

const SIZE = 512;
const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="${VIEW}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1a2030"/>
      <stop offset="1" stop-color="#0c0e14"/>
    </linearGradient>
    <linearGradient id="ink" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7aa2f7"/>
      <stop offset="1" stop-color="#c4a1ff"/>
    </linearGradient>
  </defs>
  <rect width="24" height="24" rx="5.4" fill="url(#bg)"/>
  <g transform="translate(0.35 0.35) scale(0.97)">
    <g fill="none" stroke="url(#ink)" stroke-width="2.35" stroke-linecap="round" stroke-linejoin="round">
      <path d="${MARK}"/>
    </g>
    <circle cx="${NODE.cx}" cy="${NODE.cy}" r="${NODE.r}" fill="url(#ink)"/>
  </g>
</svg>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE, height: SIZE, show: false, frame: false, transparent: true,
    webPreferences: { offscreen: true },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    `<html><body style="margin:0;background:transparent">${svg}</body></html>`,
  ));
  await new Promise((r) => setTimeout(r, 350));
  const img = await win.webContents.capturePage();
  const out = path.join(__dirname, '..', 'build', 'icon.png');
  fs.writeFileSync(out, img.toPNG());
  console.log(`wrote ${out} (${img.getSize().width}x${img.getSize().height})`);
  app.quit();
});
