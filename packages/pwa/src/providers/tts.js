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
    if (name) {
      const chosen = this.voices().find((v) => v.name === name);
      if (chosen) return chosen; // explicit user choice wins
    }
    return this.#autoVoice();
  }

  // No voice chosen → match the browser's preferred language, so a user whose
  // system default is (say) Cantonese still hears their UI language, not whatever
  // the OS default voice happens to be.
  #autoVoice() {
    const voices = this.voices();
    if (!voices.length) return null;
    const norm = (l) => (l || '').toLowerCase().replace('_', '-');
    const prefs = (navigator.languages?.length ? navigator.languages : [navigator.language || 'en-US']).map(norm);
    const best = (list) => list.find((v) => v.default) || list.find((v) => v.localService) || list[0] || null;
    // 1. exact locale (en-us), then 2. base language (en)
    for (const pref of prefs) {
      const hit = best(voices.filter((v) => norm(v.lang) === pref));
      if (hit) return hit;
    }
    for (const pref of prefs) {
      const base = pref.split('-')[0];
      const hit = best(voices.filter((v) => norm(v.lang).split('-')[0] === base));
      if (hit) return hit;
    }
    return null;
  }

  /** Speak text. Appends to the current queue (so streamed output reads in order). */
  speak(text, { remember = true } = {}) {
    if (!this.synth || !text || !text.trim()) return;
    if (remember) this.lastText = text;
    for (const sentence of splitSentences(text)) {
      const u = new SpeechSynthesisUtterance(sentence);
      u.rate = this.getRate?.() || 1;
      const voice = this.#pickVoice();
      // Set lang either way so the synth engine won't fall back to the OS default
      // voice (which may be a different language than the user's browser).
      u.lang = voice?.lang || navigator.language || 'en-US';
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
