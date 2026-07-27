// A small markdown renderer that emits dodo VNodes — never HTML.
//
// The agent's `show_markdown` tool promises "lists, links, tables", and the card
// used to print the source verbatim: "## Findings" and all. This renders it.
//
// It builds nodes directly rather than producing an HTML string, so there is no
// injection surface to sanitize: text is text, and the only attribute that ever
// carries agent-supplied data is a link href, which is checked against a scheme
// allowlist. Unsupported syntax degrades to the literal text — the worst case is
// what the card did for everything before.

import { dd } from '../runtime.js';

const { h, span, a, div, ul, ol, li, p, pre, code, strong, em, table, thead, tbody, tr, th, td } = dd;

const SAFE_SCHEME = /^(https?:|mailto:)/i;
const safeHref = (url) => (SAFE_SCHEME.test(url.trim()) ? url.trim() : null);

// ---- inline ---------------------------------------------------------------
// One pass, longest-marker-first so `**` wins over `*`. Everything that isn't a
// recognised marker accumulates into a text run.
const INLINE = [
  { re: /^`([^`]+)`/, node: (m) => code({ className: 'md-code' }, m[1]) },
  { re: /^\*\*([^*]+)\*\*/, node: (m) => strong(inline(m[1])) },
  { re: /^__([^_]+)__/, node: (m) => strong(inline(m[1])) },
  { re: /^\*([^*\n]+)\*/, node: (m) => em(inline(m[1])) },
  { re: /^_([^_\n]+)_/, node: (m) => em(inline(m[1])) },
  {
    re: /^\[([^\]]*)\]\(([^)\s]+)\)/,
    node: (m) => {
      const href = safeHref(m[2]);
      // A javascript:/data: link is shown as the text it claimed to be rather
      // than silently dropped, so nothing the agent wrote disappears.
      return href
        ? a({ href, target: '_blank', rel: 'noopener noreferrer' }, inline(m[1]))
        : span(m[1] || m[2]);
    },
  },
];

export function inline(text) {
  const out = [];
  let buf = '';
  let rest = text;
  const flush = () => {
    if (buf) {
      out.push(span(buf));
      buf = '';
    }
  };
  while (rest) {
    let hit = null;
    for (const rule of INLINE) {
      const m = rule.re.exec(rest);
      if (m) {
        hit = { rule, m };
        break;
      }
    }
    if (hit) {
      flush();
      out.push(hit.rule.node(hit.m));
      rest = rest.slice(hit.m[0].length);
    } else {
      buf += rest[0];
      rest = rest.slice(1);
    }
  }
  flush();
  return out;
}

// ---- blocks ---------------------------------------------------------------
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE = /^\s*```(\w*)\s*$/;
const ROW = /^\s*\|(.+)\|\s*$/;
const DIVIDER = /^\s*\|?[\s:-]*\|[\s|:-]*$/;

const cells = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());

/** Render markdown source to an array of VNodes. */
export function renderMarkdown(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  const take = (match) => {
    const run = [];
    while (i < lines.length) {
      const m = match(lines[i]);
      if (!m) break;
      run.push(m[1]);
      i++;
    }
    return run;
  };

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      i++;
      const body = [];
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or end of input)
      out.push(pre({ className: 'md-pre' }, code(body.join('\n'))).key(`c${out.length}`));
      continue;
    }

    if (RULE.test(line)) {
      out.push(h('hr', { className: 'md-hr' }).key(`h${out.length}`));
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length + 2, 6); // h1 in a chat bubble is shouting
      out.push(h(`h${level}`, { className: 'md-h' }, inline(heading[2])).key(`t${out.length}`));
      i++;
      continue;
    }

    // A table needs a header row, a divider, then body rows.
    if (ROW.test(line) && i + 1 < lines.length && DIVIDER.test(lines[i + 1]) && lines[i + 1].includes('|')) {
      const head = cells(ROW.exec(line)[1]);
      i += 2;
      const body = [];
      while (i < lines.length && ROW.test(lines[i])) body.push(cells(ROW.exec(lines[i++])[1]));
      out.push(
        table({ className: 'md-table' },
          thead(tr(head.map((c, n) => th(inline(c)).key(`h${n}`)))),
          tbody(body.map((row, n) => tr(row.map((c, k) => td(inline(c)).key(`c${k}`))).key(`r${n}`))),
        ).key(`tb${out.length}`),
      );
      continue;
    }

    if (BULLET.test(line)) {
      const items = take((l) => BULLET.exec(l));
      out.push(ul({ className: 'md-list' }, items.map((t, n) => li(inline(t)).key(n))).key(`u${out.length}`));
      continue;
    }

    if (NUMBERED.test(line)) {
      const items = take((l) => NUMBERED.exec(l));
      out.push(ol({ className: 'md-list' }, items.map((t, n) => li(inline(t)).key(n))).key(`o${out.length}`));
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted = take((l) => QUOTE.exec(l));
      out.push(div({ className: 'md-quote' }, inline(quoted.join(' '))).key(`q${out.length}`));
      continue;
    }

    // Paragraph: consecutive lines up to a blank one or the start of any block.
    const para = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]); // a block-looking line nothing matched
    out.push(p({ className: 'md-p' }, inline(para.join(' '))).key(`p${out.length}`));
  }

  return out;
}

/**
 * The same source as speech. Text-to-speech reading "hash hash Findings,
 * backtick code backtick" is the audible version of printing the source, and
 * this card is most useful precisely when the user isn't looking at it.
 */
export function markdownToSpeech(source) {
  return String(source ?? '')
    .replace(/```[\s\S]*?(?:```|$)/g, ' code block. ') // reading code aloud helps nobody
    .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // say the label, not the URL
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '$1$2')
    .replace(/\*([^*\n]+)\*|_([^_\n]+)_/g, '$1$2')
    // Drop the table's divider row before turning the rest into "a, b" — after,
    // it would already read as a row of dashes.
    .replace(/^[ \t]*\|[ \t:|-]*$/gm, '')
    // `[ \t]`, not `\s`: in multiline mode `\s*$` happily eats the newline that
    // separates two rows, and the table reads as one run-on line.
    .replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_, row) => row.split('|').map((c) => c.trim()).filter(Boolean).join(', '))
    .replace(/\n{2,}/g, '\n')
    .trim();
}

const isBlockStart = (line) =>
  HEADING.test(line) || BULLET.test(line) || NUMBERED.test(line) || QUOTE.test(line) || RULE.test(line) || FENCE.test(line) || ROW.test(line);
