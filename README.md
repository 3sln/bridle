# 🐴 bridle

Tether an AI agent CLI running on your **desktop** to your **phone** — over WebRTC,
with voice and chat. Talk to your agent from the couch; it runs where your code,
keys, and tools already are.

- **Desktop** spawns the agent CLI (default `claude`), holds your OpenAI key, runs
  **Whisper** STT on inbound voice, and is a WebRTC peer.
- **Phone** (an installable **PWA**) captures voice, streams it P2P to the desktop,
  reads replies aloud with the browser's **TTS**, and has a hands-free
  **conversation mode** with **voice commands**.
- **Backend** (`bridle.3sln.com`) only does **signaling** + hosts the PWA. The
  audio/chat hot path is **peer-to-peer**, so infra cost stays ~zero.

Built on the [3sln stack](https://github.com/3sln/stack): **ngin** (DI engine —
providers/actions/queries), **dodo** (functional VDOM), **bones** (reactive glue).
Every platform capability is wrapped in an ngin **Provider**, so nothing is locked
to Cloudflare, OpenAI, werift, or any one runtime.

## Install

```sh
# macOS / Linux
curl -fsSL https://bridle.3sln.com/install.sh | sh
# Windows (PowerShell)
irm https://bridle.3sln.com/install.ps1 | iex
```

Then, in any project:

```sh
export OPENAI_API_KEY=sk-...      # required for voice; chat works without it
bridle -- claude                  # pair: scan the QR with your phone
```

Scan the QR (or open the printed URL). The first time you tether, bridle
**installs itself as a background service** for that project and hands off — it's
now always available; your phone reconnects automatically.

```sh
bridle list                       # your daemonized tethers + status
bridle remove <name>              # stop + uninstall one
bridle -- claude --no-daemon      # pair without daemonizing
bridle --webview -- claude        # also pop a native QR window
```

## How it works

```
   phone (PWA)                 backend (bridle.3sln.com)          desktop (bridle)
 ┌───────────┐   WebSocket    ┌──────────────────────┐         ┌────────────────┐
 │ mic ──────┼── signaling ──▶│  signaling relay      │◀── signaling ──┤ werift peer │
 │ TTS ◀─────┤   (SDP/ICE)    │  + PWA static host    │         │  agent CLI     │
 └─────┬─────┘                └──────────────────────┘         │  Whisper STT   │
       │                                                        └───────┬────────┘
       └──────────────── WebRTC data channel (P2P) ────────────────────┘
              voice (audio) ▶ STT ▶ agent stdin  ·  agent stdout ▶ TTS
```

- **Voice in:** the phone records an utterance (VAD-segmented), ships the audio
  over the data channel to the desktop, which runs Whisper. The transcript comes
  back; the **phone** decides command vs. dictation and either acts locally or
  sends the text to the agent.
- **Voice out:** agent stdout streams to the phone, which speaks it with the
  browser's SpeechSynthesis, sentence by sentence (so "stop talking" cuts in).
- **Voice commands** (say the lead-in word, default `bridle`): `pause` / `resume`,
  `stop conversation`, `repeat`, `interrupt`, `faster` / `slower`, `clear`.
  `stop talking` / `be quiet` work without the lead-in for instant barge-in.

## Repo layout

```
packages/
  protocol/   shared wire protocol (signaling + P2P link + ICE)  — zero-dep ESM
  worker/     Cloudflare Worker: signaling relay + PWA host       (platform-agnostic core + CF adapter)
  desktop/    bun CLI: agent spawn, Whisper, werift peer, QR, daemon
  pwa/        ngin + dodo + bones app (providers / bl / ui)
```

The signaling logic (`worker/src/signaling-room.js`) is transport-neutral; the
Cloudflare Durable Object (`durable-object.js`) and the Bun `dev-server.js` are
just two adapters over it. Same idea on the desktop and phone: werift /
browser-RTC, OpenAI / any STT, launchd / systemd / Task Scheduler — all behind
providers.

## Deploy (bridle.3sln.com)

The backend deploys via **Cloudflare Workers Builds** (Git-connected). In the
Cloudflare dashboard, connect this repo and set:

| Setting | Value |
| --- | --- |
| Root directory | `/` (repo root) |
| Build command | `npm install && npm run build:pwa` |
| Deploy command | `npx wrangler deploy --config packages/worker/wrangler.toml` |

`wrangler.toml` provisions the **Custom Domain** `bridle.3sln.com` on the existing
`3sln.com` zone (doesn't touch sibling subdomains) and a SQLite-backed Durable
Object for signaling rooms (free-plan eligible). The PWA build output
(`packages/pwa/dist`) is served as static assets with SPA fallback.

Manual deploy:

```sh
npm run build:pwa
npm run deploy:worker
```

## Local development

```sh
bun install
bun run dev:signaling          # signaling + PWA host on http://localhost:8787
bun run dev:pwa                # vite dev server (open from your phone on the LAN)
bridle --local -- claude       # point the desktop at localhost:8787
```

Open the PWA with `?backend=http://<your-lan-ip>:8787#room=<code>` when running the
vite dev server separately from the worker.

## Requirements

- [Bun](https://bun.sh) ≥ 1.1 (desktop + tooling)
- `OPENAI_API_KEY` for Whisper STT (chat works without it)
- A modern mobile browser (Chrome/Safari) for the PWA — mic + SpeechSynthesis.

## License

MIT © Ray Stubbs
