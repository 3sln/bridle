// Pure usage-accounting for Cloudflare TURN. No platform/runtime deps so it's
// trivially unit-testable; the Durable Object (`turn-budget.js`) is just a thin
// storage shell that calls `decide()` and persists the returned state.
//
// Cloudflare TURN has no native per-key budget or bandwidth cap — the only
// product knobs are credential TTL, revocation, and analytics. So we govern
// spend ourselves, three ways, before ever minting a credential:
//
//   1. monthly GB ceiling   — the circuit breaker that keeps us under CF's free
//                             tier. Estimate-based by default; uses real egress
//                             from analytics when `usedGb` is supplied.
//   2. per-IP daily cap     — one client can't scrape the credential pool.
//   3. global per-minute cap — smooths scripted bursts.
//
// All time buckets are UTC so they line up with Cloudflare's billing month.

// The whole governor state is one Durable Object value, and a DO value tops out
// at 128 KiB — so the per-IP table cannot be allowed to grow with traffic. At
// 60 grants/minute a busy day would otherwise reach tens of thousands of entries,
// `put` would start throwing, `reserve()` would fail, and the worker's catch
// would quietly return "budget-unavailable" — turning the relay off for everyone
// until UTC midnight. Cheap to trigger deliberately, too. A thousand IPv6-sized
// entries sits comfortably inside the limit; see `trackIp` for what happens at
// the ceiling.
const MAX_TRACKED_IPS = 1000;

export const GOVERNOR_DEFAULTS = Object.freeze({
  monthlyGbBudget: 500, // hard ceiling; stay well under CF's free 1000 GB/month
  estMbPerGrant: 100, // assumed relay egress per granted session (fallback when no analytics)
  maxPerIpPerDay: 25, // one client can't drain the monthly pool on its own
  maxPerMinute: 60, // smooth scripted bursts across all clients
  ttlSeconds: 7200, // 2h short-lived credential — long enough for a session, short enough to bound a leak
});

const pad = (n) => String(n).padStart(2, '0');
const round2 = (x) => Math.round(x * 100) / 100;

/**
 * Decide whether to grant a TURN credential and return the next counter state.
 *
 * @param {object} stateIn  previous persisted state ({} on first call)
 * @param {object} opts
 * @param {string} opts.ip          client IP (CF-Connecting-IP)
 * @param {number} opts.now         epoch ms (inject for testability)
 * @param {object} [opts.knobs]     overrides for GOVERNOR_DEFAULTS
 * @param {number|null} [opts.usedGb] real month-to-date GB from analytics; when
 *        null the monthly check estimates from grant count × estMbPerGrant.
 * @returns {{ ok: boolean, reason: string|null, state: object, remainingGb: number }}
 */
export function decide(stateIn, { ip, now, knobs = {}, usedGb = null }) {
  const k = { ...GOVERNOR_DEFAULTS, ...knobs };
  const d = new Date(now);
  const monthTag = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
  const dayTag = `${monthTag}-${pad(d.getUTCDate())}`;
  const minute = Math.floor(now / 60000);

  // Roll the buckets forward, resetting whichever window has elapsed.
  let s = { month: monthTag, grants: 0, day: dayTag, ipCounts: {}, minute, minuteCount: 0, ...stateIn };
  if (s.month !== monthTag) s = { ...s, month: monthTag, grants: 0 };
  if (s.day !== dayTag) s = { ...s, day: dayTag, ipCounts: {} };
  if (s.minute !== minute) s = { ...s, minute, minuteCount: 0 };

  const consumedGb = usedGb != null ? usedGb : (s.grants * k.estMbPerGrant) / 1000;
  const remainingGb = round2(Math.max(0, k.monthlyGbBudget - consumedGb));
  const deny = (reason) => ({ ok: false, reason, state: s, remainingGb });

  // Cheapest checks first; all three must pass to spend budget.
  if (s.minuteCount >= k.maxPerMinute) return deny('rate');
  const ipKey = ip || 'unknown';
  const ipc = s.ipCounts[ipKey] || 0;
  if (ipc >= k.maxPerIpPerDay) return deny('ip-quota');
  if (consumedGb >= k.monthlyGbBudget) return deny('budget');

  const next = {
    ...s,
    grants: s.grants + 1,
    minuteCount: s.minuteCount + 1,
    ipCounts: trackIp(s.ipCounts, ipKey, ipc),
  };
  return { ok: true, reason: null, state: next, remainingGb };
}

/**
 * Record one more grant against an IP, keeping the table bounded.
 *
 * At the ceiling, the single-grant entries go first: forgetting a client that
 * has used one credential today costs at most one extra grant, while the
 * repeat callers the cap actually exists to stop are exactly the ones with the
 * high counts. If every entry is a repeat caller, the new IP simply isn't
 * tracked — the per-IP cap is a refinement, and degrading to the global
 * per-minute and monthly ceilings is far better than the alternative, which was
 * the whole governor failing shut.
 */
function trackIp(ipCounts, ipKey, current) {
  const known = current > 0;
  if (known || Object.keys(ipCounts).length < MAX_TRACKED_IPS) {
    return { ...ipCounts, [ipKey]: current + 1 };
  }
  const kept = {};
  for (const [key, count] of Object.entries(ipCounts)) {
    if (count > 1) kept[key] = count;
  }
  if (Object.keys(kept).length >= MAX_TRACKED_IPS) return ipCounts; // untracked this time
  kept[ipKey] = 1;
  return kept;
}
