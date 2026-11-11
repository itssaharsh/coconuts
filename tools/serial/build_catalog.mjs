// Writes public/serial/catalog.json from the built files. Usage: node tools/serial/build_catalog.mjs  (run after the other builders)
import { NodeIO } from '@gltf-transform/core';
import { mat4, vec3 } from 'gl-matrix';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'); const SV = ROOT + '/public/serial/';
const io = new NodeIO(); const rep = JSON.parse(fs.readFileSync(ROOT + '/assets-src/serial/chars_report.json'));
const r2 = (x) => +x.toFixed(2);
async function bounds(file) {
  const d = await io.read(file); const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9]; const pts = [];
  for (const n of d.getRoot().listNodes()) { const m = n.getMesh(); if (!m) continue; const W = n.getSkin() ? mat4.create() : n.getWorldMatrix();
    for (const p of m.listPrimitives()) { const a = p.getAttribute('POSITION'); const v = [0, 0, 0]; for (let i = 0; i < a.getCount(); i++) { a.getElement(i, v); const w = vec3.transformMat4(vec3.create(), v, n.getSkin() ? mat4.create() : W); pts.push(w); } } }
  // horse: skinned, but the node/armature chain carries the scale; apply the mesh node world matrix for the unskinned estimate
  return pts;
}
const out = { version: 1, units: 'kit units; runtime scale 1 unit = 1/12 of the proscenium opening width (opening x in [-6,6], y in [0,6.75]); glTF Y-up; origin of characters at the feet', root: 'public/serial/', animationsFile: 'anims.glb',
  note: 'three.js GLTFLoader strips "." from node names: bone "handslot.r" is "handslotr" at runtime (PropertyBinding.sanitizeNodeName); clip tracks use the same sanitised names, so mixer.clipAction(clip) on any character just works.' };
out.characters = {};
for (const c of rep.chars) {
  const pts = await bounds(SV + c.file);
  out.characters[c.id] = { file: c.file, bytes: c.bytes, height: r2(Math.max(...pts.map((p) => p[1]))), triangles: c.tris, materials: c.materials, joints: 41, rig: 'Rig > root > hips ...', skinnedMeshNode: c.id };
}
out.clips = Object.fromEntries(rep.anims.clips.map((c) => [c.name, c.duration]));
out.animations = { file: 'anims.glb', bytes: rep.anims.bytes, clips: rep.anims.clips };
out.attach = { rightHand: { glTF: 'handslot.r', three: 'handslotr' }, leftHand: { glTF: 'handslot.l', three: 'handslotl' }, head: { glTF: 'head', three: 'head' }, chest: { glTF: 'chest', three: 'chest' } };
out.items = Object.fromEntries(rep.items.map((i) => [i.id, { file: i.file, bytes: i.bytes, triangles: i.tris, attachBone: i.attachBone, attachBoneThree: i.attachBone.replace('.', ''), offset: i.offset, note: 'bone.add(itemScene): the glTF root node already carries the hand-slot offset' }]));
// horse
const h = await io.read(SV + 'horse.glb'); const top = h.getRoot().listScenes()[0].listChildren()[0]; const sc = top.getScale()[0];
const mesh = h.getRoot().listNodes().find((n) => n.getMesh()); const M = mesh.getWorldMatrix(); let ymax = -1e9, back = -1e9; let zmin = 1e9, zmax = -1e9, xw = 0;
for (const p of mesh.getMesh().listPrimitives()) { const a = p.getAttribute('POSITION'); const v = [0, 0, 0]; for (let i = 0; i < a.getCount(); i++) { a.getElement(i, v); const w = vec3.transformMat4(vec3.create(), v, M); ymax = Math.max(ymax, w[1]); zmin = Math.min(zmin, w[2]); zmax = Math.max(zmax, w[2]); xw = Math.max(xw, Math.abs(w[0])); if (Math.abs(w[0]) < 0.15 && w[2] > -0.5 * sc && w[2] < 0.5 * sc) back = Math.max(back, w[1]); } }
const hf = ROOT + '/public/serial/horse.glb'; const clips = h.getRoot().listAnimations().map((a) => ({ name: a.getName(), duration: r2(Math.max(...a.listSamplers().map((s) => { const t = s.getInput().getArray(); return t[t.length - 1]; }))) }));
out.horse = { file: 'horse.glb', bytes: fs.statSync(hf).size, scale: sc, height: r2(ymax), backHeight: r2(back), length: r2(zmax - zmin), width: r2(xw * 2), facing: '+z (head towards +z)', clips,
  triangles: 2182, materials: 1, material: 'vertex colours (COLOR_0), no texture',
  riderSeat: { note: 'parent the rider (KayKit rig, origin = pelvis in Sit_Chair_Idle) under the horse root at this offset; verified in qa/lookdev/baked.html?scene=road', position: [0, 2.25, -0.1] },
  bones: { body: 'Body', back: 'Back', head: 'Head' } };
// sets
out.sets = {};
for (const f of fs.readdirSync(SV + 'sets').filter((x) => x.endsWith('.json'))) { const s = JSON.parse(fs.readFileSync(SV + 'sets/' + f)); out.sets[s.id] = { glb: s.glb, json: 'sets/' + f, bytes: s.bytes, triangles: s.stats.triangles, materials: s.stats.materials, drawCalls: s.stats.drawCalls, footprint: s.footprint, marks: Object.keys(s.marks), dynamicNodes: Object.keys(s.dynamic) }; }
const si = JSON.parse(fs.readFileSync(SV + 'scenery/index.json')); out.scenery = { index: 'scenery/index.json', pieces: si.pieces.map((p) => ({ id: p.id, file: p.file, kind: p.kind, height: p.height, footprint: p.footprint, triangles: p.triangles, bytes: p.bytes })) };
const bf = ROOT + '/assets-src/serial/beasts_report.json';
if (fs.existsSync(bf)) { const br = JSON.parse(fs.readFileSync(bf)); out.beasts = {};
  for (const [id, r] of Object.entries(br)) out.beasts[id] = { file: r.file, bytes: r.bytes, triangles: r.triangles, height: r.height, shoulderHeight: r.shoulderHeight, length: r.length, width: r.width, scale: r.scale, clips: r.clips, rootNode: r.rootNode, rootBone: r.rootBone, joints: r.joints, material: r.material, facing: '+z', origin: 'feet at y=0, centred on the body' };
  if (out.beasts.horse_white) out.beasts.horse_white.riderSeat = out.horse.riderSeat; }
fs.writeFileSync(SV + 'catalog.json', JSON.stringify(out, null, 1)); console.log(JSON.stringify({ horse: out.horse, chars: Object.fromEntries(Object.entries(out.characters).map(([k, v]) => [k, v.height])) }));
