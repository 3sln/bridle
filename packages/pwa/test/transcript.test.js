import { test, expect } from 'bun:test';
import { meaningfulTranscript } from '../src/lib/transcript.js';

test('drops blank-audio / silence / sound tags', () => {
  for (const noise of ['[BLANK_AUDIO]', '[ Silence ]', '[Music]', '(buzzing)', '  [ pause ] ', '♪', '<noise>']) {
    expect(meaningfulTranscript(noise)).toBe('');
  }
});

test('drops punctuation / symbol-only output', () => {
  for (const junk of ['', '   ', '...', '。', '- -', '!?']) {
    expect(meaningfulTranscript(junk)).toBe('');
  }
});

test('drops stock hallucination phrases', () => {
  expect(meaningfulTranscript('Thanks for watching!')).toBe('');
  expect(meaningfulTranscript('  please subscribe. ')).toBe('');
});

test('keeps real speech and strips embedded tags', () => {
  expect(meaningfulTranscript('run the tests')).toBe('run the tests');
  expect(meaningfulTranscript('[BLANK_AUDIO] open the file')).toBe('open the file');
  expect(meaningfulTranscript('stop')).toBe('stop');
  expect(meaningfulTranscript('yes')).toBe('yes'); // short real words survive
});
