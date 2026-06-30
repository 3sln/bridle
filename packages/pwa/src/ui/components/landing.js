// First-run landing — what bridle is, how to install, and how to pair. Shown at
// the root URL to a fresh visitor (no saved tethers, not arriving from a QR's
// #room=…). A phone that scans a QR seeds an active tether and skips straight to
// connecting, so it never sees this. Pure dodo: the only engine touch is the
// "Add a tether" button, which fires the same `open-tethers` event the control
// bar uses.
import { dd } from '../../runtime.js';

const { alias, div, p, span, strong, button, a, ul, li, h } = dd;

const REPO = 'https://github.com/3sln/bridal';
const INSTALL = {
  unix: 'curl -fsSL https://bridle.3sln.com/install.sh | sh',
  win: 'irm https://bridle.3sln.com/install.ps1 | iex',
};

const onWindows = () => /win/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '');

// A copyable command line. Clipboard is a pure UI affordance, so it's handled
// inline rather than routed through an ngin Action.
function cmd(line) {
  return div({ className: 'lp-cmd' },
    h('code', { className: 'lp-cmd-text' }, line),
    button({ className: 'btn ghost lp-copy', title: 'Copy to clipboard' }, 'Copy').on({
      click: function () {
        const btn = this;
        const done = (label) => { btn.textContent = label; setTimeout(() => { btn.textContent = 'Copy'; }, 1200); };
        if (!navigator.clipboard) return done('—');
        navigator.clipboard.writeText(line).then(() => done('Copied'), () => done('Copy failed'));
      },
    }),
  );
}

export default alias(function () {
  const self = this;
  const fire = (type, detail) => self.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));
  const win = onWindows();
  const primary = win ? INSTALL.win : INSTALL.unix;
  const other = win ? INSTALL.unix : INSTALL.win;

  return div({ className: 'landing' },
    div({ className: 'lp' },
      h('header', { className: 'lp-hero' },
        p({ className: 'lp-logo' }, '🐴 bridle'),
        h('h1', { className: 'lp-tagline' }, 'Talk to your terminal AI agent from your phone.'),
        p({ className: 'lp-sub' },
          'Tether a coding-agent CLI on your desktop to your phone over WebRTC — voice and chat, hands-free. ',
          'The agent runs where your code is; you drive it from the couch, the kitchen, or the car.',
        ),
      ),

      h('section', { className: 'lp-card' },
        h('h2', {}, '1 · Install on your desktop'),
        p({ className: 'lp-muted' }, win ? 'Windows (PowerShell):' : 'macOS / Linux:'),
        cmd(primary),
        h('details', { className: 'lp-details' },
          h('summary', {}, win ? 'macOS / Linux' : 'Windows (PowerShell)'),
          cmd(other),
        ),
        p({ className: 'lp-muted lp-small' },
          'No API keys: speech-to-text runs on-device (Whisper), text-to-speech is your browser’s.',
        ),
      ),

      h('section', { className: 'lp-card' },
        h('h2', {}, '2 · Pair with your phone'),
        h('ol', { className: 'lp-steps' },
          li({}, 'In any project, run ', h('code', {}, 'bridle'), ' (or ', h('code', {}, 'bridle codex'), ', etc.).'),
          li({}, 'It prints a QR and installs itself as a background service for that project.'),
          li({}, 'Scan the QR with your phone — it opens this app and links over a peer-to-peer data channel.'),
          li({}, 'Talk to your agent. Turn on conversation mode and just speak; say “stop talking” to cut in.'),
        ),
        div({ className: 'lp-actions' },
          a({ className: 'btn lp-btn', href: REPO, target: '_blank', rel: 'noopener' }, 'Docs & source'),
          button({ className: 'btn ghost lp-btn' }, 'Already paired? Add a tether')
            .on({ click: () => fire('open-tethers') }),
        ),
      ),

      h('section', { className: 'lp-card' },
        h('h2', {}, 'What it’s for'),
        ul({ className: 'lp-feats' },
          li({}, strong('Voice in and out'), ' — on-device Whisper STT, browser TTS, a hands-free conversation mode with barge-in.'),
          li({}, strong('Any agent'), ' — claude, codex, gemini, aider, opencode, goose… or pipe any other CLI.'),
          li({}, strong('Private and P2P'), ' — chat and files flow phone↔desktop directly; the backend only brokers the handshake.'),
          li({}, strong('Driving mode'), ' — earcons, screen wake-lock, and car/headset/lock-screen media buttons for eyes-off use.'),
        ),
      ),

      h('footer', { className: 'lp-foot' },
        span({}, '🐴 bridle'),
        span({ className: 'lp-dot' }, '·'),
        a({ href: REPO, target: '_blank', rel: 'noopener' }, 'github.com/3sln/bridal'),
      ),
    ),
  );
});
