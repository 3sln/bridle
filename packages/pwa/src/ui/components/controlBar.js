// The control surface. Two modes:
//   • Normal — a single composer row. Empty input shows a mic FAB (tap = start
//     hands-free voice, press-and-hold = push-to-talk); typing morphs it into a
//     send button. The morph is driven imperatively (keystrokes don't touch ngin
//     state) via a `data-mode` attribute the CSS keys off.
//   • In conversation — only the voice controls (status orb + pause/quiet/
//     interrupt/end), nothing else.
// Pure dodo: emits CustomEvents the composition turns into ngin Actions.
import { dd } from '../../runtime.js';
import { icon } from '../icon.js';

const { alias, div, button, span, h } = dd;

const HOLD_MS = 320;
const MAX_COMPOSER_PX = 140; // ~6 lines before it scrolls internally

// Grow the textarea to fit its content (up to a cap), then let it scroll.
const autoGrow = (el) => {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, MAX_COMPOSER_PX)}px`;
};

export default alias(function (state) {
  const self = this;
  const fire = (type, detail) => self.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));

  if (state.conversation) {
    return div({ className: 'controls' }, conversationBar(state, fire));
  }

  const submit = () => {
    const el = self._input;
    if (el && el.value.trim()) {
      fire('send-text', el.value.trim());
      el.value = '';
      syncMode();
      autoGrow(el);
    }
  };
  const syncMode = () => {
    const c = self._composer;
    const el = self._input;
    if (!c || !el) return;
    const sendable = !!el.value.trim();
    const mode = sendable || !state.micSupported ? 'send' : 'mic';
    c.dataset.mode = mode;
    if (self._fab) self._fab.disabled = mode === 'send' && !sendable;
  };

  // FAB: tap = send (text) / start hands-free (empty); hold = push-to-talk.
  let holdTimer = null;
  let holding = false;
  let suppressClick = false;
  const isMic = () => self._composer?.dataset.mode === 'mic';
  const fab = button(
    { className: 'fab', 'aria-label': 'Send, or hold to talk' },
    icon('arrow_upward', 'g-send'),
    icon('mic', 'g-mic'),
  ).on({
    $attach: (el) => { self._fab = el; },
    click: () => {
      if (suppressClick) { suppressClick = false; return; }
      if (self._input?.value.trim()) {
        submit();
      } else if (state.micSupported) {
        fire('toggle-conversation');
      }
    },
    pointerdown: () => {
      if (!isMic() || !state.micSupported) return;
      holding = false;
      holdTimer = setTimeout(() => { holding = true; fire('ptt-down'); }, HOLD_MS);
    },
    pointerup: () => {
      clearTimeout(holdTimer);
      if (holding) { holding = false; suppressClick = true; fire('ptt-up'); }
    },
    pointercancel: () => { clearTimeout(holdTimer); if (holding) { holding = false; suppressClick = true; fire('ptt-up'); } },
    pointerleave: () => { clearTimeout(holdTimer); if (holding) { holding = false; suppressClick = true; fire('ptt-up'); } },
  });

  const linked = state.connection === 'tethered';
  const placeholder = linked ? 'Message your agent…' : 'Not linked yet — messages send once connected';
  const composer = div({ className: `composer ${linked ? '' : 'unlinked'}`.trim(), 'data-mode': 'mic' },
    h('textarea', { name: 'message', className: 'composer-input', placeholder, rows: '1', enterkeyhint: 'send' }).on({
      $attach: (el) => { self._input = el; syncMode(); autoGrow(el); },
      input: (e) => { syncMode(); autoGrow(e.target); },
      // Enter sends; Shift+Enter (and IME composition) inserts a newline.
      keydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } },
    }),
    fab,
  ).on({
    $attach: (el) => { self._composer = el; syncMode(); },
    $update: syncMode,
  });

  return div({ className: 'controls' }, composer);
});

const LINK_STATUS = { waiting: 'Waiting for desktop…', reconnecting: 'Reconnecting…', negotiating: 'Linking…', connecting: 'Connecting…' };

function conversationBar(state, fire) {
  // A dropped/linking tether takes priority — don't imply we're listening to the
  // agent when nothing's on the other end.
  const linkMsg = state.connection !== 'tethered' && (LINK_STATUS[state.connection] || null);
  const status = linkMsg ? linkMsg
    : state.speaking ? 'Speaking…'
    : state.awaitingReply ? 'Thinking…'
    : state.processing ? 'Transcribing…'
    : state.listening ? 'Listening…'
    : 'Paused';
  const phase = linkMsg ? 'linking'
    : state.speaking ? 'speaking'
    : state.awaitingReply || state.processing ? 'thinking'
    : state.listening ? 'listening'
    : 'paused';

  const ctl = (glyph, label, evt, extra = '') =>
    button({ className: `icon-btn round ${extra}`.trim(), title: label, 'aria-label': label }, icon(glyph)).on({ click: () => fire(evt) });

  return div({ className: `convo-bar ${phase}` },
    div({ className: 'convo-status' },
      span({ className: 'convo-orb' }, icon(state.listening ? 'mic' : 'mic_off', 'orb-ic')),
      span({ className: 'convo-text' }, status),
    ),
    div({ className: 'convo-controls' },
      ctl(state.listening ? 'pause' : 'play_arrow', state.listening ? 'Pause listening' : 'Resume listening', 'toggle-listening'),
      state.speaking && ctl('volume_off', 'Quiet', 'stop-speaking'),
      ctl('skip_next', 'Interrupt the agent', 'interrupt'),
      ctl('call_end', 'End voice', 'toggle-conversation', 'danger'),
    ),
  );
}
