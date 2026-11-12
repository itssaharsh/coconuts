// The player's own voice, for one moment between reels: hold the megaphone, say what should happen next.
// Everything here is optional. The microphone is asked for on the page, before the headset view, and only if the
// player wants it; when it is missing, refused or silent the game carries on with its pitch cards.

import { automationRun, functionsBase } from './env';
import { audioContext } from './sound';

let stream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let stopTimer: ReturnType<typeof setTimeout> | null = null;
/** The microphone is being opened for a take; letting go of the megaphone now calls the take off. */
let opening = false;
let calledOff = false;

const FLAG = 'coconuts.voice';

/**
 * A filmed run has no microphone: the capture tool leaves a recording in the browser's storage, and a held megaphone
 * hears that instead (under automation only: a player's megaphone always opens the microphone).
 */
const SAY = 'coconuts.say';
let scripted: Blob | null = null;
function scriptedTake(): Blob | null {
  if (!automationRun()) return null;
  try {
    const m = /^data:([^;,]+);base64,(.+)$/.exec(localStorage.getItem(SAY) ?? '');
    if (!m) return null;
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: m[1] });
  } catch {
    return null;
  }
}

export function voiceSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
}

/** The player said yes to the microphone at some point (the browser remembers the permission for this site). */
export function voiceWanted(): boolean {
  try {
    return voiceSupported() && localStorage.getItem(FLAG) === '1';
  } catch {
    return false;
  }
}

function release(s: MediaStream | null): void {
  try {
    s?.getTracks().forEach((t) => t.stop());
  } catch {
    // already gone
  }
}

/** Open the microphone. `timeoutMs` bounds the wait: inside the headset view the browser cannot always show its prompt. */
async function acquire(timeoutMs: number): Promise<MediaStream | null> {
  try {
    const want = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    if (timeoutMs <= 0) return await want;
    const got = await Promise.race([want, new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
    if (!got) void want.then(release).catch(() => undefined); // it may still arrive: let it go again
    return got;
  } catch (e) {
    console.log('VOICE refused', e instanceof Error ? e.name : '');
    return null;
  }
}

/**
 * Ask for the microphone (a browser prompt the first time). Only the permission is kept: the microphone itself is
 * opened for each take and closed after it, because an open capture stream can duck a headset's own sound.
 */
export async function enableVoice(timeoutMs = 0): Promise<boolean> {
  if (!voiceSupported()) return false;
  if (!(await hearingOn())) return false; // no prompt for a microphone nobody would listen to
  const s = await acquire(timeoutMs);
  if (!s) return false;
  release(s);
  try {
    localStorage.setItem(FLAG, '1');
  } catch {
    // private mode: the permission still holds for this visit
  }
  console.log('VOICE ready');
  return true;
}

/**
 * The microphone can be opened without the browser asking anything: the permission already stands, and the player
 * has not answered "sounds only" on the page. (Inside the headset view a browser prompt would cover the show.)
 */
export async function micAllowed(): Promise<boolean> {
  try {
    if (!voiceSupported() || localStorage.getItem('coconuts.voiceAsk') === 'no') return false;
    const p = await navigator.permissions?.query({ name: 'microphone' as PermissionName });
    return p?.state === 'granted';
  } catch {
    return false; // a browser that will not say is treated as one that would ask
  }
}

/** The loudest moment of the take so far, 0..1: a take that never rose above the room is not sent anywhere. */
let peak = 0;
let meter: { stop: () => void } | null = null;
const QUIET = 0.03;

function startMeter(s: MediaStream): void {
  peak = 0;
  meter = null;
  try {
    const ctx = audioContext();
    if (!ctx) return; // no audio graph (it never started): the take is sent unjudged
    const src = ctx.createMediaStreamSource(s);
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    const id = setInterval(() => {
      an.getFloatTimeDomainData(buf);
      for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
    }, 50);
    meter = {
      stop: () => {
        clearInterval(id);
        src.disconnect();
      },
    };
  } catch {
    meter = null;
  }
}

/** True when the take was measured and nothing in it rose above the room. */
function stopMeter(): boolean {
  const m = meter;
  meter = null;
  if (!m) return false;
  m.stop();
  return peak < QUIET;
}

function mimeType(): string {
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) if (MediaRecorder.isTypeSupported(t)) return t;
  return '';
}

/** Open the microphone and start recording; it stops by itself after `maxMs`. False when there is nothing to record with. */
export async function startListening(maxMs = 6000, onAutoStop?: () => void): Promise<boolean | 'off'> {
  if (recorder || opening || scripted || !voiceSupported()) return false;
  scripted = scriptedTake();
  if (scripted) return true; // (no clock on this take: whoever films lets go of the megaphone)
  opening = true;
  calledOff = false;
  const s = await acquire(4000);
  opening = false;
  if (calledOff) {
    release(s);
    return 'off'; // the megaphone was let go before the microphone had opened: nothing is wrong
  }
  if (!s || s.getAudioTracks()[0]?.readyState !== 'live') {
    release(s);
    return false;
  }
  try {
    const type = mimeType();
    recorder = new MediaRecorder(s, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined);
  } catch {
    recorder = null;
    release(s);
    return false;
  }
  stream = s;
  startMeter(s);
  chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  recorder.start();
  stopTimer = setTimeout(() => onAutoStop?.(), maxMs);
  return true;
}

/** A take is being recorded, or the microphone is being opened for one. */
export function listening(): boolean {
  return !!recorder || opening || !!scripted;
}

/** Stop and hand back what was recorded (null when nothing was). The microphone is closed again. */
export function stopListening(): Promise<Blob | null> {
  if (scripted) {
    const take = scripted;
    scripted = null;
    return Promise.resolve(take);
  }
  if (stopTimer) clearTimeout(stopTimer);
  stopTimer = null;
  if (opening) calledOff = true; // let go before the microphone had opened
  const r = recorder;
  const s = stream;
  recorder = null;
  stream = null;
  const quiet = stopMeter();
  if (!r) return Promise.resolve(null);
  return new Promise((resolve) => {
    r.onstop = () => {
      release(s);
      if (quiet) console.log('VOICE nothing was said');
      resolve(chunks.length && !quiet ? new Blob(chunks, { type: (r.mimeType || 'audio/webm').split(';')[0] }) : null);
    };
    try {
      r.stop();
    } catch {
      release(s);
      resolve(null);
    }
  });
}

function base(): string {
  try {
    return functionsBase();
  } catch {
    return '/';
  }
}

let heard: Promise<boolean> | null = null;
/** Whether the server can turn speech into words at all (asked once). Without it the megaphone is not offered. */
export function hearingOn(): Promise<boolean> {
  heard ??= (async () => {
    if (!voiceSupported()) return false;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    try {
      const res = await fetch(`${base()}api/hear`, { signal: ctl.signal });
      return res.ok && ((await res.json()) as { ok?: unknown }).ok === true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  })();
  return heard;
}

/** The recording's words, or null when the hearing function is off, slow or heard nothing. */
export async function transcribe(blob: Blob, timeoutMs = 9500): Promise<string | null> {
  if (blob.size < 800) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base()}api/hear`, { method: 'POST', headers: { 'content-type': blob.type || 'audio/webm' }, body: blob, signal: ctl.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as { text?: unknown };
    return typeof data.text === 'string' && data.text.trim() ? data.text.trim() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
