// Wraps a spawned AI-agent CLI as a streaming process. The agent is just a
// shell command (default `claude`, override with `tether -- <cmd...>`), so any
// agent CLI works. Output is surfaced as events; input is written to stdin.
//
// We use Bun.spawn with piped stdio. For agent CLIs that demand a real TTY,
// drop in a PTY-backed runner that conforms to this same surface — the rest of
// the system only depends on this interface, never on how the process is made.

export class AgentRunner extends EventTarget {
  /** @param {string[]} command e.g. ['claude'] or ['claude','--model','opus'] */
  constructor(command, { cwd = process.cwd(), env = process.env } = {}) {
    super();
    this.command = command;
    this.cwd = cwd;
    this.env = env;
    /** @type {import('bun').Subprocess | null} */
    this.proc = null;
  }

  get running() {
    return !!this.proc && this.proc.killed === false;
  }

  start() {
    if (this.running) return;
    this.proc = Bun.spawn(this.command, {
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
      /* stream closed on process exit */
    }
  }

  /** Feed a line of input to the agent (caller decides about trailing newline). */
  write(text) {
    if (!this.proc) return false;
    this.proc.stdin.write(text);
    this.proc.stdin.flush?.();
    return true;
  }

  /** Best-effort "cancel the current turn": send an ETX (Ctrl-C) on stdin.
   *  Many REPL-style agents treat this as interrupt without dying. */
  interrupt() {
    this.write('\x03');
  }

  /** Close the agent's stdin (EOF). */
  eof() {
    this.proc?.stdin.end?.();
  }

  restart() {
    this.kill();
    this.start();
  }

  kill(signal = 'SIGTERM') {
    if (this.proc) {
      try {
        this.proc.kill(signal);
      } catch {
        /* already gone */
      }
      this.proc = null;
    }
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
