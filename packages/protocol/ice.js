// Default ICE configuration. STUN handles the common case; a public TURN relay
// is the fallback for symmetric-NAT / restrictive networks (the "when needed"
// path the spec calls out). Defaults are overridable everywhere — nothing here
// is Cloudflare-specific, and a deployment can supply its own TURN (incl.
// Cloudflare TURN, Twilio NTS, coturn, ...) via config/providers.
//
// The well-known free relay is the Open Relay Project (metered.ca). It is
// best-effort and rate-limited — fine for getting started, swap for your own
// for anything sustained.

export const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

export const OPEN_RELAY_TURN = [
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

export const DEFAULT_ICE_SERVERS = [...STUN_SERVERS, ...OPEN_RELAY_TURN];

/**
 * Build an RTCConfiguration. Pass `{ turn: false }` to use STUN only, or
 * `{ iceServers }` to fully override.
 */
export function iceConfig({ iceServers, turn = true } = {}) {
  if (iceServers) return { iceServers };
  return { iceServers: turn ? DEFAULT_ICE_SERVERS : STUN_SERVERS };
}
