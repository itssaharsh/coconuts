#!/usr/bin/env node
// Builds the test clips under qa/hear/ (inputs only): Gemini TTS for the sentences, ffmpeg to webm opus mono 32k.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const env = {};
for (const l of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) { const m = /^(GEMINI_API_KEYS)=(.*)$/.exec(l.trim()); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const key = env.GEMINI_API_KEYS.split(',')[0].trim();
const out = join(ROOT, 'qa', 'hear');
const S = {
  s1: 'The thief hides in the market and a bull gets loose',
  s2: 'A storm breaks over the graveyard and the dead wake up',
  s3: 'The knight rides to the inn and orders supper',
  s4: 'A dragon lands on the bridge and asks for a toll',
  s5: 'The baker finds a golden key inside a loaf of bread',
  s6: 'The old wizard turns the guards into frogs',
};
const voices = ['Kore', 'Puck', 'Charon', 'Zephyr', 'Fenrir', 'Aoede'];
let i = 0;
for (const [id, text] of Object.entries(S)) {
  const wav = join(out, `${id}.wav`);
  if (!existsSync(wav)) {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ parts: [{ text: `Say clearly: ${text}` }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voices[i % voices.length] } } } } }),
    });
    if (!r.ok) { console.log(id, 'tts HTTP', r.status); i++; continue; }
    const d = await r.json();
    const b64 = d.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    const pcm = join(out, `${id}.pcm`);
    writeFileSync(pcm, Buffer.from(b64, 'base64'));
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcm, wav]);
    execFileSync('rm', [pcm]);
  }
  console.log(id, 'ok');
  i++;
}
writeFileSync(join(out, 'sentences.json'), JSON.stringify(S, null, 1));
