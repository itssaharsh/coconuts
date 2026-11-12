#!/usr/bin/env node
// A local stand-in for the deployed functions, so the dev pages can talk to the reel Director:
//   node tools/director/serve.mjs [--port 8796]   (REEL_MODEL, REEL_FAST: from the environment, .env.local wins when it sets them)
// then start a dev page with VITE_DIRECTOR_BASE=http://127.0.0.1:8796/ in its environment.
// Keys are read from .env.local only (never from the shell, whose ANTHROPIC_API_KEY may belong to a coding agent);
// with no key there the function answers with its written reels, which is still the real request path.
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]) || 8796;

for (const name of ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GEMINI_API_KEYS', 'ASSEMBLYAI_API_KEY']) delete process.env[name];
const envFile = join(ROOT, '.env.local');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^(ANTHROPIC_API_KEY|GEMINI_API_KEY|GEMINI_API_KEYS|ASSEMBLYAI_API_KEY|REEL_MODEL|REEL_FAST|REEL_DAILY_CAP|REEL_DISABLED)=(.*)$/.exec(line.trim());
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
}
console.log('keys:', ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GEMINI_API_KEYS', 'ASSEMBLYAI_API_KEY'].filter((k) => process.env[k]).join(', ') || 'none (written reels only)');

const routes = {};
for (const name of ['reel', 'hear', 'health']) {
  try {
    routes[`/api/${name}`] = (await runnerImport(join(ROOT, 'api', `${name}.ts`))).module;
  } catch (e) {
    console.warn(`api/${name} did not load:`, e instanceof Error ? e.message.split('\n')[0] : e);
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const mod = routes[url.pathname];
  const handler = mod?.[req.method ?? 'GET'];
  if (!handler) {
    res.writeHead(404, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }).end('not found');
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const started = Date.now();
  try {
    const request = new Request(url, { method: req.method, headers: req.headers, body: body.length ? body : undefined });
    // the reel's trace (backend, repair, latency, tokens) rides back on a header, for tools/director/batch.mjs --url;
    // only this local stand-in does that, the deployed function never sends it
    let trace = null;
    const out = url.pathname === '/api/reel' && req.method === 'POST' && mod.handleReel ? await mod.handleReel(request, { onTrace: (t) => (trace = t) }) : await handler(request);
    if (trace) out.headers.set('x-reel-trace', encodeURIComponent(JSON.stringify(trace)));
    const buf = Buffer.from(await out.arrayBuffer());
    res.writeHead(out.status, Object.fromEntries(out.headers)).end(buf);
    console.log(req.method, url.pathname, out.status, `${Date.now() - started} ms`, buf.length, 'bytes');
  } catch (e) {
    console.error(req.method, url.pathname, 'threw', e);
    res.writeHead(500, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }).end('error');
  }
}).listen(port, '127.0.0.1', () => console.log(`functions on http://127.0.0.1:${port}/`));
