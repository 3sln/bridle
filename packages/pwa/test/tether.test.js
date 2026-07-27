// The phone's connection state machine, driven through real link frames.
//
// Every provider TetherQuery depends on is injected, so the whole thing runs
// headless with stubs — which matters, because the bugs worth guarding here are
// exactly the ones that only show up in sequence: going green before the desktop
// has said yes, and calling a live tether "reconnecting" because something other
// than the data channel twitched.

import { test, expect, beforeAll } from 'bun:test';
import { Window } from 'happy-dom';

let Engine;
let Provider;
let TetherQuery;
let CONNECTION;
let link;

beforeAll(async () => {
  const win = new Window({ url: 'https://bridle.3sln.com/app/' });
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.navigator = win.navigator;
  globalThis.location = win.location;
  globalThis.URL.createObjectURL ??= () => 'blob:stub';
  globalThis.requestAnimationFrame ??= (fn) => fn();

  ({ Engine, Provider } = await import('@3sln/ngin'));
  ({ TetherQuery, CONNECTION } = await import('../src/bl/tether.js'));
  link = await import('@bridle/protocol/link');
});

class Bus extends EventTarget {
  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

class FakePeer extends Bus {
  sent = [];
  open = false;
  async makeOffer() {
    return 'v=0 fake-offer';
  }
  async accept() {}
  send(msg) {
    this.sent.push(msg);
    return this.open;
  }
  sendBinary() {
    return this.open;
  }
  close() {
    this.open = false;
  }
  /** Bring the data channel up the way GuestPeer does. */
  goLive() {
    this.open = true;
    this.emit('open', {});
  }
}

const SETTINGS = { autoSpeak: false, earcons: false, commandLeadIn: 'bridle', ttsRate: 1, conversationOnConnect: false, drivingMode: false };

async function boot() {
  const signaling = new Bus();
  Object.assign(signaling, { connect() {}, close() {}, sendSignal() {} });

  const peers = [];
  const tether = { id: 't1', room: 'devtetherdevtetherdevteth', backendUrl: 'https://x.test', label: 'devtether…' };
  const tethers = Object.assign(new Bus(), {
    activeId: 't1',
    list: () => [tether],
    active: () => tether,
    setAutoLabel(_id, label) {
      tether.label = label;
    },
  });

  const tts = Object.assign(new Bus(), { supported: true, voices: () => [], speak() {}, cancel() {}, repeat() {} });
  const mic = Object.assign(new Bus(), { start: async () => {}, stop: async () => {}, pause() {}, resume() {} });
  const stt = Object.assign(new Bus(), { readyState: 'ready', prewarm() {}, ensureReady: async () => {}, transcribeSamples: async () => '' });

  const engine = new Engine({
    providers: {
      config: Provider.fromSingleton({ iceServers: [] }),
      settings: Provider.fromSingleton({ all: () => ({ ...SETTINGS }), get: (k) => SETTINGS[k], set() {} }),
      signaling: Provider.fromSingleton(signaling),
      peer: Provider.fromSingleton(async () => {
        const p = new FakePeer();
        peers.push(p);
        return p;
      }),
      mic: Provider.fromSingleton(mic),
      tts: Provider.fromSingleton(tts),
      stt: Provider.fromSingleton(stt),
      tethers: Provider.fromSingleton(tethers),
      identity: Provider.fromSingleton({ publicKeyJwk: async () => ({ kty: 'EC' }), sign: async () => 'sig' }),
    },
  });

  const frames = [];
  const sub = engine.query(new TetherQuery()).subscribe((s) => frames.push(s));
  const now = () => frames[frames.length - 1];
  const settle = () => new Promise((r) => setTimeout(r, 0));

  await settle();
  // The desktop is already in the room, so the phone offers immediately.
  signaling.emit('joined', { peers: ['host'] });
  await settle();
  await settle();

  const peer = peers[0];
  peer.goLive();
  await settle();

  return { engine, sub, signaling, peer, tethers, now, settle, frames };
}

test('the phone stays "linking" until the desktop says the device is verified', async () => {
  const { engine, sub, peer, now, settle } = await boot();

  // Channel open is not admission — the host has not challenged us yet.
  expect(now().connection).toBe(CONNECTION.NEGOTIATING);

  peer.emit('message', { msg: link.helloHost('Claude Code', '/work/proj', 'nonce-1') });
  await settle();
  // …and neither is HELLO, which every device gets, including one about to be
  // refused. Green here is a promise the tether can't keep.
  expect(now().connection).toBe(CONNECTION.NEGOTIATING);
  expect(now().agent).toBe('Claude Code');
  expect(now().messages.filter((m) => m.role === 'system')).toEqual([]);
  expect(peer.sent.map((m) => m.t)).toContain(link.LINK.HELLO); // we answered the challenge

  peer.emit('message', { msg: link.ready() });
  await settle();
  expect(now().connection).toBe(CONNECTION.TETHERED);
  expect(now().messages.at(-1).content).toBe('connected to Claude Code');

  sub.unsubscribe();
  await engine.dispose();
});

test('an older desktop (proto 1, no READY) still connects', async () => {
  const { engine, sub, peer, now, settle } = await boot();

  peer.emit('message', { msg: { ...link.helloHost('codex', '/w', 'n'), proto: 1 } });
  await settle();
  expect(now().connection).toBe(CONNECTION.TETHERED);

  sub.unsubscribe();
  await engine.dispose();
});

test('losing the signaling socket does not disturb a live tether', async () => {
  const { engine, sub, signaling, peer, now, settle } = await boot();
  peer.emit('message', { msg: link.helloHost('claude', '/w', 'n') });
  peer.emit('message', { msg: link.ready() });
  await settle();
  expect(now().connection).toBe(CONNECTION.TETHERED);

  // Signaling is only how the ends find each other; the relay hibernating or
  // dropping says nothing about the P2P channel, which is still open.
  signaling.emit('close', { code: 1006 });
  await settle();
  expect(now().connection).toBe(CONNECTION.TETHERED);

  // If the channel really is down, then it is news.
  peer.open = false;
  signaling.emit('close', { code: 1006 });
  await settle();
  expect(now().connection).toBe(CONNECTION.RECONNECTING);

  sub.unsubscribe();
  await engine.dispose();
});

test('a transient ICE wobble recovers instead of sticking on "reconnecting"', async () => {
  const { engine, sub, peer, now, settle } = await boot();
  peer.emit('message', { msg: link.helloHost('claude', '/w', 'n') });
  peer.emit('message', { msg: link.ready() });
  await settle();

  peer.emit('state', { state: 'disconnected' });
  await settle();
  expect(now().connection).toBe(CONNECTION.RECONNECTING);

  peer.emit('state', { state: 'connected' });
  await settle();
  expect(now().connection).toBe(CONNECTION.TETHERED);

  sub.unsubscribe();
  await engine.dispose();
});

test('a refused device is told so, and stays told', async () => {
  const { engine, sub, peer, now, settle } = await boot();
  peer.emit('message', { msg: link.helloHost('claude', '/w', 'n') });
  await settle();

  peer.emit('message', {
    msg: link.notice('This phone isn’t the one paired…', link.LEVEL.ERROR, link.NOTICE_CODE.UNPAIRED),
  });
  await settle();
  expect(now().connection).toBe(CONNECTION.UNPAIRED);
  expect(now().error).toContain('paired');

  // The desktop hangs up right after. "Waiting for desktop…" would point the
  // user at a problem they don't have.
  peer.open = false;
  peer.emit('closed', {});
  await settle();
  expect(now().connection).toBe(CONNECTION.UNPAIRED);

  sub.unsubscribe();
  await engine.dispose();
});

test('an ordinary notice is still just a toast', async () => {
  const { engine, sub, peer, now, settle } = await boot();
  peer.emit('message', { msg: link.helloHost('claude', '/w', 'n') });
  peer.emit('message', { msg: link.ready() });
  peer.emit('message', { msg: link.notice('build finished', link.LEVEL.INFO) });
  await settle();
  expect(now().toast).toEqual({ text: 'build finished', level: 'info' });
  expect(now().connection).toBe(CONNECTION.TETHERED);

  sub.unsubscribe();
  await engine.dispose();
});

test('text composed before admission is held, then flushed once verified', async () => {
  const { engine, sub, peer, now, settle } = await boot();
  const engineFeed = engine.feed;

  engineFeed.dispatchEvent(new CustomEvent('intent', { detail: { type: 'send-text', text: 'early' } }));
  await settle();
  expect(now().messages.at(-1)).toMatchObject({ role: 'user', content: 'early', delivery: 'pending' });
  expect(peer.sent.some((m) => m.t === link.LINK.TEXT)).toBe(false);

  peer.emit('message', { msg: link.helloHost('claude', '/w', 'n') });
  peer.emit('message', { msg: link.ready() });
  await settle();
  expect(peer.sent.find((m) => m.t === link.LINK.TEXT)).toMatchObject({ text: 'early' });
  expect(now().messages.find((m) => m.content === 'early').delivery).toBe('sent');

  sub.unsubscribe();
  await engine.dispose();
});
