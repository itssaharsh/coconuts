// Stage effects: rain, snow, sparks, dust, broken glass, motes, mist, embers and confetti, in at most four draws
// whatever is on. Everything lives in stage space (kit units) under the theatre's stage group and is lit and graded by
// the film's own rules (the wash, the key, the lamps, the fade to tinted monochrome, the lightning), so an effect sits
// in the picture instead of on it; and everything stops at the wings. Points size themselves from the eye buffer's
// height and the stage's scale, so a spark is the same spark at desk size and at wall size, in either eye.
// Nothing here reads a clock or Math.random: the show moves by update(dt) and one seeded generator, so a stepped
// capture plays the same every time.
import {
  AdditiveBlending,
  type Blending,
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  DoubleSide,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  NormalBlending,
  type Object3D,
  Points,
  RedFormat,
  RepeatWrapping,
  ShaderMaterial,
  Vector4,
  type WebGLRenderer,
} from 'three';
import { film, MAX_LAMPS } from './film';

/** Hard caps: no effect ever holds more than this, however often it is called. */
export const CAPS = { rain: 600, sparks: 150, shards: 60, embers: 150, motes: 120, snow: 150, dust: 120, confetti: 150 } as const;
const MAX_EMBERS = 4;
/** The rain starts above the pelmet, out of sight. */
const RAIN_TOP = 7;

/** A small seeded generator (mulberry32): the same seed gives the same show. */
export function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One kind's particles: a fixed number of slots, never grown. A spawn takes a free slot, or when there is none the
 * one nearest its end, so a flood of calls recycles instead of allocating. `s` holds four spare numbers a slot.
 */
export class Pool {
  readonly p: Float32Array;
  readonly v: Float32Array;
  readonly age: Float32Array;
  /** Seconds the particle lives; 0 is a free slot. */
  readonly life: Float32Array;
  readonly s: Float32Array;
  live = 0;
  private cursor = 0;

  constructor(readonly cap: number) {
    this.p = new Float32Array(cap * 3);
    this.v = new Float32Array(cap * 3);
    this.age = new Float32Array(cap);
    this.life = new Float32Array(cap);
    this.s = new Float32Array(cap * 4);
  }

  spawn(life: number): number {
    let at = 0;
    let left = Infinity;
    for (let n = 0; n < this.cap; n++) {
      const i = (this.cursor + n) % this.cap;
      if (this.life[i] <= 0) {
        at = i;
        left = -1;
        break;
      }
      const l = this.life[i] - this.age[i];
      if (l < left) {
        left = l;
        at = i;
      }
    }
    if (left === -1) this.live++;
    this.cursor = (at + 1) % this.cap;
    this.age[at] = 0;
    this.life[at] = Math.max(1e-3, life);
    this.v.fill(0, at * 3, at * 3 + 3);
    return at;
  }

  /** Age every particle and free the ones past their life. */
  tick(dt: number): void {
    if (!this.live) return;
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) continue;
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) this.free(i);
    }
  }

  free(i: number): void {
    if (this.life[i] <= 0) return;
    this.life[i] = 0;
    this.live--;
  }

  clear(): void {
    this.life.fill(0);
    this.live = 0;
    this.cursor = 0;
  }
}

// ---- shaders

/** The film's light and grade, for a speck of air instead of a surface (it has no face to turn to the key). */
const GRADE = `
uniform mat4 uStageInv;
uniform float uFilmColour;
uniform vec3 uFilmTint;
uniform vec3 uSky;
uniform vec3 uGround;
uniform vec3 uKeyCol;
uniform vec3 uLampPos[${MAX_LAMPS}];
uniform vec3 uLampCol[${MAX_LAMPS}];
uniform float uFlash;
uniform float uViewportHeight;
const vec3 LUMA = vec3(0.30, 0.59, 0.11);
// lit 0: a thing that shines (a spark); lit 1: a thing seen by the stage's light (a flake, a mote)
vec3 filmGrade(vec3 base, vec3 sp, float lit) {
  vec3 wash = mix(uGround, uSky, 0.65) + uKeyCol * 0.45;
  wash *= 1.0 - 0.3 * smoothstep(3.5, 7.0, abs(sp.x));
  vec3 lamp = vec3(0.0);
  for (int i = 0; i < ${MAX_LAMPS}; i++) {
    vec3 d = uLampPos[i] - sp;
    lamp += uLampCol[i] * 0.55 / (dot(d, d) * 1.3 + 0.5);
  }
  wash = mix(vec3(1.0), wash + vec3(uFlash * 1.6), lit);
  lamp *= lit;
  vec3 c = base * wash;
  vec3 w = base * lamp;
  return mix(vec3(dot(c, LUMA)) * 1.08 * uFilmTint, c, uFilmColour) + mix(vec3(dot(w, LUMA)) * vec3(1.0, 0.74, 0.42), w, max(uFilmColour, 0.55));
}
// eye-buffer pixels per view-space unit at this depth (each eye has its own projection)
float pxPerUnit(float viewZ) {
  return projectionMatrix[1][1] * 0.5 * uViewportHeight / max(-viewZ, 1e-3);
}
`;

const CLIP = `
uniform float uStageClip;
uniform float uStageFront;
varying vec3 vStage;
`;

// Every speck is a capsule drawn inside its point: a dot when it has no length, a streak along its motion, a sliver
// of glass or a scrap of paper turning in the light. The point grows to hold the capsule.
const POINT_VERT = `${GRADE}
#define MAX_POINT 256.0
attribute vec4 aColor;
attribute vec3 aDir;
attribute vec4 aShape; // width (kit units), softness, taper, lit
varying vec4 vColor;
varying vec3 vSeg;
varying vec2 vStyle;
varying vec3 vStage;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vStage = (uStageInv * modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * mv;
  float ppu = pxPerUnit(mv.z);
  float w = aShape.x * length(modelMatrix[0].xyz) * ppu;
  vec2 seg = (modelViewMatrix * vec4(aDir, 0.0)).xy * ppu;
  // a speck under a pixel and a half shimmers in a headset: it keeps that size and gives up light instead
  float fade = clamp(w / 1.5, 0.0, 1.0);
  w = max(w, 1.5);
  float natural = length(seg) + w + 2.0;
  float size = min(natural, MAX_POINT);
  float k = size / natural;
  gl_PointSize = size;
  vSeg = vec3(seg * k / size, 0.5 * w * k / size);
  vColor = vec4(filmGrade(aColor.rgb, vStage, aShape.w), aColor.a * fade);
  vStyle = aShape.yz;
  if (aColor.a <= 0.0) {
    gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
    gl_PointSize = 0.0;
  }
}`;

const POINT_FRAG = `${CLIP}
varying vec4 vColor;
varying vec3 vSeg;
varying vec2 vStyle;
void main() {
  if (abs(vStage.x) > uStageClip || vStage.z > uStageFront) discard;
  vec2 p = vec2(gl_PointCoord.x - 0.5, 0.5 - gl_PointCoord.y);
  vec2 ba = vSeg.xy;
  vec2 pa = p + 0.5 * ba;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
  float d = length(pa - ba * h) / vSeg.z;
  if (d >= 1.0) discard;
  float hard = 1.0 - smoothstep(0.55, 1.0, d);
  float soft = exp(-3.0 * d * d) * (1.0 - d * d);
  // a spark is brightest at its head
  float a = mix(hard, soft, vStyle.x) * mix(1.0, 0.15 + 0.85 * h, vStyle.y);
  gl_FragColor = vec4(vColor.rgb, vColor.a * a);
  #include <colorspace_fragment>
}`;

// The rain is worked out on the GPU from a seed per drop and the show's time: no buffer moves, and a drop is a streak
// while it falls and a ring on the boards when it lands.
const RAIN_VERT = `${GRADE}
#define TOP ${RAIN_TOP.toFixed(1)}
#define SLANT 0.2
attribute vec4 aSeed; // x, z, phase, speed
uniform float uTime;
uniform float uAmount;
varying vec2 vUv;
varying float vAlpha;
varying float vRing;
varying vec3 vColor;
varying vec3 vStage;
void main() {
  float r = aSeed.w;
  float speed = 12.0 + 4.0 * r;
  float fall = TOP / speed;
  float splash = 0.26;
  float cyc = fall + splash + 0.25 * fract(r * 13.7);
  float c = uTime / cyc + aSeed.z;
  float t = fract(c) * cyc;
  // each drop lands somewhere new, so the rings do not keep hitting the same spots
  vec2 xz = fract(aSeed.xy + floor(c) * vec2(0.618034, 0.754878));
  vec3 land = vec3(mix(-7.0, 7.0, xz.x), 0.0, mix(-3.7, 3.4, xz.y));
  // lighter rain is fewer drops, not fainter ones
  float on = step(fract(r * 7.31 + aSeed.x * 3.7), uAmount);
  // both shapes are worked out and one is kept (no branches: cheaper on a tiled GPU, and the same on every driver)
  float falling = step(t, fall);
  float y = max(TOP - speed * t, 0.0);
  vec3 head = land + vec3(SLANT * y, y, 0.0);
  vec3 tail = head + vec3(SLANT, 1.0, 0.0) * (speed * 0.045);
  vec3 streak = mix(tail, head, position.y + 0.5);
  float s = clamp((t - fall) / splash, 0.0, 1.0);
  float rad = 0.05 + 0.2 * sqrt(s);
  vec3 ring = land + vec3(position.x * 2.0 * rad, 0.04, position.y * 2.0 * rad);
  vec3 p = mix(ring, streak, falling);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  // a streak is widened across its own direction on screen, and never drawn thinner than about a pixel
  vec2 d = (modelViewMatrix * vec4(head - tail, 0.0)).xy;
  d /= max(length(d), 1e-6);
  float least = 1.1 / pxPerUnit(mv.z);
  float wv = 0.024 * length(modelMatrix[0].xyz);
  mv.xy += vec2(-d.y, d.x) * (position.x * max(wv, least) * falling);
  vAlpha = mix(1.0 - s, min(1.0, wv / least), falling) * on * smoothstep(0.0, 0.6, uAmount);
  vRing = 1.0 - falling;
  vUv = position.xy * 2.0;
  vStage = (uStageInv * modelMatrix * vec4(p, 1.0)).xyz;
  vColor = filmGrade(vec3(0.78, 0.84, 0.95), vStage, 0.6);
  gl_Position = mix(vec4(0.0, 0.0, -2.0, 1.0), projectionMatrix * mv, on);
}`;

const RAIN_FRAG = `${CLIP}
varying vec2 vUv;
varying float vAlpha;
varying float vRing;
varying vec3 vColor;
void main() {
  if (abs(vStage.x) > uStageClip || vStage.z > uStageFront) discard;
  float a;
  if (vRing > 0.5) {
    float d = length(vUv);
    a = smoothstep(0.55, 0.82, d) * (1.0 - smoothstep(0.82, 1.0, d)) * 0.6;
  } else {
    a = (1.0 - abs(vUv.x)) * (0.2 + 0.8 * (vUv.y * 0.5 + 0.5)) * 0.55;
  }
  gl_FragColor = vec4(vColor, vAlpha * a);
  #include <colorspace_fragment>
}`;

// The mist: a few gauze sheets standing across the stage, thickest just off the boards, drifting at their own pace.
// They are lit per vertex (a fine grid), so a lantern warms the mist around it without any work per pixel.
const FOG_VERT = `${GRADE}
attribute float aLayer;
varying vec2 vUv;
varying vec3 vColor;
varying float vLayer;
varying vec3 vStage;
void main() {
  vStage = (uStageInv * modelMatrix * vec4(position, 1.0)).xyz;
  // mist holds a little light of its own (the moon's), or at night it would be a darker dark
  vColor = filmGrade(vec3(0.8, 0.83, 0.9), vStage, 0.72);
  vUv = uv;
  vLayer = aLayer;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FOG_FRAG = `${CLIP}
uniform sampler2D uNoise;
uniform float uTime;
uniform float uAmount;
varying vec2 vUv;
varying vec3 vColor;
varying float vLayer;
void main() {
  if (abs(vStage.x) > uStageClip || vStage.z > uStageFront) discard;
  // rising off the boards (no hard line where a sheet meets the floor) and thinning upward
  float body = smoothstep(0.0, 0.22, vUv.y) * (1.0 - smoothstep(0.2, 1.0, vUv.y));
  float drift = uTime * (0.012 + 0.008 * vLayer) * (mod(vLayer, 2.0) < 0.5 ? 1.0 : -1.0);
  float n1 = texture2D(uNoise, vec2(vStage.x * 0.055 + drift + vLayer * 0.31, vUv.y * 0.22 + vLayer * 0.37)).r;
  float n2 = texture2D(uNoise, vec2(vStage.x * 0.13 - uTime * 0.017 + vLayer * 0.53, vUv.y * 0.45 - uTime * 0.006)).r;
  float n = smoothstep(0.12, 0.8, n1 * 0.7 + n2 * 0.45);
  // it thins out toward the wings: the far sheets end inside the opening, and a sheet must not show its edge
  float wing = 1.0 - smoothstep(uStageClip - 2.4, uStageClip - 0.2, abs(vStage.x));
  gl_FragColor = vec4(vColor, uAmount * body * n * wing * 0.8);
  #include <colorspace_fragment>
}`;

// ---- the draws

interface Look {
  r: number;
  g: number;
  b: number;
  a: number;
  dx: number;
  dy: number;
  dz: number;
  width: number;
  soft: number;
  taper: number;
  lit: number;
}

/** One Points draw holding several kinds side by side, each in its own range of the buffer. */
class Batch {
  readonly points: Points<BufferGeometry, ShaderMaterial>;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly dir: Float32Array;
  private readonly shape: Float32Array;
  private readonly attrs: BufferAttribute[];
  /** Something in this draw is alive this frame. */
  any = false;

  constructor(cap: number, material: ShaderMaterial, name: string) {
    this.pos = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 4);
    this.dir = new Float32Array(cap * 3);
    this.shape = new Float32Array(cap * 4);
    const g = new BufferGeometry();
    this.attrs = [
      new BufferAttribute(this.pos, 3),
      new BufferAttribute(this.col, 4),
      new BufferAttribute(this.dir, 3),
      new BufferAttribute(this.shape, 4),
    ];
    ['position', 'aColor', 'aDir', 'aShape'].forEach((n, i) => g.setAttribute(n, this.attrs[i].setUsage(DynamicDrawUsage)));
    this.points = new Points(g, material);
    this.points.name = name;
    this.points.frustumCulled = false; // its bounds change every frame; it is one draw either way
    this.points.visible = false;
  }

  put(i: number, x: number, y: number, z: number, l: Look): void {
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.col[i * 4] = l.r;
    this.col[i * 4 + 1] = l.g;
    this.col[i * 4 + 2] = l.b;
    this.col[i * 4 + 3] = l.a;
    this.dir[i * 3] = l.dx;
    this.dir[i * 3 + 1] = l.dy;
    this.dir[i * 3 + 2] = l.dz;
    this.shape[i * 4] = l.width;
    this.shape[i * 4 + 1] = l.soft;
    this.shape[i * 4 + 2] = l.taper;
    this.shape[i * 4 + 3] = l.lit;
    if (l.a > 0) this.any = true;
  }

  hide(i: number): void {
    this.col[i * 4 + 3] = 0;
  }

  /** Upload what moved; a draw with nothing alive is not drawn at all. */
  flush(force = false): void {
    this.points.visible = this.any || force;
    if (this.any) for (const a of this.attrs) a.needsUpdate = true;
    this.any = false;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.points.material.dispose();
  }
}

interface Kind {
  pool: Pool;
  batch: Batch;
  base: number;
}

interface Emitter {
  x: number;
  y: number;
  z: number;
  acc: number;
}

const CONFETTI: [number, number, number][] = [
  [0.95, 0.24, 0.22],
  [0.98, 0.78, 0.22],
  [0.26, 0.52, 0.95],
  [0.32, 0.8, 0.42],
  [0.95, 0.48, 0.74],
  [0.98, 0.96, 0.9],
];

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const approach = (cur: number, want: number, step: number) => (cur < want ? Math.min(want, cur + step) : Math.max(want, cur - step));
const smooth = (t: number) => t * t * (3 - 2 * t);

/** Tileable cloud noise for the mist, made from the seeded generator (no canvas, so it is the same everywhere). */
function mistTexture(rand: () => number): DataTexture {
  const N = 128;
  const acc = new Float32Array(N * N);
  let amp = 1;
  for (const f of [4, 8, 16, 32]) {
    const grid = new Float32Array(f * f).map(() => rand());
    const at = (i: number, j: number) => grid[(j % f) * f + (i % f)];
    for (let y = 0; y < N; y++) {
      const fy = (y / N) * f;
      const y0 = Math.floor(fy);
      const ty = smooth(fy - y0);
      for (let x = 0; x < N; x++) {
        const fx = (x / N) * f;
        const x0 = Math.floor(fx);
        const tx = smooth(fx - x0);
        const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
        const bot = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
        acc[y * N + x] += (top + (bot - top) * ty) * amp;
      }
    }
    amp *= 0.5;
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of acc) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const data = new Uint8Array(N * N);
  for (let i = 0; i < data.length; i++) data[i] = Math.round(((acc[i] - lo) / (hi - lo)) * 255);
  const t = new DataTexture(data, N, N, RedFormat);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.magFilter = LinearFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/** Three gauze sheets across the stage, each a fine grid so the lamps can light it per vertex. */
function mistGeometry(): BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const layer: number[] = [];
  const index: number[] = [];
  const SX = 28;
  const SY = 4;
  const sheets: [number, number][] = [
    [2.7, 1.5], // z, height
    [0.3, 1.8],
    [-2.2, 2.1],
  ];
  sheets.forEach(([z, h], l) => {
    const first = pos.length / 3;
    for (let j = 0; j <= SY; j++) {
      for (let i = 0; i <= SX; i++) {
        const u = i / SX;
        const v = j / SY;
        pos.push(-7.2 + 14.4 * u, v * h, z);
        uv.push(u, v);
        layer.push(l);
      }
    }
    for (let j = 0; j < SY; j++) {
      for (let i = 0; i < SX; i++) {
        const a = first + j * (SX + 1) + i;
        const b = a + SX + 1;
        index.push(a, a + 1, b + 1, a, b + 1, b);
      }
    }
  });
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  g.setAttribute('aLayer', new Float32BufferAttribute(layer, 1));
  g.setIndex(index);
  return g;
}

/** The stage's weather and debris. Construct with the theatre's `stage` group (kit units); call update(dt) each frame. */
export class StageFx {
  readonly root = new Group();
  private readonly rand: () => number;
  private time = 0;
  private readonly viewport = { value: 720 };
  private pinned = false;
  private readonly glow: Batch;
  private readonly soft: Batch;
  private readonly rainMesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private readonly fogMesh: Mesh<BufferGeometry, ShaderMaterial>;
  private readonly noise: DataTexture;
  private readonly rainU = { time: { value: 0 }, amount: { value: 0 } };
  private readonly fogU = { time: { value: 0 }, amount: { value: 0 } };
  private readonly sparkK: Kind;
  private readonly shardK: Kind;
  private readonly emberK: Kind;
  private readonly moteK: Kind;
  private readonly snowK: Kind;
  private readonly dustK: Kind;
  private readonly confettiK: Kind;
  private rainNow = 0;
  private rainWant = 0;
  private snowNow = 0;
  private snowWant = 0;
  private snowAcc = 0;
  private moteNow = 0;
  private moteWant = 0;
  private moteAcc = 0;
  private fogNow = 0;
  private fogWant = 0;
  private emitters: Emitter[] = [];
  private warmFrames = 0;
  private readonly all: Kind[];
  private readonly look: Look = { r: 0, g: 0, b: 0, a: 0, dx: 0, dy: 0, dz: 0, width: 0, soft: 0, taper: 0, lit: 0 };

  constructor(
    private stage: Object3D,
    seed = 0x5eed,
  ) {
    this.rand = prng(seed);
    this.root.name = 'stage-fx';
    const base = () => ({
      uFilmColour: film.colour,
      uFilmTint: film.tint,
      uStageInv: film.stageInv,
      uStageClip: film.clip,
      uStageFront: film.clipFront,
      uSky: film.sky,
      uGround: film.ground,
      uKeyCol: film.keyCol,
      uLampPos: film.lampPos,
      uLampCol: film.lampCol,
      uFlash: film.flash,
      uViewportHeight: this.viewport,
    });
    const mat = (vertexShader: string, fragmentShader: string, blending: Blending, extra: Record<string, { value: unknown }> = {}) =>
      new ShaderMaterial({ vertexShader, fragmentShader, uniforms: { ...base(), ...extra }, transparent: true, depthWrite: false, blending, toneMapped: false, side: DoubleSide });

    // glow: things that shine or catch the light, added to the picture; soft: things with a body, laid over it
    this.glow = new Batch(CAPS.sparks + CAPS.shards + CAPS.embers + CAPS.motes, mat(POINT_VERT, POINT_FRAG, AdditiveBlending), 'fx-glow');
    this.soft = new Batch(CAPS.snow + CAPS.dust + CAPS.confetti, mat(POINT_VERT, POINT_FRAG, NormalBlending), 'fx-soft');
    let at = 0;
    const kind = (batch: Batch, cap: number, first: boolean): Kind => {
      if (first) at = 0;
      const k = { pool: new Pool(cap), batch, base: at };
      at += cap;
      return k;
    };
    this.sparkK = kind(this.glow, CAPS.sparks, true);
    this.shardK = kind(this.glow, CAPS.shards, false);
    this.emberK = kind(this.glow, CAPS.embers, false);
    this.moteK = kind(this.glow, CAPS.motes, false);
    this.snowK = kind(this.soft, CAPS.snow, true);
    this.dustK = kind(this.soft, CAPS.dust, false);
    this.confettiK = kind(this.soft, CAPS.confetti, false);
    this.all = [this.sparkK, this.shardK, this.emberK, this.moteK, this.snowK, this.dustK, this.confettiK];

    // rain: one quad per drop, every drop's place and pace fixed now
    const rg = new InstancedBufferGeometry();
    rg.setAttribute('position', new Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    rg.setIndex([0, 1, 2, 0, 2, 3]);
    const seeds = new Float32Array(CAPS.rain * 4).map(() => this.rand());
    rg.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 4));
    rg.instanceCount = CAPS.rain;
    this.rainMesh = new Mesh(rg, mat(RAIN_VERT, RAIN_FRAG, AdditiveBlending, { uTime: this.rainU.time, uAmount: this.rainU.amount }));
    this.rainMesh.name = 'fx-rain';

    this.noise = mistTexture(this.rand);
    this.fogMesh = new Mesh(mistGeometry(), mat(FOG_VERT, FOG_FRAG, NormalBlending, { uTime: this.fogU.time, uAmount: this.fogU.amount, uNoise: { value: this.noise } }));
    this.fogMesh.name = 'fx-mist';

    // the mist lies under everything, the glints over everything
    const order: [Object3D, number][] = [
      [this.fogMesh, 4],
      [this.soft.points, 5],
      [this.rainMesh, 6],
      [this.glow.points, 7],
    ];
    const v4 = new Vector4();
    for (const [o, r] of order) {
      o.renderOrder = r;
      o.frustumCulled = false;
      o.visible = false;
      // the eye buffer's height, read at draw time (each eye's viewport), unless the caller has said what it is
      o.onBeforeRender = (renderer: WebGLRenderer) => {
        if (!this.pinned) this.viewport.value = renderer.getCurrentViewport(v4).w || this.viewport.value;
      };
      this.root.add(o);
    }
    stage.add(this.root);
  }

  /** The height in pixels of the buffer each eye draws into. Without a call it is read from the renderer as it draws. */
  setViewport(heightPx: number): void {
    this.viewport.value = Math.max(1, heightPx);
    this.pinned = true;
  }

  // ---- the effects

  /** Slanted rain over the whole stage, rings where it lands; fades in and out over about a second. */
  rain(on: boolean, strength = 1): void {
    this.rainWant = on ? clamp01(strength) : 0;
  }

  /** Slow flakes with a little sway. */
  snow(on: boolean): void {
    if (on && this.snowWant === 0 && this.snowK.pool.live === 0) {
      // the air is already full of snow when it fades in, rather than waiting for the first flakes to come down
      for (let n = 0; n < 110; n++) this.flake(0.2 + this.rand() * (RAIN_TOP - 0.2));
    }
    this.snowWant = on ? 1 : 0;
  }

  /** Steel on steel: a short, bright burst that falls and skitters. */
  sparks(x: number, y: number, z: number, count = 14): void {
    const { pool } = this.sparkK;
    const r = this.rand;
    for (let n = 0; n < Math.min(count, pool.cap); n++) {
      const i = pool.spawn(0.28 + r() * 0.3);
      const th = r() * Math.PI * 2;
      const up = 0.15 + r() * 0.95;
      const sp = 3.2 + r() * 4.5;
      const k = sp / Math.hypot(1, up);
      pool.p.set([x + (r() - 0.5) * 0.1, y + (r() - 0.5) * 0.1, z + (r() - 0.5) * 0.1], i * 3);
      pool.v.set([Math.cos(th) * k, up * k, Math.sin(th) * k * 0.6], i * 3);
      pool.s[i * 4] = r();
    }
  }

  /** A low puff at the floor: a fall, a slammed door, hooves. `drift` carries it along x (the road under a horse). */
  dust(x: number, z: number, amount = 1, drift = 0): void {
    const { pool } = this.dustK;
    const r = this.rand;
    const a = Math.max(0.2, Math.min(3, amount));
    const n = Math.min(pool.cap, Math.round(4 + 8 * a));
    for (let j = 0; j < n; j++) {
      const i = pool.spawn(1.1 + r() * 0.9);
      const th = r() * Math.PI * 2;
      const sp = (1.0 + r() * 1.6) * Math.sqrt(a);
      pool.p.set([x + Math.cos(th) * 0.25, 0.1 + r() * 0.2, z + Math.sin(th) * 0.18], i * 3);
      pool.v.set([Math.cos(th) * sp, 0.3 + r() * 0.6, Math.sin(th) * sp * 0.6], i * 3);
      pool.s[i * 4] = (0.75 + r() * 0.5) * Math.sqrt(a);
      pool.s[i * 4 + 1] = 0.85 + r() * 0.3;
      pool.s[i * 4 + 2] = drift;
    }
  }

  /** Glass breaking: a dozen tumbling glints that fall and fade. */
  shards(x: number, y: number, z: number): void {
    const { pool } = this.shardK;
    const r = this.rand;
    for (let n = 0; n < 12; n++) {
      const i = pool.spawn(1.1 + r() * 0.7);
      pool.p.set([x + (r() - 0.5) * 0.3, y + (r() - 0.5) * 0.3, z + (r() - 0.5) * 0.2], i * 3);
      pool.v.set([(r() - 0.5) * 4.2, 0.6 + r() * 2.4, -0.6 + r() * 2.2], i * 3);
      pool.s.set([(r() < 0.5 ? -1 : 1) * (6 + r() * 10), r() * 6.28, r() * 6.28, r() * 6.28], i * 4);
    }
  }

  /** Slow floating dust in the light of an interior: the air of the stage. Seen only where a lamp or the key falls. */
  motes(on: boolean): void {
    if (on && this.moteWant === 0 && this.moteK.pool.live === 0) for (let n = 0; n < 100; n++) this.mote(true);
    this.moteWant = on ? 1 : 0;
  }

  /** Ground mist, 0..1: three soft sheets low over the floor, drifting. */
  fog(amount: number): void {
    this.fogWant = clamp01(amount);
  }

  /** Rising embers over a fire or a brazier; up to four at once. Turning one off lets its last embers finish. */
  embers(x: number, y: number, z: number, on: boolean): void {
    const i = this.emitters.findIndex((e) => Math.hypot(e.x - x, e.y - y, e.z - z) < 0.6);
    if (on && i < 0) {
      if (this.emitters.length >= MAX_EMBERS) this.emitters.shift();
      this.emitters.push({ x, y, z, acc: 0 });
    } else if (!on && i >= 0) this.emitters.splice(i, 1);
  }

  /** A short celebratory burst from above, for the end of a reel. */
  confetti(): void {
    const { pool } = this.confettiK;
    const r = this.rand;
    for (let n = 0; n < 120; n++) {
      const i = pool.spawn(4.6 + r() * 1.6);
      pool.p.set([(r() - 0.5) * 12.5, 6.0 + r() * 1.8, -2.6 + r() * 5.4], i * 3);
      pool.v.set([(r() - 0.5) * 1.6, -(0.3 + r() * 1.6), (r() - 0.5) * 0.6], i * 3);
      pool.s.set([4 + r() * 7, r() * 6.28, r() * 6.28, Math.floor(r() * CONFETTI.length)], i * 4);
    }
  }

  /** Draw all four draws for a few frames with nothing in them, so their shaders are built before a reel needs them. */
  warm(frames = 3): void {
    this.warmFrames = frames;
  }

  /** Everything off at once (a scene change). */
  clear(): void {
    for (const k of this.kinds()) k.pool.clear();
    this.rainNow = this.rainWant = 0;
    this.snowNow = this.snowWant = 0;
    this.moteNow = this.moteWant = 0;
    this.fogNow = this.fogWant = 0;
    this.emitters.length = 0;
    this.write();
  }

  dispose(): void {
    this.stage.remove(this.root);
    this.glow.dispose();
    this.soft.dispose();
    this.rainMesh.geometry.dispose();
    this.rainMesh.material.dispose();
    this.fogMesh.geometry.dispose();
    this.fogMesh.material.dispose();
    this.noise.dispose();
  }

  /** How many particles of each kind are alive, and whether the rain and the mist are up (for tests and the HUD). */
  get counts(): Record<string, number> {
    return {
      rain: this.rainNow,
      fog: this.fogNow,
      sparks: this.sparkK.pool.live,
      shards: this.shardK.pool.live,
      embers: this.emberK.pool.live,
      motes: this.moteK.pool.live,
      snow: this.snowK.pool.live,
      dust: this.dustK.pool.live,
      confetti: this.confettiK.pool.live,
    };
  }

  // ---- the show

  update(dt: number): void {
    if (dt <= 0) return;
    this.time += dt;
    const r = this.rand;
    this.rainNow = approach(this.rainNow, this.rainWant, dt);
    this.snowNow = approach(this.snowNow, this.snowWant, dt);
    this.moteNow = approach(this.moteNow, this.moteWant, dt * 0.8);
    this.fogNow = approach(this.fogNow, this.fogWant, dt * 0.6);

    // the persistent kinds spawn while they are wanted
    if (this.snowWant > 0) for (this.snowAcc += dt * 15; this.snowAcc >= 1; this.snowAcc--) this.flake(RAIN_TOP - 0.4 + r() * 0.8);
    if (this.moteWant > 0) for (this.moteAcc += dt * 12; this.moteAcc >= 1; this.moteAcc--) this.mote(false);
    for (const e of this.emitters) {
      for (e.acc += dt * 12; e.acc >= 1; e.acc--) {
        const { pool } = this.emberK;
        const i = pool.spawn(1.3 + r() * 1.3);
        const o = i * 3;
        pool.p[o] = e.x + (r() - 0.5) * 0.5;
        pool.p[o + 1] = e.y + r() * 0.15;
        pool.p[o + 2] = e.z + (r() - 0.5) * 0.35;
        pool.v[o] = (r() - 0.5) * 0.4;
        pool.v[o + 1] = 0.8 + r() * 0.7;
        pool.v[o + 2] = (r() - 0.5) * 0.2;
        const q = i * 4;
        pool.s[q] = r() * 6.28;
        pool.s[q + 1] = 9 + r() * 14;
        pool.s[q + 2] = 0.7 + r() * 0.6;
        pool.s[q + 3] = 0;
      }
    }
    if (this.snowNow <= 0 && this.snowWant === 0) this.snowK.pool.clear();
    if (this.moteNow <= 0 && this.moteWant === 0) this.moteK.pool.clear();

    for (const k of this.kinds()) k.pool.tick(dt);
    this.simulate(dt);
    this.write();
  }

  private kinds(): Kind[] {
    return this.all;
  }

  private flake(y: number): void {
    const { pool } = this.snowK;
    const r = this.rand;
    const i = pool.spawn(60);
    pool.p.set([(r() - 0.5) * 14, y, -3.8 + r() * 7.3], i * 3);
    pool.v.set([0, -(0.55 + r() * 0.45), 0], i * 3);
    pool.s.set([r() * 6.28, 0.5 + r() * 0.8, r(), 0], i * 4);
    if (y < RAIN_TOP - 1) pool.age[i] = 1; // a flake already in the air is not fading in
  }

  private mote(midLife: boolean): void {
    const { pool } = this.moteK;
    const r = this.rand;
    const life = 6 + r() * 5;
    const i = pool.spawn(life);
    if (midLife) pool.age[i] = r() * life * 0.8;
    pool.p.set([(r() - 0.5) * 13, 0.4 + r() * 4.8, -3.6 + r() * 6.4], i * 3);
    pool.v.set([(r() - 0.5) * 0.16, (r() - 0.5) * 0.08, (r() - 0.5) * 0.1], i * 3);
    pool.s[i * 4] = r() * 6.28;
  }

  /** Move every live particle by its kind's rules. */
  private simulate(dt: number): void {
    const t = this.time;
    // sparks: gravity, a little drag, a skitter on the boards
    {
      const { p, v, life } = this.sparkK.pool;
      const drag = Math.exp(-1.5 * dt);
      for (let i = 0; i < life.length; i++) {
        if (life[i] <= 0) continue;
        const o = i * 3;
        v[o + 1] -= 16 * dt;
        for (let a = 0; a < 3; a++) p[o + a] += (v[o + a] *= drag) * dt;
        if (p[o + 1] < 0.02) {
          p[o + 1] = 0.02;
          v[o + 1] = Math.abs(v[o + 1]) * 0.3;
          v[o] *= 0.5;
          v[o + 2] *= 0.5;
        }
      }
    }
    // glass: falls, bounces once or twice, lies glinting
    {
      const { p, v, s, life } = this.shardK.pool;
      const drag = Math.exp(-0.4 * dt);
      for (let i = 0; i < life.length; i++) {
        if (life[i] <= 0) continue;
        const o = i * 3;
        v[o + 1] -= 14 * dt;
        for (let a = 0; a < 3; a++) p[o + a] += (v[o + a] *= drag) * dt;
        if (p[o + 1] < 0.03) {
          p[o + 1] = 0.03;
          v[o + 1] = Math.abs(v[o + 1]) * 0.25;
          v[o] *= 0.4;
          v[o + 2] *= 0.4;
          s[i * 4] *= 0.6; // a shard on the floor turns slower
        }
      }
    }
    // embers: rise on the heat and wander as they cool
    {
      const { p, v, s, life } = this.emberK.pool;
      const drag = Math.exp(-0.6 * dt);
      for (let i = 0; i < life.length; i++) {
        if (life[i] <= 0) continue;
        const o = i * 3;
        const ph = s[i * 4];
        v[o] += Math.sin(t * 2.3 + ph) * 1.1 * dt;
        v[o + 1] += 0.2 * dt;
        v[o + 2] += Math.cos(t * 1.7 + ph * 1.3) * 0.5 * dt;
        for (let a = 0; a < 3; a++) p[o + a] += (v[o + a] *= drag) * dt;
      }
    }
    // motes: drift on slow air
    {
      const { p, v, s, life } = this.moteK.pool;
      for (let i = 0; i < life.length; i++) {
        if (life[i] <= 0) continue;
        const o = i * 3;
        const ph = s[i * 4];
        p[o] += (v[o] + Math.sin(t * 0.37 + ph) * 0.07) * dt;
        p[o + 1] += (v[o + 1] + Math.sin(t * 0.29 + ph * 1.7) * 0.04) * dt;
        p[o + 2] += v[o + 2] * dt;
      }
    }
    // snow: falls and sways, settles and melts away
    {
      const pool = this.snowK.pool;
      const { p, v, s, age, life } = pool;
      for (let i = 0; i < life.length; i++) {
        if (life[i] <= 0) continue;
        const o = i * 3;
        p[o] += Math.sin(t * 1.1 + s[i * 4]) * 0.3 * s[i * 4 + 1] * dt;
        p[o + 1] += v[o + 1] * dt;
        if (p[o + 1] <= 0.04 && v[o + 1] < 0) {
          p[o + 1] = 0.04;
          v[o + 1] = 0;
          life[i] = Math.min(life[i], age[i] + 0.8);
        }
      }
    }
    // dust: thrown out low and fast, slowed by the air, settling
    {
      const { p, v, s, life } = this.dustK.pool;
      const drag = Math.exp(-3.2 * dt);
      for (let i = 0; i < life.length; i++) {
        if (life[i] <= 0) continue;
        const o = i * 3;
        v[o + 1] -= 0.25 * dt;
        for (let a = 0; a < 3; a++) p[o + a] += (v[o + a] *= drag) * dt;
        p[o] += s[i * 4 + 2] * dt;
        p[o + 1] = Math.max(0.08, p[o + 1]);
      }
    }
    // confetti: flutters down at paper's pace and lies where it lands
    {
      const { p, v, s, age, life } = this.confettiK.pool;
      const drag = Math.exp(-2.5 * dt);
      for (let i = 0; i < life.length; i++) {
        if (life[i] <= 0) continue;
        const o = i * 3;
        if (p[o + 1] <= 0.03) continue;
        v[o] += Math.sin(t * 3 + s[i * 4 + 1]) * 2.2 * dt;
        v[o + 1] -= 4 * dt;
        for (let a = 0; a < 3; a++) p[o + a] += (v[o + a] *= drag) * dt;
        if (p[o + 1] <= 0.03) {
          p[o + 1] = 0.03;
          life[i] = Math.min(life[i], age[i] + 0.7);
        }
      }
    }
  }

  /** Write every kind into its draw, and the uniforms of the rain and the mist. */
  private write(): void {
    const t = this.time;
    const l = this.look;
    const each = (k: Kind, fn: (i: number, f: number) => void) => {
      const { pool, batch, base } = k;
      for (let i = 0; i < pool.cap; i++) {
        if (pool.life[i] <= 0) batch.hide(base + i);
        else fn(i, pool.age[i] / pool.life[i]);
      }
    };
    const put = (k: Kind, i: number) => k.batch.put(k.base + i, k.pool.p[i * 3], k.pool.p[i * 3 + 1], k.pool.p[i * 3 + 2], l);

    each(this.sparkK, (i, f) => {
      const v = this.sparkK.pool.v;
      // white-hot, cooling to orange
      l.r = 1.7;
      l.g = 1.4 - 0.85 * f;
      l.b = 0.85 - 0.75 * f;
      l.a = 1 - f * f;
      l.dx = v[i * 3] * 0.05;
      l.dy = v[i * 3 + 1] * 0.05;
      l.dz = v[i * 3 + 2] * 0.05;
      l.width = 0.075;
      l.soft = 0.3;
      l.taper = 1;
      l.lit = 0;
      put(this.sparkK, i);
    });
    each(this.shardK, (i, f) => {
      const s = this.shardK.pool.s;
      const age = this.shardK.pool.age[i];
      const th = s[i * 4 + 1] + s[i * 4] * age;
      const phi = s[i * 4 + 2];
      // a face turning through the light flashes
      const glint = Math.pow(0.5 + 0.5 * Math.sin(th * 2 + s[i * 4 + 3]), 10);
      const b = 0.45 + 1.8 * glint;
      l.r = 0.82 * b;
      l.g = 0.92 * b;
      l.b = 1.0 * b;
      l.a = 1 - smooth(clamp01((f - 0.6) / 0.4));
      l.dx = Math.cos(th) * 0.26;
      l.dy = Math.sin(th) * Math.cos(phi) * 0.26;
      l.dz = Math.sin(th) * Math.sin(phi) * 0.26;
      l.width = 0.06;
      l.soft = 0.1;
      l.taper = 0;
      l.lit = 0.35;
      put(this.shardK, i);
    });
    each(this.emberK, (i, f) => {
      const { v, s } = this.emberK.pool;
      const flick = 0.75 + 0.25 * Math.sin(t * s[i * 4 + 1] + s[i * 4]);
      const heat = (2.1 - f) * flick;
      l.r = 1.0 * heat;
      l.g = (0.55 - 0.35 * f) * heat;
      l.b = (0.2 - 0.15 * f) * heat;
      l.a = smooth(clamp01(f / 0.1)) * (1 - smooth(clamp01((f - 0.5) / 0.5)));
      l.dx = v[i * 3] * 0.05;
      l.dy = v[i * 3 + 1] * 0.05;
      l.dz = v[i * 3 + 2] * 0.05;
      l.width = 0.1 * s[i * 4 + 2];
      l.soft = 0.6;
      l.taper = 0.5;
      l.lit = 0;
      put(this.emberK, i);
    });
    each(this.moteK, (i, f) => {
      l.r = 0.55;
      l.g = 0.5;
      l.b = 0.42;
      l.a = Math.sin(Math.PI * f) * this.moteNow * 0.8;
      l.dx = l.dy = l.dz = 0;
      l.width = 0.065;
      l.soft = 1;
      l.taper = 0;
      l.lit = 1;
      put(this.moteK, i);
    });
    each(this.snowK, (i) => {
      const { s, age, life } = this.snowK.pool;
      const melt = this.snowK.pool.v[i * 3 + 1] === 0 ? clamp01((life[i] - age[i]) / 0.8) : 1;
      l.r = 1.0;
      l.g = 1.02;
      l.b = 1.08;
      l.a = this.snowNow * clamp01(age[i] * 2) * melt * 0.95;
      l.dx = l.dy = l.dz = 0;
      l.width = 0.09 + 0.06 * s[i * 4 + 2];
      l.soft = 0.75;
      l.taper = 0;
      l.lit = 1;
      put(this.snowK, i);
    });
    each(this.dustK, (i, f) => {
      const s = this.dustK.pool.s;
      const sh = s[i * 4 + 1];
      l.r = 0.7 * sh;
      l.g = 0.62 * sh;
      l.b = 0.5 * sh;
      l.a = 0.4 * Math.pow(1 - f, 1.5) * clamp01(f * 10);
      l.dx = l.dy = l.dz = 0;
      l.width = (0.45 + 1.1 * (1 - (1 - f) * (1 - f))) * s[i * 4];
      l.soft = 1;
      l.taper = 0;
      l.lit = 0.8;
      put(this.dustK, i);
    });
    each(this.confettiK, (i, f) => {
      const { s, age } = this.confettiK.pool;
      const th = s[i * 4 + 1] + s[i * 4] * age[i];
      const phi = s[i * 4 + 2];
      const c = CONFETTI[s[i * 4 + 3]] ?? CONFETTI[0];
      l.r = c[0];
      l.g = c[1];
      l.b = c[2];
      l.a = 1 - smooth(clamp01((f - 0.85) / 0.15));
      l.dx = Math.cos(th) * 0.15;
      l.dy = Math.sin(th) * Math.cos(phi) * 0.15;
      l.dz = Math.sin(th) * Math.sin(phi) * 0.15;
      // a scrap flipping over shows its edge, then its face
      l.width = 0.11 * (0.25 + 0.75 * Math.abs(Math.cos(th * 0.7 + phi)));
      l.soft = 0.05;
      l.taper = 0;
      l.lit = 0.8;
      put(this.confettiK, i);
    });
    const warm = this.warmFrames > 0;
    if (warm) this.warmFrames--;
    this.glow.flush(warm);
    this.soft.flush(warm);

    this.rainU.time.value = t;
    this.rainU.amount.value = this.rainNow;
    this.rainMesh.visible = this.rainNow > 0 || warm;
    this.fogU.time.value = t;
    this.fogU.amount.value = this.fogNow;
    this.fogMesh.visible = this.fogNow > 0.002 || warm;
  }
}
