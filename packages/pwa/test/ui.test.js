// UI render smoke tests. These exist because a regression once shipped where
// the whole app rendered *nothing*: `main.js` passed the app's alias factory to
// `reconcile` without calling it, so dodo stringified the function as a text
// node. Unit tests of pure logic can't catch that — only mounting can. These
// tests mount real components into a happy-dom document and assert actual DOM
// comes out.

import { test, expect, beforeAll } from 'bun:test';
import { Window } from 'happy-dom';

let document;
let dd;
let app;
let statusBar;

beforeAll(async () => {
  // A detached jsdom-like document. dodo derives its document/window from the
  // target element's ownerDocument, so we just need real DOM nodes.
  const win = new Window({ url: 'https://bridle.3sln.com/' });
  document = win.document;
  // Components read globals (navigator, etc.) at render time; point them at the
  // happy-dom window so rendering is deterministic across runtimes.
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.navigator = win.navigator;
  globalThis.location = win.location;
  globalThis.requestAnimationFrame = win.requestAnimationFrame || ((fn) => fn());

  // Import after globals are in place (module top-levels may touch them).
  ({ dd } = await import('../src/runtime.js'));
  app = (await import('../src/ui/compositions/app.js')).default;
  statusBar = (await import('../src/ui/components/statusBar.js')).default;
});

function mount(vnode) {
  const root = document.createElement('main');
  document.body.appendChild(root);
  dd.reconcile(root, [vnode]);
  return root;
}

// A fake engine whose query never emits, so the app renders its initial frame
// (the "starting…" screen). Enough to prove the mount produces real DOM.
const fakeEngine = {
  query: () => ({ subscribe: () => ({ unsubscribe() {} }), peek: () => undefined }),
  dispatch: () => {},
};

test('app composition mounts to real DOM when the component is called', () => {
  const App = app(fakeEngine); // the component (alias factory)
  const root = mount(App()); //   called → a VNode dodo can render
  expect(root.querySelector('.screen')).toBeTruthy();
  // The shipped bug stringified a function into the DOM; guard against it.
  expect(root.textContent).not.toContain('=>');
  expect(root.textContent).not.toContain('VNode');
});

test('regression: passing the uncalled factory renders inert text, not UI', () => {
  const App = app(fakeEngine);
  const root = mount(App); // the bug: factory not called
  expect(root.querySelector('.screen')).toBeFalsy();
  expect(root.textContent).toContain('=>'); // the stringified arrow function
});

test('statusBar reflects connection state', () => {
  const root = mount(statusBar({ connection: 'tethered', tetherLabel: 'claude · demo', room: 'ABC123' }));
  expect(root.querySelector('.status .dot.tethered')).toBeTruthy();
  expect(root.querySelector('.tether-chip')?.textContent).toContain('claude · demo');
});

test('statusBar shows a status label when there is no tether yet', () => {
  const root = mount(statusBar({ connection: 'connecting' }));
  expect(root.querySelector('.status .dot.connecting')).toBeTruthy();
  expect(root.textContent).toContain('connecting');
});

test('controlBar shows "Thinking…" while awaiting the agent reply', async () => {
  const controlBar = (await import('../src/ui/components/controlBar.js')).default;
  const thinking = mount(controlBar({ conversation: true, awaitingReply: true, listening: true }));
  expect(thinking.textContent).toContain('Thinking…');
  // On-device transcription is distinct from the agent thinking.
  const transcribing = mount(controlBar({ conversation: true, processing: true, listening: true }));
  expect(transcribing.textContent).toContain('Transcribing…');
});

test('messageList badges a message held for the next turn', async () => {
  const messageList = (await import('../src/ui/components/messageList.js')).default;
  const root = mount(messageList([{ id: 'q1', role: 'user', content: 'and one more thing', queued: true }]));
  expect(root.querySelector('.msg.queued')).toBeTruthy();
  expect(root.querySelector('.queued-tag')?.textContent).toContain('queued');
});

test('sessionsSheet is honest about link state', async () => {
  const sessionsSheet = (await import('../src/ui/components/sessionsSheet.js')).default;
  const disconnected = mount(sessionsSheet({ connection: 'waiting', sessions: [] }));
  expect(disconnected.textContent).toContain('Connect to your desktop');
  expect(disconnected.querySelector('.btn.big')?.disabled).toBe(true);

  const loading = mount(sessionsSheet({ connection: 'tethered', sessionsLoading: true, sessions: [] }));
  expect(loading.textContent).toContain('Loading conversations…');

  const withList = mount(sessionsSheet({ connection: 'tethered', sessions: [{ id: 's1', title: 'fix the build' }] }));
  expect(withList.querySelector('.session-title')?.textContent).toContain('fix the build');
});

test('messageList shows honest delivery state on user messages', async () => {
  const messageList = (await import('../src/ui/components/messageList.js')).default;
  const root = mount(messageList([
    { id: 'a', role: 'user', content: 'not delivered', delivery: 'pending' },
    { id: 'b', role: 'user', content: 'on the wire', delivery: 'sent' },
    { id: 'c', role: 'user', content: 'agent has it', delivery: 'read' },
    { id: 'd', role: 'assistant', content: 'reply' },
  ]));
  expect(root.querySelector('.msg.user .delivery.pending')).toBeTruthy();
  expect(root.querySelector('.msg.user .delivery.sent')).toBeTruthy();
  expect(root.querySelector('.msg.user .delivery.read')).toBeTruthy();
  // Assistant messages never get a delivery receipt.
  expect(root.querySelector('.msg.assistant .delivery')).toBeFalsy();
});
