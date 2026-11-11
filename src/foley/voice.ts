// The player's own voice, for one moment between reels: hold the megaphone, say what should happen next.
// Everything here is optional. The microphone is asked for on the page, before the headset view, and only if the
// player wants it; when it is missing, refused or silent the game carries on with its pitch cards.

let stream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let stopTimer: ReturnType<typeof setTimeout> | null = null;

const FLAG = 'coconuts.voice';

export function voiceSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
}

/** The player said yes to the microphone at some point (the browser remembers the permission for this site). */
export function voiceWanted(): boolean {
  try {
    return localStorage.getItem(FLAG) === '1';
  } catch {
    return false;
  }
}

export function voiceReady(): boolean {
  return !!stream && stream.active;
}

/** Ask for the microphone (a browser prompt the first time). True when it can be used. */
export async function enableVoice(): Promise<boolean> {
  if (!voiceSupported()) return false;
  if (voiceReady()) return true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    try {
      localStorage.setItem(FLAG, '1');
    } catch {
      // private mode: the permission still holds for this visit
    }
    console.log('VOICE ready');
    return true;
  } catch (e) {
    console.log('VOICE refused', e instanceof Error ? e.name : '');
    stream = null;
    return false;
  }
}

function mimeType(): string {
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) if (MediaRecorder.isTypeSupported(t)) return t;
  return '';
}

/** Start recording; it stops by itself after `maxMs`. False when there is no microphone to record. */
export function startListening(maxMs = 6000, onAutoStop?: () => void): boolean {
  if (!voiceReady() || recorder) return false;
  try {
    const type = mimeType();
    recorder = new MediaRecorder(stream!, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined);
  } catch {
    recorder = null;
    return false;
  }
  chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  recorder.start();
  stopTimer = setTimeout(() => onAutoStop?.(), maxMs);
  return true;
}

export function listening(): boolean {
  return !!recorder;
}

/** Stop and hand back what was recorded (null when nothing was). */
export function stopListening(): Promise<Blob | null> {
  if (stopTimer) clearTimeout(stopTimer);
  stopTimer = null;
  const r = recorder;
  recorder = null;
  if (!r) return Promise.resolve(null);
  return new Promise((resolve) => {
    r.onstop = () => resolve(chunks.length ? new Blob(chunks, { type: (r.mimeType || 'audio/webm').split(';')[0] }) : null);
    try {
      r.stop();
    } catch {
      resolve(null);
    }
  });
}

function base(): string {
  try {
    return (import.meta.env?.VITE_DIRECTOR_BASE as string | undefined) || import.meta.env?.BASE_URL || '/';
  } catch {
    return '/';
  }
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
