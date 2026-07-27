import { test, expect } from 'bun:test';
import { McpServer } from '../src/mcp.js';

function fakeController() {
  const calls = [];
  return {
    calls,
    notify: (t, l) => { calls.push(['notify', t, l]); return 'shown'; },
    speak: () => 'spoken',
    sendAsset: async () => 'sent file (10 bytes)',
    showMarkdown: () => 'rendered',
    setStatus: () => 'ok',
    ask: async () => 'yes',
  };
}

test('MCP server: initialize, tools/list, tools/call', async () => {
  const c = fakeController();
  const s = new McpServer({ controller: c, port: 0 });
  s.start();
  const rpc = (body) =>
    fetch(s.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(body),
    }).then((r) => r.json());

  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  expect(init.result.serverInfo.name).toBe('bridle');
  expect(init.result.capabilities.tools).toBeDefined();

  const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = list.result.tools.map((t) => t.name);
  expect(names).toContain('play_audio');
  expect(names).toContain('show_image');
  expect(names).toContain('ask');

  const call = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'notify', arguments: { text: 'hi', level: 'warn' } } });
  expect(call.result.content[0].text).toBe('shown');
  expect(c.calls[0]).toEqual(['notify', 'hi', 'warn']);

  s.stop();
});

test('MCP server: notifications get no response, unknown method errors', async () => {
  const s = new McpServer({ controller: fakeController(), port: 0 });
  s.start();
  const notif = await fetch(s.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  expect(notif.status).toBe(202);

  const bad = await fetch(s.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'nope' }),
  }).then((r) => r.json());
  expect(bad.error.code).toBe(-32601);

  s.stop();
});

test('the MCP endpoint is not reachable from a web page', async () => {
  // It binds to loopback, which keeps it off the network but not away from any
  // browser running on the same machine — and these tools drive the user's phone
  // and approve the agent's tool calls.
  const s = new McpServer({ controller: fakeController(), port: 0 });
  s.start();
  const base = `http://127.0.0.1:${s.server.port}`;
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const json = { 'content-type': 'application/json' };

  // The path carries a per-run secret, so the endpoint can't just be found.
  expect(s.url).toContain('/mcp/');
  expect((await fetch(`${base}/mcp`, { method: 'POST', headers: json, body })).status).toBe(404);
  expect((await fetch(`${base}/mcp/${'0'.repeat(32)}`, { method: 'POST', headers: json, body })).status).toBe(404);

  // Even holding the URL, a page can't use it: browsers stamp Origin on every
  // cross-origin request, and MCP clients send none.
  const fromPage = await fetch(s.url, { method: 'POST', headers: { ...json, origin: 'https://evil.example' }, body });
  expect(fromPage.status).toBe(403);

  // And text/plain — the one content type a page can send without a preflight
  // this server would have to answer — is refused.
  expect((await fetch(s.url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body })).status).toBe(415);

  // The agent's own call still works.
  const ok = await fetch(s.url, { method: 'POST', headers: json, body }).then((r) => r.json());
  expect(ok.result.tools.length).toBeGreaterThan(0);

  s.stop();
});

test('two servers never share a token', () => {
  const a = new McpServer({ controller: fakeController() });
  const b = new McpServer({ controller: fakeController() });
  expect(a.token).not.toBe(b.token);
  expect(a.token.length).toBeGreaterThanOrEqual(32);
});
