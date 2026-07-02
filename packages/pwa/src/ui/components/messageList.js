// Conversation transcript. Renders text plus assets the agent pushed via MCP
// (audio / image / file / markdown), grouped by day with sticky date separators.
// Each bubble carries its time + (for your own messages) a delivery receipt.
// Outside hands-free mode, replies aren't read automatically — a speaker button
// on each spoken message plays it on demand.
import { dd } from '../../runtime.js';
import { icon } from '../icon.js';

const { alias, ul, li, span, div, a, img, h, button } = dd;

// Delivery states shown on your own messages so nothing looks sent when it isn't.
const DELIVERY = {
  pending: { glyph: 'schedule', label: 'Pending — not delivered yet' },
  sent: { glyph: 'check', label: 'Sent to your desktop' },
  read: { glyph: 'done_all', label: 'The agent has this' },
};

export default alias(function (state) {
  const self = this;
  const fire = (type, detail) => self.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));
  const messages = state.messages || [];
  const manualSpeak = !state.conversation; // hands-free reads aloud; otherwise on-demand

  const rows = [];
  let lastDay = null;
  for (const m of messages) {
    const day = dayKey(m.ts);
    if (day && day !== lastDay) {
      lastDay = day;
      rows.push(li({ className: 'date-sep' }, span(dayLabel(m.ts))).key(`sep-${day}`));
    }
    rows.push(renderMessage(m, manualSpeak, fire));
  }

  return ul({ className: 'messages' }, rows).on({ $attach: scrollToEnd, $update: scrollToEnd });
});

function renderMessage(m, manualSpeak, fire) {
  const speakable = manualSpeak && SPOKEN_ROLES.has(m.role) && textOf(m);
  return li({ className: `msg ${m.role} ${m.kind || ''} ${m.queued ? 'queued' : ''}`.trim() },
    m.kind === 'command' && span({ className: 'tag' }, 'cmd'),
    m.queued && span({ className: 'tag queued-tag' }, 'queued'),
    body(m),
    speakable
      ? button({ className: 'speak-btn', title: 'Read aloud', 'aria-label': 'Read aloud' }, icon('volume_up'))
          .on({ click: () => fire('speak-message', { text: textOf(m) }) })
      : null,
  ).key(m.id);
}

const SPOKEN_ROLES = new Set(['assistant', 'user']);
const textOf = (m) => (!m.kind || m.kind === 'markdown' || m.kind === 'answer' || m.kind === 'command') ? (m.content || '') : (m.content || '');

// The time + delivery receipt that sits inside the bubble, bottom-right. System
// status pills stay bare.
function meta(m) {
  if (m.role === 'system') return null;
  return span({ className: 'meta' },
    span({ className: 'time' }, hhmm(m.ts)),
    deliveryMark(m),
  );
}

function deliveryMark(m) {
  if (m.role !== 'user' || !m.delivery || m.kind === 'command' || m.kind === 'answer') return null;
  const d = DELIVERY[m.delivery];
  return d ? span({ className: `delivery ${m.delivery}`, title: d.label, 'aria-label': d.label }, icon(d.glyph)) : null;
}

function body(m) {
  switch (m.kind) {
    case 'audio':
      return div({ className: 'bubble asset' },
        h('audio', { className: 'audio', src: m.url, controls: true, autoplay: !!m.autoplay, playsinline: true }),
        m.content && span({ className: 'caption' }, m.content),
        meta(m),
      );
    case 'image':
      return a({ className: 'bubble asset', href: m.url, target: '_blank' },
        img({ className: 'image', src: m.url, alt: m.content || m.name || 'image' }),
        m.content && span({ className: 'caption' }, m.content),
        meta(m),
      );
    case 'file':
      return a({ className: 'bubble file', href: m.url, download: m.name || 'file' },
        span({ className: 'file-icon' }, '📎'),
        span({ className: 'file-name' }, m.name || m.content || 'download'),
        meta(m),
      );
    case 'markdown':
      return div({ className: 'bubble md' },
        m.title && span({ className: 'md-title' }, m.title),
        span({ className: 'md-body' }, m.content),
        meta(m),
      );
    default:
      return div({ className: 'bubble' }, span({ className: 'bubble-text' }, m.content), meta(m));
  }
}

// --- dates / times ----------------------------------------------------------
const pad2 = (n) => String(n).padStart(2, '0');
const hhmm = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const dayKey = (ts) => {
  if (!ts) return null;
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};
function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (dayKey(ts) === dayKey(today.getTime())) return 'Today';
  if (dayKey(ts) === dayKey(y.getTime())) return 'Yesterday';
  const sameYear = d.getFullYear() === today.getFullYear();
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

function scrollToEnd(el) {
  requestAnimationFrame(() => {
    el.scrollTop = el.scrollHeight;
  });
}
