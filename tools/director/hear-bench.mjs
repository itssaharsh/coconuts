#!/usr/bin/env node
// AssemblyAI-only timing of api/hear.ts over the clips in qa/hear/ (Gemini switched off): node tools/director/hear-bench.mjs [rounds]
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
for (const l of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) { const m = /^(ASSEMBLYAI_API_KEY)=(.*)$/.exec(l.trim()); if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim(); }
const { handleHear } = (await runnerImport(join(ROOT, 'api', 'hear.ts'))).module;
for (let r = 1; r <= (Number(process.argv[2]) || 1); r++) {
  for (const c of ['s1', 's2', 's3', 's4', 's5', 's6', 'silence', 'noise']) {
    const body = readFileSync(join(ROOT, 'qa', 'hear', `${c}.webm`));
    const t = performance.now();
    const res = await handleHear(new Request('http://x/api/hear', { method: 'POST', headers: { 'content-type': 'audio/webm', 'x-forwarded-for': `10.9.${r}.${c.length}${c.charCodeAt(1)}` }, body }), { geminiKeys: [] });
    console.log(r, c, res.status, ((performance.now() - t) / 1000).toFixed(2), await res.text());
  }
}
process.exit(0);
