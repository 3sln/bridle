// Microphone with energy-based voice-activity detection. Continuously reports a
// level (for the UI meter) and segments speech into utterances: on voice onset
// it records via MediaRecorder; after `hangover` ms of silence it finalizes the
// clip and emits it. The encoded blob is shipped over the data channel to the
// desktop, which runs Whisper — STT never happens on-device.
//
// Thresholds are read live from settings each frame, so tuning is instant.

import { Provider } from '@3sln/ngin';

const CANDIDATE_MIMES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4', // Safari/iOS
  'audio/ogg;codecs=opus',
];

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  return CANDIDATE_MIMES.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

export class Microphone extends EventTarget {
  constructor({ getThreshold, getHangover }) {
    super();
    this.getThreshold = getThreshold;
    this.getHangover = getHangover;
    this.running = false;
    this.paused = false;
    this.speaking = false;
    this.discarding = false;
    this.stream = null;
    this.ctx = null;
    this.recorder = null;
    this.chunks = [];
  }

  get active() {
    return this.running;
  }

  async start() {
    if (this.running) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioCtx();
    await this.ctx.resume().catch(() => {});
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.source.connect(this.analyser);
    this.buf = new Uint8Array(this.analyser.fftSize);
    this.mime = pickMime();
    this.running = true;
    this.paused = false;
    this.emit('start', {});
    this.#loop();
  }

  #loop() {
    if (!this.running) return;
    this.analyser.getByteTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const x = (this.buf[i] - 128) / 128;
      sum += x * x;
    }
    const rms = Math.sqrt(sum / this.buf.length);
    this.emit('level', { level: rms });

    if (!this.paused) {
      const threshold = this.getThreshold();
      const hangover = this.getHangover();
      const now = performance.now();
      if (rms > threshold) {
        this.lastVoice = now;
        if (!this.speaking) {
          this.speaking = true;
          this.#startRecorder();
          this.emit('speechstart', {});
        }
      } else if (this.speaking && now - this.lastVoice > hangover) {
        this.speaking = false;
        this.#stopRecorder();
      }
    }
    this.raf = requestAnimationFrame(() => this.#loop());
  }

  #startRecorder() {
    this.chunks = [];
    this.discarding = false;
    try {
      this.recorder = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime } : undefined);
    } catch {
      this.recorder = new MediaRecorder(this.stream);
    }
    this.recStart = performance.now();
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) this.chunks.push(e.data);
    };
    this.recorder.onstop = () => {
      const durationMs = performance.now() - this.recStart;
      if (!this.discarding) {
        const blob = new Blob(this.chunks, { type: this.mime || 'audio/webm' });
        // Drop sub-250ms blips (door slams, lip smacks).
        if (blob.size > 0 && durationMs > 250) {
          this.emit('utterance', { blob, mime: blob.type || this.mime || 'audio/webm', durationMs });
        }
      }
      this.emit('speechend', {});
    };
    this.recorder.start();
  }

  #stopRecorder() {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
  }

  /** Push-to-talk: begin a single recording immediately, bypassing the VAD. */
  async startManual() {
    if (!this.running) await this.start();
    this.paused = true; // suppress VAD segmentation while held
    this.speaking = false;
    this.#startRecorder();
  }

  /** Push-to-talk: stop and emit the recorded utterance. */
  stopManual() {
    this.#stopRecorder();
  }

  /** Pause utterance capture (level metering continues). Drops any in-flight clip. */
  pause() {
    this.paused = true;
    if (this.speaking) {
      this.speaking = false;
      this.discarding = true;
      this.#stopRecorder();
    }
    this.emit('paused', {});
  }

  resume() {
    if (!this.running) return;
    this.paused = false;
    this.emit('resumed', {});
  }

  async stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.discarding = true;
    this.#stopRecorder();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close().catch(() => {});
    this.stream = null;
    this.ctx = null;
    this.speaking = false;
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
        getThreshold: () => settings.get('vadThreshold'),
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
