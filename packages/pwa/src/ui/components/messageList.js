// Conversation transcript. Keyed list so streamed assistant text updates in
// place; auto-scrolls to the newest message on every reconcile.
import { dd } from '../../runtime.js';

const { alias, ul, li, span } = dd;

export default alias((messages) =>
  ul({ className: 'messages' },
    messages.map((m) =>
      li({ className: `msg ${m.role} ${m.kind || ''}` },
        m.kind === 'command' && span({ className: 'tag' }, 'cmd'),
        span({ className: 'bubble' }, m.content),
      ).key(m.id),
    ),
  ).on({
    $attach: scrollToEnd,
    $update: scrollToEnd,
  }),
);

function scrollToEnd(el) {
  // Defer so layout has settled after the children reconcile.
  requestAnimationFrame(() => {
    el.scrollTop = el.scrollHeight;
  });
}
