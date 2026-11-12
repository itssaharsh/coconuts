// The Blender props: GLBs from public/models dress the primitive props once they load. The primitives stay
// as the fallback, so the stage is complete before the first model arrives and on a failed fetch.
import { AssetManager } from '@iwsdk/core';
import { BufferAttribute, type BufferGeometry, Group, Matrix4, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PropId } from './types';

export type ModelKind = PropId | 'clapper' | 'table';

const FILES: Record<ModelKind, string> = {
  coconuts: 'coconut_pair.glb',
  door: 'door.glb',
  bell: 'bell.glb',
  thunder: 'thunder_sheet.glb',
  whistle: 'slide_whistle.glb',
  glass: 'glass_bag.glb',
  clapper: 'clapperboard.glb',
  table: 'table.glb',
};

/** The moving parts the primitives carry as groups; the models bring their own under the same names. */
const MOVING = new Set(['Leaf', 'Clap', 'Slide', 'Sheet']);

function isPrimitive(o: Object3D): boolean {
  if (o instanceof Mesh) return o.name !== 'lamp' && o.name !== 'ring' && !o.name.startsWith('hit') && o.name !== 'face';
  return o instanceof Group && MOVING.has(o.name);
}

let loaded = 0;
let failed = 0;
export const modelStats = () => ({ loaded, failed });

/**
 * Swap a group's primitive meshes for its model. Rings, lamp pools and hit boxes stay; child groups
 * (the props on the table) are untouched. Resolves with the model's root, or null when it could not load.
 */
export async function dress(group: Object3D, kind: ModelKind, offset?: { x?: number; y?: number; z?: number }): Promise<Object3D | null> {
  const url = `${import.meta.env.BASE_URL}models/${FILES[kind]}`;
  let model: Object3D;
  try {
    const gltf = await AssetManager.loadGLTF(url);
    model = gltf.scene.clone(true);
  } catch (e) {
    failed++;
    console.warn('MODEL failed', kind, e instanceof Error ? e.message : e);
    return null;
  }
  model.name = `model-${kind}`;
  model.traverse((o) => {
    if (o instanceof Mesh) {
      o.castShadow = kind !== 'table';
      o.receiveShadow = kind === 'table';
    }
  });
  if (offset) model.position.set(offset.x ?? 0, offset.y ?? 0, offset.z ?? 0);
  for (const child of [...group.children]) if (isPrimitive(child)) group.remove(child);
  group.add(model);
  loaded++;
  return model;
}

/** The parts the stage animates by name: their meshes stay under them. */
const ANIMATED = new Set(['Leaf', 'Clap', 'Slide', 'Sheet', 'Button']);

/**
 * The models are small and plainly coloured, but every colour is its own material, and so its own draw call, for
 * each eye. This folds a model's flat-coloured meshes into one mesh per finish (matte, metal), with the colours
 * moved onto the vertices. Animated parts are folded separately and keep their own node. Textured or transparent
 * meshes are left alone.
 */
export function mergeByFinish(root: Object3D): number {
  root.updateWorldMatrix(true, true);
  const buckets = new Map<Object3D, Mesh[]>();
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material)) return;
    const m = mesh.material as MeshStandardMaterial;
    if (!m.isMeshStandardMaterial || m.map || m.transparent || m.vertexColors || m.emissiveMap) return;
    let owner: Object3D = root;
    for (let p: Object3D | null = mesh.parent; p && p !== root; p = p.parent) {
      if (ANIMATED.has(p.name)) {
        owner = p;
        break;
      }
    }
    if (ANIMATED.has(mesh.name)) return; // the mesh itself is the animated node: it stays as it is
    let list = buckets.get(owner);
    if (!list) buckets.set(owner, (list = []));
    list.push(mesh);
  });
  let saved = 0;
  const toOwner = new Matrix4();
  for (const [owner, meshes] of buckets) {
    for (const metal of [false, true]) {
      const group = meshes.filter((x) => ((x.material as MeshStandardMaterial).metalness > 0.5) === metal);
      if (group.length < 2) continue;
      const geos: BufferGeometry[] = [];
      let rough = 0;
      let metalness = 0;
      toOwner.copy(owner.matrixWorld).invert();
      for (const mesh of group) {
        const mat = mesh.material as MeshStandardMaterial;
        const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
        g.applyMatrix4(new Matrix4().multiplyMatrices(toOwner, mesh.matrixWorld));
        if (!g.getAttribute('normal')) g.computeVertexNormals();
        const n = g.getAttribute('position').count;
        const colours = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) colours.set([mat.color.r, mat.color.g, mat.color.b], i * 3);
        g.setAttribute('color', new BufferAttribute(colours, 3));
        for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'color') g.deleteAttribute(name);
        g.morphAttributes = {};
        geos.push(g);
        rough += mat.roughness;
        metalness += mat.metalness;
      }
      const merged = mergeGeometries(geos, false);
      if (!merged) continue;
      const one = new Mesh(merged, new MeshStandardMaterial({ vertexColors: true, roughness: rough / group.length, metalness: metalness / group.length }));
      one.name = `${owner === root ? 'body' : owner.name.toLowerCase()}-${metal ? 'metal' : 'matte'}`;
      one.castShadow = group[0].castShadow;
      one.receiveShadow = group[0].receiveShadow;
      owner.add(one);
      for (const mesh of group) mesh.removeFromParent();
      saved += group.length - 1;
    }
  }
  return saved;
}
