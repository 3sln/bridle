// Cross-platform "always available" service manager. ONE OS service — the shared
// `bridle server` — runs at login/boot and supervises every tether, restarting on
// failure. Three adapters behind one interface:
//
//   macOS    -> launchd LaunchAgent  (~/Library/LaunchAgents)
//   Linux    -> systemd user unit    (~/.config/systemd/user)
//   Windows  -> Scheduled Task       (schtasks, ONLOGON)
//
// Each adapter is parameterized by a job {key, args}: `key` names the service,
// `args` is the bridle command tail it runs. The server is {key:'server', args:
// ['server']}; the same adapters also uninstall the legacy per-tether services
// (key = the tether name) during migration. Kept dependency-free (shells out to
// the native tool); reached through the ServiceProvider so a new init system is a
// new adapter, not a rewrite.

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { safeName, serverRunning, stopLegacyDaemon, configDir } from './registry.js';

const SERVER_KEY = 'server';
const LABEL = (key) => `com.3sln.bridle.${key}`;
const UNIT = (key) => `bridle-${key}.service`;
const TASK = (key) => `Bridle_${key}`;

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

// --- the shared server service ----------------------------------------------
export async function installServerService() {
  return pick().install(SERVER_KEY, ['server']);
}
export async function uninstallServerService() {
  return pick().uninstall(SERVER_KEY);
}
export async function serverServiceStatus() {
  try {
    return await pick().status(SERVER_KEY);
  } catch {
    return 'unknown';
  }
}

/**
 * Fallback when the persistent service can't be installed: launch a *detached*
 * `bridle server`, unless one is already running. It survives this process
 * exiting but is transient — it won't come back after logout/reboot (that's what
 * the real service is for). Guarded by the single server lock.
 */
export async function startBackgroundServer() {
  if (serverRunning()) return { already: true };
  const { exec, prefix } = selfCommand();
  const args = [...prefix, 'server'];
  if (process.platform === 'win32') {
    // Windows console apps get a terminal window however they're launched, so the
    // server runs behind a tray host (hidden PowerShell + NotifyIcon) that starts
    // it truly windowless — same launcher the scheduled task uses.
    const vbs = await writeTrayLauncher(SERVER_KEY, exec, args);
    await run('wscript.exe', [vbs]);
  } else {
    const child = Bun.spawn([exec, ...args], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    child.unref?.();
  }
  return { already: false };
}

/**
 * One-time upgrade cleanup: remove the old per-tether OS services and stop their
 * daemons, so the single server owns every tether. Best-effort — a leftover we
 * can't reach just idles until reboot. `names` are the safe keys of the tethers
 * that used to each have their own service.
 */
export async function migrateLegacyServices(names) {
  const adapter = pick();
  for (const name of names) {
    const key = safeName(name);
    if (key === SERVER_KEY) continue;
    await adapter.uninstall(key).catch(() => {});
    stopLegacyDaemon(key); // kill any still-running per-tether daemon + clear its lock
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
  plistPath: (key) => join(homedir(), 'Library', 'LaunchAgents', `${LABEL(key)}.plist`),
  async install(key, tail) {
    const { exec, prefix } = selfCommand();
    const args = [...prefix, ...tail];
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL(key)}</string>
  <key>ProgramArguments</key><array>
    ${[exec, ...args].map((a) => `<string>${xml(a)}</string>`).join('\n    ')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${xml(join(homedir(), 'Library', 'Logs', `${LABEL(key)}.log`))}</string>
  <key>StandardErrorPath</key><string>${xml(join(homedir(), 'Library', 'Logs', `${LABEL(key)}.log`))}</string>
</dict></plist>`;
    const path = this.plistPath(key);
    await mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
    await writeFile(path, plist);
    await run('launchctl', ['unload', path]).catch(() => {});
    const { code, err } = await run('launchctl', ['load', '-w', path]);
    if (code !== 0) throw new Error(`launchctl load failed: ${err}`);
    return { manager: 'launchd', path };
  },
  async uninstall(key) {
    const path = this.plistPath(key);
    await run('launchctl', ['unload', '-w', path]).catch(() => {});
    await rm(path, { force: true });
    return true;
  },
  async status(key) {
    const { out } = await run('launchctl', ['list']);
    return out.includes(LABEL(key)) ? 'active' : 'inactive';
  },
};

// --- systemd (Linux, user scope) --------------------------------------------
const systemd = {
  unitDir: () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user'),
  unitPath(key) {
    return join(this.unitDir(), UNIT(key));
  },
  async install(key, tail) {
    const { exec, prefix } = selfCommand();
    const execStart = [exec, ...prefix, ...tail].map(shellQuote).join(' ');
    const unit = `[Unit]
Description=Bridle server (all tethers)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
    await mkdir(this.unitDir(), { recursive: true });
    await writeFile(this.unitPath(key), unit);
    await run('systemctl', ['--user', 'daemon-reload']);
    // Allow the service to run without an active login session (best effort).
    await run('loginctl', ['enable-linger', process.env.USER || '']).catch(() => {});
    const { code, err } = await run('systemctl', ['--user', 'enable', '--now', UNIT(key)]);
    if (code !== 0) throw new Error(`systemctl enable failed: ${err}`);
    return { manager: 'systemd', path: this.unitPath(key) };
  },
  async uninstall(key) {
    await run('systemctl', ['--user', 'disable', '--now', UNIT(key)]).catch(() => {});
    await rm(this.unitPath(key), { force: true });
    await run('systemctl', ['--user', 'daemon-reload']);
    return true;
  },
  async status(key) {
    const { out } = await run('systemctl', ['--user', 'is-active', UNIT(key)]);
    return out.trim() === 'active' ? 'active' : 'inactive';
  },
};

// --- Task Scheduler (Windows) -----------------------------------------------
// Registering a per-user task can be denied on locked-down machines (AppLocker /
// EPM / GPO). We don't try to auto-elevate (privilege tools distrust a scripted
// elevation); instead the caller falls back to a transient background server and
// tells the user to run `bridle daemonize` from a console they opened as admin —
// where this same install runs elevated and succeeds. The task itself always
// runs with a LIMITED token, so the agent never runs as admin.
//
// A scheduled task that launches the console binary directly pops a terminal
// window at every logon and keeps it open for the life of the server. So the
// task instead runs a hidden "tray host": `wscript` (no console of its own)
// starts a hidden PowerShell that launches the server truly windowless
// (CreateNoWindow) and shows a system-tray icon — the only visible presence —
// with a menu to restart or quit. See writeTrayLauncher below.
const taskScheduler = {
  async install(key, tail) {
    const task = TASK(key);
    const { exec, prefix } = selfCommand();
    const vbs = await writeTrayLauncher(key, exec, [...prefix, ...tail]);
    const tr = winCmdLine(['wscript.exe', vbs]);
    const created = await run('schtasks', [
      '/Create', '/TN', task, '/TR', tr, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F',
    ]);
    if (created.code !== 0) {
      throw new Error(created.err.trim() || 'schtasks create failed (access denied)');
    }
    // ONLOGON only registers it for future logins — start it now too, or the
    // tethers stay dark (phone stuck "waiting for desktop") until the next logon.
    await run('schtasks', ['/Run', '/TN', task]).catch(() => {});
    return { manager: 'task-scheduler', path: task };
  },
  async uninstall(key) {
    await run('schtasks', ['/End', '/TN', TASK(key)]).catch(() => {});
    await run('schtasks', ['/Delete', '/TN', TASK(key), '/F']).catch(() => {});
    await removeTrayLauncher(key);
    return true;
  },
  async status(key) {
    const { code, out } = await run('schtasks', ['/Query', '/TN', TASK(key)]);
    if (code !== 0) return 'inactive';
    return /Running|Ready/i.test(out) ? 'active' : 'inactive';
  },
};

const xml = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
const shellQuote = (s) => (/[^\w@%+=:,./-]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s);
// A Windows command line from tokens: quote any token containing spaces.
const winCmdLine = (tokens) => tokens.map((t) => (/\s/.test(t) ? `"${t}"` : t)).join(' ');

// --- Windows tray host (hidden background server + NotifyIcon) ---------------
const trayPs1Path = (key) => join(configDir(), `bridle-${key}-tray.ps1`);
const trayVbsPath = (key) => join(configDir(), `bridle-${key}.vbs`);
const psLiteral = (s) => `'${String(s).replace(/'/g, "''")}'`;

// The PowerShell tray host: launches the server windowless, shows a tray icon,
// keeps the server up while it lives, and tears the whole tree down on Quit.
function trayScript(exec, argsList) {
  const argsStr = argsList.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
  return `# bridle background server + tray icon (generated — safe to delete)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$Exe = ${psLiteral(exec)}
$ServerArgs = ${psLiteral(argsStr)}
function Start-Server {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Exe
  $psi.Arguments = $ServerArgs
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  return [System.Diagnostics.Process]::Start($psi)
}
function Stop-Tree($p) {
  if ($p -and -not $p.HasExited) {
    Start-Process 'taskkill' -ArgumentList '/PID', $p.Id, '/T', '/F' -WindowStyle Hidden -Wait
  }
}
$script:server = Start-Server
$script:quitting = $false
$script:fails = 0
try { $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($Exe) } catch { $icon = [System.Drawing.SystemIcons]::Application }
$script:ni = New-Object System.Windows.Forms.NotifyIcon
$script:ni.Icon = $icon
$script:ni.Text = 'bridle - running'
$script:ni.Visible = $true
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$hdr = $menu.Items.Add('bridle server'); $hdr.Enabled = $false
[void]$menu.Items.Add('-')
$restart = $menu.Items.Add('Restart')
$restart.add_Click({ Stop-Tree $script:server; $script:fails = 0; $script:server = Start-Server })
$quit = $menu.Items.Add('Quit bridle')
$quit.add_Click({
  $script:quitting = $true
  Stop-Tree $script:server
  $script:ni.Visible = $false
  $script:ni.Dispose()
  [System.Windows.Forms.Application]::Exit()
})
$script:ni.ContextMenuStrip = $menu
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({
  if ($script:quitting) { return }
  if ($script:server.HasExited) {
    $script:fails++
    if ($script:fails -le 5) { $script:server = Start-Server }
    else { $script:ni.Visible = $false; [System.Windows.Forms.Application]::Exit() }
  } else {
    $script:fails = 0
  }
})
$timer.Start()
[System.Windows.Forms.Application]::Run()
Stop-Tree $script:server
`;
}

// A .vbs that starts the tray host's PowerShell with no window of its own.
// WScript.Shell.Run(cmd, 0, False): 0 = hidden, False = don't wait.
function trayVbs(key) {
  const tokens = ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Sta', '-WindowStyle', 'Hidden', '-File', trayPs1Path(key)];
  const cmd = tokens.map((t) => `""${t}""`).join(' ');
  return `CreateObject("WScript.Shell").Run "${cmd}", 0, False\r\n`;
}

export async function writeTrayLauncher(key, exec, argsList) {
  await mkdir(configDir(), { recursive: true }).catch(() => {});
  await writeFile(trayPs1Path(key), trayScript(exec, argsList));
  await writeFile(trayVbsPath(key), trayVbs(key));
  return trayVbsPath(key);
}

export async function removeTrayLauncher(key) {
  await rm(trayVbsPath(key), { force: true }).catch(() => {});
  await rm(trayPs1Path(key), { force: true }).catch(() => {});
}
