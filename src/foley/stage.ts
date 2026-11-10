// The stage: the table with its props, clapperboard and tiles, and the screen, as one root group.
import { CanvasTexture, Group, Mesh, MeshBasicMaterial, Object3D, Quaternion, SRGBColorSpace, Vector3 } from 'three';
import { Screen } from './screen';
import { PALETTE, TABLE_D, TABLE_H, TABLE_W, buildClapper, buildProp, buildTable, buildTile, mat } from './toys';
import { PROPS, type PropId } from './types';

export type PieceId = PropId | 'clapper' | 'tile-pause' | 'tile-volume' | 'tile-redo' | 'tile-glasses' | 'tile-calm';

export interface PropPiece {
  id: PieceId;
  root: Group;
  home: Vector3;
  homeQuat: Quaternion;
  selected: boolean;
  hovered: boolean;
  /** Set by sound triggers to flash the lamp. */
  pulse: number;
}

const SCREEN_AHEAD = 1.3;
const SCREEN_LIFT = 0.12; // screen centre 12 cm above eye height, so the lane under it clears the props
const TABLE_AHEAD = 0.75;
const TABLE_BELOW = 0.25;

const TILES: { id: PieceId; label: string }[] = [
  { id: 'tile-pause', label: 'Pause' },
  { id: 'tile-volume', label: 'Vol 100' },
  { id: 'tile-redo', label: 'Redo' },
];

export class Stage {
  readonly root = new Group();
  readonly table: Group;
  readonly screen = new Screen();
  readonly pieces = new Map<string, PropPiece>();
  private byObject = new WeakMap<Object3D, PropPiece>();
  private doorSwing = 0;
  private clapSnap = 0;

  constructor() {
    this.root.name = 'coconuts-stage';
    this.table = buildTable();
    this.root.add(this.table);
    for (const spec of PROPS) {
      const g = buildProp(spec.id);
      g.position.set(spec.x, TABLE_H, spec.z);
      this.table.add(g);
      this.addPiece(spec.id, g);
    }
    const clapper = buildClapper();
    clapper.position.set(-0.3, TABLE_H, TABLE_D / 2 - 0.06);
    clapper.rotation.y = 0.35;
    this.table.add(clapper);
    this.addPiece('clapper', clapper);
    TILES.forEach((t, i) => {
      const tile = buildTile(t.label);
      tile.position.set(TABLE_W / 2 - 0.05, TABLE_H, TABLE_D / 2 - 0.05 - i * 0.065);
      this.table.add(tile);
      this.addPiece(t.id, tile);
    });
    this.screen.group.position.set(0, TABLE_BELOW + SCREEN_LIFT, -(SCREEN_AHEAD - TABLE_AHEAD));
    this.root.add(this.screen.group);
  }

  private addPiece(id: PieceId, root: Group): void {
    const piece: PropPiece = {
      id,
      root,
      home: root.position.clone(),
      homeQuat: root.quaternion.clone(),
      selected: false,
      hovered: false,
      pulse: 0,
    };
    this.pieces.set(id, piece);
    root.traverse((o) => this.byObject.set(o, piece));
  }

  pieceFor(object: Object3D | null | undefined): PropPiece | undefined {
    let o: Object3D | null | undefined = object;
    while (o) {
      const p = this.byObject.get(o);
      if (p) return p;
      o = o.parent;
    }
    return undefined;
  }

  /** Place the stage relative to the viewer: the table 0.75 m ahead and 0.25 m below the eyes, facing them. */
  placeFrom(eye: Vector3, forward: Vector3): void {
    const fwd = forward.clone();
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
    fwd.normalize();
    this.root.position.copy(eye).addScaledVector(fwd, TABLE_AHEAD);
    this.root.position.y = eye.y - TABLE_BELOW;
    this.root.rotation.set(0, Math.atan2(fwd.x, fwd.z) + Math.PI, 0);
  }

  setHovered(id: string, on: boolean): void {
    const p = this.pieces.get(id);
    if (p) p.hovered = on;
  }

  flash(id: string, strength = 1): void {
    const p = this.pieces.get(id);
    if (p) p.pulse = Math.max(p.pulse, strength);
  }

  worldOf(id: string, out = new Vector3()): Vector3 {
    const p = this.pieces.get(id);
    return p ? p.root.getWorldPosition(out) : out.set(0, 0, 0);
  }

  /** Swing the door leaf: 1 = a full slam, 0.35 = a knock's rattle. */
  swingDoor(amount: number): void {
    this.doorSwing = Math.max(this.doorSwing, amount);
  }

  snapClapper(): void {
    this.clapSnap = 1;
  }

  setWhistleSlide(pitch: number): void {
    const slide = this.pieces.get('whistle')?.root.getObjectByName('Slide');
    if (slide) slide.position.x = -0.03 + 0.03 * Math.max(0, Math.min(1, pitch));
  }

  setTileLabel(tile: 'pause' | 'volume' | 'redo' | 'glasses' | 'calm', label: string): void {
    const p = this.pieces.get(`tile-${tile}`);
    const face = p?.root.getObjectByName('face') as Mesh | undefined;
    if (!face) return;
    const m = face.material as MeshBasicMaterial;
    m.map?.dispose();
    m.map = tileTexture(label);
    m.needsUpdate = true;
  }

  update(dt: number): void {
    const k = Math.min(1, dt * 14);
    for (const p of this.pieces.values()) {
      const lamp = p.root.getObjectByName('lamp') as Mesh | undefined;
      if (lamp) {
        const m = lamp.material as MeshBasicMaterial;
        const target = Math.max(p.pulse, p.selected ? 1 : p.hovered ? 0.55 : 0);
        m.opacity += (target - m.opacity) * k;
      }
      p.pulse = Math.max(0, p.pulse - dt * 2.5);
      const s = p.hovered ? 1.04 : 1;
      p.root.scale.x += (s - p.root.scale.x) * k;
      p.root.scale.z = p.root.scale.y = p.root.scale.x;
    }
    // the door leaf swings and settles; the clapper's bar snaps shut
    const leaf = this.pieces.get('door')?.root.getObjectByName('Leaf');
    if (leaf) {
      leaf.rotation.y = -this.doorSwing * 1.1;
      this.doorSwing = Math.max(0, this.doorSwing - dt * 4);
    }
    const clap = this.pieces.get('clapper')?.root.getObjectByName('Clap');
    if (clap) {
      clap.rotation.z = this.clapSnap * 0.45;
      this.clapSnap = Math.max(0, this.clapSnap - dt * 5);
    }
  }

  static readonly accentMaterial = () => mat(PALETTE.accent, 0.6);
}

export function tileTexture(label: string): CanvasTexture {
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
