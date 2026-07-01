// Settings — small persisted key/value store behind a Provider. Owns
// localStorage so nothing else in the app reaches for it directly.

import { Provider } from '@3sln/ngin';

const KEY = 'bridle.settings';

export const DEFAULTS = Object.freeze({
  autoSpeak: true, // read agent replies aloud
  ttsRate: 1.0,
  ttsVoice: '', // '' = browser default
  conversationOnConnect: false, // start in conversation mode automatically
  vadHangoverMs: 500, // trailing pause (redemption) that ends a Silero segment and sends it
  commandLeadIn: 'bridle', // optional wake word to force command interpretation
  language: '', // Whisper language hint ('' = auto; ignored by *.en models)
  sttModel: 'Xenova/whisper-tiny.en', // offline Whisper model run in-browser
  // hands-free / driving
  drivingMode: false, // auto-conversation on connect + keep-awake + earcons
  earcons: true, // non-visual audio cues for listening/processing/done
  keepAwake: true, // hold a screen wake lock while in conversation
  mediaControls: true, // headset/car/lock-screen buttons (holds audio focus)
});

const LEGACY_HANGOVER_MS = 900; // old default that felt like "wait until I'm finished"

class Settings extends EventTarget {
  constructor() {
    super();
    const stored = read();
    this.values = { ...DEFAULTS, ...stored };
    // One-time migration: adopt the snappier send gap for anyone still sitting on
    // the old default (they never deliberately chose 900ms).
    if (stored.vadHangoverMs === LEGACY_HANGOVER_MS) {
      this.values.vadHangoverMs = DEFAULTS.vadHangoverMs;
      write(this.values);
    }
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
