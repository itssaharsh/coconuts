// The cue lane: cards slide along a rail under the screen toward the "now" line; a landed cue lights up.
import { CanvasTexture, Group, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace } from 'three';
import type { CueState, CueTracker } from './cues';
import type { PropId } from './types';

const CARD_W = 0.11;
const CARD_H = 0.07;
const LANE_W = 0.8;
const SECONDS_ACROSS = 6; // seconds of film shown from the right edge to the now line
const NOW_X = -LANE_W / 2 + 0.12; // the now line sits near the left end

const COLORS = { paper: '#FFFDF8', ink: '#2B2320', muted: '#8A7A66', accent: '#3F8FD6', hit: '#E9F6EC', hitInk: '#256B42' };

function glyph(g: CanvasRenderingContext2D, prop: PropId, x: number, y: number, s: number, color: string): void {
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineWidth = s * 0.12;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  switch (prop) {
    case 'coconuts':
      g.arc(x - s * 0.3, y + s * 0.1, s * 0.28, Math.PI, 0);
      g.moveTo(x + s * 0.62, y + s * 0.1);
      g.arc(x + s * 0.34, y + s * 0.1, s * 0.28, 0, Math.PI, true);
      g.stroke();
      break;
    case 'door':
      g.rect(x - s * 0.3, y - s * 0.4, s * 0.6, s * 0.8);
      g.stroke();
      g.beginPath();
      g.arc(x + s * 0.15, y + s * 0.05, s * 0.05, 0, Math.PI * 2);
      g.fill();
      break;
    case 'bell':
      g.arc(x, y + s * 0.15, s * 0.36, Math.PI, 0);
      g.lineTo(x + s * 0.36, y + s * 0.15);
      g.lineTo(x - s * 0.36, y + s * 0.15);
      g.stroke();
      g.beginPath();
      g.arc(x, y - s * 0.26, s * 0.06, 0, Math.PI * 2);
      g.fill();
      break;
    case 'thunder':
      g.moveTo(x + s * 0.1, y - s * 0.42);
      g.lineTo(x - s * 0.18, y + s * 0.02);
      g.lineTo(x + s * 0.06, y + s * 0.02);
      g.lineTo(x - s * 0.1, y + s * 0.42);
      g.stroke();
      break;
    case 'whistle':
      g.moveTo(x - s * 0.38, y - s * 0.3);
      g.lineTo(x + s * 0.38, y + s * 0.3);
      g.stroke();
      g.beginPath();
      g.arc(x + s * 0.38, y + s * 0.3, s * 0.1, 0, Math.PI * 2);
      g.fill();
      break;
    case 'glass':
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        g.moveTo(x, y);
        g.lineTo(x + Math.cos(a) * s * 0.4, y + Math.sin(a) * s * 0.4);
      }
      g.stroke();
      break;
  }
}

function cardTexture(state: CueState, lit: boolean): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 352;
  c.height = 224;
  const g = c.getContext('2d')!;
  g.fillStyle = lit ? COLORS.hit : COLORS.paper;
  g.beginPath();
  g.roundRect(4, 4, c.width - 8, c.height - 8, 28);
  g.fill();
  g.strokeStyle = lit ? COLORS.hitInk : '#E1D6C4';
  g.lineWidth = lit ? 10 : 6;
  g.stroke();
  glyph(g, state.cue.prop, 72, 100, 90, lit ? COLORS.hitInk : COLORS.ink);
  g.fillStyle = lit ? COLORS.hitInk : COLORS.ink;
  g.font = '600 40px Instrument Sans, system-ui, sans-serif';
  g.textBaseline = 'middle';
  const words = state.cue.label.split(' ');
  const line1 = words.slice(0, 2).join(' ');
  const line2 = words.slice(2).join(' ');
  g.fillText(line1, 132, line2 ? 80 : 100, 200);
  if (line2) g.fillText(line2, 132, 128, 200);
  g.fillStyle = COLORS.muted;
  g.font = '500 28px Instrument Sans, system-ui, sans-serif';
  g.fillText(lit ? 'hit' : `${state.cue.t.toFixed(0)}s`, 132, 180);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

export class Lane {
  readonly group = new Group();
  private cards = new Map<CueState, { mesh: Mesh; lit: boolean }>();
  private tracker: CueTracker | null = null;
  private summaryMesh: Mesh | null = null;

  constructor() {
    this.group.name = 'lane';
    const rail = new Mesh(new PlaneGeometry(LANE_W, 0.004), new MeshBasicMaterial({ color: 0xc9b08a }));
    rail.position.y = -CARD_H / 2 - 0.01;
    this.group.add(rail);
    const now = new Mesh(new PlaneGeometry(0.006, CARD_H + 0.04), new MeshBasicMaterial({ color: 0x3f8fd6 }));
    now.position.set(NOW_X, 0, 0.002);
    now.name = 'now';
    this.group.add(now);
  }

  setTracker(tracker: CueTracker | null): void {
    for (const c of this.cards.values()) {
      this.group.remove(c.mesh);
      (c.mesh.material as MeshBasicMaterial).map?.dispose();
    }
    this.cards.clear();
    this.tracker = tracker;
  }

  private cardFor(state: CueState): { mesh: Mesh; lit: boolean } {
    let c = this.cards.get(state);
    if (!c) {
      const mesh = new Mesh(new PlaneGeometry(CARD_W, CARD_H), new MeshBasicMaterial({ map: cardTexture(state, false), transparent: true }));
      mesh.name = `cue-${state.cue.t}`;
      this.group.add(mesh);
      c = { mesh, lit: false };
      this.cards.set(state, c);
    }
    if (state.hit && !c.lit) {
      (c.mesh.material as MeshBasicMaterial).map = cardTexture(state, true);
      c.lit = true;
    }
    return c;
  }

  /** Slide the cards: a cue at time t sits at the now line when the film reaches t. */
  update(filmTime: number): void {
    if (!this.tracker) return;
    const visible = new Set(this.tracker.upcoming(filmTime, SECONDS_ACROSS + 1, 1.5));
    for (const [state, c] of this.cards) {
      if (!visible.has(state)) {
        this.group.remove(c.mesh);
        this.cards.delete(state);
      }
    }
    const perSecond = (LANE_W - 0.12 - CARD_W) / SECONDS_ACROSS;
    for (const state of visible) {
      const c = this.cardFor(state);
      const dt = state.cue.t - filmTime;
      c.mesh.position.x = NOW_X + dt * perSecond;
      c.mesh.position.y = 0;
      c.mesh.position.z = 0.001;
      const edge = Math.min(1, Math.max(0, (LANE_W / 2 - Math.abs(c.mesh.position.x) + CARD_W / 2) / CARD_W));
      (c.mesh.material as MeshBasicMaterial).opacity = edge;
      const lift = dt < 0.1 && dt > -0.6 ? (state.hit ? 0.012 : 0.004) : 0;
      c.mesh.scale.setScalar(1 + lift * 8);
    }
  }
}
