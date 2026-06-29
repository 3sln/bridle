// Platform-agnostic HTTP entry. Pure function of the request plus two injected
// capabilities, so the same routing works on Cloudflare, Node, Bun, Deno —
// only the adapters differ:
//
//   routeSignal(request, room, role) -> Response   // hand off a WS upgrade
//   serveAsset(request)              -> Response    // serve the built PWA
//
// Nothing Cloudflare-specific lives here. See `worker.js` for the CF wiring and
// `dev-server.js` for the Node/Bun wiring.

import { isValidRoomCode } from '@bridle/protocol/signaling';
import { INSTALL_SH, INSTALL_PS1, INSTALL_HELP } from './install-scripts.js';

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

const text = (body, type = 'text/plain; charset=utf-8') =>
  new Response(body, { headers: { 'content-type': type, 'cache-control': 'public, max-age=300' } });

export async function handleRequest(request, { routeSignal, serveAsset }) {
  const url = new URL(request.url);

  // Health check — handy for uptime probes and `wrangler tail` sanity.
  if (url.pathname === '/healthz') return json({ ok: true });

  // Install scripts (curl … | sh  /  irm … | iex). Explicit routes so they
  // never get the SPA fallback and carry the right content-type.
  if (url.pathname === '/install.sh') return text(INSTALL_SH, 'text/x-shellscript; charset=utf-8');
  if (url.pathname === '/install.ps1') return text(INSTALL_PS1, 'text/plain; charset=utf-8');
  if (url.pathname === '/install') return text(INSTALL_HELP);

  // Signaling endpoint: a WebSocket upgrade carrying ?room=CODE&role=host|guest
  if (url.pathname === '/signal') {
    const room = url.searchParams.get('room') || '';
    const role = url.searchParams.get('role') || '';
    if (!isValidRoomCode(room)) return json({ error: 'invalid room code' }, 400);
    if (role !== 'host' && role !== 'guest') return json({ error: 'invalid role' }, 400);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return json({ error: 'expected websocket upgrade' }, 426);
    }
    return routeSignal(request, room, role);
  }

  // Everything else is the PWA (with SPA fallback handled by the asset adapter).
  return serveAsset(request);
}
