// Sessions sheet: pick an existing agent session to attach to, or start fresh.
// Pure dodo — emits `connect-session` {id}, `new-session`, and `close-sessions`.
import { dd } from '../../runtime.js';
import { icon } from '../icon.js';

const { alias, div, span, button, ul, li, p } = dd;

export default alias(function (state) {
  const self = this;
  const fire = (type, detail) => self.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));
  const close = () => fire('close-sessions');
  const list = state.sessions || [];

  return div({ className: 'sheet-backdrop' },
    div({ className: 'sheet' },
      div({ className: 'sheet-head' }, span('Conversations'), button({ className: 'btn ghost' }, 'Done').on({ click: close })),
      button({ className: 'btn big' }, icon('add_comment'), 'New conversation').on({ click: () => fire('new-session') }),
      list.length
        ? ul({ className: 'session-list' },
            list.map((s, i) =>
              li({ className: `session ${state.currentSession && state.currentSession.id === s.id ? 'current' : ''}`, tabindex: '0', role: 'button' },
                span({ className: 'idx' }, String(i + 1)),
                div({ className: 'session-meta' },
                  span({ className: 'session-title' }, s.title || s.id),
                  span({ className: 'session-when' }, relative(s.updatedAt)),
                ),
              ).on({
                click: () => fire('connect-session', { id: s.id }),
                keydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire('connect-session', { id: s.id }); } },
              }).key(s.id),
            ),
          )
        : p({ className: 'hint' }, 'No earlier conversations for this project yet.'),
      p({ className: 'hint' }, `Say "${(state.settings && state.settings.commandLeadIn) || 'bridle'} session 2" to switch by voice.`),
    ),
  ).on({
    click: (e) => { if (e.target.classList.contains('sheet-backdrop')) close(); },
  });
});

function relative(ms) {
  if (!ms) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
