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

const REPO = '3sln/bridal';

export const INSTALL_SH = `#!/bin/sh
# bridle installer —  curl -fsSL https://bridle.3sln.com/install.sh | sh
set -e
REPO="${REPO}"
BIN="bridle"
API="https://api.github.com/repos/\${REPO}/releases"

os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$arch" in
  x86_64|amd64) arch="x64" ;;
  arm64|aarch64) arch="arm64" ;;
  *) echo "bridle: unsupported architecture: $arch" >&2; exit 1 ;;
esac
case "$os" in
  darwin) os="darwin" ;;
  linux) os="linux" ;;
  *) echo "bridle: unsupported OS: $os (use install.ps1 on Windows)" >&2; exit 1 ;;
esac

asset="bridle-\${os}-\${arch}"
dest="\${BRIDLE_INSTALL:-$HOME/.local/bin}"
mkdir -p "$dest"

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"; else wget -qO- "$1"; fi
}

# Newest release tag (pre-releases included; the first tag_name in the list is
# the most recent). /releases/latest would skip pre-releases.
echo "bridle: finding latest release…"
tag=$(fetch "$API" | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\\1/')
if [ -z "$tag" ]; then
  echo "bridle: no release found for \${REPO}" >&2
  exit 1
fi
url="https://github.com/\${REPO}/releases/download/\${tag}/\${asset}"

echo "bridle: downloading $asset ($tag)…"
if command -v curl >/dev/null 2>&1; then
  curl -fSL "$url" -o "$dest/$BIN"
else
  wget -O "$dest/$BIN" "$url"
fi
chmod +x "$dest/$BIN"

echo "bridle: installed to $dest/$BIN"
case ":$PATH:" in
  *":$dest:"*) ;;
  *) echo "bridle: add $dest to your PATH, e.g.  export PATH=\\"$dest:\\$PATH\\"" ;;
esac
echo ""
echo "next:  bridle -- claude        # pair, then it auto-daemonizes"
echo "       bridle list             # see your tethers"
`;

export const INSTALL_PS1 = `# bridle installer —  irm https://bridle.3sln.com/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$repo = '${REPO}'
$arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'arm64' }
$asset = "bridle-windows-$arch.exe"

# Newest release (pre-releases included; /releases/latest would skip them).
# Invoke-RestMethod hands back the JSON array as a single [Object[]], so indexing
# $releases[0] would grab the whole array (and .tag_name would enumerate EVERY
# tag). Pull the tag_name column and take the first — newest — entry instead.
Write-Host "bridle: finding latest release…"
$headers = @{ 'User-Agent' = 'bridle-installer'; 'Accept' = 'application/vnd.github+json' }
$releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases" -Headers $headers
$tag = @($releases.tag_name)[0]
if (-not $tag) { throw "bridle: no release found for $repo" }
$url = "https://github.com/$repo/releases/download/$tag/$asset"

$dest = Join-Path $env:LOCALAPPDATA 'Programs\\bridle'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$out = Join-Path $dest 'bridle.exe'

Write-Host "bridle: downloading $asset ($tag)…"
Invoke-WebRequest -Uri $url -OutFile $out

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$dest*") {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$dest", 'User')
  Write-Host "bridle: added $dest to your PATH (restart your terminal)"
}
Write-Host "bridle: installed to $out"
Write-Host ""
Write-Host "next:  bridle -- claude        # pair, then it auto-daemonizes"
Write-Host "       bridle list             # see your tethers"
`;

export const INSTALL_HELP = `bridle — install

  macOS / Linux:   curl -fsSL https://bridle.3sln.com/install.sh | sh
  Windows:         irm https://bridle.3sln.com/install.ps1 | iex

Then:  bridle -- claude
`;
