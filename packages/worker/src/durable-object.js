// Cloudflare adapter: one Durable Object instance per room. The DO owns the two
// live WebSockets (DOs are the only place Workers can hold stateful, addressable
// connections) and delegates all logic to the platform-neutral SignalingRoom.
//
// This is the *only* file that touches Cloudflare's WebSocket/DO primitives.
// Swap it for `dev-server.js` to run the exact same SignalingRoom on Node/Bun.

import { DurableObject } from 'cloudflare:workers';
import { SIGNAL } from '@bridle/protocol/signaling';
import { SignalingRoom } from './signaling-room.js';

export class BridleRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    /** @type {SignalingRoom} */
    this.room = new SignalingRoom('room');
    // Map from the live WebSocket to its peer wrapper.
    this.peerBySocket = new WeakMap();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get('role');
    const code = url.searchParams.get('room') || this.room.code;
    this.room.code = code;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();
    const peer = this.#wrapSocket(server, role);

    if (!this.room.add(peer)) {
      // `add` already sent an error + closed; nothing more to do.
      return new Response(null, { status: 101, webSocket: client });
    }
    this.peerBySocket.set(server, peer);

    server.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
      } catch {
        return; // ignore non-JSON / binary on the signaling channel
      }
      if (msg && msg.t) this.room.onMessage(peer, msg);
    });

    const teardown = () => {
      this.room.remove(peer);
      this.peerBySocket.delete(server);
    };
    server.addEventListener('close', teardown);
    server.addEventListener('error', teardown);

    return new Response(null, { status: 101, webSocket: client });
  }

  #wrapSocket(socket, role) {
    return {
      role,
      send(obj) {
        try {
          socket.send(JSON.stringify(obj));
        } catch {
          /* socket already closing */
        }
      },
      close(code = 1000, reason = '') {
        try {
          socket.close(code, reason);
        } catch {
          /* already closed */
        }
      },
    };
  }
}

export { SIGNAL };
