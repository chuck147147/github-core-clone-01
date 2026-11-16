import { GitClient, hashObject, buildTree, buildCommit } from './.spec/git-client.ts';
import { deflateSync } from 'node:zlib';
// Run with MAKEFUN_SHOP_TOKEN=test ~/workspace/tools/node22/bin/node --experimental-strip-types self-test.ts
// Uses actual IncomingMessage/ServerResponse serialization without requiring a sandbox TCP bind.
import { GIT_CHECKS } from './.spec/checks-git.ts';
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
 for (const check of GIT_CHECKS) {
 const result = await check.fn({baseUrl:origin, token:'test', scenario, signal:new AbortController().signal, deadlineMs:performance.now()+20000, timeoutMs:20000, log() {}});
 console.log(check.id, result.ok ? 'PASS' : 'FAIL', result.detail); if(result.ok) passed++;
 }
 assert.equal(passed,30);
 const client = new GitClient({baseUrl:origin, token:'test'}), owner = scenario.viewer.login;
 const auth = {Authorization:'Bearer test'};
 const sha = (type: any, data: Buffer) => hashObject(type,data);
 const header = (type: number, n: number) => { const a = [(type << 4) | (n & 15)]; n = Math.floor(n/16); if(n) a[0] |= 128; while(n) {const x=n&127; n=Math.floor(n/128); a.push(x|(n?128:0));} return Buffer.from(a); };
 const vint = (n: number) => {const a:number[]=[]; do {const x=n&127;n=Math.floor(n/128);a.push(x|(n?128:0));}while(n);return Buffer.from(a);};
 const entry = (type: number, data: Buffer) => Buffer.concat([header(type,data.length),deflateSync(data)]);
 const base = Buffer.from('hello delta base\n'), next = Buffer.from('hello delta next\n');
 // The delta copies a six-byte prefix, then inserts the remaining bytes.
 const d = Buffer.concat([vint(base.length),vint(next.length),Buffer.from([0x90,6,next.length-6]),next.subarray(6)]);
 for (const mode of ['ref','ofs','thin']) {
   const name = `incoming-${mode}`; await client.createRepo(owner,name);
   const baseId = sha('blob',base), nextId = sha('blob',next);
   const tree = buildTree([{mode:'100644',name:'delta.txt',oid:nextId}]);
   const treeId = sha('tree',tree);
   const commit = buildCommit({tree:treeId,parents:[],message:'delta test\n',author:'Test <test@example.com>',timestamp:1767225600});
   const commitId = sha('commit',commit);
   if (mode === 'thin') {
     const baseTree = buildTree([{mode:'100644',name:'base.txt',oid:baseId}]);
     const baseCommit = buildCommit({tree:sha('tree',baseTree),parents:[],message:'base\n',author:'Test <test@example.com>',timestamp:1767225600});
     const setup = await client.push(owner,name,[{oldOid:'0'.repeat(40),newOid:sha('commit',baseCommit),ref:'refs/heads/base'}],{objects:[{type:'blob',data:base},{type:'tree',data:baseTree},{type:'commit',data:baseCommit}]});
     assert.ok(setup.report?.refs[0].ok);
   }
   const baseEntry = entry(3,base);
   const distance = baseEntry.length;
   assert.ok(distance < 128);
   const parts = [entry(1,commit),entry(2,tree)];
   if(mode !== 'thin') parts.push(baseEntry);
   parts.push(Buffer.concat([header(mode === 'ofs' ? 6 : 7,d.length),mode === 'ofs' ? Buffer.from([distance]) : Buffer.from(baseId,'hex'),deflateSync(d)]));
   const h = Buffer.alloc(12);h.write('PACK');h.writeUInt32BE(2,4);h.writeUInt32BE(parts.length,8);
   const bytes = Buffer.concat([h,...parts]);const packed = Buffer.concat([bytes,createHash('sha1').update(bytes).digest()]);
   const result = await client.push(owner,name,[{oldOid:'0'.repeat(40),newOid:commitId,ref:'refs/heads/main'}],{pack:packed});
   assert.ok(result.report?.unpackOk,JSON.stringify(result.report));assert.ok(result.report?.refs[0].ok);
   const clone = await client.clone(owner,name);assert.ok(clone.objects.get(nextId)?.data.equals(next));
   const rest = await fetch(`${origin}/api/v3/repos/${owner}/${name}/contents/delta.txt`,{headers:auth});
   assert.equal(rest.status,200);assert.equal(Buffer.from((await rest.json()).content,'base64').toString(),next.toString());
   const commits = await (await fetch(`${origin}/api/v3/repos/${owner}/${name}/commits`,{headers:auth})).json();assert.equal(commits[0].sha,commitId);
   const v0 = new GitClient({baseUrl:origin,token:'test',gitProtocol:0});
   const v0Clone = await v0.clone(owner,name,{depth:1});assert.ok(v0Clone.objects.get(commitId)?.data.equals(commit));
   const idle = await v0.fetch(owner,name,{wants:[commitId],haves:[commitId],haveObjects:v0Clone.objects});assert.equal(idle.objects.size,0);
   // A bad checksum must neither advance the ref nor poison a later clone.
   const corrupt = Buffer.from(packed);corrupt[corrupt.length-1] ^= 1;
   const rejected = await client.push(owner,name,[{oldOid:'0'.repeat(40),newOid:commitId,ref:'refs/heads/bad'}],{pack:corrupt});assert.equal(rejected.report?.unpackOk,false);
   assert.ok(!(await client.lsRefs(owner,name)).refs.some(r=>r.name==='refs/heads/bad'));
   console.log(`PASS extra: incoming ${mode} delta, REST visibility, v0 clone/fetch, corrupt-pack rollback`);
 }
 await client.createRepo(owner,'auth-public');
 const publicUrl = `${origin}/${owner}/auth-public.git/info/refs?service=git-upload-pack`;
 assert.equal((await fetch(publicUrl)).status,401); // createRepo makes a private repo
 await fetch(`${origin}/api/v3/repos/${owner}/auth-public`,{method:'PATCH',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({private:false})});
 assert.equal((await fetch(publicUrl)).status,200);
 assert.equal((await fetch(publicUrl,{headers:{Authorization:'Bearer wrong'}})).status,401);
 assert.equal((await fetch(publicUrl,{headers:{Authorization:'Basic '+Buffer.from('git:test').toString('base64')}})).status,200);
 assert.equal((await fetch(publicUrl.replace('upload-pack','receive-pack'))).status,401);
 // REST-created canonical objects are also available through git.
 const created = await (await fetch(`${origin}/api/v3/repos/${owner}/auth-public/contents/rest.txt`,{method:'PUT',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({message:'from REST',content:Buffer.from('REST bytes\n').toString('base64')})})).json();
 const restClone = await client.clone(owner,'auth-public');assert.ok(restClone.objects.has(created.commit.sha));assert.equal(restClone.objects.get(created.content.sha)?.data.toString(),'REST bytes\n');
 console.log('PASS extra: anonymous public read, private/write auth, Basic auth, wrong token, REST-to-git objects');
} finally {globalThis.fetch=originalFetch; server.close();}
