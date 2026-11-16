import { createHash } from 'node:crypto';
import { users } from './scenario.ts';

export type Json = Record<string, any>;
export interface FileEntry { sha: string; content: Buffer; mode: string }
export interface GitObject { type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer }
export interface Commit {
  sha: string; treeSha: string; tree: Map<string, FileEntry>; parents: string[];
  message: string; author: { name: string; email: string; date: string }; timestamp: number;
}
export interface Repo {
  data: Json; labels: Map<string, Json>; issues: Map<number, Json>; comments: Map<number, Json[]>;
  pulls: Map<number, Json>; nextNumber: number; refs: Map<string, string>;
  commits: Map<string, Commit>; objects: Map<string, GitObject>;
}
export class Store {
  users = new Map(users.map(u => [u.login, { ...u, type: 'User' }]));
  viewer = this.users.get(users[0].login)!;
  teammate = this.users.get(users[1].login)!;
  stranger = this.users.get(users[2].login)!;
  repos = new Map<string, Repo>();
  nextId = 10000;
  createRepo(name: string, input: Json, origin: string): Repo {
    const now = '2026-01-01T00:00:00.000Z';
    const full = `${this.viewer.login}/${name}`;
    const repo: Repo = {
      data: { id: this.nextId++, name, full_name: full, owner: this.viewer, private: input.private === true,
        description: input.description ?? null, default_branch: 'main', html_url: `${origin}/${full}`,
        clone_url: `${origin}/${full}.git`, url: `${origin}/api/v3/repos/${full}`, created_at: now, updated_at: now },
      labels: new Map(), issues: new Map(), comments: new Map(), pulls: new Map(), nextNumber: 1,
      refs: new Map(), commits: new Map(), objects: new Map(),
    };
    this.repos.set(full.toLowerCase(), repo);
    return repo;
  }
}

/** Store canonical loose-object payloads; pack transport can use these bytes directly. */
export function object(repo: Repo, type: GitObject['type'], data: Buffer): string {
  const sha = createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
  repo.objects.set(sha, { type, data });
  return sha;
}
export function blob(repo: Repo, content: Buffer): FileEntry {
  return { sha: object(repo, 'blob', content), content, mode: '100644' };
}
export function treeObject(repo: Repo, files: Map<string, FileEntry>, prefix = ''): string {
  const children = new Map<string, { dir: boolean; file?: FileEntry }>();
  for (const [path, file] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) children.set(rest, { dir: false, file });
    else children.set(rest.slice(0, slash), { dir: true });
  }
  const parts: Buffer[] = [];
  const names = [...children.keys()].sort((a, b) => Buffer.compare(Buffer.from(a + (children.get(a)!.dir ? '/' : '')), Buffer.from(b + (children.get(b)!.dir ? '/' : ''))));
  for (const name of names) {
    const child = children.get(name)!;
    const sha = child.dir ? treeObject(repo, files, `${prefix}${name}/`) : child.file!.sha;
    parts.push(Buffer.from(`${child.dir ? '40000' : child.file!.mode} ${name}\0`), Buffer.from(sha, 'hex'));
  }
  return object(repo, 'tree', Buffer.concat(parts));
}
export function makeCommit(repo: Repo, tree: Map<string, FileEntry>, parents: string[], message: string, author: Json): Commit {
  const timestamp = 1767225600;
  const identity = { name: String(author.name ?? author.login), email: String(author.email), date: new Date(timestamp * 1000).toISOString() };
  const treeSha = treeObject(repo, tree);
  const who = `${identity.name.replace(/[\n<>]/g, '')} <${identity.email.replace(/[\n<>]/g, '')}> ${timestamp} +0000`;
  const data = Buffer.from(`tree ${treeSha}\n${parents.map(p => `parent ${p}\n`).join('')}author ${who}\ncommitter ${who}\n\n${message}\n`);
  const commit = { sha: object(repo, 'commit', data), treeSha, tree, parents, message, author: identity, timestamp };
  repo.commits.set(commit.sha, commit);
  repo.data.updated_at = identity.date;
  return commit;
}
export function resolve(repo: Repo, ref: string): string | undefined {
  return repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`) ?? (repo.commits.has(ref) ? ref : undefined);
}
export function commitJson(c: Commit): Json {
  return { sha: c.sha, commit: { message: c.message, author: c.author, committer: c.author, tree: { sha: c.treeSha } }, parents: c.parents.map(sha => ({ sha })) };
}
export function fileJson(path: string, file: FileEntry): Json {
  return { type: 'file', name: path.split('/').at(-1), path, sha: file.sha, size: file.content.length, content: file.content.toString('base64'), encoding: 'base64' };
}

/** Merge only changes since the PR's recorded base, preserving unrelated base changes. */
export function mergeTrees(ancestor: Map<string, FileEntry>, base: Map<string, FileEntry>, head: Map<string, FileEntry>): Map<string, FileEntry> | null {
  const result = new Map(base);
  for (const path of new Set([...ancestor.keys(), ...head.keys()])) {
    const a = ancestor.get(path), b = base.get(path), h = head.get(path);
    if (a?.sha === h?.sha) continue;
    if (b?.sha !== a?.sha && b?.sha !== h?.sha) return null;
    if (h) result.set(path, h); else result.delete(path);
  }
  return result;
}

function lines(file?: FileEntry): string[] {
  if (!file || file.content.length === 0) return [];
  const values = file.content.toString('utf8').split('\n');
  if (values.at(-1) === '') values.pop();
  return values;
}
export function changedFiles(base: Map<string, FileEntry>, head: Map<string, FileEntry>): Json[] {
  const out: Json[] = [];
  for (const path of new Set([...base.keys(), ...head.keys()])) {
    const b = base.get(path), h = head.get(path);
    if (b?.sha === h?.sha) continue;
    const old = lines(b), next = lines(h);
    // LCS gives exact line additions/deletions without retaining a quadratic matrix.
    let previous = new Uint32Array(next.length + 1);
    for (const line of old) {
      const row = new Uint32Array(next.length + 1);
      for (let j = 0; j < next.length; j++) row[j + 1] = line === next[j] ? previous[j] + 1 : Math.max(previous[j + 1], row[j]);
      previous = row;
    }
    const common = previous[next.length], additions = next.length - common, deletions = old.length - common;
    out.push({ filename: path, status: !b ? 'added' : !h ? 'removed' : 'modified', additions, deletions, changes: additions + deletions, sha: h?.sha ?? b!.sha });
  }
  return out;
}
