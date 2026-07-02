// The shared server: one process that supervises every tether. It reads
// tethers.json, runs an isolated session (its own agent + signaling + peer +
// MCP) per tether, and watches the file so tethers added/removed by the CLI are
// picked up live — no re-daemonizing. Live state is written to status.json for
// the CLI to read. One `server.pid` lock guards the single instance.
//
// Each tether is a full ngin Engine running a SessionQuery (the exact same
// session machinery the foreground `tether` command used), so this is lifecycle
// glue, not a rewrite of the session logic.

import { watch } from 'node:fs';
import { SessionQuery } from './bl/session.js';
import { configFromSetup } from './config.js';
import {
  configDir,
  readSetupsSync,
  acquireServerLock,
  releaseServerLock,
  writeStatus,
} from './registry.js';

const HEARTBEAT_MS = 5000; // refresh status timestamps so the CLI sees us as live
const POLL_MS = 5000; // backstop in case fs.watch misses a change
const DEBOUNCE_MS = 300;

// Restart a tether only when something that affects the running session changes.
const sig = (s) => JSON.stringify({ room: s.room, agent: s.agent, cwd: s.cwd, backendUrl: s.backendUrl });

export async function runServer(buildEngine, { ui } = {}) {
  if (!acquireServerLock()) {
    ui?.note?.('a bridle server is already running — exiting.');
    return { already: true };
  }
  const release = () => releaseServerLock();
  process.on('exit', release);

  const sessions = new Map(); // key -> { engine, sig, room }
  const status = {}; // key -> { phase, guest, agentState, room, at }
  let reconciling = false;
  let pending = false;

  async function startTether(setup) {
    const config = configFromSetup(setup);
    const engine = buildEngine(config);
    const handle = engine.query(new SessionQuery());
    // Keep the subscription for the tether's lifetime; disposing the engine kills
    // the query (and tears the session down) when we stop it.
    handle.subscribe((state) => {
      if (!sessions.has(setup.name)) return; // stopping — ignore late frames
      status[setup.name] = {
        phase: state.phase,
        guest: state.guest || null,
        agentState: state.agentState,
        room: setup.room,
        at: Date.now(),
      };
      writeStatus(status);
    });
    sessions.set(setup.name, { engine, sig: sig(setup), room: setup.room });
    ui?.note?.(`+ ${setup.name}  (room ${setup.room})`);
  }

  async function stopTether(key) {
    const s = sessions.get(key);
    if (!s) return;
    sessions.delete(key);
    delete status[key];
    writeStatus(status);
    try {
      await s.engine.dispose(); // kills the SessionQuery: agent, signaling, MCP all torn down
    } catch (err) {
      ui?.note?.(`(teardown of ${key}: ${err.message})`);
    }
    ui?.note?.(`- ${key}`);
  }

  async function reconcile() {
    if (reconciling) {
      pending = true;
      return;
    }
    reconciling = true;
    try {
      const all = readSetupsSync();
      const want = new Map(Object.entries(all));
      for (const key of [...sessions.keys()]) {
        if (!want.has(key)) {
          await stopTether(key);
        } else if (sessions.get(key).sig !== sig(want.get(key))) {
          await stopTether(key); // definition changed — restart it
          await startTether(want.get(key));
        }
      }
      for (const [key, setup] of want) {
        if (!sessions.has(key)) {
          await startTether({ ...setup, name: key });
        }
      }
    } finally {
      reconciling = false;
      if (pending) {
        pending = false;
        reconcile();
      }
    }
  }

  ui?.note?.('bridle server — supervising tethers from tethers.json');
  await reconcile();

  // Watch the config dir (watching a lone file misses atomic replaces) and
  // debounce the burst of events a save produces.
  let debounce = null;
  let watcher = null;
  try {
    watcher = watch(configDir(), (_evt, file) => {
      if (file && !/tethers\.touch/.test(file)) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => reconcile().catch(() => {}), DEBOUNCE_MS);
    });
  } catch {
    /* no fs.watch — the poll backstop covers it */
  }
  const poll = setInterval(() => reconcile().catch(() => {}), POLL_MS);
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const key of sessions.keys()) {
      if (status[key]) status[key].at = now;
    }
    writeStatus(status);
  }, HEARTBEAT_MS);

  await new Promise((resolve) => {
    const stop = async () => {
      clearTimeout(debounce);
      clearInterval(poll);
      clearInterval(heartbeat);
      try {
        watcher?.close();
      } catch {
        /* noop */
      }
      for (const key of [...sessions.keys()]) {
        await stopTether(key);
      }
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });

  release();
  return { already: false };
}
