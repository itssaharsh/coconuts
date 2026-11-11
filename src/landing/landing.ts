// The landing overlay: wires the buttons and chips to the engine and keeps the result card and the glove in step.
// The Serial (the default show) has its own page in serial-landing.ts; this file's films page runs with `?films`.
import './landing.css';
import { CueTracker, type Cue } from '../foley/cues';
import { directorLine } from '../foley/director';
import { serialMode } from '../foley/env';
import { decodeTake, encodeTake } from '../foley/recorder';
import { ensureAudio } from '../foley/sound';
import type { Take } from '../foley/types';
import { mountSerialLanding } from './serial-landing';

export interface ClipMeta {
  id: string;
  title: string;
  year: number;
  duration: number;
  cues: Cue[];
}

export interface EngineBridge {
  xrSupported: () => Promise<boolean>;
  launchXR: () => void;
  loadClip: (id: string) => Promise<ClipMeta | null>;
  playTake: (take: Take) => Promise<void>;
  startTake: () => Promise<void>;
  /** Screen-space position of a prop, in CSS pixels, or null when off screen. */
  screenPositionOf: (propId: string) => { x: number; y: number } | null;
  onTakeEnd: (cb: (take: Take, summary: string, line: string) => void) => void;
  /** The Serial's state (boot | loading | ready | playing | pitch | writing), or null before it exists and in the films show. */
  serialState: () => string | null;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

async function loadDemoTake(id: string): Promise<Take | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}takes/${id}-demo.json`);
    if (!res.ok) return null;
    return (await res.json()) as Take;
  } catch {
    return null;
  }
}

export function mountLanding(engine: EngineBridge): void {
  const serial = serialMode();
  document.documentElement.classList.toggle('show-serial', serial);
  document.documentElement.classList.toggle('show-films', !serial);
  if (serial) {
    mountSerialLanding(engine);
    return;
  }
  document.title = 'Coconuts: be the sound of a silent movie'; // the head names the Serial, the default show
  const params = new URLSearchParams(location.search);
  const state = params.get('state');
  const enter = $<HTMLButtonElement>('enter');
  const play = $<HTMLButtonElement>('play');
  const playTake = $<HTMLButtonElement>('playTake');
  const copyLink = $<HTMLButtonElement>('copyLink');
  const note = $<HTMLParagraphElement>('note');
  // a take travels as a code in the URL: /#take=<clip>.<events>
  const shared = decodeTake(new URLSearchParams(location.hash.replace(/^#/, '')).get('take') ?? '');
  const chips = Array.from(document.querySelectorAll<HTMLButtonElement>('#chips .chip'));
  let clip: ClipMeta | null = null;
  let demo: Take | null = null;

  const showResult = (take: Take | null, meta: ClipMeta | null, label: string) => {
    const hits = $<HTMLUListElement>('hits');
    hits.replaceChildren();
    if (!take || !meta) {
      $('takeTitle').textContent = meta ? `${meta.title} (${meta.year})` : 'Loading the reel…';
      $('takeLine').textContent = 'Pinch the clapperboard and the film rolls.';
      $('takeMeta').innerHTML = meta ? `${fmt(meta.duration)}` : '';
      return;
    }
    const tracker = new CueTracker(meta.cues);
    for (const e of take.events) tracker.register(e);
    $('takeTitle').textContent = `${label}: ${tracker.hits} of ${tracker.total} cues hit.${label === 'Shared take' ? ' Your turn.' : ''}`;
    for (const s of tracker.states) {
      const li = document.createElement('li');
      if (!s.hit) li.className = 'miss';
      hits.appendChild(li);
    }
    $('takeLine').textContent = directorLine(tracker);
    const scripted = label === 'Sample take' ? '<span class="sep"> · </span>scripted from the cue sheet' : '';
    $('takeMeta').innerHTML = `${meta.title} (${meta.year})<span class="sep"> · </span>${fmt(meta.duration)}${scripted}`;
  };

  const selectClip = async (id: string) => {
    for (const c of chips) c.setAttribute('aria-pressed', String(c.dataset.clip === id));
    [clip, demo] = await Promise.all([engine.loadClip(id), loadDemoTake(id)]);
    if (shared && shared.clipId === id) demo = shared;
    showResult(demo, clip, shared && demo === shared ? 'Shared take' : 'Sample take');
    playTake.hidden = !demo;
    play.hidden = !demo;
    copyLink.hidden = !(shared && demo === shared);
  };

  copyLink.addEventListener('click', () => {
    void navigator.clipboard?.writeText(location.href).then(
      () => (copyLink.textContent = 'Link copied'),
      () => (copyLink.textContent = 'Copy the address bar'),
    );
  });

  chips.forEach((c) => c.addEventListener('click', () => void selectClip(c.dataset.clip!)));

  enter.addEventListener('click', () => {
    void ensureAudio(); // the click is the gesture that lets the audio graph start
    engine.launchXR();
  });
  play.addEventListener('click', () => {
    if (demo) void engine.playTake(demo);
    else void engine.startTake();
    document.getElementById('top')?.scrollIntoView({ behavior: 'smooth' });
  });
  playTake.addEventListener('click', () => {
    if (demo) void engine.playTake(demo);
  });

  engine.onTakeEnd((take, _summary, line) => {
    demo = take;
    showResult(take, clip, 'Your take');
    if (line) $('takeLine').textContent = line;
    playTake.hidden = false;
    // the take's code goes into the address, so the link replays it anywhere
    history.replaceState(null, '', `#take=${encodeTake(take)}`);
    copyLink.textContent = 'Copy link';
    copyLink.hidden = false;
  });

  void engine.xrSupported().then((ok) => {
    if (ok && state !== 'noxr') return;
    enter.textContent = 'Open on your Quest';
    enter.addEventListener('click', () => {
      void navigator.clipboard?.writeText(location.origin + location.pathname);
      note.hidden = false;
      note.innerHTML = `Open <code>${location.host}${location.pathname}</code> in the Quest browser. (Copied.)`;
    });
    note.hidden = false;
    note.innerHTML = `This browser can't open VR. Open <code>${location.host}${location.pathname}</code> in the Quest browser, or play with your mouse.`;
  });

  // the glove points at the coconuts; it follows the prop as the stage is placed or the window resizes
  const hand = $<SVGSVGElement & HTMLElement>('hand');
  const halo = $<SVGLineElement & HTMLElement>('rayHalo');
  const dots = $<SVGLineElement & HTMLElement>('rayDots');
  const aim = () => {
    const p = engine.screenPositionOf('coconuts');
    if (!p || innerWidth < 900) {
      hand.style.opacity = '0';
      halo.setAttribute('x2', '0');
      dots.setAttribute('x2', '0');
      return;
    }
    hand.style.opacity = '1';
    // the glove comes in from the bottom right; its fingertip stops a hand's width short of the coconuts
    const from = { x: innerWidth - 60, y: innerHeight + 40 };
    const dx = p.x - from.x;
    const dy = p.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const gap = 150;
    const tip = { x: p.x - ux * gap, y: p.y - uy * gap };
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI + 90; // the SVG finger points up
    const scale = 230 / 320;
    const tipX = 128 * scale;
    const tipY = 16 * scale;
    hand.style.left = `${tip.x - tipX}px`;
    hand.style.top = `${tip.y - tipY}px`;
    hand.style.transformOrigin = `${tipX}px ${tipY}px`;
    hand.style.transform = `rotate(${angle}deg)`;
    for (const l of [halo, dots]) {
      l.setAttribute('x1', String(tip.x + ux * 10));
      l.setAttribute('y1', String(tip.y + uy * 10));
      l.setAttribute('x2', String(p.x));
      l.setAttribute('y2', String(p.y));
    }
  };
  const loop = () => {
    if (!document.body.classList.contains('in-xr')) aim();
    requestAnimationFrame(loop);
  };
  loop();

  // on a phone the stage sits in the gap the spacer leaves under the headline
  const scene = document.getElementById('scene-container')!;
  const spacer = document.querySelector<HTMLElement>('.spacer')!;
  const layout = () => {
    if (innerWidth <= 900) {
      scene.style.top = `${spacer.offsetTop}px`;
      scene.style.height = `${spacer.offsetHeight}px`;
    } else {
      scene.style.top = '';
      scene.style.height = '';
    }
  };
  addEventListener('resize', layout);
  layout();
  setTimeout(layout, 300);

  void selectClip(shared?.clipId ?? params.get('clip') ?? 'one-week');
}
