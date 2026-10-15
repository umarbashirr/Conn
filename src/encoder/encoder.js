'use strict';
const bus = window.encoder;

let canvas;
let ctx;
let track;
let recorder;
let mime;
let bitmap;
let decoding = Promise.resolve();
const chunks = [];

// H.264 cannot code an odd width or height.
const even = (n) => Math.max(2, n - (n % 2));
const decode = (bytes) => createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));

function draw() {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const k = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
  const w = Math.round(bitmap.width * k);
  const h = Math.round(bitmap.height * k);
  ctx.drawImage(bitmap, Math.floor((canvas.width - w) / 2), Math.floor((canvas.height - h) / 2), w, h);
}

const guarded = (fn) => async (payload) => {
  try { await fn(payload); } catch (e) { bus.fail((e && e.message) || e); }
};

bus.on('init', guarded(async ({ mimes, frame }) => {
  bitmap = await decode(frame);
  // The encoder takes a picture this small and then never finishes.
  if (bitmap.width < 16 || bitmap.height < 16) throw new Error(`the preview is ${bitmap.width}x${bitmap.height}, too small to record`);
  canvas = document.createElement('canvas');
  canvas.width = even(bitmap.width);
  canvas.height = even(bitmap.height);
  ctx = canvas.getContext('2d', { alpha: false });
  mime = mimes.find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) throw new Error('this build of Electron cannot encode video');
  const stream = canvas.captureStream(0);
  track = stream.getVideoTracks()[0];
  recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  draw();
  recorder.start();
  track.requestFrame();
  await bus.ready({ mime, width: canvas.width, height: canvas.height });
}));

bus.on('frame', (bytes) => {
  decoding = decode(bytes).then((b) => { bitmap = b; }, () => {});
});

bus.on('tick', guarded(async () => {
  await decoding;
  draw();
  track.requestFrame();
}));

bus.on('stop', guarded(async () => {
  await decoding;
  draw();
  track.requestFrame();
  const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
  recorder.stop();
  await stopped;
  const blob = new Blob(chunks, { type: mime });
  await bus.done({ bytes: new Uint8Array(await blob.arrayBuffer()), mime });
}));
