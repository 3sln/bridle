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
  command as mkCommand,
  listSessions as mkListSessions,
  connectSession as mkConnectSession,
  askReply as mkAskReply,
} from '@bridle/protocol/link';
import { offer as mkOffer } from '@bridle/protocol/signaling';
import { parse as parseCommand, CMD } from './commands.js';
import { createEarcons, createWakeLock, setupMediaSession } from '../hands.js';

export const CONNECTION = Object.freeze({
  NONE: 'no-tether', // no tether selected — scan a QR
  CONNECTING: 'connecting',
  WAITING: 'waiting', // signaling up, desktop not present yet
  NEGOTIATING: 'negotiating',
  TETHERED: 'tethered',
  RECONNECTING: 'reconnecting',
  ERROR: 'error',
});

const SPEAK_FLUSH_MS = 800;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lastBoundary = (s) => {
  const m = s.match(/[\s\S]*[.!?\n]/);
  return m ? m[0].length : 0;
};

const ORDINAL = { one: 1, two: 2, three: 3, four: 4, five: 5, first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };
// Map a spoken answer onto one of the offered choices (exact / contains / ordinal).
function resolveChoice(text, choices) {
  const t = (text || '').trim();
  if (!choices || !choices.length) return t;
  const low = t.toLowerCase().replace(/[.,!?]$/g, '');
  const exact = choices.find((c) => c.toLowerCase() === low);
  if (exact) return exact;
  const part = choices.find((c) => low.includes(c.toLowerCase()) || c.toLowerCase().includes(low));
  if (part) return part;
  const n = /^\d+$/.test(low) ? parseInt(low, 10) : ORDINAL[low];
  if (n && choices[n - 1]) return choices[n - 1];
  return t;
}

export class TetherQuery extends Query {
  static deps = ['config', 'settings', 'signaling', 'peer', 'mic', 'tts', 'stt', 'tethers', 'identity'];

  async boot({ config, settings, signaling, peer: makePeer, mic, tts, stt, tethers, identity }, { notify, engineFeed }) {
    const state = {
      connection: CONNECTION.NONE,
      conversation: false,
      listening: false,
      speaking: false,
      processing: false, // transcribing an utterance on-device
      sttState: 'idle', // idle | loading | ready | error
      sttProgress: null, // 0..100 when totals are known; null = indeterminate
      sttBytes: 0, // bytes downloaded so far (always known, monotonic)
      preparingVoice: false, // gating hands-free on the one-time model download
      messages: [],
      level: 0,
      error: null,
      room: '',
      agent: null,
      micSupported: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
      ttsSupported: tts.supported,
      voices: tts.voices().map((v) => v.name),
      settings: settings.all(),
      sheetOpen: false,
      sessions: [], // resumable agent sessions (when listed)
      currentSession: null, // { id, title }
      sessionsOpen: false,
      statusLine: '', // transient agent status (set_status)
      toast: null, // { text, level } notice
      ask: null, // { id, question, choices } pending prompt
      tethers: [], // known desktops/agents this phone can reach
      activeTetherId: null,
      tetherLabel: null,
      tethersOpen: false,
      detailsOpen: false, // the connection-details sheet (opened from the status bead)
      shortcutsOpen: false, // keyboard-shortcuts help (desktop)
    };

    // Hands-free helpers (driving / eyes-off use).
    const earcons = createEarcons();
    const wake = createWakeLock();
    const earcon = (name) => settings.get('earcons') && earcons[name] && earcons[name]();
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
    let speakBuffer = '';
    let incomingAsset = null; // asset being received (between ASSET_BEGIN/END)
    let replyPending = false; // we sent input and are awaiting the agent's reply
    let flushTimer = null;
    let lastLevelNotify = 0;

    // --- messages -----------------------------------------------------------
    const addMessage = (role, content, kind, extra) => {
      if (role === 'user') markAssistantDone();
      state.messages.push({ id: `${nonce}-${state.messages.length}`, role, content, kind, ts: Date.now(), ...extra });
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
    mic.addEventListener('utterance', (e) => transcribeUtterance(e.detail));

    // Offline STT model load progress -> UI (one-time download). The worker
    // already aggregates per-file bytes into one number; clamp it monotonic here
    // so a late-arriving file can never make the bar jump backwards.
    stt.addEventListener('progress', (e) => {
      const d = e.detail || {};
      if (d.status === 'fallback') return;
      const patch = { sttState: 'loading' };
      if (typeof d.progress === 'number') patch.sttProgress = Math.max(state.sttProgress || 0, Math.round(d.progress));
      if (typeof d.loaded === 'number') patch.sttBytes = Math.max(state.sttBytes || 0, d.loaded);
      push(patch);
    });
    stt.addEventListener('ready', () => push({ sttState: 'ready', sttProgress: 100 }));
    // A model-load failure (e.g. the one-time CDN download) otherwise dies in the
    // worker with the loading banner stuck — surface it and stop conversation.
    stt.addEventListener('error', (e) => {
      earcon('error');
      push({ sttState: 'error', preparingVoice: false, error: `couldn't load the speech model: ${e.detail?.message || 'fetch failed'}` });
      if (state.conversation) stopConversation();
    });

    // Transcribe locally, then decide: command (run here) or dictation (-> agent).
    async function transcribeUtterance({ blob }) {
      push({ processing: true });
      earcon('think');
      try {
        const heard = await stt.transcribe(blob);
        push({ processing: false, sttState: 'ready' });
        onTranscript(heard);
      } catch (err) {
        earcon('error');
        push({ processing: false, sttState: 'error', error: `speech: ${err.message}` });
      }
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
      // Mint a fresh peer with ICE servers from the active tether's backend, so
      // a short-lived Cloudflare TURN credential (if any) is scoped per session.
      const t = tethers.active();
      peer = await makePeer({ backendUrl: t?.backendUrl, room: t?.room });
      peer.addEventListener('open', onPeerOpen);
      peer.addEventListener('message', (e) => handleLink(e.detail.msg));
      peer.addEventListener('binary', (e) => onBinary(e.detail.chunk));
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
      // Wait for the host's HELLO (it carries the auth nonce) before replying
      // with our signed device HELLO — see the LINK.HELLO handler.
      updateNowPlaying();
      if (settings.get('conversationOnConnect') || settings.get('drivingMode')) startConversation();
    }
    // Prove this device to the host: sign `${token}|${nonce}` with our persistent
    // key. The host TOFU-pins the key on first pair and rejects any other later.
    async function sendSignedHello(nonce) {
      const token = tethers.active()?.room || '';
      try {
        const pubKey = await identity.publicKeyJwk();
        const sig = await identity.sign(token, nonce);
        peer?.send(helloGuest({ pubKey, sig }));
      } catch {
        peer?.send(helloGuest());
      }
    }

    // --- tethers: connect to the active one; reconnect on switch ------------
    let currentTetherId = null;
    const refreshTethers = () => {
      state.tethers = tethers.list();
      state.activeTetherId = tethers.activeId;
      // Keep the status-bar chip in sync with the active tether's label, so the
      // desktop's friendly auto-label (agent · dir) replaces the raw room code
      // once HELLO arrives — `change` fires without a reconnect.
      const active = tethers.active();
      state.tetherLabel = active ? active.label : null;
    };
    function connectActive() {
      const t = tethers.active();
      teardownPeer();
      signaling.close();
      refreshTethers();
      currentTetherId = t?.id || null;
      if (t) {
        push({ connection: CONNECTION.CONNECTING, room: t.room, tetherLabel: t.label, agent: null, currentSession: null });
        signaling.connect({ url: t.backendUrl, room: t.room });
      } else {
        push({ connection: CONNECTION.NONE, room: '', tetherLabel: null });
      }
    }
    tethers.addEventListener('change', () => {
      refreshTethers();
      if ((tethers.active()?.id || null) !== currentTetherId) connectActive();
      else notifyNow();
    });

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
        case LINK.HELLO: {
          push({ agent: msg.agent || 'agent' });
          sendSignedHello(msg.nonce); // authenticate this device to the host
          // Give the active tether a friendly auto-label from the desktop.
          const base = (msg.cwd || '').split(/[\\/]/).filter(Boolean).pop();
          if (state.activeTetherId) tethers.setAutoLabel(state.activeTetherId, base ? `${msg.agent} · ${base}` : msg.agent);
          addMessage('system', `connected to ${msg.agent || 'agent'}`, 'status');
          updateNowPlaying();
          break;
        }
        case LINK.OUTPUT:
          if (replyPending) {
            earcon('done');
            replyPending = false;
          }
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
        case LINK.SESSIONS:
          push({ sessions: msg.sessions || [], currentSession: findSession(msg.sessions, msg.currentId), sessionsOpen: true });
          break;
        case LINK.SESSION:
          markAssistantDone();
          // A fresh conversation starts from a clean transcript.
          if (!msg.resumed) state.messages = [];
          push({ currentSession: { id: msg.id, title: msg.title }, sessionsOpen: false });
          addMessage('system', msg.resumed ? `resumed ${msg.title}` : 'new conversation', 'status');
          updateNowPlaying();
          break;

        // --- front-end control (agent MCP tools) ---
        case LINK.SPEAK:
          tts.speak(msg.text);
          break;
        case LINK.STATUSLINE:
          push({ statusLine: msg.text || '' });
          break;
        case LINK.NOTICE:
          showToast(msg.text, msg.level);
          break;
        case LINK.MARKDOWN:
          markAssistantDone();
          addMessage('assistant', msg.markdown, 'markdown', { title: msg.title });
          break;
        case LINK.ASK:
          push({ ask: { id: msg.id, question: msg.question, choices: msg.choices } });
          if (settings.get('autoSpeak')) tts.speak(msg.question, { remember: false });
          break;
        case LINK.ASSET_BEGIN:
          incomingAsset = { ...msg, chunks: [], received: 0 };
          break;
        case LINK.ASSET_END:
          finishAsset(msg.id);
          break;
        default:
          break;
      }
    }

    function onBinary(chunk) {
      if (incomingAsset) {
        incomingAsset.chunks.push(chunk);
        incomingAsset.received += chunk.byteLength || 0;
      }
    }

    function finishAsset(id) {
      const a = incomingAsset;
      incomingAsset = null;
      if (!a || a.id !== id || !a.chunks.length) return;
      const blob = new Blob(a.chunks, { type: a.mime || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      markAssistantDone();
      addMessage('assistant', (a.meta && a.meta.caption) || a.name || '', a.kind, {
        url,
        name: a.name,
        mime: a.mime,
        autoplay: a.kind === 'audio' && (!a.meta || a.meta.autoplay !== false),
      });
    }

    let toastTimer = null;
    function showToast(text, level = 'info') {
      push({ toast: { text, level } });
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => push({ toast: null }), 5000);
    }

    const findSession = (list, id) => (list || []).find((s) => s.id === id) || (id ? { id, title: 'current' } : null);

    // The phone decides: command or dictation.
    function onTranscript(heard) {
      push({ processing: false });
      if (!heard || !heard.trim()) return;
      const cmd = parseCommand(heard, { leadIn: settings.get('commandLeadIn') });
      if (cmd) {
        addMessage('user', heard, 'command');
        runCommand(cmd);
      } else if (state.ask) {
        // A question is pending — this speech is the answer.
        answerAsk(resolveChoice(heard, state.ask.choices));
      } else {
        addMessage('user', heard);
        peer?.send(mkText(heard));
        replyPending = true;
      }
    }

    function answerAsk(answer) {
      if (!state.ask) return;
      peer?.send(mkAskReply(state.ask.id, answer));
      addMessage('user', answer, 'answer');
      push({ ask: null });
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
          adjustRate(0.15);
          break;
        case CMD.SLOWER:
          adjustRate(-0.15);
          break;
        case CMD.CLEAR:
          state.messages = [];
          notifyNow();
          break;
        case CMD.SESSIONS:
          peer?.send(mkListSessions());
          break;
        case CMD.NEW_SESSION:
          peer?.send(mkConnectSession(null));
          break;
        case CMD.CONNECT_SESSION: {
          const target = state.sessions[(cmd.index || 1) - 1];
          if (target) peer?.send(mkConnectSession(target.id));
          else {
            peer?.send(mkListSessions());
            addMessage('system', `say "${settings.get('commandLeadIn')} sessions" first to see the list`, 'status');
          }
          break;
        }
        case CMD.TETHERS:
          push({ tethersOpen: true });
          break;
        case CMD.SWITCH_TETHER: {
          const t = state.tethers[(cmd.index || 1) - 1];
          if (t) tethers.setActive(t.id);
          else push({ tethersOpen: true });
          break;
        }
        default:
          addMessage('system', `unknown command${cmd.rest ? `: ${cmd.rest}` : ''}`, 'error');
      }
    }

    // --- conversation + manual control --------------------------------------
    async function startConversation() {
      earcons.resume(); // unlock audio for earcons within this user gesture
      // Don't pretend we're listening before the model can actually transcribe:
      // on first use, gate behind a full-screen "preparing voice" overlay until
      // the one-time download finishes. Subsequent starts are instant.
      if (stt.readyState !== 'ready') {
        push({ preparingVoice: true, sttState: 'loading', sttProgress: null, sttBytes: 0, error: null });
        try {
          await stt.ensureReady();
        } catch (err) {
          push({ preparingVoice: false, sttState: 'error', error: `couldn't load the speech model: ${err.message}` });
          return;
        }
        if (!state.preparingVoice) return; // user backed out while it loaded
        push({ preparingVoice: false, sttState: 'ready' });
      }
      try {
        await mic.start();
        if (settings.get('keepAwake') || settings.get('drivingMode')) wake.enable();
        if (settings.get('mediaControls')) media.activate(); // hold session for hw buttons
        push({ conversation: true, listening: true });
        media.setListening(true);
        earcon('listen');
      } catch (err) {
        push({ error: `mic: ${err.message}` });
      }
    }
    function cancelPreparingVoice() {
      push({ preparingVoice: false });
    }
    async function stopConversation() {
      await mic.stop();
      tts.cancel();
      wake.disable();
      media.deactivate();
      push({ conversation: false, listening: false });
      earcon('stop');
    }
    function toggleListening() {
      if (state.listening) {
        mic.pause();
        push({ listening: false });
        media.setListening(false);
        earcon('stop');
      } else {
        mic.resume();
        push({ listening: true });
        media.setListening(true);
        earcon('listen');
      }
    }
    function adjustRate(delta) {
      settings.set('ttsRate', clamp(settings.get('ttsRate') + delta, 0.5, 2.5));
      refreshSettings();
      notifyNow();
    }
    // Lock-screen / car "now playing" card: what you're tethered to.
    function updateNowPlaying() {
      media.update({
        title: state.tetherLabel || state.agent || 'bridle',
        artist: (state.currentSession && state.currentSession.title) || (state.agent ? 'voice agent' : 'tether your agent'),
      });
    }

    // --- UI intents (dispatched Actions emit these on the engineFeed) -------
    function onIntent(e) {
      const it = e.detail || {};
      switch (it.type) {
        case 'send-text':
          if (it.text && it.text.trim()) {
            if (state.ask) {
              peer?.send(mkAskReply(state.ask.id, it.text));
              addMessage('user', it.text, 'answer');
              push({ ask: null });
            } else {
              addMessage('user', it.text);
              peer?.send(mkText(it.text));
            }
          }
          break;
        case 'toggle-conversation':
          state.conversation ? stopConversation() : startConversation();
          break;
        case 'cancel-voice-prep':
          cancelPreparingVoice();
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
          stt.prewarm();
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
        case 'list-sessions':
          peer?.send(mkListSessions());
          break;
        case 'connect-session':
          peer?.send(mkConnectSession(it.id || null));
          break;
        case 'set-sessions-sheet':
          push({ sessionsOpen: !!it.open });
          break;
        case 'answer-ask':
          if (state.ask) {
            peer?.send(mkAskReply(state.ask.id, it.answer));
            addMessage('user', it.answer, 'answer');
            push({ ask: null });
          }
          break;
        case 'switch-tether':
          tethers.setActive(it.id);
          break;
        case 'add-tether':
          if (it.room) tethers.setActive(tethers.add({ room: it.room, backendUrl: it.backendUrl, label: it.label }));
          break;
        case 'remove-tether':
          tethers.remove(it.id);
          break;
        case 'rename-tether':
          tethers.rename(it.id, it.label);
          break;
        case 'set-tethers-sheet':
          push({ tethersOpen: !!it.open });
          break;
        case 'set-details-sheet':
          push({ detailsOpen: !!it.open });
          break;
        case 'set-shortcuts':
          push({ shortcutsOpen: !!it.open });
          break;
        case 'close-sheets':
          if (state.sheetOpen || state.sessionsOpen || state.tethersOpen || state.detailsOpen || state.shortcutsOpen || state.preparingVoice) {
            push({ sheetOpen: false, sessionsOpen: false, tethersOpen: false, detailsOpen: false, shortcutsOpen: false, preparingVoice: false });
          }
          break;
        default:
          break;
      }
    }
    engineFeed.addEventListener('intent', onIntent);

    // Hardware transport controls (headset / Bluetooth / car / lock screen).
    const media = setupMediaSession({
      play: () => { if (!state.conversation) startConversation(); else if (!state.listening) toggleListening(); },
      pause: () => state.listening && toggleListening(),
      toggleMic: () => (state.conversation ? toggleListening() : startConversation()),
      stop: () => tts.cancel(), // barge-in
      previous: () => tts.repeat(),
      next: () => peer?.send(mkCommand(COMMAND.INTERRUPT)), // skip = interrupt the turn
      seekForward: () => adjustRate(0.15), // faster speech
      seekBackward: () => adjustRate(-0.15), // slower speech
      hangup: () => stopConversation(),
    });

    // --- go -----------------------------------------------------------------
    connectActive();
    notifyNow();

    this.kill = () => {
      engineFeed.removeEventListener('intent', onIntent);
      clearTimeout(flushTimer);
      teardownPeer();
      signaling.close();
      mic.stop();
      tts.cancel();
      wake.disable();
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
export class CancelVoicePrepAction extends IntentOnly {
  intent = { type: 'cancel-voice-prep' };
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
export class ListSessionsAction extends IntentOnly {
  intent = { type: 'list-sessions' };
}
export class NewSessionAction extends Action {
  execute(_, { engineFeed }) {
    emit(engineFeed, { type: 'connect-session', id: null });
  }
}
export class ConnectSessionAction extends Action {
  constructor(id) {
    super();
    this.id = id;
  }
  execute(_, { engineFeed }) {
    emit(engineFeed, { type: 'connect-session', id: this.id });
  }
}
export class CloseSessionsAction extends IntentOnly {
  intent = { type: 'set-sessions-sheet', open: false };
}
export class AnswerAskAction extends Action {
  constructor(answer) {
    super();
    this.answer = answer;
  }
  execute(_, { engineFeed }) {
    emit(engineFeed, { type: 'answer-ask', answer: this.answer });
  }
}

// --- tethers ---
export class OpenTethersAction extends IntentOnly {
  intent = { type: 'set-tethers-sheet', open: true };
}
export class CloseTethersAction extends IntentOnly {
  intent = { type: 'set-tethers-sheet', open: false };
}
export class OpenDetailsAction extends IntentOnly {
  intent = { type: 'set-details-sheet', open: true };
}
export class CloseDetailsAction extends IntentOnly {
  intent = { type: 'set-details-sheet', open: false };
}
export class OpenShortcutsAction extends IntentOnly {
  intent = { type: 'set-shortcuts', open: true };
}
export class CloseShortcutsAction extends IntentOnly {
  intent = { type: 'set-shortcuts', open: false };
}
export class CloseSheetsAction extends IntentOnly {
  intent = { type: 'close-sheets' };
}
export class SwitchTetherAction extends Action {
  constructor(id) {
    super();
    this.id = id;
  }
  execute(_, { engineFeed }) {
    emit(engineFeed, { type: 'switch-tether', id: this.id });
  }
}
export class AddTetherAction extends Action {
  constructor({ room, backendUrl, label } = {}) {
    super();
    this.room = room;
    this.backendUrl = backendUrl;
    this.label = label;
  }
  execute(_, { engineFeed }) {
    emit(engineFeed, { type: 'add-tether', room: this.room, backendUrl: this.backendUrl, label: this.label });
  }
}
export class RemoveTetherAction extends Action {
  constructor(id) {
    super();
    this.id = id;
  }
  execute(_, { engineFeed }) {
    emit(engineFeed, { type: 'remove-tether', id: this.id });
  }
}
export class RenameTetherAction extends Action {
  constructor(id, label) {
    super();
    this.id = id;
    this.label = label;
  }
  execute(_, { engineFeed }) {
    emit(engineFeed, { type: 'rename-tether', id: this.id, label: this.label });
  }
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
