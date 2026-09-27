// The default microphone as a handle with three verbs: how loud it is now,
// finish (the take as 16 kHz mono Int16), and abort. MediaRecorder records,
// an AnalyserNode on the same stream reads the level.
import { SPEECH_RATE } from '../../../shared/speech';

const REFUSED = 'Microphone access was refused.';
const REASONS = {
  NotAllowedError: REFUSED,
  SecurityError: REFUSED,
  NotFoundError: 'No microphone found.',
  OverconstrainedError: 'No microphone found.',
  NotReadableError: 'The microphone is in use by another app.',
};
// Speech sits far below full scale, so the raw RMS barely moves a meter.
const GAIN = 4;

export async function openMic() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    throw new Error(REASONS[e?.name] || `The microphone did not open: ${e?.message || e}`);
  }

  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  context.createMediaStreamSource(stream).connect(analyser);
  const frame = new Float32Array(analyser.fftSize);

  const chunks = [];
  const recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.start();

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const track of stream.getTracks()) track.stop();
    context.close().catch(() => {});
  };

  return {
    level() {
      if (closed) return 0;
      analyser.getFloatTimeDomainData(frame);
      let sum = 0;
      for (const v of frame) sum += v * v;
      return Math.min(1, Math.sqrt(sum / frame.length) * GAIN);
    },
    async finish() {
      const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
      recorder.stop();
      await stopped;
      close();
      return toSpeech(new Blob(chunks, { type: recorder.mimeType }));
    },
    abort() {
      recorder.ondataavailable = null;
      if (recorder.state !== 'inactive') recorder.stop();
      close();
    },
  };
}

// decodeAudioData resamples to the rate of the context that decodes, so an
// offline context at SPEECH_RATE does the resampling. Channels are averaged.
async function toSpeech(blob) {
  if (!blob.size) return new Int16Array(0);
  const decoded = await new OfflineAudioContext(1, 1, SPEECH_RATE).decodeAudioData(await blob.arrayBuffer());
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i));
  const out = new Int16Array(decoded.length);
  for (let i = 0; i < out.length; i += 1) {
    let sum = 0;
    for (const channel of channels) sum += channel[i];
    const v = Math.max(-1, Math.min(1, sum / channels.length));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}
