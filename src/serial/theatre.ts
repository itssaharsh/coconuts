// The toy theatre: proscenium, curtain, the box with its painted sky, the set, its lights, and the cards that speak
// for the film. The group is in metres with its origin at the centre of the opening's bottom edge (scale the group
// to make the whole theatre larger); `stage` inside it is in kit units (the set and the actors).
import {
  AdditiveBlending,
  Box3,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  type MeshStandardMaterial,
  type Object3D,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  type Texture,
  Vector3,
} from 'three';
import type { PropId } from '../foley/types';
import { backdropTexture, choiceCard, cueCard, curtainTexture, emoteCard, glowTexture, soundWordFor, titleCard, valanceTexture, wordCard } from './cards';
import { type Actor, loadGLB } from './cast';
import { film, filmify, MAX_LAMPS, setTint, type TintName } from './film';
import { StageFx } from './fx';
import { GALLOP_SPEED, Road, type RoadTheme } from './road';
import type { Emote, SetInfo, StageCue } from './schema';
import { type Task } from './tasks';

export const STAGE_W = 1.0; // the opening, metres (before the group's scale)
export const STAGE_H = 0.5625;
/** Kit units -> metres: the opening shows twelve units of stage. */
export const KIT = STAGE_W / 12;
/** The proscenium plane and the back wall's inner face, kit units. */
export const FRONT_Z = 4;
export const BACK_Z = -4;
/** The wings: the film shader drops everything beyond this, and the box wall stands here. */
export const CLIP_X = 6.85;
// the box is taller than the opening so the sky runs up behind the pelmet; its roof rises toward the back and
// starts below the frame's top edge, so from a seat nothing of the box shows above the frame
const TOP_FRONT = 0.632; // metres
const TOP_BACK = 0.72;
const BOX_BACK = BACK_Z - 1.3; // the painted sky stands behind the back wall
const RAKE = 0.07; // radians
const FRAME_SCALE = STAGE_W / 0.8; // the proscenium model's opening is 0.8 m wide
/** `?nofx` plays the show without its weather and debris (a switch, should a headset dislike them). */
const FX_OFF = typeof location !== 'undefined' && new URLSearchParams(location.search).has('nofx');

/** A burst on the stage. */
export type Burst = 'sparks' | 'dust' | 'shards' | 'confetti';

/** Theatre metres from a kit z. */
const zt = (z: number) => (z - FRONT_Z) * KIT - 0.006;

const DEFAULT_MARKS: Record<string, [number, number]> = {
  centre: [0, 0.8],
  left: [-3.8, 1.2],
  right: [3.8, 1.2],
  door: [-1.5, -2.6],
  table: [4.2, -1],
  chest: [-1.8, -2.2],
  window: [2.6, -2.8],
  upstage_left: [-4, -2.6],
  upstage_right: [4, -2.6],
  wings_left: [-8.5, 2],
  wings_right: [8.5, 2],
};

/** The clear places every set has (the sets keep the front of the stage free of furniture). */
const COMMON_MARKS: Record<string, [number, number]> = {
  duel_a: [-1.15, 1.5],
  duel_b: [1.15, 1.5],
  front_left: [-3.0, 2.0],
  front_right: [3.0, 2.0],
  aside_left: [-5.2, 2.4],
  aside_right: [5.2, 2.4],
  // where something large comes to rest: the middle of the back of the stage
  lair: [1.4, -1.5],
};

/** Where a set's own marks put an actor behind its furniture, the stage knows better. */
const MARK_FIXES: Record<string, Record<string, [number, number]>> = {
  hall: { door_side: [-4.3, -1.0] }, // clear of the shield pillar
  inn: { door_side: [-3.4, -1.6] }, // clear of the left table
  graveyard: { grave_a: [-3.4, -0.9], grave_b: [0.4, -1.4], grave_c: [3.6, -0.7] }, // in front of the stones, not behind them
  vault: { chest: [-1.9, -0.5] }, // the sleeper lies in front of the gold
};

const ROAD_MARKS: Record<string, [number, number]> = {
  ...COMMON_MARKS,
  centre: [0, 1.3],
  left: [-3.8, 1.3],
  right: [3.8, 1.3],
  wings_left: [-8.5, 1.3],
  wings_right: [8.5, 1.3],
};

export type Sky = 'night' | 'day' | 'dusk' | 'storm' | 'dark';

interface Floater {
  sprite: Sprite;
  life: number;
  total: number;
  rise: number;
  base: number;
}

interface Dynamic {
  node: Object3D;
  base: Quaternion;
  axis: Vector3;
  open: number;
  cur: number;
  want: number;
}

interface Lamp {
  pos: Vector3;
  glow: Sprite;
  /** Authored strength (a torch is about 1) times what its kind throws. */
  power: number;
  colour: Color;
  phase: number;
}

/** The wash and the key for each film stock, outdoors and in: [sky, ground, key]. */
const LIGHTS: Record<TintName, { out: [number, number, number]; in: [number, number, number] }> = {
  blue: { out: [0x56669a, 0x1c1c26, 0x8a9cd6], in: [0x4a4f66, 0x1a1820, 0x7a7f9a] },
  amber: { out: [0xa6adb8, 0x4a4234, 0xfff0d8], in: [0x7e6c58, 0x30251e, 0xc8b08c] },
  red: { out: [0x8a625c, 0x30201c, 0xf0a078], in: [0x70504a, 0x2a1a18, 0xc08060] },
  green: { out: [0x6c9478, 0x26362a, 0xb4e0bc], in: [0x4a5e50, 0x1a201a, 0x86a890] },
  plain: { out: [0xa6adb8, 0x4a4234, 0xfff0d8], in: [0x77705e, 0x2a241c, 0xc0b090] },
};

interface SetFile {
  marks?: Record<string, [number, number]>;
  kind?: 'interior' | 'exterior';
  sky?: Sky;
  lights?: { name?: string; kind?: string; pos: [number, number, number]; color?: string; intensity?: number; distance?: number }[];
  dynamic?: Record<string, { node?: string; axis?: [number, number, number]; open?: number; baseQuaternion?: [number, number, number, number] }>;
}

/** One quad as two triangles, appended to position/uv arrays. Corners go round counter-clockwise seen from the front. */
function quad(pos: number[], uv: number[], a: number[], b: number[], c: number[], d: number[], uvs: number[][]): void {
  pos.push(...a, ...b, ...c, ...a, ...c, ...d);
  uv.push(...uvs[0], ...uvs[1], ...uvs[2], ...uvs[0], ...uvs[2], ...uvs[3]);
}

function mesh(pos: number[], uv: number[], material: MeshBasicMaterial, name: string): Mesh {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  const m = new Mesh(g, material);
  m.name = name;
  return m;
}

export class Theatre {
  readonly group = new Group();
  readonly stage = new Group();
  private setRoot: Object3D | null = null;
  private road: Road | null = null;
  private info: SetInfo = { id: 'none', marks: DEFAULT_MARKS };
  private dynamics = new Map<string, Dynamic>();
  private lamps: Lamp[] = [];
  private glowMap: Texture | null = null;
  private curtains: Mesh[] = [];
  private curtainOpen = 0;
  private wantCurtain = 0;
  private titleMesh: Mesh;
  private titleShow = 0;
  private wantTitle = 0;
  private cueMesh: Mesh;
  private cueShow = 0;
  private wantCue = 0;
  private cyc: MeshBasicMaterial;
  private skies = new Map<Sky, Texture>();
  private flashMesh: Mesh;
  private flash = 0;
  /** The iris: the picture closes to a point and opens from one, the silent film's own scene change. */
  private irisMesh: Mesh;
  private irisOpen = 1;
  private wantIris = 1;
  private shake = 0;
  private floaters: Floater[] = [];
  private wantColour = 0;
  private colourNow = 0;
  private bloom = 0;
  private time = 0;
  private frameLoaded = false;
  private size = 1;
  private cueScale = 1;
  private tint: TintName = 'amber';
  /** How fast the road slides past, 0..1 of a full gallop. */
  scroll = 0;
  /** The stage's own sounds (curtain, a door's creak): whoever owns the audio listens here. */
  onSound: ((cue: StageCue) => void) | null = null;
  /** The theatre wants to be wall-size (or desk-size again): whoever placed it moves and scales it. */
  onScale: ((big: boolean) => void) | null = null;
  private bigNow = false;
  /** False once wall size proved too much for the headset: the theatre then stays on the desk. */
  allowBig = true;
  /** The stage's weather and debris: rain, mist, embers, sparks, dust. Null when switched off. */
  fx: StageFx | null = null;
  private raining = false;

  constructor(private base: string) {
    this.group.name = 'theatre';
    const hw = CLIP_X * KIT + 0.001;
    const tf = TOP_FRONT;
    const tb = TOP_BACK;
    const back = zt(BOX_BACK);
    // the sky: the back of the box, its sides and its roof, so no edge of it shows from any seat
    this.cyc = new MeshBasicMaterial({ toneMapped: false, map: this.sky('night') });
    {
      const pos: number[] = [];
      const uv: number[] = [];
      quad(pos, uv, [-hw, 0, back], [hw, 0, back], [hw, tb, back], [-hw, tb, back], [[0, 0], [1, 0], [1, 1], [0, 1]]);
      quad(pos, uv, [-hw, 0, 0], [-hw, 0, back], [-hw, tb, back], [-hw, tf, 0], [[0.01, 0], [0.01, 0], [0.01, 1], [0.01, 0.9]]);
      quad(pos, uv, [hw, 0, back], [hw, 0, 0], [hw, tf, 0], [hw, tb, back], [[0.99, 0], [0.99, 0], [0.99, 0.9], [0.99, 1]]);
      quad(pos, uv, [-hw, tb, back], [hw, tb, back], [hw, tf, 0], [-hw, tf, 0], [[0.01, 0.995], [0.99, 0.995], [0.99, 0.995], [0.01, 0.995]]);
      const m = mesh(pos, uv, this.cyc, 'sky');
      this.group.add(m);
    }
    // the deck under the set and the outside of the box, in dark wood
    {
      const pos: number[] = [];
      const uv: number[] = [];
      const o = 0.004; // the shell stands just outside the sky
      const z0 = -0.012;
      const zero = [[0, 0], [0, 0], [0, 0], [0, 0]];
      quad(pos, uv, [-hw, -0.001, 0], [hw, -0.001, 0], [hw, -0.001, back], [-hw, -0.001, back], zero); // deck
      quad(pos, uv, [-hw - o, -0.06, back - o], [-hw - o, -0.06, z0], [-hw - o, tf + o, z0], [-hw - o, tb + o, back - o], zero); // left, outside
      quad(pos, uv, [hw + o, -0.06, z0], [hw + o, -0.06, back - o], [hw + o, tb + o, back - o], [hw + o, tf + o, z0], zero); // right
      quad(pos, uv, [hw + o, -0.06, back - o], [-hw - o, -0.06, back - o], [-hw - o, tb + o, back - o], [hw + o, tb + o, back - o], zero); // back
      quad(pos, uv, [-hw - o, tf + o, z0], [hw + o, tf + o, z0], [hw + o, tb + o, back - o], [-hw - o, tb + o, back - o], zero); // roof
      this.group.add(mesh(pos, uv, new MeshBasicMaterial({ toneMapped: false, color: 0x17110d }), 'box'));
    }

    // the stage is raked: its floor rises toward the back, as in a real theatre, so the upstage action is seen
    this.stage.name = 'stage';
    this.stage.scale.setScalar(KIT);
    this.stage.rotation.x = RAKE;
    this.stage.position.set(0, FRONT_Z * KIT * Math.sin(RAKE), zt(0));
    this.group.add(this.stage);
    if (!FX_OFF) this.fx = new StageFx(this.stage);


    // the curtain: two halves that gather toward the pillars
    const velvet = curtainTexture();
    velvet.wrapS = RepeatWrapping;
    for (const side of [-1, 1]) {
      const geo = new PlaneGeometry(STAGE_W / 2 + 0.004, STAGE_H + 0.01);
      geo.translate((-side * (STAGE_W / 2 + 0.004)) / 2, 0, 0); // pivot on the outer edge
      const m = new Mesh(geo, new MeshBasicMaterial({ toneMapped: false, map: velvet }));
      m.position.set((side * STAGE_W) / 2, STAGE_H / 2, 0.004);
      m.name = side < 0 ? 'curtain-left' : 'curtain-right';
      m.renderOrder = 3;
      this.curtains.push(m);
      this.group.add(m);
    }
    // the pelmet across the top hides the roof of the box from a low seat
    const pelmet = new Mesh(new PlaneGeometry(STAGE_W + 0.01, 0.105), new MeshBasicMaterial({ toneMapped: false, map: valanceTexture(), alphaTest: 0.5 }));
    pelmet.position.set(0, STAGE_H - 0.105 / 2 + 0.004, 0.008);
    pelmet.renderOrder = 4;
    pelmet.name = 'pelmet';
    this.group.add(pelmet);

    this.titleMesh = new Mesh(
      new PlaneGeometry(STAGE_W * 0.96, STAGE_H * 0.96),
      new MeshBasicMaterial({ toneMapped: false, transparent: true, opacity: 0, depthWrite: false }),
    );
    this.titleMesh.position.set(0, STAGE_H / 2, 0.016);
    this.titleMesh.renderOrder = 40;
    this.titleMesh.visible = false;
    this.titleMesh.name = 'title-card';

    this.cueMesh = new Mesh(new PlaneGeometry(0.4, 0.1), new MeshBasicMaterial({ toneMapped: false, transparent: true, opacity: 0, depthWrite: false, depthTest: false }));
    this.cueMesh.position.set(0, -0.05, 0.12);
    this.cueMesh.rotation.x = -0.25;
    this.cueMesh.renderOrder = 42;
    this.cueMesh.visible = false;
    this.cueMesh.name = 'cue-card';

    this.flashMesh = new Mesh(
      new PlaneGeometry(STAGE_W, STAGE_H),
      new MeshBasicMaterial({ toneMapped: false, color: 0xdfe8ff, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false }),
    );
    this.flashMesh.position.set(0, STAGE_H / 2, 0.002);
    this.flashMesh.renderOrder = 2;
    this.flashMesh.visible = false;
    this.irisMesh = new Mesh(
      new PlaneGeometry(STAGE_W + 0.004, STAGE_H + 0.004),
      new ShaderMaterial({
        uniforms: { uOpen: { value: 1 } },
        vertexShader: 'varying vec2 vUv;\nvoid main() {\n  vUv = uv;\n  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);\n}',
        // black everywhere but a circle; at uOpen = 1 the circle is wider than the frame's diagonal
        fragmentShader:
          'uniform float uOpen;\nvarying vec2 vUv;\nvoid main() {\n  vec2 p = (vUv - 0.5) * vec2(1.7778, 1.0);\n  if (length(p) < uOpen * 1.03) discard;\n  gl_FragColor = vec4(0.012, 0.01, 0.009, 1.0);\n}',
        toneMapped: false,
      }),
    );
    this.irisMesh.position.set(0, STAGE_H / 2, 0.003);
    this.irisMesh.renderOrder = 2;
    this.irisMesh.visible = false;
    this.irisMesh.name = 'iris';
    this.group.add(this.flashMesh, this.irisMesh, this.titleMesh, this.cueMesh);
  }

  /** Make the whole theatre larger or smaller (its light is worked out in stage space, so nothing else changes). */
  setSize(s: number): void {
    this.size = s;
    this.group.scale.setScalar(s);
    // at wall size the cards keep a readable size instead of growing with the stage: an intertitle covers the middle
    // of the opening, and the cue card stands on the stage's front edge instead of hanging below it
    const wall = s > 1.6;
    this.titleMesh.scale.setScalar(wall ? 0.6 : 1);
    this.titleMesh.position.y = wall ? STAGE_H * 0.43 : STAGE_H / 2;
    this.cueScale = wall ? 1.25 / s : 1;
    this.cueMesh.position.set(0, wall ? 0.034 : -0.05, wall ? 0.02 : 0.12);
    this.cueMesh.rotation.x = wall ? -0.1 : -0.25;
  }

  get scale(): number {
    return this.size;
  }

  /** The proscenium model; the theatre works (box and curtain) before it arrives. */
  async init(frameUrl: string): Promise<void> {
    if (this.frameLoaded) return;
    this.frameLoaded = true;
    try {
      const gltf = await loadGLB(frameUrl);
      const frame = gltf.scene.clone(true);
      frame.name = 'proscenium';
      frame.scale.setScalar(FRAME_SCALE);
      // the model's opening starts 0.055 above its base and its back face sits 0.015 behind its origin
      frame.position.set(0, -0.055 * FRAME_SCALE, 0.03);
      // the frame is lit by whatever room it stands in; a little light of its own keeps its wood readable in a dark one
      frame.traverse((o) => {
        const m = (o as Mesh).material as MeshStandardMaterial | undefined;
        if (!(o as Mesh).isMesh || !m || !('emissive' in m)) return;
        const lit = m.clone();
        lit.emissive.copy(lit.map ? WHITE : lit.color).multiplyScalar(0.42);
        lit.emissiveMap = lit.map;
        (o as Mesh).material = lit;
      });
      this.group.add(frame);
      const box = new Box3().setFromObject(frame);
      console.log('FRAME', [box.min.x, box.max.x, box.min.y, box.max.y, box.min.z, box.max.z].map((v) => v.toFixed(3)).join(' '));
    } catch (e) {
      console.warn('THEATRE frame failed', e instanceof Error ? e.message : e);
    }
  }

  private sky(kind: Sky): Texture {
    let t = this.skies.get(kind);
    if (!t) {
      t = backdropTexture(kind);
      this.skies.set(kind, t);
    }
    return t;
  }

  setSky(kind: Sky): void {
    this.cyc.map = this.sky(kind);
    this.cyc.needsUpdate = true;
  }

  /** The film stock of the scene. An interior keeps its darkness whatever the tint. */
  setTint(tint: TintName): void {
    setTint(tint);
    this.tint = tint;
    const inside = this.info.kind === 'interior';
    if (inside) this.setSky('dark');
    else this.setSky(tint === 'blue' ? 'night' : tint === 'red' ? 'dusk' : tint === 'green' ? 'night' : (this.info.sky ?? 'day') === 'night' ? 'day' : (this.info.sky ?? 'day'));
    // night and indoor scenes are lit low, so the lamps and the colour that comes back have something to do
    const [sky, ground, key] = LIGHTS[tint][inside ? 'in' : 'out'];
    film.sky.value.setHex(sky);
    film.ground.value.setHex(ground);
    film.keyCol.value.setHex(key);
  }

  private clearSet(): void {
    if (this.setRoot) this.stage.remove(this.setRoot);
    this.setRoot = null;
    if (this.road) this.stage.remove(this.road.root);
    this.road = null;
    this.dynamics.clear();
    for (const l of this.lamps) {
      this.stage.remove(l.glow);
      l.glow.material.dispose();
    }
    this.lamps.length = 0;
    this.scroll = 0;
    this.raining = false;
    this.fx?.clear();
  }

  /** Fetch a set's model ahead of time (a later scene of the reel that is playing). */
  preloadSet(id: string): void {
    if (id === 'road' || id.startsWith('road-')) {
      const theme = id === 'road' ? 'road' : id.slice(5);
      Road.preload(this.base, theme === 'forest' || theme === 'village' ? theme : 'road');
    } else void loadGLB(`${this.base}sets/${id}.glb`).catch(() => null);
  }

  /** Swap the set. Call with the curtain closed. `road`, `road-forest` and `road-village` are the endless road. */
  async loadSet(id: string): Promise<SetInfo> {
    this.clearSet();
    if (id === 'road' || id.startsWith('road-')) {
      const theme = (id === 'road' ? 'road' : id.slice(5)) as RoadTheme;
      const road = new Road(this.base, theme === 'forest' || theme === 'village' ? theme : 'road');
      await road.build();
      this.road = road;
      this.stage.add(road.root);
      this.info = { id, marks: ROAD_MARKS, kind: 'exterior' };
      console.log('SET', id, 'road');
      return this.info;
    }
    let file: SetFile = {};
    try {
      const res = await fetch(`${this.base}sets/${id}.json`);
      if (res.ok) file = (await res.json()) as SetFile;
    } catch {
      // default marks
    }
    const marks = { ...DEFAULT_MARKS, ...COMMON_MARKS, ...(file.marks ?? {}) };
    // the spots beside the door and the window, from where a knock or a leap can be seen
    if (!file.marks?.door_side) marks.door_side = [Math.min(5.4, marks.door[0] + 1.55), marks.door[1] - 0.15];
    if (!file.marks?.window_side) marks.window_side = [Math.max(-5.4, marks.window[0] - 1.5), marks.window[1] + 0.6];
    Object.assign(marks, MARK_FIXES[id] ?? {});
    this.info = { id, marks, kind: file.kind, sky: file.sky };
    try {
      const gltf = await loadGLB(`${this.base}sets/${id}.glb`);
      const root = gltf.scene.clone(true);
      root.name = `set-${id}`;
      filmify(root);
      for (const [name, d] of Object.entries(file.dynamic ?? {})) {
        const node = root.getObjectByName(d.node ?? name);
        if (!node) continue;
        const base = d.baseQuaternion ? new Quaternion(...d.baseQuaternion) : node.quaternion.clone();
        this.dynamics.set(name, { node, base, axis: new Vector3(...(d.axis ?? [0, 1, 0])).normalize(), open: d.open ?? -1.75, cur: 0, want: 0 });
      }
      this.setRoot = root;
      this.stage.add(root);
    } catch (e) {
      console.warn('THEATRE set failed', id, e instanceof Error ? e.message : e);
    }
    // the set's own lamps: the strongest few torches, candles and fires
    const lamps = (file.lights ?? [])
      .filter((l) => l.kind !== 'key' && l.kind !== 'fill' && l.kind !== 'ambient')
      .sort((a, b) => (b.intensity ?? 0) - (a.intensity ?? 0))
      .slice(0, MAX_LAMPS);
    for (const l of lamps) this.addLamp(l.pos, l.color ?? '#ffa040', (l.intensity ?? 1) * (l.kind === 'fire' ? 7 : 4.6));
    // the air of the place: embers over its fires, mist among the graves, dust in the light of a room
    if (this.fx) {
      for (const l of file.lights ?? []) if (l.kind === 'fire' || l.name?.startsWith('brazier')) this.fx.embers(l.pos[0], Math.max(0.3, l.pos[1] - 0.5), l.pos[2] + 0.25, true);
      if (id === 'graveyard') this.fx.fog(0.85);
      else if (id === 'camp') this.fx.fog(0.3);
      if (file.kind === 'interior') this.fx.motes(true);
    }
    console.log('SET', id, Object.keys(this.info.marks).length, 'marks', [...this.dynamics.keys()].join(',') || 'nothing moves', this.lamps.length, 'lamps');
    return this.info;
  }

  private addLamp(pos: [number, number, number], color: string, power: number): void {
    const colour = new Color(color).lerp(WHITE, 0.25); // the kit's lamp colours are very saturated
    if (!this.glowMap) this.glowMap = glowTexture();
    const glow = new Sprite(new SpriteMaterial({ toneMapped: false, map: this.glowMap, color: colour, transparent: true, blending: AdditiveBlending, depthWrite: false }));
    glow.position.set(pos[0], pos[1] + 0.25, pos[2] + 0.35);
    glow.scale.setScalar(1.7);
    glow.renderOrder = 1;
    // the light itself stands a little in front of the flame, so the wall behind a torch is lit rather than grazed
    this.lamps.push({ pos: new Vector3(pos[0], pos[1] + 0.2, pos[2] + 0.9), glow, power, colour, phase: this.lamps.length * 1.7 });
    this.stage.add(glow);
  }

  get set(): SetInfo {
    return this.info;
  }

  mark(name: string): [number, number] {
    return this.info.marks[name] ?? DEFAULT_MARKS[name] ?? [0, 0];
  }

  /** Where to look to look AT a part of the set: the door's leaf is in the back wall behind its mark. */
  lookAt(name: string): [number, number] {
    const [x, z] = this.mark(name);
    return name === 'door' || name === 'window' ? [x, BACK_Z - 0.3] : [x, z];
  }

  addActor(a: Actor): void {
    this.stage.add(a.root);
    a.onStage = true;
  }

  removeActor(a: Actor): void {
    this.stage.remove(a.root);
    a.onStage = false;
  }

  // ---- things that take time

  curtain(open: boolean): Task {
    return {
      update: () => {
        if (this.wantCurtain !== (open ? 1 : 0)) this.onSound?.('curtain');
        this.wantCurtain = open ? 1 : 0;
        return Math.abs(this.curtainOpen - this.wantCurtain) < 0.02;
      },
    };
  }

  get isOpen(): boolean {
    return this.curtainOpen > 0.9;
  }

  /** Close the picture to a point, or open it from one (a scene change inside a reel; the curtain is for reels). */
  iris(open: boolean): Task {
    return {
      update: () => {
        this.wantIris = open ? 1 : 0;
        return Math.abs(this.irisOpen - this.wantIris) < 0.01;
      },
    };
  }

  /** An intertitle over the whole opening. */
  title(text: string, sub = '', secs = 2.8): Task {
    let left = secs;
    let started = false;
    return {
      update: (dt) => {
        if (!started) {
          started = true;
          const m = this.titleMesh.material as MeshBasicMaterial;
          m.map = titleCard(text, sub);
          m.needsUpdate = true;
          this.wantTitle = 1;
          console.log('TITLE', text, sub ? `| ${sub}` : '');
        }
        left -= dt;
        if (left <= 0) {
          this.wantTitle = 0;
          return this.titleShow < 0.05;
        }
        return false;
      },
      cancel: () => {
        this.wantTitle = 0;
      },
    };
  }

  /** A card that stays up until `hideCard`: the choice between reels, or a line while the Director writes. */
  showChoice(prompt: string, options: { prop: PropId; text: string }[], footer = ''): void {
    const m = this.titleMesh.material as MeshBasicMaterial;
    m.map = choiceCard(prompt, options, footer);
    m.needsUpdate = true;
    this.wantTitle = 1;
  }

  showCard(text: string, sub = ''): void {
    const m = this.titleMesh.material as MeshBasicMaterial;
    m.map = titleCard(text, sub);
    m.needsUpdate = true;
    this.wantTitle = 1;
  }

  hideCard(): void {
    this.wantTitle = 0;
  }

  showCue(prop: PropId | null, label: string, pips = ''): void {
    const m = this.cueMesh.material as MeshBasicMaterial;
    m.map = cueCard(prop, pips ? `${label}  ${pips}` : label);
    m.needsUpdate = true;
    this.wantCue = 1;
  }

  hideCue(): void {
    this.wantCue = 0;
  }

  /** Swing a hinged part of the set (a door, a chest lid). A door swings away from the audience unless `toward`. */
  setDynamic(name: string, open: boolean, toward = false): void {
    const d = this.dynamics.get(name);
    if (!d) return;
    if (open && name === 'door') d.open = (toward ? -1 : 1) * Math.abs(d.open);
    if (open && d.want === 0) this.onSound?.('creak');
    d.want = open ? 1 : 0;
  }

  setDoor(open: boolean): void {
    this.setDynamic('door', open);
  }

  get doorOpen(): boolean {
    return (this.dynamics.get('door')?.want ?? 0) > 0.5;
  }

  /** Colour bleeds into the film as cues land: 0 monochrome, 1 the kit's own colours. */
  setColour(amount: number): void {
    this.wantColour = Math.max(0, Math.min(1, amount));
  }

  /** Burst to the size of the wall, under cover of a lightning flash; or come back to the desk. */
  grow(big = true): void {
    if (big === this.bigNow || (big && !this.allowBig)) return;
    this.bigNow = big;
    this.flash = 1;
    this.onScale?.(big);
  }

  get isBig(): boolean {
    return this.bigNow;
  }

  /** A sound was made: the picture blooms with colour for a moment. */
  pulse(): void {
    this.bloom = 0.45;
  }

  lightning(): void {
    this.flash = 1;
  }

  /** A storm breaks over the scene (or passes). Rain falls only under the sky; a room keeps it outside. */
  storm(on: boolean): void {
    this.raining = on;
    this.fx?.rain(on && this.info.kind !== 'interior');
  }

  get storming(): boolean {
    return this.raining;
  }

  /** Steel on steel, a puff from the boards, breaking glass, the paper at a reel's end. Places are in stage units. */
  burst(kind: Burst, x = 0, y = 0, z = 0, amount = 1, drift = 0): void {
    const fx = this.fx;
    if (!fx) return;
    if (kind === 'sparks') fx.sparks(x, y, z, Math.round(16 * amount));
    else if (kind === 'dust') fx.dust(x, z, amount, drift);
    else if (kind === 'shards') fx.shards(x, y, z);
    else fx.confetti();
  }

  /** How bright the lightning is right now, 0..1 (the room around the theatre flashes with it). */
  get flashLevel(): number {
    return this.flash;
  }

  /** 0 with the curtain shut, 1 with it open. */
  get curtainLevel(): number {
    return this.curtainOpen;
  }

  quake(): void {
    this.shake = 1;
  }

  emote(actor: Actor, emote: Emote): void {
    const s = new Sprite(new SpriteMaterial({ toneMapped: false, map: emoteCard(emote), transparent: true, depthWrite: false }));
    actor.head(s.position);
    s.scale.setScalar(1.5);
    s.renderOrder = 8;
    this.stage.add(s);
    this.floaters.push({ sprite: s, life: 1.7, total: 1.7, rise: 0.5, base: 1.5 });
  }

  /** Every sound is seen as well as heard: a comic word bursts at the foot of the stage. */
  soundWord(prop: PropId, kind?: string): void {
    const s = new Sprite(new SpriteMaterial({ toneMapped: false, map: wordCard(soundWordFor(prop, kind)), transparent: true, depthWrite: false, depthTest: false }));
    const side = this.floaters.length % 2 ? 1 : -1;
    s.position.set(side * (3.3 + Math.random() * 1.4), 0.7 + Math.random() * 0.9, FRONT_Z + 0.3);
    s.scale.set(3.0, 1.15, 1);
    s.renderOrder = 21;
    this.stage.add(s);
    this.floaters.push({ sprite: s, life: 0.9, total: 0.9, rise: 0.9, base: 3.4 });
  }

  update(dt: number): void {
    this.time += dt;
    const ease = (cur: number, want: number, rate: number) => cur + (want - cur) * Math.min(1, rate * dt);
    // curtain: the halves gather to a tenth of their width
    this.curtainOpen = ease(this.curtainOpen, this.wantCurtain, 2.6);
    const sx = 1 - this.curtainOpen * 0.9;
    for (const c of this.curtains) c.scale.x = sx;
    // cards
    this.titleShow = ease(this.titleShow, this.wantTitle, 7);
    (this.titleMesh.material as MeshBasicMaterial).opacity = this.titleShow;
    this.titleMesh.visible = this.titleShow > 0.01;
    this.cueShow = ease(this.cueShow, this.wantCue, 8);
    (this.cueMesh.material as MeshBasicMaterial).opacity = this.cueShow;
    this.cueMesh.visible = this.cueShow > 0.01;
    this.cueMesh.scale.setScalar(this.cueScale * (1 + 0.04 * Math.sin(this.time * 6) * this.cueShow)); // it breathes while it waits
    // the iris closes and opens at a steady pace (an eased one looks like a camera, not a film)
    if (this.irisOpen !== this.wantIris) {
      const step = dt * 1.9;
      this.irisOpen = this.wantIris > this.irisOpen ? Math.min(1, this.irisOpen + step) : Math.max(0, this.irisOpen - step);
      (this.irisMesh.material as ShaderMaterial).uniforms.uOpen.value = this.irisOpen;
    }
    this.irisMesh.visible = this.irisOpen < 0.999;
    // doors and lids
    for (const d of this.dynamics.values()) {
      if (Math.abs(d.cur - d.want) < 1e-3) continue;
      d.cur = ease(d.cur, d.want, 6);
      d.node.quaternion.copy(d.base).multiply(tmpQ.setFromAxisAngle(d.axis, d.open * d.cur));
    }
    // the road
    this.road?.update(dt, this.scroll * GALLOP_SPEED);
    this.fx?.update(dt);
    // film colour: a faded print that every landed cue restores; each sound makes it bloom for a moment,
    // and the actors always keep more of theirs than the scenery
    this.colourNow = ease(this.colourNow, this.wantColour, 1.6);
    this.bloom = Math.max(0, this.bloom - dt * 1.8);
    film.colour.value = Math.min(1, 0.3 + 0.7 * this.colourNow + this.bloom);
    film.actorColour.value = 0.55 + 0.45 * film.colour.value;
    // the wings: the film shader drops what lies beyond them
    this.stage.updateWorldMatrix(true, false);
    film.stageInv.value.copy(this.stage.matrixWorld).invert();
    film.clip.value = CLIP_X;
    film.clipFront.value = FRONT_Z + 0.5;
    // lamps flicker; in a monochrome film their glow is the tint's
    for (let i = 0; i < MAX_LAMPS; i++) {
      const l = this.lamps[i];
      if (!l) {
        film.lampCol.value[i].setRGB(0, 0, 0);
        continue;
      }
      const f = 0.86 + 0.1 * Math.sin(this.time * 9 + l.phase) + 0.06 * Math.sin(this.time * 23 + l.phase * 2);
      film.lampPos.value[i].copy(l.pos);
      film.lampCol.value[i].copy(l.colour).multiplyScalar(l.power * f);
      const m = l.glow.material;
      tmpC.copy(film.tint.value).multiplyScalar(0.8);
      m.color.copy(tmpC).lerp(l.colour, film.colour.value);
      m.opacity = 0.55 * f;
    }
    // lightning and quake
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt * 3.2);
      const f = this.flash * (0.6 + 0.4 * Math.sin(this.time * 70));
      (this.flashMesh.material as MeshBasicMaterial).opacity = f * 0.55;
      this.flashMesh.visible = f > 0.01;
      film.flash.value = f;
    }
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt * 2.4);
      this.stage.position.x = Math.sin(this.time * 61) * 0.004 * this.shake;
      this.stage.position.y = FRONT_Z * KIT * Math.sin(RAKE) + Math.sin(this.time * 47) * 0.003 * this.shake;
    }
    // floaters
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      f.life -= dt;
      const m = f.sprite.material;
      m.opacity = f.life < 0.3 ? Math.max(0, f.life / 0.3) : 1;
      f.sprite.position.y += f.rise * dt;
      if (f.life <= 0) {
        this.stage.remove(f.sprite);
        m.dispose(); // the card's texture is kept for the next time
        this.floaters.splice(i, 1);
      }
    }
  }

  /** World position of a mark, for anything outside the stage group that wants to point at it. */
  markWorld(name: string, out = new Vector3()): Vector3 {
    const [x, z] = this.mark(name);
    return this.stage.localToWorld(out.set(x, 0, z));
  }
}

const tmpQ = new Quaternion();
const tmpC = new Color();
const WHITE = new Color(1, 1, 1);
