// Records the managed emulator page as video frames through CDP (for the backup video), e.g.
//   node node_modules/@iwsdk/cli/dist/cli.js browser run tools/xr/record.mjs
// Env: REC_SECONDS (default 30, at most ~100: a managed-browser script lives 110 s), REC_DIR (default qa/rec),
// REC_FPS cap (default 15). Frames land as JPEGs with their timestamps in frames.json; a later run with the same
// REC_DIR appends to it, so a long take is recorded as back-to-back chunks. tools/xr/record-encode.sh encodes.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export default async function run({ page, cdp }) {
  const seconds = Math.min(100, Number(process.env.REC_SECONDS ?? 30));
  const dir = process.env.REC_DIR ?? 'qa/rec';
  const maxFps = Number(process.env.REC_FPS ?? 15);
  mkdirSync(dir, { recursive: true });
  const session = cdp ?? (await page.context().newCDPSession(page));
  const listPath = join(dir, 'frames.json');
  const frames = existsSync(listPath) && process.env.REC_APPEND ? JSON.parse(readFileSync(listPath, 'utf8')) : [];
  const first = frames.length;
  let last = 0;
  session.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    const t = metadata.timestamp ?? Date.now() / 1000;
    if (t - last >= 1 / maxFps) {
      const name = `frame-${String(frames.length).padStart(5, '0')}.jpg`;
      writeFileSync(join(dir, name), Buffer.from(data, 'base64'));
      frames.push({ name, t });
      last = t;
    }
    await session.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
  });
  await session.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: 1280, maxHeight: 1280, everyNthFrame: 1 });
  await new Promise((r) => setTimeout(r, seconds * 1000));
  await session.send('Page.stopScreencast');
  writeFileSync(listPath, JSON.stringify(frames));
  const mine = frames.slice(first);
  const span = mine.length > 1 ? mine[mine.length - 1].t - mine[0].t : 0;
  return { frames: mine.length, total: frames.length, seconds: Number(span.toFixed(2)), fps: span ? Number((mine.length / span).toFixed(2)) : 0, dir };
}
