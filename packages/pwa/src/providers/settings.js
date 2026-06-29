// Settings — small persisted key/value store behind a Provider. Owns
// localStorage so nothing else in the app reaches for it directly.

import { Provider } from '@3sln/ngin';

const KEY = 'bridle.settings';

export const DEFAULTS = Object.freeze({
  autoSpeak: true, // read agent replies aloud
  ttsRate: 1.0,
  ttsVoice: '', // '' = browser default
  conversationOnConnect: false, // start in conversation mode automatically
  vadThreshold: 0.012, // RMS gate for voice activity (0..1)
  vadHangoverMs: 900, // silence before an utterance is considered finished
  commandLeadIn: 'bridle', // optional wake word to force command interpretation
  language: '', // Whisper language hint ('' = auto; ignored by *.en models)
  sttModel: 'Xenova/whisper-tiny.en', // offline Whisper model run in-browser
});

class Settings extends EventTarget {
  constructor() {
    super();
    this.values = { ...DEFAULTS, ...read() };
  }
  get(key) {
    return this.values[key];
  }
  all() {
    return { ...this.values };
  }
  set(key, value) {
    this.values[key] = value;
    write(this.values);
    this.dispatchEvent(new CustomEvent('change', { detail: { key, value } }));
  }
}

function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}
function write(values) {
  try {
    localStorage.setItem(KEY, JSON.stringify(values));
  } catch {
    /* private mode / quota — settings just won't persist */
  }
}

export class SettingsProvider extends Provider {
  constructor() {
    super();
    this.settings = new Settings();
  }
  async obtain() {
    return this.settings;
  }
}
