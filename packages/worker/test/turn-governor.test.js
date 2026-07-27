import { test, expect } from 'bun:test';
import { decide, GOVERNOR_DEFAULTS } from '../src/turn-governor.js';

const T0 = Date.UTC(2026, 5, 15, 12, 0, 0); // 2026-06-15T12:00:00Z

// Walk N grants forward through `decide`, threading state, at a fixed instant.
function run(n, opts = {}) {
  let state = {};
  const results = [];
  for (let i = 0; i < n; i++) {
    const r = decide(state, { ip: '1.2.3.4', now: T0, knobs: {}, ...opts });
    results.push(r);
    state = r.state;
  }
  return { state, results };
}

test('grants a credential under all caps and decrements remaining budget', () => {
  const r = decide({}, { ip: '1.2.3.4', now: T0 });
  expect(r.ok).toBe(true);
  expect(r.reason).toBe(null);
  expect(r.state.grants).toBe(1);
  // 500 GB budget, 100 MB/grant estimate, 0 consumed before this grant.
  expect(r.remainingGb).toBe(GOVERNOR_DEFAULTS.monthlyGbBudget);
});

test('enforces the per-IP daily cap', () => {
  const knobs = { maxPerIpPerDay: 3, maxPerMinute: 1000 };
  const { results } = run(5, { knobs });
  expect(results.slice(0, 3).every((r) => r.ok)).toBe(true);
  expect(results[3].ok).toBe(false);
  expect(results[3].reason).toBe('ip-quota');
});

test('enforces the global per-minute burst cap', () => {
  // Different IPs so the per-IP cap can't be what trips it.
  const knobs = { maxPerMinute: 2, maxPerIpPerDay: 100 };
  let state = {};
  const out = [];
  for (let i = 0; i < 4; i++) {
    const r = decide(state, { ip: `10.0.0.${i}`, now: T0, knobs });
    out.push(r);
    state = r.state;
  }
  expect(out[0].ok).toBe(true);
  expect(out[1].ok).toBe(true);
  expect(out[2].ok).toBe(false);
  expect(out[2].reason).toBe('rate');
});

test('estimate-based monthly budget stops issuance', () => {
  // 1 GB budget, 100 MB/grant => 10 grants allowed, 11th denied.
  const knobs = { monthlyGbBudget: 1, estMbPerGrant: 100, maxPerIpPerDay: 1000, maxPerMinute: 1000 };
  const { results } = run(12, { knobs });
  const granted = results.filter((r) => r.ok).length;
  expect(granted).toBe(10);
  expect(results[10].ok).toBe(false);
  expect(results[10].reason).toBe('budget');
});

test('analytics usedGb overrides the estimate as the budget gate', () => {
  const knobs = { monthlyGbBudget: 500, maxPerIpPerDay: 1000, maxPerMinute: 1000 };
  // Real usage already over budget => deny regardless of low grant count.
  const over = decide({}, { ip: '1.2.3.4', now: T0, knobs, usedGb: 501 });
  expect(over.ok).toBe(false);
  expect(over.reason).toBe('budget');
  // Real usage under budget => grant, remaining reflects real bytes.
  const under = decide({}, { ip: '1.2.3.4', now: T0, knobs, usedGb: 200 });
  expect(under.ok).toBe(true);
  expect(under.remainingGb).toBe(300);
});

test('rolls the monthly grant counter over at a UTC month boundary', () => {
  const julMidJune = { month: '2026-06', grants: 9999, day: '2026-06-15', ipCounts: {}, minute: 0, minuteCount: 0 };
  const july = Date.UTC(2026, 6, 1, 0, 0, 0); // 2026-07-01
  const r = decide(julMidJune, { ip: '1.2.3.4', now: july, knobs: { estMbPerGrant: 100, monthlyGbBudget: 500 } });
  expect(r.ok).toBe(true);
  expect(r.state.month).toBe('2026-07');
  expect(r.state.grants).toBe(1); // reset then incremented, not 10000
});

test('rolls the per-IP daily counter over at a UTC day boundary', () => {
  const prevDay = { month: '2026-06', grants: 5, day: '2026-06-14', ipCounts: { '1.2.3.4': 25 }, minute: 0, minuteCount: 0 };
  const r = decide(prevDay, { ip: '1.2.3.4', now: T0, knobs: { maxPerIpPerDay: 25 } });
  expect(r.ok).toBe(true); // yesterday's 25 don't count against today
  expect(r.state.ipCounts['1.2.3.4']).toBe(1);
});

test('the per-IP table stays inside a Durable Object value', () => {
  // The whole state is one DO value, capped at 128 KiB. Unbounded growth here
  // meant `put` eventually threw, `reserve()` failed, and the worker's catch
  // quietly answered "budget-unavailable" — TURN off for everyone until UTC
  // midnight, and cheap to trigger on purpose.
  const knobs = { maxPerMinute: 1e9, maxPerIpPerDay: 1e9, monthlyGbBudget: 1e9 };
  let state = {};
  for (let i = 0; i < 5000; i++) {
    state = decide(state, { ip: `2001:db8::${i.toString(16)}`, now: T0, knobs }).state;
  }
  const tracked = Object.keys(state.ipCounts).length;
  expect(tracked).toBeLessThanOrEqual(1000);
  // Every grant is still counted globally, whether or not its IP is tracked.
  expect(state.grants).toBe(5000);
  expect(JSON.stringify(state).length).toBeLessThan(120 * 1024);
});

test('a flood of one-shot IPs cannot evict a repeat caller from its cap', () => {
  const knobs = { maxPerMinute: 1e9, maxPerIpPerDay: 3, monthlyGbBudget: 1e9 };
  let state = {};
  // A repeat caller uses up its allowance.
  for (let i = 0; i < 3; i++) state = decide(state, { ip: 'abuser', now: T0, knobs }).state;
  // Then the table is flooded with fresh IPs — the single-grant entries are the
  // ones that get forgotten, not the caller the cap exists for.
  for (let i = 0; i < 4000; i++) {
    state = decide(state, { ip: `10.0.${(i >> 8) & 255}.${i & 255}`, now: T0, knobs }).state;
  }
  expect(state.ipCounts.abuser).toBe(3);
  expect(decide(state, { ip: 'abuser', now: T0, knobs }).reason).toBe('ip-quota');
});
