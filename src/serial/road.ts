// The road: an endless strip of country that slides past the horse. The horse gallops on the spot; the world moves.
// Positions are kit units on the stage. Pieces wrap round, so a dozen meshes make a road of any length.
import { Group, Mesh, MeshBasicMaterial, type Object3D, PlaneGeometry, RepeatWrapping } from 'three';
import { hillsTexture, roadTexture } from './cards';
import { loadGLB } from './cast';
import { filmify, filmMaterial } from './film';

export type RoadTheme = 'road' | 'forest' | 'village';

const SPAN = 26; // pieces live in x -13..13
const TILE = SPAN / 3; // the ground texture repeats three times across the span
/** Full gallop, kit units per second. */
export const GALLOP_SPEED = 9.5;

interface Lane {
  z: number;
  step: number;
  scale: number;
  pieces: string[];
}

const LANES: Record<RoadTheme, Lane[]> = {
  road: [
    { z: -3.2, step: 6.5, scale: 1, pieces: ['tree_round', 'house_a', 'tree_cone', 'windmill'] },
    { z: -1.2, step: 5.2, scale: 0.85, pieces: ['fence', 'haystack', 'bush_b', 'signpost', 'rock_a'] },
    { z: 3.5, step: 8.7, scale: 0.3, pieces: ['rock_b', 'rock_a', 'rock_b'] },
  ],
  forest: [
    { z: -3.3, step: 4.4, scale: 1, pieces: ['tree_cone', 'tree_round', 'tree_grove_b', 'tree_cone', 'tree_round', 'tree_cone'] },
    { z: -1.3, step: 5.2, scale: 0.8, pieces: ['bush_a', 'rock_a', 'tree_cone', 'bush_b', 'rock_b'] },
    { z: 3.5, step: 8.7, scale: 0.3, pieces: ['rock_a', 'rock_b', 'rock_a'] },
  ],
  village: [
    { z: -3.2, step: 6.5, scale: 1, pieces: ['house_b', 'tree_round', 'house_a', 'well'] },
    { z: -1.2, step: 5.2, scale: 0.85, pieces: ['fence', 'cart', 'haystack', 'fence', 'signpost'] },
    { z: 3.5, step: 8.7, scale: 0.3, pieces: ['rock_b', 'rock_a', 'rock_b'] },
  ],
};

export class Road {
  readonly root = new Group();
  private movers: Object3D[] = [];
  private ground: MeshBasicMaterial;
  private hills: MeshBasicMaterial;

  constructor(
    private base: string,
    readonly theme: RoadTheme,
  ) {
    this.root.name = `road-${theme}`;
    const groundMap = roadTexture(theme);
    groundMap.wrapS = RepeatWrapping;
    groundMap.repeat.set(3, 1);
    this.ground = filmMaterial(new MeshBasicMaterial({ map: groundMap }));
    const ground = new Mesh(new PlaneGeometry(SPAN, 9), this.ground);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, 0, -0.5); // z -5..4
    ground.name = 'road-ground';
    const hillsMap = hillsTexture();
    hillsMap.wrapS = RepeatWrapping;
    hillsMap.repeat.set(1.5, 1);
    this.hills = filmMaterial(new MeshBasicMaterial({ map: hillsMap, alphaTest: 0.5 }));
    const hills = new Mesh(new PlaneGeometry(SPAN, 3.2), this.hills);
    hills.position.set(0, 1.6, -4.9);
    hills.name = 'road-hills';
    this.root.add(ground, hills);
  }

  /** Load the pieces and set them out along the lanes. */
  async build(): Promise<void> {
    const lanes = LANES[this.theme];
    const ids = [...new Set(lanes.flatMap((l) => l.pieces))];
    const loaded = new Map<string, Object3D>();
    await Promise.all(
      ids.map(async (id) => {
        try {
          const gltf = await loadGLB(`${this.base}scenery/${id}.glb`);
          loaded.set(id, gltf.scene);
        } catch (e) {
          console.warn('ROAD piece failed', id, e instanceof Error ? e.message : e);
        }
      }),
    );
    let n = 0;
    for (const lane of lanes) {
      const count = Math.round(SPAN / lane.step);
      for (let i = 0; i < count; i++) {
        const src = loaded.get(lane.pieces[i % lane.pieces.length]);
        if (!src) continue;
        const o = src.clone(true);
        filmify(o);
        o.scale.setScalar(lane.scale);
        // a fixed scatter: the same road every time, so a capture can be repeated
        const jitter = Math.sin(++n * 12.9898) * 43758.5453;
        const j = jitter - Math.floor(jitter);
        o.position.set(-SPAN / 2 + (i + 0.5 * j) * lane.step, 0, lane.z + (j - 0.5) * 0.7);
        o.rotation.y = (j - 0.5) * 1.2;
        this.movers.push(o);
        this.root.add(o);
      }
    }
  }

  /** Slide the world toward stage left by `speed` kit units per second. */
  update(dt: number, speed: number): void {
    if (speed <= 0) return;
    const d = speed * dt;
    for (const o of this.movers) {
      o.position.x -= d;
      if (o.position.x < -SPAN / 2) o.position.x += SPAN;
    }
    this.ground.map!.offset.x = (this.ground.map!.offset.x + d / TILE) % 1;
    this.hills.map!.offset.x = (this.hills.map!.offset.x + (d * 0.12) / (SPAN / 1.5)) % 1;
  }
}
