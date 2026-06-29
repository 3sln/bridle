// Transport-neutral signaling room. Knows nothing about WebSockets, Cloudflare
// Durable Objects, or Node — it operates on an abstract `peer`:
//
//   peer = { role: 'host'|'guest', send(obj), close(code?, reason?) }
//
// Responsibilities (intentionally minimal — the relay must stay dumb & cheap):
//   * enforce at most one host + one guest per room
//   * relay `signal` payloads verbatim to the *other* peer
//   * announce peer join/leave so each side knows when to (re)negotiate
//
// All WebRTC negotiation (offer/answer/ICE) happens in the peers; SDP is never
// inspected here.

import { SIGNAL, ROLE, otherRole, error, joined, peerJoin, peerLeave } from '@bridle/protocol/signaling';

export class SignalingRoom {
  /** @param {string} code */
  constructor(code) {
    this.code = code;
    /** @type {Map<'host'|'guest', any>} */
    this.peers = new Map();
  }

  get isEmpty() {
    return this.peers.size === 0;
  }

  /**
   * Admit a peer that has already declared its role. Returns false (and closes
   * the peer) if the role slot is taken.
   */
  add(peer) {
    if (peer.role !== ROLE.HOST && peer.role !== ROLE.GUEST) {
      peer.send(error('bad-role', `unknown role: ${peer.role}`));
      peer.close(4000, 'bad-role');
      return false;
    }
    if (this.peers.has(peer.role)) {
      peer.send(error('role-taken', `role ${peer.role} already present in room ${this.code}`));
      peer.close(4001, 'role-taken');
      return false;
    }

    this.peers.set(peer.role, peer);
    peer.send(joined(this.code, peer.role, [...this.peers.keys()]));

    // Tell the other side someone arrived (its cue to start/redo negotiation).
    const other = this.peers.get(otherRole(peer.role));
    if (other) other.send(peerJoin(peer.role));
    return true;
  }

  /** Relay a `signal` envelope to the opposite peer (verbatim). */
  relay(fromPeer, msg) {
    const other = this.peers.get(otherRole(fromPeer.role));
    if (!other) {
      fromPeer.send(error('no-peer', 'the other peer is not connected'));
      return;
    }
    other.send({ t: SIGNAL.SIGNAL, data: msg.data });
  }

  /** Remove a peer (on disconnect/leave) and notify the other side. */
  remove(peer) {
    if (this.peers.get(peer.role) !== peer) return;
    this.peers.delete(peer.role);
    const other = this.peers.get(otherRole(peer.role));
    if (other) other.send(peerLeave(peer.role));
  }

  /**
   * Dispatch an inbound, already-parsed message from a peer. The transport
   * adapter calls this for every frame after attaching the peer via `add`.
   */
  onMessage(peer, msg) {
    switch (msg.t) {
      case SIGNAL.SIGNAL:
        this.relay(peer, msg);
        break;
      case SIGNAL.LEAVE:
        this.remove(peer);
        peer.close(1000, 'left');
        break;
      // JOIN is handled by the transport adapter (it must know the role before
      // `add`); anything else is ignored to keep the relay surface tiny.
      default:
        break;
    }
  }
}
