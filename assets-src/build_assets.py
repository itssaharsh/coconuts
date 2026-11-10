"""Pointlings asset builder: every toy prop built procedurally, exported as one .glb each.

Run from the repo root:
    blender -b --factory-startup --python assets-src/build_assets.py
Options after `--`:  --no-render   skip overview.png
                     --only a,b    build/verify only these assets (overview still uses every .glb on disk)
                     --engine cycles|eevee|workbench   overview renderer (default cycles)
                     --samples N  --pct P  --out path.png   quick test renders

Modelling convention: Blender Z up, metres, origin at the base centre, "forward" = Blender -Y.
The glTF exporter writes Y up, so Blender -Y becomes glTF +Z (the helper's nose points +Z in three.js).
"""
import bpy, bmesh, math, os, sys, json, struct, time, random
from mathutils import Matrix, Vector, Euler

T0 = time.time()
HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(HERE)
OUT = os.path.join(PROJ, 'public', 'models')
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
TAU = math.tau


def arg(flag, default=None):
    for a in ARGS:
        if a == flag:
            return True
        if a.startswith(flag + '='):
            return a.split('=', 1)[1]
    return default


# ---------------------------------------------------------------- palette (design/tokens.css)
PAL = dict(
    pip='#F2C14E', mo='#5B8DEF', tuck='#F08A6C',
    red='#E5412D', green='#6FA85A', blue='#4EA8DE',
    moss='#7FA04A', moss_dark='#6B8F3C', stream='#BFE3F2', sand='#E8D7B0',
    plank='#D8B98A', key='#D9A441', wood='#B98A5A',
    beech='#EAD9B9', beech_light='#F4E8D2', beech_dark='#C9B08A',
    ink='#2B2320', stone='#C9C2B6', metal='#5A544D', eye='#1E1A17', white='#FBF7F0',
)


def hex_srgb(h):
    h = h.lstrip('#')
    return [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]


def to_lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def lin(h):
    return tuple(to_lin(c) for c in hex_srgb(h)) + (1.0,)


def mix_hex(a, b, t):
    ca, cb = hex_srgb(a), hex_srgb(b)
    return '#' + ''.join('%02X' % round(255 * (x + (y - x) * t)) for x, y in zip(ca, cb))


# ---------------------------------------------------------------- scene helpers
def purge():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.lights, bpy.data.cameras,
                 bpy.data.node_groups, bpy.data.worlds):
        for d in list(coll):
            coll.remove(d)
    for c in list(bpy.data.collections):
        bpy.data.collections.remove(c)


def mat(name, hexc, rough=0.7, metal=0.0, vcol=False):
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = lin(hexc)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    m.diffuse_color = lin(hexc)
    m.roughness = rough
    if vcol:
        n = nt.nodes.new('ShaderNodeVertexColor')
        n.layer_name = 'Color'
        nt.links.new(n.outputs['Color'], b.inputs['Base Color'])
    return m


def empty(name, parent=None, loc=(0, 0, 0)):
    ob = bpy.data.objects.new(name, None)
    ob.empty_display_size = 0.02
    bpy.context.scene.collection.objects.link(ob)
    ob.parent = parent
    ob.location = loc
    return ob


def MT(x=0.0, y=0.0, z=0.0):
    return Matrix.Translation((x, y, z))


def MR(axis, deg):
    return Matrix.Rotation(math.radians(deg), 4, axis)


def MS(x, y, z):
    return Matrix.Diagonal((x, y, z, 1.0))


def shade(bm, deg=None):
    """deg None = flat; else smooth with edges sharper than deg marked sharp."""
    bm.normal_update()
    if deg is None:
        for f in bm.faces:
            f.smooth = False
        return
    a = math.radians(deg)
    for f in bm.faces:
        f.smooth = True
    for e in bm.edges:
        e.smooth = len(e.link_faces) == 2 and e.calc_face_angle(0.0) <= a


def finish(bm, deg=None):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    shade(bm, deg)
    return bm


# ---------------------------------------------------------------- primitives (each returns a bmesh)
def box(sx, sy, sz, bevel=0.0, seg=1, centered=False):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co.x *= sx
        v.co.y *= sy
        v.co.z = v.co.z * sz + (0.0 if centered else sz / 2)
    if bevel > 0:
        bmesh.ops.bevel(bm, geom=bm.edges[:], offset=bevel, offset_type='OFFSET', segments=seg,
                        profile=0.5, affect='EDGES', clamp_overlap=True)
    return finish(bm, None)


def lathe(prof, seg=24, closed=False, sharp=40):
    """Revolve (r, z) points around Z. r == 0 points are poles."""
    bm = bmesh.new()
    rings = []
    for r, z in prof:
        if r <= 1e-7:
            rings.append([bm.verts.new((0.0, 0.0, z))])
        else:
            rings.append([bm.verts.new((r * math.cos(TAU * i / seg), r * math.sin(TAU * i / seg), z))
                          for i in range(seg)])
    pairs = list(zip(rings, rings[1:]))
    if closed:
        pairs.append((rings[-1], rings[0]))
    for a, b in pairs:
        if len(a) == 1 and len(b) == 1:
            continue
        for i in range(seg):
            j = (i + 1) % seg
            if len(a) == 1:
                vs = [a[0], b[j], b[i]]
            elif len(b) == 1:
                vs = [a[i], a[j], b[0]]
            else:
                vs = [a[i], a[j], b[j], b[i]]
            bm.faces.new(vs)
    return finish(bm, sharp)


def sphere(r, u=12, v=8):
    # lathe instead of bmesh.ops.create_uvsphere: that op's face order varies run to run (non-deterministic GLBs)
    return lathe([(r * math.sin(math.pi * k / v), -r * math.cos(math.pi * k / v)) for k in range(v + 1)], u, sharp=80)


def tube_arc(R, r, a0, a1, seg=10, mseg=6, cap=True):
    """Tube along an arc of radius R in the XZ plane (angles in degrees, 0 = +X, 90 = +Z)."""
    bm = bmesh.new()
    rings = []
    for k in range(seg + 1):
        t = math.radians(a0 + (a1 - a0) * k / seg)
        c = Vector((R * math.cos(t), 0.0, R * math.sin(t)))
        n = Vector((math.cos(t), 0.0, math.sin(t)))
        b = Vector((0.0, 1.0, 0.0))
        rings.append([bm.verts.new(c + r * (math.cos(TAU * m / mseg) * n + math.sin(TAU * m / mseg) * b))
                      for m in range(mseg)])
    for k in range(seg):
        for m in range(mseg):
            q = (m + 1) % mseg
            bm.faces.new([rings[k][m], rings[k][q], rings[k + 1][q], rings[k + 1][m]])
    if cap:
        bm.faces.new(rings[0])
        bm.faces.new(rings[-1][::-1])
    return finish(bm, 60)


def prism(pts, h):
    """Extrude a CCW 2D polygon (x, y) up by h."""
    bm = bmesh.new()
    bot = [bm.verts.new((x, y, 0.0)) for x, y in pts]
    top = [bm.verts.new((x, y, h)) for x, y in pts]
    bm.faces.new(bot[::-1])
    bm.faces.new(top)
    n = len(pts)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new([bot[i], bot[j], top[j], top[i]])
    return finish(bm, None)


def segment_cyl(p0, p1, r, seg=8):
    """Cylinder between two points."""
    p0, p1 = Vector(p0), Vector(p1)
    d = p1 - p0
    bm = lathe([(0, 0), (r, 0), (r, d.length), (0, d.length)], seg=seg, sharp=40)
    rot = d.normalized().to_track_quat('Z', 'Y').to_matrix().to_4x4()
    bm.transform(MT(*p0) @ rot)
    return bm


def rrect_ring(hw, hh, rc, d, z, csteps=6, rmin=0.0015):
    """Points of a rounded rectangle (half sizes hw, hh, corner radius rc) inset by d, at height z."""
    r = max(rc - d, rmin)
    cx, cy = hw - d - r, hh - d - r
    pts = []
    for qx, qy, a0 in ((1, 1, 0), (-1, 1, 90), (-1, -1, 180), (1, -1, 270)):
        for k in range(csteps + 1):
            a = math.radians(a0 + 90 * k / csteps)
            pts.append((qx * cx + r * math.cos(a), qy * cy + r * math.sin(a), z))
    return pts


def rrect_loft(hw, hh, rc, prof, closed=True, caps=False, csteps=6, sharp=40):
    """Sweep a (inset d, z) cross-section around a rounded rectangle."""
    bm = bmesh.new()
    rings = [[bm.verts.new(p) for p in rrect_ring(hw, hh, rc, d, z, csteps)] for d, z in prof]
    n = len(rings[0])
    pairs = list(zip(rings, rings[1:]))
    if closed:
        pairs.append((rings[-1], rings[0]))
    for a, b in pairs:
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new([a[i], a[j], b[j], b[i]])
    if caps:
        bm.faces.new(rings[0][::-1])
        bm.faces.new(rings[-1])
    return finish(bm, sharp)


# ---------------------------------------------------------------- mesh builder
class Builder:
    def __init__(self):
        self.bm = bmesh.new()
        self.mats = []

    def add(self, src, material, M=None):
        if M is not None:
            src.transform(M)
        if material not in self.mats:
            self.mats.append(material)
        idx = self.mats.index(material)
        src.verts.index_update()
        nv = [self.bm.verts.new(v.co) for v in src.verts]
        first = len(self.bm.faces)
        for f in src.faces:
            nf = self.bm.faces.new([nv[v.index] for v in f.verts])
            nf.material_index = idx
            nf.smooth = f.smooth
        for e in src.edges:
            if not e.smooth:
                ne = self.bm.edges.get([nv[e.verts[0].index], nv[e.verts[1].index]])
                if ne:
                    ne.smooth = False
        src.free()
        self.bm.faces.ensure_lookup_table()
        return range(first, len(self.bm.faces))

    def obj(self, name, parent=None, loc=(0, 0, 0)):
        me = bpy.data.meshes.new(name)
        self.bm.to_mesh(me)
        self.bm.free()
        for m in self.mats:
            me.materials.append(m)
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        ob.parent = parent
        ob.location = loc
        return ob


def single(name, src, material, parent=None, loc=(0, 0, 0), M=None):
    b = Builder()
    b.add(src, material, M)
    return b.obj(name, parent, loc)


# ================================================================ assets
# ---- helper (peg doll) ----------------------------------------------------------
HELPER = dict(R=0.016, top=0.060, foot=0.0047, head_z=0.040)


def build_helper():
    root = empty('helper')
    R, top, foot = HELPER['R'], HELPER['top'], HELPER['foot']
    zc = top - R
    c = 0.003
    prof = [(0, foot)]
    prof += [(R - c + c * math.cos(math.radians(a)), foot + c + c * math.sin(math.radians(a))) for a in (-90, -45, 0)]
    prof += [(R * math.cos(math.radians(a)), zc + R * math.sin(math.radians(a))) for a in (0, 15, 30, 45, 60, 75, 90)]
    single('Body', lathe(prof, 24, sharp=50), mat('Body', PAL['pip'], 0.62), root)

    hz = HELPER['head_z']
    nose = lathe([(0, 0), (0.0052, 0), (0.0036, 0.0065), (0.0020, 0.0130), (0.0009, 0.0184), (0, 0.0200)], 12, sharp=45)
    single('Nose', nose, mat('Nose', PAL['ink'], 0.6), root, (0, 0, hz), MT(0, -0.0140, 0) @ MR('X', 90))

    b = Builder()
    em = mat('Eyes', PAL['eye'], 0.6)
    for sx in (-1, 1):
        b.add(sphere(0.0021, 10, 6), em, MT(sx * 0.0058, -0.0130, 0.0085))
    b.obj('Eyes', root, (0, 0, hz))

    base = [(0, 0), (0.0235, 0), (0.0250, 0.0015), (0.0250, 0.0043), (0.0237, 0.0060), (0.0205, 0.0060),
            (0.0190, 0.0047), (0, 0.0047)]
    single('Base', lathe(base, 32, sharp=35), mat('Base', PAL['beech'], 0.7), root)


# ---- crates --------------------------------------------------------------------
def crate_shell(b, W, D, H, paint, wood, e=0.005, n=3, lid=True, core=True, gap=0.0012, t=0.0025, rec=0.0007):
    """Frame of 12 chamfered battens (wood) + painted slats with grooves between them."""
    ch = 0.0008
    for sx in (-1, 1):
        for sy in (-1, 1):
            b.add(box(e, e, H, ch), wood, MT(sx * (W / 2 - e / 2), sy * (D / 2 - e / 2), 0))
    for z in ((0.0, H - e) if lid else (0.0, H - e)):
        for sy in (-1, 1):
            b.add(box(W - 2 * e, e, e, ch), wood, MT(0, sy * (D / 2 - e / 2), z))
        for sx in (-1, 1):
            b.add(box(e, D - 2 * e, e, ch), wood, MT(sx * (W / 2 - e / 2), 0, z))
    sh = (H - 2 * e - (n - 1) * gap) / n
    for k in range(n):
        z = e + k * (sh + gap)
        for sy in (-1, 1):
            b.add(box(W - 2 * e + 0.001, t, sh), paint, MT(0, sy * (D / 2 - rec - t / 2), z))
        for sx in (-1, 1):
            b.add(box(t, D - 2 * e + 0.001, sh), paint, MT(sx * (W / 2 - rec - t / 2), 0, z))
    if lid:
        sw = (D - 2 * e - (n - 1) * gap) / n
        for k in range(n):
            y = -D / 2 + e + k * (sw + gap) + sw / 2
            b.add(box(W - 2 * e + 0.001, sw, t), paint, MT(0, y, H - rec - t))
    if core:
        i = rec + t + 0.0004
        b.add(box(W - 2 * i, D - 2 * i, H - 0.002), wood, MT(0, 0, 0.001))


def build_crate():
    root = empty('crate')
    b = Builder()
    paint, wood = mat('Paint', PAL['red'], 0.65), mat('Wood', PAL['wood'], 0.72)
    rope = mat('Rope', PAL['sand'], 0.8)
    W = D = 0.040
    H = 0.036
    crate_shell(b, W, D, H, paint, wood)
    b.add(tube_arc(0.0075, 0.0014, 0, 180, 12, 6), rope, MT(0, 0, H - 0.001))
    for sx in (-1, 1):
        b.add(sphere(0.0023, 8, 5), rope, MT(sx * 0.0075, 0, H + 0.0004))
    b.obj('Crate', root)


def build_crate_heavy():
    root = empty('crate_heavy')
    b = Builder()
    paint, wood = mat('Paint', PAL['red'], 0.65), mat('Wood', PAL['wood'], 0.72)
    metal = mat('Metal', PAL['metal'], 0.6, 0.45)
    rope = mat('Rope', PAL['sand'], 0.8)
    W, D, H = 0.060, 0.040, 0.040
    crate_shell(b, W, D, H, paint, wood, e=0.0055)
    for sx in (-1, 1):  # two iron straps over the lid and down the long faces
        x = sx * 0.0175
        b.add(box(0.0055, D + 0.0016, 0.0008), metal, MT(x, 0, H - 0.0002))
        for sy in (-1, 1):
            b.add(box(0.0055, 0.0008, H + 0.0004), metal, MT(x, sy * (D / 2 + 0.0003), -0.0002))
    for sx in (-1, 1):  # rope handles on both short ends: two helpers, one each side
        rot = MR('Z', 0 if sx > 0 else 180) @ MR('X', 90)
        b.add(tube_arc(0.0080, 0.0014, -90, 90, 10, 6), rope, MT(sx * (W / 2 - 0.0006), 0, 0.027) @ rot)
        for sy in (-1, 1):
            b.add(sphere(0.0022, 8, 5), rope, MT(sx * (W / 2 + 0.0004), sy * 0.008, 0.027))
    b.obj('Crate', root)


def build_plank_crate():
    root = empty('plank_crate')
    b = Builder()
    paint, wood = mat('Paint', PAL['beech_dark'], 0.7), mat('Wood', PAL['wood'], 0.72)
    W = D = 0.040
    H = 0.026
    crate_shell(b, W, D, H, paint, wood, e=0.0045, n=2, lid=False, core=False)
    b.add(box(W - 0.006, D - 0.006, 0.003), wood, MT(0, 0, 0.001))  # floor
    b.obj('Crate', root)
    p = Builder()
    plank = mat('Plank', PAL['plank'], 0.7)
    for (x, y, L, ry, rx) in ((-0.0105, 0.0055, 0.050, -7, 3), (0.0005, -0.0045, 0.056, 2, -4), (0.0110, 0.0040, 0.046, 8, 2)):
        p.add(box(0.0095, 0.0032, L, 0.0005), plank, MT(x, y, 0.004) @ MR('Y', ry) @ MR('X', rx))
    p.obj('Planks', root)


def build_bridge():
    root = empty('bridge')
    b = Builder()
    plank, wood = mat('Plank', PAL['plank'], 0.7), mat('Wood', PAL['wood'], 0.72)
    for sy in (-1, 1):
        b.add(box(0.090, 0.0195, 0.005, 0.0008, 2), plank, MT(0, sy * 0.01025, 0))
    for sx in (-1, 1):  # cleats across the ends
        b.add(box(0.0060, 0.0410, 0.0022, 0.0006), wood, MT(sx * 0.0375, 0, 0.0048))
        for sy in (-1, 1):
            b.add(sphere(0.0008, 6, 4), wood, MT(sx * 0.0375, sy * 0.0115, 0.0070))
    b.obj('Bridge', root)


# ---- pad -----------------------------------------------------------------------
def build_pad():
    root = empty('pad')
    b = Builder()
    paint = mat('Paint', PAL['blue'], 0.62)
    light = mat('PaintLight', mix_hex(PAL['blue'], '#FFFFFF', 0.6), 0.65)
    base = mat('Base', PAL['beech'], 0.7)
    b.add(lathe([(0, 0), (0.0236, 0), (0.0250, 0.0012), (0.0250, 0.0030), (0.0240, 0.0040), (0, 0.0040)], 40, sharp=35), base)
    b.add(lathe([(0.0172, 0.0035), (0.0228, 0.0035), (0.0228, 0.0051), (0.0219, 0.0060), (0.0181, 0.0060),
                 (0.0172, 0.0051)], 40, closed=True, sharp=50), paint)
    b.add(lathe([(0, 0.0035), (0.0173, 0.0035), (0.0173, 0.0046), (0.0168, 0.0049), (0, 0.0049)], 40, sharp=40), light)
    b.add(lathe([(0, 0.0045), (0.0042, 0.0045), (0.0042, 0.0053), (0.0037, 0.0056), (0, 0.0056)], 20, sharp=40), paint)
    b.obj('Pad', root)


# ---- key, gate -----------------------------------------------------------------
def build_key():
    root = empty('key')
    b = Builder()
    brass = mat('Brass', PAL['key'], 0.6, 0.35)
    bow = [(0.0030, 0.0004), (0.0034, 0.0), (0.0052, 0.0), (0.0057, 0.0006), (0.0057, 0.0024), (0.0052, 0.0030),
           (0.0034, 0.0030), (0.0030, 0.0026)]
    b.add(lathe(bow, 20, closed=True, sharp=50), brass, MT(-0.0095, 0, 0))
    b.add(box(0.0200, 0.0034, 0.0028, 0.0005), brass, MT(0.0055, 0, 0.0001))
    b.add(box(0.0020, 0.0058, 0.0030, 0.0005), brass, MT(-0.0030, 0, 0))
    b.add(box(0.0026, 0.0048, 0.0028, 0.0004), brass, MT(0.0092, -0.0034, 0.0001))
    b.add(box(0.0026, 0.0064, 0.0028, 0.0004), brass, MT(0.0136, -0.0042, 0.0001))
    b.obj('Key', root)


def build_gate():
    root = empty('gate')
    wood = mat('Wood', PAL['wood'], 0.72)
    cap = mat('Cap', PAL['blue'], 0.62)
    P = 0.037
    b = Builder()
    for sx in (-1, 1):
        b.add(box(0.0060, 0.0060, 0.0500, 0.0008), wood, MT(sx * P, 0, 0))
        b.add(box(0.0110, 0.0140, 0.0040, 0.0010), wood, MT(sx * P, 0, 0))
        b.add(sphere(0.0045, 12, 8), cap, MT(sx * P, 0, 0.0535))
    b.obj('Posts', root)
    # Door: pivot on the left post's axis, so rotating it about its local up axis swings it open.
    d = Builder()
    L = 2 * P - 0.0065
    cx = P  # door-local x of the gap centre
    for z in (0.0120, 0.0330):
        d.add(box(L, 0.0035, 0.0065, 0.0006), wood, MT(cx, 0, z))
    for x in (0.0065, 2 * P - 0.0065):
        d.add(box(0.0050, 0.0033, 0.0300, 0.0006), wood, MT(x, 0, 0.0100))
    p0, p1 = Vector((0.0090, 0, 0.0170)), Vector((2 * P - 0.0090, 0, 0.0350))
    dv = p1 - p0
    ang = math.degrees(math.atan2(dv.z, dv.x))
    d.add(box(dv.length, 0.0030, 0.0045, 0.0005, centered=True), wood,
          MT(*(p0 + p1) / 2) @ MR('Y', -ang))
    d.obj('Door', root, (-P, 0, 0))
    # Padlock: separate so it can drop away when the key is used.
    k = Builder()
    brass = mat('Brass', PAL['key'], 0.6, 0.35)
    metal = mat('Metal', PAL['metal'], 0.6, 0.45)
    k.add(box(0.0085, 0.0035, 0.0075, 0.0012, 2, centered=True), brass)
    k.add(tube_arc(0.0026, 0.0008, 0, 180, 8, 6), metal, MT(0, 0, 0.0030))
    k.add(box(0.0012, 0.0006, 0.0026, centered=True), metal, MT(0, -0.0018, -0.0008))
    k.obj('Padlock', root, (0.0300, -0.0046, 0.0240))


# ---- stool, tree, stone ----------------------------------------------------------
def build_stool():
    root = empty('stool')
    b = Builder()
    wood, seat = mat('Wood', PAL['wood'], 0.72), mat('Seat', PAL['beech_dark'], 0.7)
    b.add(lathe([(0, 0.0250), (0.0145, 0.0250), (0.0155, 0.0262), (0.0155, 0.0288), (0.0146, 0.0300), (0, 0.0300)], 28, sharp=40), seat)
    for k in range(3):
        a = math.radians(90 + 120 * k)
        b.add(segment_cyl((0.0125 * math.cos(a), 0.0125 * math.sin(a), 0.0), (0.0080 * math.cos(a), 0.0080 * math.sin(a), 0.0255), 0.0021, 8), wood)
    b.obj('Stool', root)


def cone_prof(z0, r, h):
    return [(0, z0), (r - 0.0012, z0), (r, z0 + 0.0014), (r * 0.80, z0 + h * 0.28), (r * 0.55, z0 + h * 0.55),
            (r * 0.28, z0 + h * 0.80), (r * 0.08, z0 + h * 0.97), (0, z0 + h)]


def build_tree():
    root = empty('tree')
    b = Builder()
    base, trunk = mat('Base', PAL['beech'], 0.7), mat('Trunk', PAL['beech_dark'], 0.7)
    leaf, leaf2 = mat('Leaf', PAL['moss'], 0.72), mat('LeafTop', PAL['moss_dark'], 0.72)
    b.add(lathe([(0, 0), (0.0115, 0), (0.0125, 0.0010), (0.0125, 0.0030), (0.0115, 0.0040), (0, 0.0040)], 28, sharp=40), base)
    b.add(lathe([(0, 0.0035), (0.0042, 0.0035), (0.0037, 0.0240), (0, 0.0240)], 12, sharp=40), trunk)
    b.add(lathe(cone_prof(0.0160, 0.0190, 0.0310), 24, sharp=50), leaf)
    b.add(lathe(cone_prof(0.0360, 0.0145, 0.0340), 24, sharp=50), leaf2)
    b.obj('Tree', root)


def build_stone():
    root = empty('stone')
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=3, radius=0.010)
    rng = random.Random(11)
    for v in bm.verts:
        v.co *= 1.0 + rng.uniform(-0.05, 0.05)
        v.co.x *= 1.0
        v.co.y *= 0.80
        v.co.z *= 0.55
        if v.co.z < -0.0025:
            v.co.z = -0.0025 + (v.co.z + 0.0025) * 0.35
    mz = min(v.co.z for v in bm.verts)
    for v in bm.verts:
        v.co.z -= mz
    finish(bm, 180)
    single('Stone', bm, mat('Stone', PAL['stone'], 0.78), root)


# ---- tray + token slot + tokens ----------------------------------------------------
TRAY = dict(field_w=0.48, field_d=0.32, rim=0.020, board_t=0.012, rim_h=0.015, field_top=0.014)


def build_tray():
    root = empty('tray')
    beech, beech_dark = mat('Beech', PAL['beech'], 0.68), mat('BeechDark', PAL['beech_dark'], 0.7)
    moss = mat('Moss', PAL['moss'], 0.78)
    hw = TRAY['field_w'] / 2 + TRAY['rim']
    hh = TRAY['field_d'] / 2 + TRAY['rim']
    bt, top = TRAY['board_t'], TRAY['board_t'] + TRAY['rim_h']
    b = Builder()
    # board slab with chamfered edges
    b.add(rrect_loft(hw, hh, 0.012, [(0.0015, 0.0), (0.0, 0.0015), (0.0, bt - 0.0015), (0.0015, bt)],
                     closed=False, caps=True, csteps=6, sharp=50), beech_dark)
    # rim: rounded cross-section, set 2 mm in from the board edge so the seam reads
    ro, ri, din = 0.004, 0.003, TRAY['rim']
    prof = [(0.002, bt)]
    prof += [(0.002 + ro - ro * math.cos(math.radians(a)), top - ro + ro * math.sin(math.radians(a))) for a in (0, 30, 60, 90)]
    prof += [(din - ri + ri * math.cos(math.radians(a)), top - ri + ri * math.sin(math.radians(a))) for a in (90, 60, 30, 0)]
    prof += [(din, bt)]
    b.add(rrect_loft(hw, hh, 0.012, prof, closed=True, csteps=6, sharp=40), beech)
    # corner dowels on the rim top
    for sx in (-1, 1):
        for sy in (-1, 1):
            b.add(lathe([(0, top - 0.001), (0.0032, top - 0.001), (0.0032, top + 0.0003), (0, top + 0.0003)], 14, sharp=40),
                  beech_dark, MT(sx * (hw - 0.011), sy * (hh - 0.011), 0))
    b.obj('Board', root)
    f = Builder()
    f.add(box(TRAY['field_w'], TRAY['field_d'], TRAY['field_top'] - bt + 0.001), moss, MT(0, 0, bt - 0.001))
    f.obj('Field', root)


def build_token_slot():
    root = empty('token_slot')
    prof = [(0, 0), (0.0145, 0), (0.0150, 0.0005), (0.0150, 0.0025), (0.0145, 0.0030), (0.0137, 0.0030),
            (0.0134, 0.0027), (0.0134, 0.0013), (0, 0.0013)]
    single('Slot', lathe(prof, 32, sharp=40), mat('Slot', PAL['beech_dark'], 0.72), root)


def icon_who(b, m):
    w, r = 0.0062, 0.0031
    yb, yt = -0.0062, 0.0060
    pts = [(-w / 2, yb), (w / 2, yb)] + [(r * math.cos(math.radians(a)), yt - r + r * math.sin(math.radians(a))) for a in range(0, 181, 20)]
    b.add(prism(pts, 0.0012), m)
    b.add(box(0.0120, 0.0018, 0.0012), m, MT(0, -0.0071, 0))
    b.add(prism([(w / 2 - 0.0004, 0.0026), (w / 2 - 0.0004, 0.0006), (w / 2 + 0.0042, 0.0016)], 0.0012), m)


def icon_what(b, m):
    s, fw = 0.0128, 0.0020
    for sy in (-1, 1):
        b.add(box(s, fw, 0.0012), m, MT(0, sy * (s / 2 - fw / 2), 0))
    for sx in (-1, 1):
        b.add(box(fw, s - 2 * fw, 0.0012), m, MT(sx * (s / 2 - fw / 2), 0, 0))
    b.add(box((s - 2 * fw) * math.sqrt(2) - 0.0012, 0.0017, 0.0012), m, MR('Z', 45))


def icon_where(b, m):
    b.add(lathe([(0.0062, 0), (0.0088, 0), (0.0088, 0.0012), (0.0062, 0.0012)], 32, closed=True, sharp=40), m)
    b.add(lathe([(0, 0), (0.0027, 0), (0.0027, 0.0012), (0, 0.0012)], 16, sharp=40), m)


def build_token(kind):
    color = dict(who=PAL['blue'], what=PAL['red'], where=PAL['moss'])[kind]
    root = empty('token_' + kind)
    b = Builder()
    wood, paint = mat('Wood', PAL['beech'], 0.7), mat('Paint', color, 0.62)
    b.add(lathe([(0, 0), (0.0122, 0), (0.0130, 0.0008), (0.0130, 0.0052), (0.0122, 0.0060), (0, 0.0060)], 32, sharp=40), wood)
    b.add(lathe([(0, 0.0055), (0.0108, 0.0055), (0.0108, 0.0064), (0.0104, 0.0068), (0, 0.0068)], 32, sharp=40), paint)
    b.obj('Disc', root)
    ib = Builder()
    icon_m = mat('Icon', PAL['white'], 0.65)
    dict(who=icon_who, what=icon_what, where=icon_where)[kind](ib, icon_m)
    ib.obj('Icon', root, (0, 0, 0.0068))


# ---- stream, lanes -----------------------------------------------------------------
def build_stream():
    root = empty('stream_section')
    water, sand = mat('Water', PAL['stream'], 0.6), mat('Sand', PAL['sand'], 0.78)
    ripple = mat('Ripple', mix_hex(PAL['stream'], '#FFFFFF', 0.75), 0.6)
    half_w, half_l, rows = 0.020, 0.160, 32
    bm = bmesh.new()
    sec_mat = [1, 1, 0, 0, 0, 1, 1]  # per cross-section segment: 0 water, 1 sand
    grid = []
    for k in range(rows + 1):
        y = -half_l + 2 * half_l * k / rows
        xl = -0.0140 + 0.0022 * math.sin(TAU * y / 0.11 + 0.5)
        xr = 0.0140 + 0.0022 * math.sin(TAU * y / 0.11 + 1.7)
        sec = [(-half_w, 0.0), (-half_w, 0.001), (xl, 0.001), (xl + 0.0025, 0.003), (xr - 0.0025, 0.003),
               (xr, 0.001), (half_w, 0.001), (half_w, 0.0)]
        grid.append([bm.verts.new((x, y, z)) for x, z in sec])
    for k in range(rows):
        for i in range(len(sec_mat)):
            f = bm.faces.new([grid[k][i], grid[k][i + 1], grid[k + 1][i + 1], grid[k + 1][i]])
            f.material_index = sec_mat[i]
    for ring, flip in ((grid[0], False), (grid[-1], True)):
        f = bm.faces.new(ring[::-1] if flip else ring)
        f.material_index = 1
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    shade(bm, 45)
    b = Builder()
    b.mats = [water, sand]
    me_bm = bm
    # merge manually to keep per-face material indices
    me_bm.verts.index_update()
    nv = [b.bm.verts.new(v.co) for v in me_bm.verts]
    for f in me_bm.faces:
        nf = b.bm.faces.new([nv[v.index] for v in f.verts])
        nf.material_index = f.material_index
        nf.smooth = f.smooth
    for e in me_bm.edges:
        if not e.smooth:
            ne = b.bm.edges.get([nv[e.verts[0].index], nv[e.verts[1].index]])
            if ne:
                ne.smooth = False
    me_bm.free()
    rng = random.Random(5)
    for k in range(7):
        y = -0.145 + k * 0.047 + rng.uniform(-0.01, 0.01)
        x = rng.uniform(-0.007, 0.007)
        b.add(box(0.0009, 0.0070, 0.0003, centered=False), ripple, MT(x, y, 0.0029) @ MR('Z', rng.uniform(-12, 12)))
    b.obj('Stream', root)


LANE_PROF = [(-0.020, 0.0), (0.020, 0.0), (0.020, 0.0015), (0.0195, 0.0020), (0.0115, 0.0020), (0.0115, 0.0011),
             (0.0085, 0.0011), (0.0085, 0.0020), (-0.0085, 0.0020), (-0.0085, 0.0011), (-0.0115, 0.0011),
             (-0.0115, 0.0020), (-0.0195, 0.0020), (-0.0200, 0.0015)]
LANE_GROOVE = {4, 5, 6, 8, 9, 10}  # segment i -> i+1 that belongs to a groove


def lane_mesh(frames, wood, groove):
    b = Builder()
    b.mats = [wood, groove]
    bm = b.bm
    n = len(LANE_PROF)
    rings = [[bm.verts.new(o + x * xd + Vector((0, 0, z))) for x, z in LANE_PROF] for o, xd in frames]
    for k in range(len(rings) - 1):
        for i in range(n):
            j = (i + 1) % n
            f = bm.faces.new([rings[k][i], rings[k][j], rings[k + 1][j], rings[k + 1][i]])
            f.material_index = 1 if i in LANE_GROOVE else 0
    bm.faces.new(rings[0])
    bm.faces.new(rings[-1][::-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    shade(bm, 30)
    return b


def build_lane_straight():
    root = empty('lane_straight')
    wood, groove = mat('Lane', PAL['beech_light'], 0.7), mat('Groove', PAL['beech_dark'], 0.75)
    frames = [(Vector((0, y, 0)), Vector((1, 0, 0))) for y in (-0.04, 0.04)]
    lane_mesh(frames, wood, groove).obj('Lane', root)


def build_lane_curve():
    root = empty('lane_curve')
    wood, groove = mat('Lane', PAL['beech_light'], 0.7), mat('Groove', PAL['beech_dark'], 0.75)
    C, R, steps = Vector((-0.04, -0.04, 0)), 0.06, 16
    frames = []
    for k in range(steps + 1):
        t = math.radians(90 * k / steps)
        rd = Vector((math.cos(t), math.sin(t), 0))
        frames.append((C + R * rd, rd))
    lane_mesh(frames, wood, groove).obj('Lane', root)


# ---- confetti ------------------------------------------------------------------------
def build_confetti():
    root = empty('confetti')
    m = mat('Confetti', '#FFFFFF', 0.7, vcol=True)
    b = Builder()
    rng = random.Random(42)
    cols = [PAL[k] for k in ('pip', 'mo', 'tuck', 'red', 'green', 'blue', 'key', 'moss', 'pip', 'tuck', 'mo', 'red')]
    spans = []
    for k in range(12):
        while True:
            p = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1)))
            if p.length <= 1.0:
                break
        p *= 0.0235
        rot = Euler((rng.uniform(0, TAU), rng.uniform(0, TAU), rng.uniform(0, TAU))).to_matrix().to_4x4()
        spans.append((b.add(box(0.010, 0.010, 0.0006, centered=True), m, MT(p.x, p.y, 0.030 + p.z) @ rot), cols[k]))
    # recentre so the scatter's bounding-box base centre sits on the origin
    vs = b.bm.verts
    lo = Vector((min(v.co.x for v in vs), min(v.co.y for v in vs), min(v.co.z for v in vs)))
    hi = Vector((max(v.co.x for v in vs), max(v.co.y for v in vs), max(v.co.z for v in vs)))
    off = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
    for v in vs:
        v.co -= off
    layer = b.bm.loops.layers.float_color.new('Color')
    for rng_faces, hc in spans:
        c = Vector(lin(hc))
        for fi in rng_faces:
            for loop in b.bm.faces[fi].loops:
                loop[layer] = c
    b.obj('Confetti', root)


ASSETS = [
    ('helper', build_helper), ('crate', build_crate), ('crate_heavy', build_crate_heavy),
    ('plank_crate', build_plank_crate), ('bridge', build_bridge), ('pad', build_pad), ('key', build_key),
    ('gate', build_gate), ('stool', build_stool), ('tree', build_tree), ('stone', build_stone),
    ('tray', build_tray), ('token_slot', build_token_slot),
    ('token_who', lambda: build_token('who')), ('token_what', lambda: build_token('what')),
    ('token_where', lambda: build_token('where')),
    ('stream_section', build_stream), ('lane_straight', build_lane_straight), ('lane_curve', build_lane_curve),
    ('confetti', build_confetti),
]
TRI_LIMIT = dict(tray=4000)


# ================================================================ export + verify
def export(name):
    bpy.ops.object.select_all(action='DESELECT')
    for ob in bpy.context.scene.objects:
        ob.select_set(True)
    path = os.path.join(OUT, name + '.glb')
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=True,
                              export_yup=True, export_texcoords=False, export_normals=True,
                              export_materials='EXPORT', export_cameras=False, export_lights=False,
                              export_animations=False, export_extras=False)
    return path


def glb_json(path):
    with open(path, 'rb') as fh:
        data = fh.read()
    clen, _ = struct.unpack_from('<II', data, 12)
    return json.loads(data[20:20 + clen])


def verify(names):
    rows, notes = [], {}
    for name in names:
        path = os.path.join(OUT, name + '.glb')
        purge()
        bpy.ops.import_scene.gltf(filepath=path)
        objs = list(bpy.context.scene.objects)
        tris, mats = 0, []
        mn, mx = Vector((1e9, 1e9, 1e9)), Vector((-1e9, -1e9, -1e9))
        for o in objs:
            if o.type != 'MESH':
                continue
            me = o.data
            me.calc_loop_triangles()
            tris += len(me.loop_triangles)
            for m in me.materials:
                if m and m.name not in mats:
                    mats.append(m.name)
            for v in me.vertices:
                w = o.matrix_world @ v.co
                mn = Vector(map(min, mn, w))
                mx = Vector(map(max, mx, w))
        J = glb_json(path)
        gtris = 0
        for node in J['nodes']:
            if 'mesh' in node:
                for prim in J['meshes'][node['mesh']]['primitives']:
                    gtris += J['accessors'][prim['indices']]['count'] // 3
        size = mx - mn
        ctr = (mx + mn) / 2
        # Blender (x, y, z) -> glTF (x, z, -y)
        gl_size = (size.x, size.z, size.y)
        gl_base = (ctr.x, mn.z, -ctr.y)
        roots = [o for o in objs if o.parent is None]
        tree = ', '.join('%s > %s' % (r.name, ' + '.join(sorted(c.name for c in r.children)) or '-') for r in roots)
        limit = TRI_LIMIT.get(name, 1500)
        rows.append(dict(name=name, tree=tree, size=gl_size, base=gl_base, tris=tris, gtris=gtris, mats=mats,
                         ok=tris <= limit, limit=limit, kb=os.path.getsize(path) / 1024))
        print('VERIFY %-15s %-55s size(m) X%.4f Y%.4f Z%.4f  base(%.4f,%.4f,%.4f)  tris %d (glb %d)  mats %s' % (
            name, tree, *gl_size, *gl_base, tris, gtris, mats))
        nodes = {n.get('name'): n for n in J['nodes']}
        if name == 'helper':
            nose = nodes['Nose']
            acc = J['accessors'][J['meshes'][nose['mesh']]['primitives'][0]['attributes']['POSITION']]
            t = nose.get('translation', [0, 0, 0])
            ob = bpy.data.objects['Nose']
            bmin = min((ob.matrix_world @ v.co).y for v in ob.data.vertices)
            notes['nose'] = dict(translation=t, pos_min=acc['min'], pos_max=acc['max'], blender_min_y=bmin)
            print('VERIFY nose node translation %s, local POSITION min %s max %s; re-imported Blender min y %.4f' % (
                t, acc['min'], acc['max'], bmin))
        if name == 'gate':
            notes['door'] = nodes['Door'].get('translation')
            notes['padlock'] = nodes['Padlock'].get('translation')
            print('VERIFY gate Door translation %s, Padlock translation %s' % (notes['door'], notes['padlock']))
    return rows, notes


def f3(x):
    return '%.3f' % (0.0 if abs(x) < 5e-4 else x)


def r4(v):
    return [round(x, 4) for x in v] if v else v


def write_table(rows, notes):
    L = ['# Pointlings toy assets',
         '',
         'Generated by `assets-src/build_assets.py` (do not edit by hand). Every file in `public/models/` was',
         're-imported into a fresh Blender scene after export; the numbers below come from that re-import',
         '(triangles cross-checked against the GLB index accessors).',
         '',
         'Units are metres. Sizes are the glTF axes: X = width, Y = height (up), Z = depth (+Z = toward the player).',
         '"Base" is the bounding-box base centre in glTF coordinates (0, 0, 0 means the origin sits at the base centre).',
         '',
         '| file | nodes (root > children) | size X x Y x Z (m) | base centre | triangles | materials |',
         '|---|---|---|---|---|---|']
    for r in rows:
        L.append('| %s.glb | %s | %s x %s x %s | %s, %s, %s | %d%s | %s |' % (
            r['name'], r['tree'], *map(f3, r['size']), *map(f3, r['base']), r['tris'],
            '' if r['ok'] else ' (OVER %d)' % r['limit'], ', '.join(r['mats'])))
    nose = notes.get('nose')
    L += ['',
          '## Axes and pivots',
          '']
    if nose:
        L.append('- **Helper nose points glTF +Z** (three.js forward: `Object3D.lookAt` aims +Z, so `helper.lookAt(target)` turns '
                 'the nose to the target). Checked in the exported file: node `Nose` translation %s, its local POSITION '
                 'z range %.4f .. %.4f (tip at +%.4f m); re-imported into Blender the nose tip sits at y = %.4f (Blender -Y).' % (
                     [round(v, 4) for v in nose['translation']], nose['pos_min'][2], nose['pos_max'][2],
                     nose['pos_max'][2], nose['blender_min_y']))
    L += ['- Modelled in Blender with Z up and forward = -Y; the exporter converts to glTF Y up, so Blender -Y = glTF +Z.',
          '- `helper`: `Nose` and `Eyes` have their origin on the body axis at head height (y = %.3f), so rotating either '
          'about its local Y swings it around the face. `Body` material is `Body` (recolour: Pip #F2C14E, Mo #5B8DEF, '
          'Tuck #F08A6C); `Base` is the beech base ring (recolour to the accent for the selection state).' % HELPER['head_z'],
          '- `gate`: spans X (8 cm, two tiles). `Door` (rails, stiles, brace) pivots on the left post axis at '
          'translation %s; rotate it about local Y to swing open. `Padlock` is its own node at %s so it can drop away.' % (
              r4(notes.get('door')), r4(notes.get('padlock'))),
          '- `tray`: the moss `Field` is exactly the 12 x 8 grid (0.48 x 0.32 m) centred on the origin; its top (the surface '
          'props stand on) is at y = %.3f. The beech rim (2 cm wide, top at y = %.3f) sits outside the grid, so the '
          'board outline is %.2f x %.2f m. With LEVELS.md coordinates (x from the player\'s left, y = 0 the near row), '
          'tile (x, y) centre = (-0.22 + 0.04 x, %.3f, 0.14 - 0.04 y) in glTF (the player sits on the +Z side).' % (
              TRAY['field_top'], TRAY['board_t'] + TRAY['rim_h'], TRAY['field_w'] + 2 * TRAY['rim'],
              TRAY['field_d'] + 2 * TRAY['rim'], TRAY['field_top']),
          '- `crate`, `crate_heavy`, `plank_crate`, `pad`, `token_*`: recolour through the material named `Paint`. '
          '`pad` also has `PaintLight` (the inner disc, 60% toward white).',
          '- `crate_heavy`: body 6 x 4 x 4 cm along X; the rope handles stick out of both X ends (one per helper).',
          '- `bridge`: planks run along X (9 cm), so it spans a stream section laid along Z; lay it on the water top (3 mm).',
          '- `stream_section`: runs along Z (0.32 m, the full grid depth), 4 cm wide in X: water 3 mm tall in the middle, '
          '1 mm sand banks on both X edges with a wavy waterline.',
          '- `lane_straight`: 8 cm along Z, 4 cm wide. `lane_curve`: centre-line radius 6 cm, fills a 2 x 2 tile block '
          '(8 x 8 cm) centred on the origin; it joins the block\'s near edge at x = +0.02 to its left edge at z = -0.02 '
          '(both on tile centre lines). Rotate in 90 degree steps for the other turns.',
          '- `token_*`: the pictogram is the child `Icon` (warm white, raised 1.2 mm on the painted face); it reads upright '
          'for a player on the +Z side (the WHO peg doll faces +X). `token_slot` recess floor is at y = 0.0013, so a token '
          'dropped in sits at y = 0.0013.',
          '- `helper`: the origin is the base-ring centre on the body axis; the bounding box is not centred in Z because the '
          'nose sticks 3.4 cm forward (+Z) while the base reaches 2.5 cm back.',
          '- `stream_section` has sand banks on both X edges, so two sections side by side (a two-tile stream such as '
          'Level 1 x = 6..7) show a sand bar down the middle; lay one section per stream, or scale X by 2 for a wide one.',
          '- `confetti`: one mesh, one material `Confetti` (white base colour x COLOR_0 vertex colours), squares scattered in a '
          '6 cm sphere centred 3 cm above the origin.',
          '- Materials are Principled BSDF only, roughness 0.6 to 0.8, no textures or UVs; metallic 0.35 to 0.45 on brass/iron.',
          ]
    with open(os.path.join(HERE, 'ASSETS.md'), 'w') as fh:
        fh.write('\n'.join(L) + '\n')


# ================================================================ overview render
def import_glb(name, M, recolor=None):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(OUT, name + '.glb'))
    new = [o for o in bpy.data.objects if o not in before]
    for o in new:
        if o.parent is None:
            o.matrix_world = M @ o.matrix_world
    if recolor:
        for o in new:
            if o.type == 'MESH':
                for slot in o.material_slots:
                    m = slot.material
                    if m and m.name.split('.')[0] in recolor:
                        m2 = m.copy()
                        m2.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = lin(recolor[m.name.split('.')[0]])
                        slot.material = m2
    return new


def tile(i, j, lift=0.0):
    """Blender coords of tile (i, j) centre; j = 0 is the near row (Blender -Y, toward the camera)."""
    return Vector((-0.22 + 0.04 * i, -0.14 + 0.04 * j, TRAY['field_top'] + lift))


def P(v, rz=0.0):
    return MT(*v) @ MR('Z', rz)


def render_overview(engine):
    purge()
    sc = bpy.context.scene
    # table: a big beech plane
    tb = Builder()
    tb.add(box(4.0, 4.0, 0.02), mat('Table', PAL.get(arg('--table'), mix_hex(PAL['beech'], PAL['beech_dark'], 0.45)), 0.75), MT(0, 0, -0.02))
    tb.obj('Table')
    import_glb('tray', MT())
    import_glb('stream_section', P(tile(6, 3.5)))
    import_glb('bridge', P(tile(6, 3, 0.003)))
    for i in (0.5, 2.5, 4.5):
        import_glb('lane_straight', P(tile(i, 3), 90))
    import_glb('lane_straight', P(tile(7.5, 3), 90))
    import_glb('lane_curve', P(tile(9.5, 3.5), -90))
    import_glb('lane_straight', P(tile(10, 5.5)))
    import_glb('pad', P(tile(10, 7)))
    import_glb('confetti', P(tile(10, 7, 0.02)))
    import_glb('helper', P(tile(2, 4), -35), {'Body': PAL['pip']})
    import_glb('helper', P(tile(8, 1), 30), {'Body': PAL['mo']})
    import_glb('helper', P(tile(4, 6), -15), {'Body': PAL['tuck']})
    import_glb('crate', P(tile(3, 1.5), 8))
    import_glb('crate', P(tile(1, 6), -6), {'Paint': PAL['blue']})
    import_glb('crate_heavy', P(tile(4.5, 0.6), 0), {'Paint': PAL['green']})
    import_glb('plank_crate', P(tile(0.5, 1), 0))
    import_glb('key', P(tile(8, 5), 25))
    import_glb('gate', P(tile(7.5, 7)))
    import_glb('stool', P(tile(11, 1)))
    import_glb('tree', P(tile(0, 7.2)))
    import_glb('tree', P(tile(11, 7.2)))
    import_glb('tree', P(tile(11, 3.6)))
    import_glb('stone', P(tile(5, 5), 30))
    import_glb('stone', P(tile(9, 2), 100))
    import_glb('stone', P(tile(2, 7.3), 200))
    # the order slate: three slots with tokens, on the table in front of the tray
    for k, kind in enumerate(('who', 'what', 'where')):
        x = -0.045 + 0.045 * k
        import_glb('token_slot', P((x, -0.215, 0.0)))
        import_glb('token_' + kind, P((x, -0.215, 0.0013), 0))

    # light: warm key from the upper left, soft warm sky
    sun = bpy.data.objects.new('Key', bpy.data.lights.new('Key', 'SUN'))
    sun.data.energy = float(arg('--sun', 2.9))
    sun.data.color = (1.0, 0.90, 0.76)
    sun.data.angle = math.radians(6)
    sun.rotation_euler = Vector((-0.55, 0.25, -0.80)).to_track_quat('Z', 'Y').to_euler()
    sc.collection.objects.link(sun)
    world = bpy.data.worlds.new('Sky')
    world.use_nodes = True
    bg = world.node_tree.nodes['Background']
    bg.inputs['Color'].default_value = (1.0, 0.93, 0.84, 1.0)
    bg.inputs['Strength'].default_value = float(arg('--sky', 0.7))
    sc.world = world

    cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam'))
    cam.data.lens = 47
    cam.location = (-0.17, -0.72, 0.50)
    tgt = Vector((0.0, -0.03, 0.0))
    cam.rotation_euler = (tgt - cam.location).to_track_quat('-Z', 'Y').to_euler()
    sc.collection.objects.link(cam)
    sc.camera = cam

    r = sc.render
    r.resolution_x, r.resolution_y, r.resolution_percentage = 1600, 900, int(arg('--pct', 100))
    r.filepath = arg('--out', os.path.join(HERE, 'overview.png'))
    r.image_settings.file_format = 'PNG'
    sc.view_settings.view_transform = arg('--view', 'Standard')
    if sc.view_settings.view_transform == 'AgX':
        sc.view_settings.look = 'AgX - Medium High Contrast'
    if engine == 'workbench':
        r.engine = 'BLENDER_WORKBENCH'
        sc.display.shading.light = 'STUDIO'
        sc.display.shading.color_type = 'MATERIAL'
        sc.display.shading.show_shadows = True
        sc.display.shading.show_cavity = True
        sc.view_settings.view_transform = 'Standard'
    elif engine == 'eevee':
        r.engine = 'BLENDER_EEVEE_NEXT'
        sc.eevee.taa_render_samples = 32
        sc.eevee.use_shadows = True
    else:
        r.engine = 'CYCLES'
        sc.cycles.device = 'CPU'
        sc.cycles.samples = int(arg('--samples', 40))
        sc.cycles.use_adaptive_sampling = True
        sc.cycles.use_denoising = True
        sc.cycles.max_bounces = 4
        sc.cycles.diffuse_bounces = 2
        sc.cycles.glossy_bounces = 2
        sc.cycles.transmission_bounces = 0
        sc.cycles.transparent_max_bounces = 2
    t = time.time()
    bpy.ops.render.render(write_still=True)
    print('RENDER %s %.1fs -> %s' % (engine, time.time() - t, r.filepath))


# ================================================================ main
def main():
    os.makedirs(OUT, exist_ok=True)
    only = arg('--only')
    names = [n for n, _ in ASSETS if not only or n in only.split(',')]
    for name, fn in ASSETS:
        if name not in names:
            continue
        purge()
        fn()
        export(name)
    print('BUILD+EXPORT %.1fs' % (time.time() - T0))
    rows, notes = verify(names)
    if not only:
        write_table(rows, notes)
    bad = [r['name'] for r in rows if not r['ok']]
    print('VERIFY done %.1fs; over budget: %s' % (time.time() - T0, bad or 'none'))
    if not arg('--no-render'):
        render_overview(arg('--engine', 'cycles'))
    print('TOTAL %.1fs' % (time.time() - T0))


main()
