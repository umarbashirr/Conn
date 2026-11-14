'use strict';
// Runs the Whisper model for builtin-speech.js, in a process of its own.
// Started by child_process.fork from main, which runs it as plain Node.
//
// It lives out here because the larger models (Small, Distil Small) crash
// Electron's main process when onnxruntime loads them, while the same code
// runs fine as Node. A process of its own also keeps a busy model from
// stalling main, and a crash here takes only the next take down, not Conn.
//
// Messages in:  { id, type: 'warm', repo, cacheDir }
//               { id, type: 'transcribe', repo, cacheDir, samples: Int16Array }
// Messages out: { id, ok: true, text? } | { id, ok: false, reason }
//               { type: 'progress', repo, file, loaded, total }

const loaded = new Map();

function load(repo, cacheDir) {
  if (!loaded.has(repo)) {
    const pending = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = cacheDir;
      return pipeline('automatic-speech-recognition', repo, {
        dtype: 'q8',
        progress_callback: (p) => {
          if (p?.status === 'progress' && p.file && p.total) {
            process.send({ type: 'progress', repo, file: p.file, loaded: p.loaded || 0, total: p.total });
          }
        },
      });
    })();
    loaded.set(repo, pending);
    pending.catch(() => loaded.delete(repo));
  }
  return loaded.get(repo);
}

// Whisper hears 30 seconds at a time. Takes can run to five minutes, and
// without chunking everything after the first 30 seconds was silently dropped,
// so a long take is cut into 30-second windows that overlap by 5 seconds on
// each side and stitched back together.
async function transcribe(repo, cacheDir, samples) {
  const transcriber = await load(repo, cacheDir);
  const audio = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) audio[i] = samples[i] / 32768;
  const out = await transcriber(audio, { chunk_length_s: 30, stride_length_s: 5 });
  return typeof out?.text === 'string' ? out.text.trim() : '';
}

process.on('message', async (msg) => {
  const { id, type, repo, cacheDir } = msg || {};
  try {
    if (type === 'warm') {
      await load(repo, cacheDir);
      process.send({ id, ok: true });
    } else if (type === 'transcribe') {
      process.send({ id, ok: true, text: await transcribe(repo, cacheDir, msg.samples) });
    }
  } catch (e) {
    process.send({ id, ok: false, reason: e?.message || String(e) });
  }
});

// Main went away: nothing is left to answer.
process.on('disconnect', () => process.exit(0));
