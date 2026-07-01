// Resolve runtime configuration from CLI args + environment, or from a saved
// setup (daemon mode). Everything the session needs is gathered into one plain
// object that becomes a singleton ngin provider.
//
// Usage:
//   bridle tether <name> [agent] [-- <cmd...>]   create a tether + pair your phone
//   bridle daemonize [name]                      keep it running (run in an admin console)
//   bridle list                                  list your tethers
//   bridle remove <name>                         stop + remove a tether
//   bridle daemon --setup <name>                 headless run (used by the service)
//   bridle help                                  show help
//
// Tethers are not deduplicated: multiple can coexist on one machine, each tied to
// the directory it was created in. Re-pairing the same directory updates it in
// place; a different directory that names a colliding tether gets a fresh suffix.
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
//   --resume          resume the latest session (default is a fresh conversation)
//   --new-session     (default) start a fresh session
//   --no-daemon       don't auto-install a service after first tether
//   --webview         pop a native window with the pairing QR
//   --no-turn         STUN only (skip public TURN)
//
// STT runs in the browser (offline Whisper) and TTS uses the browser's speech
// synthesis, so the desktop needs NO API keys.

import { basename } from 'node:path';
import { makeToken } from '@bridle/protocol/signaling';
import { DEFAULT_ICE_SERVERS, STUN_SERVERS } from '@bridle/protocol/ice';
import { resolveAgent } from './agents.js';

const DEFAULT_BACKEND = 'https://bridle.3sln.com';
export const KNOWN_SUBS = new Set(['tether', 'daemonize', 'list', 'remove', 'rm', 'daemon', 'help']);

export function parseArgs(argv = process.argv.slice(2)) {
  const dashDash = argv.indexOf('--');
  const head = dashDash >= 0 ? argv.slice(0, dashDash) : argv;
  const agentCmd = dashDash >= 0 && argv.length > dashDash + 1 ? argv.slice(dashDash + 1) : null;

  const first = head[0] && !head[0].startsWith('-') ? head[0] : null;
  const wantsHelp = argv.some((a) => a === 'help' || a === '--help' || a === '-h');
  // Bare `bridle` shows the dashboard (tethers + help); an explicit help flag
  // shows just help; anything unrecognized also falls through to the dashboard.
  const sub = wantsHelp ? 'help' : first && KNOWN_SUBS.has(first) ? first : 'default';
  const opts = first && KNOWN_SUBS.has(first) ? head.slice(1) : head;

  const get = (name) => {
    const i = opts.indexOf(name);
    return i >= 0 && opts[i + 1] ? opts[i + 1] : undefined;
  };
  const has = (name) => opts.includes(name);
  const positional = opts.filter((a) => !a.startsWith('-'));

  // `bridle tether <name> [agent]`: positional[0] is the name, positional[1] the
  // agent profile; `-- <cmd...>` runs an arbitrary CLI in generic pipe mode.
  const tetherName = positional[0] || null;
  const agentName = sub === 'tether' ? positional[1] || null : null;

  return { sub, tetherName, agentName, get, has, positional, agentCmd };
}

export function loadConfig(parsed = parseArgs(), env = process.env) {
  const { get, has, agentCmd, agentName, tetherName } = parsed;

  // No default agent: an agent is chosen explicitly (a profile id or `-- <cmd>`).
  // cmdPair validates that one was given, so we never privilege a particular one.
  const requested = get('--agent') || agentName;
  const profile = agentCmd ? resolveAgent({ command: agentCmd }) : requested ? resolveAgent({ id: requested }) : null;

  let backend = get('--backend') || env.BRIDLE_BACKEND_URL || DEFAULT_BACKEND;
  if (has('--local')) backend = 'http://localhost:8787';
  backend = backend.replace(/\/$/, '');

  const room = get('--room') || env.BRIDLE_ROOM || makeToken();
  const turn = !has('--no-turn');
  const name = get('--name') || tetherName || basename(process.cwd()) || 'default';
  const modeName = get('--mode') || null;

  return {
    name,
    room,
    backendUrl: backend,
    pwaUrl: `${backend}/app/#room=${room}`,
    agent: profile ? { ...profile, cwd: process.cwd(), modeName, modeArgs: profile.modes?.[modeName] || [] } : null,
    session: {
      id: get('--session') || null,
      // Default to a fresh conversation. Resuming the latest session silently
      // continued an unrelated prior chat, so it's now opt-in via --resume (or
      // pin a specific one with --session <id>).
      fresh: !get('--session') && !has('--resume'),
      attachLatest: has('--resume'),
    },
    iceServers: turn ? DEFAULT_ICE_SERVERS : STUN_SERVERS,
    mcp: { enabled: !has('--no-mcp'), port: Number(get('--mcp-port')) || 0 },
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
    pwaUrl: `${backend}/app/#room=${setup.room}`,
    agent: { ...profile, cwd: setup.cwd || process.cwd(), modeName: a.mode || null, modeArgs: profile.modes?.[a.mode] || [] },
    session: { id: null, fresh: true, attachLatest: false },
    iceServers: DEFAULT_ICE_SERVERS,
    mcp: { enabled: true, port: 0 },
    webview: false,
    autoDaemon: false,
    daemonMode: true,
  };
}
