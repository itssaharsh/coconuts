"""Bakes a toy-theatre set from a description JSON into one small GLB plus a runtime JSON.

  blender -b --python assets-src/serial/bake_set.py -- assets-src/sets/cellar.json [--out public/serial/sets]

Input  assets-src/sets/<id>.json   (see assets-src/serial/SET_FORMAT in the header of gen_sets.py)
Output public/serial/sets/<id>.glb  static pieces joined to one mesh per material; dynamic pieces stay separate named nodes
       public/serial/sets/<id>.json marks, lights, torches, footprint, dynamic-node info, triangle/material/draw-call counts

Coordinates in the JSON are glTF space (Y up), kit units. "rotY" is degrees about +Y (positive turns +Z towards +X).
Pieces: {"src": "<alias>:<file>" or a path relative to assets-src/kits/, "pos":[x,y,z], "rotY":deg, "scale":s|[sx,sy,sz],
         "dynamic":bool, "name":str, "pivot":[x,y,z] (piece-local hinge for a dynamic piece),
         "dynamic_children": {"<node name inside the piece>": "<exported node name>"}}
Prims:  {"type":"box","name":..,"min":[x,y,z],"max":[x,y,z],"like":"<src whose material to reuse>","uv":[u,v] (glTF uv), "rotY":deg about the box centre}
"""
import bpy, bmesh, json, sys, os, re, math
from mathutils import Matrix, Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
if not argv:
    raise SystemExit('usage: blender -b --python bake_set.py -- <set.json> [--out dir]')
set_path = os.path.abspath(argv[0])
out_dir = os.path.join(ROOT, 'public', 'serial', 'sets')
if '--out' in argv:
    out_dir = os.path.abspath(argv[argv.index('--out') + 1])
KITS = os.path.join(ROOT, 'assets-src', 'kits')
spec = json.load(open(set_path))
SID = spec['id']
ALIASES = spec.get('kits', {})

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
col = scene.collection

# ---------------------------------------------------------------- helpers
def base(n): return re.sub(r'\.\d{3}$', '', n)

def resolve(src):
    if ':' in src and src.split(':')[0] in ALIASES:
        a, f = src.split(':', 1)
        p = os.path.join(KITS, ALIASES[a], f)
    else:
        p = os.path.join(KITS, src)
    for cand in (p, p + '.glb', p + '.gltf', p + '.gltf.glb'):
        if os.path.isfile(cand): return cand
    raise FileNotFoundError(src + ' -> ' + p)

canon = {}
def mat_key(m):
    img = None
    if m.use_nodes:
        for n in m.node_tree.nodes:
            if n.type == 'TEX_IMAGE' and n.image: img = n.image; break
    if img: return ('img', base(img.name), tuple(img.size))
    bc = (0.8, 0.8, 0.8, 1)
    if m.use_nodes:
        for n in m.node_tree.nodes:
            if n.type == 'BSDF_PRINCIPLED': bc = tuple(round(x, 3) for x in n.inputs['Base Color'].default_value); break
    return ('col', base(m.name), bc)
def canonical(m):
    k = mat_key(m)
    if k not in canon: canon[k] = m
    return canon[k]

protos = {}  # resolved path -> list of mesh objects (renamed __proto_*)
def proto(src):
    p = resolve(src)
    if p in protos: return protos[p]
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=p)
    new = [o for o in bpy.data.objects if o not in before]
    out = []
    for o in new:
        o['gname'] = base(o.name); o.name = '__proto_' + o.name
        if o.type == 'MESH':
            for s in o.material_slots:
                if s.material: s.material = canonical(s.material)
            out.append(o)
    bpy.context.view_layer.update()
    protos[p] = out
    return out

def placement(pos, rot_y=0.0, scale=1.0):
    s = scale if isinstance(scale, (list, tuple)) else [scale] * 3
    x, y, z = pos
    return Matrix.Translation((x, -z, y)) @ Matrix.Rotation(math.radians(rot_y), 4, 'Z') @ Matrix.Diagonal((s[0], s[1], s[2], 1.0))

def new_obj(name, mesh, mw):
    ob = bpy.data.objects.new(name, mesh); col.objects.link(ob); ob.matrix_world = mw; return ob

def join(objs, name):
    if not objs: return None
    for o in bpy.context.view_layer.objects: o.select_set(False)
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    with bpy.context.temp_override(active_object=objs[0], selected_editable_objects=objs, selected_objects=objs):
        bpy.ops.object.join()
    objs[0].name = name; objs[0].data.name = name
    return objs[0]

def gl(v):  # blender -> glTF space
    return [round(v.x, 4), round(v.z, 4), round(-v.y, 4)]

# ---------------------------------------------------------------- build
static, dynamic, dyn_info = [], [], {}
for i, pc in enumerate(spec['pieces']):
    pr = proto(pc['src'])
    P = placement(pc.get('pos', [0, 0, 0]), pc.get('rotY', 0), pc.get('scale', 1))
    kids = pc.get('dynamic_children', {})
    if pc.get('dynamic'):
        # whole piece is one dynamic node; origin moved to "pivot" (piece-local, glTF space)
        nm = pc['name']
        pv = pc.get('pivot', [0, 0, 0]); pvb = Vector((pv[0], -pv[2], pv[1]))
        objs = []
        for o in pr:
            me = o.data.copy(); me.transform(o.matrix_world); me.transform(Matrix.Translation(-pvb)); objs.append(new_obj(nm, me, Matrix.Identity(4)))
        ob = join(objs, nm); ob.matrix_world = P @ Matrix.Translation(pvb)
        dynamic.append(ob); dyn_info[nm] = {'src': pc['src']}
        continue
    for o in pr:
        gn = o.get('gname', '')
        if gn in kids:
            me = o.data.copy(); ob = new_obj(kids[gn], me, P @ o.matrix_world); dynamic.append(ob); dyn_info[kids[gn]] = {'src': pc['src']}
            continue
        me = o.data.copy(); me.transform(P @ o.matrix_world); static.append(new_obj('s%d' % i, me, Matrix.Identity(4)))

def rot_gl(rx=0.0, ry=0.0, rz=0.0):
    """rotation in glTF space (degrees): X, then Z... applied as Ry * Rx * Rz"""
    return (Matrix.Rotation(math.radians(ry), 3, 'Y') @ Matrix.Rotation(math.radians(rx), 3, 'X') @ Matrix.Rotation(math.radians(rz), 3, 'Z'))

dyn_prims = {}
for k, pm in enumerate(spec.get('prims', [])):
    like = proto(pm['like'])[0].material_slots[0].material
    mn, mx = Vector(pm['min']), Vector(pm['max'])
    c = (mn + mx) / 2; sz = mx - mn
    R = rot_gl(pm.get('rotX', 0), pm.get('rotY', 0), pm.get('rotZ', 0))
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        g = R @ Vector((v.co.x * sz.x, v.co.y * sz.y, v.co.z * sz.z)) + c   # glTF space
        v.co = Vector((g.x, -g.z, g.y))                                      # -> blender
    uv = bm.loops.layers.uv.new('UVMap'); u, v_ = pm.get('uv', [0.5, 0.5])
    for f in bm.faces:
        for l in f.loops: l[uv].uv = (u, 1.0 - v_)
    me = bpy.data.meshes.new(pm['name']); bm.to_mesh(me); bm.free(); me.materials.append(like)
    for p in me.polygons: p.use_smooth = False
    dyn = pm.get('dynamic')
    if dyn:
        piv = pm['pivot']; pvb = Vector((piv[0], -piv[2], piv[1]))
        me.transform(Matrix.Translation(-pvb)); ob = new_obj(dyn, me, Matrix.Translation(pvb)); dyn_prims.setdefault(dyn, []).append(ob)
    else:
        static.append(new_obj('p%d' % k, me, Matrix.Identity(4)))
for nm, objs in dyn_prims.items():
    for o in objs: o.data.transform(o.matrix_world); o.matrix_world = Matrix.Identity(4)   # bake to world, then re-pivot
    pv = [pm for pm in spec['prims'] if pm.get('dynamic') == nm][0]['pivot']; pvb = Vector((pv[0], -pv[2], pv[1]))
    ob = join(objs, nm); ob.data.transform(Matrix.Translation(-pvb)); ob.matrix_world = Matrix.Translation(pvb)
    dynamic.append(ob); dyn_info[nm] = {'src': 'prims'}

stat = join(static, 'static')
stat_objs = [stat] if stat else []

# ---------------------------------------------------------------- stats + export
def count(ob):
    me = ob.data; me.calc_loop_triangles()
    per = {}
    for t in me.loop_triangles: per[t.material_index] = per.get(t.material_index, 0) + 1
    return per
tris = 0; mats = set(); draws = 0
for ob in stat_objs + dynamic:
    per = count(ob)
    for mi, n in per.items():
        tris += n; draws += 1; mats.add(ob.material_slots[mi].material.name)
bpy.context.view_layer.update()

for o in bpy.data.objects: o.select_set(False)
for o in stat_objs + dynamic: o.select_set(True)
os.makedirs(out_dir, exist_ok=True)
glb = os.path.join(out_dir, SID + '.glb')
bpy.ops.export_scene.gltf(filepath=glb, export_format='GLB', use_selection=True, export_yup=True, export_apply=True,
                          export_materials='EXPORT', export_image_format='AUTO', export_animations=False,
                          export_cameras=False, export_lights=False, export_extras=False)

# bounds of the static mesh in glTF space
vs = [stat.matrix_world @ v.co for v in stat.data.vertices]
bmin = [round(min(gl(v)[i] for v in vs), 3) for i in range(3)]; bmax = [round(max(gl(v)[i] for v in vs), 3) for i in range(3)]

dyn_out = {}
for ob in dynamic:
    q = ob.matrix_world.to_quaternion()
    # blender quaternion (w,x,y,z) in Z-up -> glTF Y-up: (x, z, -y)
    qg = [round(q.x, 5), round(q.z, 5), round(-q.y, 5), round(q.w, 5)]
    info = dict(dyn_info.get(ob.name, {})); info.update(spec.get('dynamic', {}).get(ob.name, {}))
    info.update({'node': ob.name, 'pivot': gl(ob.matrix_world.translation), 'baseQuaternion': qg, 'triangles': sum(count(ob).values())})
    dyn_out[ob.name] = info

res = {
    'id': SID, 'title': spec.get('title', SID), 'glb': 'sets/%s.glb' % SID,
    'convention': spec.get('convention', ''), 'kind': spec.get('kind'), 'sky': spec.get('sky'),
    'footprint': spec.get('footprint'), 'floorY': 0,
    'marks': spec.get('marks', {}), 'lights': spec.get('lights', []),
    'torches': [l['pos'] for l in spec.get('lights', []) if l.get('kind') == 'torch'],
    'dynamic': dyn_out, 'bounds': {'min': bmin, 'max': bmax},
    'stats': {'triangles': tris, 'materials': len(mats), 'materialNames': sorted(mats), 'drawCalls': draws, 'staticMeshes': len(stat_objs), 'dynamicNodes': len(dynamic)},
    'bytes': os.path.getsize(glb), 'meta': spec.get('meta', {}),
}
json.dump(res, open(os.path.join(out_dir, SID + '.json'), 'w'), indent=1)
print('BAKED', SID, json.dumps(res['stats']), res['bytes'], 'bytes')
