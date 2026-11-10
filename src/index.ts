import { VisibilityState, World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { Vector3 } from 'three';
import type { Cue } from './foley/cues';
import { FoleySystem, setFoleyHooks, type FoleyApi } from './foley/system';
import type { Take } from './foley/types';
import { mountLanding, type ClipMeta } from './landing/landing';

const base = import.meta.env.BASE_URL;

/** Each film ships as VP9 WebM (Quest Browser and desktop Chromium both decode it) with an H.264 MP4 beside it. */
function preferredExt(): 'mp4' | 'webm' {
  const probe = document.createElement('video');
  return probe.canPlayType('video/webm; codecs="vp9"') ? 'webm' : 'mp4';
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

async function clipMeta(id: string): Promise<ClipMeta | null> {
  try {
    const res = await fetch(`${base}clips/${id}.json`);
    if (!res.ok) return null;
    const m = (await res.json()) as Partial<ClipMeta>;
    return { id, title: m.title ?? id, year: m.year ?? 0, duration: m.duration ?? 0, cues: Array.isArray(m.cues) ? (m.cues as Cue[]) : [] };
  } catch {
    return null;
  }
}

let api: FoleyApi | null = null;
const ready = new Promise<FoleyApi>((resolve) => {
  setFoleyHooks({
    onReady: (a) => {
      api = a;
      resolve(a);
    },
    onHit: () => {},
    onTakeStart: () => {},
    onTakeEnd: (take, a) => {
      const tracker = a.cues();
      console.log('TAKE summary', take.clipId, take.events.length, 'hits', tracker ? tracker.summary() : '');
      for (const cb of takeEndListeners) cb(take, tracker ? tracker.summary() : '', '');
    },
  });
});
const takeEndListeners: ((take: Take, summary: string, line: string) => void)[] = [];

World.create(document.getElementById('scene-container') as HTMLDivElement, projectOptions).then((world) => {
  world.registerSystem(FoleySystem);
  console.log('COCONUTS world ready', { xr: world.xrEnabled });
  world.visibilityState.subscribe((v) => {
    document.body.classList.toggle('in-xr', v !== VisibilityState.NonImmersive);
  });
  const tmp = new Vector3();
  mountLanding({
    xrSupported: async () => {
      try {
        return !!(navigator.xr && ((await navigator.xr.isSessionSupported('immersive-ar')) || (await navigator.xr.isSessionSupported('immersive-vr'))));
      } catch {
        return false;
      }
    },
    launchXR: () => world.launchXR(),
    loadClip: async (id) => {
      const a = await ready;
      const [url, meta] = await Promise.all([clipUrl(id), clipMeta(id)]);
      console.log('CUES', id, meta?.cues.length ?? 0);
      await a.loadClip(id, url, meta?.cues ?? [], `${base}films/${id}.jpg`);
      return meta;
    },
    playTake: async (take) => {
      const a = await ready;
      await a.replayTake(take);
    },
    startTake: async () => {
      const a = await ready;
      await a.startTake();
    },
    screenPositionOf: (propId) => {
      if (!api) return null;
      api.stage.worldOf(propId, tmp);
      tmp.project(world.camera);
      if (tmp.z > 1) return null;
      const el = world.renderer.domElement;
      const rect = el.getBoundingClientRect();
      return { x: rect.left + ((tmp.x + 1) / 2) * rect.width, y: rect.top + ((1 - tmp.y) / 2) * rect.height };
    },
    onTakeEnd: (cb) => takeEndListeners.push(cb),
  });
});
