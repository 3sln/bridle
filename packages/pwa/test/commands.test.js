import { test, expect } from 'bun:test';
import { parse, CMD } from '../src/bl/commands.js';

test('lead-in word triggers a command', () => {
  expect(parse('bridle pause', { leadIn: 'bridle' })).toEqual({ name: CMD.PAUSE_LISTENING });
  expect(parse('bridle repeat that', { leadIn: 'bridle' })).toEqual({ name: CMD.REPEAT });
  expect(parse('bridle stop conversation', { leadIn: 'bridle' })).toEqual({ name: CMD.STOP_CONVERSATION });
});

test('plain dictation is not a command', () => {
  expect(parse('what is the capital of France', { leadIn: 'bridle' })).toBeNull();
  // "pause" alone, without the lead-in, is dictation (not the pause command)
  expect(parse('pause', { leadIn: 'bridle' })).toBeNull();
});

test('always-on safety commands work without the lead-in', () => {
  expect(parse('stop talking', { leadIn: 'bridle' })).toEqual({ name: CMD.STOP_SPEAKING });
  expect(parse('be quiet', { leadIn: 'bridle' })).toEqual({ name: CMD.STOP_SPEAKING });
});

test('trailing punctuation and case are ignored', () => {
  expect(parse('Bridle, Pause!', { leadIn: 'bridle' })).toEqual({ name: CMD.PAUSE_LISTENING });
});

test('unknown command after lead-in is reported', () => {
  const r = parse('bridle do a barrel roll', { leadIn: 'bridle' });
  expect(r.name).toBe('unknown');
});

test('session commands', () => {
  expect(parse('bridle sessions', { leadIn: 'bridle' })).toEqual({ name: CMD.SESSIONS });
  expect(parse('bridle new session', { leadIn: 'bridle' })).toEqual({ name: CMD.NEW_SESSION });
});

test('connect to a session by number or ordinal', () => {
  expect(parse('bridle connect to session 2', { leadIn: 'bridle' })).toEqual({ name: CMD.CONNECT_SESSION, index: 2 });
  expect(parse('bridle session two', { leadIn: 'bridle' })).toEqual({ name: CMD.CONNECT_SESSION, index: 2 });
  expect(parse('bridle open session number 3', { leadIn: 'bridle' })).toEqual({ name: CMD.CONNECT_SESSION, index: 3 });
});
