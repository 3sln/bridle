// Runs an agent profile. Three strategies (see agents.js):
//
//   • oneshot — each turn spawns the agent's headless mode with an explicit
//     session id threaded through, streams the answer, and exits. Turns queue so
//     a fast talker never races the agent. `beginSession()` attaches/creates a
//     session and injects the voice primer as the opening turn.
//   • stream-json — one persistent process per session, driven over a bidirectional
//     newline-delimited-JSON stdio protocol (Claude Code). `write()` sends a user
//     turn; we parse text deltas out of the event stream and mark turn boundaries
//     on the `result` event, so hooks/monitors run and the reply streams live.
//   • pipe — one persistent process; `write()` feeds stdin, stdout streams back.
//
// The rest of the app only sees this surface (start/write/interrupt/…/events),
// never how the process is made or which agent it is.

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VOICE_PRIMER } from './agents.js';

export class AgentRunner extends EventTarget {
  /** @param {object} profile resolved agent profile @param {{cwd,env}} opts */
  constructor(profile, { cwd = process.cwd(), env = process.env } = {}) {
    super();
    this.profile = profile;
    this.cwd = cwd;
    this.env = env;
    this.proc = null; // persistent (pipe / stream-json) process
    this.current = null; // in-flight oneshot turn process
    this.queue = [];
    this.busy = false;
    this.sessionId = null;
    this.first = true;
    this.primed = false; // pipe agents: primed once per live process
    this.mcpUrl = null;
    this.mcpConfigPath = null;
    this.mcpReady = false;
    this.rid = crypto.randomUUID().slice(0, 8); // unique per runner (mcp config path)
    this.streamBuf = ''; // stream-json: partial line carry
    this.expectExit = false; // stream-json: we killed the process on purpose
  }

  /** Point the agent at bridle's MCP server (profiles that support it inject it). */
  setMcp({ url } = {}) {
    this.mcpUrl = url || null;
    this.mcpReady = false;
  }

  #mcpArgs() {
    if (!this.mcpUrl || !this.profile.mcp) return [];
    if (!this.mcpReady) {
      this.mcpConfigPath = join(tmpdir(), `bridle-mcp-${process.pid}-${this.rid}.json`);
      if (this.profile.mcpConfig) {
        writeFileSync(this.mcpConfigPath, JSON.stringify(this.profile.mcpConfig(this.mcpUrl)));
      }
      this.mcpReady = true;
    }
    const args = this.profile.mcp({ url: this.mcpUrl, configPath: this.mcpConfigPath });
    // Delegate the agent's own permission prompts to the phone, where the profile
    // supports it (Claude's --permission-prompt-tool → bridle's `permission` tool).
    if (this.profile.permissionPromptTool) {
      args.push(...this.profile.permissionPromptTool('mcp__bridle__permission'));
    }
    return args;
  }

  get isPipe() {
    return this.profile.mode === 'pipe';
  }
  get isStream() {
    return this.profile.mode === 'stream-json';
  }
  get running() {
    // pipe/stream have a live process; oneshot is always "available" (spawns per turn).
    return this.isPipe || this.isStream ? !!this.proc && !this.proc.killed : true;
  }

  start() {
    if (this.isPipe) {
      this.#spawnPersistent();
    } else {
      // oneshot + stream-json spawn lazily once we know the session id (beginSession).
      this.emit('status', { state: 'ready' });
    }
  }

  /** List the agent's existing sessions for this project (may be empty). */
  async listSessions() {
    try {
      return this.profile.listSessions ? this.profile.listSessions(this.cwd) : [];
    } catch {
      return [];
    }
  }

  /**
   * Attach to (or create) a session. `resumeId` attaches to an existing
   * conversation; omitted, we create a fresh one (owning the UUID where we can).
   * Priming is decided by the caller (the server tracks which sessions are already
   * primed) via `prime()` — so a reconnect/resume never re-primes.
   */
  beginSession({ resumeId } = {}) {
    if (resumeId) {
      this.sessionId = resumeId;
      this.first = false; // resume, don't create
    } else if (this.profile.setsSessionId) {
      this.sessionId = crypto.randomUUID();
      this.first = true;
    } else {
      this.sessionId = null;
      this.first = true;
    }
    // stream-json binds the persistent process to the session at spawn — do it
    // before the session event so the caller's prime() lands on a live process.
    if (this.isStream) this.#spawnStream();
    this.emit('session', { id: this.sessionId, resumed: !!resumeId });
  }

  /** Give the agent the bridle voice primer (once per session; caller-gated). */
  prime() {
    if (this.isPipe) {
      this.write(VOICE_PRIMER + '\n'); // persistent REPL: just speak it
    } else if (this.isStream) {
      this.write(VOICE_PRIMER); // first streamed user turn
    } else {
      this.#enqueue(VOICE_PRIMER, { primer: true });
    }
  }

  /** Feed a user message to the agent. */
  write(text) {
    if (this.isStream) {
      if (this.busy) {
        this.queue.push(text);
      } else {
        this.#streamDispatch(text);
      }
      return true;
    }
    if (this.isPipe) {
      if (!this.proc) return false;
      this.proc.stdin.write(text);
      this.proc.stdin.flush?.();
      return true;
    }
    this.#enqueue(text, {});
    return true;
  }

  interrupt() {
    if (this.isStream) {
      // In-band interrupt: aborts the in-flight turn but keeps the process (and
      // session) alive — the aborted turn still emits a `result`, so the turn
      // machinery closes out and the next queued message dispatches normally.
      if (this.proc && this.profile.stream?.interrupt) {
        this.proc.stdin.write(this.profile.stream.interrupt());
        this.proc.stdin.flush?.();
      }
    } else if (this.isPipe) {
      this.write('\x03'); // ETX
    } else if (this.current) {
      try {
        this.current.kill('SIGINT');
      } catch {
        /* gone */
      }
    }
  }

  eof() {
    if (this.isPipe || this.isStream) this.proc?.stdin.end?.();
  }

  /** Start a brand-new session (drops continuity) and re-prime. */
  restart() {
    if (this.isPipe) {
      this.kill();
      this.start();
      return;
    }
    if (this.isStream) {
      this.queue = [];
      this.busy = false;
      this.beginSession({}); // fresh session -> respawns the process
      return;
    }
    this.queue = [];
    if (this.current) {
      try {
        this.current.kill('SIGTERM');
      } catch {
        /* gone */
      }
    }
    this.beginSession({});
  }

  kill(signal = 'SIGTERM') {
    this.expectExit = true;
    for (const p of [this.proc, this.current]) {
      if (p) {
        try {
          p.kill(signal);
        } catch {
          /* gone */
        }
      }
    }
    this.proc = null;
    this.current = null;
    this.queue = [];
    this.busy = false;
  }

  // ---- internals -----------------------------------------------------------

  #spawnPersistent() {
    if (this.running) return;
    this.primed = false; // a fresh process needs priming again
    this.proc = Bun.spawn([...this.profile.command, ...(this.profile.modeArgs || [])], {
      cwd: this.cwd,
      env: this.env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    this.#pump(this.proc.stdout, 'stdout');
    this.#pump(this.proc.stderr, 'stderr');
    this.proc.exited.then((code) => {
      this.emit('exit', { code });
      this.proc = null;
    });
    this.emit('status', { state: 'spawned', pid: this.proc.pid });
  }

  // ---- stream-json (persistent, session-bound) -----------------------------

  #killProc() {
    if (this.proc) {
      this.expectExit = true;
      try {
        this.proc.kill();
      } catch {
        /* gone */
      }
      this.proc = null;
    }
  }

  #spawnStream() {
    this.#killProc(); // rebinding to a (new/resumed) session
    this.primed = false;
    const s = this.profile.stream;
    const args = [
      ...(this.profile.modeArgs || []),
      ...this.#mcpArgs(),
      ...s.baseArgs,
      ...s.sessionArgs({ first: this.first, sessionId: this.sessionId }),
    ];
    this.first = false; // any later respawn resumes this session
    let proc;
    try {
      proc = Bun.spawn([...this.profile.command, ...args], {
        cwd: this.cwd,
        env: this.env,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: this.profile.streamStderr ? 'pipe' : 'ignore',
      });
    } catch (err) {
      this.emit('output', { text: `\n[bridle] failed to run ${this.profile.command[0]}: ${err.message}\n`, stream: 'stderr' });
      return;
    }
    this.proc = proc;
    this.streamBuf = '';
    this.#pumpStream(proc.stdout);
    if (this.profile.streamStderr) this.#pump(proc.stderr, 'stderr');
    proc.exited.then((code) => {
      if (this.proc === proc) this.proc = null;
      if (this.expectExit) {
        this.expectExit = false;
        return; // we killed it on purpose (rebind / teardown)
      }
      this.busy = false;
      this.emit('exit', { code });
    });
    this.emit('status', { state: 'spawned', pid: proc.pid });
  }

  #streamDispatch(text) {
    if (!this.proc) this.#spawnStream(); // process died (crash / eof) — resume it
    if (!this.proc) return; // spawn failed
    this.busy = true;
    this.emit('status', { state: 'turn-start' });
    this.proc.stdin.write(this.profile.stream.encode(text));
    this.proc.stdin.flush?.();
  }

  async #pumpStream(stream) {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.streamBuf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = this.streamBuf.indexOf('\n')) >= 0) {
          const line = this.streamBuf.slice(0, nl);
          this.streamBuf = this.streamBuf.slice(nl + 1);
          if (line.trim()) this.#onStreamLine(line);
        }
      }
    } catch {
      /* stream closed */
    }
  }

  #onStreamLine(line) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      return; // not a JSON event line
    }
    if (o.type === 'stream_event') {
      const ev = o.event;
      // Only assistant *text* deltas reach the phone (skip thinking / tool json).
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
        this.emit('output', { text: ev.delta.text, stream: 'stdout' });
      }
      return;
    }
    if (o.type === 'result') {
      // A genuine API failure is worth surfacing; an interrupt (error_during_execution) isn't.
      if (o.is_error && o.subtype !== 'error_during_execution' && o.api_error_status) {
        this.emit('output', { text: `\n[bridle] ${o.subtype || 'error'}: ${o.api_error_status}\n`, stream: 'stderr' });
      }
      this.busy = false;
      this.emit('turn-end', { code: o.is_error ? 1 : 0 });
      const next = this.queue.shift();
      if (next != null) this.#streamDispatch(next);
    }
  }

  #enqueue(prompt, meta) {
    if (this.busy) this.queue.push({ prompt, meta });
    else this.#runTurn(prompt, meta);
  }

  async #runTurn(prompt, meta = {}) {
    this.busy = true;
    const { args, stdinFromNull } = this.profile.turn({ prompt, first: this.first, sessionId: this.sessionId });
    this.first = false;
    const mcpArgs = this.#mcpArgs();
    let proc;
    try {
      proc = Bun.spawn([...this.profile.command, ...(this.profile.modeArgs || []), ...mcpArgs, ...args], {
        cwd: this.cwd,
        env: this.env,
        stdin: stdinFromNull ? 'ignore' : 'pipe',
        stdout: 'pipe',
        stderr: this.profile.streamStderr ? 'pipe' : 'ignore',
      });
    } catch (err) {
      this.busy = false;
      this.emit('output', { text: `\n[bridle] failed to run ${this.profile.command[0]}: ${err.message}\n`, stream: 'stderr' });
      return;
    }
    this.current = proc;
    this.emit('status', { state: 'turn-start', primer: !!meta.primer });
    this.#pump(proc.stdout, 'stdout');
    if (this.profile.streamStderr) this.#pump(proc.stderr, 'stderr');
    const code = await proc.exited;
    this.current = null;
    this.busy = false;
    this.emit('turn-end', { code });
    const next = this.queue.shift();
    if (next) this.#runTurn(next.prompt, next.meta);
  }

  async #pump(stream, name) {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = dec.decode(value, { stream: true });
        if (text) this.emit('output', { text, stream: name });
      }
    } catch {
      /* stream closed */
    }
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
