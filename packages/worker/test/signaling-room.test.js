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

test('a newer peer supersedes the old one for a role', () => {
  const room = new SignalingRoom('abc123');
  const host1 = fakePeer('host');
  expect(room.add(host1)).toBe(true);

  // The newcomer is admitted; the old host is evicted with the superseded code.
  const host2 = fakePeer('host');
  expect(room.add(host2)).toBe(true);
  expect(host1.closed.c).toBe(4002);
  expect(host2.sent.some((m) => m.t === 'joined')).toBe(true);

  // The evicted socket's later close must NOT announce a false peer-leave.
  const guest = fakePeer('guest');
  room.add(guest);
  room.remove(host1);
  expect(guest.sent.some((m) => m.t === 'peer-leave')).toBe(false);
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
