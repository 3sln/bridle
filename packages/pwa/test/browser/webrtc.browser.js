// End-to-end WebRTC + link-protocol test in a real browser. Uses the production
// GuestPeer (the phone's native-RTCPeerConnection offerer) against a plain
// RTCPeerConnection answerer, wired directly in-page (no signaling server), and
// round-trips real link frames over the data channel on loopback. Proves the
// browser half of the tether actually connects — the desktop half is covered by
// the werift node E2E (packages/desktop/test/e2e.test.js).
import { GuestPeer } from '../../src/providers/peer.js';
import { encode, decode, text } from '@bridle/protocol/link';
import { assert, waitFor } from './_helpers.js';

const gather = async (pc, ms = 4000) => {
  if (pc.iceGatheringState === 'complete') return;
  await new Promise((res) => {
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', onChange);
        res();
      }
    };
    pc.addEventListener('icegatheringstatechange', onChange);
    setTimeout(res, ms);
  });
};

describe('browser WebRTC data channel + link protocol', () => {
  it('GuestPeer connects over loopback and round-trips link frames both ways', async () => {
    const guest = new GuestPeer({ iceServers: [] }); // host candidates only — loopback
    const answerer = new RTCPeerConnection({ iceServers: [] });

    let answererCh = null;
    let answererGot = null;
    let guestGot = null;
    let opened = false;

    answerer.ondatachannel = (e) => {
      answererCh = e.channel;
      answererCh.onmessage = (ev) => { answererGot = decode(ev.data); };
    };
    guest.addEventListener('open', () => { opened = true; });
    guest.addEventListener('message', (e) => { guestGot = e.detail.msg; });

    // GuestPeer is the offerer and gathers ICE fully before returning the SDP.
    const offerSdp = await guest.makeOffer();
    await answerer.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    await answerer.setLocalDescription(await answerer.createAnswer());
    await gather(answerer);
    await guest.accept({ kind: 'answer', sdp: answerer.localDescription.sdp });

    // The channel must actually open — the real connectivity check.
    assert(await waitFor(() => opened && answererCh && answererCh.readyState === 'open'),
      'data channel never opened on loopback');

    // Guest → answerer.
    guest.send(text('ping from guest'));
    assert(await waitFor(() => answererGot), 'answerer never received a frame');
    assert(answererGot.text === 'ping from guest', `unexpected frame: ${JSON.stringify(answererGot)}`);

    // Answerer → guest.
    answererCh.send(encode(text('pong from host')));
    assert(await waitFor(() => guestGot), 'guest never received a frame');
    assert(guestGot.text === 'pong from host', `unexpected frame: ${JSON.stringify(guestGot)}`);

    guest.close();
    answerer.close();
  });
});
