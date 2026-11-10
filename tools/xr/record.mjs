// Records the managed emulator page as video frames through CDP (for the backup video), e.g.
//   node node_modules/@iwsdk/cli/dist/cli.js browser run tools/xr/record.mjs
// Env: REC_SECONDS (default 30), REC_DIR (default qa/rec), REC_FPS cap (default 15).
// Frames land as JPEGs with their timestamps in frames.json; tools/xr/record-encode.sh turns them into an MP4.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export default async function run({ page, cdp }) {
  const seconds = Number(process.env.REC_SECONDS ?? 30);
  const dir = process.env.REC_DIR ?? 'qa/rec';
  const maxFps = Number(process.env.REC_FPS ?? 15);
  mkdirSync(dir, { recursive: true });
  const session = cdp ?? (await page.context().newCDPSession(page));
  const frames = [];
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
  writeFileSync(join(dir, 'frames.json'), JSON.stringify(frames));
  const span = frames.length > 1 ? frames[frames.length - 1].t - frames[0].t : 0;
  return { frames: frames.length, seconds: Number(span.toFixed(2)), fps: span ? Number((frames.length / span).toFixed(2)) : 0, dir };
}
