// Builds public/serial/scenery/*.glb (one mesh, one material each) + index.json
// Usage: node tools/serial/build_scenery.mjs
import { Document, NodeIO } from '@gltf-transform/core';
import { weld, simplify } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import { mat4, vec3, quat } from 'gl-matrix';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KK = ROOT + '/assets-src/kits/';
const HX = KK + 'kaykit/Medieval-Hexagon-Pack/addons/kaykit_medieval_hexagon_pack/Assets/gltf/';
const QN = KK + 'quaternius-mirror/public/glb/';
const OUT = ROOT + '/public/serial/scenery/';
const CAP = 1500;
const io = new NodeIO();

// id, source, uniform scale, rotation about Y (deg), kind
const LIST = [
  ['tree_cone', HX + 'decoration/nature/tree_single_A.gltf', 5.5, 0, 'tree'],
  ['tree_round', HX + 'decoration/nature/tree_single_B.gltf', 5.5, 0, 'tree'],
  ['tree_grove', HX + 'decoration/nature/trees_A_medium.gltf', 5, 0, 'tree'],
  ['tree_grove_b', HX + 'decoration/nature/trees_B_small.gltf', 5, 0, 'tree'],
  ['bush_a', QN + 'nature_pack/Bush_1.glb', 2.4, 0, 'bush'],
  ['bush_b', QN + 'nature_pack/Bush_2.glb', 2.4, 40, 'bush'],
  ['rock_a', HX + 'decoration/nature/rock_single_C.gltf', 8, 0, 'rock'],
  ['rock_b', HX + 'decoration/nature/rock_single_E.gltf', 8, 70, 'rock'],
  ['fence', HX + 'buildings/neutral/fence_wood_straight.gltf', 4, 90, 'fence'],
  ['signpost', null, 1, 0, 'signpost'],
  ['house_a', HX + 'buildings/red/building_home_A_red.gltf', 4.5, 0, 'house'],
  ['house_b', HX + 'buildings/red/building_home_B_red.gltf', 4.5, 0, 'house'],
  ['windmill', ROOT + '/assets-src/serial/work/windmill_dec.glb', 5, 0, 'windmill'],
  ['well', HX + 'buildings/red/building_well_red.gltf', 4.5, 0, 'well'],
  ['cart', QN + 'medieval_village_pack/Cart.glb', 4.2, 0, 'cart'],
  ['haystack', QN + 'medieval_village_pack/Hay.glb', 14, 0, 'haystack'],
];

function collect(doc) {
  const root = doc.getRoot(); const items = [];
  for (const n of root.listNodes()) {
    const m = n.getMesh(); if (!m) continue;
    const W = n.getWorldMatrix();
    for (const p of m.listPrimitives()) items.push({ p, W });
  }
  return items;
}

async function buildFromKit(id, src, s, rotY, kind) {
  const doc = await io.read(src); const items = collect(doc);
  const textured = items.every(({ p }) => p.getMaterial()?.getBaseColorTexture());
  const R = mat4.fromYRotation(mat4.create(), rotY * Math.PI / 180);
  const M = mat4.create(); mat4.scale(M, mat4.create(), [s, s, s]); mat4.multiply(M, R, M); // rotate after scale
  let nv = 0, ni = 0; for (const { p } of items) { nv += p.getAttribute('POSITION').getCount(); ni += p.getIndices() ? p.getIndices().getCount() : p.getAttribute('POSITION').getCount(); }
  const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), UV = new Float32Array(nv * 2), C = new Uint16Array(nv * 4), I = new Uint32Array(ni);
  let vo = 0, io_ = 0; let tex = null, matSrc = null;
  for (const { p, W } of items) {
    const MM = mat4.multiply(mat4.create(), M, W); const NM = mat4.clone(MM); NM[12] = NM[13] = NM[14] = 0;
    const pa = p.getAttribute('POSITION'), na = p.getAttribute('NORMAL'), ua = p.getAttribute('TEXCOORD_0'); const cnt = pa.getCount();
    const mat = p.getMaterial(); const bc = mat ? mat.getBaseColorFactor() : [0.8, 0.8, 0.8, 1];
    if (textured && !tex) { tex = mat.getBaseColorTexture(); matSrc = mat; }
    const v3 = [0, 0, 0];
    for (let v = 0; v < cnt; v++) {
      pa.getElement(v, v3); P.set(vec3.transformMat4(vec3.create(), v3, MM), (vo + v) * 3);
      if (na) { na.getElement(v, v3); N.set(vec3.normalize(vec3.create(), vec3.transformMat4(vec3.create(), v3, NM)), (vo + v) * 3); }
      if (textured && ua) { const u2 = [0, 0]; ua.getElement(v, u2); UV.set(u2, (vo + v) * 2); }
      for (let k = 0; k < 4; k++) C[(vo + v) * 4 + k] = Math.round((textured ? 1 : bc[k]) * 65535);
    }
    const ia = p.getIndices() ? p.getIndices().getArray() : Uint32Array.from({ length: cnt }, (_, i) => i);
    for (let k = 0; k < ia.length; k++) I[io_ + k] = ia[k] + vo; io_ += ia.length; vo += cnt;
  }
  return finish(id, P, N, textured ? UV : null, textured ? null : C, I, kind, textured ? { tex, matSrc } : null);
}

// the signpost is built from boxes
function box(parts, [x0, y0, z0], [x1, y1, z1], col) { parts.push({ min: [x0, y0, z0], max: [x1, y1, z1], col }); }
function buildSignpost() {
  const parts = []; const wood = [0.34, 0.2, 0.1, 1], dark = [0.2, 0.12, 0.07, 1], plank = [0.55, 0.36, 0.18, 1];
  box(parts, [-0.18, 0, -0.18], [0.18, 3.6, 0.18], wood); box(parts, [-0.3, 3.45, -0.3], [0.3, 3.75, 0.3], dark);
  box(parts, [-0.2, 2.6, 0.18], [1.9, 3.3, 0.3], plank); box(parts, [-1.7, 1.7, 0.18], [0.2, 2.4, 0.3], plank);
  box(parts, [-0.9, 0, -0.9], [0.9, 0.18, 0.9], [0.45, 0.43, 0.4, 1]);
  const P = [], N = [], C = [], I = [];
  for (const b of parts) {
    const [a0, a1] = [b.min, b.max];
    const faces = [[[1, 0, 0], [[a1[0], a0[1], a0[2]], [a1[0], a1[1], a0[2]], [a1[0], a1[1], a1[2]], [a1[0], a0[1], a1[2]]]],
      [[-1, 0, 0], [[a0[0], a0[1], a1[2]], [a0[0], a1[1], a1[2]], [a0[0], a1[1], a0[2]], [a0[0], a0[1], a0[2]]]],
      [[0, 1, 0], [[a0[0], a1[1], a0[2]], [a0[0], a1[1], a1[2]], [a1[0], a1[1], a1[2]], [a1[0], a1[1], a0[2]]]],
      [[0, -1, 0], [[a0[0], a0[1], a1[2]], [a0[0], a0[1], a0[2]], [a1[0], a0[1], a0[2]], [a1[0], a0[1], a1[2]]]],
      [[0, 0, 1], [[a0[0], a0[1], a1[2]], [a1[0], a0[1], a1[2]], [a1[0], a1[1], a1[2]], [a0[0], a1[1], a1[2]]]],
      [[0, 0, -1], [[a1[0], a0[1], a0[2]], [a0[0], a0[1], a0[2]], [a0[0], a1[1], a0[2]], [a1[0], a1[1], a0[2]]]]];
    for (const [n, vs] of faces) { const o = P.length / 3; for (const v of vs) { P.push(...v); N.push(...n); C.push(...b.col); } I.push(o, o + 1, o + 2, o, o + 2, o + 3); }
  }
  return finish('signpost', Float32Array.from(P), Float32Array.from(N), null, Uint16Array.from(C.map((x) => Math.round(x * 65535))), Uint32Array.from(I), 'signpost', null);
}

async function finish(id, P, N, UV, C, I, kind, texInfo) {
  // recentre: base on y=0, centred on x/z bbox centre
  const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], P[i + k]); mx[k] = Math.max(mx[k], P[i + k]); }
  const off = [(mn[0] + mx[0]) / 2, mn[1], (mn[2] + mx[2]) / 2];
  for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) P[i + k] -= off[k];
  const doc = new Document(); const buf = doc.createBuffer(); const A = (t, a, nrm) => doc.createAccessor().setType(t).setArray(a).setBuffer(buf).setNormalized(!!nrm);
  const mat = doc.createMaterial(id).setMetallicFactor(0).setRoughnessFactor(0.85);
  const prim = doc.createPrimitive().setMaterial(mat).setAttribute('POSITION', A('VEC3', P)).setAttribute('NORMAL', A('VEC3', N)).setIndices(A('SCALAR', I));
  if (UV) {
    prim.setAttribute('TEXCOORD_0', A('VEC2', UV));
    const t = doc.createTexture('atlas').setImage(texInfo.tex.getImage()).setMimeType(texInfo.tex.getMimeType()); mat.setBaseColorTexture(t);
    mat.setBaseColorFactor(texInfo.matSrc.getBaseColorFactor());
  } else { prim.setAttribute('COLOR_0', A('VEC4', C, true)); }
  doc.createScene().addChild(doc.createNode(id).setMesh(doc.createMesh(id).addPrimitive(prim)));
  await doc.transform(weld({ tolerance: 1e-4 }));
  let tris = doc.getRoot().listMeshes()[0].listPrimitives()[0].getIndices().getCount() / 3;
  if (tris > CAP) {
    await MeshoptSimplifier.ready;
    for (const error of [0.05, 0.1, 0.2, 0.4, 0.8, 1, 1, 1]) {
      if (tris <= CAP) break;
      await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: Math.min(0.8, (CAP * 0.9) / tris), error }));
      tris = doc.getRoot().listMeshes()[0].listPrimitives()[0].getIndices().getCount() / 3;
    }
  }
  const out = OUT + id + '.glb'; await io.write(out, doc);
  const pa = doc.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('POSITION');
  const bmin = pa.getMin([]), bmax = pa.getMax([]);
  return { id, file: 'scenery/' + id + '.glb', kind, height: +bmax[1].toFixed(2), footprint: [+(bmax[0] - bmin[0]).toFixed(2), +(bmax[2] - bmin[2]).toFixed(2)],
    triangles: tris, materials: 1, bytes: fs.statSync(out).size, textured: !!UV, origin: 'base centre (y=0, x/z bbox centre)' };
}

const index = [];
for (const [id, src, s, ry, kind] of LIST) index.push(id === 'signpost' ? await buildSignpost() : await buildFromKit(id, src, s, ry, kind));
fs.writeFileSync(OUT + 'index.json', JSON.stringify({ units: 'kit units (runtime scales by 0.0625)', up: 'y', origin: 'base centre', pieces: index }, null, 1));
for (const r of index) console.log(r.id.padEnd(14), r.kind.padEnd(9), 'h', String(r.height).padEnd(6), 'fp', r.footprint.join('x').padEnd(10), 'tris', r.triangles, 'bytes', r.bytes);
