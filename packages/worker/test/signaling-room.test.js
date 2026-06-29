import { test, expect } from 'bun:test';
import { SignalingRoom } from '../src/signaling-room.js';

function fakePeer(role) {
  return { role, sent: [], closed: null, send(m) { this.sent.push(m); }, close(c, r) { this.closed = { c, r }; } };
}

test('admits host then guest and announces the join', () => {
  const room = new SignalingRoom('abc123');
  const host = fakePeer('host');
  const guest = fakePeer('guest');

  expect(room.add(host)).toBe(true);
  expect(host.sent[0].t).toBe('joined');

  expect(room.add(guest)).toBe(true);
  // the host is told a peer joined
  expect(host.sent.some((m) => m.t === 'peer-join' && m.role === 'guest')).toBe(true);
});

test('rejects a duplicate role', () => {
  const room = new SignalingRoom('abc123');
  expect(room.add(fakePeer('host'))).toBe(true);
  const host2 = fakePeer('host');
  expect(room.add(host2)).toBe(false);
  expect(host2.closed.c).toBe(4001);
});

test('relays signal payloads to the other peer only', () => {
  const room = new SignalingRoom('abc123');
  const host = fakePeer('host');
  const guest = fakePeer('guest');
  room.add(host);
  room.add(guest);

  room.onMessage(guest, { t: 'signal', data: { kind: 'offer', sdp: 'x' } });
  const relayed = host.sent.find((m) => m.t === 'signal');
  expect(relayed.data.sdp).toBe('x');
  // guest should not receive its own offer back
  expect(guest.sent.some((m) => m.t === 'signal')).toBe(false);
});

test('removing a peer notifies the other', () => {
  const room = new SignalingRoom('abc123');
  const host = fakePeer('host');
  const guest = fakePeer('guest');
  room.add(host);
  room.add(guest);
  room.remove(guest);
  expect(host.sent.some((m) => m.t === 'peer-leave' && m.role === 'guest')).toBe(true);
  expect(room.isEmpty).toBe(false);
  room.remove(host);
  expect(room.isEmpty).toBe(true);
});
