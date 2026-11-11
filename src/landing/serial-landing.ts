// The Serial's page. The hero says what it is and puts the theatre on your desk; without a headset the stage beside it
// plays with the mouse and the keys. A status chip follows the Serial, and while a reel plays the copy steps back and the
// house lights go down across the page, so the stage is the page.
import './serial.css';
import { ensureAudio } from '../foley/sound';
import { followSerial } from './framing';
import type { EngineBridge } from './landing';

type Phase = 'loading' | 'ready' | 'playing' | 'pitch' | 'writing' | 'next';

const STATUS: Record<Phase, string> = {
  loading: 'Loading the theatre…',
  ready: 'Ready: tap the clapper or press Space',
  playing: 'A reel is rolling: make the sound the stage waits for',
  pitch: 'What happens next? Make a sound to choose',
  writing: 'The Director is writing the next reel…',
  next: 'Loading the next reel…',
};

function phaseOf(state: string | null, rolled: boolean): Phase {
  switch (state) {
    case 'ready':
    case 'playing':
    case 'pitch':
    case 'writing':
      return state;
    default:
      return rolled ? 'next' : 'loading';
  }
}

export function mountSerialLanding(engine: EngineBridge): void {
  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
  const enter = byId<HTMLButtonElement>('s-enter');
  const note = byId<HTMLParagraphElement>('s-note');
  const status = byId<HTMLParagraphElement>('status');
  const statusText = byId<HTMLSpanElement>('status-text');
  const scene = byId<HTMLDivElement>('scene-container');
  const slot = document.querySelector<HTMLElement>('.s-stage');
  const hero = document.querySelector<HTMLElement>('.s-hero');
  if (!enter || !note || !status || !statusText || !scene || !slot || !hero) return;
  const params = new URLSearchParams(location.search);

  // the button: into the headset where WebXR is there; elsewhere it says where to open the page
  enter.addEventListener('click', () => {
    void ensureAudio(); // the click is the gesture that lets the audio graph start
    engine.launchXR();
  });
  const say = (before: string, after: string) => {
    const where = document.createElement('code');
    where.textContent = `${location.host}${location.pathname}`;
    note.replaceChildren(before, where, after);
  };
  void engine.xrSupported().then((ok) => {
    if (ok && params.get('state') !== 'noxr') return;
    enter.textContent = 'Open on your Quest';
    enter.addEventListener('click', () => {
      void navigator.clipboard?.writeText(location.origin + location.pathname);
      say('Open ', ' in the Quest browser. (Copied.)');
    });
    say('This browser can’t open VR. Open ', ' in the Quest browser, or play it right here.');
  });

  // the keys on the page dip when the same key plays a prop (the engine does the playing)
  const caps = new Map<string, HTMLElement>();
  document.querySelectorAll<HTMLElement>('.s-keys kbd[data-key]').forEach((k) => caps.set(k.dataset.key ?? '', k));
  addEventListener('keydown', (e) => {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (tag === 'BUTTON' && (e.key === ' ' || e.key === 'Enter'))) return;
    const cap = caps.get(e.key === 'Enter' ? ' ' : e.key.toLowerCase());
    if (!cap) return;
    cap.classList.add('down');
    setTimeout(() => cap.classList.remove('down'), 170);
  });

  // on a phone the stage fills the window the copy leaves under the button; on wide screens the stylesheet places it
  const narrow = matchMedia('(max-width: 900px)');
  const layout = () => {
    if (narrow.matches) {
      const r = slot.getBoundingClientRect();
      scene.style.top = `${Math.round(r.top + scrollY)}px`;
      scene.style.height = `${Math.round(r.height)}px`;
    } else {
      scene.style.top = '';
      scene.style.height = '';
    }
  };
  addEventListener('resize', layout);
  new ResizeObserver(layout).observe(hero);
  void document.fonts?.ready.then(layout);
  layout();

  // the status chip follows the Serial; a reel on stage takes the page, and the camera follows the stage's window
  let phase: Phase | null = null;
  let rolled = false;
  let last = performance.now();
  const tick = (now: number) => {
    const state = engine.serialState();
    if (state === 'playing') rolled = true;
    const p = phaseOf(state, rolled);
    if (p !== phase) {
      phase = p;
      statusText.textContent = STATUS[p];
      status.dataset.state = p;
      document.body.classList.toggle('reel-on', p !== 'ready' && p !== 'loading');
    }
    if (!document.body.classList.contains('in-xr')) followSerial((now - last) / 1000, document.body.classList.contains('reel-on'));
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
