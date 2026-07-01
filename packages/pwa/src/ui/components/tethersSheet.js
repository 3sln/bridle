// Tethers sheet: switch between desktops/agents, or add one by code. Pure dodo —
// emits switch-tether/remove-tether/add-tether/close-tethers.
import { dd } from '../../runtime.js';
import { icon } from '../icon.js';

const { alias, div, span, button, ul, li, input, p } = dd;

export default alias(function (state) {
  const self = this;
  const fire = (type, detail) => self.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));
  const close = () => fire('close-tethers');
  const list = state.tethers || [];

  const addByCode = () => {
    const el = self._code;
    const raw = (el && el.value.trim().toLowerCase()) || '';
    // Accept a bare room code or a full pasted link (…#room=CODE).
    const m = raw.match(/room=([a-z0-9]+)/) || [null, raw];
    const room = m[1];
    if (room) {
      fire('add-tether', { room, backendUrl: window.location.origin });
      if (el) el.value = '';
    }
  };

  return div({ className: 'sheet-backdrop' },
    div({ className: 'sheet' },
      div({ className: 'sheet-head' }, span('Tethers'), button({ className: 'btn ghost' }, 'Done').on({ click: close })),
      list.length
        ? ul({ className: 'session-list' },
            list.map((t, i) =>
              li({ className: `session ${t.id === state.activeTetherId ? 'current' : ''}`, tabindex: '0', role: 'button' },
                span({ className: 'idx' }, icon('dns')),
                div({ className: 'session-meta' },
                  span({ className: 'session-title' }, t.label || t.room),
                  span({ className: 'session-when' }, `#${t.room}`),
                ),
                button({ className: 'icon-btn remove', title: 'Remove', 'aria-label': 'Remove tether' }, icon('close')).on({
                  click: (e) => { e.stopPropagation(); fire('remove-tether', { id: t.id }); },
                }),
              ).on({
                click: () => fire('switch-tether', { id: t.id }),
                keydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire('switch-tether', { id: t.id }); } },
              }).key(t.id),
            ),
          )
        : p({ className: 'hint' }, 'No tethers yet. Scan a desktop QR, or add its room code below.'),
      div({ className: 'composer' },
        input({ type: 'text', className: 'composer-input', placeholder: 'room code or pasted link', autocapitalize: 'none' }).on({
          $attach: (el) => { self._code = el; },
          keydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); addByCode(); } },
        }),
        button({ className: 'btn send' }, icon('add'), 'Add').on({ click: addByCode }),
      ),
      p({ className: 'hint' }, `Say "${(state.settings && state.settings.commandLeadIn) || 'bridle'} tether 2" to switch by voice.`),
    ),
  ).on({
    click: (e) => { if (e.target.classList.contains('sheet-backdrop')) close(); },
  });
});
