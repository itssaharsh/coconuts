// Starts or stops the in-page soundtrack recorder (the page must be open with ?sound), e.g.
//   MODE=start node node_modules/@iwsdk/cli/dist/cli.js browser run tools/xr/audio-rec.mjs
//   MODE=stop OUT=qa/rec/take.webm node node_modules/@iwsdk/cli/dist/cli.js browser run tools/xr/audio-rec.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export default async function run({ page }) {
  const mode = process.env.MODE ?? 'start';
  if (mode === 'start') {
    const ok = await page.evaluate(() => window.__coconuts?.start?.() ?? false);
    return { started: ok };
  }
  const dataUrl = await page.evaluate(() => window.__coconuts?.stop?.() ?? '');
  if (!dataUrl) return { saved: false, reason: 'no recorder (open the page with ?sound and start first)' };
  const out = process.env.OUT ?? 'qa/rec/take.webm';
  mkdirSync(dirname(out), { recursive: true });
  const b64 = dataUrl.split(',')[1] ?? '';
  writeFileSync(out, Buffer.from(b64, 'base64'));
  return { saved: true, out, bytes: Buffer.byteLength(b64, 'base64') };
}
