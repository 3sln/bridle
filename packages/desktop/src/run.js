// Run a session to completion. In foreground (`pair`) mode, the first successful
// tether triggers a hand-off: we free the signaling room, install a background
// service, and exit — the daemon then owns the room and the phone reconnects to
// it automatically. In daemon mode we just run until signalled.

import { SessionQuery, PHASE } from './bl/session.js';
import { InstallSetupAction } from './bl/setups.js';

export function runSession(engine, config, { ui } = {}) {
  return new Promise((resolve) => {
    let firstTether = true;
    let lastPhase = null;

    if (ui) {
      engine.feed.addEventListener('agent-output', (e) => ui.agentOutput(e.detail));
      engine.feed.addEventListener('guest-input', (e) => ui.guestInput(e.detail));
    }

    const handle = engine.query(new SessionQuery());
    const sub = handle.subscribe(async (state) => {
      if (ui && state.phase !== lastPhase) {
        lastPhase = state.phase;
        ui.phase(state);
      }
      if (ui && state.error) ui.error(state.error);

      if (state.phase === PHASE.TETHERED && firstTether) {
        firstTether = false;
        if (config.autoDaemon && !config.daemonMode) {
          await daemonizeHandoff(engine, config, sub, ui);
          resolve({ reason: 'daemonized' });
        }
      }
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

async function daemonizeHandoff(engine, config, sub, ui) {
  ui?.note('first tether confirmed — installing background service…');
  // Free the room BEFORE the service starts, so the daemon can claim the host
  // slot without colliding with us.
  sub.unsubscribe();

  const feed = engine.dispatch(
    new InstallSetupAction({
      name: config.name,
      room: config.room,
      agent: config.agent.command,
      cwd: config.agent.cwd,
      backendUrl: config.backendUrl,
    }),
  );

  feed.addEventListener('installed', (e) => ui?.installed(e.detail));
  await new Promise((res, rej) => {
    feed.addEventListener('complete', res);
    feed.addEventListener('error', (e) => rej(e.error));
  }).catch((err) => ui?.error(`daemon install failed: ${err.message}`));
}
