// Signaling protocol — messages exchanged between a peer and the signaling
// relay (our Cloudflare Worker, or any other transport). The relay is
// deliberately "dumb": it tracks at most two peers per room (by role) and
// forwards `signal` payloads to the *other* peer verbatim. All WebRTC
// negotiation lives in the peers; the relay never inspects SDP/ICE.
//
// Every message is a plain JSON object with a `t` (type) discriminator so it
// can travel over any text transport (WebSocket, SSE+POST, long-poll, ...).

/** @typedef {'host'|'guest'} Role */

export const ROLE = Object.freeze({ HOST: 'host', GUEST: 'guest' });

export const SIGNAL = Object.freeze({
  // peer -> relay
  JOIN: 'join', // { t, room, role }
  LEAVE: 'leave', // { t }
  SIGNAL: 'signal', // { t, data }  (relayed verbatim to the other peer)
  // relay -> peer
  JOINED: 'joined', // { t, room, role, peers: Role[] }
  PEER_JOIN: 'peer-join', // { t, role }
  PEER_LEAVE: 'peer-leave', // { t, role }
  ERROR: 'error', // { t, code, message }
});

/** Inner `data` kinds carried by a SIGNAL message. */
export const SIGNAL_KIND = Object.freeze({
  OFFER: 'offer', // { kind, sdp }
  ANSWER: 'answer', // { kind, sdp }
  ICE: 'ice', // { kind, candidate }
});

export const otherRole = (role) =>
  role === ROLE.HOST ? ROLE.GUEST : ROLE.HOST;

// ---- message factories (keep call sites terse + typo-proof) -----------------

export const join = (room, role) => ({ t: SIGNAL.JOIN, room, role });
export const leave = () => ({ t: SIGNAL.LEAVE });
export const signal = (data) => ({ t: SIGNAL.SIGNAL, data });
export const joined = (room, role, peers) => ({ t: SIGNAL.JOINED, room, role, peers });
export const peerJoin = (role) => ({ t: SIGNAL.PEER_JOIN, role });
export const peerLeave = (role) => ({ t: SIGNAL.PEER_LEAVE, role });
export const error = (code, message) => ({ t: SIGNAL.ERROR, code, message });

export const offer = (sdp) => ({ kind: SIGNAL_KIND.OFFER, sdp });
export const answer = (sdp) => ({ kind: SIGNAL_KIND.ANSWER, sdp });
export const ice = (candidate) => ({ kind: SIGNAL_KIND.ICE, candidate });

// ---- room codes -------------------------------------------------------------
// Short, unambiguous, case-insensitive codes for QR/manual entry. Crockford
// base32 minus the easily-confused characters. We do not use Math.random's
// quality assumptions for anything security-sensitive — the room code only has
// to be unguessable enough to avoid casual collisions; pair authentication is
// handled by the one-time token (see tether.js hello handshake).

const ROOM_ALPHABET = '23456789abcdefghjkmnpqrstvwxyz';

/**
 * @param {() => number} [rng] inject randomness (crypto in prod, seedable in tests)
 */
export function makeRoomCode(length = 6, rng = defaultRng) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ROOM_ALPHABET[Math.floor(rng() * ROOM_ALPHABET.length)];
  }
  return out;
}

function defaultRng() {
  // Prefer a CSPRNG when present (browser + bun + workers all expose it).
  const c = globalThis.crypto;
  if (c && c.getRandomValues) {
    const a = new Uint32Array(1);
    c.getRandomValues(a);
    return a[0] / 2 ** 32;
  }
  return Math.random();
}

export const isValidRoomCode = (code) =>
  typeof code === 'string' &&
  code.length >= 4 &&
  code.length <= 16 &&
  [...code].every((ch) => ROOM_ALPHABET.includes(ch));
