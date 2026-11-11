// Builds public/serial/horse.glb from the Quaternius Horse: one vertex-coloured material, clips Idle/Walk/Gallop/Gallop_Jump.
// Usage: node tools/serial/build_horse.mjs [scale]
import { NodeIO } from '@gltf-transform/core';
import { prune } from '@gltf-transform/functions';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCALE = Number(process.argv[2] || 0.55);
const io = new NodeIO();
const doc = await io.read(ROOT + '/assets-src/kits/quaternius-mirror/public/glb/animals_pack/Horse.glb'); const root = doc.getRoot(); const buf = root.listBuffers()[0];
const KEEP = ['Idle', 'Walk', 'Gallop', 'Gallop_Jump'];
for (const a of root.listAnimations()) {
  const nm = a.getName().replace(/^AnimalArmature\|/, '');
  if (KEEP.includes(nm)) a.setName(nm); else { a.listChannels().forEach((c) => c.dispose()); a.listSamplers().forEach((s) => s.dispose()); a.dispose(); }
}
// merge the 8 primitives into one with COLOR_0 from each material's base colour
const node = root.listNodes().find((n) => n.getMesh()); const mesh = node.getMesh(); const prims = mesh.listPrimitives();
const cnt = prims.reduce((s, p) => s + p.getAttribute('POSITION').getCount(), 0), ni = prims.reduce((s, p) => s + p.getIndices().getCount(), 0);
const P = new Float32Array(cnt * 3), N = new Float32Array(cnt * 3), J = new Uint16Array(cnt * 4), W = new Float32Array(cnt * 4), C = new Uint16Array(cnt * 4), I = new Uint32Array(ni);
let vo = 0, io_ = 0;
for (const p of prims) {
  const c = p.getAttribute('POSITION').getCount(); P.set(p.getAttribute('POSITION').getArray(), vo * 3); N.set(p.getAttribute('NORMAL').getArray(), vo * 3);
  J.set(p.getAttribute('JOINTS_0').getArray(), vo * 4); W.set(p.getAttribute('WEIGHTS_0').getArray(), vo * 4);
  const bc = p.getMaterial().getBaseColorFactor();
  for (let v = 0; v < c; v++) for (let k = 0; k < 4; k++) C[(vo + v) * 4 + k] = Math.round(bc[k] * 65535);
  const ia = p.getIndices().getArray(); for (let k = 0; k < ia.length; k++) I[io_ + k] = ia[k] + vo; io_ += ia.length; vo += c;
}
const A = (t, a, norm) => doc.createAccessor().setType(t).setArray(a).setBuffer(buf).setNormalized(!!norm);
const mat = doc.createMaterial('horse').setBaseColorFactor([1, 1, 1, 1]).setMetallicFactor(0).setRoughnessFactor(0.85);
const prim = doc.createPrimitive().setMaterial(mat).setAttribute('POSITION', A('VEC3', P)).setAttribute('NORMAL', A('VEC3', N)).setAttribute('JOINTS_0', A('VEC4', J))
  .setAttribute('WEIGHTS_0', A('VEC4', W)).setAttribute('COLOR_0', A('VEC4', C, true)).setIndices(A('SCALAR', I));
const nm = doc.createMesh('Horse').addPrimitive(prim); node.setMesh(nm);
mesh.dispose();
for (const m of root.listMaterials()) if (m !== mat) m.dispose();
// scale the whole thing from the top node
const top = root.listScenes()[0].listChildren()[0]; top.setScale([SCALE, SCALE, SCALE]);
await doc.transform(prune({ keepLeaves: true }));
const out = ROOT + '/public/serial/horse.glb'; await io.write(out, doc);
const dur = (a) => Math.max(...a.listSamplers().map((s) => { const t = s.getInput().getArray(); return t[t.length - 1]; }));
console.log(JSON.stringify({ bytes: fs.statSync(out).size, tris: ni / 3, scale: SCALE, clips: root.listAnimations().map((a) => [a.getName(), +dur(a).toFixed(3)]) }));
