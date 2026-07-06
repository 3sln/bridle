// Terminal rendering for the CLI. Centralized so index.js/run.js stay logic-only
// and so daemon mode can swap in a quiet variant (logs go to the service journal).

import { PHASE } from './bl/session.js';
import { platformName } from './service.js';
import { listProfiles } from './agents.js';

const agentLabel = (a) => (!a ? '?' : a.id === 'custom' || !a.id ? (a.command || []).join(' ') : a.id);
const claudeModes = () => listProfiles().find((p) => p.id === 'claude')?.modes || {};

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  ul: (s) => `\x1b[4m${s}\x1b[0m`,
};

export const ui = {
  async banner(config, terminalQR) {
    console.log(`\n${c.bold('🐴 bridle')} — tether your agent to your phone\n`);
    console.log(await terminalQR(config.pwaUrl));
    console.log(`  scan ↑   or open  ${c.ul(config.pwaUrl)}`);
    console.log(`  room     ${c.bold(config.room)}`);
    console.log(`  agent    ${config.agent.label}${config.agent.modeName ? c.cyan(` · ${config.agent.modeName} mode`) : ''} ${c.dim(`(${config.agent.mode}, ${config.agent.tier})`)}`);
    console.log(c.dim(`  session  ${config.session.fresh ? 'new' : config.session.id || 'resume latest'} — primed for voice on connect`));
    console.log(c.dim('  voice    on-device (browser Whisper) — no API key needed'));
    console.log('');
  },

  phase(s) {
    console.log(`${c.yellow('●')} ${phaseLabel(s)}`);
  },
  error(msg) {
    console.error(c.red(`✗ ${msg}`));
  },
  note(msg) {
    console.log(c.dim(msg));
  },
  agentOutput({ text }) {
    process.stdout.write(text);
  },
  guestInput({ text }) {
    console.log(`\n${c.cyan('📱 you:')} ${text}`);
  },
  removed({ name, removed }) {
    console.log(removed ? c.green(`✓ removed "${name}"`) : c.yellow(`· no tether named "${name}"`));
  },
  // After `bridle tether`: report how the shared server is handling it.
  tetherAdded(setup, ensured) {
    switch (ensured.how) {
      case 'already':
        console.log(c.green('✓ added to the running bridle server — scan the QR to connect.'));
        break;
      case 'service':
        console.log(c.green(`✓ added, and installed the bridle server service (${ensured.svc?.manager || platformName()}).`));
        break;
      case 'background':
        console.log(ensured.already
          ? c.green('✓ added to the background bridle server — scan the QR to connect.')
          : c.green('✓ added, and started a background bridle server — scan the QR to connect.'));
        console.log(c.dim('  the background server stops on logout/reboot. to keep it across logins,'));
        console.log(`  open ${c.bold('PowerShell as administrator')} and run  ${c.cyan('bridle daemonize')}`);
        break;
      default: // skipped (--no-daemon)
        console.log(c.yellow('· tether saved. start it with  bridle server  (or  bridle daemonize  to persist).'));
    }
    console.log(c.dim(`  manage:  bridle list   /   bridle remove ${setup.name}`));
  },
  serverInstalled(svc) {
    console.log(c.green(`✓ installed the bridle server service via ${svc.manager}`));
    console.log(c.dim(`  ${svc.path}`));
    console.log(c.dim('  it now runs every tether across logins.'));
    if (svc.manager === 'task-scheduler') {
      console.log(c.dim('  runs in the background with a 🐴 tray icon (right-click to restart or quit) — no terminal window.'));
    }
  },
  setups(list) {
    if (!list.length) {
      console.log(c.dim('\n  no tethers yet — create one with:  bridle tether <name> <agent>\n'));
      return;
    }
    const svc = list[0].service;
    const serverUp = list[0].serverRunning;
    const serverState = serverUp
      ? c.green(svc === 'active' ? 'running · service' : 'running · background')
      : svc === 'active'
        ? c.yellow('registered · not running')
        : c.dim('not running — run  bridle daemonize');
    console.log(`\n  ${c.bold('bridle server')}  ${serverState}`);
    console.log(c.bold('\n  tethers\n'));
    for (const s of list) {
      const dot = s.running ? c.green('●') : c.dim('○');
      const state = s.running
        ? c.green(phaseWord(s.phase) + (s.guest ? c.dim(` · ${s.guest}`) : ''))
        : c.dim('idle');
      console.log(`  ${dot} ${c.bold(s.name.padEnd(16))} ${state}   ${c.dim(agentLabel(s.agent))}`);
      if (s.cwd) {
        console.log(`    ${c.dim(s.cwd)}`);
      }
    }
    console.log('');
  },
  needAgent(name) {
    const n = name || '<name>';
    console.error(c.red('✗ pick an agent — bridle has no default.'));
    console.log(`  usage:  ${c.bold(`bridle tether ${n} <agent>`)}`);
    console.log(`  agents: ${listProfiles().map((p) => p.aliases[0]).join('  ')}`);
    console.log(c.dim(`  or tether any CLI:  bridle tether ${n} -- <cmd…>`));
  },
  help() {
    console.log(`${c.bold('bridle')} — tether an AI agent CLI to your phone

${c.bold('usage')}
  bridle tether <name> [agent]           create a tether + pair your phone (scan the QR)
  bridle tether <name> -- <cmd...>        …tethering an arbitrary CLI instead of a profile
  bridle daemonize                        keep the bridle server running across logins
                                          ${c.dim('(run from PowerShell opened as administrator)')}
  bridle list                            list your tethers + status
  bridle remove <name>                   stop + remove a tether
  bridle help                            show this help

  ${c.dim('all tethers are run by one shared `bridle server`; new tethers join it live.')}

${c.bold('agents')}  ${listProfiles().map((p) => p.aliases[0]).join('  ')}
  ${c.dim('use `-- <cmd...>` to tether any other CLI, or define your own profiles')}
  ${c.dim('in ~/.config/bridle/profiles.json (see the README).')}

${c.bold('options')} ${c.dim('(for `tether`)')}
  --mode <name>     select an agent run mode (e.g. claude: ${Object.keys(claudeModes()).join(', ') || '—'})
  --resume          resume the latest session (default: fresh conversation)
  --session <id>    attach to a specific agent session
  --backend <url>   backend base URL (default https://bridle.3sln.com)
  --local           use http://localhost:8787
  --room <token>    fixed room token (default: random high-entropy)
  --no-daemon       don't try to install a background service
  --webview         pop a native window with the pairing QR
  --no-turn         STUN only (skip public TURN)

${c.dim('voice STT runs on the phone (offline) — the desktop needs no API key')}`);
  },
};

// Daemon variant: terse, journald-friendly, no QR/echo spam.
ui.quiet = {
  banner: async () => {},
  phase: (s) => console.log(`[bridle] ${phaseLabel(s)}`),
  error: (msg) => console.error(`[bridle] error: ${msg}`),
  note: (msg) => console.log(`[bridle] ${msg}`),
  agentOutput: () => {},
  guestInput: () => {},
  removed: () => {},
  tetherAdded: () => {},
  serverInstalled: () => {},
  setups: () => {},
  help: () => {},
};

// Short status word for `bridle list`.
function phaseWord(phase) {
  switch (phase) {
    case PHASE.TETHERED: return 'connected';
    case PHASE.WAITING: return 'waiting for phone';
    case PHASE.NEGOTIATING: return 'linking';
    case PHASE.PEER_LEFT: return 'phone left';
    case PHASE.STARTING: return 'starting';
    case PHASE.ERROR: return 'error';
    default: return phase || 'live';
  }
}

function phaseLabel(s) {
  switch (s.phase) {
    case PHASE.STARTING: return 'starting…';
    case PHASE.WAITING: return 'waiting for your phone to connect…';
    case PHASE.NEGOTIATING: return 'phone found — negotiating P2P link…';
    case PHASE.TETHERED: return `${c.green('tethered')} (${s.guest || 'phone'}) — talk to your agent`;
    case PHASE.PEER_LEFT: return 'phone disconnected — waiting for reconnect…';
    case PHASE.ERROR: return `error: ${s.error || 'unknown'}`;
    default: return s.phase;
  }
}
