// Link protocol — messages exchanged peer-to-peer over the WebRTC data channel
// once signaling has connected the phone (guest) to the desktop (host). This is
// "the reins" of bridle: the live tether between the two ends. The backend is
// NOT involved — this is the P2P hot path, which keeps infra cost ~zero.
//
// STT runs on the phone (offline Whisper in the browser) and TTS uses the
// browser's speech synthesis, so NO audio ever crosses this channel and the
// desktop holds no API keys. Only text + control flow travels here:
//
//   guest -> host : TEXT (transcribed or typed) and COMMAND (agent control)
//   host  -> guest: OUTPUT (agent stdout) and STATUS (lifecycle)
//
// Every frame is a JSON string; there are no binary frames.

export const PROTO_VERSION = 1;

export const LINK = Object.freeze({
  // either direction
  HELLO: 'hello', // { t, role, proto, agent?, cwd?, client? }
  PING: 'ping', // { t, ts }
  PONG: 'pong', // { t, ts }
  NOTICE: 'notice', // { t, level, text }

  // guest (phone) -> host (desktop)
  TEXT: 'text', // { t, text }            transcribed/typed line -> agent stdin
  COMMAND: 'command', // { t, name, arg? }  control affecting the host
  LIST_SESSIONS: 'list-sessions', // { t }          request the agent's sessions
  CONNECT_SESSION: 'connect-session', // { t, id }  attach (id) or start fresh (null)

  // host (desktop) -> guest (phone)
  OUTPUT: 'output', // { t, text, stream }   agent stdout/stderr chunk
  STATUS: 'status', // { t, state, code? }   agent lifecycle
  SESSIONS: 'sessions', // { t, sessions, currentId }  list of resumable sessions
  SESSION: 'session', // { t, id, title, resumed }     active session changed
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
export const command = (name, arg) => ({ t: LINK.COMMAND, name, arg });
export const listSessions = () => ({ t: LINK.LIST_SESSIONS });
export const connectSession = (id) => ({ t: LINK.CONNECT_SESSION, id: id || null });

export const output = (s, stream = STREAM.STDOUT) => ({ t: LINK.OUTPUT, text: s, stream });
export const status = (state, code) => ({ t: LINK.STATUS, state, code });
export const sessions = (list, currentId) => ({ t: LINK.SESSIONS, sessions: list, currentId });
export const session = (id, title, resumed) => ({ t: LINK.SESSION, id, title, resumed });

// ---- (de)serialization ------------------------------------------------------

export function encode(msg) {
  return JSON.stringify(msg);
}

export function decode(raw) {
  if (typeof raw !== 'string') {
    throw new TypeError('link.decode expects a string frame');
  }
  const msg = JSON.parse(raw);
  if (!msg || typeof msg.t !== 'string') {
    throw new Error('malformed link message: missing type');
  }
  return msg;
}
