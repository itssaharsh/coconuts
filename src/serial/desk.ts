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
const from = new Vector3();
const to = new Vector3();
const tmp = new Vector3();

export class Desk {
  /** Its units are stage units, so an actor walks here as it walks on the stage. */
  readonly root = new Group();

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
    return sequence([() => leap, ...run, () => call(() => a.faceAudience()), () => a.perform('cheer')]);
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
