// Every effect is synthesized here with Web Audio: no samples, no licences, and it plays offline.
import { automationRun, soundForced } from './env';
import type { HitEvent, PropId } from './types';

type Vec3Like = { x: number; y: number; z: number };

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let recDest: MediaStreamAudioDestinationNode | null = null;
const panners = new Map<PropId | 'director', PannerNode>();
const held = new Map<string, { stop: (t?: number) => void; set: (v: number) => void }>();
let noiseBuffer: AudioBuffer | null = null;

export function audioContext(): AudioContext | null {
  return ctx;
}

/** Automation runs (the emulator driven by scripts) have no ears; the audio graph stays off so nothing can crash. */
function audioSilenced(): boolean {
  if (automationRun() && !soundForced()) return true;
  return typeof location !== 'undefined' && new URLSearchParams(location.search).has('silent');
}

/** Create (or resume) the audio graph. Call from a user gesture such as the clapper pinch. */
export async function ensureAudio(): Promise<AudioContext | null> {
  if (audioSilenced()) {
    if (!ctx) console.log('AUDIO silent (automation run)');
    return null;
  }
  try {
    if (!ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctx = new AC({ latencyHint: 'interactive' });
      master = ctx.createGain();
      master.gain.value = 0.9;
      master.connect(ctx.destination);
      recDest = ctx.createMediaStreamDestination();
      master.connect(recDest);
      console.log('AUDIO ready', ctx.sampleRate);
    }
    if (ctx.state !== 'running') await ctx.resume();
  } catch (err) {
    console.warn('AUDIO unavailable', err);
  }
  return ctx;
}

export function setMasterVolume(v: number): void {
  if (master && ctx) master.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), ctx.currentTime, 0.02);
}

/** The mix as a stream, for recording the video's soundtrack. */
export function recordStream(): MediaStream | null {
  return recDest?.stream ?? null;
}

function noise(): AudioBuffer {
  if (noiseBuffer || !ctx) return noiseBuffer!;
  const len = ctx.sampleRate * 2;
  noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = noiseBuffer.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuffer;
}

function pannerFor(id: PropId | 'director'): PannerNode {
  let p = panners.get(id);
  if (!p) {
    p = ctx!.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 0.5;
    p.rolloffFactor = 1;
    p.connect(master!);
    panners.set(id, p);
  }
  return p;
}

/** Keep each prop's sound where the prop is. */
export function placeSource(id: PropId | 'director', pos: Vec3Like): void {
  if (!ctx) return;
  const p = pannerFor(id);
  const t = ctx.currentTime;
  p.positionX.setTargetAtTime(pos.x, t, 0.03);
  p.positionY.setTargetAtTime(pos.y, t, 0.03);
  p.positionZ.setTargetAtTime(pos.z, t, 0.03);
}

export function placeListener(pos: Vec3Like, forward: Vec3Like, up: Vec3Like): void {
  if (!ctx) return;
  const l = ctx.listener;
  const t = ctx.currentTime;
  if (l.positionX) {
    l.positionX.setTargetAtTime(pos.x, t, 0.03);
    l.positionY.setTargetAtTime(pos.y, t, 0.03);
    l.positionZ.setTargetAtTime(pos.z, t, 0.03);
    l.forwardX.setTargetAtTime(forward.x, t, 0.03);
    l.forwardY.setTargetAtTime(forward.y, t, 0.03);
    l.forwardZ.setTargetAtTime(forward.z, t, 0.03);
    l.upX.setTargetAtTime(up.x, t, 0.03);
    l.upY.setTargetAtTime(up.y, t, 0.03);
    l.upZ.setTargetAtTime(up.z, t, 0.03);
  } else {
    (l as unknown as { setPosition: (x: number, y: number, z: number) => void }).setPosition(pos.x, pos.y, pos.z);
    (l as unknown as { setOrientation: (...a: number[]) => void }).setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
  }
}

function env(g: GainNode, t0: number, peak: number, attack: number, decay: number): void {
  g.gain.cancelScheduledValues(t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
}

function burst(out: AudioNode, t0: number, peak: number, attack: number, decay: number, filter: { type: BiquadFilterType; f: number; q: number }): void {
  const src = ctx!.createBufferSource();
  src.buffer = noise();
  src.loop = true;
  const bq = ctx!.createBiquadFilter();
  bq.type = filter.type;
  bq.frequency.value = filter.f;
  bq.Q.value = filter.q;
  const g = ctx!.createGain();
  env(g, t0, peak, attack, decay);
  src.connect(bq).connect(g).connect(out);
  src.start(t0);
  src.stop(t0 + attack + decay + 0.05);
}

function tone(out: AudioNode, t0: number, f: number, peak: number, attack: number, decay: number, type: OscillatorType = 'sine', fEnd?: number): OscillatorNode {
  const o = ctx!.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f, t0);
  if (fEnd) o.frequency.exponentialRampToValueAtTime(Math.max(20, fEnd), t0 + attack + decay);
  const g = ctx!.createGain();
  env(g, t0, peak, attack, decay);
  o.connect(g).connect(out);
  o.start(t0);
  o.stop(t0 + attack + decay + 0.05);
  return o;
}

/** A coconut half striking: a woody knock with a hollow ring. `v` strength 0..1; `which` picks the shell. */
function clop(v = 1, which: 0 | 1 = 0, at?: number): void {
  if (!ctx) return;
  const t0 = at ?? ctx.currentTime;
  const out = pannerFor('coconuts');
  const base = which === 0 ? 520 : 610;
  const amp = 0.25 + 0.55 * v;
  tone(out, t0, base * 1.9, amp * 0.9, 0.002, 0.045, 'triangle', base * 1.2);
  tone(out, t0, base, amp * 0.6, 0.002, 0.09, 'sine', base * 0.8);
  burst(out, t0, amp * 0.5, 0.002, 0.03, { type: 'bandpass', f: 1800, q: 2 });
}

function knock(v = 1, at?: number): void {
  if (!ctx) return;
  const t0 = at ?? ctx.currentTime;
  const out = pannerFor('door');
  const amp = 0.3 + 0.6 * v;
  tone(out, t0, 160, amp, 0.002, 0.07, 'sine', 70);
  burst(out, t0, amp * 0.7, 0.001, 0.04, { type: 'lowpass', f: 1200, q: 0.7 });
}

function slam(v = 1, at?: number): void {
  if (!ctx) return;
  const t0 = at ?? ctx.currentTime;
  const out = pannerFor('door');
  const amp = 0.5 + 0.5 * v;
  tone(out, t0, 110, amp, 0.003, 0.18, 'sine', 45);
  burst(out, t0, amp, 0.002, 0.12, { type: 'lowpass', f: 700, q: 0.8 });
  burst(out, t0 + 0.01, amp * 0.5, 0.002, 0.25, { type: 'bandpass', f: 2400, q: 1.2 });
  // the latch rattles after
  for (let i = 0; i < 3; i++) tone(out, t0 + 0.09 + i * 0.045, 1900 + i * 150, amp * 0.12, 0.001, 0.03, 'square');
}

function ding(v = 1, at?: number): void {
  if (!ctx) return;
  const t0 = at ?? ctx.currentTime;
  const out = pannerFor('bell');
  const amp = 0.2 + 0.5 * v;
  const f = 2093;
  tone(out, t0, f, amp, 0.002, 1.4);
  tone(out, t0, f * 2.76, amp * 0.35, 0.002, 0.7);
  tone(out, t0, f * 5.4, amp * 0.15, 0.002, 0.35);
  burst(out, t0, amp * 0.3, 0.001, 0.02, { type: 'highpass', f: 4000, q: 0.7 });
}

/** The thunder sheet: a continuous rumble whose level follows the shake. */
function rumbleStart(): void {
  if (!ctx || held.has('thunder')) return;
  const out = pannerFor('thunder');
  const src = ctx.createBufferSource();
  src.buffer = noise();
  src.loop = true;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 180;
  lp.Q.value = 0.9;
  const peakF = ctx.createBiquadFilter();
  peakF.type = 'peaking';
  peakF.frequency.value = 90;
  peakF.gain.value = 10;
  const g = ctx.createGain();
  g.gain.value = 0.0001;
  src.connect(lp).connect(peakF).connect(g).connect(out);
  src.start();
  held.set('thunder', {
    set: (v) => {
      const t = ctx!.currentTime;
      g.gain.setTargetAtTime(0.0001 + v * 0.9, t, 0.06);
      lp.frequency.setTargetAtTime(120 + v * 500, t, 0.08);
    },
    stop: (t) => {
      const when = t ?? ctx!.currentTime;
      g.gain.setTargetAtTime(0.0001, when, 0.25);
      src.stop(when + 1.2);
      held.delete('thunder');
    },
  });
}

export function rumbleSet(v: number): void {
  if (!held.has('thunder')) rumbleStart();
  held.get('thunder')?.set(Math.max(0, Math.min(1, v)));
}

export function rumbleStop(): void {
  held.get('thunder')?.stop();
}

/** A one-shot thunder clap for pinch play. */
function rumbleOnce(v = 1, at?: number): void {
  if (!ctx) return;
  const t0 = at ?? ctx.currentTime;
  const out = pannerFor('thunder');
  burst(out, t0, 0.4 + 0.6 * v, 0.03, 1.6, { type: 'lowpass', f: 220, q: 0.9 });
  burst(out, t0 + 0.12, 0.3 * v, 0.05, 0.9, { type: 'lowpass', f: 400, q: 0.7 });
}

/** The slide whistle: a held tone whose pitch follows the slide (0 low .. 1 high). */
function whistleStart(pitch = 0.5): void {
  if (!ctx || held.has('whistle')) return;
  const out = pannerFor('whistle');
  const o = ctx.createOscillator();
  o.type = 'triangle';
  const vib = ctx.createOscillator();
  vib.frequency.value = 5.5;
  const vibGain = ctx.createGain();
  vibGain.gain.value = 6;
  vib.connect(vibGain).connect(o.frequency);
  const g = ctx.createGain();
  g.gain.value = 0.0001;
  const t = ctx.currentTime;
  o.frequency.setValueAtTime(whistleHz(pitch), t);
  g.gain.setTargetAtTime(0.35, t, 0.02);
  o.connect(g).connect(out);
  o.start();
  vib.start();
  held.set('whistle', {
    set: (p) => o.frequency.setTargetAtTime(whistleHz(p), ctx!.currentTime, 0.03),
    stop: (when) => {
      const w = when ?? ctx!.currentTime;
      g.gain.setTargetAtTime(0.0001, w, 0.05);
      o.stop(w + 0.4);
      vib.stop(w + 0.4);
      held.delete('whistle');
    },
  });
}

const whistleHz = (p: number): number => 240 * Math.pow(2, Math.max(0, Math.min(1, p)) * 2.6);

export function whistleSet(pitch: number): void {
  if (!held.has('whistle')) whistleStart(pitch);
  held.get('whistle')?.set(pitch);
}

export function whistleStop(): void {
  held.get('whistle')?.stop();
}

/** A one-shot pratfall: the classic slide from high to low. */
function whistleFall(v = 1, at?: number): void {
  if (!ctx) return;
  const t0 = at ?? ctx.currentTime;
  const out = pannerFor('whistle');
  tone(out, t0, whistleHz(0.95), 0.3 + 0.2 * v, 0.02, 0.75, 'triangle', whistleHz(0.05));
}

function crash(v = 1, at?: number): void {
  if (!ctx) return;
  const t0 = at ?? ctx.currentTime;
  const out = pannerFor('glass');
  const amp = 0.4 + 0.6 * v;
  burst(out, t0, amp, 0.002, 0.35, { type: 'highpass', f: 2500, q: 0.6 });
  for (let i = 0; i < 10; i++) {
    const dt = Math.random() * 0.25;
    const f = 2600 + Math.random() * 5400;
    tone(out, t0 + dt, f, amp * (0.08 + Math.random() * 0.1), 0.001, 0.12 + Math.random() * 0.4, 'sine', f * 0.98);
  }
  tone(out, t0, 140, amp * 0.5, 0.002, 0.1, 'sine', 60);
}

/** Play a recorded or one-shot hit now (or at an absolute context time). */
export function playHit(hit: HitEvent, at?: number): void {
  switch (hit.kind) {
    case 'clop':
      clop(hit.v, hit.hand === 'left' ? 1 : 0, at);
      break;
    case 'knock':
      knock(hit.v, at);
      break;
    case 'slam':
      slam(hit.v, at);
      break;
    case 'ding':
      ding(hit.v, at);
      break;
    case 'rumble':
      rumbleOnce(hit.v, at);
      break;
    case 'whistle':
      whistleFall(hit.v, at);
      break;
    case 'crash':
      crash(hit.v, at);
      break;
  }
}

export function stopHeld(): void {
  for (const h of held.values()) h.stop();
}

/** Play a decoded voice clip (the Director) from the theatre's position; resolves when it ends. */
export async function playVoice(data: ArrayBuffer): Promise<void> {
  const c = await ensureAudio();
  if (!c) return;
  const buffer = await c.decodeAudioData(data.slice(0));
  const src = c.createBufferSource();
  src.buffer = buffer;
  const g = c.createGain();
  g.gain.value = 0.9;
  src.connect(g).connect(pannerFor('director'));
  await new Promise<void>((resolve) => {
    src.onended = () => resolve();
    src.start();
  });
}

/** A soft click when a take is about to start, so the room feels alive before the first hit. */
export function clapperSnap(at?: number): void {
  if (!ctx) return;
  const t0 = at ?? ctx.currentTime;
  const out = pannerFor('director');
  burst(out, t0, 0.5, 0.001, 0.05, { type: 'bandpass', f: 2600, q: 1.5 });
  tone(out, t0, 420, 0.3, 0.001, 0.05, 'square', 180);
}
