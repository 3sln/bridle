// Link protocol — messages exchanged peer-to-peer over the WebRTC data channel
// once signaling has connected the phone (guest) to the desktop (host). This is
// "the reins" of bridle: the live tether between the two ends. The backend is
// NOT involved — this is the P2P hot path, which keeps infra cost ~zero.
//
// STT runs on the phone (offline Whisper in the browser) and TTS uses the
// browser's speech synthesis, so NO audio ever crosses this channel and the
// desktop holds no API keys. Only text + control flow travels here:
//
//   guest -> host : TEXT (transcribed or typed), COMMAND, session + ask replies
//   host  -> guest: OUTPUT/STATUS, session info, and front-end control (speak,
//                   markdown, ask, asset transfer) driven by the agent's MCP tools
//
// String frames are JSON control messages. Binary frames are asset bytes (audio/
// image/file) belonging to the asset announced by the most recent ASSET_BEGIN.

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
  ASK_REPLY: 'ask-reply', // { t, id, answer }      response to an ASK prompt
  FORM_REPLY: 'form-reply', // { t, id, values }     submitted form values (or null = cancelled)
  FORM_FILE_BEGIN: 'form-file-begin', // { t, id, field, name, mime, size }  upload starts; binary chunks follow
  FORM_FILE_END: 'form-file-end', // { t, id, field }                        upload done
  ATTACH_BEGIN: 'attach-begin', // { t, id, name, mime, size }  a file/image the user attached; binary chunks follow
  ATTACH_END: 'attach-end', // { t, id }                        saved to disk; referenced to the agent on the next message

  // host (desktop) -> guest (phone)
  OUTPUT: 'output', // { t, text, stream }   agent stdout/stderr chunk
  STATUS: 'status', // { t, state, code? }   agent lifecycle
  SESSIONS: 'sessions', // { t, sessions, currentId }  list of resumable sessions
  SESSION: 'session', // { t, id, title, resumed }     active session changed

  // host -> guest: front-end control (driven by the agent via MCP tools)
  SPEAK: 'speak', // { t, text }              say something via TTS
  MARKDOWN: 'markdown', // { t, title, markdown }  render a card
  STATUSLINE: 'status-line', // { t, text }   set a transient status line
  ASK: 'ask', // { t, id, question, choices }  prompt the user; expects ASK_REPLY
  FORM: 'form', // { t, id, html, title, submit }  render a form; expects FORM_REPLY
  ASSET_BEGIN: 'asset-begin', // { t, id, kind, name, mime, size, meta }
  ASSET_END: 'asset-end', // { t, id }         binary chunks arrive between begin/end
});

export const ASSET = Object.freeze({ AUDIO: 'audio', IMAGE: 'image', FILE: 'file' });

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

// The host's HELLO carries a per-connection `nonce`: the guest signs it (with
// the token) using its persistent device key, proving possession on every
// reconnect. The host TOFU-pins the key on first pair and rejects others after.
export const helloHost = (agent, cwd, nonce) => ({
  t: LINK.HELLO,
  role: 'host',
  client: 'desktop',
  proto: PROTO_VERSION,
  agent,
  cwd,
  nonce,
});
// `pubKey` (JWK) + `sig` (base64) authenticate the device to the host. Omitted
// only when talking to a pre-pinning host, which ignores them.
export const helloGuest = ({ pubKey, sig } = {}) => ({
  t: LINK.HELLO,
  role: 'guest',
  client: 'pwa',
  proto: PROTO_VERSION,
  ...(pubKey ? { pubKey } : {}),
  ...(sig ? { sig } : {}),
});

export const ping = (ts) => ({ t: LINK.PING, ts });
export const pong = (ts) => ({ t: LINK.PONG, ts });
export const notice = (text, level = LEVEL.INFO) => ({ t: LINK.NOTICE, level, text });

export const text = (s, source) => ({ t: LINK.TEXT, text: s, source });
export const command = (name, arg) => ({ t: LINK.COMMAND, name, arg });
export const listSessions = () => ({ t: LINK.LIST_SESSIONS });
export const connectSession = (id) => ({ t: LINK.CONNECT_SESSION, id: id || null });

export const output = (s, stream = STREAM.STDOUT) => ({ t: LINK.OUTPUT, text: s, stream });
export const status = (state, code) => ({ t: LINK.STATUS, state, code });
export const sessions = (list, currentId) => ({ t: LINK.SESSIONS, sessions: list, currentId });
export const session = (id, title, resumed) => ({ t: LINK.SESSION, id, title, resumed });

// front-end control
export const speak = (s) => ({ t: LINK.SPEAK, text: s });
export const markdown = (md, title) => ({ t: LINK.MARKDOWN, markdown: md, title });
export const statusLine = (s) => ({ t: LINK.STATUSLINE, text: s });
export const ask = (id, question, choices) => ({ t: LINK.ASK, id, question, choices: choices || null });
export const askReply = (id, answer) => ({ t: LINK.ASK_REPLY, id, answer });
export const form = (id, html, { title, submit } = {}) => ({ t: LINK.FORM, id, html, title: title || null, submit: submit || null });
export const formReply = (id, values) => ({ t: LINK.FORM_REPLY, id, values: values || null });
export const formFileBegin = (id, field, { name, mime, size } = {}) => ({ t: LINK.FORM_FILE_BEGIN, id, field, name: name || 'upload', mime: mime || 'application/octet-stream', size: size || 0 });
export const formFileEnd = (id, field) => ({ t: LINK.FORM_FILE_END, id, field });
export const attachBegin = (id, { name, mime, size } = {}) => ({ t: LINK.ATTACH_BEGIN, id, name: name || 'file', mime: mime || 'application/octet-stream', size: size || 0 });
export const attachEnd = (id) => ({ t: LINK.ATTACH_END, id });
export const assetBegin = (id, kind, name, mime, size, meta) => ({ t: LINK.ASSET_BEGIN, id, kind, name, mime, size, meta: meta || {} });
export const assetEnd = (id) => ({ t: LINK.ASSET_END, id });

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
