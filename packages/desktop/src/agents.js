// Agent profiles + session support.
//
// Bridle talks to an agent CLI in one of two ways:
//   • oneshot — each user turn spawns the agent's HEADLESS mode (`claude -p`,
//     `codex exec`, `agy -p`, …): prompt in, answer streams out, process exits.
//     No PTY, no ANSI to read aloud. Continuity is preserved by threading an
//     explicit SESSION ID through every call.
//   • pipe — a persistent subprocess; we write the user's text to stdin and
//     stream stdout. Generic fallback for ANY command (`bridle -- <cmd…>`).
//
// Sessions: where a tool lets us own the id (Claude) we generate a UUID and pass
// `--session-id` then `--resume <id>`. Where it doesn't (Codex) we resume by the
// id it assigned (or `--last`). `listSessions(cwd)` enumerates a tool's existing
// sessions so a voice client can attach to a conversation the user already had
// going in their terminal.
//
// New tools are a one-line profile, not a code change.

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { configDir } from './registry.js';

// Injected ONCE per session (the server tracks which sessions are primed), so the
// agent learns the bridle conventions without re-priming on every reconnect.
export const VOICE_PRIMER =
  '[bridle] This session is now reachable from the bridle phone client. From now on, any input ' +
  'line prefixed with "bridle.voice:" is transcribed speech from the phone (expect dictation ' +
  'quirks — homophones, missing punctuation) and any line prefixed with "bridle.text:" is typed ' +
  'from the phone; a line with neither prefix is from the normal terminal session. When replying ' +
  'to a bridle line, remember it may be read aloud by text-to-speech: keep it concise and ' +
  'conversational, avoid long code blocks, tables, or ascii art unless asked, and read commands ' +
  'and file paths clearly. Acknowledge in one short sentence, then continue.';

/** @type {Record<string, any>} */
const BUILTIN_PROFILES = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    aliases: ['claude', 'claude-code'],
    command: ['claude'],
    mode: 'oneshot',
    tier: 'enhanced',
    // Selectable run modes (extra flags): `bridle tether <name> claude --mode auto`.
    modes: {
      auto: ['--permission-mode', 'auto'], // classifier decides what's safe vs. too risky
      edits: ['--permission-mode', 'acceptEdits'], // auto-accept edits, still gated on risky ops
      yolo: ['--dangerously-skip-permissions'], // no prompts at all — use with care
      plan: ['--permission-mode', 'plan'], // plan-only, makes no changes
    },
    setsSessionId: true, // we choose the UUID
    turn: ({ prompt, first, sessionId }) => ({
      args: ['-p', ...(first ? ['--session-id', sessionId] : ['--resume', sessionId]), prompt],
      stdinFromNull: true,
    }),
    listSessions: (cwd) => claudeSessions(cwd),
    // Auto-wire bridle's MCP server so the agent can drive the phone front-end.
    mcpConfig: (url) => ({ mcpServers: { bridle: { type: 'http', url } } }),
    mcp: ({ configPath }) => ['--mcp-config', configPath, '--allowedTools', 'mcp__bridle__*'],
    // Route Claude's permission prompts to bridle's MCP tool → the phone. Paired
    // with `--mode auto`, the classifier auto-approves safe calls and only the
    // risky ones surface as an approve/deny card on your phone.
    permissionPromptTool: (toolName) => ['--permission-prompt-tool', toolName],
    streamStderr: false,
  },

  codex: {
    id: 'codex',
    label: 'Codex',
    aliases: ['codex', 'openai-codex'],
    command: ['codex'],
    mode: 'oneshot',
    tier: 'enhanced',
    setsSessionId: false, // Codex assigns the id; we resume by it (or --last)
    turn: ({ prompt, first, sessionId }) => {
      if (first) return { args: ['exec', prompt], stdinFromNull: true };
      const resume = sessionId ? ['exec', 'resume', sessionId] : ['exec', 'resume', '--last'];
      return { args: [...resume, prompt], stdinFromNull: true };
    },
    listSessions: (cwd) => codexSessions(cwd),
    streamStderr: false,
  },

  antigravity: {
    id: 'antigravity',
    label: 'Antigravity',
    aliases: ['antigravity', 'agy'],
    command: ['agy'],
    mode: 'oneshot',
    tier: 'enhanced',
    setsSessionId: false,
    turn: ({ prompt }) => ({ args: ['-p', prompt], stdinFromNull: true }),
    streamStderr: false,
  },

  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    aliases: ['gemini', 'gemini-cli'],
    command: ['gemini'],
    mode: 'oneshot',
    tier: 'enhanced',
    setsSessionId: false,
    turn: ({ prompt }) => ({ args: ['-p', prompt], stdinFromNull: true }),
    streamStderr: false,
  },

  opencode: {
    id: 'opencode',
    label: 'opencode',
    aliases: ['opencode'],
    command: ['opencode'],
    mode: 'oneshot',
    tier: 'enhanced',
    setsSessionId: false,
    turn: ({ prompt, first, sessionId }) => ({
      args: first ? ['run', prompt] : ['run', ...(sessionId ? ['--session', sessionId] : ['--continue']), prompt],
      stdinFromNull: true,
    }),
    streamStderr: false,
  },

  aider: {
    id: 'aider',
    label: 'Aider',
    aliases: ['aider'],
    command: ['aider'],
    mode: 'oneshot',
    tier: 'enhanced',
    setsSessionId: false, // aider keeps history in the repo
    turn: ({ prompt }) => ({ args: ['--yes', '--message', prompt], stdinFromNull: true }),
    streamStderr: false,
  },

  goose: {
    id: 'goose',
    label: 'Goose',
    aliases: ['goose'],
    command: ['goose'],
    mode: 'oneshot',
    tier: 'enhanced',
    setsSessionId: false,
    turn: ({ prompt, first, sessionId }) => ({
      args: first
        ? ['run', ...(sessionId ? ['--name', sessionId] : []), '-t', prompt]
        : ['run', '--resume', ...(sessionId ? ['--name', sessionId] : []), '-t', prompt],
      stdinFromNull: true,
    }),
    streamStderr: false,
  },

  cursor: {
    id: 'cursor',
    label: 'Cursor Agent',
    aliases: ['cursor', 'cursor-agent'],
    command: ['cursor-agent'],
    mode: 'oneshot',
    tier: 'enhanced',
    setsSessionId: false,
    turn: ({ prompt, first, sessionId }) => ({
      args: ['-p', ...(!first && sessionId ? ['--resume', sessionId] : []), prompt],
      stdinFromNull: true,
    }),
    streamStderr: false,
  },

  // Best-effort headless profiles (flags vary by release; `bridle -- <cmd>` is
  // always the fallback).
  q: {
    id: 'q',
    label: 'Amazon Q',
    aliases: ['q', 'amazon-q', 'qchat'],
    command: ['q'],
    mode: 'oneshot',
    tier: 'baseline+',
    setsSessionId: false,
    turn: ({ prompt }) => ({ args: ['chat', '--no-interactive', '--trust-all-tools', prompt], stdinFromNull: true }),
    streamStderr: false,
  },
  copilot: {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    aliases: ['copilot', 'gh-copilot'],
    command: ['copilot'],
    mode: 'oneshot',
    tier: 'baseline+',
    setsSessionId: false,
    turn: ({ prompt }) => ({ args: ['-p', prompt], stdinFromNull: true }),
    streamStderr: false,
  },
};

// ---- custom profiles -------------------------------------------------------
// Users can add or override agents from `<config>/profiles.json` (on Linux/mac:
// ~/.config/bridle/profiles.json). Because `turn` is a function we can't store
// in JSON, oneshot agents are described declaratively with arg templates:
//
//   {
//     "mycli": {
//       "label": "My CLI",
//       "aliases": ["mycli", "mc"],
//       "command": ["mycli"],
//       "mode": "oneshot",                                 // or "pipe" (stdin)
//       "promptArgs": ["-p", "{prompt}"],                  // first turn
//       "resumeArgs": ["-p", "--resume", "{session}", "{prompt}"],  // optional
//       "stdinFromNull": true
//     }
//   }
//
// `{prompt}` and `{session}` are substituted per turn. A "pipe" profile needs no
// templates. Custom ids override built-ins of the same key.
export function normalizeCustomProfile(id, def) {
  const mode = def.mode === 'pipe' ? 'pipe' : 'oneshot';
  const profile = {
    id,
    label: def.label || id,
    aliases: Array.isArray(def.aliases) && def.aliases.length ? def.aliases : [id],
    command: Array.isArray(def.command) && def.command.length ? def.command : [id],
    mode,
    tier: def.tier || 'custom',
    setsSessionId: false,
    streamStderr: def.streamStderr ?? mode === 'pipe',
    listSessions: () => [],
  };
  if (def.modes && typeof def.modes === 'object') {
    profile.modes = def.modes; // { name: [extra, args] }
  }
  if (mode === 'oneshot') {
    const promptArgs = Array.isArray(def.promptArgs) ? def.promptArgs : ['{prompt}'];
    const resumeArgs = Array.isArray(def.resumeArgs) ? def.resumeArgs : promptArgs;
    const fill = (tmpl, prompt, sessionId) =>
      tmpl.map((a) => String(a).replaceAll('{prompt}', prompt).replaceAll('{session}', sessionId || ''));
    profile.turn = ({ prompt, first, sessionId }) => ({
      args: fill(first ? promptArgs : resumeArgs, prompt, sessionId),
      stdinFromNull: def.stdinFromNull !== false,
    });
  }
  return profile;
}

function loadCustomProfiles() {
  let path;
  try {
    path = join(configDir(), 'profiles.json');
    if (!existsSync(path)) return {};
    const obj = JSON.parse(readFileSync(path, 'utf8'));
    const out = {};
    for (const [id, def] of Object.entries(obj || {})) {
      if (def && typeof def === 'object') out[id] = normalizeCustomProfile(id, def);
    }
    return out;
  } catch (err) {
    process.stderr.write(`\x1b[33m[bridle] ignoring ${path || 'profiles.json'} — ${err.message}\x1b[0m\n`);
    return {};
  }
}

/** @type {Record<string, any>} */
const PROFILES = { ...BUILTIN_PROFILES, ...loadCustomProfiles() };

const BY_ALIAS = (() => {
  const map = new Map();
  for (const p of Object.values(PROFILES)) for (const a of p.aliases) map.set(a, p);
  return map;
})();

export const DEFAULT_AGENT = 'claude';
export const listProfiles = () => Object.values(PROFILES);

/** Generic persistent-pipe profile for an arbitrary command. */
export function genericProfile(command) {
  return {
    id: 'custom',
    label: command.join(' '),
    command,
    mode: 'pipe',
    tier: 'baseline',
    setsSessionId: false,
    streamStderr: true,
    listSessions: () => [],
  };
}

/**
 * Resolve a profile from { id } (a known agent) or { command } (a raw command,
 * e.g. from `-- cmd…`). An unknown bare name becomes a generic pipe profile.
 */
export function resolveAgent({ id, command } = {}) {
  if (command && command.length) {
    const known = BY_ALIAS.get(command[0]);
    if (known && command.length === 1) return known;
    return genericProfile(command);
  }
  const key = (id || DEFAULT_AGENT).toLowerCase();
  return BY_ALIAS.get(key) || genericProfile([key]);
}

// ---- session listing -------------------------------------------------------

const claudeSlug = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

function claudeSessions(cwd) {
  const dir = join(homedir(), '.claude', 'projects', claudeSlug(cwd));
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const path = join(dir, name);
    let mtime = 0;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    out.push({ id: name.replace(/\.jsonl$/, ''), title: firstUserText(path), updatedAt: mtime });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);
}

function codexSessions(cwd) {
  const root = join(homedir(), '.codex', 'sessions');
  if (!existsSync(root)) return [];
  const files = [];
  walk(root, files, 0);
  const out = [];
  for (const path of files) {
    if (!path.endsWith('.jsonl')) continue;
    let meta;
    try {
      meta = readFirstObject(path);
    } catch {
      continue;
    }
    if (meta?.cwd && meta.cwd !== cwd) continue; // scope to this project when known
    const id = meta?.id || meta?.session_id || extractUuid(path);
    if (!id) continue;
    out.push({ id, title: firstUserText(path), updatedAt: safeMtime(path) });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);
}

// --- small fs helpers -------------------------------------------------------

function walk(dir, acc, depth) {
  if (depth > 4 || acc.length > 500) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc, depth + 1);
    else acc.push(p);
  }
}

function safeMtime(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function readFirstObject(path) {
  const head = readFileSync(path, 'utf8').split('\n', 1)[0];
  return head ? JSON.parse(head) : null;
}

const extractUuid = (s) => (s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [])[0];

// Pull a human-readable title from the first user message in a transcript.
function firstUserText(path) {
  try {
    const text = readFileSync(path, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const role = obj.role || obj.type || obj.message?.role;
      if (role === 'user') {
        const content = obj.content ?? obj.text ?? obj.message?.content;
        const s = typeof content === 'string' ? content : extractText(content);
        if (s && s.trim() && !s.startsWith('[bridle]')) return truncate(s.trim());
      }
    }
  } catch {
    /* unreadable */
  }
  return 'untitled session';
}

function extractText(content) {
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join(' ');
  }
  return '';
}

const truncate = (s, n = 80) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
