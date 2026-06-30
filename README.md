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

## Front-end control (the agent drives the phone)

Bridle runs a small **MCP server in-process** and auto-wires the agent to it (for
Claude: `--mcp-config` + `--allowedTools "mcp__bridle__*"`). Because it shares the
process with the live WebRTC link, a tool call reaches the phone directly — so the
agent can do more than talk:

| Tool | Effect on the phone |
| --- | --- |
| `play_audio(path\|url)` | send an audio file and play it |
| `show_image(path\|url)` | display an image |
| `show_file(path\|url)` | offer a file (download/preview) |
| `show_markdown(md)` | render a card (lists, links, tables) |
| `speak(text)` | say something via TTS |
| `notify(text)` | toast |
| `set_status(text)` | transient status line |
| `ask(question, choices?)` | prompt the user and **block for their spoken/tapped answer** |

So "read me my last voicemail" can have the agent transcribe it *and* `play_audio`
the clip; "which of these should I merge?" can `ask` with choices you answer by
voice. Files stream peer-to-peer over the data channel (no backend, no upload).
The MCP server binds to `127.0.0.1` only; disable with `--no-mcp`.

It's a minimal Streamable-HTTP MCP server (`packages/desktop/src/mcp.js`), so any
MCP-capable agent can use it — Claude is auto-configured; point others at the URL
bridle prints (`http://127.0.0.1:<port>/mcp`).

## Staying connected

A daemonized desktop holds its signaling socket to the backend **open 24/7** on a
**fixed room code**, so your phone can call in any time — open the PWA and it
re-handshakes. Drops re-establish automatically: the phone leaving triggers a
`peer-leave`, its return triggers a fresh offer/answer (and a re-prime); if the
desktop sleeps or changes networks it auto-reconnects to the same room with
backoff. Because the signaling room is a **hibernatable** Durable Object, the
always-open host socket costs almost nothing while idle — the DO sleeps between
signaling messages and wakes when a peer connects. (One host + one guest per room;
the chat itself is P2P and never touches the backend.)

## Multiple tethers

The phone keeps a **list of tethers** (desktops/agents) and switches between them —
their daemons keep running, so they coexist; you're just changing focus. Scan a
desktop's QR to add one (or paste its room code in **Tethers**). Switch by tapping
the active-tether chip in the header, or by voice: **"bridle tethers"** to see the
list, **"bridle tether 2"** to switch. Each tether auto-labels itself from the
desktop (`claude · my-project`).

## Hands-free / driving

Bridle is built for eyes-off use — talking to your agent while driving:

- **Driving mode** (one toggle): auto-starts conversation on connect, keeps the
  screen awake, and enables audio cues.
- **Car / headset / lock-screen controls** (MediaSession): play/pause &
  togglemicrophone→listen/pause, stop→stop talking, ⏮→repeat, ⏭→interrupt,
  ⏪/⏩→slower/faster speech, hangup→end. Steering-wheel buttons just work, and a
  silent keepalive holds the session so they fire even while only listening. The
  lock-screen "now playing" card shows the active tether/agent/session.
- **Earcons**: short tones for listening / thinking / answer-ready / error, so you
  know the state without looking.
- **Wake Lock** keeps the session alive; **barge-in** ("stop talking") cuts the
  agent off instantly; the **voice-connect primer** already tells the agent to keep
  replies short and speech-friendly.
- The agent can **push audio/answers** to you via MCP (`play_audio`, `ask`) — ideal
  when reading a screen isn't an option.

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
