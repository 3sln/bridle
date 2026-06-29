// Cloudflare Worker entry. Thin wiring only: it injects the two Cloudflare
// capabilities (Durable Object signaling + static asset serving) into the
// platform-agnostic `handleRequest`. To port tether to another platform, write
// a new entry that injects different adapters — the routing and signaling logic
// are untouched.

import { handleRequest } from './app.js';

export { BridleRoom } from './durable-object.js';

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, {
      // Route a WS upgrade to the room's Durable Object (addressed by room code).
      routeSignal: (req, room) => {
        const id = env.SIGNAL_ROOMS.idFromName(room);
        const stub = env.SIGNAL_ROOMS.get(id);
        return stub.fetch(req);
      },
      // Serve the built PWA. `env.ASSETS` is configured with SPA fallback in
      // wrangler.toml (not_found_handling = "single-page-application").
      serveAsset: (req) => env.ASSETS.fetch(req),
    });
  },
};
