// Hands-free helpers for eyes-off / driving use: non-visual audio cues
// (earcons), keep-awake (Wake Lock), and hardware media controls (MediaSession —
// so a car/headset/lock-screen play-pause-skip maps onto bridle).
//
// All three degrade gracefully where unsupported.

// ---- earcons: short tones that signal state without looking ---------------
export function createEarcons() {
  let ctx = null;
  const ensure = () => {
    if (!ctx) {
      const A = window.AudioContext || window.webkitAudioContext;
      if (!A) return null;
      ctx = new A();
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  };
  const tone = (freq, dur = 0.12, type = 'sine', gain = 0.05) => {
    const c = ensure();
    if (!c) return;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.value = freq;
    o.connect(g);
    g.connect(c.destination);
    const t = c.currentTime;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t);
    o.stop(t + dur);
  };
  return {
    resume: ensure,
    listen: () => tone(660, 0.1), // started listening
    stop: () => tone(440, 0.09), // stopped listening
    think: () => { tone(520, 0.06); setTimeout(() => tone(520, 0.06), 120); }, // processing
    done: () => { tone(720, 0.08); setTimeout(() => tone(960, 0.1), 90); }, // result ready
    error: () => tone(300, 0.18, 'square', 0.05),
  };
}

// ---- wake lock: keep the screen/session alive while in use ----------------
export function createWakeLock() {
  let sentinel = null;
  let wanted = false;
  const acquire = async () => {
    try {
      if (navigator.wakeLock && !sentinel) {
        sentinel = await navigator.wakeLock.request('screen');
        sentinel.addEventListener('release', () => { sentinel = null; });
      }
    } catch {
      /* denied / unsupported */
    }
  };
  const release = async () => {
    try {
      await sentinel?.release();
    } catch {
      /* noop */
    }
    sentinel = null;
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wanted) acquire();
  });
  return {
    enable: () => { wanted = true; acquire(); },
    disable: () => { wanted = false; release(); },
  };
}

// ---- media session: hardware transport controls --------------------------
// Maps headset / Bluetooth / car / lock-screen buttons onto handlers. These only
// fire while the page is actually playing audio, so we keep a SILENT looping
// keepalive element playing while a conversation is active — that holds the
// media session so the buttons reach us even when we're only listening.
//
// Trade-off: holding the session takes audio focus, so the user's music ducks/
// pauses during a bridle conversation (like talking to a voice assistant) and
// resumes when it ends. Gate with the `mediaControls` setting if undesired.
//
// playbackState mirrors *listening*, so a single-button headset toggles
// listen/pause; togglemicrophone does the same on devices that expose it.
export function setupMediaSession(handlers) {
  const supported = 'mediaSession' in navigator;
  let audio = null;
  const ensureAudio = () => {
    if (!audio) {
      audio = new Audio(silentWavUrl());
      audio.loop = true;
      audio.preload = 'auto';
    }
    return audio;
  };
  const wrap = (fn) => (fn ? () => { try { fn(); } catch { /* noop */ } } : null);
  const bind = (action, fn) => {
    if (!supported) return;
    try {
      navigator.mediaSession.setActionHandler(action, wrap(fn));
    } catch {
      /* action unsupported on this browser */
    }
  };

  if (supported) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: 'bridle', artist: 'voice agent' });
    } catch {
      /* noop */
    }
    bind('play', handlers.play);
    bind('pause', handlers.pause);
    bind('stop', handlers.stop);
    bind('previoustrack', handlers.previous);
    bind('nexttrack', handlers.next);
    bind('togglemicrophone', handlers.toggleMic);
    bind('hangup', handlers.hangup);
  }

  const setPlaybackState = (s) => {
    if (!supported) return;
    try {
      navigator.mediaSession.playbackState = s;
    } catch {
      /* noop */
    }
  };

  return {
    // Start holding the session (call within a user gesture for autoplay).
    activate() {
      try {
        ensureAudio().play().catch(() => {});
      } catch {
        /* noop */
      }
      setPlaybackState('playing');
    },
    deactivate() {
      try {
        audio?.pause();
      } catch {
        /* noop */
      }
      setPlaybackState('none');
    },
    // Reflect listening state so the single-button toggle works.
    setListening(on) {
      setPlaybackState(on ? 'playing' : 'paused');
      try {
        navigator.mediaSession.setMicrophoneActive?.(on);
      } catch {
        /* noop */
      }
    },
    update(meta) {
      if (!supported) return;
      try {
        navigator.mediaSession.metadata = new MediaMetadata({ title: 'bridle', ...meta });
      } catch {
        /* noop */
      }
    },
  };
}

// A tiny silent mono 8 kHz WAV as an object URL — the keepalive's "media".
function silentWavUrl() {
  const rate = 8000;
  const samples = rate / 2; // 0.5s
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF');
  v.setUint32(4, 36 + samples * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, samples * 2, true);
  // samples are already zero (silence)
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
