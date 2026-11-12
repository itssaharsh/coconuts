// The Serial's page. The hero says what it is and puts the theatre on your desk; without a headset the stage beside it
// plays with the mouse and the keys. A status chip follows the Serial, and while a reel plays the copy steps back and the
// house lights go down across the page, so the stage is the page. An optional switch asks for the microphone, so the
// player can pitch the next reel by voice through the megaphone between reels.
import './serial.css';
import { ensureAudio } from '../foley/sound';
import { enableVoice, hearingOn, voiceSupported, voiceWanted } from '../foley/voice';
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
  // Into the headset. The first time, where speech can be heard, one question comes first: may the Director hear you?
  // (Inside the headset view the browser cannot ask, so a player who was never asked would find the megaphone dead.)
  const ask = byId<HTMLDivElement>('s-ask');
  const askYes = byId<HTMLButtonElement>('s-ask-yes');
  const askNo = byId<HTMLButtonElement>('s-ask-no');
  let hearing = false;
  void hearingOn().then((ok) => (hearing = ok));
  const answered = (): boolean => {
    try {
      return voiceWanted() || localStorage.getItem('coconuts.voiceAsk') !== null;
    } catch {
      return true;
    }
  };
  const remember = (v: 'yes' | 'no'): void => {
    try {
      localStorage.setItem('coconuts.voiceAsk', v);
    } catch {
      // private mode: asked again next visit
    }
  };
  const go = (hint = 'The headset view did not open. Allow it if the browser asks, then press Enter again.', after = 6000): void => {
    engine.launchXR();
    // a session that never starts (a refused prompt, a headset that is busy, a click the browser no longer counts) says so
    setTimeout(() => {
      if (xrOk && !document.body.classList.contains('in-xr')) note.textContent = hint;
    }, after);
  };
  enter.addEventListener('click', () => {
    void ensureAudio(); // the click is the gesture that lets the audio graph start
    if (xrOk && ask && ask.hidden && hearing && voiceSupported() && !answered()) {
      ask.hidden = false;
      askYes?.focus();
      return;
    }
    if (ask) ask.hidden = true; // Enter pressed again with the question open: sounds only, and in we go
    go();
  });
  askNo?.addEventListener('click', () => {
    remember('no');
    if (ask) ask.hidden = true;
    go();
  });
  askYes?.addEventListener('click', () => {
    if (askYes.getAttribute('aria-busy') === 'true') return;
    askYes.setAttribute('aria-busy', 'true');
    void enableVoice().then((ok) => {
      askYes.removeAttribute('aria-busy');
      remember(ok ? 'yes' : 'no');
      if (ask) ask.hidden = true;
      const label = byId<HTMLSpanElement>('s-voice-label');
      const btn = byId<HTMLButtonElement>('s-voice-btn');
      if (label && btn) {
        btn.dataset.on = String(ok);
        label.textContent = ok ? 'Voice is on' : 'No microphone';
      }
      // the browser's own prompt may have outlived the click: if the headset view does not open, one more press does it
      go(ok ? 'The microphone is on. Press Enter once more.' : 'No microphone: sounds only. Press Enter once more.', 2500);
    });
  });
  // a story already under way in this browser: the clapper will go on with it. On a headset that is passed round, the
  // next player wants reel one, so the page says what is waiting and offers the beginning.
  const resume = byId<HTMLParagraphElement>('s-resume');
  const resumeLine = byId<HTMLSpanElement>('s-resume-line');
  const resumeBtn = byId<HTMLButtonElement>('s-resume-btn');
  if (resume && resumeLine && resumeBtn) {
    let done = 0;
    try {
      const saved = JSON.parse(localStorage.getItem('coconuts.serial') ?? 'null') as { v?: number; done?: number; story?: unknown[] } | null;
      if (saved && saved.v === 1 && Array.isArray(saved.story) && saved.story.length) done = Number(saved.done) || 0;
    } catch {
      done = 0;
    }
    if (done >= 1) {
      resumeLine.textContent = `A story is under way here: reel ${done + 1} is next.`;
      resume.hidden = false;
      resumeBtn.addEventListener('click', () => {
        try {
          localStorage.removeItem('coconuts.serial');
        } catch {
          // nothing was kept
        }
        location.reload();
      });
    }
  }

  let xrOk = false;
  const say = (before: string, after: string) => {
    const where = document.createElement('code');
    where.textContent = `${location.host}${location.pathname}`;
    note.replaceChildren(before, where, after);
  };
  void engine.xrSupported().then((ok) => {
    xrOk = ok && params.get('state') !== 'noxr';
    if (xrOk) return;
    enter.textContent = 'Open on your Quest';
    enter.addEventListener('click', () => {
      void navigator.clipboard?.writeText(location.origin + location.pathname);
      say('Open ', ' in the Quest browser. (Copied.)');
    });
    say('This browser can’t open VR. Open ', ' in the Quest browser, or play it right here.');
  });

  // pitch by voice: optional; the microphone prompt comes from this click, on the page, before the headset view
  const voice = byId<HTMLDivElement>('s-voice');
  const voiceBtn = byId<HTMLButtonElement>('s-voice-btn');
  const voiceLabel = byId<HTMLSpanElement>('s-voice-label');
  if (voice && voiceBtn && voiceLabel) {
    if (!voiceSupported()) voice.hidden = true;
    else void hearingOn().then((ok) => (voice.hidden = !ok));
    voiceBtn.addEventListener('click', () => {
      if (voiceBtn.dataset.on === 'true' || voiceBtn.getAttribute('aria-busy') === 'true') return;
      voiceBtn.setAttribute('aria-busy', 'true');
      void enableVoice().then((ok) => {
        voiceBtn.removeAttribute('aria-busy');
        voiceBtn.dataset.on = String(ok);
        voiceLabel.textContent = ok ? 'Voice is on' : 'No microphone';
      });
    });
  }

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
  // a window changing size (or a media query flipping) should not play the house-lights move
  let still = 0;
  addEventListener('resize', () => {
    document.body.classList.add('s-resizing');
    clearTimeout(still);
    still = window.setTimeout(() => document.body.classList.remove('s-resizing'), 300);
    layout();
  });
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
