import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { FoleySystem, setFoleyHooks } from './foley/system';

const base = import.meta.env.BASE_URL;
const params = new URLSearchParams(location.search);
const clipId = params.get('clip') ?? 'one-week';

/** Each film ships as VP9 WebM (Quest Browser and desktop Chromium both decode it) with an H.264 MP4 beside it. */
function preferredExt(): 'mp4' | 'webm' {
  const probe = document.createElement('video');
  const vp9 = probe.canPlayType('video/webm; codecs="vp9"');
  return vp9 ? 'webm' : 'mp4';
}

async function exists(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok && !(res.headers.get('content-type') ?? '').includes('text/html');
  } catch {
    return false;
  }
}

async function clipUrl(id: string): Promise<string> {
  const ext = preferredExt();
  const other = ext === 'mp4' ? 'webm' : 'mp4';
  for (const candidate of [`${base}films/${id}.${ext}`, `${base}films/${id}.${other}`]) {
    if (await exists(candidate)) return candidate;
  }
  console.warn('FILM missing, using the test reel', id);
  return `${base}films/test.${ext}`;
}

setFoleyHooks({
  onReady: (api) => {
    clipUrl(clipId).then((url) => api.loadClip(clipId, url));
  },
  onHit: () => {},
  onTakeStart: () => {},
  onTakeEnd: (take) => {
    console.log('TAKE summary', take.clipId, take.events.length, 'hits');
  },
});

World.create(document.getElementById('scene-container') as HTMLDivElement, projectOptions).then((world) => {
  world.registerSystem(FoleySystem);
  console.log('COCONUTS world ready', { xr: world.xrEnabled });
});
