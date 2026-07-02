// The session — a single long-lived ngin Query that boots the whole P2P tether
// and `notify`s a status object the CLI renders. All resources are pre-obtained
// by ngin (Query deps = obtained resources) and released when the query is
// killed. `this.kill` tears everything down.
//
// A fresh WebRTC peer is minted per phone connection (peers are single-use), so
// a daemonized session survives unlimited reconnects. The agent process and
// signaling socket persist across reconnects.
//
// Data flow once tethered (backend NOT involved):
//   phone text   --link--> agent stdin   (already transcribed on-device)
//   agent stdout --link--> phone (TTS reads it)
//   phone command--link--> agent control (interrupt / eof / restart / key)
//
// STT/TTS and command/dictation disambiguation all live on the PHONE. The desktop
// just pipes text in and streams output out — it holds no keys and stays fast.

import { Query } from '@3sln/ngin';
import {
  LINK,
  LEVEL,
  COMMAND,
  helloHost,
  notice,
  output,
  status,
  pong,
  sessions as mkSessions,
  session as mkSession,
} from '@bridle/protocol/link';
import { answer as mkAnswer } from '@bridle/protocol/signaling';
import { fingerprintJwk, verifySignature } from '@bridle/protocol/identity';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '../mcp.js';

export const PHASE = Object.freeze({
  STARTING: 'starting',
  WAITING: 'waiting', // signaling up, no phone yet
  NEGOTIATING: 'negotiating', // offer received, answering
  TETHERED: 'tethered', // data channel open
  PEER_LEFT: 'peer-left',
  ERROR: 'error',
});

export class SessionQuery extends Query {
  static deps = ['config', 'agent', 'signaling', 'peer', 'frontend', 'registry'];

  async boot({ config, agent, signaling, peer: makePeer, frontend, registry }, { notify, engineFeed }) {
    const echo = (type, detail) => engineFeed.dispatchEvent(new CustomEvent(type, { detail }));

    // MCP server: lets the agent drive the phone front-end (audio/images/ask/…).
    let mcp = null;
    if (config.mcp.enabled && agent.profile?.mcp) {
      mcp = new McpServer({ controller: frontend, port: config.mcp.port });
      try {
        mcp.start();
        agent.setMcp({ url: mcp.url });
        echo('mcp-up', { url: mcp.url });
      } catch (err) {
        echo('agent-output', { text: `\n[bridle] MCP server failed to start: ${err.message}\n`, stream: 'stderr' });
        mcp = null;
      }
    }

    const state = {
      phase: PHASE.STARTING,
      room: config.room,
      pwaUrl: config.pwaUrl,
      guest: null,
      agentState: 'starting',
      ice: 'new',
      error: null,
    };
    const push = (patch) => {
      Object.assign(state, patch);
      notify({ ...state });
    };

    let outBuffer = ''; // agent output produced before a channel is open
    let peer = null; // the live HostPeer for the current connection
    // Incoming form-file uploads: bytes are streamed to a temp file so a big
    // upload never sits in memory or crosses into the agent's context.
    const formFiles = new Map(); // formId -> [{ field, name, path, size, mime }]
    let activeUpload = null;
    const takeFormFiles = (id) => {
      const f = formFiles.get(id) || [];
      formFiles.delete(id);
      return f;
    };
    let authed = false; // has the current peer proven its pinned device identity?
    let nonce = null; // per-connection challenge the guest must sign
    let preAuth = []; // messages that arrived before auth finished — replayed on admit
    let pinnedFingerprint = await registry.getPin(config.room); // TOFU device pin
    let currentSessionId = null;
    const sessionTitles = new Map();
    const baseCleanups = [];
    const peerCleanups = [];
    const onBase = (target, type, fn) => {
      target.addEventListener(type, fn);
      baseCleanups.push(() => target.removeEventListener(type, fn));
    };

    // --- agent (persists across reconnects) ---------------------------------
    agent.start();
    push({ agentState: 'running' });
    onBase(agent, 'output', (e) => {
      const { text, stream } = e.detail;
      // Only stream to a verified peer; otherwise buffer until one authenticates.
      if (!(authed && peer && peer.send(output(text, stream)))) outBuffer += text;
      echo('agent-output', { text, stream });
    });
    onBase(agent, 'exit', (e) => {
      push({ agentState: 'exited' });
      peer?.send(status('exited', e.detail.code));
    });
    // Turn boundaries let the phone show a "thinking" indicator for the whole turn
    // and hold anything typed/said mid-turn until the agent is ready for it. Only
    // oneshot agents emit these; pipe agents fall back to the phone's idle timer.
    onBase(agent, 'status', (e) => {
      if (e.detail?.state === 'turn-start') peer?.send(status('turn-start'));
    });
    onBase(agent, 'turn-end', (e) => peer?.send(status('turn-end', e.detail?.code)));
    // Active session changed (created/attached) -> tell the phone, and prime the
    // agent exactly once per session (tracked in the registry) so a reconnect or
    // resume never repeats the primer.
    onBase(agent, 'session', (e) => {
      currentSessionId = e.detail.id;
      const title = sessionTitles.get(e.detail.id) || shortId(e.detail.id);
      peer?.send(mkSession(e.detail.id, title, e.detail.resumed));
      primeOnce(e.detail.id);
    });
    function primeOnce(sid) {
      if (sid) {
        // oneshot: durable per-session tracking (survives reconnect + restart).
        if (registry.isSeeded(sid)) return;
        registry.markSeeded(sid);
      } else {
        // pipe agents have no session id — prime once per live process.
        if (agent.primed) return;
        agent.primed = true;
      }
      agent.prime();
    }

    // Attach to (or create) an agent session for this connection and prime it.
    async function attachSession(resumeId) {
      let id = resumeId;
      if (id === undefined) {
        if (config.session.id) id = config.session.id;
        else if (config.session.attachLatest) {
          const list = await agent.listSessions();
          list.forEach((s) => sessionTitles.set(s.id, s.title));
          id = list[0]?.id;
        }
      }
      agent.beginSession({ resumeId: id || undefined });
    }

    // --- per-connection peer ------------------------------------------------
    function teardownPeer() {
      for (const off of peerCleanups.splice(0)) off();
      frontend.detach();
      authed = false;
      nonce = null;
      preAuth = [];
      if (peer) {
        try {
          peer.close();
        } catch {
          /* noop */
        }
        peer = null;
      }
    }
    function newPeer() {
      teardownPeer();
      peer = makePeer();
      const on = (type, fn) => {
        peer.addEventListener(type, fn);
        peerCleanups.push(() => peer && peer.removeEventListener(type, fn));
      };
      on('state', (e) => push({ ice: e.detail.state }));
      on('open', () => {
        // Challenge the phone, but reveal nothing (no agent output, no front-end,
        // no session) until it proves the pinned device identity — see HELLO.
        nonce = crypto.randomUUID();
        peer.send(helloHost(config.agent.label, config.agent.cwd, nonce));
      });
      on('closed', () => push({ phase: PHASE.PEER_LEFT }));
      on('message', (e) => handleLink(e.detail.msg));
      on('binary', (e) => onUploadChunk(e.detail.chunk));
    }

    // Stream an in-flight form-file upload straight to disk (only from a verified
    // peer, and only between FORM_FILE_BEGIN/END).
    function onUploadChunk(chunk) {
      if (!authed || !activeUpload) return;
      const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      activeUpload.writer.write(u8);
      activeUpload.size += u8.byteLength;
    }

    // The guest passed the challenge: open the tether for real.
    async function admitGuest(guestName) {
      authed = true;
      push({ phase: PHASE.TETHERED, guest: guestName || 'phone' });
      if (outBuffer) {
        peer.send(output(outBuffer));
        outBuffer = '';
      }
      frontend.attach(peer); // the agent's MCP tools now reach this phone
      // First connect: start fresh (never silently resume an unrelated chat).
      // Reconnects: continue whatever session this tether was already on, so a
      // network blip doesn't drop you into a new conversation mid-task.
      await attachSession(currentSessionId || undefined);
      // Replay anything the phone sent between HELLO and admission (e.g. an
      // outbox flush) — it was held, not dropped, so no first message is lost.
      const held = preAuth.splice(0);
      for (const m of held) {
        await handleLink(m);
      }
    }

    // Verify the guest's signature over our nonce and enforce the device pin
    // (trust-on-first-use). Returns true only for the pinned device.
    async function verifyGuest(msg) {
      if (!msg.pubKey || !msg.sig) return false;
      if (!(await verifySignature(msg.pubKey, msg.sig, config.room, nonce))) return false;
      let fp;
      try {
        fp = await fingerprintJwk(msg.pubKey);
      } catch {
        return false;
      }
      if (!pinnedFingerprint) {
        pinnedFingerprint = fp;
        await registry.savePin(config.room, fp).catch(() => {});
        return true;
      }
      return pinnedFingerprint === fp;
    }

    // --- signaling <-> peer negotiation -------------------------------------
    onBase(signaling, 'open', () => push({ phase: PHASE.WAITING }));
    onBase(signaling, 'peer-join', () => {
      newPeer();
      push({ phase: PHASE.NEGOTIATING });
    });
    onBase(signaling, 'peer-leave', () => {
      teardownPeer();
      push({ phase: PHASE.PEER_LEFT, guest: null });
    });
    onBase(signaling, 'relay-error', (e) => push({ error: e.detail.message }));
    onBase(signaling, 'signal', async (e) => {
      try {
        if (!peer) newPeer(); // offer arrived before peer-join — be tolerant
        const answerSdp = await peer.accept(e.detail.data);
        if (answerSdp) signaling.sendSignal(mkAnswer(answerSdp));
      } catch (err) {
        push({ phase: PHASE.ERROR, error: `negotiation failed: ${err.message}` });
      }
    });

    async function handleLink(msg) {
      // Until the device is verified we act on nothing but its HELLO — but we hold
      // (don't drop) the rest, capped against a flood, and replay it once admitted.
      if (!authed && msg.t !== LINK.HELLO) {
        if (preAuth.length < 32) {
          preAuth.push(msg);
        }
        return;
      }
      switch (msg.t) {
        case LINK.HELLO: {
          const ok = await verifyGuest(msg);
          if (!ok) {
            peer?.send(notice('This device isn’t paired with this tether. Re-scan the QR on the desktop to pair it.', LEVEL.ERROR));
            echo('agent-output', { text: '\n[bridle] rejected an unrecognized device.\n', stream: 'stderr' });
            teardownPeer();
            push({ phase: PHASE.PEER_LEFT, guest: null });
            return;
          }
          await admitGuest(msg.client);
          break;
        }
        case LINK.TEXT: {
          // Tag the line so the (primed) agent knows it's from the phone and
          // whether it was spoken or typed.
          const prefix = msg.source === 'voice' ? 'bridle.voice: ' : 'bridle.text: ';
          const line = prefix + msg.text.replace(/\n+$/, '');
          agent.write(line + '\n');
          echo('guest-input', { text: msg.text });
          break;
        }
        case LINK.COMMAND:
          runCommand(msg.name, msg.arg);
          break;
        case LINK.LIST_SESSIONS: {
          const list = await agent.listSessions();
          list.forEach((s) => sessionTitles.set(s.id, s.title));
          peer?.send(mkSessions(list, currentSessionId));
          break;
        }
        case LINK.CONNECT_SESSION:
          // id present -> resume it; id null -> explicit fresh session.
          if (msg.id) attachSession(msg.id);
          else agent.beginSession({});
          break;
        case LINK.ASK_REPLY:
          frontend.resolveAsk(msg.id, msg.answer);
          break;
        case LINK.FORM_FILE_BEGIN: {
          const safe = String(msg.name || 'upload').replace(/[^\w.-]/g, '_').slice(-80) || 'upload';
          const path = join(tmpdir(), `bridle-upload-${process.pid}-${Date.now()}-${safe}`);
          activeUpload = { id: msg.id, field: msg.field, name: msg.name || safe, mime: msg.mime, path, size: 0, writer: Bun.file(path).writer() };
          break;
        }
        case LINK.FORM_FILE_END:
          if (activeUpload && activeUpload.id === msg.id && activeUpload.field === msg.field) {
            await activeUpload.writer.end();
            const list = formFiles.get(activeUpload.id) || [];
            list.push({ field: activeUpload.field, name: activeUpload.name, path: activeUpload.path, size: activeUpload.size, mime: activeUpload.mime });
            formFiles.set(activeUpload.id, list);
            activeUpload = null;
          }
          break;
        case LINK.FORM_REPLY:
          // The phone sends the text fields; any uploaded files were streamed
          // separately and saved to disk here, so we merge their paths in.
          frontend.resolveForm(msg.id, msg.values == null ? null : { values: msg.values, files: takeFormFiles(msg.id) });
          break;
        case LINK.PING:
          peer?.send(pong(msg.ts));
          break;
        default:
          break;
      }
    }

    function runCommand(name, arg) {
      switch (name) {
        case COMMAND.INTERRUPT: agent.interrupt(); break;
        case COMMAND.EOF: agent.eof(); break;
        case COMMAND.RESTART: agent.restart(); push({ agentState: 'running' }); break;
        case COMMAND.KEY: if (typeof arg === 'string') agent.write(arg); break;
        default: break;
      }
    }

    // Go.
    signaling.connect();
    notify({ ...state });

    this.kill = () => {
      for (const off of baseCleanups) off();
      teardownPeer();
      signaling.close();
      agent.kill();
      mcp?.stop();
    };
  }
}

const shortId = (id) => (id ? `session ${String(id).slice(0, 8)}` : 'new session');
