// Builds public/serial/chars/*.glb (one skinned mesh, no clips), public/serial/anims.glb, public/serial/items/*.glb
// Usage: node tools/serial/build_chars.mjs
import { Document, NodeIO } from '@gltf-transform/core';
import { prune } from '@gltf-transform/functions';
import { mat4, quat, vec3 } from 'gl-matrix';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KK = ROOT + '/assets-src/kits/kaykit/';
const ADV = KK + 'Character-Pack-Adventures/addons/kaykit_character_pack_adventures/';
const SKL = KK + 'Character-Pack-Skeletons/addons/kaykit_character_pack_skeletons/';
const OUT = ROOT + '/public/serial/';
const io = new NodeIO();
fs.mkdirSync(OUT + 'chars', { recursive: true }); fs.mkdirSync(OUT + 'items', { recursive: true });

const CHARS = {
  knight: ADV + 'Characters/gltf/Knight.glb', barbarian: ADV + 'Characters/gltf/Barbarian.glb', mage: ADV + 'Characters/gltf/Mage.glb',
  rogue: ADV + 'Characters/gltf/Rogue.glb', rogue_hooded: ADV + 'Characters/gltf/Rogue_Hooded.glb',
  skeleton_warrior: SKL + 'Characters/gltf/Skeleton_Warrior.glb', skeleton_minion: SKL + 'Characters/gltf/Skeleton_Minion.glb',
  skeleton_rogue: SKL + 'Characters/gltf/Skeleton_Rogue.glb', skeleton_mage: SKL + 'Characters/gltf/Skeleton_Mage.glb',
};
const CLIPS = ['Idle', 'Walking_A', 'Walking_Backwards', 'Running_A', 'Jump_Full_Short', 'Hit_A', 'Hit_B', 'Death_A', 'Death_B', 'Block',
  '1H_Melee_Attack_Chop', '1H_Melee_Attack_Slice_Horizontal', '1H_Melee_Attack_Stab', 'Unarmed_Melee_Attack_Punch_A', 'Unarmed_Melee_Attack_Kick',
  'PickUp', 'Throw', 'Use_Item', 'Interact', 'Cheer', 'Sit_Chair_Down', 'Sit_Chair_Idle', 'Sit_Chair_StandUp', 'Sit_Floor_Down', 'Sit_Floor_Idle',
  'Lie_Down', 'Lie_Idle', 'Lie_StandUp', 'Spellcast_Raise', 'Spellcast_Shoot', 'Dodge_Backward'];
const SKEL_CLIPS = ['Idle_Combat', 'Skeletons_Awaken_Floor', 'Death_C_Skeletons', 'Death_C_Skeletons_Resurrect'];
const isHandSlot = (n) => { for (let p = n.getParentNode(); p; p = p.getParentNode()) if (/^handslot\./.test(p.getName())) return true; return false; };

function clipDuration(a) { let d = 0; for (const s of a.listSamplers()) { const t = s.getInput().getArray(); d = Math.max(d, t[t.length - 1]); } return d; }

async function buildChar(id, file) {
  const doc = await io.read(file); const root = doc.getRoot(); const buf = root.listBuffers()[0];
  for (const a of root.listAnimations()) { for (const c of a.listChannels()) c.dispose(); for (const s of a.listSamplers()) s.dispose(); a.dispose(); }
  const skinNode = root.listNodes().find((n) => n.getSkin()); const skin = skinNode.getSkin();
  const joints = skin.listJoints(); const ibm = skin.getInverseBindMatrices().getArray();
  const bindWorld = joints.map((_, i) => mat4.invert(mat4.create(), ibm.subarray(i * 16, i * 16 + 16)));
  // collect sources: skinned meshes, and non-hand static meshes parented to a joint (helmet, hat, cape)
  const parts = []; // {prim, jointIdx|null, local mat}
  const dispose = [];
  for (const n of root.listNodes()) {
    const m = n.getMesh(); if (!m) continue;
    if (n.getSkin()) { for (const p of m.listPrimitives()) parts.push({ p, j: -1 }); dispose.push(n); continue; }
    dispose.push(n);
    if (isHandSlot(n)) continue; // weapons/shields come back as separate item GLBs
    const j = joints.indexOf(n.getParentNode()); if (j < 0) throw new Error(id + ': ' + n.getName() + ' parent is not a joint');
    const loc = mat4.fromRotationTranslationScale(mat4.create(), quat.fromValues(...n.getRotation()), vec3.fromValues(...n.getTranslation()), vec3.fromValues(...n.getScale()));
    for (const p of m.listPrimitives()) parts.push({ p, j, M: mat4.multiply(mat4.create(), bindWorld[j], loc) });
  }
  // group by material
  const groups = new Map();
  for (const pt of parts) { const k = pt.p.getMaterial(); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(pt); }
  const mesh = doc.createMesh(id);
  for (const [mat, pts] of groups) {
    let nv = 0, ni = 0; for (const { p } of pts) { nv += p.getAttribute('POSITION').getCount(); ni += p.getIndices().getCount(); }
    const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), U = new Float32Array(nv * 2), J = new Uint16Array(nv * 4), W = new Float32Array(nv * 4), I = new Uint32Array(ni);
    let vo = 0, io_ = 0;
    for (const pt of pts) {
      const { p } = pt; const pa = p.getAttribute('POSITION').getArray(), na = p.getAttribute('NORMAL').getArray(), ua = p.getAttribute('TEXCOORD_0').getArray();
      const ja = p.getAttribute('JOINTS_0')?.getArray(), wa = p.getAttribute('WEIGHTS_0')?.getArray(), ia = p.getIndices().getArray(); const cnt = p.getAttribute('POSITION').getCount();
      for (let v = 0; v < cnt; v++) {
        const o = vo + v;
        if (pt.j < 0) { P.set(pa.subarray(v * 3, v * 3 + 3), o * 3); N.set(na.subarray(v * 3, v * 3 + 3), o * 3); J.set(ja.subarray(v * 4, v * 4 + 4), o * 4); W.set(wa.subarray(v * 4, v * 4 + 4), o * 4); }
        else {
          const pp = vec3.transformMat4(vec3.create(), pa.subarray(v * 3, v * 3 + 3), pt.M); P.set(pp, o * 3);
          // translation was in the 13..15 slots; recompute with zero translation
          const M0 = mat4.clone(pt.M); M0[12] = M0[13] = M0[14] = 0; const n2 = vec3.normalize(vec3.create(), vec3.transformMat4(vec3.create(), na.subarray(v * 3, v * 3 + 3), M0)); N.set(n2, o * 3);
          J[o * 4] = pt.j; W[o * 4] = 1;
        }
        U.set(ua.subarray(v * 2, v * 2 + 2), o * 2);
      }
      for (let k = 0; k < ia.length; k++) I[io_ + k] = ia[k] + vo; io_ += ia.length; vo += cnt;
    }
    const acc = (t, a, ty) => doc.createAccessor().setType(t).setArray(a).setBuffer(buf);
    const prim = doc.createPrimitive().setMaterial(mat)
      .setAttribute('POSITION', acc('VEC3', P)).setAttribute('NORMAL', acc('VEC3', N)).setAttribute('TEXCOORD_0', acc('VEC2', U))
      .setAttribute('JOINTS_0', acc('VEC4', J)).setAttribute('WEIGHTS_0', acc('VEC4', W)).setIndices(acc('SCALAR', I));
    mesh.addPrimitive(prim);
  }
  const rig = skinNode.getParentNode(); const node = doc.createNode(id).setMesh(mesh).setSkin(skin);
  (rig ? rig : doc.getRoot().listScenes()[0]).addChild(node);
  for (const n of dispose) { const m = n.getMesh(); n.dispose(); }
  for (const m of root.listMeshes()) if (m !== mesh) m.dispose();
  await doc.transform(prune({ keepLeaves: true }));
  const out = OUT + 'chars/' + id + '.glb'; await io.write(out, doc);
  const tris = mesh.listPrimitives().reduce((s, p) => s + p.getIndices().getCount() / 3, 0);
  return { id, file: 'chars/' + id + '.glb', bytes: fs.statSync(out).size, tris, materials: groups.size };
}

// ---- items: standalone props, with the character-file local offset to their handslot baked into the root node
async function readItemOffset(charFile, nodeName) {
  const d = await io.read(charFile); const n = d.getRoot().listNodes().find((x) => x.getName() === nodeName);
  return { slot: n.getParentNode().getName(), t: n.getTranslation(), r: n.getRotation(), s: n.getScale() };
}
async function buildItem(id, src, offsetFrom, slot) {
  const doc = await io.read(src); const root = doc.getRoot();
  const scene = root.listScenes()[0];
  let off = { t: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1], slot };
  if (offsetFrom) off = await readItemOffset(offsetFrom[0], offsetFrom[1]);
  const holder = doc.createNode(id).setTranslation(off.t).setRotation(off.r);
  for (const c of scene.listChildren()) { scene.removeChild(c); holder.addChild(c); }
  scene.addChild(holder);
  await doc.transform(prune({ keepLeaves: true }));
  const out = OUT + 'items/' + id + '.glb'; await io.write(out, doc);
  const tris = root.listMeshes().reduce((s, m) => s + m.listPrimitives().reduce((a, p) => a + (p.getIndices()?.getCount() ?? 0) / 3, 0), 0);
  return { id, file: 'items/' + id + '.glb', bytes: fs.statSync(out).size, tris, attachBone: off.slot, offset: { position: [...off.t], quaternion: [...off.r] } };
}

async function buildAnims() {
  const doc = await io.read(CHARS.knight); const root = doc.getRoot();
  const sk = await io.read(CHARS.skeleton_warrior);
  const keep = new Set(CLIPS);
  for (const a of root.listAnimations()) if (!keep.has(a.getName())) { a.listChannels().forEach((c) => c.dispose()); a.listSamplers().forEach((s) => s.dispose()); a.dispose(); }
  const byName = new Map(root.listNodes().map((n) => [n.getName(), n]));
  const buf = root.listBuffers()[0];
  for (const name of SKEL_CLIPS) {
    const src = sk.getRoot().listAnimations().find((a) => a.getName() === name); if (!src) throw new Error('missing ' + name);
    const an = doc.createAnimation(name);
    for (const ch of src.listChannels()) {
      const tgt = byName.get(ch.getTargetNode().getName()); if (!tgt) continue;
      const s = ch.getSampler();
      const inp = doc.createAccessor().setType('SCALAR').setArray(s.getInput().getArray().slice()).setBuffer(buf);
      const outp = doc.createAccessor().setType(s.getOutput().getType()).setArray(s.getOutput().getArray().slice()).setBuffer(buf);
      const ns = doc.createAnimationSampler().setInput(inp).setOutput(outp).setInterpolation(s.getInterpolation());
      an.addSampler(ns); an.addChannel(doc.createAnimationChannel().setTargetNode(tgt).setTargetPath(ch.getTargetPath()).setSampler(ns));
    }
  }
  const missing = [...CLIPS, ...SKEL_CLIPS].filter((n) => !root.listAnimations().some((a) => a.getName() === n)); if (missing.length) throw new Error('missing clips ' + missing);
  // drop tracks nobody renders: IK/control helper bones (skin joints 23..40 carry zero vertex weight) and scale tracks that stay ~1
  const helper = new Set(root.listSkins()[0].listJoints().slice(23).map((j) => j.getName()));
  let dropped = 0;
  for (const a of root.listAnimations()) for (const c of a.listChannels()) {
    let drop = helper.has(c.getTargetNode().getName());
    if (!drop && c.getTargetPath() === 'scale') { const v = c.getSampler().getOutput().getArray(); drop = v.every((x) => Math.abs(x - 1) < 1e-3); }
    if (drop) { const sm = c.getSampler(); c.dispose(); sm.dispose(); dropped++; }
  }
  console.log('dropped channels', dropped);
  // strip meshes and skin, keep the node hierarchy (Rig > root > ...)
  for (const n of root.listNodes()) if (n.getMesh()) { n.setMesh(null); n.setSkin(null); }
  for (const n of root.listNodes()) if (!n.getParentNode() || true) { /* keep */ }
  for (const sk_ of root.listSkins()) sk_.dispose();
  for (const n of root.listNodes()) if (/_(ArmLeft|ArmRight|Body|Head|LegLeft|LegRight)$/.test(n.getName()) && n.listChildren().length === 0) n.dispose();
  for (const n of root.listNodes()) if (!n.getParentNode() && n.listChildren().length === 0 && !root.listAnimations().some((a) => a.listChannels().some((c) => c.getTargetNode() === n))) n.dispose();
  await doc.transform(prune({ keepLeaves: true }));
  for (const m of root.listMaterials()) m.dispose(); for (const t of root.listTextures()) t.dispose();
  const out = OUT + 'anims.glb'; await io.write(out, doc);
  return { file: 'anims.glb', bytes: fs.statSync(out).size, clips: root.listAnimations().map((a) => ({ name: a.getName(), duration: +clipDuration(a).toFixed(3) })) };
}

const res = { chars: [], items: [] };
for (const [id, f] of Object.entries(CHARS)) res.chars.push(await buildChar(id, f));
res.anims = await buildAnims();
const A = ADV + 'Assets/gltf/', S = SKL + 'Assets/gltf/', C = ADV + 'Characters/gltf/';
res.items.push(
  await buildItem('sword_1handed', A + 'sword_1handed.gltf', [C + 'Knight.glb', '1H_Sword']),
  await buildItem('shield_round', A + 'shield_round.gltf', [C + 'Knight.glb', 'Round_Shield']),
  await buildItem('staff', A + 'staff.gltf', [C + 'Mage.glb', '2H_Staff']),
  await buildItem('wand', A + 'wand.gltf', [C + 'Mage.glb', '1H_Wand']),
  await buildItem('dagger', A + 'dagger.gltf', [C + 'Rogue.glb', 'Knife']),
  await buildItem('crossbow_1handed', A + 'crossbow_1handed.gltf', [C + 'Rogue.glb', '1H_Crossbow']),
  await buildItem('mug', A + 'mug_full.gltf', null, 'handslot.r'),
  await buildItem('spellbook', A + 'spellbook_closed.gltf', [C + 'Mage.glb', 'Spellbook']),
  await buildItem('skeleton_blade', S + 'Skeleton_Blade.gltf', null, 'handslot.r'),
  await buildItem('skeleton_axe', S + 'Skeleton_Axe.gltf', null, 'handslot.r'),
  await buildItem('skeleton_staff', S + 'Skeleton_Staff.gltf', null, 'handslot.r'),
  await buildItem('skeleton_crossbow', S + 'Skeleton_Crossbow.gltf', null, 'handslot.r'),
  await buildItem('skeleton_shield_small', S + 'Skeleton_Shield_Small_A.gltf', null, 'handslot.l'),
);
fs.writeFileSync(ROOT + '/assets-src/serial/chars_report.json', JSON.stringify(res, null, 1));
console.log(JSON.stringify(res.chars), JSON.stringify(res.items.map((i) => [i.id, i.bytes, i.tris, i.attachBone])), res.anims.bytes, res.anims.clips.length);
