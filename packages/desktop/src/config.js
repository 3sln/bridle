// Resolve runtime configuration from CLI args + environment, or from a saved
// setup (daemon mode). Everything the session needs is gathered into one plain
// object that becomes a singleton ngin provider.
//
// Usage:
//   bridle [agent] [options] [-- <raw cmd...>]   pair + run (auto-daemonizes)
//   bridle list                                  list daemonized setups
//   bridle remove <name>                         stop + remove a setup
//   bridle install [agent] [options]             install a setup without pairing
//   bridle daemon --setup <name>                 headless run (used by the service)
//
//   [agent] is a known profile id (claude, codex, antigravity, gemini, opencode,
//   aider, goose, cursor, q, copilot). Omit it for the default (claude), or use
//   `-- <cmd...>` to run any other CLI in generic pipe mode.
//
// Options:
//   --agent <id>      select an agent profile explicitly
//   --backend <url>   backend base URL (default https://bridle.3sln.com)
//   --local           use http://localhost:8787
//   --room <code>     fixed room code (default: random)
//   --name <name>     setup name (default: current directory name)
//   --session <id>    attach to a specific agent session id
//   --new-session     start a fresh session instead of resuming the latest
//   --no-daemon       don't auto-install a service after first tether
//   --webview         pop a native window with the pairing QR
//   --no-turn         STUN only (skip public TURN)
//
// STT runs in the browser (offline Whisper) and TTS uses the browser's speech
// synthesis, so the desktop needs NO API keys.

import { basename } from 'node:path';
import { makeRoomCode } from '@bridle/protocol/signaling';
import { DEFAULT_ICE_SERVERS, STUN_SERVERS } from '@bridle/protocol/ice';
import { resolveAgent, DEFAULT_AGENT } from './agents.js';

const DEFAULT_BACKEND = 'https://bridle.3sln.com';
export const KNOWN_SUBS = new Set(['pair', 'install', 'list', 'remove', 'rm', 'daemon', 'help']);

export function parseArgs(argv = process.argv.slice(2)) {
  const dashDash = argv.indexOf('--');
  const head = dashDash >= 0 ? argv.slice(0, dashDash) : argv;
  const agentCmd = dashDash >= 0 && argv.length > dashDash + 1 ? argv.slice(dashDash + 1) : null;

  const first = head[0] && !head[0].startsWith('-') ? head[0] : null;
  const sub = first && KNOWN_SUBS.has(first) ? first : 'pair';
  // A leading non-flag token that isn't a subcommand is an agent name.
  const agentName = first && !KNOWN_SUBS.has(first) ? first : null;
  const opts = first ? head.slice(1) : head;

  const get = (name) => {
    const i = opts.indexOf(name);
    return i >= 0 && opts[i + 1] ? opts[i + 1] : undefined;
  };
  const has = (name) => opts.includes(name);
  const positional = opts.filter((a) => !a.startsWith('-'));

  return { sub, agentName, get, has, positional, agentCmd };
}

export function loadConfig(parsed = parseArgs(), env = process.env) {
  const { get, has, agentCmd, agentName } = parsed;

  const profile = resolveAgent(agentCmd ? { command: agentCmd } : { id: get('--agent') || agentName || DEFAULT_AGENT });

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
    agent: { ...profile, cwd: process.cwd() },
    session: {
      id: get('--session') || null,
      fresh: has('--new-session'),
      attachLatest: !has('--new-session') && !get('--session'),
    },
    iceServers: turn ? DEFAULT_ICE_SERVERS : STUN_SERVERS,
    webview: has('--webview'),
    autoDaemon: !has('--no-daemon'),
    daemonMode: false,
  };
}

/** Build config from a persisted setup (daemon mode). */
export function configFromSetup(setup, env = process.env) {
  const backend = (setup.backendUrl || DEFAULT_BACKEND).replace(/\/$/, '');
  const a = setup.agent || {};
  const profile = resolveAgent(a.id === 'custom' || !a.id ? { command: a.command } : { id: a.id });
  return {
    name: setup.name,
    room: setup.room,
    backendUrl: backend,
    pwaUrl: `${backend}/#room=${setup.room}`,
    agent: { ...profile, cwd: setup.cwd || process.cwd() },
    session: { id: null, fresh: false, attachLatest: true },
    iceServers: DEFAULT_ICE_SERVERS,
    webview: false,
    autoDaemon: false,
    daemonMode: true,
  };
}
