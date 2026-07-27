// Node/Bun adapter — proves the signaling core is NOT Cloudflare-bound. Runs the
// exact same `SignalingRoom` over Bun's WebSocket server and serves the built
// PWA from disk. Useful for local dev, self-hosting, or pointing the desktop at
// its own signaling so the public backend can be skipped entirely.
//
//   bun src/dev-server.js [--port 8787] [--assets ../pwa/dist]

import { normalize, resolve, sep } from 'node:path';
import { SignalingRoom } from './signaling-room.js';
import { handleRequest } from './app.js';
import { baseIceServers } from './turn.js';

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
  // Routing is the shared, platform-neutral `handleRequest` — the same one the
  // Cloudflare Worker uses. Only the three adapters below differ, so dev can't
  // drift from production (it used to re-implement the routes and, among other
  // things, had no /install.sh and served the landing page for `/app/`).
  async fetch(request, server) {
    return handleRequest(request, {
      // Stash the role/code; the peer wrapper is built in `open`.
      routeSignal: (req, code, role) => {
        if (server.upgrade(req, { data: { code, role } })) return undefined;
        return new Response('expected websocket', { status: 426 });
      },
      serveAsset: (req) => serveStatic(new URL(req.url).pathname, assetsDir),
      // Dev has no Cloudflare TURN secrets, so just the free STUN base.
      issueIce: () => ({ iceServers: baseIceServers(), turn: false, reason: 'dev' }),
    });
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

// Serve a file from the build output, mirroring what Cloudflare's asset handler
// does for us in production: a directory resolves to its index.html (the PWA
// lives at /app/, so this is the app itself, not a nicety), and anything else
// falls back to the shell.
async function serveStatic(pathname, dir) {
  const root = resolve(dir);
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return new Response('bad request', { status: 400 });
  }

  // `..` in a URL must not reach outside the build output — this server is also
  // the self-hosting path, not just a local convenience.
  const target = resolve(root, '.' + normalize(rel));
  if (target !== root && !target.startsWith(root + sep)) {
    return new Response('forbidden', { status: 403 });
  }

  const candidates = rel.endsWith('/') ? [target + sep + 'index.html'] : [target, target + sep + 'index.html'];
  for (const path of candidates) {
    const file = Bun.file(path);
    if (await file.exists()) return new Response(file);
  }

  // SPA fallback so client-routed deep links resolve to the app shell — 200, as
  // Cloudflare's `not_found_handling = "single-page-application"` serves it.
  const shell = Bun.file(root + sep + 'index.html');
  if (!(await shell.exists())) return new Response('PWA not built (run build:pwa)', { status: 404 });
  return new Response(shell);
}

console.log(`tether signaling + PWA on http://localhost:${server.port}`);
console.log(`serving assets from ${assetsDir}`);
