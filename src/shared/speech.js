'use strict';
// The one audio shape that crosses IPC: mono signed 16-bit PCM at SPEECH_RATE.
// The renderer records to it and main re-checks it, so both read these.

const SPEECH_RATE = 16000;
const MAX_SECONDS = 300;
// Shorter than this is a mis-click, not speech.
const MIN_SECONDS = 0.3;

module.exports = { SPEECH_RATE, MAX_SECONDS, MIN_SECONDS };
