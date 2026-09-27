'use strict';
// Conn's own speech model. Whisper tiny, English, run in this process.
// The weights are downloaded once into the app's user data and reused.
// A custom dictation command, when set, replaces this. See dictation.js.
const path = require('path');
const { app } = require('electron');

const MODEL = 'Xenova/whisper-tiny.en';

let pending;

function warm() {
  pending ||= load();
  return pending;
}

async function load() {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = path.join(app.getPath('userData'), 'speech');
  return pipeline('automatic-speech-recognition', MODEL, { dtype: 'q8' });
}

// samples is 16 kHz mono Int16, the same shape the microphone records.
async function transcribe(samples) {
  const transcriber = await warm();
  const audio = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) audio[i] = samples[i] / 32768;
  const out = await transcriber(audio);
  return typeof out?.text === 'string' ? out.text.trim() : '';
}

module.exports = { warm, transcribe, MODEL };
