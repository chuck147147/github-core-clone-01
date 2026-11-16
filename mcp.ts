import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Json } from './store.ts';

const revisions = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const serverInfo = { name: 'makefun-forge', version: '1.0.0' };
const capabilities = { tools: {} };
const string = { type: 'string' };
const location = { owner: string, repo: string };
const tools = [
  ['create_repo', 'Create a repository for the authenticated user.', { name: string, description: string, private: { type: 'boolean' } }, ['name']],
  ['get_repo', 'Read a repository.', location, ['owner', 'repo']],
  ['create_issue', 'Create an issue in a repository.', { ...location, title: string, body: string }, ['owner', 'repo', 'title']],
  ['list_issues', 'List repository issues by state.', { ...location, state: { type: 'string', enum: ['open', 'closed', 'all'] } }, ['owner', 'repo']],
  ['create_pull_request', 'Open a pull request between repository branches.', { ...location, title: string, body: string, head: string, base: string }, ['owner', 'repo', 'title', 'head', 'base']],
  ['merge_pull_request', 'Merge a repository pull request.', { ...location, pull_number: { type: 'integer', minimum: 1 } }, ['owner', 'repo', 'pull_number']],
].map(([name, description, properties, required]) => ({ name, description, inputSchema: { type: 'object', properties, required } })) as Array<{ name: string; description: string; inputSchema: { type: string; properties: Json; required: string[] } }>;
const record = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
type Operation = (method: string, path: string, body: Json) => Promise<{ status: number; data: any }>;

/** Stateless Streamable HTTP: one JSON response per POST; legacy sessions are optional. */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, rest: Operation): Promise<void> {
  const send = (status: number, value?: unknown) => {
    const text = value === undefined ? '' : JSON.stringify(value) + '\n';
    res.statusCode = status; res.setHeader('content-length', Buffer.byteLength(text)); res.end(text);
  };
  let id: string | number | null = null;
  const error = (code: number, message: string, status = 200, data?: unknown) => send(status, { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });
  if (req.method !== 'POST') { res.setHeader('allow', 'POST'); return error(-32600, 'Use POST', 405); }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  let rpc: unknown;
  try { rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return error(-32700, 'Parse error', 400); }
  if (!record(rpc)) return error(-32600, 'Invalid Request', 400);
  if (typeof rpc.id === 'string' || (typeof rpc.id === 'number' && Number.isFinite(rpc.id))) id = rpc.id;
  if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string' || (rpc.id !== undefined && id === null) || (rpc.params !== undefined && !record(rpc.params))) return error(-32600, 'Invalid Request', 400);
  const params = rpc.params ?? {};
  const version = params._meta?.['io.modelcontextprotocol/protocolVersion'] ?? params._meta?.protocolVersion ?? req.headers['mcp-protocol-version'];
  if (rpc.method !== 'initialize' && version && !revisions.includes(version)) return error(-32022, 'Unsupported protocol version', 400, { supported: revisions });
  if (req.headers['mcp-method'] && req.headers['mcp-method'] !== rpc.method) return error(-32020, 'Method header mismatch', 400);
  if (req.headers['mcp-protocol-version'] && version !== req.headers['mcp-protocol-version']) return error(-32020, 'Protocol version header mismatch', 400);
  // Notifications never execute tools and never receive a JSON-RPC response.
  if (rpc.id === undefined) return send(202);
  const result = (value: unknown) => send(200, { jsonrpc: '2.0', id, result: value });
  if (rpc.method === 'initialize') return result({ protocolVersion: revisions.includes(params.protocolVersion) ? params.protocolVersion : revisions[0], serverInfo, capabilities });
  if (rpc.method === 'server/discover') return result({ resultType: 'server/discover', supportedVersions: revisions, serverInfo, capabilities, _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo } });
  if (rpc.method === 'ping') return result({});
  if (rpc.method === 'tools/list') return result({ tools });
  if (rpc.method !== 'tools/call') return error(-32601, 'Method not found');
  const tool = tools.find(t => t.name === params.name);
  if (!tool) return error(-32602, 'Unknown tool');
  const args = params.arguments;
  if (!record(args)) return error(-32602, 'arguments must be an object');
  for (const key of tool.inputSchema.required) {
    const type = tool.inputSchema.properties[key].type;
    if (type === 'integer' ? !Number.isInteger(args[key]) || args[key] < 1 : typeof args[key] !== 'string' || !args[key].trim()) return error(-32602, `${key} is required`);
  }
  const path = `/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}`;
  let method = 'GET', route = path;
  switch (tool.name) {
    case 'create_repo': method = 'POST'; route = '/user/repos'; break;
    case 'create_issue': method = 'POST'; route += '/issues'; break;
    case 'list_issues': route += `/issues?state=${encodeURIComponent(args.state ?? 'open')}&per_page=100`; break;
    case 'create_pull_request': method = 'POST'; route += '/pulls'; break;
    case 'merge_pull_request': method = 'PUT'; route += `/pulls/${args.pull_number}/merge`; break;
  }
  try {
    const answer = await rest(method, route, args);
    return result({ content: [{ type: 'text', text: JSON.stringify(answer.data) }], structuredContent: Array.isArray(answer.data) ? { issues: answer.data } : answer.data, isError: answer.status >= 400 });
  } catch (failure) {
    return result({ content: [{ type: 'text', text: failure instanceof Error ? failure.message : 'Tool failed' }], isError: true });
  }
}
