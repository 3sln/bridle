// PWA bootstrap: read the pairing room from the URL, build the ngin engine with
// the browser providers, mount the app, register the service worker.

import { Engine, Provider } from '@3sln/ngin';
import { dd } from './runtime.js';
import { DEFAULT_ICE_SERVERS } from '@bridle/protocol/ice';
import { isValidRoomCode } from '@bridle/protocol/signaling';
import { SettingsProvider } from './providers/settings.js';
import { SignalingProvider } from './providers/signaling.js';
import { PeerProvider } from './providers/peer.js';
import { MicProvider } from './providers/mic.js';
import { TtsProvider } from './providers/tts.js';
import app from './ui/compositions/app.js';

const root = document.querySelector('.app');
const config = loadConfig();

if (!isValidRoomCode(config.room)) {
  dd.reconcile(root, [noPairing()]);
} else {
  const engine = new Engine({
    providers: {
      config: Provider.fromSingleton(config),
      settings: SettingsProvider,
      signaling: SignalingProvider,
      peer: PeerProvider,
      mic: MicProvider,
      tts: TtsProvider,
    },
  });
  dd.reconcile(root, [app(engine)]);
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

function loadConfig() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const qs = new URLSearchParams(location.search);

  let room = hash.get('room') || qs.get('room') || localStorage.getItem('bridle.lastRoom') || '';
  if (isValidRoomCode(room)) localStorage.setItem('bridle.lastRoom', room);

  // The PWA is served by the backend, so same-origin is the default. Allow an
  // override for local dev (vite on a different port than the worker).
  let backend = qs.get('backend') || localStorage.getItem('bridle.backend') || location.origin;
  if (qs.get('backend')) localStorage.setItem('bridle.backend', backend);

  return { room, backendUrl: backend.replace(/\/$/, ''), iceServers: DEFAULT_ICE_SERVERS };
}

function noPairing() {
  const { div, p, strong, code } = dd;
  return div({ className: 'screen' },
    div({ className: 'hero' },
      p({ className: 'hero-title' }, '🐴 bridle'),
      p('No pairing code. On your desktop run ', strong('bridle'), ' and scan the QR it shows.'),
      p({ className: 'hint' }, code('curl -fsSL https://bridle.3sln.com/install.sh | sh')),
    ),
  );
}
