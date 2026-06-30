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
let landing;
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

  // Import after globals are in place (module top-levels may touch them).
  ({ dd } = await import('../src/runtime.js'));
  app = (await import('../src/ui/compositions/app.js')).default;
  landing = (await import('../src/ui/components/landing.js')).default;
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

test('landing component renders its hero and install command', () => {
  const root = mount(landing({}));
  expect(root.querySelector('.landing')).toBeTruthy();
  expect(root.querySelector('.lp-tagline')?.textContent).toContain('terminal AI agent');
  expect(root.textContent).toContain('bridle.3sln.com/install.sh');
});

test('statusBar reflects connection state', () => {
  const root = mount(statusBar({ connection: 'tethered', tetherLabel: 'claude · demo', room: 'ABC123' }));
  expect(root.querySelector('.status .dot.tethered')).toBeTruthy();
  expect(root.textContent).toContain('tethered');
});
