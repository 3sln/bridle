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
//   phone text   --link--> agent stdin
//   phone audio  --link(binary)--> Whisper(STT) --link--> phone (transcript)
//   agent stdout --link--> phone (TTS reads it)
//   phone command--link--> agent control (interrupt / eof / restart / key)
//
// Command/dictation disambiguation lives on the PHONE: the host just transcribes
// and returns text. That keeps UX logic (and user config) on the device and the
// desktop dumb + fast.

import { Query } from '@3sln/ngin';
import { LINK, COMMAND, helloHost, output, status, transcript, sttError, pong } from '@bridle/protocol/link';
import { answer as mkAnswer } from '@bridle/protocol/signaling';

export const PHASE = Object.freeze({
  STARTING: 'starting',
  WAITING: 'waiting', // signaling up, no phone yet
  NEGOTIATING: 'negotiating', // offer received, answering
  TETHERED: 'tethered', // data channel open
  PEER_LEFT: 'peer-left',
  ERROR: 'error',
});

export class SessionQuery extends Query {
  static deps = ['config', 'agent', 'whisper', 'signaling', 'peer'];

  async boot({ config, agent, whisper, signaling, peer: makePeer }, { notify, engineFeed }) {
    const echo = (type, detail) => engineFeed.dispatchEvent(new CustomEvent(type, { detail }));

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
    let currentUtter = null; // { id, mime, chunks: [] }
    let peer = null; // the live HostPeer for the current connection
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
      if (!(peer && peer.send(output(text, stream)))) outBuffer += text;
      echo('agent-output', { text, stream });
    });
    onBase(agent, 'exit', (e) => {
      push({ agentState: 'exited' });
      peer?.send(status('exited', e.detail.code));
    });

    // --- per-connection peer ------------------------------------------------
    function teardownPeer() {
      for (const off of peerCleanups.splice(0)) off();
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
        peer.send(helloHost(config.agent.command.join(' '), config.agent.cwd));
        if (outBuffer) {
          peer.send(output(outBuffer));
          outBuffer = '';
        }
        push({ phase: PHASE.TETHERED });
      });
      on('closed', () => push({ phase: PHASE.PEER_LEFT }));
      on('binary', (e) => {
        if (currentUtter) currentUtter.chunks.push(toBuffer(e.detail.chunk));
      });
      on('message', (e) => handleLink(e.detail.msg));
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
      switch (msg.t) {
        case LINK.HELLO:
          push({ guest: msg.client || 'phone' });
          break;
        case LINK.TEXT:
          agent.write(msg.text.endsWith('\n') ? msg.text : msg.text + '\n');
          echo('guest-input', { text: msg.text });
          break;
        case LINK.COMMAND:
          runCommand(msg.name, msg.arg);
          break;
        case LINK.UTTER_BEGIN:
          currentUtter = { id: msg.id, mime: msg.mime || 'audio/webm', chunks: [] };
          break;
        case LINK.UTTER_END:
          await finishUtterance(msg.id);
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

    async function finishUtterance(id) {
      const utter = currentUtter;
      currentUtter = null;
      if (!utter || utter.id !== id || utter.chunks.length === 0) return;
      const audio = Buffer.concat(utter.chunks);
      try {
        const text = await whisper.transcribe(audio, utter.mime);
        peer?.send(transcript(id, text));
        echo('guest-transcript', { id, text });
      } catch (err) {
        peer?.send(sttError(id, err.message));
        push({ error: `STT: ${err.message}` });
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
    };
  }
}

function toBuffer(chunk) {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}
