// Connection status header. Pure + presentational — no engine, no events.
import { dd } from '../../runtime.js';

const { alias, div, span } = dd;

const LABELS = {
  connecting: 'connecting…',
  waiting: 'waiting for desktop…',
  negotiating: 'linking…',
  tethered: 'tethered',
  reconnecting: 'reconnecting…',
  error: 'error',
};

export default alias((state) =>
  div({ className: 'status' },
    span({ className: `dot ${state.connection}` }),
    span({ className: 'status-label' }, LABELS[state.connection] || state.connection),
    state.agent && span({ className: 'agent' }, state.agent),
    span({ className: 'room' }, `#${state.room}`),
  ),
);
