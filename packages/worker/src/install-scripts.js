// Install scripts served from bridle.3sln.com/install.sh and /install.ps1.
// They download the right prebuilt single-file binary from GitHub Releases and
// drop it on PATH. The binaries are produced by `bun build --compile --target`
// in CI and uploaded as release assets named bridle-<os>-<arch>[.exe].
//
// We resolve the *newest* release via the GitHub API rather than the
// `/releases/latest/download/` redirect, because that redirect silently skips
// pre-releases — so a pre-release tag would 404. The API lists releases newest
// first (drafts excluded for anonymous callers), so the first entry's tag is the
// one to download, pre-release or not.
//
// Both scripts: fail with a clear one-line reason (never a raw stack trace),
// sanity-check that the download is actually the binary (not an HTML error page),
// and — because a running tether keeps the old binary open (a hard file lock on
// Windows) — offer to stop the tether so the upgrade can proceed, then restart it.

const REPO = '3sln/bridal';

export const INSTALL_SH = `#!/bin/sh
# bridle installer —  curl -fsSL https://bridle.3sln.com/install.sh | sh
set -e
REPO="${REPO}"
BIN="bridle"
API="https://api.github.com/repos/\${REPO}/releases"

info() { printf 'bridle: %s\\n' "\$1"; }
fail() { printf '\\n\\033[31m✗ bridle: %s\\033[0m\\n' "\$1" >&2; exit 1; }

os=\$(uname -s | tr '[:upper:]' '[:lower:]')
arch=\$(uname -m)
case "\$arch" in
  x86_64|amd64) arch="x64" ;;
  arm64|aarch64) arch="arm64" ;;
  *) fail "unsupported architecture: \$arch" ;;
esac
case "\$os" in
  darwin) os="darwin" ;;
  linux) os="linux" ;;
  *) fail "unsupported OS: \$os (on Windows, use install.ps1)" ;;
esac

asset="bridle-\${os}-\${arch}"
dest="\${BRIDLE_INSTALL:-\$HOME/.local/bin}"
mkdir -p "\$dest" || fail "couldn't create \$dest"

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "\$1"; else wget -qO- "\$1"; fi
}

# Newest release tag (pre-releases included; the first tag_name in the list is
# the most recent). /releases/latest would skip pre-releases.
info "finding latest release…"
releases=\$(fetch "\$API") || fail "couldn't reach GitHub — check your connection and try again."
tag=\$(printf '%s' "\$releases" | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\\1/')
[ -n "\$tag" ] || fail "no releases published for \${REPO} yet."
url="https://github.com/\${REPO}/releases/download/\${tag}/\${asset}"

# A running tether keeps the OLD binary until it restarts. Offer to stop it so
# the upgrade takes effect; we restart it afterwards.
stop_services() {
  if command -v launchctl >/dev/null 2>&1; then
    launchctl list 2>/dev/null | grep -o 'com\\.3sln\\.bridle\\.[^[:space:]]*' | while read -r l; do launchctl stop "\$l" 2>/dev/null || true; done
  fi
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user stop 'bridle-*.service' 2>/dev/null || true
  fi
  pkill -x "\$BIN" 2>/dev/null || true
}
start_services() {
  if command -v launchctl >/dev/null 2>&1; then
    launchctl list 2>/dev/null | grep -o 'com\\.3sln\\.bridle\\.[^[:space:]]*' | while read -r l; do launchctl start "\$l" 2>/dev/null || true; done
  fi
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user start 'bridle-*.service' 2>/dev/null || true
  fi
}

was_running=""
if pgrep -x "\$BIN" >/dev/null 2>&1; then
  was_running="1"
  info "a bridle tether is currently running."
  ans="y"
  if [ -t 0 ] && [ "\$BRIDLE_YES" != "1" ]; then
    printf 'Stop it to finish the upgrade? [Y/n] '
    read ans
  fi
  case "\$ans" in
    ''|y|Y|yes|YES) stop_services ;;
    *) fail "cancelled — stop your running tether, then re-run the installer." ;;
  esac
fi

info "downloading \$asset (\$tag)…"
tmp="\$dest/.\${BIN}.download"
if command -v curl >/dev/null 2>&1; then
  curl -fSL "\$url" -o "\$tmp" || fail "download failed — the release may still be publishing its \$os build; try again shortly."
else
  wget -O "\$tmp" "\$url" || fail "download failed — the release may still be publishing its \$os build; try again shortly."
fi
# Guard: a redirect or 404 can leave an HTML page on disk instead of the binary.
if [ "\$(wc -c < "\$tmp")" -lt 1000000 ]; then
  rm -f "\$tmp"
  fail "the downloaded file isn't the bridle binary (too small). Asset URL: \$url"
fi
chmod +x "\$tmp"
mv "\$tmp" "\$dest/\$BIN" || fail "couldn't move the binary into \$dest"

info "installed \$tag to \$dest/\$BIN"
if [ -n "\$was_running" ]; then
  start_services
  info "restarted your background tether(s) on the new build."
fi

case ":\$PATH:" in
  *":\$dest:"*) ;;
  *) info "add \$dest to your PATH, e.g.  export PATH=\\"\$dest:\\\$PATH\\"" ;;
esac
printf '\\n'
echo "next:  bridle -- claude        # pair, then it auto-daemonizes"
echo "       bridle list             # see your tethers"
`;

export const INSTALL_PS1 = `# bridle installer —  irm https://bridle.3sln.com/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$repo = '${REPO}'

function Info($m) { Write-Host "bridle: $m" }
function Fail($m) { Write-Host ""; Write-Host "x bridle: $m" -ForegroundColor Red; exit 1 }

$arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'arm64' }
$asset = "bridle-windows-$arch.exe"

# Newest release (pre-releases included; /releases/latest would skip them).
# Invoke-RestMethod hands back the JSON array as a single [Object[]], so indexing
# $releases[0] would grab the whole array (and .tag_name would enumerate EVERY
# tag). Pull the tag_name column and take the first — newest — entry instead.
Info "finding latest release..."
$headers = @{ 'User-Agent' = 'bridle-installer'; 'Accept' = 'application/vnd.github+json' }
try {
  $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases" -Headers $headers
} catch {
  Fail "couldn't reach GitHub ($($_.Exception.Message)). Check your connection and try again."
}
$tag = @($releases.tag_name)[0]
if (-not $tag) { Fail "no releases published for $repo yet." }
$url = "https://github.com/$repo/releases/download/$tag/$asset"

$dest = Join-Path $env:LOCALAPPDATA 'Programs\\bridle'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$out = Join-Path $dest 'bridle.exe'

# A running tether holds bridle.exe open (a hard lock on Windows), so we can't
# overwrite it. Offer to stop it; we restart any background tasks afterwards.
$script:stoppedTasks = @()
function Stop-Bridle {
  foreach ($t in @(Get-ScheduledTask -TaskName 'Bridle_*' -ErrorAction SilentlyContinue)) {
    schtasks /End /TN $t.TaskName 2>$null | Out-Null
    $script:stoppedTasks += $t.TaskName
  }
  @(Get-Process -Name bridle -ErrorAction SilentlyContinue) | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
}
function Confirm-Yes($prompt) {
  if ($env:BRIDLE_YES -eq '1') { return $true }
  try { $a = Read-Host "$prompt [Y/n]"; return ($a -eq '' -or $a -match '^(y|yes)$') }
  catch { Info "non-interactive shell - proceeding."; return $true }
}

if (@(Get-Process -Name bridle -ErrorAction SilentlyContinue).Count -gt 0) {
  Info "a bridle tether is currently running (it has the app file open)."
  if (Confirm-Yes "Stop it so the install can continue?") { Stop-Bridle }
  else { Fail "cancelled - stop your running tether, then re-run the installer." }
}

Info "downloading $asset ($tag)..."
$tmp = "$out.download"
try {
  Invoke-WebRequest -Uri $url -OutFile $tmp
} catch {
  Remove-Item $tmp -ErrorAction SilentlyContinue
  Fail "download failed ($($_.Exception.Message)). The release may still be publishing its Windows build - try again in a minute."
}
# Guard: a redirect or 404 can leave an HTML page on disk instead of the binary.
if ((Get-Item $tmp).Length -lt 1MB) {
  Remove-Item $tmp -ErrorAction SilentlyContinue
  Fail "the downloaded file isn't the bridle binary (too small). Asset URL: $url"
}
try {
  Move-Item -Path $tmp -Destination $out -Force
} catch {
  Stop-Bridle
  try { Move-Item -Path $tmp -Destination $out -Force }
  catch { Remove-Item $tmp -ErrorAction SilentlyContinue; Fail "couldn't replace $out - is a tether still running? ($($_.Exception.Message))" }
}

foreach ($tn in $script:stoppedTasks) { schtasks /Run /TN $tn 2>$null | Out-Null }
if ($script:stoppedTasks.Count -gt 0) { Info "restarted your background tether(s) on the new build." }

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$dest*") {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$dest", 'User')
  Info "added $dest to your PATH (restart your terminal)"
}
Write-Host ""
Write-Host "OK  bridle $tag installed to $out" -ForegroundColor Green
Write-Host ""
Write-Host "next:  bridle -- claude        # pair, then it auto-daemonizes"
Write-Host "       bridle list             # see your tethers"
`;

export const INSTALL_HELP = `bridle — install

  macOS / Linux:   curl -fsSL https://bridle.3sln.com/install.sh | sh
  Windows:         irm https://bridle.3sln.com/install.ps1 | iex

Then:  bridle -- claude
`;
