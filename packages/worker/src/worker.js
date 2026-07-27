// Cloudflare Worker entry. Thin wiring only: it injects the Cloudflare
// capabilities (Durable Object signaling, static asset serving, TURN credential
// issuance) into the platform-agnostic `handleRequest`. To port bridle to
// another platform, write a new entry that injects different adapters — the
// routing, signaling, and TURN-budget logic are untouched.

import { handleRequest } from './app.js';
import { baseIceServers, mintTurnCredentials } from './turn.js';
import { GOVERNOR_DEFAULTS } from './turn-governor.js';

export { BridleRoom } from './durable-object.js';
export { BridleTurnBudget } from './turn-budget.js';

const numEnv = (v, dflt) => (v != null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : dflt);

// Resolve TURN config from env (vars + secrets). All limits are overridable via
// wrangler `[vars]`; the secrets (TURN_KEY_ID / TURN_KEY_API_TOKEN) are set with
// `wrangler secret put`. Analytics is opt-in and only tightens the budget gate.
function turnConfig(env) {
  return {
    keyId: env.TURN_KEY_ID,
    apiToken: env.TURN_KEY_API_TOKEN,
    ttl: numEnv(env.TURN_TTL_SECONDS, GOVERNOR_DEFAULTS.ttlSeconds),
    knobs: {
      monthlyGbBudget: numEnv(env.TURN_MONTHLY_GB_BUDGET, GOVERNOR_DEFAULTS.monthlyGbBudget),
      estMbPerGrant: numEnv(env.TURN_EST_MB_PER_GRANT, GOVERNOR_DEFAULTS.estMbPerGrant),
      maxPerIpPerDay: numEnv(env.TURN_MAX_PER_IP_PER_DAY, GOVERNOR_DEFAULTS.maxPerIpPerDay),
      maxPerMinute: numEnv(env.TURN_MAX_PER_MINUTE, GOVERNOR_DEFAULTS.maxPerMinute),
    },
    analytics:
      env.TURN_ANALYTICS_TOKEN && env.CF_ACCOUNT_ID
        ? { token: env.TURN_ANALYTICS_TOKEN, accountTag: env.CF_ACCOUNT_ID }
        : null,
  };
}

// Assemble the ICE server list for a client. Always includes the STUN base;
// prepends a fresh, short-lived Cloudflare TURN credential when it's configured
// and the budget governor approves. Any failure degrades to STUN-only rather
// than erroring the client's connection.
async function issueIce(request, env) {
  const base = baseIceServers();
  const cfg = turnConfig(env);
  if (!cfg.keyId || !cfg.apiToken || !env.TURN_BUDGET) {
    return { iceServers: base, turn: false, reason: 'not-configured' };
  }

  const url = new URL(request.url);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const room = url.searchParams.get('room') || '';

  let verdict;
  try {
    const stub = env.TURN_BUDGET.get(env.TURN_BUDGET.idFromName('global'));
    verdict = await stub.reserve({ ip, knobs: cfg.knobs, analytics: cfg.analytics });
  } catch {
    return { iceServers: base, turn: false, reason: 'budget-unavailable' };
  }
  if (!verdict.ok) return { iceServers: base, turn: false, reason: verdict.reason };

  try {
    const entry = await mintTurnCredentials({
      keyId: cfg.keyId,
      apiToken: cfg.apiToken,
      ttl: cfg.ttl,
      customIdentifier: room || ip,
    });
    // Deliberately not `remainingGb`: /ice is public and unauthenticated, and
    // telling a caller exactly how much of the monthly budget is left is telling
    // them how much is left to drain. The client has no use for it either.
    return { iceServers: [entry, ...base], turn: true, ttl: cfg.ttl };
  } catch {
    return { iceServers: base, turn: false, reason: 'mint-failed' };
  }
}

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
      // Hand out budget-governed ICE servers (STUN + Cloudflare TURN).
      issueIce: (req) => issueIce(req, env),
    });
  },
};
