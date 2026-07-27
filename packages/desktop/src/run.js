// Run a single tether session to completion. Used by the legacy `daemon --setup`
// path (one tether per process). The shared `bridle server` runs many of these
// concurrently via its own supervisor; both just drive a SessionQuery and stop on
// a process signal. Pairing no longer runs a foreground session — `bridle tether`
// registers the tether and lets the server own it.

import { SessionQuery } from './bl/session.js';

export function runSession(engine, config, { ui } = {}) {
  return new Promise((resolve) => {
    let lastPhase = null;

    if (ui) {
      engine.feed.addEventListener('agent-output', (e) => ui.agentOutput(e.detail));
      engine.feed.addEventListener('guest-input', (e) => ui.guestInput(e.detail));
      engine.feed.addEventListener('mcp-up', (e) => ui.note(`agent front-end tools (MCP) at ${e.detail.url}`));
      engine.feed.addEventListener('bridle-note', (e) =>
        e.detail.level === 'error' ? ui.error(e.detail.text) : ui.note(e.detail.text),
      );
    }

    const handle = engine.query(new SessionQuery());
    const sub = handle.subscribe((state) => {
      if (ui && state.phase !== lastPhase) {
        lastPhase = state.phase;
        ui.phase(state);
      }
      if (ui && state.error) ui.error(state.error);
    });

    const stop = () => {
      try {
        sub.unsubscribe();
      } catch {
        /* noop */
      }
      resolve({ reason: 'signal' });
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}
