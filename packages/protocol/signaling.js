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

// WebSocket close codes the relay uses. SUPERSEDED means a newer connection for
// the same role took over — the old one must NOT reconnect (it would just evict
// the new one back). BAD_ROOM is fatal; the rest reconnect with backoff.
export const CLOSE = Object.freeze({
  BAD_ROOM: 4000,
  ROLE_TAKEN: 4001, // legacy: role busy (superseded now replaces this path)
  SUPERSEDED: 4002,
});

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

// ---- room tokens ------------------------------------------------------------
// The value in the QR/URL (`#room=…`) is BOTH the signaling address and the
// first-contact secret: anyone holding it can take the guest slot and reach the
// host, whose input is piped to your agent. So it must be a real high-entropy
// token, not a short human code — a 6-char code (~29 bits) is brute-forceable
// and was the channel's only gate. `makeToken()` produces ~128 bits from the
// CSPRNG. A persistent device pin (TOFU, see the HELLO handshake) is the second
// factor that protects an already-paired tether if the token later leaks.
//
// Alphabet: Crockford base32 minus easily-confused characters, so a token is
// still case-insensitive and safe to read aloud / type if ever needed.

const ROOM_ALPHABET = '23456789abcdefghjkmnpqrstvwxyz';
export const TOKEN_LENGTH = 26; // 26 * log2(30) ≈ 128 bits

/**
 * @param {() => number} [rng] inject randomness (crypto in prod, seedable in tests)
 */
export function makeRoomCode(length = TOKEN_LENGTH, rng = defaultRng) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ROOM_ALPHABET[Math.floor(rng() * ROOM_ALPHABET.length)];
  }
  return out;
}

/** A full-entropy room token — the default for a new tether. */
export const makeToken = (rng = defaultRng) => makeRoomCode(TOKEN_LENGTH, rng);

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

// Min 4 keeps legacy short rooms working; max 64 admits full-entropy tokens.
export const isValidRoomCode = (code) =>
  typeof code === 'string' &&
  code.length >= 4 &&
  code.length <= 64 &&
  [...code].every((ch) => ROOM_ALPHABET.includes(ch));
