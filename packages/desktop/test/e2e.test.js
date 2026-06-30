// End-to-end tether over real local WebRTC. Wires the production pieces — the
// platform-neutral SignalingRoom relay, the desktop HostPeer (werift answerer),
// and a guest offerer — and drives a full offer/answer through the relay until a
// data channel opens, then round-trips real link-protocol frames both ways.
//
// No STUN/TURN: peers connect over host candidates on loopback, so this runs
// fully offline inside CI/containers. This is the test that proves "the tether
// actually connects", which pure-logic unit tests can't.

import { test, expect } from 'bun:test';
import { RTCPeerConnection } from 'werift';
import { SignalingRoom } from '../../worker/src/signaling-room.js';
import { SIGNAL, offer as mkOffer, answer as mkAnswer } from '@bridle/protocol/signaling';
import { HostPeer } from '../src/peer.js';
import { encode, decode, text } from '@bridle/protocol/link';

const gather = (pc, ms = 5000) =>
  pc.iceGatheringState === 'complete'
    ? Promise.resolve()
    : new Promise((res) => {
        const sub = pc.iceGatheringStateChange.subscribe((s) => {
          if (s === 'complete') {
            sub?.unsubscribe?.();
            res();
          }
        });
        setTimeout(res, ms);
      });

const waitFor = async (cond, ms = 12000, step = 50) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
};

test('guest ↔ desktop host tether: connect over local WebRTC and exchange link frames', async () => {
  const room = new SignalingRoom('roomab');
  const host = new HostPeer({ iceServers: [] });

  let hostGot = null;
  host.addEventListener('message', (e) => { hostGot = e.detail.msg; });

  let guestPc;
  let guestGot = null;

  // Host signaling adapter: an inbound offer is answered by the real HostPeer,
  // and the answer goes back through the relay.
  const hostSig = {
    role: 'host',
    send: async (m) => {
      if (m.t !== SIGNAL.SIGNAL) return; // ignore joined / peer-join envelopes
      const answerSdp = await host.accept(m.data);
      if (answerSdp) room.onMessage(hostSig, { t: SIGNAL.SIGNAL, data: mkAnswer(answerSdp) });
    },
    close() {},
  };

  // Guest signaling adapter: apply the relayed answer to the guest peer.
  const guestSig = {
    role: 'guest',
    send: (m) => {
      if (m.t === SIGNAL.SIGNAL && m.data.kind === 'answer') {
        guestPc.setRemoteDescription({ type: 'answer', sdp: m.data.sdp });
      }
    },
    close() {},
  };

  expect(room.add(hostSig)).toBe(true);
  expect(room.add(guestSig)).toBe(true);

  // Guest is the offerer and owns the data channel (mirrors the browser GuestPeer).
  guestPc = new RTCPeerConnection({ iceServers: [] });
  const guestCh = guestPc.createDataChannel('bridle', { ordered: true });
  guestCh.onMessage.subscribe((d) => {
    try { guestGot = decode(typeof d === 'string' ? d : d.toString()); } catch { /* ignore */ }
  });

  await guestPc.setLocalDescription(await guestPc.createOffer());
  await gather(guestPc);
  room.onMessage(guestSig, { t: SIGNAL.SIGNAL, data: mkOffer(guestPc.localDescription.sdp) });

  // The data channel must actually open — this is the real connectivity check.
  expect(await waitFor(() => guestCh.readyState === 'open')).toBe(true);

  // Guest → host link frame.
  guestCh.send(encode(text('hi host')));
  expect(await waitFor(() => hostGot)).toBe(true);
  expect(hostGot.text).toBe('hi host');

  // Host → guest link frame.
  host.send(text('hi guest'));
  expect(await waitFor(() => guestGot)).toBe(true);
  expect(guestGot.text).toBe('hi guest');

  host.close();
  guestPc.close();
}, 30000);
