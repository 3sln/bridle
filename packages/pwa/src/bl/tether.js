// The phone's brain. One long-lived ngin Query boots the connection (guest /
// offerer), wires mic + TTS, drives conversation mode, and `notify`s a single
// UI state snapshot the composition renders via bones `watch`.
//
// User intents arrive as dispatched Actions that emit on the engineFeed; the
// query (which holds the live peer/mic/tts) reacts. This is ngin's choreographer
// pattern: Actions stay thin verbs, the Query owns coordination.

import { Query, Action } from '@3sln/ngin';
import {
  LINK,
  COMMAND,
  helloGuest,
  text as mkText,
  utterBegin,
  utterEnd,
  command as mkCommand,
} from '@bridle/protocol/link';
import { offer as mkOffer } from '@bridle/protocol/signaling';
import { parse as parseCommand, CMD } from './commands.js';

export const CONNECTION = Object.freeze({
  CONNECTING: 'connecting',
  WAITING: 'waiting', // signaling up, desktop not present yet
  NEGOTIATING: 'negotiating',
  TETHERED: 'tethered',
  RECONNECTING: 'reconnecting',
  ERROR: 'error',
});

const AUDIO_CHUNK = 16 * 1024;
const SPEAK_FLUSH_MS = 800;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lastBoundary = (s) => {
  const m = s.match(/[\s\S]*[.!?\n]/);
  return m ? m[0].length : 0;
};

export class TetherQuery extends Query {
  static deps = ['config', 'settings', 'signaling', 'peer', 'mic', 'tts'];

  async boot({ config, settings, signaling, peer: makePeer, mic, tts }, { notify, engineFeed }) {
    const state = {
      connection: CONNECTION.CONNECTING,
      conversation: false,
      listening: false,
      speaking: false,
      processing: false, // utterance sent, awaiting transcript
      messages: [],
      level: 0,
      error: null,
      room: config.room,
      agent: null,
      micSupported: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
      ttsSupported: tts.supported,
      voices: tts.voices().map((v) => v.name),
      settings: settings.all(),
      sheetOpen: false,
    };
    const refreshSettings = () => {
      state.settings = settings.all();
    };
    const nonce = Math.random().toString(36).slice(2, 8);
    const notifyNow = () => notify({ ...state, messages: state.messages.slice() });
    const push = (patch) => {
      Object.assign(state, patch);
      notifyNow();
    };

    let peer = null;
    let utterSeq = 0;
    let speakBuffer = '';
    let flushTimer = null;
    let lastLevelNotify = 0;

    // --- messages -----------------------------------------------------------
    const addMessage = (role, content, kind) => {
      if (role === 'user') markAssistantDone();
      state.messages.push({ id: `${nonce}-${state.messages.length}`, role, content, kind, ts: Date.now() });
      notifyNow();
    };
    const appendAssistant = (chunk) => {
      const last = state.messages[state.messages.length - 1];
      if (last && last.role === 'assistant' && !last.done) {
        last.content += chunk;
      } else {
        state.messages.push({ id: `${nonce}-${state.messages.length}`, role: 'assistant', content: chunk, ts: Date.now() });
      }
      notifyNow();
    };
    const markAssistantDone = () => {
      const last = state.messages[state.messages.length - 1];
      if (last && last.role === 'assistant') last.done = true;
    };

    // --- streaming TTS: speak whole sentences as output arrives --------------
    const speakChunk = (chunk) => {
      if (!settings.get('autoSpeak')) return;
      speakBuffer += chunk;
      const idx = lastBoundary(speakBuffer);
      if (idx > 0) {
        tts.speak(speakBuffer.slice(0, idx));
        speakBuffer = speakBuffer.slice(idx);
      }
      clearTimeout(flushTimer);
      flushTimer = setTimeout(flushSpeak, SPEAK_FLUSH_MS);
    };
    const flushSpeak = () => {
      clearTimeout(flushTimer);
      if (settings.get('autoSpeak') && speakBuffer.trim()) tts.speak(speakBuffer);
      speakBuffer = '';
    };

    // --- TTS <-> mic (barge-in: don't record ourselves while speaking) ------
    tts.addEventListener('speaking', () => {
      push({ speaking: true });
      if (state.conversation && state.listening) mic.pause();
    });
    tts.addEventListener('idle', () => {
      push({ speaking: false });
      if (state.conversation && state.listening) mic.resume();
    });

    // --- mic ----------------------------------------------------------------
    mic.addEventListener('level', (e) => {
      state.level = e.detail.level;
      const now = performance.now();
      if (now - lastLevelNotify > 120) {
        lastLevelNotify = now;
        notifyNow();
      }
    });
    mic.addEventListener('utterance', (e) => sendUtterance(e.detail));

    async function sendUtterance({ blob, mime }) {
      if (!peer) return;
      const id = `${nonce}-u${++utterSeq}`;
      peer.send(utterBegin(id, mime));
      const u8 = new Uint8Array(await blob.arrayBuffer());
      for (let o = 0; o < u8.length; o += AUDIO_CHUNK) {
        peer.sendBinary(u8.slice(o, o + AUDIO_CHUNK));
      }
      peer.send(utterEnd(id));
      push({ processing: true });
    }

    // --- connection / negotiation (guest = offerer) -------------------------
    function teardownPeer() {
      if (peer) {
        try {
          peer.close();
        } catch {
          /* noop */
        }
        peer = null;
      }
    }
    async function startOffer() {
      teardownPeer();
      push({ connection: CONNECTION.NEGOTIATING });
      peer = makePeer();
      peer.addEventListener('open', onPeerOpen);
      peer.addEventListener('message', (e) => handleLink(e.detail.msg));
      peer.addEventListener('closed', () => push({ connection: CONNECTION.WAITING }));
      peer.addEventListener('state', (e) => {
        if (e.detail.state === 'failed' || e.detail.state === 'disconnected') {
          push({ connection: CONNECTION.RECONNECTING });
        }
      });
      try {
        const sdp = await peer.makeOffer();
        signaling.sendSignal(mkOffer(sdp));
      } catch (err) {
        push({ connection: CONNECTION.ERROR, error: `offer failed: ${err.message}` });
      }
    }
    function onPeerOpen() {
      push({ connection: CONNECTION.TETHERED, error: null });
      peer.send(helloGuest());
      if (settings.get('conversationOnConnect')) startConversation();
    }

    signaling.addEventListener('open', () => push({ connection: CONNECTION.CONNECTING }));
    signaling.addEventListener('joined', (e) => {
      const peers = e.detail.peers || [];
      if (peers.includes('host')) startOffer();
      else push({ connection: CONNECTION.WAITING });
    });
    signaling.addEventListener('peer-join', (e) => {
      if (e.detail.role === 'host') startOffer();
    });
    signaling.addEventListener('peer-leave', () => {
      teardownPeer();
      push({ connection: CONNECTION.WAITING, agent: null });
    });
    signaling.addEventListener('signal', (e) => peer && peer.accept(e.detail.data));
    signaling.addEventListener('relay-error', (e) => push({ error: e.detail.message }));
    signaling.addEventListener('close', () => {
      if (state.connection === CONNECTION.TETHERED) push({ connection: CONNECTION.RECONNECTING });
    });

    // --- inbound link messages ----------------------------------------------
    function handleLink(msg) {
      switch (msg.t) {
        case LINK.HELLO:
          push({ agent: msg.agent || 'agent' });
          addMessage('system', `connected to ${msg.agent || 'agent'}`, 'status');
          break;
        case LINK.OUTPUT:
          appendAssistant(msg.text);
          speakChunk(msg.text);
          break;
        case LINK.STATUS:
          if (msg.state === 'exited') {
            markAssistantDone();
            flushSpeak();
            addMessage('system', `agent exited (${msg.code ?? '?'})`, 'status');
          }
          break;
        case LINK.TRANSCRIPT:
          onTranscript(msg.text);
          break;
        case LINK.STT_ERROR:
          push({ processing: false });
          addMessage('system', `couldn't catch that: ${msg.message}`, 'error');
          break;
        default:
          break;
      }
    }

    // The phone decides: command or dictation.
    function onTranscript(heard) {
      push({ processing: false });
      if (!heard || !heard.trim()) return;
      const cmd = parseCommand(heard, { leadIn: settings.get('commandLeadIn') });
      if (cmd) {
        addMessage('user', heard, 'command');
        runCommand(cmd);
      } else {
        addMessage('user', heard);
        peer?.send(mkText(heard));
      }
    }

    function runCommand(cmd) {
      switch (cmd.name) {
        case CMD.PAUSE_LISTENING:
          mic.pause();
          push({ listening: false });
          break;
        case CMD.RESUME_LISTENING:
          if (!state.conversation) startConversation();
          else {
            mic.resume();
            push({ listening: true });
          }
          break;
        case CMD.STOP_SPEAKING:
          tts.cancel();
          break;
        case CMD.REPEAT:
          tts.repeat();
          break;
        case CMD.START_CONVERSATION:
          startConversation();
          break;
        case CMD.STOP_CONVERSATION:
          stopConversation();
          break;
        case CMD.INTERRUPT_AGENT:
          peer?.send(mkCommand(COMMAND.INTERRUPT));
          break;
        case CMD.FASTER:
          settings.set('ttsRate', clamp(settings.get('ttsRate') + 0.15, 0.5, 2.5));
          refreshSettings();
          notifyNow();
          break;
        case CMD.SLOWER:
          settings.set('ttsRate', clamp(settings.get('ttsRate') - 0.15, 0.5, 2.5));
          refreshSettings();
          notifyNow();
          break;
        case CMD.CLEAR:
          state.messages = [];
          notifyNow();
          break;
        default:
          addMessage('system', `unknown command${cmd.rest ? `: ${cmd.rest}` : ''}`, 'error');
      }
    }

    // --- conversation + manual control --------------------------------------
    async function startConversation() {
      try {
        await mic.start();
        push({ conversation: true, listening: true });
      } catch (err) {
        push({ error: `mic: ${err.message}` });
      }
    }
    async function stopConversation() {
      await mic.stop();
      tts.cancel();
      push({ conversation: false, listening: false });
    }
    function toggleListening() {
      if (state.listening) {
        mic.pause();
        push({ listening: false });
      } else {
        mic.resume();
        push({ listening: true });
      }
    }

    // --- UI intents (dispatched Actions emit these on the engineFeed) -------
    function onIntent(e) {
      const it = e.detail || {};
      switch (it.type) {
        case 'send-text':
          if (it.text && it.text.trim()) {
            addMessage('user', it.text);
            peer?.send(mkText(it.text));
          }
          break;
        case 'toggle-conversation':
          state.conversation ? stopConversation() : startConversation();
          break;
        case 'toggle-listening':
          toggleListening();
          break;
        case 'stop-speaking':
          tts.cancel();
          break;
        case 'repeat':
          tts.repeat();
          break;
        case 'interrupt':
          peer?.send(mkCommand(COMMAND.INTERRUPT));
          break;
        case 'restart':
          peer?.send(mkCommand(COMMAND.RESTART));
          break;
        case 'clear':
          state.messages = [];
          notifyNow();
          break;
        case 'manual-start':
          mic.startManual().then(() => push({ listening: true })).catch((err) => push({ error: `mic: ${err.message}` }));
          break;
        case 'manual-stop':
          mic.stopManual();
          push({ listening: false });
          break;
        case 'settings-changed':
          refreshSettings();
          notifyNow();
          break;
        case 'set-sheet':
          push({ sheetOpen: !!it.open });
          break;
        default:
          break;
      }
    }
    engineFeed.addEventListener('intent', onIntent);

    // --- go -----------------------------------------------------------------
    signaling.connect();
    notifyNow();

    this.kill = () => {
      engineFeed.removeEventListener('intent', onIntent);
      clearTimeout(flushTimer);
      teardownPeer();
      signaling.close();
      mic.stop();
      tts.cancel();
    };
  }
}

// --- Actions (thin verbs the UI dispatches) ---------------------------------

const emit = (engineFeed, intent) => engineFeed.dispatchEvent(new CustomEvent('intent', { detail: intent }));

export class SendTextAction extends Action {
  constructor(text) {
    super();
    this.text = text;
  }
  execute(_, { engineFeed }) {
    emit(engineFeed, { type: 'send-text', text: this.text });
  }
}
class IntentOnly extends Action {
  execute(_, { engineFeed }) {
    emit(engineFeed, this.intent);
  }
}
export class ToggleConversationAction extends IntentOnly {
  intent = { type: 'toggle-conversation' };
}
export class ToggleListeningAction extends IntentOnly {
  intent = { type: 'toggle-listening' };
}
export class StopSpeakingAction extends IntentOnly {
  intent = { type: 'stop-speaking' };
}
export class RepeatAction extends IntentOnly {
  intent = { type: 'repeat' };
}
export class InterruptAgentAction extends IntentOnly {
  intent = { type: 'interrupt' };
}
export class RestartAgentAction extends IntentOnly {
  intent = { type: 'restart' };
}
export class ClearAction extends IntentOnly {
  intent = { type: 'clear' };
}
export class ManualStartAction extends IntentOnly {
  intent = { type: 'manual-start' };
}
export class ManualStopAction extends IntentOnly {
  intent = { type: 'manual-stop' };
}
export class OpenSettingsAction extends IntentOnly {
  intent = { type: 'set-sheet', open: true };
}
export class CloseSettingsAction extends IntentOnly {
  intent = { type: 'set-sheet', open: false };
}

export class SetSettingAction extends Action {
  static deps = ['settings'];
  constructor(key, value) {
    super();
    this.key = key;
    this.value = value;
  }
  execute({ settings }, { engineFeed }) {
    settings.set(this.key, this.value);
    emit(engineFeed, { type: 'settings-changed', key: this.key, value: this.value });
  }
}
