// Terminal rendering for the CLI. Centralized so index.js/run.js stay logic-only
// and so daemon mode can swap in a quiet variant (logs go to the service journal).

import { PHASE } from './bl/session.js';
import { platformName } from './service.js';

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
    console.log(`  agent    ${config.agent.command.join(' ')}`);
    console.log(`  daemon   ${config.autoDaemon ? `auto (${platformName()}) after first tether` : 'off (--no-daemon)'}`);
    if (!config.whisper.apiKey) {
      console.log(`  ${c.red('⚠ OPENAI_API_KEY not set — voice STT will fail; chat still works')}`);
    }
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
  guestTranscript({ text }) {
    console.log(c.dim(`🎙  heard: ${text}`));
  },
  installed({ setup, service }) {
    console.log(c.green(`✓ installed daemon "${setup.name}" via ${service.manager}`));
    console.log(c.dim(`  ${service.path}`));
  },
  removed({ name, removed }) {
    console.log(removed ? c.green(`✓ removed "${name}"`) : c.yellow(`· no setup named "${name}"`));
  },
  handedOff() {
    console.log(c.green('✓ handed off to the background service — it will keep this tether alive.'));
    console.log(c.dim('  manage it with:  bridle list   /   bridle remove <name>'));
  },
  setups(list) {
    if (!list.length) {
      console.log(c.dim('no setups yet — run `bridle` in a project and tether once to create one.'));
      return;
    }
    console.log(c.bold('\n  setups\n'));
    for (const s of list) {
      const dot = s.status === 'active' ? c.green('●') : c.dim('○');
      console.log(`  ${dot} ${c.bold(s.name.padEnd(16))} ${c.dim(s.status.padEnd(9))} room ${s.room}  ${c.dim(s.agent.join(' '))}`);
    }
    console.log('');
  },
  help() {
    console.log(`${c.bold('bridle')} — tether an AI agent CLI to your phone

${c.bold('usage')}
  bridle [options] [-- <agent cmd...>]   pair + run (auto-daemonizes on first tether)
  bridle install [options] [-- <cmd...>] install a setup without pairing first
  bridle list                            list daemonized setups + status
  bridle remove <name>                   stop + remove a setup
  bridle daemon --setup <name>           headless run (used by the service)

${c.bold('options')}
  --backend <url>   backend base URL (default https://bridle.3sln.com)
  --local           use http://localhost:8787
  --room <code>     fixed room code (default: random)
  --name <name>     setup name (default: current directory name)
  --no-daemon       don't auto-install a service after first tether
  --webview         pop a native window with the pairing QR
  --no-turn         STUN only (skip public TURN)
  --lang <code>     Whisper language hint (e.g. en)

${c.dim('env: OPENAI_API_KEY (required for voice STT)')}`);
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
  guestTranscript: () => {},
  installed: () => {},
  removed: () => {},
  handedOff: () => {},
  setups: () => {},
  help: () => {},
};

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
