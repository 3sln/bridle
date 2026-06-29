// The main control surface: text composer + voice controls. Pure dodo — it
// dispatches CustomEvents which the composition translates into ngin Actions
// (per the 3sln convention: components emit events, never touch the engine).
import { dd } from '../../runtime.js';

const { alias, div, button, input } = dd;

// `function` (not arrow) so `this` is the component's backing element, which we
// use both to dispatch bubbling events and to stash the input ref.
export default alias(function (state) {
  const self = this;
  const fire = (type, detail) => self.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));
  const submit = () => {
    const el = self._input;
    if (el && el.value.trim()) {
      fire('send-text', el.value.trim());
      el.value = '';
    }
  };

  const composer = div({ className: 'composer' },
    input({ type: 'text', className: 'composer-input', placeholder: 'type a message…', enterkeyhint: 'send' }).on({
      $attach: (el) => { self._input = el; },
      keydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } },
    }),
    button({ className: 'btn send' }, 'Send').on({ click: submit }),
  );

  const converse = button(
    { className: `btn big ${state.conversation ? 'on' : ''}`, disabled: !state.micSupported },
    state.conversation ? '■ Stop conversation' : '● Start conversation',
  ).on({ click: () => fire('toggle-conversation') });

  const ptt = button(
    { className: 'btn ptt', disabled: !state.micSupported || state.conversation },
    'Hold to talk',
  ).on({
    pointerdown: (e) => { e.preventDefault(); fire('ptt-down'); },
    pointerup: () => fire('ptt-up'),
    pointercancel: () => fire('ptt-up'),
    pointerleave: () => fire('ptt-up'),
  });

  const row = div({ className: 'actions' },
    converse,
    ptt,
    state.conversation && button({ className: `btn ${state.listening ? '' : 'muted'}` }, state.listening ? 'Pause' : 'Listen')
      .on({ click: () => fire('toggle-listening') }),
    state.speaking && button({ className: 'btn quiet' }, 'Quiet').on({ click: () => fire('stop-speaking') }),
    button({ className: 'btn ghost' }, 'Interrupt').on({ click: () => fire('interrupt') }),
    button({ className: 'btn ghost icon' }, '⚙').on({ click: () => fire('open-settings') }),
  );

  return div({ className: 'controls' }, composer, row);
});
