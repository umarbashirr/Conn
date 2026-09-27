'use strict';
// Proves Conn's own speech model can hear a known recording.
// Run with the Electron binary, because the model loader uses app.getPath.
const { app } = require('electron');
const fs = require('fs');

const SAMPLE = 'https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav';

// The published sample is 44.1 kHz stereo. The microphone records 16 kHz mono,
// so this brings the sample to that shape before the model sees it.
function samplesFromWav(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a wav');
  let offset = 12;
  let rate = 0;
  let channels = 0;
  let bits = 0;
  let data = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (id === 'fmt ') {
      channels = view.getUint16(start + 2, true);
      rate = view.getUint32(start + 4, true);
      bits = view.getUint16(start + 14, true);
    } else if (id === 'data') {
      data = buf.subarray(start, start + size);
    }
    offset = start + size + (size % 2);
  }
  if (!data || bits !== 16 || !rate || !channels) throw new Error(`unsupported wav ${rate} Hz ${channels} ch ${bits} bit`);
  const pcm = new Int16Array(data.buffer, data.byteOffset, Math.floor(data.length / 2));
  const frames = Math.floor(pcm.length / channels);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) sum += pcm[i * channels + c];
    mono[i] = sum / channels / 32768;
  }
  const outLen = Math.round(frames * 16000 / rate);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const src = i * rate / 16000;
    const i0 = Math.floor(src);
    const frac = src - i0;
    const a = mono[i0] || 0;
    const b = mono[Math.min(i0 + 1, frames - 1)] || a;
    out[i] = Math.max(-32768, Math.min(32767, Math.round((a * (1 - frac) + b * frac) * 32768)));
  }
  return out;
}

app.whenReady().then(async () => {
  const builtin = require('../src/main/builtin-speech');
  const file = '/tmp/conn-jfk.wav';
  if (!fs.existsSync(file)) {
    const res = await fetch(SAMPLE);
    if (!res.ok) throw new Error(`sample download ${res.status}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  const text = await builtin.transcribe(samplesFromWav(fs.readFileSync(file)));
  const ok = /country/i.test(text);
  console.log(JSON.stringify({ ok, text }));
  app.exit(ok ? 0 : 1);
}).catch((err) => {
  console.error(err);
  app.exit(1);
});
