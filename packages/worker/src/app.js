// Platform-agnostic HTTP entry. Pure function of the request plus a few injected
// capabilities, so the same routing works on Cloudflare, Node, Bun, Deno —
// only the adapters differ:
//
//   routeSignal(request, room, role) -> Response   // hand off a WS upgrade
//   serveAsset(request)              -> Response    // serve the built PWA
//   issueIce(request)                -> object      // budget-governed ICE servers
//
// Nothing Cloudflare-specific lives here. See `worker.js` for the CF wiring and
// `dev-server.js` for the Node/Bun wiring.

import { isValidRoomCode } from '@bridle/protocol/signaling';
import { INSTALL_SH, INSTALL_PS1, INSTALL_HELP } from './install-scripts.js';

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

const text = (body, type = 'text/plain; charset=utf-8') =>
  new Response(body, { headers: { 'content-type': type, 'cache-control': 'public, max-age=300' } });

// The ICE endpoint is fetched cross-origin when a tether points at a different
// backend than the PWA's origin, so it carries permissive CORS. The response is
// per-request (fresh, short-lived credentials) and must never be cached.
const cors = (res) => {
  res.headers.set('access-control-allow-origin', '*');
  res.headers.set('access-control-allow-methods', 'GET, OPTIONS');
  res.headers.set('access-control-allow-headers', 'content-type');
  res.headers.set('cache-control', 'no-store');
  return res;
};

// The app renders HTML the agent composed (`show_form`, `show_markdown`), and
// the agent's own context can contain things it merely read somewhere. DOMPurify
// and a shadow root handle the markup; this handles the rest of the blast
// radius, and enforces at the browser what the README promises: nothing bridle
// serves loads a script, a font, or an image from anyone else.
//
//   wasm-unsafe-eval  the ONNX runtime behind on-device Whisper
//   'unsafe-inline'   styles only — the form sheet injects a themed stylesheet
//                     and agents write style attributes
//   img/media blob:   assets the agent pushes arrive over the data channel
//   connect https:    a tether names its own backend, and the Whisper weights
//                     come from the HF hub
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' https: wss: blob: data:",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'", // agent forms submit over the data channel; nothing navigates
].join('; ');

function harden(res) {
  // Mutate in place where the runtime allows it (Bun): re-wrapping a
  // file-backed response turns it into a chunked stream and — the part that
  // matters, given the `nosniff` below — drops its content type entirely.
  // Cloudflare's asset responses have immutable headers, so there they are
  // copied across explicitly instead.
  let out = res;
  try {
    out.headers.set('content-security-policy', CSP);
  } catch {
    const headers = new Headers(res.headers);
    headers.set('content-security-policy', CSP);
    out = new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
  out.headers.set('x-content-type-options', 'nosniff');
  out.headers.set('referrer-policy', 'no-referrer');
  return out;
}

export async function handleRequest(request, { routeSignal, serveAsset, issueIce }) {
  const url = new URL(request.url);

  // Health check — handy for uptime probes and `wrangler tail` sanity.
  if (url.pathname === '/healthz') return json({ ok: true });

  // ICE servers (STUN + budget-governed Cloudflare TURN). The PWA calls this
  // per connection so each gets a fresh, short-lived credential.
  if (url.pathname === '/ice') {
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    const result = issueIce ? await issueIce(request) : { iceServers: [] };
    return cors(json(result));
  }

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
  return harden(await serveAsset(request));
}
