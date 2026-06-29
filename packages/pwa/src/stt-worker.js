// Offline speech-to-text worker. Runs Whisper entirely in the browser via
// Transformers.js (ONNX Runtime, WebGPU when available, WASM otherwise). The
// model is fetched from the HF hub once and cached by the browser — after that
// it works offline. No audio ever leaves the device.
//
// Main thread sends decoded mono 16 kHz Float32 samples; we return text.

import { pipeline, env } from '@huggingface/transformers';

// We only use remote (hub) models, cached in the browser.
env.allowLocalModels = false;

let asrPromise = null;
let loadedKey = null;

function getAsr(model, device) {
  const key = `${model}@${device || 'wasm'}`;
  if (!asrPromise || loadedKey !== key) {
    loadedKey = key;
    asrPromise = pipeline('automatic-speech-recognition', model, {
      ...(device ? { device } : {}),
      progress_callback: (p) => self.postMessage({ type: 'progress', data: p }),
    }).catch(async (err) => {
      // WebGPU not available / failed → fall back to WASM once.
      if (device) {
        self.postMessage({ type: 'progress', data: { status: 'fallback', message: String(err?.message || err) } });
        loadedKey = `${model}@wasm`;
        return pipeline('automatic-speech-recognition', model, {
          progress_callback: (p) => self.postMessage({ type: 'progress', data: p }),
        });
      }
      throw err;
    });
  }
  return asrPromise;
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  try {
    if (msg.type === 'load') {
      await getAsr(msg.model, msg.device);
      self.postMessage({ type: 'ready' });
      return;
    }
    if (msg.type === 'transcribe') {
      const asr = await getAsr(msg.model, msg.device);
      self.postMessage({ type: 'ready' });
      const opts = { chunk_length_s: 30, stride_length_s: 5 };
      // English-only models reject a language option.
      if (!msg.model.endsWith('.en') && msg.language) opts.language = msg.language;
      const out = await asr(msg.samples, opts);
      self.postMessage({ type: 'result', id: msg.id, text: (out.text || '').trim() });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: String(err?.message || err) });
  }
};
