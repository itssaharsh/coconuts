// The stage: the table with its props and clapperboard, and the screen, as one root group.
import { Group, Mesh, MeshBasicMaterial, Object3D, Vector3 } from 'three';
import { Screen } from './screen';
import { PALETTE, TABLE_D, TABLE_H, buildClapper, buildProp, buildTable, mat } from './toys';
import { PROPS, type PropId } from './types';

export interface PropPiece {
  id: PropId | 'clapper';
  root: Group;
  home: Vector3;
  selected: boolean;
  hovered: boolean;
  /** Set by sound triggers to flash the lamp. */
  pulse: number;
}

const SCREEN_AHEAD = 1.3;
const SCREEN_LIFT = 0.12; // screen centre 12 cm above eye height, so the lane under it clears the props
const TABLE_AHEAD = 0.75;
const TABLE_BELOW = 0.25;

export class Stage {
  readonly root = new Group();
  readonly table: Group;
  readonly screen = new Screen();
  readonly pieces = new Map<string, PropPiece>();
  private byObject = new WeakMap<Object3D, PropPiece>();

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
    this.screen.group.position.set(0, TABLE_BELOW + SCREEN_LIFT, -(SCREEN_AHEAD - TABLE_AHEAD));
    this.root.add(this.screen.group);
  }

  private addPiece(id: PropId | 'clapper', root: Group): void {
    const piece: PropPiece = { id, root, home: root.position.clone(), selected: false, hovered: false, pulse: 0 };
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
  }

  static readonly accentMaterial = () => mat(PALETTE.accent, 0.6);
}
