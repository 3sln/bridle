// Host-side signaling client. Connects to the relay as the `host` peer and
// surfaces the relay events the session needs. Role + room travel in the URL,
// so there is no separate join message — the relay admits us on connect.
//
// Uses the global WebSocket (present in Bun, browsers, and Workers), so this
// same shape works anywhere; only the URL differs.

import { SIGNAL } from '@bridle/protocol/signaling';

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
  }

  connect() {
    this.closedByUs = false;
    const wsUrl = toWsUrl(this.baseUrl, this.room, this.role);
    this.ws = new WebSocket(wsUrl);
    this.ws.onopen = () => {
      this.retry = 0;
      this.emit('open', {});
    };
    this.ws.onclose = (e) => {
      this.emit('close', { code: e.code, reason: e.reason });
      // The daemon must stay available — reconnect with capped backoff unless we
      // closed on purpose, or the relay rejected us (role taken / bad room).
      if (!this.closedByUs && e.code !== 4001 && e.code !== 4000) {
        const delay = Math.min(30000, 500 * 2 ** this.retry++);
        setTimeout(() => !this.closedByUs && this.connect(), delay);
      }
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
