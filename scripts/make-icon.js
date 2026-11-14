// Renders every icon Conn ships, with Electron itself, so the repo needs no
// image tooling. Run: npx electron scripts/make-icon.js (xvfb-run is fine).
//
// One look everywhere, the site's: the ink prompt and the orange node on warm
// paper (site/styles.css --ink, --accent, --paper). The geometry is shared with
// the title bar and the site through src/shared/conn-mark.js.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const { VIEW, MARK, NODE } = require('../src/shared/conn-mark');

const INK = '#15140f';
const ACCENT = '#ff5a1f';
const PAPER = '#f5f2ea';
const STROKE = 2.6;
// The mark spans x 3.6 to 21.75, so its middle sits right of the view's.
const MID_X = (3.6 + NODE.cx + NODE.r) / 2;

const mark = ({ ink = INK, node = ACCENT, scale = 1 } = {}) => `
  <g transform="translate(12 12) scale(${scale}) translate(${-MID_X} -12)">
    <path d="${MARK}" fill="none" stroke="${ink}" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${NODE.cx}" cy="${NODE.cy}" r="${NODE.r}" fill="${node}"/>
  </g>`;

const svg = (size, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${VIEW}">${body}</svg>`;

const ROOT = path.join(__dirname, '..');
// A rounded tile for the desktop and the tab icon, where the OS does not shape it.
const tile = `<rect width="24" height="24" rx="5.4" fill="${PAPER}"/>${mark({ scale: 0.78 })}`;
const OUT = [
  ['build/icon.png', 512, tile],
  ['site/favicon.png', 64, tile],
  ['mobile/assets/favicon.png', 48, tile],
  // iOS and the store want a full square; the OS rounds it.
  ['mobile/assets/icon.png', 1024, `<rect width="24" height="24" fill="${PAPER}"/>${mark({ scale: 0.66 })}`],
  // Android masks the adaptive icon to its own shape and keeps only the middle
  // two thirds safe, so the foreground mark is smaller and sits on paper.
  ['mobile/assets/android-icon-background.png', 512, `<rect width="24" height="24" fill="${PAPER}"/>`],
  ['mobile/assets/android-icon-foreground.png', 512, mark({ scale: 0.5 })],
  // Themed icons use only the alpha, so one colour for both parts.
  ['mobile/assets/android-icon-monochrome.png', 432, mark({ ink: '#000', node: '#000', scale: 0.5 })],
  ['mobile/assets/splash-icon.png', 1024, mark({ scale: 0.6 })],
];

async function render(win, size, body) {
  win.setContentSize(size, size);
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    `<html><body style="margin:0;background:transparent;overflow:hidden">${svg(size, body)}</body></html>`,
  ));
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  // A HiDPI display captures at its scale; the files want exact pixels.
  return img.getSize().width === size ? img : img.resize({ width: size, height: size, quality: 'best' });
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024, height: 1024, useContentSize: true, show: false, frame: false, transparent: true,
    webPreferences: { offscreen: true },
  });
  for (const [rel, size, body] of OUT) {
    const img = await render(win, size, body);
    fs.writeFileSync(path.join(ROOT, rel), img.toPNG());
    console.log(`wrote ${rel} (${img.getSize().width}x${img.getSize().height})`);
  }
  app.quit();
});
