// Text-to-speech via the browser's SpeechSynthesis API (per spec — TTS lives on
// the PWA, not the server). Splits replies into sentences so speech starts fast
// and can be interrupted cleanly ("stop talking"). Emits speaking on/off so the
// conversation loop knows when to resume listening (barge-in friendly).

import { Provider } from '@3sln/ngin';

export class Speaker extends EventTarget {
  constructor({ getRate, getVoiceName }) {
    super();
    this.getRate = getRate;
    this.getVoiceName = getVoiceName;
    this.synth = window.speechSynthesis || null;
    this.queue = [];
    this.speaking = false;
    this.lastText = '';
  }

  get supported() {
    return !!this.synth;
  }

  voices() {
    return this.synth ? this.synth.getVoices() : [];
  }

  #pickVoice() {
    const name = this.getVoiceName?.();
    if (!name) return null;
    return this.voices().find((v) => v.name === name) || null;
  }

  /** Speak text. Appends to the current queue (so streamed output reads in order). */
  speak(text, { remember = true } = {}) {
    if (!this.synth || !text || !text.trim()) return;
    if (remember) this.lastText = text;
    for (const sentence of splitSentences(text)) {
      const u = new SpeechSynthesisUtterance(sentence);
      u.rate = this.getRate?.() || 1;
      const voice = this.#pickVoice();
      if (voice) u.voice = voice;
      u.onstart = () => this.#setSpeaking(true);
      u.onend = () => this.#onUtteranceDone();
      u.onerror = () => this.#onUtteranceDone();
      this.queue.push(u);
      this.synth.speak(u);
    }
  }

  repeat() {
    if (this.lastText) this.speak(this.lastText, { remember: false });
  }

  #onUtteranceDone() {
    // Speaking is "off" only when nothing remains pending/active.
    if (!this.synth.pending && !this.synth.speaking) this.#setSpeaking(false);
  }

  #setSpeaking(v) {
    if (this.speaking === v) return;
    this.speaking = v;
    this.emit(v ? 'speaking' : 'idle', {});
  }

  cancel() {
    this.queue = [];
    this.synth?.cancel();
    this.#setSpeaking(false);
  }

  pause() {
    this.synth?.pause();
  }
  resume() {
    this.synth?.resume();
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

// Naive but effective sentence segmentation; keeps chunks short so the first
// words come out quickly and a "stop" cuts in within a sentence.
function splitSentences(text) {
  return text
    .replace(/\s+/g, ' ')
    .match(/[^.!?]+[.!?]*\s*/g)
    ?.map((s) => s.trim())
    .filter(Boolean) || [text.trim()];
}

export class TtsProvider extends Provider {
  static deps = ['settings'];
  constructor({ settings }) {
    super();
    this.settings = settings;
    this.speaker = null;
  }
  async obtain() {
    if (!this.speaker) {
      const settings = await this.settings.obtain();
      this.speaker = new Speaker({
        getRate: () => settings.get('ttsRate'),
        getVoiceName: () => settings.get('ttsVoice'),
      });
    }
    return this.speaker;
  }
  async dispose() {
    this.speaker?.cancel();
  }
}
