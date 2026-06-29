// Desktop WebRTC peer (the "host"/answerer). Uses werift — a pure-JS WebRTC
// stack — so the desktop binary stays a single `bun build --compile` artifact
// with no native .node addons to ship.
//
// werift exposes rx-style events (`.subscribe(...)`) rather than DOM `on*`
// handlers; verified against werift's datachannel example. We use vanilla
// (non-trickle) ICE: gather fully, then hand the complete SDP to signaling.
// That keeps the relay to a single offer/answer round-trip. The guest (phone)
// is the offerer and creates the data channel; we answer and accept it.

import { RTCPeerConnection } from 'werift';
import { encode, decode } from '@bridle/protocol/link';

export class HostPeer extends EventTarget {
  /** @param {{ iceServers: RTCIceServer[] }} opts */
  constructor({ iceServers }) {
    super();
    this.pc = new RTCPeerConnection({ iceServers });
    this.channel = null;
    this.#wire();
  }

  #wire() {
    // The guest created the data channel; accept it when it arrives.
    this.pc.onDataChannel.subscribe((channel) => {
      this.channel = channel;
      this.#wireChannel(channel);
    });
    this.pc.iceConnectionStateChange.subscribe((state) =>
      this.emit('state', { state }),
    );
  }

  #wireChannel(channel) {
    channel.stateChanged.subscribe((state) => {
      if (state === 'open') this.emit('open', {});
      if (state === 'closed') this.emit('closed', {});
    });
    channel.onMessage.subscribe((data) => {
      // String frames are control/text JSON; binary frames are audio bytes.
      if (typeof data === 'string') {
        try {
          this.emit('message', { msg: decode(data) });
        } catch (err) {
          this.emit('error', { message: `bad link frame: ${err.message}` });
        }
      } else {
        // werift hands binary as a Buffer/Uint8Array.
        this.emit('binary', { chunk: data });
      }
    });
  }

  /**
   * Handle an inbound signaling payload from the guest. Returns an answer SDP
   * to relay back (for an offer), otherwise null.
   */
  async accept(data) {
    if (data.kind === 'offer') {
      await this.pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
      await this.pc.setLocalDescription(await this.pc.createAnswer());
      await this.#waitForGathering();
      return this.pc.localDescription.sdp;
    }
    if (data.kind === 'ice' && data.candidate) {
      // Tolerated for forward-compat if the guest trickles; vanilla ICE won't.
      try {
        await this.pc.addIceCandidate(data.candidate);
      } catch {
        /* ignore late/duplicate candidates */
      }
    }
    return null;
  }

  #waitForGathering() {
    if (this.pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const sub = this.pc.iceGatheringStateChange.subscribe((state) => {
        if (state === 'complete') {
          sub?.unsubscribe?.();
          resolve();
        }
      });
      // Don't hang forever if a relay candidate is slow; host candidates are
      // usually enough to connect on a LAN / via TURN shortly after.
      setTimeout(() => {
        sub?.unsubscribe?.();
        resolve();
      }, 5000);
    });
  }

  send(msg) {
    if (this.channel && this.channel.readyState === 'open') {
      this.channel.send(encode(msg));
      return true;
    }
    return false;
  }

  close() {
    try {
      this.channel?.close?.();
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
