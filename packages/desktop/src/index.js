#!/usr/bin/env bun
// Bridle desktop CLI dispatcher. Subcommands:
//   pair (default) | install | list | remove <name> | daemon --setup <name>
//
// Compile to a single binary with:  bun build src/index.js --compile --outfile bridle

import { readFile } from 'node:fs/promises';
import { Engine, Provider } from '@3sln/ngin';
import { parseArgs, loadConfig, configFromSetup } from './config.js';
import {
  AgentProvider,
  WhisperProvider,
  SignalingProvider,
  PeerProvider,
  RegistryProvider,
  ServiceProvider,
} from './providers.js';
import { SetupsQuery, RemoveSetupAction, InstallSetupAction } from './bl/setups.js';
import { getSetup, envFileFor } from './registry.js';
import { runSession } from './run.js';
import { terminalQR, openWebviewQR } from './qr.js';
import { ui } from './ui.js';

const parsed = parseArgs();

function buildEngine(config) {
  return new Engine({
    providers: {
      config: Provider.fromSingleton(config),
      agent: AgentProvider,
      whisper: WhisperProvider,
      signaling: SignalingProvider,
      peer: PeerProvider,
      registry: RegistryProvider,
      service: ServiceProvider,
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
  case 'install':
    await cmdInstall();
    break;
  case 'daemon':
    await cmdDaemon(parsed.get('--setup'));
    break;
  case 'help':
  case '--help':
  case '-h':
    ui.help();
    break;
  default:
    await cmdPair();
    break;
}

// --- pair: foreground run, QR, auto-daemonize on first tether ---------------
async function cmdPair() {
  const config = loadConfig(parsed);
  const engine = buildEngine(config);
  await ui.banner(config, terminalQR);
  if (config.webview) {
    openWebviewQR(config.pwaUrl).then((ok) => !ok && ui.note('(webview unavailable — using terminal QR)'));
  }
  const { reason } = await runSession(engine, config, { ui });
  if (reason === 'daemonized') ui.handedOff();
  await engine.dispose();
  process.exit(0);
}

// --- daemon: headless run for the service -----------------------------------
async function cmdDaemon(name) {
  if (!name) fail('daemon mode requires --setup <name>');
  const setup = await getSetup(name);
  if (!setup) fail(`no such setup: ${name}`);
  await loadEnvFile(envFileFor(setup.name));
  const config = configFromSetup(setup);
  const engine = buildEngine(config);
  ui.note(`bridle daemon for "${setup.name}" — room ${setup.room}, agent ${setup.agent.join(' ')}`);
  await runSession(engine, config, { ui: ui.quiet });
  await engine.dispose();
  process.exit(0);
}

// --- list -------------------------------------------------------------------
async function cmdList() {
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

// --- install (without pairing first) ----------------------------------------
async function cmdInstall() {
  const config = loadConfig(parsed);
  const engine = buildEngine(config);
  const feed = engine.dispatch(
    new InstallSetupAction(
      { name: config.name, room: config.room, agent: config.agent.command, cwd: config.agent.cwd, backendUrl: config.backendUrl },
      { apiKey: config.whisper.apiKey, language: config.whisper.language },
    ),
  );
  await new Promise((resolve, reject) => {
    feed.addEventListener('installed', (e) => ui.installed(e.detail));
    feed.addEventListener('complete', resolve);
    feed.addEventListener('error', (e) => reject(e.error));
  }).catch((err) => fail(err.message));
  ui.note(`open ${config.pwaUrl} on your phone to tether (room ${config.room}).`);
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
