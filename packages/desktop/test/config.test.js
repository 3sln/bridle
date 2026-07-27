import { test, expect } from 'bun:test';
import { parseArgs, loadConfig } from '../src/config.js';

test('`tether <name> <agent>` names the tether and selects the agent', () => {
  const parsed = parseArgs(['tether', 'My Project', 'codex']);
  expect(parsed.sub).toBe('tether');
  expect(parsed.tetherName).toBe('My Project');
  expect(parsed.agentName).toBe('codex');

  const cfg = loadConfig(parsed, {});
  expect(cfg.name).toBe('My Project');
  expect(cfg.agent.id).toBe('codex');
});

test('no default agent — omitting it yields a null agent (cmdPair errors)', () => {
  const cfg = loadConfig(parseArgs(['tether', 'work']), {});
  expect(cfg.name).toBe('work');
  expect(cfg.agent).toBeNull();
});

test('--mode resolves the profile mode flags', () => {
  const cfg = loadConfig(parseArgs(['tether', 'work', 'claude', '--mode', 'yolo']), {});
  expect(cfg.agent.modeName).toBe('yolo');
  expect(cfg.agent.modeArgs).toEqual(['--dangerously-skip-permissions']);
  // unknown mode surfaces as empty args; cmdPair validates against agent.modes
  const bad = loadConfig(parseArgs(['tether', 'work', 'claude', '--mode', 'nope']), {});
  expect(bad.agent.modeArgs).toEqual([]);
  expect(bad.agent.modes.nope).toBeUndefined();
});

test('bare / unknown → dashboard; explicit help → help', () => {
  expect(parseArgs([]).sub).toBe('default'); // bare `bridle` → tethers + help
  expect(parseArgs(['codex']).sub).toBe('default'); // unknown → dashboard
  expect(parseArgs(['help']).sub).toBe('help');
  expect(parseArgs(['--help']).sub).toBe('help');
  expect(parseArgs(['-h']).sub).toBe('help');
});

test('`tether <name> -- <cmd...>` tethers an arbitrary CLI', () => {
  const cfg = loadConfig(parseArgs(['tether', 'proj', '--', 'my-cli', '--flag']), {});
  expect(cfg.name).toBe('proj');
  expect(cfg.agent.mode).toBe('pipe');
  expect(cfg.agent.command).toEqual(['my-cli', '--flag']);
});

test('default session is a fresh conversation; --resume opts in', () => {
  expect(loadConfig(parseArgs([]), {}).session.fresh).toBe(true);
  expect(loadConfig(parseArgs(['--resume']), {}).session.fresh).toBe(false);
  expect(loadConfig(parseArgs(['--resume']), {}).session.attachLatest).toBe(true);
});

test('a fresh token is high-entropy (not the legacy 6-char code)', () => {
  expect(loadConfig(parseArgs([]), {}).room.length).toBeGreaterThanOrEqual(20);
});

test('an invalid --room is rejected at the point it is chosen', () => {
  // The relay only accepts the token alphabet, so an unusable one used to print
  // a QR and then fail invisibly — the tether sat at "starting" forever.
  expect(() => loadConfig(parseArgs(['tether', 'work', 'claude', '--room', 'DEVROOM']), {})).toThrow(/invalid room token/);
  expect(() => loadConfig(parseArgs(['tether', 'work', 'claude', '--room', 'no']), {})).toThrow(/invalid room token/);
  expect(() => loadConfig(parseArgs(['tether', 'work', 'claude']), { BRIDLE_ROOM: 'l0ts-of-c0nfusables' })).toThrow(/BRIDLE_ROOM/);

  const ok = loadConfig(parseArgs(['tether', 'work', 'claude', '--room', 'devtetherdevtetherdevteth']), {});
  expect(ok.room).toBe('devtetherdevtetherdevteth');
  expect(ok.pwaUrl).toContain('#room=devtetherdevtetherdevteth');
});

test('a generated room token is always valid', () => {
  for (let i = 0; i < 20; i++) {
    expect(() => loadConfig(parseArgs(['tether', 'work', 'claude']), {})).not.toThrow();
  }
});
