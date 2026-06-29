// Link protocol — messages exchanged peer-to-peer over the WebRTC data channel
// once the signaling handshake has connected the phone (guest) to the desktop
// (host). This is "the reins" of bridle: the live tether between the two ends.
// The backend is NOT involved here — this is the P2P hot path, which keeps
// infra cost ~zero.
//
// Transport framing on the single ordered+reliable data channel:
//   - string frames  -> JSON control/text messages (the kinds below)
//   - binary frames  -> raw audio bytes for the currently-open utterance
//
// Only one utterance is "open" at a time per direction (guest dictates, host
// transcribes), so binary frames need no envelope — they implicitly belong to
// the utterance announced by the most recent UTTER_BEGIN.

export const PROTO_VERSION = 1;

export const LINK = Object.freeze({
  // either direction
  HELLO: 'hello', // { t, role, proto, agent?, cwd?, client? }
  PING: 'ping', // { t, ts }
  PONG: 'pong', // { t, ts }
  NOTICE: 'notice', // { t, level, text }

  // guest (phone) -> host (desktop)
  TEXT: 'text', // { t, text }            chat line -> agent stdin
  UTTER_BEGIN: 'utter-begin', // { t, id, mime }   start of a dictation utterance
  UTTER_END: 'utter-end', // { t, id }         utterance complete -> run STT
  COMMAND: 'command', // { t, name, arg? }  control affecting the host

  // host (desktop) -> guest (phone)
  OUTPUT: 'output', // { t, text, stream }   agent stdout/stderr chunk
  STATUS: 'status', // { t, state, code? }   agent lifecycle
  TRANSCRIPT: 'transcript', // { t, id, text }     STT result for an utterance
  STT_ERROR: 'stt-error', // { t, id, message }
});

export const STREAM = Object.freeze({ STDOUT: 'stdout', STDERR: 'stderr' });
export const AGENT_STATE = Object.freeze({
  SPAWNED: 'spawned',
  EXITED: 'exited',
  ERROR: 'error',
});
export const LEVEL = Object.freeze({ INFO: 'info', WARN: 'warn', ERROR: 'error' });

// Host-affecting control commands the guest can issue (by voice or button).
// Listening/TTS pause-resume are guest-LOCAL and never cross the wire.
export const COMMAND = Object.freeze({
  INTERRUPT: 'interrupt', // SIGINT-equivalent to the agent (cancel current turn)
  EOF: 'eof', // close agent stdin
  RESTART: 'restart', // restart the agent process
  KEY: 'key', // send a raw key/control sequence (arg = string)
});

// ---- message factories ------------------------------------------------------

export const helloHost = (agent, cwd) => ({
  t: LINK.HELLO,
  role: 'host',
  client: 'desktop',
  proto: PROTO_VERSION,
  agent,
  cwd,
});
export const helloGuest = () => ({
  t: LINK.HELLO,
  role: 'guest',
  client: 'pwa',
  proto: PROTO_VERSION,
});

export const ping = (ts) => ({ t: LINK.PING, ts });
export const pong = (ts) => ({ t: LINK.PONG, ts });
export const notice = (text, level = LEVEL.INFO) => ({ t: LINK.NOTICE, level, text });

export const text = (s) => ({ t: LINK.TEXT, text: s });
export const utterBegin = (id, mime) => ({ t: LINK.UTTER_BEGIN, id, mime });
export const utterEnd = (id) => ({ t: LINK.UTTER_END, id });
export const command = (name, arg) => ({ t: LINK.COMMAND, name, arg });

export const output = (s, stream = STREAM.STDOUT) => ({ t: LINK.OUTPUT, text: s, stream });
export const status = (state, code) => ({ t: LINK.STATUS, state, code });
export const transcript = (id, s) => ({ t: LINK.TRANSCRIPT, id, text: s });
export const sttError = (id, message) => ({ t: LINK.STT_ERROR, id, message });

// ---- (de)serialization ------------------------------------------------------
// Centralized so both ends agree on framing and bad frames fail loudly.

export function encode(msg) {
  return JSON.stringify(msg);
}

export function decode(raw) {
  if (typeof raw !== 'string') {
    throw new TypeError('link.decode expects a string frame (binary frames are audio)');
  }
  const msg = JSON.parse(raw);
  if (!msg || typeof msg.t !== 'string') {
    throw new Error('malformed link message: missing type');
  }
  return msg;
}
