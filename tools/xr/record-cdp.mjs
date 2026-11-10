#!/usr/bin/env node
// Records the managed emulator page over its own DevTools port, outside the IWSDK command lease, so the CLI
// keeps working while it runs: a JPEG screencast (frames.json carries timestamps) and, when the page was
// opened with ?sound, the mix as WebM audio. Stops after REC_SECONDS or on SIGTERM/SIGINT.
//   REC_DIR=qa/rec REC_SECONDS=400 node tools/xr/record-cdp.mjs
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const dir = process.env.REC_DIR ?? 'qa/rec';
const seconds = Number(process.env.REC_SECONDS ?? 400);
const maxFps = Number(process.env.REC_FPS ?? 15);
const match = process.env.REC_URL ?? 'localhost:8081';

function devtoolsPort() {
  const root = `/tmp/.iwsdk-browser-${process.getuid?.() ?? 1000}`;
  for (const d of existsSync(root) ? readdirSync(root) : []) {
    const f = join(root, d, 'DevToolsActivePort');
    if (existsSync(f)) return Number(readFileSync(f, 'utf8').split('\n')[0]);
  }
  throw new Error('no DevToolsActivePort under ' + root);
}

mkdirSync(dir, { recursive: true });
const port = devtoolsPort();
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const pages = browser.contexts().flatMap((c) => c.pages());
const page = pages.find((p) => p.url().includes(match));
if (!page) throw new Error(`no page matching ${match}; have ${pages.map((p) => p.url()).join(', ')}`);
const cdp = await page.context().newCDPSession(page);
// the app runs inside the runtime's iframe; the top document is the dev shell
const app = page.frames().find((f) => f.name() === 'workspace-runtime-frame') ?? page.mainFrame();

const audioOn = await app.evaluate(async () => (await window.__coconuts?.start?.()) ?? false).catch(() => false);
const frames = [];
let last = 0;
const t0 = Date.now();
cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
  const t = metadata.timestamp ?? Date.now() / 1000;
  if (t - last >= 1 / maxFps) {
    const name = `frame-${String(frames.length).padStart(5, '0')}.jpg`;
    writeFileSync(join(dir, name), Buffer.from(data, 'base64'));
    frames.push({ name, t });
    last = t;
  }
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: 1280, maxHeight: 1280, everyNthFrame: 1 });
console.log(JSON.stringify({ recording: true, port, audio: audioOn, page: page.url(), app: app.url() }));

let stopping = false;
async function stop(reason) {
  if (stopping) return;
  stopping = true;
  await cdp.send('Page.stopScreencast').catch(() => undefined);
  writeFileSync(join(dir, 'frames.json'), JSON.stringify(frames));
  let audio = null;
  if (audioOn) {
    const dataUrl = await app.evaluate(() => window.__coconuts?.stop?.() ?? '').catch(() => '');
    const b64 = dataUrl.split(',')[1] ?? '';
    if (b64) {
      writeFileSync(join(dir, 'take.webm'), Buffer.from(b64, 'base64'));
      audio = Buffer.byteLength(b64, 'base64');
    }
  }
  const span = frames.length > 1 ? frames[frames.length - 1].t - frames[0].t : 0;
  console.log(JSON.stringify({ stopped: reason, frames: frames.length, seconds: Number(span.toFixed(1)), fps: span ? Number((frames.length / span).toFixed(2)) : 0, audioBytes: audio, wall: Math.round((Date.now() - t0) / 1000) }));
  await browser.close().catch(() => undefined);
  process.exit(0);
}
process.on('SIGTERM', () => void stop('signal'));
process.on('SIGINT', () => void stop('signal'));
setTimeout(() => void stop('time'), seconds * 1000);
