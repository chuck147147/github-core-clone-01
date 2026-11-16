import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { createApp } from './app.ts';
import { buildScenario } from './.spec/wire.ts';
import { GRAPHQL_CHECKS, GRAPHQL_DOCUMENTS, configureGraphQLGit } from './.spec/checks-graphql.ts';
process.env.MAKEFUN_SHOP_TOKEN = 'test';
const server = createApp(), scenario = buildScenario();
const origin = 'http://forge.test:18766';
const originalFetch = globalThis.fetch;
const seen = new Set<string>();
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
  if (url.pathname === '/api/graphql' && init.body) { const b = JSON.parse(String(init.body)); for (const op of Array.isArray(b) ? b : [b]) if (op.query) seen.add(op.query); }
  server.emit('request', req, res);
  if (init.body) req.push(Buffer.from(init.body as string)); req.push(null);
  return done;
}) as typeof fetch;

async function rest(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(origin + '/api/v3' + path, { method, headers: { authorization: 'Bearer test' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json(); if (!response.ok) throw Error(`${method} ${path}: ${response.status} ${JSON.stringify(data)}`); return data;
}
// The contract's git adapter pushes one commit. REST contents/refs builds the same
// branch trees in process; transport itself is outside this GraphQL validation.
configureGraphQLGit({ async pushBranch(request) {
  try {
    const path = `/repos/${request.owner}/${request.repo}`;
    if (request.from) {
      const ref = await rest(`${path}/git/refs/heads/${request.from}`);
      await rest(`${path}/git/refs`, 'POST', { ref: `refs/heads/${request.branch}`, sha: ref.object.sha });
    }
    let sha;
    const current = await fetch(origin + '/api/v3' + path + `/contents/${request.path}?ref=${encodeURIComponent(request.branch)}`, { headers: { authorization: 'Bearer test' } });
    if (current.ok) sha = (await current.json()).sha;
    await rest(`${path}/contents/${request.path}`, 'PUT', { branch: request.branch, message: request.message, content: Buffer.from(request.content).toString('base64'), ...(sha ? { sha } : {}) });
    return null;
  } catch (error) { return String(error); }
} });
try {
  let passed = 0;
  for (const check of GRAPHQL_CHECKS) {
    const result = await check.fn({ baseUrl: origin, token: 'test', scenario, signal: new AbortController().signal, deadlineMs: performance.now() + 15000, timeoutMs: 15000, log() {} });
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${check.id}: ${result.detail}`);
    if (result.ok) passed++;
  }
  const missing = Object.entries(GRAPHQL_DOCUMENTS).filter(([, document]) => !seen.has(document));
  console.log(`${passed}/${GRAPHQL_CHECKS.length} GraphQL checks passed; ${Object.keys(GRAPHQL_DOCUMENTS).length - missing.length}/${Object.keys(GRAPHQL_DOCUMENTS).length} exported documents sent.`);
  for (const [name] of missing) console.error('Unsent document:', name);
  assert.equal(missing.length, 0); assert.equal(passed, 20);
  const query = async (query: string, variables = {}, authorization = 'Bearer test') => {
    const response = await fetch(origin + '/api/graphql', { method: 'POST', headers: { authorization }, body: JSON.stringify({ query, variables }) });
    return { status: response.status, body: await response.json() };
  };
  const fragment = await query('query Named($enabled: Boolean = true) { viewer { ...UserFields } } fragment UserFields on User { alias: login }');
  assert.equal(fragment.body.data.viewer.alias, scenario.viewer.login);
  const schema = await query('{ __schema { queryType { name } types { name kind } } __type(name: "Repository") { fields { name type { kind name ofType { name kind } } } } }');
  assert.equal(schema.body.data.__schema.queryType.name, 'Query');
  assert.ok(schema.body.data.__type.fields.some((f: any) => f.name === 'id' && f.type.kind === 'NON_NULL' && f.type.ofType.name === 'ID'));
  for (const document of ['{ viewer {', '{ nonexistent }', '{ repository(owner: "missing", name: "missing") { nonexistent } }']) {
    const answer = await query(document); assert.equal(answer.status, 200); assert.ok(answer.body.errors.length);
  }
  assert.equal((await query('{ viewer { login } }', {}, 'Bearer wrong')).status, 401);
  console.log('6/6 additional GraphQL behaviors passed (fragments/default variables, schema/type references, three invalid documents, wrong-token auth).');

} finally { globalThis.fetch = originalFetch; configureGraphQLGit(null); server.close(); }
