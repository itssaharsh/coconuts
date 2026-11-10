// Starts or stops the in-page soundtrack recorder (the page must be open with ?sound), e.g.
//   MODE=on node node_modules/@iwsdk/cli/dist/cli.js browser run tools/xr/audio-rec.mjs      (sets the flag and reloads; MODE=off clears it)
//   MODE=start node node_modules/@iwsdk/cli/dist/cli.js browser run tools/xr/audio-rec.mjs
//   MODE=stop OUT=qa/rec/take.webm node node_modules/@iwsdk/cli/dist/cli.js browser run tools/xr/audio-rec.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export default async function run({ page, frame }) {
  // the app runs inside the runtime's iframe; the top document is the dev shell
  const app = frame ?? page.frames().find((f) => f.name() === 'workspace-runtime-frame') ?? page.mainFrame();
  const mode = process.env.MODE ?? 'start';
  if (mode === 'on' || mode === 'off') {
    // the flag lives in localStorage (the runtime drops query strings when it reopens the page); a reload applies it
    await app.evaluate((on) => (on ? localStorage.setItem('coconuts.sound', '1') : localStorage.removeItem('coconuts.sound')), mode === 'on');
    await app.evaluate(() => location.reload());
    await new Promise((r) => setTimeout(r, 4000));
    return { sound: mode === 'on' };
  }
  if (mode === 'start') {
    const ok = await app.evaluate(async () => (await window.__coconuts?.start?.()) ?? false);
    return { started: ok };
  }
  const dataUrl = await app.evaluate(() => window.__coconuts?.stop?.() ?? '');
  if (!dataUrl) return { saved: false, reason: 'no recorder (open the page with ?sound and start first)' };
  const out = process.env.OUT ?? 'qa/rec/take.webm';
  mkdirSync(dirname(out), { recursive: true });
  const b64 = dataUrl.split(',')[1] ?? '';
  writeFileSync(out, Buffer.from(b64, 'base64'));
  return { saved: true, out, bytes: Buffer.byteLength(b64, 'base64') };
}
