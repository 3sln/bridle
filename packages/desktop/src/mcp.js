// Minimal MCP server (Streamable HTTP) that bridle runs in-process and the agent
// connects to. It exposes a suite of tools for driving the phone front-end —
// pushing audio/images/files and asking the user things — backed by the live
// FrontendController. Because it shares the process with the WebRTC peer, a tool
// call reaches the phone directly, no IPC.
//
// We hand-roll the JSON-RPC subset MCP needs (initialize, tools/list,
// tools/call, ping) and answer with application/json — no SSE required for
// request/response tools.
//
// Binding to 127.0.0.1 keeps it off the network but does NOT make it private:
// any page in any browser on this machine can POST to a loopback port. These
// tools ask the user questions on their phone and approve the agent's tool
// calls, so a web page must never be able to reach them. Three gates, per the
// MCP local-server guidance:
//
//   * an unguessable per-run token in the path — the agent gets it via
//     --mcp-config, an attacker would have to guess 128 bits;
//   * no `Origin` header — every cross-origin browser request carries one, and
//     no CLI MCP client sends one;
//   * `content-type: application/json` — the one content type that cannot be
//     sent cross-origin without a preflight the server never answers.

import { writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROTOCOL_VERSION = '2025-06-18';

export class McpServer {
  constructor({ controller, port = 0 } = {}) {
    this.controller = controller;
    this.port = port;
    this.sessionId = crypto.randomUUID();
    this.token = crypto.randomUUID().replace(/-/g, '');
    this.path = `/mcp/${this.token}`;
    this.server = null;
    this.tools = buildTools(controller);
  }

  get url() {
    return this.server ? `http://127.0.0.1:${this.server.port}${this.path}` : null;
  }

  start() {
    this.server = Bun.serve({
      port: this.port,
      hostname: '127.0.0.1',
      fetch: (req) => this.#fetch(req),
    });
    return this.url;
  }

  stop() {
    this.server?.stop(true);
    this.server = null;
  }

  async #fetch(req) {
    const url = new URL(req.url);
    // Constant-time-ish and, more importantly, indistinguishable: a wrong token
    // and a wrong path both look like nothing is here.
    if (url.pathname !== this.path) return new Response('not found', { status: 404 });
    // A browser stamps Origin on every cross-origin request; MCP clients don't
    // send one at all. Anything with one is a page, and no page should be here.
    if (req.headers.get('origin')) return new Response('forbidden', { status: 403 });
    if (req.method === 'GET') return new Response(null, { status: 405 }); // no server-initiated SSE
    if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
    // Rejecting anything else costs a correct client nothing and takes away the
    // simple-request (text/plain, no preflight) path a page would have to use.
    if (!/^application\/json\b/i.test(req.headers.get('content-type') || '')) {
      return new Response('expected application/json', { status: 415 });
    }

    let msg;
    try {
      msg = await req.json();
    } catch {
      return this.#json(rpcError(null, -32700, 'parse error'));
    }
    // Batches: handle each, drop notification (undefined) results.
    if (Array.isArray(msg)) {
      const out = (await Promise.all(msg.map((m) => this.#handle(m)))).filter((r) => r !== undefined);
      return out.length ? this.#json(out) : new Response(null, { status: 202 });
    }
    const res = await this.#handle(msg);
    return res === undefined ? new Response(null, { status: 202 }) : this.#json(res);
  }

  #json(body) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json', 'mcp-session-id': this.sessionId },
    });
  }

  async #handle(msg) {
    const { id, method, params } = msg || {};
    // Notifications have no id and expect no response.
    if (id === undefined || id === null) return undefined;

    switch (method) {
      case 'initialize':
        return rpcOk(id, {
          protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'bridle', version: '0.0.1' },
          instructions:
            'Tools to drive the connected phone: notify, speak, play_audio, show_image, ' +
            'show_file, show_markdown, set_status, ask, show_form. Use them to surface results the ' +
            'user is better off hearing or seeing than having read aloud. Use `ask` for a quick ' +
            'question and `show_form` for surveys, structured input, or file uploads (its full ' +
            'response — including files — is saved to disk and only summarized back to you).',
        });
      case 'ping':
        return rpcOk(id, {});
      case 'tools/list':
        return rpcOk(id, { tools: this.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case 'tools/call':
        return this.#callTool(id, params);
      default:
        return rpcError(id, -32601, `method not found: ${method}`);
    }
  }

  async #callTool(id, params) {
    const tool = this.tools.find((t) => t.name === params?.name);
    if (!tool) return rpcError(id, -32602, `unknown tool: ${params?.name}`);
    try {
      const text = await tool.handler(params.arguments || {});
      return rpcOk(id, { content: [{ type: 'text', text: String(text ?? 'ok') }] });
    } catch (err) {
      return rpcOk(id, { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
    }
  }
}

const rpcOk = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

const str = (desc) => ({ type: 'string', description: desc });

function buildTools(c) {
  return [
    {
      name: 'notify',
      description: 'Show a short notification toast on the phone.',
      inputSchema: { type: 'object', properties: { text: str('message'), level: { type: 'string', enum: ['info', 'warn', 'error'] } }, required: ['text'] },
      handler: (a) => c.notify(a.text, a.level || 'info'),
    },
    {
      name: 'speak',
      description: "Say something out loud via the phone's text-to-speech.",
      inputSchema: { type: 'object', properties: { text: str('what to say') }, required: ['text'] },
      handler: (a) => c.speak(a.text),
    },
    {
      name: 'play_audio',
      description: 'Send an audio file (local path or URL) to the phone and play it.',
      inputSchema: {
        type: 'object',
        properties: { path: str('local file path'), url: str('http(s) url'), autoplay: { type: 'boolean' }, caption: str('caption') },
      },
      handler: (a) => c.sendAsset('audio', { path: a.path, url: a.url, meta: { autoplay: a.autoplay !== false, caption: a.caption } }),
    },
    {
      name: 'show_image',
      description: 'Send an image (local path or URL) to display on the phone.',
      inputSchema: { type: 'object', properties: { path: str('local file path'), url: str('http(s) url'), caption: str('caption') } },
      handler: (a) => c.sendAsset('image', { path: a.path, url: a.url, meta: { caption: a.caption } }),
    },
    {
      name: 'show_file',
      description: 'Send any file to the phone (offered for download/preview).',
      inputSchema: { type: 'object', properties: { path: str('local file path'), url: str('http(s) url'), name: str('display name') } },
      handler: (a) => c.sendAsset('file', { path: a.path, url: a.url, name: a.name }),
    },
    {
      name: 'show_markdown',
      description: 'Render a markdown card on the phone (good for lists, links, tables).',
      inputSchema: { type: 'object', properties: { markdown: str('markdown body'), title: str('optional title') }, required: ['markdown'] },
      handler: (a) => c.showMarkdown(a.markdown, a.title),
    },
    {
      name: 'set_status',
      description: 'Set a transient status line on the phone (e.g. progress).',
      inputSchema: { type: 'object', properties: { text: str('status text') }, required: ['text'] },
      handler: (a) => c.setStatus(a.text),
    },
    {
      name: 'ask',
      description: 'Ask the user a question on the phone and wait for their spoken or tapped answer.',
      inputSchema: {
        type: 'object',
        properties: { question: str('the question'), choices: { type: 'array', items: { type: 'string' }, description: 'optional choices' } },
        required: ['question'],
      },
      handler: (a) => c.ask(a.question, a.choices),
    },
    {
      name: 'show_form',
      description:
        'Render a form on the phone for surveys, structured input, or file uploads. `html` is the form body ' +
        '(labels + input/textarea/select/checkbox/radio/file; sanitized + themed on the phone). Returns a compact ' +
        'summary; the FULL response — including any uploaded files — is saved to a file path you can read on demand, ' +
        'so large values never bloat this reply. Give inputs a `name`.',
      inputSchema: {
        type: 'object',
        properties: { html: str('form body HTML'), title: str('optional heading'), submit: str('submit button label') },
        required: ['html'],
      },
      handler: async (a) => summarizeFormResult(await c.showForm(a.html, { title: a.title, submit: a.submit })),
    },
    {
      // Claude calls this (via --permission-prompt-tool) for tool calls its
      // permission mode won't auto-approve. We surface an approve/deny card on the
      // phone and return the SDK's expected {behavior} shape.
      name: 'permission',
      description: 'Approve or deny a tool call (Claude permission prompt). Do not call directly.',
      inputSchema: {
        type: 'object',
        properties: { tool_name: str('tool being requested'), input: { type: 'object', description: 'tool input' } },
        required: ['tool_name'],
      },
      handler: async (a) => {
        let answer;
        try {
          answer = await c.ask(`Allow ${a.tool_name}?\n${summarizeToolCall(a.tool_name, a.input)}`, ['Allow', 'Deny']);
        } catch {
          return JSON.stringify({ behavior: 'deny', message: 'No answer from the phone; denying to be safe.' });
        }
        const allow = /^(allow|yes|ok|okay|approve|sure|go ahead)\b/i.test(String(answer).trim());
        return JSON.stringify(
          allow
            ? { behavior: 'allow', updatedInput: a.input || {} }
            : { behavior: 'deny', message: 'The user denied this action from their phone.' },
        );
      },
    },
  ];
}

// Save the full form response to disk and hand the agent only a compact summary
// + the file path, so large values (and uploaded files) never enter its context.
let formSeq = 0;
function summarizeFormResult(result) {
  if (!result || (result.values == null && !(result.files && result.files.length))) {
    return 'The user cancelled the form.';
  }
  const path = join(tmpdir(), `bridle-form-${process.pid}-${++formSeq}.json`);
  try {
    // Whatever the user typed into the form — tmpdir is world-readable.
    writeFileSync(path, JSON.stringify(result, null, 2), { mode: 0o600 });
    chmodSync(path, 0o600); // `mode` only applies on creation
  } catch {
    /* fall back to inline (best effort) */
  }
  const lines = [`Form submitted. Full response saved to: ${path}`, '  (read that file for full values; large fields are truncated below)'];
  const values = result.values || {};
  const fieldLines = Object.entries(values).map(([k, v]) => {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return `  - ${k}: ${s.length > 120 ? s.slice(0, 119) + '…' : s}`;
  });
  if (fieldLines.length) lines.push('fields:', ...fieldLines);
  for (const f of result.files || []) {
    lines.push(`  - ${f.field}: file "${f.name}" (${fmtBytes(f.size)}) saved to ${f.path}`);
  }
  return lines.join('\n');
}
const fmtBytes = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n > 1e3 ? `${(n / 1e3).toFixed(1)} KB` : `${n} B`);

// A short, human-readable summary of a tool call for the permission card.
function summarizeToolCall(tool, input) {
  if (!input || typeof input !== 'object') return '';
  const pick = input.command || input.cmd || input.file_path || input.path || input.url || input.pattern;
  if (pick) return String(pick).slice(0, 300);
  const s = JSON.stringify(input);
  return s.length > 300 ? s.slice(0, 299) + '…' : s;
}
