// The film look and the stage's own light. Every stage material is unlit by the scene: it carries its lighting in
// its shader (a sky/ground wash, one key, up to four lamps), worked out in stage space, so the theatre looks the same
// in any app and costs the same whatever lights the room around it has. The same shader fades the picture to tinted
// monochrome, and keeps the stage inside its box by dropping fragments beyond the wings (in stage space, which does
// not depend on the eye and so is safe under multiview stereo).
import { Color, type Material, Matrix4, type Mesh, MeshBasicMaterial, type MeshStandardMaterial, type Object3D, Vector3 } from 'three';

export const TINTS = {
  amber: new Color(1.0, 0.86, 0.62), // day interiors, candlelight
  blue: new Color(0.62, 0.74, 1.0), // night
  red: new Color(1.0, 0.66, 0.56), // fire, danger
  green: new Color(0.72, 0.94, 0.7), // forest, poison, magic
  plain: new Color(1, 1, 1),
} as const;
export type TintName = keyof typeof TINTS;

export const MAX_LAMPS = 4;

/**
 * colour: 0 = silent-film monochrome, 1 = the kit's own colours (the set).
 * actorColour: the same for the actors, who always keep more of theirs so they stand out from the scenery.
 * tint: the film stock of the scene. stageInv: world -> stage space. clip / clipFront: the wings and the footlights.
 * sky / ground / keyDir / keyCol / lampPos / lampCol / flash: the light, in stage space (kit units).
 */
export const film = {
  colour: { value: 0.3 },
  actorColour: { value: 0.6 },
  tint: { value: TINTS.amber.clone() },
  stageInv: { value: new Matrix4() },
  clip: { value: 1e6 },
  clipFront: { value: 1e6 },
  sky: { value: new Color(0.5, 0.52, 0.6) },
  ground: { value: new Color(0.2, 0.17, 0.15) },
  keyDir: { value: new Vector3(-0.4, 0.75, 0.55).normalize() },
  keyCol: { value: new Color(0.9, 0.86, 0.8) },
  lampPos: { value: Array.from({ length: MAX_LAMPS }, () => new Vector3()) },
  lampCol: { value: Array.from({ length: MAX_LAMPS }, () => new Color(0, 0, 0)) },
  flash: { value: 0 },
};

const VERT_HEAD = `#include <common>
uniform mat4 uStageInv;
varying vec3 vStagePos;
varying vec3 vStageN;`;

const VERT_BODY = `#include <project_vertex>
#ifdef USE_SKINNING
  vec3 filmN = objectNormal;
#else
  vec3 filmN = normal;
#endif
vStagePos = (uStageInv * modelMatrix * vec4(transformed, 1.0)).xyz;
vStageN = mat3(uStageInv) * mat3(modelMatrix) * filmN;`;

const FRAG_HEAD = `#include <common>
uniform float uFilmColour;
uniform vec3 uFilmTint;
uniform float uStageClip;
uniform float uStageFront;
uniform vec3 uSky;
uniform vec3 uGround;
uniform vec3 uKeyDir;
uniform vec3 uKeyCol;
uniform vec3 uLampPos[${MAX_LAMPS}];
uniform vec3 uLampCol[${MAX_LAMPS}];
uniform float uFlash;
varying vec3 vStagePos;
varying vec3 vStageN;`;

const fragBody = (actor: boolean, free = false) => `#include <opaque_fragment>
vec3 filmN = normalize(vStageN);
vec3 filmLit = mix(uGround, uSky, 0.5 + 0.5 * filmN.y) + uKeyCol * max(dot(filmN, uKeyDir), 0.0);
vec3 filmLamp = vec3(0.0);
for (int i = 0; i < ${MAX_LAMPS}; i++) {
  vec3 d = uLampPos[i] - vStagePos;
  float r2 = dot(d, d);
  filmLamp += uLampCol[i] * (${actor ? '0.35 + 0.65 * ' : ''}max(dot(filmN, d) * inversesqrt(r2), 0.0)) / (r2 * 1.3 + 0.5);
}
// the light falls away toward the wings, and lightning whitens everything
filmLit *= 1.0 - 0.3 * smoothstep(3.5, 7.0, abs(vStagePos.x));
filmLit += vec3(uFlash * 1.6);${free ? '\n// out of the picture there are no lamps: the figure keeps enough light to be read in a dimmed room\nfilmLit = max(filmLit * 1.15, vec3(0.62));' : ''}
vec3 filmA = gl_FragColor.rgb${actor ? ' * 1.18' : ''};
vec3 filmC = filmA * filmLit;
float filmL = dot(filmC, vec3(0.30, 0.59, 0.11));
// the print is tinted; the lamps are hand-painted on it, so their warmth survives the fade
vec3 filmW = filmA * filmLamp;
float filmWL = dot(filmW, vec3(0.30, 0.59, 0.11));
gl_FragColor.rgb = mix(vec3(filmL) * 1.08 * uFilmTint, filmC, uFilmColour) + mix(vec3(filmWL) * vec3(1.0, 0.74, 0.42), filmW, max(uFilmColour, 0.55));`;

const converted = { set: new WeakMap<Material, MeshBasicMaterial>(), actor: new WeakMap<Material, MeshBasicMaterial>(), free: new WeakMap<Material, MeshBasicMaterial>() };

/**
 * The stage material for a kit material. Actors read `actorColour` and are lit a little more kindly.
 * `free` is an actor who has left the picture: the same film, without the wings and the footlights that would cut it off.
 */
export function filmMaterial(src: Material, actor = false, free = false): MeshBasicMaterial {
  const cache = free ? converted.free : actor ? converted.actor : converted.set;
  const done = cache.get(src);
  if (done) return done;
  const s = src as MeshStandardMaterial;
  const m = new MeshBasicMaterial({
    map: s.map ?? null,
    color: s.color ? s.color.clone() : new Color(1, 1, 1),
    transparent: s.transparent,
    opacity: s.opacity,
    alphaTest: s.alphaTest,
    side: s.side,
    vertexColors: s.vertexColors,
    toneMapped: false,
  });
  m.name = src.name;
  m.userData.filmSrc = src;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uFilmColour: actor ? film.actorColour : film.colour,
      uFilmTint: film.tint,
      uStageInv: film.stageInv,
      uStageClip: film.clip,
      uStageFront: film.clipFront,
      uSky: film.sky,
      uGround: film.ground,
      uKeyDir: film.keyDir,
      uKeyCol: film.keyCol,
      uLampPos: film.lampPos,
      uLampCol: film.lampCol,
      uFlash: film.flash,
    });
    shader.vertexShader = shader.vertexShader.replace('#include <common>', VERT_HEAD).replace('#include <project_vertex>', VERT_BODY);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', FRAG_HEAD)
      .replace('#include <clipping_planes_fragment>', free ? '#include <clipping_planes_fragment>' : '#include <clipping_planes_fragment>\nif (abs(vStagePos.x) > uStageClip || vStagePos.z > uStageFront) discard;')
      .replace('#include <opaque_fragment>', fragBody(actor || free, free));
  };
  m.customProgramCacheKey = () => (free ? 'film-free' : actor ? 'film-actor' : 'film-set');
  cache.set(src, m);
  return m;
}

/** Swap every mesh under `root` to the stage material. Nothing here uses the scene's lights or shadow maps. */
export function filmify(root: Object3D, opts: { actor?: boolean } = {}): void {
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    const one = (mat: Material) => filmMaterial(mat, !!opts.actor);
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(one) : one(mesh.material);
  });
}

/** Let an actor's meshes out of the picture (or back into it): they swap to the material with no wings. */
export function filmFree(root: Object3D, free: boolean): void {
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    const one = (mat: Material): Material => {
      const src = mat.userData.filmSrc as Material | undefined;
      return src ? filmMaterial(src, true, free) : mat;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(one) : one(mesh.material);
  });
}

export function setTint(name: TintName): void {
  film.tint.value.copy(TINTS[name]);
}
