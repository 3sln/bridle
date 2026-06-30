// PWA bootstrap: build the ngin engine with the browser providers, mount the
// app, register the service worker. The active tether (and any from a scanned
// QR) is managed by the Tethers provider, which seeds itself from the URL hash.

import { Engine, Provider } from '@3sln/ngin';
import { dd } from './runtime.js';
import { DEFAULT_ICE_SERVERS } from '@bridle/protocol/ice';
import { SettingsProvider } from './providers/settings.js';
import { SignalingProvider } from './providers/signaling.js';
import { PeerProvider } from './providers/peer.js';
import { MicProvider } from './providers/mic.js';
import { TtsProvider } from './providers/tts.js';
import { SttProvider } from './providers/stt.js';
import { TethersProvider } from './providers/tethers.js';
import app from './ui/compositions/app.js';

const root = document.querySelector('.app');

const engine = new Engine({
  providers: {
    config: Provider.fromSingleton({ iceServers: DEFAULT_ICE_SERVERS }),
    settings: SettingsProvider,
    signaling: SignalingProvider,
    peer: PeerProvider,
    mic: MicProvider,
    tts: TtsProvider,
    stt: SttProvider,
    tethers: TethersProvider,
  },
});

// `app(engine)` returns a dodo component (an alias factory); call it to produce
// the VNode that actually renders. Passing the factory itself would make dodo
// stringify it as a text node — i.e. the whole app renders nothing.
const App = app(engine);
dd.reconcile(root, [App()]);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
