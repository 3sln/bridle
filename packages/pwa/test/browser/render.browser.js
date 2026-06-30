// Real-browser render tests. The whole-app-renders-nothing regression slipped
// through because nothing ever mounted the app. These mount it in actual
// Chromium with a controllable fake engine and assert real DOM comes out and
// reacts to state changes.
import { dd } from '../../src/runtime.js';
import app from '../../src/ui/compositions/app.js';
import landing from '../../src/ui/components/landing.js';
import statusBar from '../../src/ui/components/statusBar.js';
import { assert, mount, waitFor } from './_helpers.js';

// A complete TetherQuery-shaped state so every child component renders.
function state(over = {}) {
  return {
    connection: 'no-tether', conversation: false, listening: false, speaking: false,
    processing: false, sttState: 'idle', sttProgress: 0, messages: [], level: 0,
    error: null, room: '', agent: null, micSupported: true, ttsSupported: true,
    voices: [], settings: { autoSpeak: true, ttsRate: 1, ttsVoice: '', vadThreshold: 0.012 },
    sheetOpen: false, sessions: [], currentSession: null, sessionsOpen: false,
    statusLine: '', toast: null, ask: null, tethers: [], activeTetherId: null,
    tetherLabel: null, tethersOpen: false, ...over,
  };
}

// Fake engine whose query we can drive: push(state) re-renders the live app.
function fakeEngine() {
  let observer;
  const engine = {
    query: () => ({ subscribe: (obs) => { observer = obs; return { unsubscribe() {} }; }, peek: async () => undefined }),
    dispatch: () => {},
  };
  return { engine, push: (s) => observer?.next?.(s) };
}

describe('app mounts and reacts in a real browser', () => {
  it('produces real DOM, not a stringified component', () => {
    const { engine } = fakeEngine();
    const App = app(engine); // alias factory…
    const root = mount(dd, App()); // …called → a renderable VNode
    assert(root.querySelector('.screen'), 'no .screen element rendered');
    assert(!root.textContent.includes('=>'), 'a function was stringified into the DOM');
    assert(!root.textContent.includes('VNode'), 'a VNode leaked into the DOM as text');
  });

  it('shows the landing for a fresh visitor, then switches to the app when tethered', async () => {
    const { engine, push } = fakeEngine();
    const root = mount(dd, app(engine)());

    // State pushed through the query re-renders on dodo's scheduler (async),
    // so poll the DOM rather than asserting synchronously.
    push(state({ connection: 'no-tether', tethers: [] }));
    assert(await waitFor(() => root.querySelector('.landing')), 'landing not shown for a fresh visitor');
    assert(root.textContent.includes('Talk to your terminal AI agent'), 'landing tagline missing');

    push(state({
      connection: 'tethered',
      tethers: [{ id: 't1', room: 'ABC123', label: 'claude' }],
      activeTetherId: 't1', tetherLabel: 'claude',
      messages: [{ id: 'm1', role: 'assistant', content: 'hello from agent' }],
    }));
    assert(await waitFor(() => !root.querySelector('.landing')), 'landing still shown once tethered');
    assert(root.querySelector('.status .dot.tethered'), 'status dot not in tethered state');
    assert(root.querySelector('.controls'), 'control bar not rendered');
    assert(root.textContent.includes('hello from agent'), 'message bubble not rendered');
  });
});

describe('individual components render', () => {
  it('landing shows the install command and a copy button', () => {
    const root = mount(dd, landing({}));
    assert(root.querySelector('.lp-tagline'), 'no tagline');
    assert(root.textContent.includes('bridle.3sln.com/install.sh'), 'install command missing');
    assert(root.querySelector('.lp-copy'), 'copy button missing');
  });

  it('statusBar reflects the connection state', () => {
    const root = mount(dd, statusBar({ connection: 'tethered', tetherLabel: 'claude · demo', room: 'ABC123' }));
    assert(root.querySelector('.status .dot.tethered'), 'dot not tethered');
    assert(root.textContent.includes('tethered'), 'label missing');
  });
});
