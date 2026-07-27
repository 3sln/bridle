// Connection details, opened by tapping the status bead. Shows what you're
// tethered to (agent, device), the live conversation, and the room token —
// info that's useful occasionally but doesn't belong in the always-on header.
// Pure dodo; emits `close-details`, and `switch-tether` via the Tethers button.
import { dd } from '../../runtime.js';
import { icon } from '../icon.js';

const { alias, div, span, button, p } = dd;

const STATUS = {
  'no-tether': 'No tether',
  connecting: 'Connecting…',
  waiting: 'Waiting for desktop…',
  negotiating: 'Linking…',
  tethered: 'Connected',
  reconnecting: 'Reconnecting…',
  unpaired: 'Refused — this phone isn’t paired',
  error: 'Error',
};

export default alias(function (state) {
  const self = this;
  const fire = (type, detail) => self.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));
  const close = () => fire('close-details');

  const row = (glyph, label, value) =>
    value
      ? div({ className: 'detail-row' },
          icon(glyph, 'detail-ic'),
          div({ className: 'detail-meta' }, span({ className: 'detail-label' }, label), span({ className: 'detail-value' }, value)),
        )
      : null;

  const session = state.currentSession;

  return div({ className: 'sheet-backdrop' },
    div({ className: 'sheet' },
      div({ className: 'sheet-head' }, span('Details'), button({ className: 'btn ghost' }, 'Done').on({ click: close })),
      div({ className: 'detail-list' },
        row('bolt', 'Status', STATUS[state.connection] || state.connection),
        row('lan', 'Tether', state.tetherLabel || '—'),
        row('smart_toy', 'Agent', state.agent || '—'),
        row('forum', 'Conversation', session ? session.title || session.id || 'current' : 'None yet'),
        row('vpn_key', 'Room token', state.room || '—'),
        row('verified_user', 'Device', 'Paired & verified on this phone'),
      ),
      div({ className: 'detail-actions' },
        button({ className: 'btn' }, icon('swap_horiz'), 'Switch tether').on({ click: () => { close(); fire('open-tethers'); } }),
        button({ className: 'btn ghost' }, icon('add_comment'), 'New conversation').on({ click: () => { close(); fire('new-session'); } }),
      ),
      p({ className: 'hint' }, 'Only this paired phone can drive the agent — the room token alone is not enough.'),
    ),
  ).on({
    click: (e) => { if (e.target.classList.contains('sheet-backdrop')) close(); },
  });
});
