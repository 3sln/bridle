// Connection header. Left: status dot + tether chip (opens the switcher) +
// current conversation. Right: quick actions (new conversation, conversations,
// settings). Pure dodo — emits bubbling CustomEvents the composition handles.
import { dd } from '../../runtime.js';
import { icon } from '../icon.js';

const { alias, div, span, button } = dd;

const LABELS = {
  'no-tether': 'no tether — scan a QR',
  connecting: 'connecting…',
  waiting: 'waiting for desktop…',
  negotiating: 'linking…',
  tethered: 'tethered',
  reconnecting: 'reconnecting…',
  unpaired: 'not paired',
  error: 'error',
};

export default alias(function (state) {
  const self = this;
  const fire = (type) => self.dispatchEvent(new CustomEvent(type, { bubbles: true }));
  const tethered = state.connection === 'tethered';

  const action = (glyph, label, evt) =>
    button({ className: 'icon-btn', title: label, 'aria-label': label }, icon(glyph)).on({ click: () => fire(evt) });

  return div({ className: 'status' },
    div({ className: 'status-id' },
      // The bead is a button: tap it for connection details (tether, agent,
      // conversation, room token) instead of cluttering the header with them.
      button({ className: 'bead', title: 'Connection details', 'aria-label': 'Connection details' },
        span({ className: `dot ${state.connection}` }),
      ).on({ click: () => fire('open-details') }),
      state.tetherLabel
        ? button({ className: 'tether-chip', title: 'Switch tether' }, icon('lan'), span(state.tetherLabel)).on({ click: () => fire('open-tethers') })
        : span({ className: 'status-label' }, LABELS[state.connection] || state.connection),
      !tethered && state.tetherLabel && span({ className: 'status-label' }, LABELS[state.connection] || state.connection),
    ),
    div({ className: 'status-actions' },
      action('add_comment', 'New conversation', 'new-session'),
      action('forum', 'Conversations', 'open-sessions'),
      action('settings', 'Settings', 'open-settings'),
    ),
  );
});
