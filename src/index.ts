import { automationRun, captureMode, soundForced } from './foley/env';
import { ensureAudio, recordStream } from './foley/sound';
import { VisibilityState, World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { FoleySystem, setFoleyHooks, type FoleyApi } from './foley/system';
import { mountSerialLanding } from './landing/serial-landing';

let api: FoleyApi | null = null;
setFoleyHooks({
  onReady: (a) => {
    api = a;
  },
});

World.create(document.getElementById('scene-container') as HTMLDivElement, projectOptions).then((world) => {
  if (automationRun()) {
    // the emulator's headless browser renders in software: draw small and skip shadows so hand motion is sampled often enough to test
    // (a recording run, with the sound flag on, draws at half scale so the footage is sharp)
    // (a capture run is not in a hurry: every drawn frame is a frame of the film, so it draws sharper)
    world.renderer.xr.setFramebufferScaleFactor(captureMode() ? 0.5 : soundForced() ? 0.35 : 0.25);
    world.renderer.setPixelRatio(1);
    world.renderer.shadowMap.enabled = false;
    console.log('RENDER low-fidelity (automation run)');
  }
  world.registerSystem(FoleySystem);
  if (import.meta.env.DEV) (window as unknown as { __world: unknown }).__world = world; // for the test drivers, not shipped
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
  mountSerialLanding({
    xrSupported: async () => {
      try {
        return !!(navigator.xr && ((await navigator.xr.isSessionSupported('immersive-ar')) || (await navigator.xr.isSessionSupported('immersive-vr'))));
      } catch {
        return false;
      }
    },
    launchXR: () => world.launchXR(),
    serialState: () => api?.serial().state ?? null,
  });
});
