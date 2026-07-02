// Guest-side signaling client (the phone). Mirrors the desktop client but joins
// as `guest`. Surfaces relay events the connection logic needs; role + room ride
// in the URL so there's no join message.

import { Provider } from '@3sln/ngin';
import { SIGNAL, CLOSE } from '@bridle/protocol/signaling';

export class SignalingClient extends EventTarget {
  constructor({ role = 'guest' } = {}) {
    super();
    this.role = role;
    this.target = null; // { url, room } — set per connect so tethers can switch
    this.ws = null;
    this.closedByUs = false;
    this.retry = 0;
  }

  connect(target) {
    if (target) this.target = target;
    if (!this.target) return;
    this.closedByUs = false;
    this.ws = new WebSocket(toWsUrl(this.target.url, this.target.room, this.role));
    this.ws.onopen = () => {
      this.retry = 0;
      this.emit('open', {});
    };
    this.ws.onclose = (e) => {
      this.emit('close', { code: e.code, reason: e.reason });
      // Don't reconnect on a deliberate close, a bad room, or when superseded (a
      // newer connection took the slot — reconnecting would just evict it).
      const fatal = e.code === CLOSE.BAD_ROOM || e.code === CLOSE.ROLE_TAKEN || e.code === CLOSE.SUPERSEDED;
      if (!this.closedByUs && !fatal) {
        const delay = Math.min(15000, 500 * 2 ** this.retry++);
        setTimeout(() => !this.closedByUs && this.connect(), delay);
      }
    };
    this.ws.onerror = () => this.emit('error', { message: 'signaling error' });
    this.ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      const map = {
        [SIGNAL.JOINED]: 'joined',
        [SIGNAL.PEER_JOIN]: 'peer-join',
        [SIGNAL.PEER_LEAVE]: 'peer-leave',
        [SIGNAL.SIGNAL]: 'signal',
        [SIGNAL.ERROR]: 'relay-error',
      };
      const evt = map[msg.t];
      if (evt) this.emit(evt, evt === 'signal' ? { data: msg.data } : msg);
    };
  }

  sendSignal(data) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ t: SIGNAL.SIGNAL, data }));
    }
  }

  close() {
    this.closedByUs = true;
    try {
      this.ws?.close(1000, 'bye');
    } catch {
      /* noop */
    }
    this.ws = null;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

function toWsUrl(base, room, role) {
  const u = new URL(base);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/signal';
  u.search = `?room=${encodeURIComponent(room)}&role=${encodeURIComponent(role)}`;
  return u.toString();
}

export class SignalingProvider extends Provider {
  async obtain() {
    return new SignalingClient({ role: 'guest' });
  }
}
