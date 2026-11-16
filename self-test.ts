// Run with MAKEFUN_SHOP_TOKEN=test ~/workspace/tools/node22/bin/node --experimental-strip-types self-test.ts
// Uses actual IncomingMessage/ServerResponse serialization without requiring a sandbox TCP bind.
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { runMcpChecks } from './.spec/checks-mcp.ts';
import { McpClient } from './.spec/mcp-client.ts';
import { createApp } from './app.ts';
import { buildScenario } from './.spec/wire.ts';
import { restChecks, restProtocolChecks } from './.spec/checks-rest.ts';
import { users } from './scenario.ts';
import { Store, blob, makeCommit } from './store.ts';
import { createHash } from 'node:crypto';

process.env.MAKEFUN_SHOP_TOKEN = 'test';
const server = createApp();
const scenario = buildScenario();
assert.deepEqual(users, scenario.users);
const origin = 'http://forge.test:18765';
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const output: Buffer[] = [];
  const socket = new Duplex({ read() {}, write(chunk, _encoding, callback) { output.push(Buffer.from(chunk)); callback(); } });
  const req = new IncomingMessage(socket as Socket);
  req.url = url.pathname + url.search; req.method = init.method ?? 'GET';
  req.httpVersionMajor = 1; req.httpVersionMinor = 1; req.complete = true;
  req.headers = Object.fromEntries(new Headers(init.headers)); req.headers.host = url.host;
  const res = new ServerResponse(req); res.assignSocket(socket as Socket);
  const done = new Promise<Response>((resolve, reject) => {
    res.once('error', reject);
    res.once('finish', () => {
      const bytes = Buffer.concat(output), boundary = bytes.indexOf('\r\n\r\n');
      const headerLines = bytes.subarray(0, boundary).toString().split('\r\n');
      const status = Number(headerLines.shift()!.split(' ')[1]);
      const headers = new Headers();
      for (const line of headerLines) { const colon = line.indexOf(':'); headers.append(line.slice(0, colon), line.slice(colon + 1).trim()); }
      const response = new Response(status === 204 ? null : bytes.subarray(boundary + 4), { status, headers });
      Object.defineProperty(response, 'url', { value: url.href });
      resolve(response);
    });
  });
  server.emit('request', req, res);
  if (init.body) req.push(Buffer.from(init.body as string)); req.push(null);
  return done;
}) as typeof fetch;
try {
  let passed = 0;
  for (const check of [...restChecks(), ...restProtocolChecks()]) {
    const result = await check.fn({ baseUrl: origin, token: 'test', scenario, signal: new AbortController().signal,
      deadlineMs: performance.now() + 10000, timeoutMs: 10000, log() {} });
    if (!result.ok) console.error(check.id, result.detail);
    else passed++;
  }
  assert.equal(passed, 55, `${passed}/55 conformance checks passed`);
  const mcpResults = await runMcpChecks({ baseUrl: origin, token: 'test', scenario, signal: new AbortController().signal,
    deadlineMs: performance.now() + 10000, timeoutMs: 10000, log() {} });
  for (const check of mcpResults) if (!check.result.ok) console.error(check.id, check.result.detail);
  assert.equal(mcpResults.filter(check => check.result.ok).length, 15);
  const mcp = new McpClient({ baseUrl: origin, token: 'test' });
  const initialize = await mcp.request<any>('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'self-test', version: '1' } }, { omitProtocolVersionHeader: true });
  assert.equal(initialize.result?.protocolVersion, '2025-11-25');
  assert.ok(initialize.result?.capabilities.tools);
  assert.equal((await mcp.notify('notifications/initialized')).status, 202);
  assert.deepEqual((await mcp.request('ping')).result, {});
  assert.equal((await mcp.request('tools/call', { name: 'unknown', arguments: {} }, { omitAuth: true })).status, 401);
  const wrongToken = new McpClient({ baseUrl: origin, token: 'wrong' });
  assert.equal((await wrongToken.request('tools/call', { name: 'unknown', arguments: {} })).status, 401);
  assert.equal((await mcp.postRaw('[]')).rpc?.error?.code, -32600);
  assert.equal((await mcp.request('unknown-method')).error?.code, -32601);
  assert.equal((await mcp.request('ping', {}, { extraHeaders: { 'mcp-protocol-version': '1900-01-01' } })).error?.code, -32020);
  console.log('23/23 MCP behaviors passed (15 contract checks plus handshake, notification, ping, auth ordering, malformed request, unknown method and header checks).');
  const call = async (path: string, method = 'GET', data?: unknown, token = 'Bearer test') => {
    const response = await fetch(origin + path, { method, headers: { authorization: token }, body: data === undefined ? undefined : JSON.stringify(data) });
    assert.ok(response.headers.get('x-github-request-id')); assert.match(response.headers.get('content-type')!, /application\/json/);
    return response;
  };
  assert.equal((await call('/api/v3/user', 'GET', undefined, 'token test')).status, 200);
  assert.equal((await call('/api/v3/user', 'GET', undefined, 'Bearer wrong')).status, 401);
  assert.equal((await call('/anything')).status, 404);
  const repoPath = `/api/v3/repos/${users[0].login}/extra`;
  assert.equal((await call('/api/v3/user/repos', 'POST', { name: 'extra' })).status, 201);
  assert.equal((await call('/api/v3/user/repos', 'POST', { name: 'extra' })).status, 422);
  const put = await call(`${repoPath}/contents/README.md`, 'PUT', { message: 'initial', content: Buffer.from('hello\n').toString('base64') });
  const content = await put.json();
  assert.equal(content.content.sha, 'ce013625030ba8dba906f756967f9e9ca394464a');
  assert.equal((await call(`${repoPath}/contents/README.md`, 'PUT', { message: 'missing SHA', content: 'eA==' })).status, 409);
  assert.equal((await call(`${repoPath}/git/refs/heads/main`)).status, 200);
  assert.equal((await (await call(`${repoPath}/git/refs`)).json()).length, 1);
  assert.deepEqual(await (await call(`${repoPath}/pulls`)).json(), []);
  assert.equal((await call(`${repoPath}/pulls/100`)).status, 404);
  // Independently reconstruct the binary tree and commit to verify canonical object hashing.
  const store = new Store(), repo = store.createRepo('hashes', {}, origin);
  const file = blob(repo, Buffer.from('hello\n'));
  const commit = makeCommit(repo, new Map([['README.md', file]]), [], 'initial', store.viewer);
  const treeBytes = Buffer.concat([Buffer.from('100644 README.md\0'), Buffer.from(file.sha, 'hex')]);
  const hash = (type: string, bytes: Buffer) => createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');
  assert.equal(commit.treeSha, hash('tree', treeBytes));
  assert.equal(commit.sha, hash('commit', repo.objects.get(commit.sha)!.data));
  console.log('55/55 REST conformance checks passed; identity, auth, duplicate, refs, SHA conflict and Git object checks passed.');
} finally { globalThis.fetch = originalFetch; server.close(); }
