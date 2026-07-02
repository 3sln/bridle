// Host-side signaling client. Connects to the relay as the `host` peer and
// surfaces the relay events the session needs. Role + room travel in the URL,
// so there is no separate join message — the relay admits us on connect.
//
// Uses the global WebSocket (present in Bun, browsers, and Workers), so this
// same shape works anywhere; only the URL differs.

import { SIGNAL, CLOSE } from '@bridle/protocol/signaling';

export class SignalingClient extends EventTarget {
  /** @param {{ url: string, room: string, role?: 'host'|'guest' }} opts */
  constructor({ url, room, role = 'host' }) {
    super();
    this.baseUrl = url;
    this.room = room;
    this.role = role;
    this.ws = null;
    this.closedByUs = false;
    this.retry = 0;
    this.roleRetries = 0;
  }

  connect() {
    this.closedByUs = false;
    const wsUrl = toWsUrl(this.baseUrl, this.room, this.role);
    this.ws = new WebSocket(wsUrl);
    this.ws.onopen = () => {
      this.retry = 0;
      this.roleRetries = 0;
      this.emit('open', {});
    };
    this.ws.onclose = (e) => {
      this.emit('close', { code: e.code, reason: e.reason });
      if (this.closedByUs || e.code === CLOSE.BAD_ROOM) return; // deliberate close, or bad room (fatal)
      // Superseded: a newer host claimed this room (e.g. a fresh server instance).
      // This one is obsolete — stop, don't fight for the slot.
      if (e.code === CLOSE.SUPERSEDED) return;
      // 4001 = role taken. On the pair→daemon handoff the foreground still holds
      // the host slot for a moment; retry quickly (bounded) so the daemon claims
      // it the instant the foreground leaves, instead of giving up and stranding
      // the phone on "waiting for desktop".
      if (e.code === CLOSE.ROLE_TAKEN) {
        if (this.roleRetries++ >= 40) return; // ~20s, then stop fighting for the slot
        setTimeout(() => !this.closedByUs && this.connect(), 500);
        return;
      }
      // Otherwise the daemon must stay available — reconnect with capped backoff.
      const delay = Math.min(30000, 500 * 2 ** this.retry++);
      setTimeout(() => !this.closedByUs && this.connect(), delay);
    };
    this.ws.onerror = () => this.emit('error', { message: 'signaling socket error' });
    this.ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      switch (msg.t) {
        case SIGNAL.JOINED:
          this.emit('joined', msg);
          break;
        case SIGNAL.PEER_JOIN:
          this.emit('peer-join', msg);
          break;
        case SIGNAL.PEER_LEAVE:
          this.emit('peer-leave', msg);
          break;
        case SIGNAL.SIGNAL:
          this.emit('signal', { data: msg.data });
          break;
        case SIGNAL.ERROR:
          this.emit('relay-error', msg);
          break;
        default:
          break;
      }
    };
  }

  /** Send a WebRTC negotiation payload ({kind, sdp|candidate}) to the other peer. */
  sendSignal(data) {
    this.ws?.send(JSON.stringify({ t: SIGNAL.SIGNAL, data }));
  }

  close() {
    this.closedByUs = true;
    try {
      this.ws?.close(1000, 'session ended');
    } catch {
      /* already closed */
    }
    this.ws = null;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

function toWsUrl(base, room, role) {
  const u = new URL(base);
  u.protocol = u.protocol === 'https:' ? 'wss:' : u.protocol === 'http:' ? 'ws:' : u.protocol;
  u.pathname = '/signal';
  u.search = `?room=${encodeURIComponent(room)}&role=${encodeURIComponent(role)}`;
  return u.toString();
}
