// Cross-platform "always available" service manager. One OS service per setup,
// each running `bridle daemon --setup <name>` at login/boot and restarting on
// failure. Three adapters behind one interface:
//
//   macOS    -> launchd LaunchAgent  (~/Library/LaunchAgents)
//   Linux    -> systemd user unit    (~/.config/systemd/user)
//   Windows  -> Scheduled Task       (schtasks, ONLOGON)
//
// Kept deliberately dependency-free (shells out to the native tool). The session
// logic never touches this — it's reached through the ServiceProvider, so a new
// OS or a different init system is a new adapter, not a rewrite.

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { safeName, envFileFor } from './registry.js';

const LABEL = (name) => `com.3sln.bridle.${safeName(name)}`;
const UNIT = (name) => `bridle-${safeName(name)}.service`;
const TASK = (name) => `Bridle_${safeName(name)}`;

/** How to invoke *this* bridle build (compiled binary, or `bun index.js` in dev). */
export function selfCommand() {
  const arg1 = process.argv[1] || '';
  // In a `bun build --compile` binary, argv[1] is not a .js entry we can re-run.
  if (arg1.endsWith('.js') || arg1.endsWith('.ts')) {
    return { exec: process.execPath, prefix: [arg1] }; // dev: bun <entry>
  }
  return { exec: process.execPath, prefix: [] }; // compiled: the binary itself
}

async function run(cmd, args) {
  const proc = Bun.spawn([cmd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const code = await proc.exited;
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  return { code, out, err };
}

export function platformName() {
  return { darwin: 'launchd', linux: 'systemd', win32: 'task-scheduler' }[process.platform] || process.platform;
}

export async function installService(name) {
  const adapter = pick();
  return adapter.install(name);
}
export async function uninstallService(name) {
  const adapter = pick();
  return adapter.uninstall(name);
}
export async function serviceStatus(name) {
  const adapter = pick();
  try {
    return await adapter.status(name);
  } catch {
    return 'unknown';
  }
}

function pick() {
  switch (process.platform) {
    case 'darwin': return launchd;
    case 'linux': return systemd;
    case 'win32': return taskScheduler;
    default:
      return {
        install: async () => { throw new Error(`unsupported platform: ${process.platform}`); },
        uninstall: async () => false,
        status: async () => 'unsupported',
      };
  }
}

// --- launchd (macOS) --------------------------------------------------------
const launchd = {
  plistPath: (name) => join(homedir(), 'Library', 'LaunchAgents', `${LABEL(name)}.plist`),
  async install(name) {
    const { exec, prefix } = selfCommand();
    const args = [...prefix, 'daemon', '--setup', safeName(name)];
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL(name)}</string>
  <key>ProgramArguments</key><array>
    ${[exec, ...args].map((a) => `<string>${xml(a)}</string>`).join('\n    ')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>EnvironmentVariables</key><dict>
    <key>BRIDLE_ENV_FILE</key><string>${xml(envFileFor(name))}</string>
  </dict>
  <key>StandardOutPath</key><string>${xml(join(homedir(), 'Library', 'Logs', `${LABEL(name)}.log`))}</string>
  <key>StandardErrorPath</key><string>${xml(join(homedir(), 'Library', 'Logs', `${LABEL(name)}.log`))}</string>
</dict></plist>`;
    const path = this.plistPath(name);
    await mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
    await writeFile(path, plist);
    await run('launchctl', ['unload', path]).catch(() => {});
    const { code, err } = await run('launchctl', ['load', '-w', path]);
    if (code !== 0) throw new Error(`launchctl load failed: ${err}`);
    return { manager: 'launchd', path };
  },
  async uninstall(name) {
    const path = this.plistPath(name);
    await run('launchctl', ['unload', '-w', path]).catch(() => {});
    await rm(path, { force: true });
    return true;
  },
  async status(name) {
    const { out } = await run('launchctl', ['list']);
    return out.includes(LABEL(name)) ? 'active' : 'inactive';
  },
};

// --- systemd (Linux, user scope) --------------------------------------------
const systemd = {
  unitDir: () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user'),
  unitPath(name) {
    return join(this.unitDir(), UNIT(name));
  },
  async install(name) {
    const { exec, prefix } = selfCommand();
    const execStart = [exec, ...prefix, 'daemon', '--setup', safeName(name)].map(shellQuote).join(' ');
    const unit = `[Unit]
Description=Bridle tether (${safeName(name)})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
EnvironmentFile=-${envFileFor(name)}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
    await mkdir(this.unitDir(), { recursive: true });
    await writeFile(this.unitPath(name), unit);
    await run('systemctl', ['--user', 'daemon-reload']);
    // Allow the service to run without an active login session (best effort).
    await run('loginctl', ['enable-linger', process.env.USER || '']).catch(() => {});
    const { code, err } = await run('systemctl', ['--user', 'enable', '--now', UNIT(name)]);
    if (code !== 0) throw new Error(`systemctl enable failed: ${err}`);
    return { manager: 'systemd', path: this.unitPath(name) };
  },
  async uninstall(name) {
    await run('systemctl', ['--user', 'disable', '--now', UNIT(name)]).catch(() => {});
    await rm(this.unitPath(name), { force: true });
    await run('systemctl', ['--user', 'daemon-reload']);
    return true;
  },
  async status(name) {
    const { out } = await run('systemctl', ['--user', 'is-active', UNIT(name)]);
    return out.trim() === 'active' ? 'active' : 'inactive';
  },
};

// --- Task Scheduler (Windows) -----------------------------------------------
const taskScheduler = {
  async install(name) {
    const { exec, prefix } = selfCommand();
    const tr = [exec, ...prefix, 'daemon', '--setup', safeName(name)].map(winQuote).join(' ');
    const { code, err } = await run('schtasks', [
      '/Create', '/TN', TASK(name), '/TR', tr, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F',
    ]);
    if (code !== 0) throw new Error(`schtasks create failed: ${err}`);
    return { manager: 'task-scheduler', path: TASK(name) };
  },
  async uninstall(name) {
    await run('schtasks', ['/Delete', '/TN', TASK(name), '/F']).catch(() => {});
    return true;
  },
  async status(name) {
    const { code, out } = await run('schtasks', ['/Query', '/TN', TASK(name)]);
    if (code !== 0) return 'inactive';
    return /Running|Ready/i.test(out) ? 'active' : 'inactive';
  },
};

const xml = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
const shellQuote = (s) => (/[^\w@%+=:,./-]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s);
const winQuote = (s) => (/\s/.test(s) ? `\\"${s}\\"` : s);
