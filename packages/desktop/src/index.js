#!/usr/bin/env bun
// Bridle desktop CLI dispatcher. Subcommands:
//   tether <name> [agent] | daemonize | list | remove <name>
//   server (the shared supervisor) | daemon --setup <name> (legacy) | help
//
// All tethers are run by ONE shared `bridle server`; `tether` registers a tether
// (tethers.json) and makes sure the server is running, then shows the QR.
//
// Compile to a single binary with:  bun build src/index.js --compile --outfile bridle

import { readFile } from 'node:fs/promises';
import { Engine, Provider } from '@3sln/ngin';
import { parseArgs, loadConfig, configFromSetup } from './config.js';
import {
  AgentProvider,
  SignalingProvider,
  PeerProvider,
  RegistryProvider,
  ServiceProvider,
  FrontendProvider,
} from './providers.js';
import { SetupsQuery, RemoveSetupAction } from './bl/setups.js';
import { getSetup, saveSetup, readSetups, envFileFor, acquireDaemonLock, releaseDaemonLock, serverRunning, stopServer } from './registry.js';
import { installServerService, startBackgroundServer, migrateLegacyServices } from './service.js';
import { runSession } from './run.js';
import { runServer } from './server.js';
import { terminalQR, openWebviewQR } from './qr.js';
import { ui } from './ui.js';

const parsed = parseArgs();

function buildEngine(config) {
  return new Engine({
    providers: {
      config: Provider.fromSingleton(config),
      agent: AgentProvider,
      signaling: SignalingProvider,
      peer: PeerProvider,
      registry: RegistryProvider,
      service: ServiceProvider,
      frontend: FrontendProvider,
    },
  });
}

switch (parsed.sub) {
  case 'list':
    await cmdList();
    break;
  case 'remove':
  case 'rm':
    await cmdRemove(parsed.positional[0]);
    break;
  case 'tether':
    await cmdPair();
    break;
  case 'daemonize':
    await cmdDaemonize();
    break;
  case 'server':
    await cmdServer();
    break;
  case 'daemon':
    await cmdDaemon(parsed.get('--setup'));
    break;
  case 'help':
    ui.help();
    break;
  default:
    await cmdDefault();
    break;
}

// --- tether: register the tether, ensure the server runs, show the QR --------
async function cmdPair() {
  const config = loadConfig(parsed);
  if (!config.agent) {
    ui.needAgent(parsed.tetherName);
    process.exit(1);
  }
  const { modeName, modes } = config.agent;
  if (modeName && !modes?.[modeName]) {
    fail(`unknown mode "${modeName}" for ${config.agent.id}. available: ${Object.keys(modes || {}).join(', ') || '(none)'}`);
  }

  // Re-tethering the same directory keeps its existing room (so an already-scanned
  // QR still works), unless a token was pinned explicitly with --room.
  const prior = await getSetup(config.name);
  if (prior?.room && !parsed.get('--room') && (!prior.cwd || prior.cwd === config.agent.cwd)) {
    config.room = prior.room;
    config.pwaUrl = `${config.backendUrl}/app/#room=${config.room}`;
  }

  const saved = await saveSetup({
    name: config.name,
    room: config.room,
    agent: { id: config.agent.id, command: config.agent.command, mode: modeName || null },
    cwd: config.agent.cwd,
    backendUrl: config.backendUrl,
    createdAt: prior?.createdAt || new Date().toISOString(),
  });

  const ensured = config.autoDaemon ? await ensureServer() : { how: 'skipped' };

  await ui.banner(config, terminalQR);
  if (config.webview) {
    openWebviewQR(config.pwaUrl).then((ok) => !ok && ui.note('(webview unavailable — using terminal QR)'));
  }
  ui.tetherAdded(saved, ensured);
  process.exit(0);
}

// Make sure exactly one shared server is running. Prefer the persistent OS
// service (also migrating away any legacy per-tether services); if that's blocked
// (locked-down machine, no elevation), fall back to a transient background server.
async function ensureServer() {
  if (serverRunning()) return { how: 'already' };
  try {
    const svc = await installServerService();
    await migrateLegacyServices(Object.keys(await readSetups())).catch(() => {});
    return { how: 'service', svc };
  } catch (err) {
    const { already } = await startBackgroundServer().catch(() => ({ already: false, failed: true }));
    return { how: 'background', already, err };
  }
}

// --- daemonize: install the persistent shared-server service -----------------
// Meant to be run from a console opened as administrator (where a locked-down
// machine will let the task be registered). Falls back to a clear message.
async function cmdDaemonize() {
  // Replace any server already running (e.g. an older build's visible-terminal
  // one) so the new hidden tray host cleanly owns the single instance.
  if (serverRunning()) stopServer();
  try {
    const svc = await installServerService();
    await migrateLegacyServices(Object.keys(await readSetups())).catch(() => {});
    ui.serverInstalled(svc);
  } catch (err) {
    fail(`couldn't register the bridle server service: ${err.message}\n  open PowerShell as administrator, then run:  bridle daemonize`);
  }
  // The task's /Run starts the tray host; give its windowless server a moment to
  // claim the lock before deciding we need the transient fallback.
  if (!(await waitFor(serverRunning, 3000))) {
    await startBackgroundServer().catch(() => {});
  }
  await new Promise((r) => setTimeout(r, 200));
  process.exit(0);
}

async function waitFor(pred, ms, step = 250) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return pred();
}

// --- server: the shared supervisor (runs every tether) ----------------------
async function cmdServer() {
  await runServer(buildEngine, { ui: ui.quiet });
  process.exit(0);
}

// --- daemon: headless run for the service -----------------------------------
async function cmdDaemon(name) {
  if (!name) fail('daemon mode requires --setup <name>');
  const setup = await getSetup(name);
  if (!setup) fail(`no such setup: ${name}`);
  // One daemon per tether — whether launched by the service or the fallback.
  if (!acquireDaemonLock(setup.name)) {
    ui.note(`a bridle daemon for "${setup.name}" is already running — exiting.`);
    process.exit(0);
  }
  const release = () => releaseDaemonLock(setup.name);
  process.on('exit', release);
  await loadEnvFile(envFileFor(setup.name));
  const config = configFromSetup(setup);
  const engine = buildEngine(config);
  ui.note(`bridle daemon for "${setup.name}" — room ${setup.room}, agent ${setup.agent?.id || (setup.agent?.command || []).join(' ')}`);
  await runSession(engine, config, { ui: ui.quiet });
  await engine.dispose();
  release();
  process.exit(0);
}

// --- list -------------------------------------------------------------------
async function renderTethers() {
  const engine = buildEngine(loadConfig(parsed));
  const handle = engine.query(new SetupsQuery());
  await new Promise((resolve) => {
    const sub = handle.subscribe((list) => {
      ui.setups(list);
      sub.unsubscribe();
      resolve();
    });
  });
  await engine.dispose();
}

async function cmdList() {
  await renderTethers();
  process.exit(0);
}

// --- default: bare `bridle` — the dashboard (tethers + help) ----------------
async function cmdDefault() {
  await renderTethers();
  ui.help();
  process.exit(0);
}

// --- remove -----------------------------------------------------------------
async function cmdRemove(name) {
  if (!name) fail('usage: bridle remove <name>');
  const engine = buildEngine(loadConfig(parsed));
  const feed = engine.dispatch(new RemoveSetupAction(name));
  await new Promise((resolve, reject) => {
    feed.addEventListener('removed', (e) => ui.removed(e.detail));
    feed.addEventListener('complete', resolve);
    feed.addEventListener('error', (e) => reject(e.error));
  }).catch((err) => fail(err.message));
  await engine.dispose();
  process.exit(0);
}

async function loadEnvFile(path) {
  try {
    const raw = await readFile(path, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) process.env[m[1]] = m[2];
    }
  } catch {
    /* no env file — rely on ambient env */
  }
}

function fail(msg) {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
}
