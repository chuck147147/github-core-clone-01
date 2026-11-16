import { createHash } from 'node:crypto';
import { deflateSync, inflateSync, gunzipSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { object, type Repo, type Store, type GitObject, type FileEntry } from './store.ts';
// Wire framing stays binary throughout: canonical object bytes are never reserialized.
const ZERO = '0'.repeat(40);
const hash = (b: Buffer) => createHash('sha1').update(b).digest();
export function pkt(data: string | Buffer): Buffer { const b = Buffer.from(data); return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]); }
const flush = Buffer.from('0000'), delim = Buffer.from('0001');
function packets(b: Buffer, stop = false): { lines: string[]; offset: number } {
  let offset = 0; const lines: string[] = [];
  while (offset < b.length) {
    const h = b.subarray(offset, offset + 4).toString();
    if (!/^[0-9a-f]{4}$/i.test(h)) throw Error('invalid pkt-line');
    const n = parseInt(h, 16); offset += 4;
    if (n < 4) { if (n > 2) throw Error('invalid packet'); if (stop && n === 0) break; continue; }
    if (n > 65520 || offset + n - 4 > b.length) throw Error('truncated packet');
    lines.push(b.subarray(offset, offset + n - 4).toString().replace(/\n$/, '')); offset += n - 4;
  }
  return { lines, offset };
}
function treeEntries(data: Buffer) {
  const entries: {mode: string; name: string; sha: string}[] = []; let p = 0;
  while (p < data.length) {
    const space = data.indexOf(32, p), nul = data.indexOf(0, space);
    if (space < p || nul < space || nul + 21 > data.length) throw Error('invalid tree');
    entries.push({mode: data.subarray(p, space).toString(), name: data.subarray(space + 1, nul).toString(), sha: data.subarray(nul + 1, nul + 21).toString('hex')}); p = nul + 21;
  } return entries;
}
const parents = (o: GitObject) => [...o.data.toString().split('\n\n')[0].matchAll(/^parent ([a-f0-9]{40})$/gm)].map(m => m[1]);
function links(o: GitObject, noParents = false): string[] {
  if (o.type === 'tree') return treeEntries(o.data).filter(e => e.mode !== '160000').map(e => e.sha);
  if (o.type === 'tag') return [o.data.toString().match(/^object ([a-f0-9]{40})\n/)![1]];
  if (o.type === 'commit') return [o.data.toString().match(/^tree ([a-f0-9]{40})\n/)![1], ...(!noParents ? parents(o) : [])];
  return [];
}
function closure(repo: Repo, tips: string[], stops = new Set<string>()): Set<string> {
  const found = new Set<string>(); const pending = [...tips];
  while (pending.length) { const id = pending.pop()!; if (found.has(id)) continue; const o = repo.objects.get(id); if (!o) throw Error(`missing object ${id}`); found.add(id); pending.push(...links(o, stops.has(id))); }
  return found;
}
function varint(n: number): Buffer { const out: number[] = []; do { const v = n & 127; n = Math.floor(n / 128); out.push(v | (n ? 128 : 0)); } while (n); return Buffer.from(out); }
function header(type: number, size: number): Buffer { const a = [(type << 4) | (size & 15)]; size = Math.floor(size / 16); if (size) a[0] |= 128; while (size) { const v = size & 127; size = Math.floor(size / 128); a.push(v | (size ? 128 : 0)); } return Buffer.from(a); }
function delta(base: Buffer, next: Buffer): Buffer {
  let prefix = 0; while (prefix < Math.min(base.length, next.length, 0xffffff) && base[prefix] === next[prefix]) prefix++;
  const parts = [varint(base.length), varint(next.length)];
  if (prefix) parts.push(Buffer.from([0xf0, prefix & 255, (prefix >>> 8) & 255, (prefix >>> 16) & 255]));
  for (let p = prefix; p < next.length; p += 127) { const b = next.subarray(p, p + 127); parts.push(Buffer.from([b.length]), b); }
  return Buffer.concat(parts);
}
function pack(repo: Repo, ids: Set<string>, deltas: boolean): Buffer {
  const h = Buffer.alloc(12); h.write('PACK'); h.writeUInt32BE(2, 4); h.writeUInt32BE(ids.size, 8);
  const parts = [h]; let base: { id: string; o: GitObject } | undefined;
  for (const id of ids) { const o = repo.objects.get(id)!; let data = o.data; let type = ['','commit','tree','blob','tag'].indexOf(o.type); let ref = Buffer.alloc(0);
    if (deltas && o.type === 'blob' && base && o.data.length > 256) { const d = delta(base.o.data, data); if (d.length < data.length) {data = d; type = 7; ref = Buffer.from(base.id, 'hex');} }
    parts.push(header(type, data.length), ref, deflateSync(data)); if (o.type === 'blob') base = { id, o };
  }
  const bytes = Buffer.concat(parts); return Buffer.concat([bytes, hash(bytes)]);
}
function applyDelta(base: Buffer, d: Buffer): Buffer {
  let p = 0; const read = () => { let n = 0, shift = 0, v: number; do { if (p >= d.length || shift > 49) throw Error('invalid delta size'); v = d[p++]; n += (v & 127) * 2 ** shift; shift += 7; } while (v & 128); return n; };
  if (read() !== base.length) throw Error('delta base size'); const size = read(); const out: Buffer[] = []; let total = 0;
  while (p < d.length) { const op = d[p++]; let b: Buffer;
    if (op & 128) { let offset = 0, n = 0; for (let i = 0; i < 4; i++) if (op & (1 << i)) offset += d[p++] * 2 ** (8 * i); for (let i = 0; i < 3; i++) if (op & (16 << i)) n += d[p++] * 2 ** (8 * i); n ||= 65536; if (offset + n > base.length) throw Error('delta copy bounds'); b = base.subarray(offset, offset + n); }
    else { if (!op || p + op > d.length) throw Error('delta insert bounds'); b = d.subarray(p, p + op); p += op; }
    total += b.length; if (total > size) throw Error('delta result size'); out.push(b);
  } if (total !== size) throw Error('delta result size'); return Buffer.concat(out);
}
// Resolve deltas in passes so REF_DELTA bases may occur later in the pack.
function unpack(repo: Repo, b: Buffer): void {
  if (b.length < 32 || b.toString('ascii', 0, 4) !== 'PACK' || ![2,3].includes(b.readUInt32BE(4)) || !hash(b.subarray(0,-20)).equals(b.subarray(-20))) throw Error('invalid pack checksum or header');
  let p = 12; const count = b.readUInt32BE(8); const entries: {offset: number; type: number; data: Buffer; base?: number | string; result?: GitObject}[] = [];
  if (count > 1000000) throw Error('pack too large');
  for (let i = 0; i < count; i++) { const offset = p; let v = b[p++], size = v & 15, shift = 4; const type = (v >> 4) & 7;
    while (v & 128) { if (p >= b.length - 20 || shift > 49) throw Error('pack size'); v = b[p++]; size += (v & 127) * 2 ** shift; shift += 7; }
    let base: number | string | undefined;
    if (type === 6) { let c = b[p++], distance = c & 127; while (c & 128) { c = b[p++]; distance = (distance + 1) * 128 + (c & 127); } base = offset - distance; }
    else if (type === 7) {base = b.subarray(p,p+20).toString('hex'); p += 20;}
    else if (![1,2,3,4].includes(type)) throw Error('invalid pack type');
    const inflated = inflateSync(b.subarray(p, -20), { info: true, maxOutputLength: 128 * 1024 * 1024 }); p += inflated.engine.bytesWritten;
    if (inflated.buffer.length !== size) throw Error('pack object size'); entries.push({offset, type, data: inflated.buffer, base});
  }
  if (p !== b.length - 20) throw Error('pack trailing bytes');
  const byOffset = new Map(entries.map(e => [e.offset, e])); let remaining = entries.length;
  while (remaining) { let progress = false;
    for (const e of entries) { if (e.result) continue; let o: GitObject;
      if (e.type < 6) o = {type: ['','commit','tree','blob','tag'][e.type] as GitObject['type'], data: e.data};
      else { const base = typeof e.base === 'number' ? byOffset.get(e.base)?.result : repo.objects.get(e.base!); if (!base) continue; o = {type: base.type, data: applyDelta(base.data,e.data)}; }
      object(repo,o.type,o.data); e.result = o; remaining--; progress = true;
    } if (!progress) throw Error('missing delta base');
  }
}
// Build the REST indexes without changing the pushed commit, tree, or blob bytes.
function indexCommits(repo: Repo): void {
  const files = (sha: string, prefix = '', result = new Map<string, FileEntry>()) => { const o = repo.objects.get(sha); if (o?.type !== 'tree') throw Error('missing tree'); for (const e of treeEntries(o.data)) { if (e.mode === '40000' || e.mode === '040000') files(e.sha, prefix + e.name + '/', result); else if (e.mode !== '160000') { const blob = repo.objects.get(e.sha); if (blob?.type !== 'blob') throw Error('missing blob'); result.set(prefix + e.name, {sha: e.sha, mode: e.mode, content: blob.data}); } } return result; };
  for (const [sha,o] of repo.objects) { if (o.type !== 'commit' || repo.commits.has(sha)) continue; const text = o.data.toString(), treeSha = text.match(/^tree ([a-f0-9]{40})\n/)?.[1]; if (!treeSha) throw Error('invalid commit'); const a = text.match(/^author (.*?) <(.*?)> (\d+) ([+-]\d{4})$/m); if (!a) throw Error('invalid author'); const timestamp = Number(a[3]); repo.commits.set(sha, {sha, treeSha, tree: files(treeSha), parents: parents(o), message: text.slice(text.indexOf('\n\n') + 2).replace(/\n$/, ''), timestamp, author: {name:a[1], email:a[2], date:new Date(timestamp * 1000).toISOString()}}); }
}
function peel(repo: Repo, id: string): string { const seen = new Set<string>(); while (repo.objects.get(id)?.type === 'tag') {if (seen.has(id)) throw Error('tag cycle'); seen.add(id); id = links(repo.objects.get(id)!)[0];} return id; }
function refList(repo: Repo): [string,string][] { const head = `refs/heads/${repo.data.default_branch}`; return [...(repo.refs.has(head) ? [['HEAD',repo.refs.get(head)!] as [string,string]] : []), ...[...repo.refs].sort(([a],[b]) => a.localeCompare(b))]; }
function bands(data: Buffer, band = 1): Buffer[] { const out: Buffer[] = []; for (let p = 0; p < data.length; p += 65000) out.push(pkt(Buffer.concat([Buffer.from([band]), data.subarray(p,p+65000)]))); return out; }
export async function handleGit(store: Store, token: string | undefined, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const m = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname); if (!m) return false;
  const send = (status: number, bytes: Buffer | string, type = 'text/plain; charset=utf-8') => {res.statusCode = status; res.setHeader('content-type',type); res.setHeader('content-length', Buffer.byteLength(bytes)); res.setHeader('cache-control','no-cache'); res.end(bytes);};
  const repo = store.repos.get(`${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`.toLowerCase());
  if (!repo) {send(404,'Repository not found\n'); return true;}
  const auth = req.headers.authorization; let credential = /^(?:Bearer|token) (.+)$/i.exec(auth ?? '')?.[1];
  if (/^Basic /i.test(auth ?? '')) credential = Buffer.from(auth!.slice(6),'base64').toString().split(':').slice(1).join(':');
  if ((auth && (!token || credential !== token)) || (!auth && (repo.data.private || m[3] === 'git-receive-pack' || url.searchParams.get('service') === 'git-receive-pack'))) {res.setHeader('www-authenticate','Basic realm="Git"'); send(401,'Bad credentials\n'); return true;}
  const service = m[3] === 'info/refs' ? url.searchParams.get('service') : m[3]; if (!['git-upload-pack','git-receive-pack'].includes(service!)) {send(400,'Unknown service\n'); return true;}
  const v2 = service === 'git-upload-pack' && String(req.headers['git-protocol']).includes('version=2');
  try {
    if (req.method === 'GET' && m[3] === 'info/refs') {
      let out: Buffer[];
      if (v2) out = [pkt('version 2\n'),pkt('agent=forge/1\n'),pkt('ls-refs=unborn\n'),pkt('fetch=shallow\n'),pkt('object-format=sha1\n'),flush];
      else { const refs = refList(repo); const caps = service === 'git-receive-pack' ? 'report-status delete-refs side-band-64k ofs-delta atomic agent=forge/1 object-format=sha1' : `multi_ack_detailed side-band-64k ofs-delta thin-pack shallow agent=forge/1 object-format=sha1 symref=HEAD:refs/heads/${repo.data.default_branch}`;
        const rows: [string,string][] = refs.length ? refs : [['capabilities^{}',ZERO]];
        out = [pkt(`# service=${service}\n`),flush]; rows.forEach(([name,id],i) => {out.push(pkt(`${id} ${name}${i === 0 ? '\0' + caps : ''}\n`)); if (repo.objects.get(id)?.type === 'tag') out.push(pkt(`${peel(repo,id)} ${name}^{}\n`));}); out.push(flush);
      } send(200,Buffer.concat(out),`application/x-${service}-advertisement`); return true;
    }
    if (req.method !== 'POST' || m[3] === 'info/refs') {send(405,'Method not allowed\n'); return true;}
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c)); const rawBody = Buffer.concat(chunks);
    const body = req.headers['content-encoding'] === 'gzip' ? gunzipSync(rawBody) : rawBody;
    if (service === 'git-receive-pack') {
      const {lines,offset} = packets(body,true), caps = lines[0]?.split('\0')[1] ?? ''; const commands = lines.map(l => l.split('\0')[0].split(' '));
      // Quarantine objects and derived indexes until the entire pack has verified.
      let unpackError = ''; const staged: Repo = {...repo, objects:new Map(repo.objects), commits:new Map(repo.commits)};
      try { if (body.length > offset) unpack(staged,body.subarray(offset)); else if (commands.some(c => c[1] !== ZERO)) throw Error('missing pack'); indexCommits(staged); } catch (e) {unpackError = (e as Error).message;}
      const seen = new Set<string>(); const reports = commands.map(([old,next,ref]) => { let reason = unpackError ? 'unpacker error' : '';
        if (!/^[a-f0-9]{40}$/.test(old ?? '') || !/^[a-f0-9]{40}$/.test(next ?? '') || !/^refs\/(heads|tags)\/.+/.test(ref ?? '') || /[\s~^:?*\[\\]|\.\.|@\{|\/\/|\/$|\.$/.test(ref ?? '') || seen.has(ref)) reason = 'invalid ref'; seen.add(ref);
        if (!reason && (repo.refs.get(ref) ?? ZERO) !== old) reason = 'stale old object';
        if (!reason && next !== ZERO) {try {closure(staged,[next]); if (ref.startsWith('refs/heads/') && staged.objects.get(next)?.type !== 'commit') reason = 'not a commit'; else if (old !== ZERO && ref.startsWith('refs/heads/')) { const pending = [next], visited = new Set<string>(); let ancestor = false; while (pending.length) { const id = pending.pop()!; if (id === old) {ancestor = true; break;} if (visited.has(id)) continue; visited.add(id); const o = staged.objects.get(id); if (o?.type === 'commit') pending.push(...parents(o)); } if (!ancestor) reason = 'non-fast-forward'; }} catch {reason = 'missing object';} }
        return {ref,next,reason}; });
      // Ordinary report-status permits mixed success; the atomic capability opts into rollback.
      if (caps.split(' ').includes('atomic') && reports.some(r => r.reason)) for (const r of reports) r.reason ||= 'atomic push failure';
      if (!unpackError) {repo.objects = staged.objects; repo.commits = staged.commits; for (const r of reports) if (!r.reason) {if (r.next === ZERO) repo.refs.delete(r.ref); else repo.refs.set(r.ref,r.next);} }
      const report = Buffer.concat([pkt(`unpack ${unpackError || 'ok'}\n`),...reports.map(r => pkt(`${r.reason ? 'ng' : 'ok'} ${r.ref}${r.reason ? ' ' + r.reason : ''}\n`)),flush]);
      send(200, caps.includes('side-band-64k') ? Buffer.concat([...bands(report),flush]) : report,`application/x-${service}-result`); return true;
    }
    const {lines} = packets(body); const values = (key: string) => lines.filter(l => l.startsWith(key + ' ')).map(l => l.slice(key.length + 1).split(' ')[0]);
    if (v2 && lines.includes('command=ls-refs')) {const prefixes = values('ref-prefix'); const out = refList(repo).filter(([name]) => !prefixes.length || prefixes.some(p => name.startsWith(p))).map(([name,id]) => pkt(`${id} ${name}${name === 'HEAD' && lines.includes('symrefs') ? ` symref-target:refs/heads/${repo.data.default_branch}` : ''}${lines.includes('peel') && repo.objects.get(id)?.type === 'tag' ? ` peeled:${peel(repo,id)}` : ''}\n`)); send(200,Buffer.concat([...out,flush]),`application/x-${service}-result`); return true;}
    const wants = values('want'), haves = values('have').filter(id => repo.objects.has(id)), shallow = new Set(values('shallow'));
    const depthText = values('deepen')[0];
    const depth = depthText === undefined ? Infinity : Number(depthText);
    if (!(depth > 0) || (depth !== Infinity && !Number.isSafeInteger(depth))) throw Error('invalid depth');
    const since = Number(values('deepen-since')[0]) || 0;
    const excluded = closure(repo, values('deepen-not').map(ref => repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`) ?? ref));
    const relative = lines.includes('deepen-relative');
    const limited = depth !== Infinity || since > 0 || excluded.size > 0;
    const boundary = new Set<string>(), visitedDepth = new Map<string,number>(), pending: [string,number][] = wants.map(id => [peel(repo,id),1]);
    while (pending.length) {
      const [id,rawDepth] = pending.shift()!;
      const d = relative && shallow.has(id) ? 0 : rawDepth;
      const o = repo.objects.get(id);
      if (o?.type !== 'commit' || (visitedDepth.get(id) ?? Infinity) <= d) continue;
      visitedDepth.set(id,d);
      const ps = parents(o);
      const blocked = ps.some(p => {
        const parent = repo.objects.get(p);
        const timestamp = Number(parent?.data.toString().match(/^committer .* (\d+) [+-]\d{4}$/m)?.[1]);
        return excluded.has(p) || (since > 0 && timestamp < since);
      });
      if ((d >= depth || blocked) && ps.length) boundary.add(id);
      else for (const p of ps) pending.push([p, relative && !shallow.has(id) && d === 1 ? 1 : d + 1]);
    }
    if (!limited) for (const s of shallow) boundary.add(s);
    const held = closure(repo,haves,shallow), selected = closure(repo,wants,boundary); for (const id of held) selected.delete(id);
    const shallowLines = [...boundary].filter(id => !shallow.has(id)).map(id => `shallow ${id}\n`); if (limited) for (const id of shallow) if (visitedDepth.has(id) && !boundary.has(id)) shallowLines.push(`unshallow ${id}\n`);
    const out: Buffer[] = []; const done = lines.includes('done');
    if (v2) {
      if (!done) {out.push(pkt('acknowledgments\n'),...(haves.length ? haves.map(id => pkt(`ACK ${id}\n`)) : [pkt('NAK\n')])); if (!haves.length) {out.push(flush); send(200,Buffer.concat(out),`application/x-${service}-result`); return true;} out.push(pkt('ready\n'),delim);}
      if (shallowLines.length) out.push(pkt('shallow-info\n'),...shallowLines.map(pkt),delim); out.push(pkt('packfile\n'));
    } else {if (limited || shallowLines.length) out.push(...shallowLines.map(pkt),flush); if (!done) {out.push(...haves.map(id => pkt(`ACK ${id} common\n`)),pkt('NAK\n')); send(200,Buffer.concat(out),`application/x-${service}-result`); return true;} out.push(haves.length ? pkt(`ACK ${haves.at(-1)}\n`) : pkt('NAK\n'));}
    const bytes = pack(repo,selected,lines.some(l => l.includes('ofs-delta'))); const sideband = v2 || lines.some(l => l.includes('side-band-64k'));
    if (sideband) {if (!lines.some(l => l.includes('no-progress'))) out.push(...bands(Buffer.from(`Enumerating objects: ${selected.size}, done.\n`),2)); out.push(...bands(bytes),flush);} else out.push(bytes);
    send(200,Buffer.concat(out),`application/x-${service}-result`);
  } catch (e) {send(400,`Git protocol error: ${(e as Error).message}\n`);}
  return true;
}
