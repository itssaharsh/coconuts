// The stage: the table with its props, clapperboard and tiles, and the screen, as one root group.
import { CanvasTexture, Group, Mesh, MeshBasicMaterial, Object3D, Quaternion, SRGBColorSpace, Vector3 } from 'three';
import { dress, modelStats } from './models';
import { Screen } from './screen';
import { PALETTE, TABLE_D, TABLE_H, TABLE_W, buildClapper, buildProp, buildTable, buildTile, mat, nameHitBoxes } from './toys';
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
const SCREEN_LIFT = 0.15; // screen centre 15 cm above eye height, so the lane under it clears most props
const TABLE_AHEAD = 0.75;
const TABLE_BELOW = 0.25;
// The Serial's seating: the table nearer and at desk height, so every prop is inside a seated reach and none of them
// stands in front of the stage; the theatre behind it, its floor a hand's breadth below the eye line.
const SERIAL_TABLE_AHEAD = 0.46;
const SERIAL_TABLE_BELOW = 0.38;
const THEATRE_AHEAD = 0.88;
const THEATRE_FLOOR_BELOW = 0.24;

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
  private bellPress = 0;
  private thunderLevel = 0;
  private thunderPhase = 0;
  /** True once every Blender model is in (or has failed): the stage's final shape. */
  dressed = false;
  /** Where the toy theatre stands (the Serial); its origin is the centre of the opening's bottom edge. */
  readonly theatreMount = new Group();
  private ahead: number;
  private below: number;

  constructor(readonly serial = false) {
    this.ahead = serial ? SERIAL_TABLE_AHEAD : TABLE_AHEAD;
    this.below = serial ? SERIAL_TABLE_BELOW : TABLE_BELOW;
    this.root.name = 'coconuts-stage';
    this.theatreMount.name = 'theatre-mount';
    this.theatreMount.position.set(0, this.below - THEATRE_FLOOR_BELOW, -(THEATRE_AHEAD - this.ahead));
    this.root.add(this.theatreMount);
    this.table = buildTable();
    this.root.add(this.table);
    for (const spec of PROPS) {
      const g = buildProp(spec.id);
      nameHitBoxes(g);
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
      tile.name = t.id;
      tile.position.set(TABLE_W / 2 - 0.03, TABLE_H, TABLE_D / 2 - 0.04 - i * 0.1); // 10 cm apart: wider than the gaze cone
      this.table.add(tile);
      this.addPiece(t.id, tile);
    });
    this.screen.group.position.set(0, TABLE_BELOW + SCREEN_LIFT, -(SCREEN_AHEAD - TABLE_AHEAD));
    this.screen.group.visible = !serial; // the theatre takes the film screen's place
    this.root.add(this.screen.group);
    void this.dressAll();
  }

  /** Swap the primitives for the Blender models as they load; the stage works before them and without them. */
  private async dressAll(): Promise<void> {
    const jobs: Promise<unknown>[] = [
      dress(this.table, 'table').then((model) => {
        // the painted spots on the table top move under the props (Spot1-3 back row, Spot4-6 front row)
        if (!model) return;
        const order = ['door', 'thunder', 'glass', 'coconuts', 'bell', 'whistle'];
        order.forEach((id, i) => {
          const spec = PROPS.find((p) => p.id === id);
          const spot = model.getObjectByName(`Spot${i + 1}`);
          if (spec && spot) spot.position.set(spec.x, spot.position.y, spec.z);
        });
      }),
    ];
    for (const spec of PROPS) {
      const piece = this.pieces.get(spec.id);
      if (piece) jobs.push(dress(piece.root, spec.id));
    }
    const clapper = this.pieces.get('clapper');
    if (clapper) jobs.push(dress(clapper.root, 'clapper'));
    // the frame's opening is centred 0.28 m above its base, and the film plane has to sit behind its back face
    const frame = this.screen.group.getObjectByName('screen-frame');
    if (frame) jobs.push(dress(frame, 'screen', { y: -0.28, z: 0.02 }));
    await Promise.all(jobs);
    const s = modelStats();
    this.dressed = true;
    console.log('MODELS', s.loaded, 'in', s.failed, 'failed');
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

  /** Place the stage relative to the viewer: the table ahead of and below the eyes (how far depends on the show), facing them. */
  placeFrom(eye: Vector3, forward: Vector3): void {
    const fwd = forward.clone();
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
    fwd.normalize();
    this.root.position.copy(eye).addScaledVector(fwd, this.ahead);
    this.root.position.y = eye.y - this.below;
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

  pressBell(): void {
    this.bellPress = 1;
  }

  /** How hard the thunder sheet is being shaken, 0..1; it wobbles on its cords and settles. */
  setThunderShake(level: number): void {
    this.thunderLevel = Math.max(this.thunderLevel, Math.min(1, level));
  }

  setWhistleSlide(pitch: number): void {
    const slide = this.pieces.get('whistle')?.root.getObjectByName('Slide');
    if (!slide) return;
    const home = (slide.userData.homeX ??= slide.position.x) as number;
    slide.position.x = home - 0.02 * (1 - Math.max(0, Math.min(1, pitch))); // pushed in at the bottom, pulled out at the top
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
        lamp.visible = m.opacity > 0.01 || target > 0; // a dark lamp is not drawn at all
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
    const button = this.pieces.get('bell')?.root.getObjectByName('Button');
    if (button) {
      const home = (button.userData.homeY ??= button.position.y) as number;
      button.position.y = home - 0.003 * this.bellPress;
      this.bellPress = Math.max(0, this.bellPress - dt * 6);
    }
    const sheet = this.pieces.get('thunder')?.root.getObjectByName('Sheet');
    if (sheet) {
      this.thunderPhase += dt * 40 * (0.3 + this.thunderLevel);
      sheet.rotation.x = Math.sin(this.thunderPhase) * 0.12 * this.thunderLevel;
      this.thunderLevel = Math.max(0, this.thunderLevel - dt * 2);
    }
  }

  static readonly accentMaterial = () => mat(PALETTE.accent, 0.6);
}

function tileTexture(label: string): CanvasTexture {
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
