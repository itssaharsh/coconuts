import { automationRun, serialMode, soundForced } from './foley/env';
import { ensureAudio, recordStream } from './foley/sound';
import { VisibilityState, World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { Vector3 } from 'three';
import type { Cue } from './foley/cues';
import { preTakeLine, reviewTake, speak } from './foley/director';
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
let currentClip: ClipMeta | null = null;
const takeEndListeners: ((take: Take, summary: string, line: string) => void)[] = [];
const ready = new Promise<FoleyApi>((resolve) => {
  setFoleyHooks({
    onReady: (a) => {
      api = a;
      resolve(a);
    },
    onHit: () => {},
    onTakeStart: (a) => {
      if (!currentClip) return;
      const line = preTakeLine(currentClip);
      a.say(line, 'the Director', 7);
      console.log('DIRECTOR', line);
      void speak(line); // the Director's own base: this site, or VITE_DIRECTOR_BASE in a dev build
    },
    onTakeEnd: (take, a) => {
      const tracker = a.cues();
      const summary = tracker ? tracker.summary() : '';
      console.log('TAKE summary', take.clipId, take.events.length, 'hits', summary);
      if (!tracker || !currentClip) return;
      void reviewTake({ clip: currentClip, tracker, take }).then(({ line, source }) => {
        console.log('DIRECTOR review', source, line);
        a.say(line, source === 'model' ? 'the Director' : 'the Director, offline', 10);
        void speak(line);
        for (const cb of takeEndListeners) cb(take, summary, line);
      });
    },
  });
});

World.create(document.getElementById('scene-container') as HTMLDivElement, projectOptions).then((world) => {
  if (automationRun()) {
    // the emulator's headless browser renders in software: draw small and skip shadows so hand motion is sampled often enough to test
    // (a recording run, with the sound flag on, draws at half scale so the footage is sharp)
    world.renderer.xr.setFramebufferScaleFactor(soundForced() ? 0.35 : 0.25);
    world.renderer.setPixelRatio(1);
    world.renderer.shadowMap.enabled = false;
    console.log('RENDER low-fidelity (automation run)');
  }
  world.registerSystem(FoleySystem);
  if (soundForced()) {
    // the video's soundtrack: start() records the mix, stop() resolves with a data URL of the WebM audio
    let rec: MediaRecorder | null = null;
    let chunks: Blob[] = [];
    (window as unknown as { __coconuts: unknown }).__coconuts = {
      start: async () => {
        await ensureAudio(); // the graph (and its recordable mix) exists only once the context does
        const stream = recordStream();
        if (!stream) return false;
        chunks = [];
        rec = new MediaRecorder(stream, { mimeType: 'audio/webm' });
        rec.ondataavailable = (e) => chunks.push(e.data);
        rec.start(250);
        return true;
      },
      stop: () =>
        new Promise<string>((resolve) => {
          if (!rec) return resolve('');
          rec.onstop = () => {
            const blob = new Blob(chunks, { type: 'audio/webm' });
            const r = new FileReader();
            r.onload = () => resolve(String(r.result));
            r.readAsDataURL(blob);
          };
          rec.stop();
        }),
    };
  }
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
      if (serialMode()) return null; // the Serial brings its own reels
      const [url, meta] = await Promise.all([clipUrl(id), clipMeta(id)]);
      console.log('CUES', id, meta?.cues.length ?? 0);
      currentClip = meta;
      await a.loadClip(id, url, meta?.cues ?? [], `${base}films/${id}.jpg`);
      return meta;
    },
    playTake: async (take) => {
      const a = await ready;
      await a.replayTake(take);
    },
    startTake: async () => {
      const a = await ready;
      if (a.serial()) await a.roll();
      else await a.startTake();
    },
    screenPositionOf: (propId) => {
      if (!api || !api.placed()) return null; // before placement the props sit at the origin and the glove would point at nothing
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
