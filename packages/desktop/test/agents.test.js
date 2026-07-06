import { test, expect } from 'bun:test';
import { resolveAgent, genericProfile, normalizeCustomProfile } from '../src/agents.js';

test('a custom oneshot profile builds turn args from templates', () => {
  const p = normalizeCustomProfile('mycli', {
    label: 'My CLI',
    command: ['mycli'],
    promptArgs: ['-p', '{prompt}'],
    resumeArgs: ['-p', '--resume', '{session}', '{prompt}'],
  });
  expect(p.id).toBe('mycli');
  expect(p.mode).toBe('oneshot');
  expect(p.turn({ prompt: 'hi', first: true }).args).toEqual(['-p', 'hi']);
  expect(p.turn({ prompt: 'more', first: false, sessionId: 'abc' }).args).toEqual(['-p', '--resume', 'abc', 'more']);
});

test('claude declares a permission-prompt-tool hook', () => {
  const claude = resolveAgent({ id: 'claude' });
  expect(claude.permissionPromptTool('mcp__bridle__permission')).toEqual(['--permission-prompt-tool', 'mcp__bridle__permission']);
  expect(claude.modes.auto).toEqual(['--permission-mode', 'auto']);
});

test('a custom pipe profile needs no templates', () => {
  const p = normalizeCustomProfile('raw', { command: ['raw-cli', '--stdin'], mode: 'pipe' });
  expect(p.mode).toBe('pipe');
  expect(p.command).toEqual(['raw-cli', '--stdin']);
  expect(p.turn).toBeUndefined();
});

test('resolves a known agent by id', () => {
  const p = resolveAgent({ id: 'claude' });
  expect(p.id).toBe('claude');
  expect(p.mode).toBe('stream-json');
});

test('a bare known command maps to its tuned profile', () => {
  expect(resolveAgent({ command: ['codex'] }).id).toBe('codex');
});

test('an arbitrary command becomes a generic pipe profile', () => {
  const p = resolveAgent({ command: ['mytool', '--flag'] });
  expect(p.mode).toBe('pipe');
  expect(p.command).toEqual(['mytool', '--flag']);
});

test('claude binds a streaming process to an explicit session: create then resume', () => {
  const claude = resolveAgent({ id: 'claude' });
  expect(claude.stream.sessionArgs({ first: true, sessionId: 'abc-123' })).toEqual(['--session-id', 'abc-123']);
  expect(claude.stream.sessionArgs({ first: false, sessionId: 'abc-123' })).toEqual(['--resume', 'abc-123']);
  const msg = JSON.parse(claude.stream.encode('hi').trim());
  expect(msg).toEqual({ type: 'user', message: { role: 'user', content: 'hi' } });
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
