import { Group, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { Actor } from '../src/serial/cast';
import { Desk, type DeskRoute } from '../src/serial/desk';
import { type Task, wait } from '../src/serial/tasks';

/** Just enough of an actor to leave a stage: a root that moves, and a record of what it was asked to do. */
class Walker {
  readonly root = new Group();
  readonly calls: string[] = [];
  free = false;
  setFree(on: boolean): void {
    this.free = on;
  }
  play(verb: string): number {
    this.calls.push(`play:${verb}`);
    return 0;
  }
  faceAudience(): void {
    this.calls.push('face:audience');
  }
  place(x: number, z: number, facing = 0): void {
    this.root.position.set(x, 0, z);
    this.root.rotation.y = facing;
  }
  perform(verb: string): Task {
    this.calls.push(`perform:${verb}`);
    return wait(0.2);
  }
  goTo(x: number, z: number): Task {
    return {
      update: (dt) => {
        const p = this.root.position;
        const d = Math.hypot(x - p.x, z - p.z);
        const step = 5 * dt;
        if (d <= step) {
          p.set(x, 0, z);
          return true;
        }
        p.x += ((x - p.x) / d) * step;
        p.z += ((z - p.z) / d) * step;
        return false;
      },
    };
  }
}

const ROUTE: DeskRoute = { unit: 0.05, path: [[0, -0.15], [0, 0], [0.02, 0.16]], off: [0.02, 0.27] };

function rig() {
  const world = new Group();
  // a stage standing behind and above the table, ten times the desk's scale
  const stage = new Group();
  stage.position.set(0, 0.14, -0.42);
  stage.scale.setScalar(0.5);
  const host = new Group();
  world.add(stage, host);
  const desk = new Desk(host, ROUTE);
  const a = new Walker();
  a.root.position.set(-0.4, 0, 0.6);
  stage.add(a.root);
  world.updateMatrixWorld(true);
  return { world, stage, host, desk, a };
}

function run(task: Task, world: Group, max = 20, dt = 1 / 30): number {
  let t = 0;
  while (t < max) {
    world.updateMatrixWorld(true);
    t += dt;
    if (task.update(dt)) return t;
  }
  throw new Error('the task did not end');
}

describe('the desk: a character leaves the picture', () => {
  it('the leap starts where the actor stands, at the size it has there', () => {
    const { world, desk, a } = rig();
    const before = a.root.getWorldPosition(new Vector3());
    const task = desk.arrive(a as unknown as Actor);
    task.update(0); // the first step moves it onto the desk without moving it in the world
    world.updateMatrixWorld(true);
    const after = a.root.getWorldPosition(new Vector3());
    expect(after.distanceTo(before)).toBeLessThan(1e-6);
    expect(a.root.getWorldScale(new Vector3()).x).toBeCloseTo(0.5, 6);
    expect(desk.holds(a as unknown as Actor)).toBe(true);
    expect(a.free).toBe(true);
  });

  it('it lands, runs the route and stops at the edge, desk-sized, facing the player', () => {
    const { world, desk, a } = rig();
    let landed = 0;
    const secs = run(desk.arrive(a as unknown as Actor, () => landed++), world);
    expect(landed).toBe(1);
    expect(secs).toBeGreaterThan(0.8); // the leap alone takes that long
    world.updateMatrixWorld(true);
    const p = a.root.getWorldPosition(new Vector3());
    expect(p.x).toBeCloseTo(0.02, 4);
    expect(p.y).toBeCloseTo(0, 4);
    expect(p.z).toBeCloseTo(0.16, 4);
    expect(a.root.getWorldScale(new Vector3()).x).toBeCloseTo(ROUTE.unit, 6);
    expect(a.calls.at(-1)).toBe('perform:cheer');
    expect(a.calls).toContain('face:audience');
  });

  it('the leap rises over the straight line on its way down', () => {
    const { world, desk, a } = rig();
    const task = desk.arrive(a as unknown as Actor);
    let top = -Infinity;
    for (let i = 0; i < 12; i++) {
      task.update(1 / 30);
      world.updateMatrixWorld(true);
      top = Math.max(top, a.root.getWorldPosition(new Vector3()).y);
    }
    expect(top).toBeGreaterThan(0.14); // above the stage floor it left
  });

  it('off the edge: out past it, then down out of sight', () => {
    const { world, desk, a } = rig();
    run(desk.arrive(a as unknown as Actor), world);
    const secs = run(desk.leave(a as unknown as Actor), world);
    world.updateMatrixWorld(true);
    const p = a.root.getWorldPosition(new Vector3());
    expect(p.y).toBeLessThan(-0.8);
    expect(p.z).toBeGreaterThan(0.27); // it fell beyond the table, toward the player
    expect(secs).toBeLessThan(3);
  });

  it('the way back: up over the edge, across the table, and one leap to a point in the world at its size there', () => {
    const { world, stage, desk, a } = rig();
    stage.remove(a.root); // it fell off the table last reel: it belongs to nobody now
    const target = stage.localToWorld(new Vector3(-0.5, 0.2, 3.3));
    let leaps = 0;
    const task = desk.comeBack(a as unknown as Actor, target, 0.5, () => leaps++);
    task.update(0);
    world.updateMatrixWorld(true);
    expect(desk.holds(a as unknown as Actor)).toBe(true);
    expect(a.free).toBe(true);
    expect(a.root.getWorldPosition(new Vector3()).y).toBeLessThan(-0.2); // it starts below the table top
    run(task, world);
    expect(leaps).toBe(1);
    world.updateMatrixWorld(true);
    expect(a.root.getWorldPosition(new Vector3()).distanceTo(target)).toBeLessThan(1e-4);
    expect(a.root.getWorldScale(new Vector3()).x).toBeCloseTo(0.5, 5);
    expect(a.calls).toContain('perform:cheer');
  });

  it('dispose takes the desk away', () => {
    const { host, desk } = rig();
    expect(host.children).toContain(desk.root);
    desk.dispose();
    expect(host.children).not.toContain(desk.root);
  });
});
