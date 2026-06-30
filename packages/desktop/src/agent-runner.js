// Runs an agent profile. Two strategies (see agents.js):
//
//   • oneshot — each turn spawns the agent's headless mode with an explicit
//     session id threaded through, streams the answer, and exits. Turns queue so
//     a fast talker never races the agent. `beginSession()` attaches/creates a
//     session and injects the voice primer as the opening turn.
//   • pipe — one persistent process; `write()` feeds stdin, stdout streams back.
//
// The rest of the app only sees this surface (start/write/interrupt/…/events),
// never how the process is made or which agent it is.

import { VOICE_PRIMER } from './agents.js';

export class AgentRunner extends EventTarget {
  /** @param {object} profile resolved agent profile @param {{cwd,env}} opts */
  constructor(profile, { cwd = process.cwd(), env = process.env } = {}) {
    super();
    this.profile = profile;
    this.cwd = cwd;
    this.env = env;
    this.proc = null; // persistent (pipe) process
    this.current = null; // in-flight oneshot turn process
    this.queue = [];
    this.busy = false;
    this.sessionId = null;
    this.first = true;
  }

  get isPipe() {
    return this.profile.mode === 'pipe';
  }
  get running() {
    return this.isPipe ? !!this.proc && !this.proc.killed : true; // oneshot is always "available"
  }

  start() {
    if (this.isPipe) {
      this.#spawnPersistent();
    } else {
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
   * Attach to (or create) a session and inject the voice primer so the agent
   * knows it's now speaking to a voice client. `resumeId` attaches to an existing
   * conversation; omitted, we create a fresh one (owning the UUID where we can).
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
    this.emit('session', { id: this.sessionId, resumed: !!resumeId });

    if (this.isPipe) {
      // Persistent REPLs: just speak the primer as a line.
      this.write(VOICE_PRIMER + '\n');
    } else {
      this.#enqueue(VOICE_PRIMER, { primer: true });
    }
  }

  /** Feed a user message to the agent. */
  write(text) {
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
    if (this.isPipe) {
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
    if (this.isPipe) this.proc?.stdin.end?.();
  }

  /** Start a brand-new session (drops continuity) and re-prime. */
  restart() {
    if (this.isPipe) {
      this.kill();
      this.start();
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
  }

  // ---- internals -----------------------------------------------------------

  #spawnPersistent() {
    if (this.running) return;
    this.proc = Bun.spawn(this.profile.command, {
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

  #enqueue(prompt, meta) {
    if (this.busy) this.queue.push({ prompt, meta });
    else this.#runTurn(prompt, meta);
  }

  async #runTurn(prompt, meta = {}) {
    this.busy = true;
    const { args, stdinFromNull } = this.profile.turn({ prompt, first: this.first, sessionId: this.sessionId });
    this.first = false;
    let proc;
    try {
      proc = Bun.spawn([...this.profile.command, ...args], {
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
