// Node/Bun adapter — proves the signaling core is NOT Cloudflare-bound. Runs the
// exact same `SignalingRoom` over Bun's WebSocket server and serves the built
// PWA from disk. Useful for local dev, self-hosting, or pointing the desktop at
// its own signaling so the public backend can be skipped entirely.
//
//   bun src/dev-server.js [--port 8787] [--assets ../pwa/dist]

import { SignalingRoom } from './signaling-room.js';
import { isValidRoomCode } from '@bridle/protocol/signaling';

// One in-memory hub of rooms, keyed by code. Garbage-collected when empty.
const rooms = new Map();
function roomFor(code) {
  let room = rooms.get(code);
  if (!room) {
    room = new SignalingRoom(code);
    rooms.set(code, room);
  }
  return room;
}

function argFlag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const port = Number(argFlag('--port', process.env.PORT || 8787));
const assetsDir = argFlag('--assets', new URL('../../pwa/dist', import.meta.url).pathname);

const server = Bun.serve({
  port,
  async fetch(request, server) {
    const url = new URL(request.url);

    if (url.pathname === '/healthz') return new Response('ok');

    if (url.pathname === '/signal') {
      const code = url.searchParams.get('room') || '';
      const role = url.searchParams.get('role') || '';
      if (!isValidRoomCode(code) || (role !== 'host' && role !== 'guest')) {
        return new Response('bad request', { status: 400 });
      }
      // Stash the role/code; the peer wrapper is built in `open`.
      if (server.upgrade(request, { data: { code, role } })) return undefined;
      return new Response('expected websocket', { status: 426 });
    }

    // Static assets with SPA fallback.
    return serveStatic(url.pathname, assetsDir);
  },
  websocket: {
    open(ws) {
      const { code, role } = ws.data;
      const room = roomFor(code);
      const peer = {
        role,
        send: (obj) => ws.send(JSON.stringify(obj)),
        close: (c = 1000, r = '') => ws.close(c, r),
      };
      ws.data.peer = peer;
      ws.data.room = room;
      room.add(peer);
    },
    message(ws, raw) {
      let msg;
      try {
        msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
      } catch {
        return;
      }
      if (msg && msg.t) ws.data.room.onMessage(ws.data.peer, msg);
    },
    close(ws) {
      const { room, peer, code } = ws.data;
      if (room && peer) {
        room.remove(peer);
        if (room.isEmpty) rooms.delete(code);
      }
    },
  },
});

async function serveStatic(pathname, dir) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  let file = Bun.file(dir + rel);
  if (!(await file.exists())) {
    // SPA fallback so deep links resolve to the app shell.
    file = Bun.file(dir + '/index.html');
    if (!(await file.exists())) return new Response('PWA not built (run build:pwa)', { status: 404 });
  }
  return new Response(file);
}

console.log(`tether signaling + PWA on http://localhost:${server.port}`);
console.log(`serving assets from ${assetsDir}`);
