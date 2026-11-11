// Builds public/serial/beasts/*.glb from the Quaternius animal / enemy rigs: one skinned mesh, one vertex-coloured material,
// scale baked on the root node, feet on y=0, facing +z, clips kept (renamed) inside the file. Usage: node tools/serial/build_beasts.mjs [id ...]
import { NodeIO } from '@gltf-transform/core';
import { prune, weld, resample } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import { mat4, vec3, quat } from 'gl-matrix';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const Q = ROOT + '/assets-src/kits/quaternius-mirror/public/glb/';
const OUT = ROOT + '/public/serial/beasts/';
const io = new NodeIO();
const CAP_TRIS = 3900, CAP_BYTES = 450 * 1024;
// id, source, scale (uniform or [sx,sy,sz]), clip map {outName: sourceName (without the rig prefix)}, shoulder height target (informational)
const BEASTS = {
  wolf: { src: 'animals_pack/Wolf.glb', scale: 0.667, shoulderRaw: 2.25, clips: { Idle: 'Idle', Walk: 'Walk', Gallop: 'Gallop', Attack: 'Attack', Death: 'Death', Idle_HitReact_Left: 'Idle_HitReact_Left', Idle_HitReact_Right: 'Idle_HitReact_Right' } },
  spider: { src: 'easy_enemies_pack/Spider.glb', scale: [0.84, 1.64, 0.84], clips: { Idle: 'Spider_Idle', Walk: 'Spider_Walk', Attack: 'Spider_Attack', Death: 'Spider_Death', Jump: 'Spider_Jump' } },
  rat: { src: 'easy_enemies_pack/Rat.glb', scale: 0.2, clips: { Idle: 'Rat_Idle', Walk: 'Rat_Walk', Run: 'Rat_Run', Attack: 'Rat_Attack', Death: 'Rat_Death' } },
  horse_white: { src: 'animals_pack/Horse_White.glb', scale: 0.75, shoulderRaw: 3.42, clips: { Idle: 'Idle', Walk: 'Walk', Gallop: 'Gallop', Gallop_Jump: 'Gallop_Jump' } },
  stag: { src: 'animals_pack/Stag.glb', scale: 0.7, shoulderRaw: 3.3, clips: { Idle: 'Idle', Walk: 'Walk', Gallop: 'Gallop', Eating: 'Eating', Death: 'Death' } },
  bull: { src: 'animals_pack/Bull.glb', scale: 0.52, shoulderRaw: 4.4, recolor: { Main: [0.13, 0.06, 0.035], Muzzle: [0.22, 0.12, 0.09], Main_Light: [0.3, 0.2, 0.14] }, clips: { Idle: 'Idle', Walk: 'Walk', Gallop: 'Gallop', Attack_Headbutt: 'Attack_Headbutt', Death: 'Death' } },
};
const dur = (a) => Math.max(...a.listSamplers().map((s) => { const t = s.getInput().getArray(); return t[t.length - 1]; }));
async function build(id, cfg) {
  const doc = await io.read(Q + cfg.src); const root = doc.getRoot(); const buf = root.listBuffers()[0];
  const want = new Map(Object.entries(cfg.clips).map(([o, s]) => [s, o]));
  for (const a of root.listAnimations()) {
    const nm = a.getName().replace(/^[^|]*\|/, '');
    if (want.has(nm)) a.setName(want.get(nm)); else { a.listChannels().forEach((c) => c.dispose()); a.listSamplers().forEach((s) => s.dispose()); a.dispose(); }
  }
  const missing = [...want.values()].filter((o) => !root.listAnimations().some((a) => a.getName() === o)); if (missing.length) console.log(id, 'MISSING clips', missing);
  const skinNode = root.listNodes().find((n) => n.getSkin()); const skin = skinNode.getSkin(); const joints = skin.listJoints();
  const ibm = skin.getInverseBindMatrices().getArray(); const bindWorld = joints.map((_, i) => mat4.invert(mat4.create(), ibm.subarray(i * 16, i * 16 + 16)));
  const parts = []; const dispose = [];
  for (const n of root.listNodes()) {
    const m = n.getMesh(); if (!m) continue; dispose.push(n);
    if (n.getSkin()) { for (const p of m.listPrimitives()) parts.push({ p, j: -1 }); continue; }
    let j = -1, par = n.getParentNode(); const loc = mat4.fromRotationTranslationScale(mat4.create(), quat.fromValues(...n.getRotation()), vec3.fromValues(...n.getTranslation()), vec3.fromValues(...n.getScale()));
    j = joints.indexOf(par); if (j < 0) throw new Error(id + ': unskinned mesh ' + n.getName() + ' parent ' + par?.getName() + ' is not a joint');
    for (const p of m.listPrimitives()) parts.push({ p, j, M: mat4.multiply(mat4.create(), bindWorld[j], loc) });
  }
  const cnt = parts.reduce((s, { p }) => s + p.getAttribute('POSITION').getCount(), 0), ni = parts.reduce((s, { p }) => s + p.getIndices().getCount(), 0);
  const P = new Float32Array(cnt * 3), N = new Float32Array(cnt * 3), J = new Uint16Array(cnt * 4), W = new Float32Array(cnt * 4), C = new Uint16Array(cnt * 4), I = new Uint32Array(ni);
  let vo = 0, io_ = 0;
  for (const pt of parts) {
    const { p } = pt; const c = p.getAttribute('POSITION').getCount(); const bc = [...p.getMaterial().getBaseColorFactor()]; const rc = cfg.recolor?.[p.getMaterial().getName()]; if (rc) { bc[0] = rc[0]; bc[1] = rc[1]; bc[2] = rc[2]; }
    const pa = p.getAttribute('POSITION').getArray(), na = p.getAttribute('NORMAL').getArray();
    if (pt.j < 0) { P.set(pa, vo * 3); N.set(na, vo * 3); J.set(p.getAttribute('JOINTS_0').getArray(), vo * 4); W.set(p.getAttribute('WEIGHTS_0').getArray(), vo * 4); }
    else {
      const M0 = mat4.clone(pt.M); M0[12] = M0[13] = M0[14] = 0;
      for (let v = 0; v < c; v++) {
        P.set(vec3.transformMat4(vec3.create(), pa.subarray(v * 3, v * 3 + 3), pt.M), (vo + v) * 3);
        N.set(vec3.normalize(vec3.create(), vec3.transformMat4(vec3.create(), na.subarray(v * 3, v * 3 + 3), M0)), (vo + v) * 3);
        J[(vo + v) * 4] = pt.j; W[(vo + v) * 4] = 1;
      }
    }
    for (let v = 0; v < c; v++) for (let k = 0; k < 4; k++) C[(vo + v) * 4 + k] = Math.round(bc[k] * 65535);
    const ia = p.getIndices().getArray(); for (let k = 0; k < ia.length; k++) I[io_ + k] = ia[k] + vo; io_ += ia.length; vo += c;
  }
  const A = (t, a, nrm) => doc.createAccessor().setType(t).setArray(a).setBuffer(buf).setNormalized(!!nrm);
  const mat = doc.createMaterial(id).setBaseColorFactor([1, 1, 1, 1]).setMetallicFactor(0).setRoughnessFactor(0.85);
  const prim = doc.createPrimitive().setMaterial(mat).setAttribute('POSITION', A('VEC3', P)).setAttribute('NORMAL', A('VEC3', N)).setAttribute('JOINTS_0', A('VEC4', J))
    .setAttribute('WEIGHTS_0', A('VEC4', W)).setAttribute('COLOR_0', A('VEC4', C, true)).setIndices(A('SCALAR', I));
  const mesh = doc.createMesh(id).addPrimitive(prim); skinNode.setMesh(mesh);
  for (const n of dispose) if (n !== skinNode) n.dispose();
  for (const m of root.listMeshes()) if (m !== mesh) m.dispose();
  for (const m of root.listMaterials()) if (m !== mat) m.dispose();
  // drop tracks of helper bones that carry no skin weight and are not ancestors of a weighted bone, and constant ~1 scale tracks
  const used = new Set(); for (let i = 0; i < J.length; i++) if (W[i] > 0.001) used.add(J[i]);
  const keep = new Set(); for (const j of used) for (let n = joints[j]; n; n = n.getParentNode()) keep.add(n);
  let dropped = 0;
  for (const a of root.listAnimations()) for (const c of a.listChannels()) {
    let drop = !keep.has(c.getTargetNode());
    if (!drop && c.getTargetPath() === 'scale') drop = c.getSampler().getOutput().getArray().every((x) => Math.abs(x - 1) < 1e-3);
    if (drop) { const sm = c.getSampler(); c.dispose(); sm.dispose(); dropped++; }
  }
  console.log(id, 'dropped channels', dropped);
  // rest-pose bbox (world, through the node chain) -> feet on y=0
  const W0 = skinNode.getWorldMatrix(); const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (let i = 0; i < cnt; i++) { const w = vec3.transformMat4(vec3.create(), [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]], W0); for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], w[k]); mx[k] = Math.max(mx[k], w[k]); } }
  const sc = Array.isArray(cfg.scale) ? cfg.scale : [cfg.scale, cfg.scale, cfg.scale];
  const top = root.listScenes()[0].listChildren()[0]; top.setScale(sc); top.setTranslation([0, -mn[1] * sc[1], 0]);
  await doc.transform(prune({ keepLeaves: true }));
  await doc.transform(weld({ tolerance: 1e-5 }));
  let tris = root.listMeshes()[0].listPrimitives()[0].getIndices().getCount() / 3;
  if (tris > CAP_TRIS) {
    // meshopt locks every attribute seam as a border, so simplify on a position-only index (first vertex per position stands in), keeping the original vertices
    await MeshoptSimplifier.ready; const pr = root.listMeshes()[0].listPrimitives()[0]; const pos = pr.getAttribute('POSITION').getArray(); const ia = pr.getIndices().getArray();
    const first = new Map(), canon = new Uint32Array(pos.length / 3);
    for (let v = 0; v < canon.length; v++) { const k = pos[v * 3].toFixed(5) + ',' + pos[v * 3 + 1].toFixed(5) + ',' + pos[v * 3 + 2].toFixed(5); if (!first.has(k)) first.set(k, v); canon[v] = first.get(k); }
    let idx = Uint32Array.from(ia, (v) => canon[v]);
    for (const error of [0.01, 0.03, 0.06, 0.12]) { const [out2] = MeshoptSimplifier.simplify(idx, pos, 3, Math.floor(CAP_TRIS * 0.85) * 3, error, ['Sparse']); idx = out2; if (idx.length / 3 <= CAP_TRIS) break; }
    pr.getIndices().setArray(idx); tris = idx.length / 3; await doc.transform(prune({ keepLeaves: true }));
    console.log(id, 'simplified', ia.length / 3, '->', tris);
  }
  await doc.transform(resample({ tolerance: 1e-4 }));
  // compact vertex data: u8 joints, u16 normalised weights, u8 colours, u16 indices
  { const pr = root.listMeshes()[0].listPrimitives()[0]; const jn = pr.getAttribute('JOINTS_0'), wt = pr.getAttribute('WEIGHTS_0'), cl = pr.getAttribute('COLOR_0'), ix = pr.getIndices();
    if (joints.length < 256) jn.setArray(Uint8Array.from(jn.getArray()));
    const w = wt.getArray(); const w16 = new Uint16Array(w.length); for (let i = 0; i < w.length; i += 4) { let t = 0; const q = [0, 1, 2, 3].map((k) => Math.round(w[i + k] * 65535)); t = q[0] + q[1] + q[2] + q[3]; q[q.indexOf(Math.max(...q))] += 65535 - t; w16.set(q, i); }
    wt.setArray(w16).setNormalized(true);
    cl.setArray(Uint8Array.from(cl.getArray(), (x) => Math.round(x / 257))).setNormalized(true);
    if (pr.getAttribute('POSITION').getCount() < 65536) ix.setArray(Uint16Array.from(ix.getArray())); }
  const out = OUT + id + '.glb'; await io.write(out, doc);
  return { id, file: 'beasts/' + id + '.glb', bytes: fs.statSync(out).size, triangles: tris, height: +((mx[1] - mn[1]) * sc[1]).toFixed(2), length: +((mx[2] - mn[2]) * sc[2]).toFixed(2), width: +((mx[0] - mn[0]) * sc[0]).toFixed(2),
    shoulderHeight: cfg.shoulderRaw ? +(cfg.shoulderRaw * sc[1]).toFixed(2) : undefined, scale: sc.length && sc[0] === sc[1] && sc[1] === sc[2] ? sc[0] : sc, clips: root.listAnimations().map((a) => ({ name: a.getName(), duration: +dur(a).toFixed(2) })),
    rootNode: top.getName(), rootBone: joints[0].getName(), joints: joints.length, material: 'vertex colours (COLOR_0), no texture' };
}
const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(BEASTS);
const repFile = ROOT + '/assets-src/serial/beasts_report.json'; const rep = fs.existsSync(repFile) ? JSON.parse(fs.readFileSync(repFile)) : {};
for (const id of ids) { rep[id] = await build(id, BEASTS[id]); const r = rep[id]; console.log(id.padEnd(12), 'tris', r.triangles, 'KB', Math.round(r.bytes / 1024), 'h', r.height, 'len', r.length, 'w', r.width, r.clips.map((c) => c.name + ':' + c.duration).join(' ')); if (r.bytes > CAP_BYTES) console.log('  OVER BYTES'); }
fs.writeFileSync(repFile, JSON.stringify(rep, null, 1));
