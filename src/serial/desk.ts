// The player's own desk, as a place the film can spill onto. A character leaves the picture, lands among the foley
// props and runs between them to the table's edge; a later sound sends it over. The host hands over a group lying on
// the table top (metres, x to the player's right, z toward the player) and a way between the props.
// A figure that comes nearer is made smaller, so it looks the size it was on the stage.
import { Group, type Object3D, Vector3 } from 'three';
import type { Actor } from './cast';
import { call, sequence, type Task } from './tasks';

export interface DeskRoute {
  /** Metres that one stage unit measures on the desk. */
  unit: number;
  /** Where the leap lands, then the way between the props, ending at the edge (metres on the table top). */
  path: [number, number][];
  /** A point past the edge: where the jump off the table goes. */
  off: [number, number];
}

const LEAP_SECS = 0.8;
const LEAP_RISE = 2.4; // stage units above the straight line, at the top of the leap
/** A fingertip this near the middle of the figure on the desk (metres) makes it start; then it is left in peace this long. */
const POKE_REACH = 0.075;
const POKE_MIDDLE = 0.045;
const POKE_CALM_S = 2.2;
const POKE_START_S = 0.55;
const from = new Vector3();
const to = new Vector3();
const tmp = new Vector3();

export class Desk {
  /** Its units are stage units, so an actor walks here as it walks on the stage. */
  readonly root = new Group();
  /** The figure standing at the table's edge with nothing to do but be pleased with itself. */
  private waiting: Actor | null = null;
  private calm = 0;
  private starting = 0;

  constructor(
    host: Object3D,
    readonly route: DeskRoute,
  ) {
    this.root.name = 'desk';
    this.root.scale.setScalar(route.unit);
    host.add(this.root);
  }

  dispose(): void {
    this.root.removeFromParent();
  }

  holds(a: Actor): boolean {
    return a.root.parent === this.root;
  }

  private point(p: [number, number], out: Vector3): Vector3 {
    return out.set(p[0] / this.route.unit, 0, p[1] / this.route.unit);
  }

  /** A leap from wherever the actor stands down to the start of the route, then the run to the edge. */
  arrive(a: Actor, onLand?: () => void): Task {
    let t = -1;
    let size = 1;
    const start = new Vector3();
    const end = new Vector3();
    const leap: Task = {
      update: (dt) => {
        if (t < 0) {
          t = 0;
          // the same place and the same size, now counted in the desk's own units
          a.root.updateWorldMatrix(true, false);
          a.root.getWorldPosition(from);
          const worldSize = a.root.getWorldScale(tmp).x;
          this.root.updateWorldMatrix(true, false);
          size = worldSize / this.root.getWorldScale(tmp).x;
          this.root.worldToLocal(start.copy(from));
          this.point(this.route.path[0], end);
          this.root.add(a.root);
          a.setFree(true);
          a.root.position.copy(start);
          a.root.scale.setScalar(size);
          a.faceAudience();
          a.play('jump');
        }
        t += dt;
        const e = Math.min(1, t / LEAP_SECS);
        a.root.position.lerpVectors(start, end, e);
        a.root.position.y += LEAP_RISE * 4 * e * (1 - e);
        a.root.scale.setScalar(size + (1 - size) * e);
        if (e < 1) return false;
        a.root.position.copy(end);
        a.root.scale.setScalar(1);
        a.play('idle');
        onLand?.();
        return true;
      },
    };
    const run = this.route.path.slice(1).map((p) => () => {
      this.point(p, to);
      return a.goTo(to.x, to.z, 'run');
    });
    // at the edge it turns to the player and crows: it got away, and it knows who is watching
    return sequence([
      () => leap,
      ...run,
      () => call(() => a.faceAudience()),
      () => a.perform('cheer'),
      () =>
        call(() => {
          this.waiting = a;
          this.calm = 0;
        }),
    ]);
  }

  /**
   * A fingertip (a point in the world) comes close to the figure waiting on the desk: it starts, and turns to look
   * at the finger. Returns the figure when it did, so the house can laugh; it is then left in peace for a moment.
   */
  poke(world: Vector3): Actor | null {
    const a = this.waiting;
    if (!a || this.calm > 0 || !this.holds(a)) return null;
    a.root.getWorldPosition(from);
    from.y += POKE_MIDDLE;
    if (from.distanceTo(world) > POKE_REACH) return null;
    this.root.worldToLocal(to.copy(world));
    a.face(to.x, to.z);
    a.play('jump');
    this.starting = POKE_START_S;
    this.calm = POKE_CALM_S;
    return a;
  }

  /** Where the waiting figure stands, in the world (null when nobody waits): for whoever films a finger going near it. */
  waitingAt(out: Vector3): Vector3 | null {
    const a = this.waiting;
    return a && this.holds(a) ? a.root.getWorldPosition(out) : null;
  }

  update(dt: number): void {
    if (this.calm > 0) this.calm -= dt;
    if (this.starting > 0 && (this.starting -= dt) <= 0) {
      const a = this.waiting;
      if (a && this.holds(a)) {
        a.faceAudience();
        a.play('idle');
      }
    }
  }

  /**
   * The way back: up over the table's edge from below, a wave at the player, the route run the other way, and a
   * leap up to `target` (a point in the world, where the figure is `targetSize` big): back into the picture.
   */
  comeBack(a: Actor, target: Vector3, targetSize: number, onLeap?: () => void): Task {
    const path = this.route.path;
    const edge = new Vector3();
    const below = new Vector3();
    const start = new Vector3();
    const end = new Vector3();
    let t = -1;
    const climb: Task = {
      update: (dt) => {
        if (t < 0) {
          t = 0;
          this.point(path[path.length - 1], edge);
          this.point(this.route.off, below).setY(-7);
          this.root.add(a.root);
          a.setFree(true);
          a.root.scale.setScalar(1);
          a.root.position.copy(below);
          a.place(below.x, below.z, Math.PI); // its back to the player as it comes up, like someone climbing a wall
          a.root.position.y = below.y;
          a.play('jump');
        }
        t += dt;
        const e = Math.min(1, t / 0.7);
        a.root.position.lerpVectors(below, edge, e);
        a.root.position.y += 3 * 4 * e * (1 - e) * 0.5;
        if (e < 1) return false;
        a.root.position.copy(edge);
        a.play('idle');
        return true;
      },
    };
    let u = -1;
    let size = 1;
    const leap: Task = {
      update: (dt) => {
        if (u < 0) {
          u = 0;
          start.copy(a.root.position);
          this.root.updateWorldMatrix(true, false);
          this.root.worldToLocal(end.copy(target));
          size = targetSize / this.root.getWorldScale(tmp).x;
          a.play('jump');
          onLeap?.();
        }
        u += dt;
        const e = Math.min(1, u / LEAP_SECS);
        a.root.position.lerpVectors(start, end, e);
        a.root.position.y += LEAP_RISE * 4 * e * (1 - e);
        a.root.scale.setScalar(1 + (size - 1) * e);
        return e >= 1;
      },
    };
    const back = path
      .slice(0, -1)
      .reverse()
      .map((p) => () => {
        this.point(p, to);
        return a.goTo(to.x, to.z, 'run');
      });
    return sequence([() => climb, () => call(() => a.faceAudience()), () => a.perform('cheer'), ...back, () => leap]);
  }

  /** Off the edge: a hop out over it and a long fall out of sight. */
  leave(a: Actor): Task {
    let t = -1;
    const start = new Vector3();
    const end = new Vector3();
    let vy = 0;
    const HOP = 0.3;
    return {
      update: (dt) => {
        if (t < 0) {
          t = 0;
          if (this.waiting === a) this.waiting = null;
          start.copy(a.root.position);
          this.point(this.route.off, end);
          a.play('jump');
        }
        t += dt;
        const p = a.root.position;
        if (t <= HOP) {
          const e = t / HOP;
          p.lerpVectors(start, end, e);
          p.y = 1.1 * 4 * e * (1 - e) * 0.5 + 0.55 * e; // up and out, still rising a little at the edge
          return false;
        }
        // the fall: it tumbles, and is gone below the table
        vy -= 34 * dt;
        p.y += vy * dt;
        p.z += 1.2 * dt;
        a.root.rotation.x += 7 * dt;
        return p.y * this.route.unit < -0.8;
      },
    };
  }
}
