// Desktop keyboard shortcuts. Installed once against the engine; it dispatches
// the same ngin Actions the buttons do, so behaviour stays identical. Shortcuts
// are ignored while typing (except Escape), so they never eat text input.
//
// Escape / Back also doubles as the TV remote's "back" — it closes any open
// sheet — so the same handler serves keyboard and remote.

import {
  NewSessionAction,
  ToggleConversationAction,
  ListSessionsAction,
  OpenTethersAction,
  OpenSettingsAction,
  OpenDetailsAction,
  OpenShortcutsAction,
  CloseShortcutsAction,
  CloseSheetsAction,
} from './bl/tether.js';

const isMac = () => typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent || '');

// The shortcut table — also rendered by the help sheet, so the two never drift.
export const SHORTCUTS = [
  { keys: ['⌘/Ctrl', 'K'], desc: 'New conversation', run: (go) => go(new NewSessionAction()) },
  { keys: ['⌘/Ctrl', 'J'], desc: 'Toggle hands-free voice', run: (go) => go(new ToggleConversationAction()) },
  { keys: ['⌘/Ctrl', 'E'], desc: 'Conversations', run: (go) => go(new ListSessionsAction()) },
  { keys: ['⌘/Ctrl', 'B'], desc: 'Tethers', run: (go) => go(new OpenTethersAction()) },
  { keys: ['⌘/Ctrl', ','], desc: 'Settings', run: (go) => go(new OpenSettingsAction()) },
  { keys: ['⌘/Ctrl', 'I'], desc: 'Connection details', run: (go) => go(new OpenDetailsAction()) },
  { keys: ['/'], desc: 'Focus the message box', run: () => focusComposer() },
  { keys: ['Esc'], desc: 'Close / go back', run: (go) => go(new CloseSheetsAction()) },
  { keys: ['?'], desc: 'Show this help', run: (go) => go(new OpenShortcutsAction()) },
];

function focusComposer() {
  const el = document.querySelector('.composer-input');
  if (el) el.focus();
}

// Map a keydown to a handler. Returns the run(go) fn or null.
function match(e) {
  const mod = isMac() ? e.metaKey : e.ctrlKey;
  const typing = isTyping(e.target);

  // Escape always works (also the remote "back"): close sheets, or blur input.
  if (e.key === 'Escape') {
    return (go) => {
      go(new CloseSheetsAction());
      if (isTyping(e.target)) e.target.blur();
    };
  }
  if (mod) {
    switch (e.key.toLowerCase()) {
      case 'k': return (go) => go(new NewSessionAction());
      case 'j': return (go) => go(new ToggleConversationAction());
      case 'e': return (go) => go(new ListSessionsAction());
      case 'b': return (go) => go(new OpenTethersAction());
      case 'i': return (go) => go(new OpenDetailsAction());
      case ',': return (go) => go(new OpenSettingsAction());
      default: return null;
    }
  }
  // Single-key shortcuts only when NOT typing, so they don't swallow text.
  if (typing) return null;
  if (e.key === '/') return () => focusComposer();
  if (e.key === '?') return (go) => go(new OpenShortcutsAction());
  return null;
}

function isTyping(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/** Install global shortcuts; returns a teardown fn. */
export function installShortcuts(engine) {
  const go = (action) => engine.dispatch(action);
  const onKeyDown = (e) => {
    if (e.defaultPrevented || e.repeat) return;
    const run = match(e);
    if (run) {
      e.preventDefault();
      run(go);
    }
  };
  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}
