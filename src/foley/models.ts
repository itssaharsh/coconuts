// The Blender props: GLBs from public/models dress the primitive props once they load. The primitives stay
// as the fallback, so the stage is complete before the first model arrives and on a failed fetch.
import { AssetManager } from '@iwsdk/core';
import { Group, Mesh, Object3D } from 'three';
import type { PropId } from './types';

export type ModelKind = PropId | 'clapper' | 'table' | 'screen';

const FILES: Record<ModelKind, string> = {
  coconuts: 'coconut_pair.glb',
  door: 'door.glb',
  bell: 'bell.glb',
  thunder: 'thunder_sheet.glb',
  whistle: 'slide_whistle.glb',
  glass: 'glass_bag.glb',
  clapper: 'clapperboard.glb',
  table: 'table.glb',
  screen: 'screen_frame.glb',
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
      o.castShadow = kind !== 'table' && kind !== 'screen';
      o.receiveShadow = kind === 'table';
    }
  });
  if (offset) model.position.set(offset.x ?? 0, offset.y ?? 0, offset.z ?? 0);
  for (const child of [...group.children]) if (isPrimitive(child)) group.remove(child);
  group.add(model);
  loaded++;
  return model;
}
