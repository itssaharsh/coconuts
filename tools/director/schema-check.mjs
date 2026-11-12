#!/usr/bin/env node
// Does the reel answer schema compile? One small structured-output request to Claude with the real schema and a tiny
// prompt (a few output tokens, cents), so a schema change is checked before a batch spends real reels on it:
//   node tools/director/schema-check.mjs
// A schema the grammar compiler refuses comes back as a 400 at once; anything else means it compiled.
// The key is read from .env.local only (never the shell's ANTHROPIC_API_KEY) and never printed.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { runnerImport } from 'vite';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
delete process.env.ANTHROPIC_API_KEY;
let key = '';
let model = 'claude-opus-5-5';
const envFile = join(ROOT, '.env.local');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^(ANTHROPIC_API_KEY|REEL_MODEL)=(.*)$/.exec(line.trim());
    if (!m) continue;
    const v = m[2].replace(/^["']|["']$/g, '').trim();
    if (m[1] === 'ANTHROPIC_API_KEY') key = v;
    else if (v) model = v;
  }
}
if (!key) throw new Error('no ANTHROPIC_API_KEY in .env.local');

const core = (await runnerImport('/api/_lib/reel-core.ts', { root: ROOT, configFile: false, logLevel: 'error' })).module;
const schema = core.reelSchema();
const client = new Anthropic({ apiKey: key });
const t0 = Date.now();
try {
  const res = await client.messages.create(
    {
      model,
      max_tokens: 64,
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: 'Start any answer that fits the schema.' }],
    },
    { maxRetries: 0, timeout: 240_000 },
  );
  console.log(`compiled: ${model} answered in ${Date.now() - t0} ms (stop ${res.stop_reason}, ${res.usage.output_tokens} output tokens)`);
} catch (e) {
  if (e instanceof Anthropic.BadRequestError) {
    console.log(`REFUSED in ${Date.now() - t0} ms: ${e.message}`);
    process.exitCode = 1;
  } else throw e;
}
