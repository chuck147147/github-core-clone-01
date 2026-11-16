// Node 22 benchmark fallback when sandbox policy prevents loopback TCP.
// Uses the kit workloads with the same HTTP adapter as self-test.ts; timings exclude TCP.
import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { createApp } from './app.ts';
import { runBenchmark } from './.spec/bench.ts';
process.env.MAKEFUN_SHOP_TOKEN = 'test';
const server = createApp();
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
try { console.log(JSON.stringify(await runBenchmark({baseUrl:origin,token:'test',log:console.error, ...(process.env.CLONE_ONLY ? {workloads:['clone'] as const, rounds:25} : {})}))); } finally { globalThis.fetch = originalFetch; server.close(); }
