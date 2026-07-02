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

import { SIGNAL, ROLE, CLOSE, otherRole, error, joined, peerJoin, peerLeave } from '@bridle/protocol/signaling';

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
   * Admit a peer that has already declared its role. The newest connection for a
   * role SUPERSEDES any older one (a returning phone whose old socket lingered),
   * so joining never fails on a stale occupant.
   */
  add(peer) {
    if (peer.role !== ROLE.HOST && peer.role !== ROLE.GUEST) {
      peer.send(error('bad-role', `unknown role: ${peer.role}`));
      peer.close(CLOSE.BAD_ROOM, 'bad-role');
      return false;
    }

    // Claim the slot first, then evict the old occupant — so its close (which
    // calls remove()) sees the slot already reassigned and stays quiet.
    const old = this.peers.get(peer.role);
    this.peers.set(peer.role, peer);
    if (old && old !== peer) {
      old.send(error('superseded', `a newer ${peer.role} connected to room ${this.code}`));
      old.close(CLOSE.SUPERSEDED, 'superseded');
    }

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
