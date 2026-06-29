// Guest-side WebRTC peer (the phone) — the offerer. Creates the data channel and
// the offer; the desktop answers. Native browser RTCPeerConnection. Vanilla
// (non-trickle) ICE keeps signaling to one offer/answer round-trip.
//
// Provided as a factory: a fresh peer per connection attempt (peers are
// single-use), so reconnects after sleep/network changes just mint a new one.

import { Provider } from '@3sln/ngin';
import { iceConfig } from '@bridle/protocol/ice';
import { encode, decode } from '@bridle/protocol/link';

export class GuestPeer extends EventTarget {
  constructor({ iceServers }) {
    super();
    this.pc = new RTCPeerConnection(iceConfig({ iceServers }));
    this.channel = this.pc.createDataChannel('bridle', { ordered: true });
    this.#wire();
  }

  #wire() {
    this.channel.onopen = () => this.emit('open', {});
    this.channel.onclose = () => this.emit('closed', {});
    this.channel.onmessage = (e) => {
      if (typeof e.data === 'string') {
        try {
          this.emit('message', { msg: decode(e.data) });
        } catch (err) {
          this.emit('error', { message: `bad link frame: ${err.message}` });
        }
      }
      // Phone never receives binary frames.
    };
    this.pc.oniceconnectionstatechange = () => this.emit('state', { state: this.pc.iceConnectionState });
  }

  /** Create the offer, fully gather ICE, return the SDP to send via signaling. */
  async makeOffer() {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await this.#waitForGathering();
    return this.pc.localDescription.sdp;
  }

  async accept(data) {
    if (data.kind === 'answer') {
      await this.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
    } else if (data.kind === 'ice' && data.candidate) {
      try {
        await this.pc.addIceCandidate(data.candidate);
      } catch {
        /* ignore late candidates */
      }
    }
  }

  #waitForGathering() {
    if (this.pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (this.pc.iceGatheringState === 'complete') {
          this.pc.removeEventListener('icegatheringstatechange', check);
          resolve();
        }
      };
      this.pc.addEventListener('icegatheringstatechange', check);
      setTimeout(resolve, 4000); // don't hang on a slow relay candidate
    });
  }

  send(msg) {
    if (this.channel.readyState === 'open') {
      this.channel.send(encode(msg));
      return true;
    }
    return false;
  }

  close() {
    try {
      this.channel.close();
    } catch {
      /* noop */
    }
    try {
      this.pc.close();
    } catch {
      /* noop */
    }
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

export class PeerProvider extends Provider {
  static deps = ['config'];
  constructor({ config }) {
    super();
    this.config = config;
  }
  async obtain() {
    const cfg = await this.config.obtain();
    return () => new GuestPeer({ iceServers: cfg.iceServers });
  }
}
