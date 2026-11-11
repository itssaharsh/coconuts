// Canvas-drawn cards for the theatre: intertitles, the cue card, the question card, emotes and sound words.
import { CanvasTexture, SRGBColorSpace } from 'three';
import type { PropId } from '../foley/types';

const TITLE_FONT = '"Limelight", "Playfair Display", Georgia, "Times New Roman", serif';
const BODY_FONT = '"Instrument Sans", system-ui, sans-serif';

function texture(c: HTMLCanvasElement): CanvasTexture {
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

function fit(g: CanvasRenderingContext2D, text: string, maxWidth: number, size: number, font: string, weight = '400'): number {
  let s = size;
  for (; s > 18; s -= 4) {
    g.font = `${weight} ${s}px ${font}`;
    if (g.measureText(text).width <= maxWidth) break;
  }
  return s;
}

function wrap(g: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (g.measureText(t).width > maxWidth && cur) {
      lines.push(cur);
      cur = w;
    } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** A silent-film intertitle: white type on black with a thin ornamental border. 16:9. */
export function titleCard(text: string, sub = ''): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1280;
  c.height = 720;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0d0b09';
  g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = '#e9dfc9';
  g.lineWidth = 5;
  g.strokeRect(34, 34, c.width - 68, c.height - 68);
  g.lineWidth = 2;
  g.strokeRect(50, 50, c.width - 100, c.height - 100);
  // corner ornaments
  for (const [x, y] of [[50, 50], [c.width - 50, 50], [50, c.height - 50], [c.width - 50, c.height - 50]]) {
    g.beginPath();
    g.arc(x, y, 16, 0, Math.PI * 2);
    g.fillStyle = '#0d0b09';
    g.fill();
    g.stroke();
  }
  g.fillStyle = '#f4ecd8';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `400 104px ${TITLE_FONT}`;
  let lines = wrap(g, text.toUpperCase(), c.width - 220);
  let size = 104;
  if (lines.length > 2) {
    size = 84;
    g.font = `400 ${size}px ${TITLE_FONT}`;
    lines = wrap(g, text.toUpperCase(), c.width - 200);
  }
  const lh = size * 1.18;
  const block = lines.length * lh + (sub ? 70 : 0);
  let y = c.height / 2 - block / 2 + lh / 2;
  for (const l of lines) {
    g.fillText(l, c.width / 2, y);
    y += lh;
  }
  if (sub) {
    g.fillStyle = '#c9bda0';
    g.font = `500 40px ${BODY_FONT}`;
    g.fillText(sub, c.width / 2, y + 14);
  }
  return texture(c);
}

/** Pictogram of a prop, the same drawings the lane uses. */
export function drawGlyph(g: CanvasRenderingContext2D, prop: PropId, x: number, y: number, s: number, color: string): void {
  g.save();
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineWidth = s * 0.11;
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
  g.restore();
}

/** The cue card: which prop the scene is waiting for, and the action it will sound. */
export function cueCard(prop: PropId | null, label: string): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 768;
  c.height = 192;
  const g = c.getContext('2d')!;
  g.fillStyle = '#FFFDF8';
  g.beginPath();
  g.roundRect(6, 6, c.width - 12, c.height - 12, 44);
  g.fill();
  g.strokeStyle = '#3F8FD6';
  g.lineWidth = 10;
  g.stroke();
  let x = 60;
  if (prop) {
    drawGlyph(g, prop, 104, 96, 110, '#2B2320');
    x = 196;
  }
  g.fillStyle = '#2B2320';
  g.textBaseline = 'middle';
  const size = fit(g, label, c.width - x - 50, 64, BODY_FONT, '700');
  g.font = `700 ${size}px ${BODY_FONT}`;
  g.fillText(label, x, 100);
  return texture(c);
}

const WORDS: Record<PropId, string> = { coconuts: 'CLOP!', door: 'KNOCK!', bell: 'DING!', thunder: 'RUMBLE!', whistle: 'WHEEE!', glass: 'CRASH!' };
export const soundWordFor = (prop: PropId, kind?: string): string => (prop === 'door' && kind === 'slam' ? 'SLAM!' : WORDS[prop]);

/** A comic sound word, so every sound is also seen. */
export function wordCard(word: string): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 192;
  const g = c.getContext('2d')!;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `400 120px ${TITLE_FONT}`;
  g.lineWidth = 16;
  g.lineJoin = 'round';
  g.strokeStyle = '#2B2320';
  g.strokeText(word, 256, 100);
  g.fillStyle = '#F2C14E';
  g.fillText(word, 256, 100);
  return texture(c);
}

const EMOTE_TEXT: Record<string, string> = { '!': '!', '?': '?', zzz: 'Zzz', heart: '♥', skull: '☠', note: '♪', angry: '#!', sweat: '’’', idea: '✦' };

export function emoteCard(emote: string): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 160;
  const g = c.getContext('2d')!;
  g.fillStyle = '#FFFDF8';
  g.beginPath();
  g.arc(80, 74, 66, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.moveTo(58, 128);
  g.lineTo(80, 158);
  g.lineTo(102, 128);
  g.fill();
  g.fillStyle = emote === 'heart' ? '#C9573A' : '#2B2320';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const t = EMOTE_TEXT[emote] ?? emote;
  g.font = `700 ${t.length > 1 ? 58 : 96}px ${BODY_FONT}`;
  g.fillText(t, 80, 78);
  return texture(c);
}

/** The curtain's velvet: vertical pleats drawn as soft stripes. */
export function curtainTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 64;
  const g = c.getContext('2d')!;
  for (let x = 0; x < c.width; x++) {
    const u = (x / c.width) * 9 * Math.PI * 2;
    const v = 0.5 + 0.5 * Math.sin(u);
    const r = Math.round(92 + 86 * v);
    const gg = Math.round(14 + 22 * v);
    const b = Math.round(16 + 20 * v);
    g.fillStyle = `rgb(${r},${gg},${b})`;
    g.fillRect(x, 0, 1, c.height);
  }
  // gold hem
  g.fillStyle = '#b8892f';
  g.fillRect(0, c.height - 5, c.width, 5);
  return texture(c);
}

/** The painted sky behind the set. */
export function backdropTexture(kind: 'night' | 'day' | 'dusk' | 'storm' | 'dark'): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 320;
  const g = c.getContext('2d')!;
  const stops: Record<string, [string, string, string]> = {
    night: ['#0b1230', '#1b2a5c', '#3a4a86'],
    day: ['#8fc3ee', '#c9e3f6', '#f4ead2'],
    dusk: ['#3b2a5a', '#b05a52', '#f0b267'],
    storm: ['#15181f', '#2c323d', '#4a505b'],
    dark: ['#07070a', '#0d0d12', '#15151c'],
  };
  const [a, b, d] = stops[kind];
  const grad = g.createLinearGradient(0, 0, 0, c.height);
  grad.addColorStop(0, a);
  grad.addColorStop(0.6, b);
  grad.addColorStop(1, d);
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);
  if (kind === 'night' || kind === 'dusk') {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    g.fillStyle = 'rgba(255,255,240,0.9)';
    for (let i = 0; i < (kind === 'night' ? 70 : 18); i++) {
      const r = rnd() * 1.4 + 0.4;
      g.beginPath();
      g.arc(rnd() * c.width, rnd() * c.height * 0.6, r, 0, Math.PI * 2);
      g.fill();
    }
    if (kind === 'night') {
      g.fillStyle = '#f5f0d8';
      g.beginPath();
      g.arc(150, 96, 22, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#131d47';
      g.beginPath();
      g.arc(160, 89, 20, 0, Math.PI * 2);
      g.fill();
    }
  }
  return texture(c);
}

/** The pelmet that hangs across the top of the opening: scalloped velvet with a gold fringe (alpha below the scallops). */
export function valanceTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, c.width, c.height);
  const scallops = 7;
  const w = c.width / scallops;
  for (let i = 0; i < scallops; i++) {
    const x0 = i * w;
    // velvet folds
    const grad = g.createLinearGradient(x0, 0, x0 + w, 0);
    grad.addColorStop(0, '#5a0d12');
    grad.addColorStop(0.5, '#b01c22');
    grad.addColorStop(1, '#5a0d12');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(x0, 0);
    g.lineTo(x0 + w, 0);
    g.lineTo(x0 + w, 58);
    g.quadraticCurveTo(x0 + w / 2, 150, x0, 58);
    g.closePath();
    g.fill();
    // gold fringe along the curve
    g.strokeStyle = '#d2a13c';
    g.lineWidth = 7;
    g.beginPath();
    g.moveTo(x0 + w, 58);
    g.quadraticCurveTo(x0 + w / 2, 150, x0, 58);
    g.stroke();
  }
  // a darker band under the top rail
  const shade = g.createLinearGradient(0, 0, 0, 30);
  shade.addColorStop(0, 'rgba(0,0,0,0.55)');
  shade.addColorStop(1, 'rgba(0,0,0,0)');
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = shade;
  g.fillRect(0, 0, c.width, 30);
  g.globalCompositeOperation = 'source-over';
  return texture(c);
}

/** A soft round glow for torches, candles and the moon's halo. */
export function glowTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.14)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return texture(c);
}

/** The road under the horse: grass with a dirt track along it, tileable along x. */
export function roadTexture(theme: 'road' | 'forest' | 'village'): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const g = c.getContext('2d')!;
  const grass = theme === 'forest' ? '#4f7a3a' : theme === 'village' ? '#8fae4e' : '#86a84a';
  const dirt = theme === 'forest' ? '#8a6a44' : '#c9a36b';
  g.fillStyle = grass;
  g.fillRect(0, 0, c.width, c.height);
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // tufts (wrap in x so the strip tiles)
  for (let i = 0; i < 260; i++) {
    const x = rnd() * c.width;
    const y = rnd() * c.height;
    g.fillStyle = rnd() > 0.5 ? 'rgba(255,255,220,0.10)' : 'rgba(20,50,10,0.16)';
    const w = 6 + rnd() * 16;
    g.fillRect(x, y, w, 3);
    if (x + w > c.width) g.fillRect(x - c.width, y, w, 3);
  }
  // the track: v 0.58..0.86 of the strip (toward the audience)
  const y0 = c.height * 0.55;
  const y1 = c.height * 0.86;
  g.fillStyle = dirt;
  g.fillRect(0, y0, c.width, y1 - y0);
  g.fillStyle = 'rgba(0,0,0,0.10)';
  g.fillRect(0, y0, c.width, 5);
  g.fillRect(0, y1 - 5, c.width, 5);
  for (let i = 0; i < 90; i++) {
    const x = rnd() * c.width;
    const y = y0 + 8 + rnd() * (y1 - y0 - 16);
    g.fillStyle = rnd() > 0.5 ? 'rgba(255,240,210,0.16)' : 'rgba(70,40,10,0.16)';
    const w = 8 + rnd() * 26;
    g.fillRect(x, y, w, 3);
    if (x + w > c.width) g.fillRect(x - c.width, y, w, 3);
  }
  return texture(c);
}

/** A far line of hills, tileable along x, transparent above the ridge. */
export function hillsTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, c.width, c.height);
  const ridge = (x: number, f: number, a: number, base: number) =>
    base - a * (0.5 + 0.5 * Math.sin((x / c.width) * Math.PI * 2 * f)) - a * 0.4 * (0.5 + 0.5 * Math.sin((x / c.width) * Math.PI * 2 * (f * 2 + 1) + 1.3));
  for (const [f, a, base, col] of [
    [2, 46, 96, '#3d5a55'],
    [3, 34, 112, '#2f4a3c'],
  ] as const) {
    g.fillStyle = col;
    g.beginPath();
    g.moveTo(0, c.height);
    for (let x = 0; x <= c.width; x += 8) g.lineTo(x, ridge(x, f, a, base));
    g.lineTo(c.width, c.height);
    g.closePath();
    g.fill();
  }
  return texture(c);
}
