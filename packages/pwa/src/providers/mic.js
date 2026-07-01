// Microphone + voice-activity detection via Silero (neural VAD, @ricky0123/vad-web).
// Silero decides speech start/end on-device, ignoring background noise — so an
// utterance is cut at real speech boundaries (no word-chopping) and noise never
// holds it open. `onSpeechEnd` hands us the exact 16 kHz mono samples Whisper
// wants, so there's no MediaRecorder / re-decoding: each segment is a complete
// utterance the conversation layer transcribes and sends.
//
// `redemptionMs` is the trailing pause after speech before a segment closes —
// i.e. the user's "pause before sending" knob.

import { Provider } from '@3sln/ngin';
import { MicVAD } from '@ricky0123/vad-web';

export class Microphone extends EventTarget {
  constructor({ getHangover }) {
    super();
    this.getHangover = getHangover;
    this.vad = null;
    this.running = false;
    this.paused = false;
  }

  get active() {
    return this.running;
  }

  async start() {
    if (this.running) return;
    this.vad = await MicVAD.new({
      model: 'v5', // newer, more accurate Silero
      // Serve the worklet, Silero model and ORT wasm from our own origin (see
      // scripts/copy-runtime-assets.mjs) rather than a CDN — same-origin,
      // SW-cacheable, and keeps inference on-device with no third-party fetch.
      baseAssetPath: '/',
      onnxWASMBasePath: '/',
      startOnLoad: false,
      submitUserSpeechOnPause: false, // pausing (barge-in) must not emit half speech
      redemptionMs: this.getHangover?.() || 500, // trailing pause that ends a segment
      preSpeechPadMs: 200, // keep the attack of the first word
      minSpeechMs: 250, // drop sub-250ms blips (misfires)
      onSpeechStart: () => this.emit('speechstart', {}),
      onSpeechEnd: (samples) => this.emit('utterance', { samples }),
      onVADMisfire: () => this.emit('speechend', {}),
      onFrameProcessed: (_probs, frame) => {
        let sum = 0;
        for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
        this.emit('level', { level: Math.sqrt(sum / frame.length) });
      },
    });
    this.running = true;
    this.paused = false;
    await this.vad.start();
    this.emit('start', {});
  }

  pause() {
    this.paused = true;
    this.vad?.pause().catch(() => {});
    this.emit('paused', {});
  }

  resume() {
    if (!this.running) return;
    this.paused = false;
    // Reapply the (possibly retuned) pause-before-sending each time we resume.
    this.vad?.setOptions?.({ redemptionMs: this.getHangover?.() || 500 });
    this.vad?.start().catch(() => {});
    this.emit('resumed', {});
  }

  // Push-to-talk: just listen; Silero emits the segment on speech end. (There's no
  // separate raw-capture path anymore — the VAD is always the segmenter.)
  async startManual() {
    await this.start();
    if (this.paused) this.resume();
  }
  stopManual() {
    /* let the in-flight segment finish and emit on its own */
  }

  async stop() {
    this.running = false;
    this.paused = false;
    try {
      await this.vad?.destroy();
    } catch {
      /* already gone */
    }
    this.vad = null;
    this.emit('stop', {});
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

export class MicProvider extends Provider {
  static deps = ['settings'];
  constructor({ settings }) {
    super();
    this.settings = settings;
    this.mic = null;
  }
  async obtain() {
    if (!this.mic) {
      const settings = await this.settings.obtain();
      this.mic = new Microphone({
        getHangover: () => settings.get('vadHangoverMs'),
      });
    }
    return this.mic;
  }
  async dispose() {
    await this.mic?.stop();
    this.mic = null;
  }
}
