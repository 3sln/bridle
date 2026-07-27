import { test, expect } from 'bun:test';
import {
  LINK,
  LEVEL,
  NOTICE_CODE,
  PROTO_VERSION,
  encode,
  decode,
  helloHost,
  notice,
  ready,
  text,
} from '../link.js';

test('the host announces a proto version the guest can branch on', () => {
  // The guest waits for READY only when the desktop is new enough to send one;
  // an older desktop must not leave it stuck on "linking…" forever.
  const hello = helloHost('Claude Code', '/work/proj', 'nonce-1');
  expect(hello.t).toBe(LINK.HELLO);
  expect(hello.proto).toBe(PROTO_VERSION);
  expect(PROTO_VERSION).toBeGreaterThanOrEqual(2);
});

test('READY is the host’s verdict, distinct from its HELLO challenge', () => {
  expect(ready()).toEqual({ t: LINK.READY });
  // HELLO carries the challenge, so it cannot double as an admission.
  expect(helloHost('a', '/b', 'n').nonce).toBe('n');
});

test('a notice can carry a machine-readable reason', () => {
  const plain = notice('heads up');
  expect(plain).toEqual({ t: LINK.NOTICE, level: LEVEL.INFO, text: 'heads up' });
  expect('code' in plain).toBe(false); // absent, not undefined — it goes over the wire

  const refused = notice('nope', LEVEL.ERROR, NOTICE_CODE.UNPAIRED);
  expect(refused.code).toBe(NOTICE_CODE.UNPAIRED);
  expect(decode(encode(refused))).toEqual(refused);
});

test('frames round-trip and malformed ones are rejected', () => {
  expect(decode(encode(text('hi', 'voice')))).toEqual({ t: LINK.TEXT, text: 'hi', source: 'voice' });
  expect(() => decode('{}')).toThrow(/missing type/);
  expect(() => decode('not json')).toThrow();
  expect(() => decode({ t: 'text' })).toThrow(/expects a string frame/);
});
