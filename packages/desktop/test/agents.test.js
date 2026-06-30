import { test, expect } from 'bun:test';
import { resolveAgent, genericProfile } from '../src/agents.js';

test('resolves a known agent by id', () => {
  const p = resolveAgent({ id: 'claude' });
  expect(p.id).toBe('claude');
  expect(p.mode).toBe('oneshot');
});

test('a bare known command maps to its tuned profile', () => {
  expect(resolveAgent({ command: ['codex'] }).id).toBe('codex');
});

test('an arbitrary command becomes a generic pipe profile', () => {
  const p = resolveAgent({ command: ['mytool', '--flag'] });
  expect(p.mode).toBe('pipe');
  expect(p.command).toEqual(['mytool', '--flag']);
});

test('claude threads an explicit session id: create then resume', () => {
  const claude = resolveAgent({ id: 'claude' });
  const create = claude.turn({ prompt: 'hi', first: true, sessionId: 'abc-123' });
  expect(create.args).toEqual(['-p', '--session-id', 'abc-123', 'hi']);
  const resume = claude.turn({ prompt: 'more', first: false, sessionId: 'abc-123' });
  expect(resume.args).toEqual(['-p', '--resume', 'abc-123', 'more']);
});

test('codex resumes by id, or --last when unknown', () => {
  const codex = resolveAgent({ id: 'codex' });
  expect(codex.turn({ prompt: 'p', first: true, sessionId: null }).args).toEqual(['exec', 'p']);
  expect(codex.turn({ prompt: 'p', first: false, sessionId: 'sid' }).args).toEqual(['exec', 'resume', 'sid', 'p']);
  expect(codex.turn({ prompt: 'p', first: false, sessionId: null }).args).toEqual(['exec', 'resume', '--last', 'p']);
});

test('generic profile streams stderr and lists no sessions', () => {
  const p = genericProfile(['foo']);
  expect(p.streamStderr).toBe(true);
  expect(p.listSessions()).toEqual([]);
});
