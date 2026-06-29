// Resolve runtime configuration from CLI args + environment, or from a saved
// setup (daemon mode). Everything the session needs is gathered into one plain
// object that becomes a singleton ngin provider — so the rest of the app reads
// config the same way it reads any other injected resource.
//
// Usage:
//   bridle [options] [-- <agent cmd...>]     pair + run (auto-daemonizes)
//   bridle list                              list daemonized setups
//   bridle remove <name>                     stop + remove a setup
//   bridle install [options] [-- <cmd...>]   install a setup without pairing first
//   bridle daemon --setup <name>             headless run (used by the service)
//
// Options:
//   --backend <url>   Backend base URL (default https://bridle.3sln.com)
//   --local           Shortcut for --backend http://localhost:8787
//   --room <code>     Use a specific room code (default: random)
//   --name <name>     Setup name for daemonizing (default: current dir name)
//   --no-daemon       Don't auto-install a service after the first tether
//   --webview         Pop a native window with the pairing QR
//   --no-turn         STUN only (skip the public TURN relay)
//
// STT runs in the browser (offline Whisper) and TTS uses the browser's speech
// synthesis, so the desktop needs NO API keys.

import { basename } from 'node:path';
import { makeRoomCode } from '@bridle/protocol/signaling';
import { DEFAULT_ICE_SERVERS, STUN_SERVERS } from '@bridle/protocol/ice';

const DEFAULT_BACKEND = 'https://bridle.3sln.com';

export function parseArgs(argv = process.argv.slice(2)) {
  const dashDash = argv.indexOf('--');
  const head = dashDash >= 0 ? argv.slice(0, dashDash) : argv;
  const agentCmd = dashDash >= 0 && argv.length > dashDash + 1 ? argv.slice(dashDash + 1) : null;

  const sub = head[0] && !head[0].startsWith('-') ? head[0] : 'pair';
  const opts = sub === head[0] ? head.slice(1) : head;

  const get = (name) => {
    const i = opts.indexOf(name);
    return i >= 0 && opts[i + 1] ? opts[i + 1] : undefined;
  };
  const has = (name) => opts.includes(name);
  const positional = opts.filter((a) => !a.startsWith('-'));

  return { sub, get, has, positional, agentCmd };
}

export function loadConfig(parsed = parseArgs(), env = process.env) {
  const { get, has, agentCmd } = parsed;
  const command = agentCmd || ['claude'];

  let backend = get('--backend') || env.BRIDLE_BACKEND_URL || DEFAULT_BACKEND;
  if (has('--local')) backend = 'http://localhost:8787';
  backend = backend.replace(/\/$/, '');

  const room = get('--room') || env.BRIDLE_ROOM || makeRoomCode();
  const turn = !has('--no-turn');
  const name = get('--name') || basename(process.cwd()) || 'default';

  return {
    name,
    room,
    backendUrl: backend,
    pwaUrl: `${backend}/#room=${room}`,
    agent: { command, cwd: process.cwd() },
    iceServers: turn ? DEFAULT_ICE_SERVERS : STUN_SERVERS,
    webview: has('--webview'),
    autoDaemon: !has('--no-daemon'),
    daemonMode: false,
  };
}

/** Build config from a persisted setup (daemon mode). env carries the secrets. */
export function configFromSetup(setup, env = process.env) {
  const backend = (setup.backendUrl || DEFAULT_BACKEND).replace(/\/$/, '');
  return {
    name: setup.name,
    room: setup.room,
    backendUrl: backend,
    pwaUrl: `${backend}/#room=${setup.room}`,
    agent: { command: setup.agent || ['claude'], cwd: setup.cwd || process.cwd() },
    iceServers: DEFAULT_ICE_SERVERS,
    webview: false,
    autoDaemon: false,
    daemonMode: true,
  };
}
