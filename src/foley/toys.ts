// Primitive builders for the table and the props (Blender GLBs replace them in T11 behind the same functions).
import {
  BoxGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  SphereGeometry,
  TorusGeometry,
} from 'three';
import type { PropId } from './types';

export const TABLE_W = 0.7;
export const TABLE_D = 0.4;
export const TABLE_H = 0.015;
const HIT_BOX = 0.09;

export const PALETTE = {
  beech: '#EAD9B9',
  beechLight: '#F4E8D2',
  beechDark: '#C9B08A',
  walnut: '#3B2A20',
  ink: '#2B2320',
  coconut: '#6B4A2B',
  cream: '#F3E9D8',
  red: '#C9573A',
  brass: '#D9A441',
  steel: '#B8BEC4',
  kraft: '#C9A06A',
  glass: '#BFE3F2',
  curtain: '#A8322A',
  accent: '#3F8FD6',
  plank: '#D8B98A',
} as const;

const mats = new Map<string, MeshStandardMaterial>();
export function mat(hex: string, roughness = 0.7, metalness = 0): MeshStandardMaterial {
  const key = `${hex}:${roughness}:${metalness}`;
  let m = mats.get(key);
  if (!m) {
    m = new MeshStandardMaterial({ color: new Color(hex), roughness, metalness });
    mats.set(key, m);
  }
  return m;
}

/** An invisible box the ray can hit: bigger than the thing, so a shaky pinch still lands. */
function hitBox(size = HIT_BOX, height = size, depth = size, name = 'hit'): Mesh {
  const m = new Mesh(
    new BoxGeometry(size, height, depth),
    new MeshBasicMaterial({ colorWrite: false, depthWrite: false, transparent: true, opacity: 0 }),
  );
  m.position.y = height / 2;
  m.name = name;
  return m;
}

/** Gives every hit box under a prop a name the emulator and tests can target: hit-<prop id>. */
export function nameHitBoxes(root: Group): void {
  const id = root.name.replace(/^prop-/, '');
  root.traverse((o) => {
    if (o.name === 'hit') o.name = `hit-${id}`;
  });
}

function ring(radius: number, hex: string = PALETTE.beechDark): Mesh {
  const m = new Mesh(new TorusGeometry(radius, 0.004, 10, 36), mat(hex, 0.6));
  m.rotation.x = Math.PI / 2;
  m.position.y = 0.004;
  m.name = 'ring';
  return m;
}

let glowTex: CanvasTexture | null = null;
function glowTexture(): CanvasTexture {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,233,168,0.85)');
  grd.addColorStop(0.55, 'rgba(255,233,168,0.25)');
  grd.addColorStop(1, 'rgba(255,233,168,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  glowTex = new CanvasTexture(c);
  return glowTex;
}

function lampPool(size = 0.12): Mesh {
  const m = new Mesh(
    new PlaneGeometry(size, size),
    new MeshBasicMaterial({ map: glowTexture(), transparent: true, depthWrite: false, opacity: 0 }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.0025;
  m.name = 'lamp';
  m.renderOrder = 1;
  return m;
}

export function buildTable(): Group {
  const g = new Group();
  g.name = 'table';
  const top = new Mesh(new BoxGeometry(TABLE_W, TABLE_H, TABLE_D), mat(PALETTE.beech, 0.75));
  top.position.y = TABLE_H / 2;
  top.receiveShadow = true;
  top.name = 'top';
  g.add(top);
  const rail = new Mesh(new BoxGeometry(TABLE_W, 0.03, 0.02), mat(PALETTE.beechLight, 0.7));
  rail.position.set(0, TABLE_H + 0.015, -TABLE_D / 2 + 0.01);
  g.add(rail);
  return g;
}

function coconutHalf(): Mesh {
  const geo = new SphereGeometry(0.04, 20, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  const m = new Mesh(geo, mat(PALETTE.coconut, 0.9));
  m.rotation.x = Math.PI; // bowl up
  m.position.y = 0.04;
  return m;
}

export function buildProp(id: PropId): Group {
  const g = new Group();
  g.name = `prop-${id}`;
  switch (id) {
    case 'coconuts': {
      const a = coconutHalf();
      a.position.x = -0.045;
      const b = coconutHalf();
      b.position.x = 0.045;
      a.castShadow = b.castShadow = true;
      g.add(a, b);
      g.add(ring(0.075));
      g.add(lampPool(0.2));
      g.add(hitBox(0.16, 0.1, 0.12));
      break;
    }
    case 'door': {
      const base = new Mesh(new BoxGeometry(0.11, 0.01, 0.05), mat(PALETTE.walnut, 0.7));
      base.position.y = 0.005;
      g.add(base);
      const postGeo = new BoxGeometry(0.012, 0.14, 0.012);
      for (const dx of [-0.045, 0.045]) {
        const p = new Mesh(postGeo, mat(PALETTE.plank, 0.7));
        p.position.set(dx, 0.08, 0);
        g.add(p);
      }
      const lintel = new Mesh(new BoxGeometry(0.102, 0.012, 0.012), mat(PALETTE.plank, 0.7));
      lintel.position.set(0, 0.146, 0);
      g.add(lintel);
      const leaf = new Group();
      leaf.name = 'Leaf';
      leaf.position.set(-0.039, 0.01, 0);
      const panel = new Mesh(new BoxGeometry(0.078, 0.13, 0.008), mat(PALETTE.red, 0.6));
      panel.position.set(0.039, 0.065, 0);
      panel.castShadow = true;
      leaf.add(panel);
      const knob = new Mesh(new SphereGeometry(0.005, 10, 8), mat(PALETTE.brass, 0.4, 0.6));
      knob.position.set(0.066, 0.065, 0.007);
      leaf.add(knob);
      g.add(leaf);
      g.add(lampPool(0.18));
      g.add(hitBox(0.14, 0.17, 0.1));
      break;
    }
    case 'bell': {
      const base = new Mesh(new CylinderGeometry(0.03, 0.032, 0.008, 24), mat(PALETTE.walnut, 0.7));
      base.position.y = 0.004;
      g.add(base);
      const dome = new Mesh(new SphereGeometry(0.026, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), mat(PALETTE.brass, 0.35, 0.8));
      dome.position.y = 0.008;
      dome.castShadow = true;
      g.add(dome);
      const button = new Mesh(new CylinderGeometry(0.005, 0.005, 0.008, 12), mat(PALETTE.ink, 0.5));
      button.name = 'Button';
      button.position.y = 0.036;
      g.add(button);
      g.add(ring(0.04));
      g.add(lampPool(0.14));
      g.add(hitBox(0.1, 0.08, 0.1));
      break;
    }
    case 'thunder': {
      const postGeo = new BoxGeometry(0.01, 0.16, 0.01);
      for (const dx of [-0.05, 0.05]) {
        const p = new Mesh(postGeo, mat(PALETTE.plank, 0.7));
        p.position.set(dx, 0.08, 0);
        g.add(p);
      }
      const bar = new Mesh(new BoxGeometry(0.11, 0.01, 0.01), mat(PALETTE.plank, 0.7));
      bar.position.set(0, 0.165, 0);
      g.add(bar);
      const sheet = new Mesh(new BoxGeometry(0.08, 0.12, 0.002), mat(PALETTE.steel, 0.35, 0.6));
      sheet.name = 'Sheet';
      sheet.position.set(0, 0.1, 0);
      sheet.castShadow = true;
      g.add(sheet);
      const handle = new Mesh(new CylinderGeometry(0.006, 0.006, 0.05, 12), mat(PALETTE.walnut, 0.7));
      handle.name = 'Handle';
      handle.rotation.z = Math.PI / 2;
      handle.position.set(0, 0.035, 0);
      g.add(handle);
      g.add(lampPool(0.18));
      g.add(hitBox(0.14, 0.18, 0.1));
      break;
    }
    case 'whistle': {
      const stand = new Mesh(new BoxGeometry(0.03, 0.01, 0.03), mat(PALETTE.walnut, 0.7));
      stand.position.y = 0.005;
      g.add(stand);
      const barrel = new Mesh(new CylinderGeometry(0.008, 0.008, 0.1, 16), mat(PALETTE.plank, 0.6));
      barrel.rotation.z = Math.PI / 2;
      barrel.position.set(0, 0.02, 0);
      barrel.castShadow = true;
      g.add(barrel);
      const slide = new Group();
      slide.name = 'Slide';
      const rod = new Mesh(new CylinderGeometry(0.003, 0.003, 0.06, 10), mat(PALETTE.steel, 0.4, 0.6));
      rod.rotation.z = Math.PI / 2;
      rod.position.set(0.08, 0.02, 0);
      slide.add(rod);
      const knob = new Mesh(new SphereGeometry(0.009, 12, 10), mat(PALETTE.ink, 0.5));
      knob.position.set(0.112, 0.02, 0);
      slide.add(knob);
      g.add(slide);
      g.add(ring(0.045));
      g.add(lampPool(0.16));
      g.add(hitBox(0.2, 0.08, 0.1));
      break;
    }
    case 'glass': {
      const bag = new Mesh(new BoxGeometry(0.05, 0.06, 0.035), mat(PALETTE.kraft, 0.85));
      bag.position.y = 0.03;
      bag.rotation.y = 0.2;
      bag.castShadow = true;
      g.add(bag);
      for (const [dx, dz, r] of [
        [-0.012, 0.004, 0.4],
        [0.01, -0.006, -0.3],
        [0.0, 0.01, 0.9],
      ]) {
        const shard = new Mesh(new BoxGeometry(0.012, 0.025, 0.002), mat(PALETTE.glass, 0.2, 0.1));
        shard.position.set(dx, 0.068, dz);
        shard.rotation.set(0.1, r, 0.15);
        g.add(shard);
      }
      g.add(ring(0.04));
      g.add(lampPool(0.14));
      g.add(hitBox(0.1, 0.1, 0.1));
      break;
    }
  }
  return g;
}

export function buildClapper(): Group {
  const g = new Group();
  g.name = 'clapper';
  const slate = new Mesh(new BoxGeometry(0.09, 0.07, 0.006), mat(PALETTE.ink, 0.6));
  slate.position.y = 0.035;
  g.add(slate);
  for (const y of [0.025, 0.04, 0.055]) {
    const line = new Mesh(new BoxGeometry(0.07, 0.002, 0.0065), mat(PALETTE.cream, 0.6));
    line.position.set(0, y, 0);
    g.add(line);
  }
  const clap = new Group();
  clap.name = 'Clap';
  clap.position.set(-0.045, 0.072, 0);
  const bar = new Mesh(new BoxGeometry(0.09, 0.016, 0.006), mat(PALETTE.ink, 0.6));
  bar.position.set(0.045, 0.008, 0);
  clap.add(bar);
  for (let i = 0; i < 4; i++) {
    const stripe = new Mesh(new BoxGeometry(0.011, 0.016, 0.0065), mat(PALETTE.cream, 0.6));
    stripe.position.set(0.0115 + i * 0.0225, 0.008, 0);
    clap.add(stripe);
  }
  g.add(clap);
  g.add(ring(0.055, PALETTE.accent));
  g.add(lampPool(0.16));
  g.add(hitBox(0.12, 0.1, 0.08));
  return g;
}

/** A round painted tile on the table rim: pause, volume, redo. Its face texture carries the label. */
export function buildTile(label: string): Group {
  const g = new Group();
  g.name = `tile-${label.toLowerCase().split(' ')[0]}`;
  const base = new Mesh(new CylinderGeometry(0.026, 0.028, 0.008, 28), mat(PALETTE.beechDark, 0.7));
  base.position.y = 0.004;
  g.add(base);
  const face = new Mesh(new CylinderGeometry(0.024, 0.024, 0.002, 28), new MeshBasicMaterial({ map: tileFace(label) }));
  face.position.y = 0.009;
  face.name = 'face';
  g.add(face);
  g.add(lampPool(0.1));
  g.add(hitBox(0.08, 0.05, 0.08));
  return g;
}

function tileFace(label: string): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#F4E8D2';
  g.beginPath();
  g.arc(128, 128, 120, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#C9B08A';
  g.lineWidth = 8;
  g.stroke();
  g.fillStyle = '#2B2320';
  g.font = '700 46px "Instrument Sans", system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const words = label.split(' ');
  if (words.length > 1) {
    g.fillText(words[0], 128, 104);
    g.fillText(words.slice(1).join(' '), 128, 156);
  } else g.fillText(label, 128, 130);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

export function buildScreenFrame(w: number, h: number): Group {
  const g = new Group();
  g.name = 'screen-frame';
  const t = 0.03;
  const frameMat = mat(PALETTE.walnut, 0.6);
  const parts: [number, number, number, number][] = [
    [0, h / 2 + t / 2, w + 2 * t, t],
    [0, -h / 2 - t / 2, w + 2 * t, t],
    [-w / 2 - t / 2, 0, t, h],
    [w / 2 + t / 2, 0, t, h],
  ];
  for (const [x, y, pw, ph] of parts) {
    const m = new Mesh(new BoxGeometry(pw, ph, 0.02), frameMat);
    m.position.set(x, y, 0);
    g.add(m);
  }
  const swag = new Mesh(new BoxGeometry(w + 0.02, 0.06, 0.03), mat(PALETTE.curtain, 0.85));
  swag.position.set(0, h / 2 - 0.02, 0.015);
  g.add(swag);
  for (const x of [-w / 3, 0, w / 3]) {
    const can = new Mesh(new CylinderGeometry(0.012, 0.014, 0.02, 12), mat(PALETTE.brass, 0.4, 0.7));
    can.rotation.x = Math.PI / 2.6;
    can.position.set(x, -h / 2 - 0.04, 0.03);
    g.add(can);
  }
  return g;
}
