// The markdown card used to print its source verbatim — "## Findings", literal
// backticks and all — despite the tool that produces it advertising "lists,
// links, tables". These mount the renderer's output and assert real structure.

import { test, expect, beforeAll } from 'bun:test';
import { Window } from 'happy-dom';

let dd;
let renderMarkdown;
let document;

beforeAll(async () => {
  const win = new Window({ url: 'https://bridle.3sln.com/app/' });
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.navigator = win.navigator;
  globalThis.requestAnimationFrame ??= (fn) => fn();
  document = win.document;
  ({ dd } = await import('../src/runtime.js'));
  ({ renderMarkdown } = await import('../src/lib/markdown.js'));
});

function render(md) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  dd.reconcile(root, renderMarkdown(md));
  return root;
}

test('headings, lists and inline marks become elements, not text', () => {
  const root = render('## Findings\n\n- one\n- **two**\n\n1. first\n2. second\n\nplain `code` here');
  expect(root.querySelector('.md-h')?.textContent).toBe('Findings');
  expect(root.textContent).not.toContain('##');
  expect([...root.querySelectorAll('ul.md-list li')].map((li) => li.textContent)).toEqual(['one', 'two']);
  expect(root.querySelector('ul.md-list strong')?.textContent).toBe('two');
  expect(root.querySelectorAll('ol.md-list li').length).toBe(2);
  expect(root.querySelector('code.md-code')?.textContent).toBe('code');
  expect(root.textContent).not.toContain('`');
});

test('fenced code keeps its newlines and is not parsed as markdown', () => {
  const root = render('before\n\n```js\nconst a = *1*;\n# not a heading\n```\n\nafter');
  const pre = root.querySelector('pre.md-pre');
  expect(pre.textContent).toBe('const a = *1*;\n# not a heading');
  expect(pre.querySelector('em')).toBeNull();
  expect(root.querySelectorAll('.md-p').length).toBe(2);
});

test('tables render as tables', () => {
  const root = render('| name | count |\n| --- | ---: |\n| a | 1 |\n| b | 2 |');
  expect([...root.querySelectorAll('th')].map((c) => c.textContent)).toEqual(['name', 'count']);
  expect(root.querySelectorAll('tbody tr').length).toBe(2);
  expect(root.textContent).not.toContain('|');
});

test('links are rendered, and only for schemes a tap should follow', () => {
  const root = render('see [docs](https://example.com/x) and [mail](mailto:a@b.c)');
  const hrefs = [...root.querySelectorAll('a')].map((a) => a.getAttribute('href'));
  expect(hrefs).toEqual(['https://example.com/x', 'mailto:a@b.c']);
  expect(root.querySelector('a').getAttribute('rel')).toContain('noopener');

  // The agent's context can contain things it merely read somewhere.
  const hostile = render('[tap me](javascript:alert(1)) [x](data:text/html,<script>)');
  expect(hostile.querySelectorAll('a').length).toBe(0);
  expect(hostile.textContent).toContain('tap me'); // shown, not silently dropped
});

test('unsupported or malformed syntax degrades to text rather than vanishing', () => {
  const root = render('a **stray marker and <not html> & an ampersand');
  expect(root.textContent).toContain('**stray marker');
  expect(root.textContent).toContain('<not html>');
  expect(root.querySelector('script')).toBeNull();
  expect(render('').childNodes.length).toBe(0);
  expect(render(null).childNodes.length).toBe(0);
});

test('a paragraph does not swallow the block that follows it', () => {
  const root = render('intro line\n## Heading\ntail line');
  expect(root.querySelector('.md-h')?.textContent).toBe('Heading');
  expect([...root.querySelectorAll('.md-p')].map((p) => p.textContent)).toEqual(['intro line', 'tail line']);
});

test('speech gets prose, not syntax', async () => {
  const { markdownToSpeech } = await import('../src/lib/markdown.js');
  const spoken = markdownToSpeech('## Findings\n\n- **one** thing\n- see [the docs](https://x.test/y)\n\n`npm test`\n\n```\nconst a = 1;\n```');
  expect(spoken).not.toMatch(/[#*`[\]()]/);
  expect(spoken).toContain('Findings');
  expect(spoken).toContain('one thing');
  expect(spoken).toContain('the docs');
  expect(spoken).not.toContain('https://');
  expect(spoken).toContain('code block'); // announced, not read out line by line
  expect(markdownToSpeech('| a | b |\n| --- | --- |\n| 1 | 2 |')).toBe('a, b\n1, 2');
});
