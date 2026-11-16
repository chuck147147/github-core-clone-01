import { handleGit } from './git.ts';
import { graphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, blob, makeCommit, resolve, commitJson, fileJson, treeObject, mergeTrees, changedFiles, type Json, type Repo, type FileEntry } from './store.ts';

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function fail(status: number, message: string): never { throw new HttpError(status, message); }
function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(422, `${name} is required`);
  return value;
}
async function bodyOf(req: IncomingMessage, allowArray = false): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return fail(400, 'Malformed JSON'); }
  if (!value || typeof value !== 'object' || (Array.isArray(value) && !allowArray)) fail(400, 'Expected a JSON object');
  return value as Json;
}
function paginate(items: unknown[], url: URL, res: Pick<ServerResponse, 'setHeader'>): unknown[] {
  const page = Math.max(1, Math.trunc(Number(url.searchParams.get('page')) || 1));
  const per = Math.max(1, Math.min(100, Math.trunc(Number(url.searchParams.get('per_page')) || 30)));
  const links: string[] = [];
  for (const [rel, n] of [['next', page * per < items.length ? page + 1 : 0], ['prev', page > 1 ? page - 1 : 0]] as const) {
    if (!n) continue;
    const link = new URL(url); link.searchParams.set('page', String(n)); link.searchParams.set('per_page', String(per));
    links.push(`<${link.href}>; rel="${rel}"`);
  }
  if (links.length) res.setHeader('link', links.join(', '));
  return items.slice((page - 1) * per, page * per);
}
function refJson(repo: Repo, ref: string, sha: string): Json {
  return { ref, node_id: Buffer.from(ref).toString('base64'), url: `${repo.data.url}/git/${ref}`, object: { type: 'commit', sha, url: `${repo.data.url}/git/commits/${sha}` } };
}
function selectLabels(repo: Repo, names: unknown): Json[] {
  if (!Array.isArray(names)) fail(422, 'labels must be an array');
  return names.map(name => {
    const label = repo.labels.get(typeof name === 'string' ? name : name?.name);
    if (!label) fail(422, 'Validation Failed: unknown label');
    return label;
  });
}
function listed(values: Iterable<Json>, url: URL): Json[] {
  const state = url.searchParams.get('state') ?? 'open';
  const items = [...values].filter(v => state === 'all' || v.state === state);
  const direction = url.searchParams.get('direction') === 'asc' ? 1 : -1;
  items.sort((a, b) => direction * (a.number - b.number));
  return items;
}

/** Each server owns its store; no state leaks between standalone app instances. */
export function createApp(): Server {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  const rest = async (method: string, url: URL, body: Json, send: (status: number, data?: any) => void, res: Pick<ServerResponse, 'setHeader'>): Promise<void> => {
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const p = path.slice('/api/v3'.length).split('/').filter(Boolean).map(decodeURIComponent);
    if (!p.length && method === 'GET') {
      res.setHeader('x-oauth-scopes', 'repo, read:org');
      return send(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' });
    }
    if (p.length === 1 && p[0] === 'meta' && method === 'GET') return send(200, { installed_version: '3.0.0' });
    if (p.length === 1 && p[0] === 'user' && method === 'GET') return send(200, store.viewer);
    if (p.join('/') === 'user/repos') {
      if (method === 'GET') return send(200, paginate([...store.repos.values()].map(r => r.data), url, res));
      if (method === 'POST') {
        const name = required(body.name, 'name');
        if (!/^[\w.-]+$/.test(name) || name === '.' || name === '..') fail(422, 'Invalid repository name');
        if (store.repos.has(`${store.viewer.login}/${name}`.toLowerCase())) fail(422, 'Repository already exists');
        return send(201, store.createRepo(name, body, url.origin).data);
      }
    }
    if (p[0] !== 'repos' || p.length < 3 || p[1].toLowerCase() !== store.viewer.login.toLowerCase()) fail(404, 'Not Found');
    const key = `${p[1]}/${p[2]}`.toLowerCase();
    const repo = store.repos.get(key);
    if (!repo) fail(404, 'Not Found');
    const tail = p.slice(3), route = tail.join('/');
    if (!tail.length) {
      if (method === 'GET') return send(200, repo.data);
      if (method === 'DELETE') { store.repos.delete(key); return send(204); }
      if (method === 'PATCH') {
        if (body.name !== undefined) {
          const name = required(body.name, 'name');
          if (!/^[\w.-]+$/.test(name) || name === '.' || name === '..') fail(422, 'Invalid repository name');
          const nextKey = `${store.viewer.login}/${name}`.toLowerCase();
          if (nextKey !== key && store.repos.has(nextKey)) fail(422, 'Repository already exists');
          repo.data.name = name; repo.data.full_name = `${store.viewer.login}/${name}`;
          repo.data.html_url = `${url.origin}/${repo.data.full_name}`; repo.data.clone_url = `${repo.data.html_url}.git`;
          repo.data.url = `${url.origin}/api/v3/repos/${repo.data.full_name}`;
          store.repos.delete(key); store.repos.set(nextKey, repo);
        }
        for (const field of ['description', 'private', 'default_branch']) if (body[field] !== undefined) repo.data[field] = body[field];
        repo.data.updated_at = '2026-01-01T00:00:00.000Z'; return send(200, repo.data);
      }
    }
    if (route === 'labels') {
      if (method === 'GET') return send(200, paginate([...repo.labels.values()], url, res));
      if (method === 'POST') {
        const name = required(body.name, 'name');
        if (repo.labels.has(name)) fail(422, 'Label already exists');
        const color = required(body.color, 'color');
        if (!/^[a-f0-9]{6}$/i.test(color)) fail(422, 'Invalid color');
        const label = { id: store.nextId++, name, color, description: body.description ?? null, default: false, url: `${repo.data.url}/labels/${encodeURIComponent(name)}` };
        repo.labels.set(name, label); return send(201, label);
      }
    }
    if (tail[0] === 'contents') {
      const filePath = tail.slice(1).join('/');
      if (filePath.split('/').some(s => s === '.' || s === '..')) fail(422, 'Invalid path');
      const branch = method === 'GET' ? url.searchParams.get('ref') ?? repo.data.default_branch : body.branch ?? repo.data.default_branch;
      const tip = resolve(repo, branch), previous = tip ? repo.commits.get(tip) : undefined;
      if (!previous && (method === 'GET' || branch !== repo.data.default_branch || repo.refs.size > 0)) fail(404, 'Not Found');
      const file = previous?.tree.get(filePath);
      if (method === 'GET') {
        if (file) return send(200, fileJson(filePath, file));
        const prefix = filePath ? `${filePath}/` : '';
        const entries = new Map<string, Json>();
        for (const [name, entry] of previous!.tree) {
          if (!name.startsWith(prefix)) continue;
          const rest = name.slice(prefix.length), first = rest.split('/')[0], childPath = prefix + first;
          if (!rest.includes('/')) entries.set(first, fileJson(childPath, entry));
          else entries.set(first, { type: 'dir', name: first, path: childPath, sha: treeObject(repo, previous!.tree, `${childPath}/`) });
        }
        if (!entries.size) fail(404, 'Not Found');
        return send(200, [...entries.values()]);
      }
      if (method === 'PUT' || method === 'DELETE') {
        if (!filePath || !tail.at(-1)) fail(422, 'Invalid path');
        const message = required(body.message, 'message');
        if (method === 'DELETE' && !file) fail(404, 'Not Found');
        if ((file && body.sha !== file.sha) || (!file && body.sha !== undefined)) fail(409, 'SHA does not match');
        const tree = new Map(previous?.tree);
        let content: FileEntry | undefined;
        if (method === 'PUT') {
          if (typeof body.content !== 'string' || !/^(?:[A-Za-z0-9+/\s]*={0,2})$/.test(body.content)) fail(422, 'Invalid base64 content');
          if ([...tree.keys()].some(p => p.startsWith(`${filePath}/`) || filePath.startsWith(`${p}/`))) fail(409, 'Path conflicts with existing entry');
          content = blob(repo, Buffer.from(body.content, 'base64')); tree.set(filePath, content);
        } else tree.delete(filePath);
        const commit = makeCommit(repo, tree, tip ? [tip] : [], message, store.viewer);
        repo.refs.set(`refs/heads/${branch}`, commit.sha);
        return send(method === 'PUT' && !file ? 201 : 200, { content: content ? fileJson(filePath, content) : null, commit: commitJson(commit) });
      }
    }
    if (route === 'branches' && method === 'GET') return send(200, paginate([...repo.refs].filter(([ref]) => ref.startsWith('refs/heads/')).map(([ref, sha]) => ({ name: ref.slice(11), commit: { sha }, protected: false })), url, res));
    if (route === 'commits' && method === 'GET') {
      const selector = url.searchParams.get('sha') ?? repo.data.default_branch;
      const tip = resolve(repo, selector);
      if (!tip && repo.refs.size) fail(404, 'Not Found');
      const commits: Json[] = [], seen = new Set<string>(), pending = tip ? [tip] : [];
      while (pending.length) {
        const sha = pending.shift()!;
        if (seen.has(sha)) continue; seen.add(sha);
        const commit = repo.commits.get(sha); if (!commit) continue;
        commits.push(commitJson(commit)); pending.unshift(...commit.parents);
      }
      return send(200, paginate(commits, url, res));
    }
    if (route === 'git/refs' && method === 'POST') {
      const ref = required(body.ref, 'ref'), sha = required(body.sha, 'sha');
      if (!/^refs\/(heads|tags)\/.+/.test(ref) || /[\s~^:?*\[\\]|\.\.|@\{|\/\/|\/$|\.$/.test(ref)) fail(422, 'Invalid ref');
      if (repo.refs.has(ref) || !repo.commits.has(sha)) fail(422, 'Reference already exists or invalid sha');
      repo.refs.set(ref, sha); return send(201, refJson(repo, ref, sha));
    }
    if (tail[0] === 'git' && tail[1] === 'refs' && method === 'GET') {
      if (tail.length === 2) return send(200, [...repo.refs].map(([ref, sha]) => refJson(repo, ref, sha)));
      const suffix = tail.slice(2).join('/'), ref = suffix.startsWith('refs/') ? suffix : `refs/${suffix}`;
      const sha = repo.refs.get(ref); if (!sha) fail(404, 'Not Found');
      return send(200, refJson(repo, ref, sha));
    }
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'GET') return send(200, paginate(listed(repo.issues.values(), url), url, res));
        if (method === 'POST') {
          const title = required(body.title, 'title'), labels = selectLabels(repo, body.labels ?? []);
          const number = repo.nextNumber++, now = '2026-01-01T00:00:00.000Z';
          const issue = { id: store.nextId++, number, title, body: body.body ?? '', state: 'open', labels, user: store.viewer, comments: 0,
            created_at: now, updated_at: now, closed_at: null, html_url: `${repo.data.html_url}/issues/${number}`, url: `${repo.data.url}/issues/${number}` };
          repo.issues.set(number, issue); return send(201, issue);
        }
      }
      const issue = repo.issues.get(Number(tail[1])); if (!issue) fail(404, 'Not Found');
      if (tail.length === 2) {
        if (method === 'GET') return send(200, issue);
        if (method === 'PATCH') {
          if (body.state !== undefined && !['open', 'closed'].includes(body.state)) fail(422, 'Invalid state');
          const labels = body.labels === undefined ? issue.labels : selectLabels(repo, body.labels);
          for (const field of ['title', 'body', 'state']) if (body[field] !== undefined) issue[field] = body[field];
          issue.labels = labels; issue.updated_at = '2026-01-01T00:00:00.000Z'; issue.closed_at = issue.state === 'closed' ? issue.updated_at : null;
          return send(200, issue);
        }
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        const comments = repo.comments.get(issue.number) ?? [];
        if (method === 'GET') return send(200, paginate(comments, url, res));
        if (method === 'POST') {
          const text = required(body.body, 'body'), now = '2026-01-01T00:00:00.000Z';
          const comment = { id: store.nextId++, body: text, user: store.viewer, created_at: now, updated_at: now, html_url: `${issue.html_url}#issuecomment-${store.nextId - 1}` };
          comments.push(comment); repo.comments.set(issue.number, comments); issue.comments = comments.length;
          return send(201, comment);
        }
      }
    }
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'GET') return send(200, paginate(listed(repo.pulls.values(), url), url, res));
        if (method === 'POST') {
          const title = required(body.title, 'title'), headInput = required(body.head, 'head'), base = required(body.base, 'base');
          const [owner, head] = headInput.includes(':') ? headInput.split(':') : [store.viewer.login, headInput];
          if (owner.toLowerCase() !== store.viewer.login.toLowerCase()) fail(422, 'Invalid head');
          const headSha = resolve(repo, head), baseSha = resolve(repo, base);
          if (!headSha || !baseSha || head === base) fail(422, 'Invalid head or base');
          const number = repo.nextNumber++, now = '2026-01-01T00:00:00.000Z';
          const pull = { id: store.nextId++, number, title, body: body.body ?? '', state: 'open', user: store.viewer,
            head: { ref: head, sha: headSha, repo: repo.data, label: `${owner}:${head}` }, base: { ref: base, sha: baseSha, repo: repo.data },
            merged: false, merged_at: null, merge_commit_sha: null, created_at: now, updated_at: now, closed_at: null,
            html_url: `${repo.data.html_url}/pull/${number}`, url: `${repo.data.url}/pulls/${number}` };
          repo.pulls.set(number, pull);
          repo.issues.set(number, { ...pull, labels: [], comments: 0, pull_request: { url: pull.url, html_url: pull.html_url } });
          return send(201, pull);
        }
      }
      const pull = repo.pulls.get(Number(tail[1])); if (!pull) fail(404, 'Not Found');
      if (tail.length === 2 && method === 'GET') return send(200, pull);
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') return send(200, paginate(changedFiles(repo.commits.get(pull.base.sha)!.tree, repo.commits.get(pull.head.sha)!.tree), url, res));
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        if (pull.merged) return send(200, { sha: pull.merge_commit_sha, merged: true, message: 'Already merged' });
        const currentSha = resolve(repo, pull.base.ref)!, current = repo.commits.get(currentSha)!;
        const headSha = resolve(repo, pull.head.ref)!, head = repo.commits.get(headSha)!;
        if (body.sha !== undefined && body.sha !== headSha) fail(409, 'Head SHA does not match');
        const tree = mergeTrees(repo.commits.get(pull.base.sha)!.tree, current.tree, head.tree);
        if (!tree) fail(405, 'Pull Request is not mergeable');
        const parents = body.merge_method === 'squash' ? [currentSha] : [...new Set([currentSha, headSha])];
        const commit = makeCommit(repo, tree, parents, body.commit_title ?? `Merge pull request #${pull.number}: ${pull.title}`, store.viewer);
        repo.refs.set(`refs/heads/${pull.base.ref}`, commit.sha);
        const now = '2026-01-01T00:00:00.000Z';
        Object.assign(pull, { state: 'closed', merged: true, merged_at: now, closed_at: now, updated_at: now, merge_commit_sha: commit.sha });
        Object.assign(repo.issues.get(pull.number)!, { state: 'closed', closed_at: now, updated_at: now });
        return send(200, { sha: commit.sha, merged: true, message: 'Pull Request successfully merged' });
      }
    }
    fail(404, 'Not Found');
  };
  let requestId = 0;
  return createServer((req, res) => {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('x-github-request-id', `${process.pid.toString(16)}:${(++requestId).toString(16)}`);
    const send = (status: number, data: unknown = null): void => {
      const text = status === 204 ? '' : `${JSON.stringify(data)}\n`;
      res.statusCode = status; res.setHeader('content-length', Buffer.byteLength(text)); res.end(text);
    };
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const method = req.method ?? 'GET';
      if (await handleGit(store, token, req, res, url)) return;
      if (path === '/healthz' && method === 'GET') return send(200, { ok: true });
      if (path === '/api/graphql' || path === '/mcp' || path === '/api/v3' || path.startsWith('/api/v3/')) {
        const auth = /^(?:Bearer|token) (.+)$/i.exec(req.headers.authorization ?? '');
        if (!token || auth?.[1] !== token) fail(401, 'Bad credentials');
      } else fail(404, 'Not Found');
      if (path === '/api/graphql') {
        if (method !== 'POST') return send(405, { message: 'Method Not Allowed' });
        const body = await bodyOf(req, true);
        return send(200, await graphql(store, body, async (method, path, input) => {
          let answer: any;
          await rest(method, new URL('/api/v3' + path, url.origin), input, (status, data) => { answer = { status, data }; }, { setHeader() { return this; } });
          return answer;
        }));
      }
      if (path === '/mcp') return handleMcp(req, res, async (method, path, body) => {
        let answer: any;
        await rest(method, new URL('/api/v3' + path, url.origin), body, (status, data) => { answer = { status, data }; }, { setHeader() { return this; } });
        return answer;
      });
      const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? await bodyOf(req) : {};
      return rest(method, url, body, send, res);
    })().catch(error => {
      if (!res.headersSent) send(error instanceof HttpError ? error.status : error instanceof URIError ? 400 : 500, { message: error instanceof HttpError ? error.message : error instanceof URIError ? 'Invalid URL encoding' : 'Internal Server Error' });
      else res.end();
    });
  });
}
