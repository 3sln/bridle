// Keyboard shortcuts help (desktop). Renders the shared SHORTCUTS table so it
// never drifts from what keyboard.js actually does. Pure dodo; emits
// `close-shortcuts`.
import { dd } from '../../runtime.js';
import { SHORTCUTS } from '../../keyboard.js';

const { alias, div, span, button, ul, li, h, p } = dd;

const isMac = () => typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent || '');
const modLabel = (k) => (k === '⌘/Ctrl' ? (isMac() ? '⌘' : 'Ctrl') : k);

export default alias(function () {
  const self = this;
  const close = () => self.dispatchEvent(new CustomEvent('close-shortcuts', { bubbles: true }));

  return div({ className: 'sheet-backdrop' },
    div({ className: 'sheet' },
      div({ className: 'sheet-head' }, span('Keyboard shortcuts'), button({ className: 'btn ghost' }, 'Done').on({ click: close })),
      ul({ className: 'sc-list' },
        SHORTCUTS.map((s, i) =>
          li({ className: 'sc-row' },
            span({ className: 'sc-desc' }, s.desc),
            span({ className: 'sc-keys' }, s.keys.map((k, j) => h('kbd', {}, modLabel(k)).key(`${i}-${j}`))),
          ).key(s.desc),
        ),
      ),
      p({ className: 'hint sc-hint' }, 'Tip: press / to jump to the message box, or ? any time to reopen this.'),
    ),
  ).on({
    click: (e) => { if (e.target.classList.contains('sheet-backdrop')) close(); },
  });
});
