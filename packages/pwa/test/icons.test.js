// The icon font is a *subset* — only the glyphs listed in src/ui/icon.js are in
// the shipped woff2. An icon used but not subsetted renders as its ligature name
// ("add_photo_alternate") in the middle of the UI, which is exactly the failure
// the self-hosted font was introduced to end. Nothing at build time notices, so
// this does.

import { test, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { GLYPHS } from '../src/ui/icon.js';

const SRC = join(import.meta.dir, '..', 'src');

function jsFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) jsFiles(path, acc);
    else if (path.endsWith('.js')) acc.push(path);
  }
  return acc;
}

// Glyph names reach `icon()` three ways: literally, through a local helper that
// takes the glyph first (`ctl`/`row`/`action`), or out of a lookup table
// (`{ glyph: 'schedule' }`). Only the FIRST argument is a glyph — the second is
// a class name, so `icon('sync', 'spin')` must not contribute "spin".
const GLYPH_NAME = /'([a-z][a-z_]*)'/g;
const CALL_SITES = /\b(?:icon|ctl|row|action)\(\s*((?:[^,()]|\([^()]*\))*)/g;

function usedGlyphs() {
  const found = new Set();
  for (const path of jsFiles(SRC)) {
    const source = readFileSync(path, 'utf8');
    for (const [, firstArg] of source.matchAll(CALL_SITES)) {
      for (const [, name] of firstArg.matchAll(GLYPH_NAME)) found.add(name);
    }
    for (const [, name] of source.matchAll(/\bglyph:\s*'([a-z][a-z_]*)'/g)) found.add(name);
  }
  return found;
}

test('every glyph the UI renders is in the shipped font subset', () => {
  const missing = [...usedGlyphs()].filter((g) => !GLYPHS.includes(g)).sort();
  expect(missing).toEqual([]);
});

test('the font subset is actually shipped', () => {
  const font = join(import.meta.dir, '..', 'public', 'fonts', 'material-symbols-rounded.woff2');
  expect(statSync(font).size).toBeGreaterThan(1000);
  expect(readFileSync(font).subarray(0, 4).toString('latin1')).toBe('wOF2');
});

test('neither page reaches for a third-party font', () => {
  // Offline-first is the whole pitch, and an icon font on the critical path
  // takes the layout apart when it doesn't arrive.
  for (const page of ['index.html', 'app/index.html']) {
    const html = readFileSync(join(import.meta.dir, '..', page), 'utf8');
    expect(html).not.toContain('fonts.googleapis.com');
    expect(html).not.toContain('fonts.gstatic.com');
  }
  const css = readFileSync(join(SRC, 'styles.css'), 'utf8');
  expect(css).toContain("src: url('/fonts/material-symbols-rounded.woff2')");
  expect(css).not.toContain('https://fonts.');
});

test('the service worker precaches the icon font with the shell', () => {
  const sw = readFileSync(join(import.meta.dir, '..', 'public', 'sw.js'), 'utf8');
  expect(sw).toContain('/fonts/material-symbols-rounded.woff2');
});
