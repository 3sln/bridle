# 🐴 bridle

Tether an AI agent CLI running on your **desktop** to your **phone** — over WebRTC,
with voice and chat. Talk to your agent from the couch; it runs where your code,
keys, and tools already are.

- **Desktop** spawns the agent CLI (default `claude`) and is a WebRTC peer. It
  pipes text in and streams output out — no API keys, no audio handling.
- **Phone** (an installable **PWA**) captures voice, transcribes it **offline in
  the browser** (Whisper via Transformers.js), reads replies aloud with the
  browser's **TTS**, and has a hands-free **conversation mode** with **voice
  commands**. Only text crosses the wire.
- **Backend** (`bridle.3sln.com`) only does **signaling** + hosts the PWA. The
  chat hot path is **peer-to-peer**, so infra cost stays ~zero.

**No API keys anywhere** — STT runs on-device, TTS is the browser's, and the
backend is just a relay.

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
bridle                  # pair (default agent: claude); scan the QR with your phone
bridle codex            # or pick another agent
bridle -- <cmd…>        # or run any other CLI in generic pipe mode
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
 ┌────────────────┐  WebSocket ┌──────────────────────┐         ┌────────────────┐
 │ mic ▶ Whisper  ┼─ signaling▶│  signaling relay      │◀ signaling ┤ werift peer  │
 │ (offline STT)  │  (SDP/ICE) │  + PWA static host    │         │  agent CLI     │
 │ TTS ◀──────────┤            └──────────────────────┘         └───────┬────────┘
 └───────┬────────┘                                                     │
         └──────────────── WebRTC data channel (P2P, text only) ────────┘
                 transcript ▶ agent stdin   ·   agent stdout ▶ TTS
```

- **Voice in:** the phone records an utterance (VAD-segmented), transcribes it
  **on-device** with Whisper, then decides command vs. dictation — acting locally
  or sending the **text** to the agent. No audio leaves the phone.
- **Voice out:** agent stdout streams to the phone, which speaks it with the
  browser's SpeechSynthesis, sentence by sentence (so "stop talking" cuts in).
- **Voice commands** (say the lead-in word, default `bridle`): `pause` / `resume`,
  `stop conversation`, `repeat`, `interrupt`, `faster` / `slower`, `clear`.
  `stop talking` / `be quiet` work without the lead-in for instant barge-in.

## Agents it drives

Bridle invokes each agent in its **headless** mode (prompt in → text out), not its
interactive TUI — so there's no PTY or ANSI to read aloud, and replies stream
cleanly to TTS. Pick one with `bridle <agent>` (default `claude`):

| Tier | Agents | How |
| --- | --- | --- |
| **Enhanced** (tuned + session continuity) | `claude`, `codex`, `antigravity` (`agy`), `gemini`, `opencode`, `aider`, `goose`, `cursor` | each tool's headless flag (`claude -p`, `codex exec`, `agy -p`, …) with explicit session IDs threaded through every turn |
| **Best-effort** | `q` (Amazon Q), `copilot` | headless flags that may shift between releases |
| **Baseline** (any CLI) | `bridle -- <cmd…>` | generic persistent pipe: your text → stdin, stdout → phone |

Adding a tuned agent is a one-line profile in `packages/desktop/src/agents.js`, not
a code change — the runner and everything downstream are agent-agnostic.

## Sessions

Bridle threads an explicit **session ID** through every call, so multi-turn voice
conversations keep context (for Claude it even owns the UUID: `--session-id` then
`--resume`). When you connect, it **attaches to the latest session you already had
going in that project** — so you can start in your terminal and pick it up by
voice — and **injects a one-time primer** telling the agent it's now speaking to a
voice client (be concise, no code dumps, read commands clearly), which the agent
acknowledges out loud.

Switch sessions hands-free: say **"bridle sessions"** to hear/see the list, then
**"bridle session 2"** (or tap one), or **"bridle new session"** to start fresh.
Sessions are read from each tool's own store (`~/.claude/projects/…`,
`~/.codex/sessions/…`).

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
- A modern mobile browser (Chrome/Safari) for the PWA — mic + SpeechSynthesis.
- First voice use downloads a small Whisper model (~40 MB for `whisper-tiny.en`,
  cached afterward; WebGPU is used when available, else WASM). No API keys.

## License

MIT © Ray Stubbs
