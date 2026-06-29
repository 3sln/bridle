// Offline STT provider. Owns the Whisper Web Worker and the audio decoding.
// `transcribe(blob)` decodes the recorded utterance to mono 16 kHz Float32 on
// the main thread (Workers can't decode media), hands the samples to the worker,
// and resolves with the transcript. Emits 'progress'/'ready'/'working' so the UI
// can show the one-time model download.

import { Provider } from '@3sln/ngin';

export class Stt extends EventTarget {
  constructor({ getModel, getLanguage }) {
    super();
    this.getModel = getModel;
    this.getLanguage = getLanguage;
    this.worker = null;
    this.audioCtx = null;
    this.seq = 0;
    this.pending = new Map();
  }

  get device() {
    return typeof navigator !== 'undefined' && navigator.gpu ? 'webgpu' : undefined;
  }

  #ensureWorker() {
    if (this.worker) return;
    this.worker = new Worker(new URL('../stt-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'progress') this.emit('progress', m.data);
      else if (m.type === 'ready') this.emit('ready', {});
      else if (m.type === 'result') {
        this.pending.get(m.id)?.resolve(m.text);
        this.pending.delete(m.id);
      } else if (m.type === 'error') {
        const p = this.pending.get(m.id);
        if (p) {
          p.reject(new Error(m.message));
          this.pending.delete(m.id);
        } else {
          this.emit('error', { message: m.message });
        }
      }
    };
  }

  /** Start downloading/initializing the model so the first utterance is fast. */
  prewarm() {
    this.#ensureWorker();
    this.worker.postMessage({ type: 'load', model: this.getModel(), device: this.device });
  }

  async transcribe(blob) {
    this.#ensureWorker();
    this.emit('working', {});
    const samples = await this.#decode(blob);
    const id = ++this.seq;
    const p = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.worker.postMessage(
      { type: 'transcribe', id, samples, model: this.getModel(), language: this.getLanguage(), device: this.device },
      [samples.buffer],
    );
    return p;
  }

  // Decode an encoded utterance to mono 16 kHz Float32 (what Whisper expects).
  async #decode(blob) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.audioCtx ||= new AudioCtx();
    const decoded = await this.audioCtx.decodeAudioData(await blob.arrayBuffer());
    const frames = Math.max(1, Math.ceil(decoded.duration * 16000));
    const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const offline = new Offline(1, frames, 16000);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0);
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.audioCtx?.close?.();
    this.audioCtx = null;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

export class SttProvider extends Provider {
  static deps = ['settings'];
  constructor({ settings }) {
    super();
    this.settings = settings;
    this.stt = null;
  }
  async obtain() {
    if (!this.stt) {
      const s = await this.settings.obtain();
      this.stt = new Stt({ getModel: () => s.get('sttModel'), getLanguage: () => s.get('language') });
    }
    return this.stt;
  }
  async dispose() {
    this.stt?.dispose();
    this.stt = null;
  }
}
