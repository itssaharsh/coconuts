"""Coconuts foley props: every prop built procedurally in Blender 4.5 and exported as one .glb each.

Run from the repo root:
    blender -b --factory-startup --python assets-src/build_props.py
Options after `--`:  --no-render       skip overview.png
                     --only a,b        build/verify only these assets
                     --pct P --samples N --out path.png   quick test renders

Modelling convention: Blender Z up, metres, origin at the base centre, the prop's FRONT faces Blender -Y.
The glTF exporter writes Y up and maps Blender (x, y, z) -> glTF (x, z, -y): Blender -Y becomes glTF +Z
(the side that faces a viewer standing on +Z, the three.js default camera), Blender +Y becomes glTF -Z.
"""
import bpy, bmesh, math, os, sys, json, struct, time, random
from mathutils import Matrix, Vector

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


# ---------------------------------------------------------------- palette (design/tokens.css + brief)
PAL = dict(
    husk='#6B4A2B', flesh='#F3E9D8', shell='#4A3220',
    frame='#B98A5A', red='#C9573A', brass='#D9A441',
    walnut='#3B2A20', ink='#2B2320', black='#1E1A17', white='#FBF7F0',
    steel='#B8BEC4', plank='#D8B98A', kraft='#C9A06A', glass='#BFE3F2',
    beech='#EAD9B9', beech_light='#F4E8D2', beech_dark='#C9B08A',
    curtain='#A8322A', cuff='#5B8DEF',
    pip='#F2C14E', mo='#5B8DEF', tuck='#F08A6C', sky='#4EA8DE', moss='#7FA04A',
)


def hex_srgb(h):
    h = h.lstrip('#')
    return [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]


def to_lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def lin(h, a=1.0):
    return tuple(to_lin(c) for c in hex_srgb(h)) + (a,)


def mix_hex(a, b, t):
    ca, cb = hex_srgb(a), hex_srgb(b)
    return '#' + ''.join('%02X' % round(255 * (x + (y - x) * t)) for x, y in zip(ca, cb))


# ---------------------------------------------------------------- scene helpers
def purge():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.lights, bpy.data.cameras,
                 bpy.data.node_groups, bpy.data.worlds, bpy.data.images):
        for d in list(coll):
            coll.remove(d)
    for c in list(bpy.data.collections):
        bpy.data.collections.remove(c)


def mat(name, hexc, rough=0.7, metal=0.0, alpha=1.0, double=False):
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = lin(hexc)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    m.diffuse_color = lin(hexc, alpha)
    m.roughness = rough
    m.metallic = metal
    m.use_backface_culling = not double     # glTF doubleSided only where a surface is open (the curtain)
    if alpha < 1.0:
        b.inputs['Alpha'].default_value = alpha
        try:
            m.surface_render_method = 'BLENDED'
        except AttributeError:
            m.blend_method = 'BLEND'
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


def finish(bm, deg=None, recalc=True):
    if recalc:
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    shade(bm, deg)
    return bm


# ---------------------------------------------------------------- primitives (each returns a bmesh)
def lathe(prof, seg=24, closed=False, sharp=40):
    """Revolve (r, z) points around Z. r == 0 points are poles. Normals face the side a profile walking
    upward on the outside would face (outer up, over a rim, inner down = consistent shell)."""
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
    return finish(bm, sharp, recalc=False)


def sphere(r, u=12, v=8, sharp=80):
    # lathe instead of bmesh.ops.create_uvsphere: that op's face order is not stable run to run
    return lathe([(r * math.sin(math.pi * k / v), -r * math.cos(math.pi * k / v)) for k in range(v + 1)], u, sharp=sharp)


def rrect_ring(hw, hh, rc, d, z, cs=4, rmin=0.0004):
    """Points of a rounded rectangle (half sizes hw, hh, corner radius rc) inset by d, at height z (CCW)."""
    r = max(rc - d, rmin)
    cx, cy = max(hw - d - r, 0.0), max(hh - d - r, 0.0)
    pts = []
    for qx, qy, a0 in ((1, 1, 0), (-1, 1, 90), (-1, -1, 180), (1, -1, 270)):
        for k in range(cs + 1):
            a = math.radians(a0 + 90 * k / cs)
            pts.append((qx * cx + r * math.cos(a), qy * cy + r * math.sin(a), z))
    out = [pts[0]]
    for p in pts[1:]:  # drop coincident points (pill shapes where a straight side has zero length)
        if (Vector(p) - Vector(out[-1])).length > 1e-7:
            out.append(p)
    if (Vector(out[0]) - Vector(out[-1])).length < 1e-7:
        out.pop()
    return out


def rrect_loft(hw, hh, rc, prof, cs=4, sharp=40):
    """Sweep an (inset d, z) cross-section around a rounded rectangle, capped at both ends."""
    bm = bmesh.new()
    rings = [[bm.verts.new(p) for p in rrect_ring(hw, hh, rc, d, z, cs)] for d, z in prof]
    n = len(rings[0])
    assert all(len(r) == n for r in rings), 'ring sizes differ'
    for a, b in zip(rings, rings[1:]):
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new([a[i], a[j], b[j], b[i]])
    bm.faces.new(rings[0][::-1])
    bm.faces.new(rings[-1])
    return finish(bm, sharp, recalc=False)


def slab(w, d, h, rc=0.002, e=0.001, cs=4, es=2, sharp=35):
    """Rounded slab: w (X) x d (Y) x h (Z), plan corner radius rc, edge round e, base at z = 0, centred in XY."""
    e = min(e, h / 2 - 1e-5, rc + 1e-9) if e > 0 else 0.0
    if e <= 1e-6:
        prof = [(0.0, 0.0), (0.0, h)]
    else:
        prof = [(e * (1 - math.sin(math.pi / 2 * k / es)), e * (1 - math.cos(math.pi / 2 * k / es))) for k in range(es + 1)]
        prof += [(e * (1 - math.cos(math.pi / 2 * k / es)), h - e + e * math.sin(math.pi / 2 * k / es)) for k in range(es + 1)]
    return rrect_loft(w / 2, d / 2, max(rc, e + 1e-5), prof, cs, sharp)


def upright(w, hgt, t, rc=0.002, e=0.001, cs=4, es=2, sharp=35):
    """A slab standing up: w along X, hgt along Z (base at z = 0), thickness t along Y (front face at y = -t/2)."""
    bm = slab(w, hgt, t, rc, e, cs, es, sharp)
    bm.transform(MT(0, t / 2, hgt / 2) @ MR('X', 90))
    return bm


def prism(pts, h, sharp=None):
    """Extrude a 2D polygon (x, y) up by h (z from 0 to h)."""
    bm = bmesh.new()
    bot = [bm.verts.new((x, y, 0.0)) for x, y in pts]
    top = [bm.verts.new((x, y, h)) for x, y in pts]
    bm.faces.new(bot[::-1])
    bm.faces.new(top)
    n = len(pts)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new([bot[i], bot[j], top[j], top[i]])
    return finish(bm, sharp)


def segment_cyl(p0, p1, r, seg=8, sharp=50):
    """Capped cylinder between two points."""
    p0, p1 = Vector(p0), Vector(p1)
    d = p1 - p0
    bm = lathe([(0, 0), (r, 0), (r, d.length), (0, d.length)], seg=seg, sharp=sharp)
    rot = d.normalized().to_track_quat('Z', 'Y').to_matrix().to_4x4()
    bm.transform(MT(*p0) @ rot)
    return bm


def grid_shell(nu, nv, point, thick_dir, t, sharp=50):
    """Closed thin shell from a parametric surface point(u, v) (u, v in 0..1) offset +-t/2 along thick_dir(u, v)."""
    bm = bmesh.new()
    F, B = [], []
    for j in range(nv + 1):
        rf, rb = [], []
        for i in range(nu + 1):
            u, v = i / nu, j / nv
            p, n = Vector(point(u, v)), Vector(thick_dir(u, v)).normalized()
            rf.append(bm.verts.new(p - n * t / 2))
            rb.append(bm.verts.new(p + n * t / 2))
        F.append(rf)
        B.append(rb)
    for j in range(nv):
        for i in range(nu):
            bm.faces.new([F[j][i], F[j][i + 1], F[j + 1][i + 1], F[j + 1][i]])
            bm.faces.new([B[j][i], B[j + 1][i], B[j + 1][i + 1], B[j][i + 1]])
    edge = [(F[0][i], B[0][i]) for i in range(nu + 1)] + [(F[j][nu], B[j][nu]) for j in range(1, nv + 1)]
    edge += [(F[nv][i], B[nv][i]) for i in range(nu - 1, -1, -1)] + [(F[j][0], B[j][0]) for j in range(nv - 1, 0, -1)]
    for k in range(len(edge)):
        (f0, b0), (f1, b1) = edge[k], edge[(k + 1) % len(edge)]
        bm.faces.new([f0, b0, b1, f1])
    return finish(bm, sharp)


def clip_x(poly, xmin, xmax):
    """Clip a convex 2D polygon to xmin <= x <= xmax (Sutherland-Hodgman)."""
    def clip(pts, inside, inter):
        out = []
        for k in range(len(pts)):
            a, b = pts[k - 1], pts[k]
            if inside(b):
                if not inside(a):
                    out.append(inter(a, b))
                out.append(b)
            elif inside(a):
                out.append(inter(a, b))
        return out

    def at(xc):
        return lambda a, b: (xc, a[1] + (b[1] - a[1]) * (xc - a[0]) / (b[0] - a[0]))
    p = clip(poly, lambda q: q[0] >= xmin, at(xmin))
    return clip(p, lambda q: q[0] <= xmax, at(xmax)) if p else p


# ---------------------------------------------------------------- mesh builder
class Builder:
    def __init__(self):
        self.bm = bmesh.new()
        self.mats = []

    def add(self, src, material, M=None):
        if M is not None:
            src.transform(M)
            if M.determinant() < 0:
                bmesh.ops.reverse_faces(src, faces=src.faces[:])
        if material not in self.mats:
            self.mats.append(material)
        idx = self.mats.index(material)
        src.verts.index_update()
        nv = [self.bm.verts.new(v.co) for v in src.verts]
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
        return self

    def obj(self, name, parent=None, loc=(0, 0, 0)):
        """Make the object; geometry was authored in the parent's space, so it is shifted by -loc."""
        if Vector(loc).length > 0:
            self.bm.transform(MT(*(-Vector(loc))))
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


# ================================================================ assets
def M_husk():
    return mat('Husk', PAL['husk'], 0.8)


# ---- 1. coconut half: 8 cm across, 4 cm tall, open side up --------------------------------------
COCO = dict(R=0.040, H=0.0392, seg=24)


def coconut_mesh(name, parent, loc, seed):
    R, H, seg = COCO['R'], COCO['H'], COCO['seg']
    rng = random.Random(seed)
    ph = [rng.uniform(0, TAU) for _ in range(6)]
    # outer: flattened pole (so it sits), sphere arc up to the rim; the rim top is the dark shell ring,
    # the inner bowl is cream flesh
    a0 = math.radians(17)
    z0 = R - R * math.cos(a0)
    sz = H / (R - z0)
    outer = [(0.0, 0.0)] + [(R * math.sin(a0 + (math.pi / 2 - a0) * k / 6),
                             (R - R * math.cos(a0 + (math.pi / 2 - a0) * k / 6) - z0) * sz) for k in range(7)]
    b = Builder()
    bm = lathe(outer, seg, sharp=70)
    for v in bm.verts:  # fibrous, slightly lumpy husk with the three faint coconut ridges
        x, y, z = v.co
        r = math.hypot(x, y)
        if r < 1e-6 or z > H - 0.004:
            continue
        th = math.atan2(y, x)
        w = min(1.0, (H - 0.004 - z) / 0.008) * min(1.0, r / 0.02)
        k = 1 + w * (0.045 * max(0.0, math.cos(3 * (th + ph[0]))) ** 6
                     + 0.016 * math.sin(5 * th + ph[1] + 40 * z) + 0.010 * math.sin(9 * th + ph[2] - 70 * z)
                     + rng.uniform(-0.014, 0.014))
        v.co.x, v.co.y = x * k, y * k
        v.co.z = z + w * rng.uniform(-0.0006, 0.0006)
    b.add(finish(bm, 70, recalc=False), M_husk())
    rim = [(R, H), (R - 0.0016, H + 0.0008), (R - 0.0036, H + 0.0002)]
    b.add(lathe(rim, seg, sharp=60), mat('Shell', PAL['shell'], 0.7))
    Ri = R - 0.0036
    inner = [(Ri, H + 0.0002), (Ri - 0.0008, H - 0.0004)]
    zc = H - 0.0004
    for k in range(1, 5):
        a = math.pi / 2 * (1 - k / 5)
        inner.append(((Ri - 0.0008) * math.sin(a), zc - (zc - 0.0062) * math.cos(a)))
    inner.append((0.0, 0.0062))
    b.add(lathe(inner, seg, sharp=60), mat('Flesh', PAL['flesh'], 0.75))
    b.bm.transform(MT(*loc))  # authored at the origin; obj() expects parent space
    return b.obj(name, parent, loc)


def build_coconut_half():
    root = empty('CoconutHalf')
    coconut_mesh('Shell', root, (0, 0, 0), 11)


def build_coconut_pair():
    root = empty('CoconutPair')
    gap = 0.04  # 4 cm between the two rims
    off = COCO['R'] + gap / 2
    coconut_mesh('CoconutLeft', root, (-off, 0, 0), 11)
    coconut_mesh('CoconutRight', root, (off, 0, 0), 23)


# ---- 2. door: 9 cm wide frame, 14 cm tall overall, leaf hinged on its left (viewer's left) -------
DOOR = dict(base_h=0.007, top=0.140, W=0.090, post=0.010, depth=0.016, lintel=0.010, cap=0.004,
            leaf_t=0.007, gap=0.0005)


def build_door():
    D = DOOR
    root = empty('Door')
    wood, paint, brass = mat('Frame', PAL['frame'], 0.7), mat('Paint', PAL['red'], 0.65), mat('Brass', PAL['brass'], 0.6, 0.6)
    b = Builder()
    b.add(slab(0.104, 0.050, D['base_h'], 0.006, 0.0018, cs=3, es=2), mat('Plinth', PAL['beech_dark'], 0.75))
    z0, ztop = D['base_h'], D['top'] - D['cap']
    zl = ztop - D['lintel']          # underside of the lintel = top of the opening
    xo = D['W'] / 2 - D['post']      # opening half width
    for sx in (-1, 1):
        b.add(slab(D['post'], D['depth'], zl - z0 + 0.002, 0.0015, 0.0010, cs=2, es=1), wood, MT(sx * (xo + D['post'] / 2), 0, z0))
    b.add(slab(D['W'], D['depth'] + 0.002, D['lintel'], 0.0015, 0.0012, cs=2, es=1), wood, MT(0, 0, zl))
    b.add(slab(D['W'] + 0.008, D['depth'] + 0.007, D['cap'], 0.0018, 0.0015, cs=2, es=1), wood, MT(0, 0, ztop))
    # brass hinge knuckles on the hinge side (the leaf's front face sits at y = hy)
    lw, lh = 2 * xo - 2 * D['gap'], zl - z0 - 2 * D['gap']
    ly = -0.001                       # leaf centre plane
    hy = ly - D['leaf_t'] / 2         # front face of the leaf = hinge axis y
    hx = -xo + D['gap']               # hinge axis x (left edge of the leaf)
    for zc in (z0 + 0.026, zl - 0.026):
        b.add(segment_cyl((hx - 0.0006, hy - 0.0006, zc - 0.007), (hx - 0.0006, hy - 0.0006, zc + 0.007), 0.0016, 10), brass)
    b.obj('Frame', root)

    # leaf: origin on the hinge axis, so rotating Leaf about its local up axis swings the door
    pivot = Vector((hx, hy, z0 + D['gap']))
    L = Builder()
    L.add(upright(lw, lh, D['leaf_t'], 0.0012, 0.0010, cs=2, es=1), paint, MT(hx + lw / 2, ly, z0 + D['gap']))
    for zb, ph in ((0.012, 0.043), (0.064, 0.043)):   # raised panels, front and back
        for side in (-1, 1):
            m = MT(hx + lw / 2, ly + side * (D['leaf_t'] / 2 + 0.0004), z0 + D['gap'] + zb)
            L.add(upright(lw - 0.016, ph, 0.0016, 0.0025, 0.0007, cs=2, es=1), paint, m)
    leaf = L.obj('Leaf', root, pivot)
    # knob: child of Leaf (swings with it), brass rose + neck + ball on both faces
    K = Builder()
    kx, kz = hx + lw - 0.0075, z0 + 0.062
    for side in (-1, 1):
        f = ly + side * D['leaf_t'] / 2
        K.add(segment_cyl((kx, f, kz), (kx, f + side * 0.0012, kz), 0.0034, 10), brass)
        K.add(segment_cyl((kx, f, kz), (kx, f + side * 0.0050, kz), 0.0012, 6), brass)
        K.add(sphere(0.0033, 10, 6), brass, MT(kx, f + side * 0.0072, kz))
    knob_loc = Vector((kx, ly, kz))
    K.bm.transform(MT(*(-pivot)))
    K.obj('Knob', leaf, knob_loc - pivot)


# ---- 3. hotel desk bell: 6 cm across, 4.5 cm tall --------------------------------------------------
def build_bell():
    root = empty('Bell')
    brass = mat('Brass', PAL['brass'], 0.6, 0.6)
    b = Builder()
    base = [(0, 0), (0.0290, 0), (0.0300, 0.0012), (0.0300, 0.0062), (0.0286, 0.0078), (0.0268, 0.0090),
            (0.0262, 0.0108), (0.0250, 0.0116), (0, 0.0116)]
    b.add(lathe(base, 28, sharp=35), mat('Walnut', PAL['walnut'], 0.7))
    dome = [(0.0244, 0.0112), (0.0246, 0.0124), (0.0237, 0.0134)]
    for k in range(1, 9):
        a = math.radians(84 * (1 - k / 9) + 6)
        dome.append((0.0236 * math.sin(a), 0.0128 + 0.0236 * math.cos(a)))
    dome += [(0.0034, 0.0362), (0.0034, 0.0370), (0.0, 0.0370)]
    b.add(lathe(dome, 28, sharp=50), brass)
    b.obj('Base', root)
    # button: origin at its bottom (top of the dome collar); move it down ~3 mm to ring
    btn = [(0, 0), (0.0018, 0), (0.0018, 0.0036), (0.0046, 0.0036), (0.0047, 0.0062), (0.0040, 0.0074),
           (0.0024, 0.0080), (0, 0.0082)]
    B = Builder()
    B.add(lathe(btn, 16, sharp=50), mat('Button', PAL['black'], 0.6))
    B.bm.transform(MT(0, 0, 0.0370))
    B.obj('Button', root, (0, 0, 0.0370))


def obj_under(b, name, parent, parent_loc, own_loc):
    """b was authored in root space; make it a child of parent (which sits at parent_loc in root space)."""
    b.bm.transform(MT(*(-Vector(parent_loc))))
    return b.obj(name, parent, Vector(own_loc) - Vector(parent_loc))


# ---- 4. thunder sheet: 8 x 12 cm steel sheet on a wooden gallows -----------------------------------
def build_thunder_sheet():
    root = empty('ThunderSheet')
    wood = mat('Frame', PAL['frame'], 0.7)
    b = Builder()
    b.add(slab(0.115, 0.056, 0.010, 0.006, 0.002, cs=3), mat('Plinth', PAL['beech_dark'], 0.75))
    px, zarm = -0.049, 0.169
    b.add(slab(0.024, 0.022, 0.006, 0.003, 0.0015, cs=2, es=1), wood, MT(px, 0, 0.0095))         # foot block
    b.add(slab(0.012, 0.012, 0.171, 0.0015, 0.0012, cs=2, es=1), wood, MT(px, 0, 0.009))          # post
    xa0, xa1 = px - 0.006, 0.056
    b.add(slab(xa1 - xa0, 0.012, 0.011, 0.0015, 0.0012, cs=2, es=1), wood, MT((xa0 + xa1) / 2, 0, zarm))  # arm
    b.add(slab(0.007, 0.009, 0.026, 0.0012, 0.0010, cs=2, es=1), wood, MT(px + 0.003, 0, 0.150) @ MR('Y', 45))  # brace
    cx, W, Hh, ztop = 0.012, 0.080, 0.120, 0.153
    ink = mat('Cord', PAL['ink'], 0.8)
    for sx in (cx - W / 2 + 0.007, cx + W / 2 - 0.007):
        b.add(segment_cyl((sx, 0, ztop - 0.001), (sx, 0, zarm + 0.001), 0.0007, 6), ink)
        b.add(segment_cyl((sx, -0.0025, ztop + 0.0035), (sx, 0.0025, ztop + 0.0035), 0.0018, 10),
              mat('Brass', PAL['brass'], 0.6, 0.6))                                  # eyelet clip
    b.obj('Frame', root)
    # sheet: origin at the middle of its top edge, so it can swing on its cords
    steel = mat('Steel', PAL['steel'], 0.35, 0.6)
    S = Builder()

    def pt(u, v):
        env = math.sin(math.pi * v ** 0.9)
        y = 0.0034 * env * math.sin(TAU * (1.1 * v + 0.3 * u) + 0.6) + 0.0016 * (u - 0.5) * env
        return (cx + (u - 0.5) * W, y, ztop - v * Hh)
    S.add(grid_shell(6, 12, pt, lambda u, v: (0, 1, 0), 0.0008, sharp=45), steel)
    S.add(segment_cyl((cx - W / 2, 0, ztop), (cx + W / 2, 0, ztop), 0.0013, 8), steel)  # rolled top edge
    sheet = obj_under(S, 'Sheet', root, (0, 0, 0), (cx, 0, ztop))
    # handle: a turned dowel clamped on the bottom edge; child of Sheet so it shakes with it
    L = 0.094
    prof = [(0, 0), (0.0040, 0), (0.0049, 0.003), (0.0049, 0.008), (0.0040, 0.0115),
            (0.0040, L - 0.0115), (0.0049, L - 0.008), (0.0049, L - 0.003), (0.0040, L), (0, L)]
    zh = ztop - Hh - 0.0005
    H = Builder()
    H.add(lathe(prof, 12, sharp=40), mat('Handle', PAL['plank'], 0.65), MT(cx - L / 2, 0, zh) @ MR('Y', 90))
    obj_under(H, 'Handle', sheet, (cx, 0, ztop), (cx, 0, zh))


# ---- 5. slide whistle: 10 cm barrel on a two-cradle stand, Slide moves along +X ---------------------
def build_slide_whistle():
    root = empty('SlideWhistle')
    R, cz, x0, Lb = 0.0085, 0.026, -0.050, 0.100
    wood, paint, ink = mat('Barrel', PAL['plank'], 0.65), mat('Paint', PAL['red'], 0.65), mat('Ink', PAL['ink'], 0.7)
    b = Builder()
    prof = [(0, 0), (0.0050, 0), (0.0058, 0.0009), (0.0066, 0.006), (0.0077, 0.012), (R, 0.018),
            (R, Lb - 0.0025), (R + 0.0008, Lb - 0.002), (R + 0.0008, Lb), (0.0046, Lb), (0.0046, Lb - 0.008), (0, Lb - 0.008)]
    AX = MT(x0, 0, cz) @ MR('Y', 90)    # lathe Z -> barrel axis (+X)
    b.add(lathe(prof, 20, sharp=40), wood, AX)
    for s0 in (0.030, 0.072):          # painted bands
        band = [(R - 0.0002, s0), (R + 0.0006, s0 + 0.0005), (R + 0.0006, s0 + 0.0045), (R - 0.0002, s0 + 0.005)]
        b.add(lathe(band, 20, sharp=40), paint, AX)
    b.add(slab(0.0065, 0.0052, 0.0016, 0.0008, 0.0, cs=1), ink, MT(x0 + 0.026, 0, cz + R - 0.0013))   # window
    b.add(slab(0.0012, 0.0060, 0.0018, 0.0005, 0.0, cs=1), ink, MT(x0 - 0.0002, 0, cz + 0.0012))     # windway
    # stand
    plinth = mat('Plinth', PAL['beech_dark'], 0.75)
    b.add(slab(0.092, 0.034, 0.006, 0.005, 0.0015, cs=3), plinth, MT(0.004, 0, 0))
    frame = mat('Frame', PAL['frame'], 0.7)
    # cradles: a U-notched block (profile in YZ, 8 mm thick along X) that the barrel drops into
    cr = [(-0.013, 0.0055), (0.013, 0.0055), (0.013, cz + 0.002), (R + 0.0002, cz + 0.002)]
    cr += [((R + 0.0002) * math.cos(a), cz + (R + 0.0002) * math.sin(a))
           for a in [math.radians(-10 - 160 * k / 6) for k in range(7)]]
    cr += [(-R - 0.0002, cz + 0.002), (-0.013, cz + 0.002)]
    for xc in (-0.028, 0.036):
        b.add(prism(cr, 0.008), frame, MT(xc - 0.004, 0, 0) @ Matrix(((0, 0, 1, 0), (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 0, 1))))
    b.obj('Whistle', root)
    # slide: origin at the open barrel end on the axis; translate along -X to push it in
    S = Builder()
    xe = x0 + Lb
    S.add(segment_cyl((xe - 0.020, 0, cz), (xe + 0.026, 0, cz), 0.0028, 12), mat('Rod', PAL['beech_light'], 0.65))
    S.add(lathe([(0, 0), (0.0040, 0), (0.0046, 0.0012), (0.0046, 0.0030), (0.0030, 0.0040)], 14, sharp=40), ink,
          MT(xe + 0.024, 0, cz) @ MR('Y', 90))
    S.add(sphere(0.0062, 12, 8), ink, MT(xe + 0.0325, 0, cz))
    obj_under(S, 'Slide', root, (0, 0, 0), (xe, 0, cz))


# ---- 6. glass bag: crumpled kraft bag, 6 cm tall, glass shards peeking out ---------------------------
def resample(pts, n):
    P = [Vector(p) for p in pts]
    segs = [(P[k], P[(k + 1) % len(P)]) for k in range(len(P))]
    total = sum((b - a).length for a, b in segs)
    out, k, acc = [], 0, 0.0
    for i in range(n):
        target = total * i / n
        while acc + (segs[k][1] - segs[k][0]).length < target:
            acc += (segs[k][1] - segs[k][0]).length
            k += 1
        a, b = segs[k]
        out.append(a.lerp(b, (target - acc) / max((b - a).length, 1e-9)))
    return out


def build_glass_bag():
    root = empty('GlassBag')
    rng = random.Random(7)
    hw, hh, H, N = 0.025, 0.017, 0.060, 28
    base = resample(rrect_ring(hw, hh, 0.004, 0, 0, cs=3), N)
    levels = [0.0, 0.008, 0.018, 0.029, 0.040, 0.050, H]
    bm = bmesh.new()
    outer, inner = [], []
    for j, z in enumerate(levels):
        t = z / H
        ro, ri = [], []
        for i, p in enumerate(base):
            q, nq = base[(i + 1) % N], base[i - 1]
            tang = (q - nq).normalized()
            nrm = Vector((tang.y, -tang.x, 0))                        # outward
            pinch = 0.0
            if abs(p.x) > hw - 0.002 and abs(p.y) < hh - 0.004:       # gusset folds in on the short sides
                pinch = 0.0055 * t ** 1.6 * math.cos(math.pi / 2 * p.y / (hh - 0.004))
            flare = 0.0016 * t if abs(p.y) > hh - 0.002 else 0.0
            amp = 0.0 if j == 0 else (0.0011 if j < len(levels) - 1 else 0.0016)
            d = -pinch + flare + rng.uniform(-amp, amp) + 0.0007 * math.sin(7 * i * 0.37 + 3 * j)
            pos = Vector((p.x, p.y, z)) + nrm * d
            if j == len(levels) - 1:
                pos.z = H + 0.0022 * math.sin(i * 0.9) + rng.uniform(-0.0018, 0.0018)
            ro.append(bm.verts.new(pos))
            ri.append(bm.verts.new(pos - nrm * 0.0010 + Vector((0, 0, 0.0012 if j == 0 else 0))))
        outer.append(ro)
        inner.append(ri)
    for j in range(len(levels) - 1):
        for i in range(N):
            k = (i + 1) % N
            bm.faces.new([outer[j][i], outer[j][k], outer[j + 1][k], outer[j + 1][i]])
            bm.faces.new([inner[j][k], inner[j][i], inner[j + 1][i], inner[j + 1][k]])
    top = len(levels) - 1
    for i in range(N):
        k = (i + 1) % N
        bm.faces.new([outer[top][i], outer[top][k], inner[top][k], inner[top][i]])
    bm.faces.new(outer[0][::-1])
    bm.faces.new(inner[0])
    b = Builder()
    b.add(finish(bm, 28), mat('Kraft', PAL['kraft'], 0.8))
    b.obj('Bag', root)
    # shards: thin glass slivers standing up inside the bag, tops above the rim
    glass = mat('Glass', PAL['glass'], 0.3, 0.0, 0.6)
    S = Builder()
    for k, (x, y, h, w, tilt, spin) in enumerate([(-0.011, 0.003, 0.040, 0.014, 10, 20), (-0.002, -0.004, 0.046, 0.012, -6, -35),
                                                  (0.008, 0.004, 0.038, 0.016, -12, 70), (0.013, -0.005, 0.034, 0.010, 8, -10),
                                                  (0.002, 0.007, 0.036, 0.011, -10, 100)]):
        poly = [(-w / 2, 0), (w / 2, 0), (w * (0.25 + 0.2 * rng.random()), h * (0.45 + 0.2 * rng.random())),
                (w * (rng.random() - 0.5) * 0.4, h), (-w * (0.3 + 0.2 * rng.random()), h * (0.5 + 0.2 * rng.random()))]
        sh = prism(poly, 0.0018)
        sh.transform(MT(x, y, 0.031) @ MR('Z', spin) @ MR('Y', tilt) @ MT(0, 0.0009, 0) @ MR('X', 90))
        S.add(sh, glass)
    S.obj('Shards', root)


# ---- 7. clapperboard: 9 cm wide slate, striped Clap hinged on the left --------------------------------
def stripes(b, x0, x1, z0, h, t, n, slant, mats, y=0.0):
    s = (x1 - x0) / n
    for i in range(-2, n + 2):
        xa = x0 + i * s
        poly = clip_x([(xa, z0), (xa + s, z0), (xa + s + slant, z0 + h), (xa + slant, z0 + h)], x0, x1)
        if len(poly) < 3:
            continue
        area = 0.5 * abs(sum(poly[k - 1][0] * poly[k][1] - poly[k][0] * poly[k - 1][1] for k in range(len(poly))))
        if area < 1e-8:
            continue
        b.add(prism(poly, t), mats[i % 2], MT(0, y + t / 2, 0) @ MR('X', 90))


def build_clapperboard():
    root = empty('Clapperboard')
    W, Hs, T = 0.090, 0.060, 0.007
    slate, chalk = mat('Slate', PAL['ink'], 0.7), mat('Chalk', PAL['beech_light'], 0.75)
    sm = [mat('StripeBlack', PAL['black'], 0.6), mat('StripeWhite', PAL['white'], 0.6)]
    b = Builder()
    b.add(upright(W, Hs, T, 0.0025, 0.0012), slate)
    for zl in (0.015, 0.028, 0.041):
        b.add(upright(W - 0.014, 0.0016, 0.0008, 0.0006, 0.0), chalk, MT(0, -T / 2 - 0.0001, zl))
    for xd in (-0.013, 0.017):
        b.add(upright(0.0016, 0.0130, 0.0008, 0.0006, 0.0), chalk, MT(xd, -T / 2 - 0.0001, 0.0158))
    hb = 0.011
    stripes(b, -W / 2, W / 2, Hs - 0.0005, hb, 0.0078, 7, 0.009, sm)
    hz = Hs + hb - 0.0003          # hinge axis height (between the two bars)
    hx = -W / 2 + 0.0045
    b.add(segment_cyl((hx, -0.0062, hz), (hx, 0.0062, hz), 0.0022, 12), mat('Brass', PAL['brass'], 0.6, 0.6))
    b.obj('Slate', root)
    C = Builder()
    stripes(C, -W / 2, W / 2, hz + 0.0006, hb, 0.0078, 7, -0.009, sm)
    obj_under(C, 'Clap', root, (0, 0, 0), (hx, 0, hz))


# ---- 8. foley table: 0.70 x 0.40 x 0.015 beech top, 3 cm back rail, six painted spots -----------------
TABLE = dict(W=0.70, D=0.40, T=0.015, rail_h=0.030, spot_r=0.050,
             spots=[(-0.22, 0.075), (0.0, 0.075), (0.22, 0.075), (-0.22, -0.085), (0.0, -0.085), (0.22, -0.085)],
             spot_cols=['tuck', 'pip', 'sky', 'moss', 'mo', 'red'])


def build_table():
    T = TABLE
    root = empty('Table')
    b = Builder()
    b.add(slab(T['W'], T['D'], T['T'], 0.030, 0.0045, cs=8, es=3, sharp=30), mat('Beech', PAL['beech'], 0.7))
    b.obj('Top', root)
    r = Builder()
    rd = 0.032
    r.add(slab(T['W'] - 0.04, rd, T['rail_h'] + 0.0005, 0.012, 0.0055, cs=5, es=3, sharp=30),
          mat('Rail', mix_hex(PAL['beech'], PAL['beech_dark'], 0.3), 0.7), MT(0, T['D'] / 2 - 0.0045 - rd / 2, T['T'] - 0.0005))
    r.obj('Rail', root)
    sr = T['spot_r']
    for k, ((x, y), col) in enumerate(zip(T['spots'], T['spot_cols'])):
        s = Builder()
        prof = [(0, 0), (sr, 0), (sr, 0.0006), (sr - 0.0010, 0.0013), (0, 0.0013)]
        s.add(lathe(prof, 40, sharp=30), mat('Spot%d' % (k + 1), mix_hex(PAL[col], PAL['beech'], 0.42), 0.75),
              MT(x, y, T['T'] - 0.0004))
        obj_under(s, 'Spot%d' % (k + 1), root, (0, 0, 0), (x, y, T['T']))


# ---- 9. screen frame: proscenium around a 0.80 x 0.45 opening ----------------------------------------
SCREEN = dict(OW=0.80, OH=0.45, side=0.035, bot=0.035, ledge_h=0.020, depth=0.030)


def grid_surface(nu, nv, point):
    """Open single-sided surface facing -Y (front); exported double sided."""
    bm = bmesh.new()
    P = [[bm.verts.new(point(i / nu, j / nv)) for i in range(nu + 1)] for j in range(nv + 1)]
    for j in range(nv):
        for i in range(nu):
            bm.faces.new([P[j][i], P[j + 1][i], P[j + 1][i + 1], P[j][i + 1]])
    return finish(bm, 60, recalc=False)


def build_screen_frame():
    S = SCREEN
    root = empty('ScreenFrame')
    walnut, brass = mat('Walnut', PAL['walnut'], 0.65), mat('Brass', PAL['brass'], 0.6, 0.6)
    ow, zb = S['OW'] / 2, S['ledge_h'] + S['bot']
    zt, xo = zb + S['OH'], S['OW'] / 2 + S['side']
    zs, zap = zt + 0.068, zt + 0.135

    def arch(x):
        return zs + (zap - zs) * max(0.0, math.cos(math.pi / 2 * x / xo)) ** 1.5
    # matching inner/outer loops (bottom, right, top, left), bridged by a moulding profile
    sides = [((-ow, zb), (ow, zb), (-xo, S['ledge_h'] - 0.002), (xo, S['ledge_h'] - 0.002), 2, False),
             ((ow, zb), (ow, zt), (xo, S['ledge_h'] - 0.002), (xo, zs), 3, False),
             ((ow, zt), (-ow, zt), (xo, zs), (-xo, zs), 12, True),
             ((-ow, zt), (-ow, zb), (-xo, zs), (-xo, S['ledge_h'] - 0.002), 3, False)]
    inner, outer = [], []
    for i0, i1, o0, o1, n, is_arch in sides:
        for k in range(n):
            t = k / n
            inner.append(Vector((i0[0] + (i1[0] - i0[0]) * t, 0, i0[1] + (i1[1] - i0[1]) * t)))
            x = o0[0] + (o1[0] - o0[0]) * t
            outer.append(Vector((x, 0, arch(x) if is_arch else o0[1] + (o1[1] - o0[1]) * t)))
    hd = S['depth'] / 2
    prof = [(0.0, hd), (0.0, -hd + 0.004), (0.05, -hd), (0.42, -hd), (0.48, -hd - 0.005), (0.58, -hd - 0.005),
            (0.64, -hd), (1.0, -hd + 0.006), (1.0, hd)]
    bm = bmesh.new()
    rings = [[bm.verts.new(o.lerp(i, t) + Vector((0, y, 0))) for o, i in zip(outer, inner)] for t, y in prof]
    n = len(inner)
    for a, c in zip(rings, rings[1:] + rings[:1]):
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new([a[i], a[j], c[j], c[i]])
    b = Builder()
    b.add(finish(bm, 35), walnut)
    b.add(slab(0.90, 0.080, S['ledge_h'], 0.008, 0.003, cs=3, es=1), walnut, MT(0, -0.025, 0))
    b.add(lathe([(0, 0), (0.016, 0), (0.016, 0.003), (0.011, 0.006), (0, 0.007)], 16, sharp=40), brass,
          MT(0, -hd + 0.001, zap - 0.024) @ MR('X', 90))                     # brass boss on the arch
    b.obj('Frame', root)
    # curtain: three swags on the header + two pleated tails, lowest point 5 mm above the opening
    red = mat('Curtain', PAL['curtain'], 0.8, double=True)
    c = Builder()
    xs, ztop = [-0.42, -0.14, 0.14, 0.42], zt + 0.058
    for k in range(3):
        x0, x1 = xs[k], xs[k + 1]

        def sw(u, v, x0=x0, x1=x1):
            zl = zt + 0.036 - 0.031 * math.sin(math.pi * u)
            y = -hd - 0.009 - 0.012 * math.sin(math.pi * u) * (0.3 + 0.7 * v) \
                - 0.0045 * math.sin(v * math.pi * 3) * math.sin(math.pi * u) ** 0.5
            return (x0 + (x1 - x0) * u, y, ztop + (zl - ztop) * v)
        c.add(grid_surface(10, 6, sw), red)
    for sx in (-1, 1):
        def tail(u, v, sx=sx):
            x = sx * (0.438 - 0.036 * u)
            zbot = zt - 0.15 + 0.07 * u
            return (x, -hd - 0.010 - 0.004 * abs(math.sin(3 * math.pi * u)), zt + 0.060 + (zbot - zt - 0.060) * v)
        tb = grid_surface(6, 5, tail)
        if sx > 0:   # u runs toward -X on the right tail; flip so the face points front (-Y)
            bmesh.ops.reverse_faces(tb, faces=tb.faces[:])
        c.add(tb, red)
    for x in (-0.14, 0.14):
        c.add(sphere(0.011, 8, 4, sharp=80), red, MT(x, -hd - 0.016, zt + 0.047) @ MS(1, 0.6, 1))
    c.obj('Curtain', root)
    # footlights: brass cans on the ledge, tilted back toward the screen
    for name, x in (('FootlightL', -0.26), ('FootlightR', 0.26)):
        f = Builder()
        base = Vector((x, -0.048, S['ledge_h']))
        f.add(segment_cyl(base, base + Vector((0, 0, 0.008)), 0.0055, 10), brass)
        tilt = MT(*(base + Vector((0, 0, 0.007)))) @ MR('X', -40) @ MT(0, 0, -0.004)
        can = [(0, 0), (0.0100, 0), (0.0115, 0.003), (0.0115, 0.021), (0.0095, 0.021), (0.0095, 0.019)]
        f.add(lathe(can, 12, sharp=40), brass, tilt.copy())
        f.add(lathe([(0.0095, 0.019), (0, 0.019)], 12, sharp=40), mat('Lens', PAL['white'], 0.6), tilt.copy())
        obj_under(f, name, root, (0, 0, 0), base)


# ---- 10. hand glove: flat cut-out pointing glove, 10 cm, index finger up ------------------------------
def build_hand_glove():
    root = empty('HandGlove')
    white, cuff, ink = mat('Glove', PAL['white'], 0.7), mat('Cuff', PAL['cuff'], 0.65), mat('Ink', PAL['ink'], 0.7)
    g = Builder()

    def pill(w, h, t, x, z, y=0.0, rot=0.0, m=white, e=0.0028):
        g.add(upright(w, h, t, min(w, h) / 2 * 0.98, e, cs=4, es=1, sharp=40), m, MT(x, y, z) @ MR('Y', rot))
    pill(0.044, 0.040, 0.0070, 0.002, 0.012)                                     # palm
    pill(0.0135, 0.058, 0.0068, -0.009, 0.040)                                   # index finger
    for x, z, h, r in ((0.003, 0.036, 0.022, 6), (0.0135, 0.035, 0.021, 10), (0.0235, 0.033, 0.019, 16)):
        pill(0.0115, h, 0.0068, x, z, -0.0016, r)                                # curled fingers
    pill(0.0130, 0.030, 0.0068, -0.015, 0.019, -0.0016, -42)                     # thumb
    for x in (-0.004, 0.006, 0.016):                                             # stitch lines
        g.add(upright(0.0014, 0.011, 0.0006, 0.0006, 0.0, cs=2), ink, MT(x, -0.0037, 0.021))
    g.obj('Glove', root)
    c = Builder()
    c.add(upright(0.042, 0.016, 0.0100, 0.0045, 0.0028, cs=4, es=1, sharp=40), cuff)
    c.obj('Cuff', root)


# ================================================================ registry
ASSETS = [
    ('coconut_half', build_coconut_half), ('coconut_pair', build_coconut_pair), ('door', build_door),
    ('bell', build_bell), ('thunder_sheet', build_thunder_sheet), ('slide_whistle', build_slide_whistle),
    ('glass_bag', build_glass_bag), ('clapperboard', build_clapperboard), ('table', build_table),
    ('screen_frame', build_screen_frame), ('hand_glove', build_hand_glove),
]
TRI_LIMIT = dict(table=4000)
FRONT = dict(
    coconut_half='open side faces +Y (up); round, no front',
    coconut_pair='+Z; halves side by side along X',
    door='+Z (leaf front, knob on the +X side)',
    bell='+Z (round; button on top, +Y)',
    thunder_sheet='+Z (sheet face; post on -X)',
    slide_whistle='+Z (barrel along X, mouthpiece -X, slide +X)',
    glass_bag='+Z (wide face)',
    clapperboard='+Z (chalk lines face +Z)',
    table='+Z = near (player) edge; rail along the far edge (-Z)',
    screen_frame='+Z (audience side); opening is a through hole',
    hand_glove='+Z (back of the glove); index finger points +Y',
)


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


def tree_str(ob):
    kids = sorted(ob.children, key=lambda o: o.name)
    return ob.name + (' (' + ', '.join(tree_str(k) for k in kids) + ')' if kids else '')


def gl(v):
    """Blender vector -> glTF (x, z, -y)."""
    return Vector((v.x, v.z, -v.y))


def verify(names):
    rows, notes = [], {}
    for name in names:
        path = os.path.join(OUT, name + '.glb')
        purge()
        bpy.ops.import_scene.gltf(filepath=path)
        objs = list(bpy.context.scene.objects)
        bpy.context.view_layer.update()
        tris, mats = 0, []
        mn, mx = Vector((1e9,) * 3), Vector((-1e9,) * 3)
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
        gtris = sum(J['accessors'][p['indices']]['count'] // 3
                    for n in J['nodes'] if 'mesh' in n for p in J['meshes'][n['mesh']]['primitives'])
        size, ctr = mx - mn, (mx + mn) / 2
        roots = [o for o in objs if o.parent is None]
        limit = TRI_LIMIT.get(name, 1500)
        alpha = {m['name']: m.get('alphaMode', 'OPAQUE') for m in J.get('materials', [])}
        rows.append(dict(name=name, tree='; '.join(tree_str(r) for r in roots), size=(size.x, size.z, size.y),
                         base=(ctr.x, mn.z, -ctr.y), tris=tris, gtris=gtris, mats=mats, limit=limit,
                         ok=tris <= limit and tris == gtris, kb=os.path.getsize(path) / 1024,
                         blend=[k for k, v in alpha.items() if v != 'OPAQUE']))
        print('VERIFY %-14s %-70s W%.4f H%.4f D%.4f tris %d (glb %d) %s' % (name, rows[-1]['tree'], size.x, size.z, size.y,
                                                                         tris, gtris, mats))
        nodes = {n.get('name'): n for n in J['nodes']}

        def node_pos(nm):
            return [round(c, 4) for c in nodes[nm].get('translation', [0, 0, 0])]

        def mesh_range(nm):
            acc = J['accessors'][J['meshes'][nodes[nm]['mesh']]['primitives'][0]['attributes']['POSITION']]
            return acc['min'], acc['max']
        if name == 'door':
            lo, hi = mesh_range('Leaf')
            free = Vector((hi[0], 0, 0))
            opened = Matrix.Rotation(-1.2, 3, 'Y') @ free     # three.js leaf.rotation.y = -1.2
            notes['door'] = dict(leaf=node_pos('Leaf'), knob=node_pos('Knob'), lo=lo, hi=hi, opened=opened)
        if name == 'clapperboard':
            lo, hi = mesh_range('Clap')
            opened = Matrix.Rotation(0.5, 3, 'Z') @ Vector((hi[0], 0, 0))
            notes['clap'] = dict(pos=node_pos('Clap'), hi=hi, opened=opened)
        if name == 'bell':
            notes['button'] = node_pos('Button')
        if name == 'thunder_sheet':
            notes['sheet'] = dict(sheet=node_pos('Sheet'), handle=node_pos('Handle'))
        if name == 'slide_whistle':
            notes['slide'] = node_pos('Slide')
        if name == 'table':
            notes['spots'] = [node_pos('Spot%d' % k) for k in range(1, 7)]
        if name == 'screen_frame':
            notes['footlights'] = (node_pos('FootlightL'), node_pos('FootlightR'))
        if name == 'coconut_pair':
            notes['pair'] = (node_pos('CoconutLeft'), node_pos('CoconutRight'))
        if name == 'glass_bag':
            notes['glass_alpha'] = alpha.get('Glass')
    return rows, notes


def f3(x):
    return '%.3f' % (0.0 if abs(x) < 5e-4 else x)


def v3(v):
    return '(%s)' % ', '.join(f3(c) for c in v)


def write_props(rows, notes):
    S = SCREEN
    L = ['# Coconuts foley props',
         '',
         'Generated by `assets-src/build_props.py`; do not edit by hand. After export every `public/models/*.glb` was',
         're-imported into an empty Blender scene and measured; triangles are cross-checked against the GLB index accessors.',
         '',
         '**Axes.** glTF/three.js, metres, Y up. W = X extent, H = Y extent, D = Z extent. The exporter maps Blender',
         '(x, y, z) to glTF (x, z, -y): **Blender -Y becomes glTF +Z** (the front of every prop faces a viewer on +Z,',
         'like the three.js default camera), and **Blender +Y becomes glTF -Z** (glTF forward, away from that viewer).',
         'Origins sit at the base centre (bottom of the bounding box) unless a note says otherwise.',
         '',
         '| file | nodes: root (children) | W x H x D (m) | triangles | materials | front |',
         '|---|---|---|---|---|---|']
    for r in rows:
        L.append('| %s.glb | %s | %s x %s x %s | %d%s | %s | %s |' % (
            r['name'], r['tree'], *map(f3, r['size']), r['tris'],
            '' if r['ok'] else ' **(OVER %d or GLB mismatch %d)**' % (r['limit'], r['gtris']),
            ', '.join(r['mats']), FRONT[r['name']]))
    L += ['', '## Moving parts and anchors (glTF coordinates)', '']
    d = notes.get('door')
    if d:
        L.append('- **door / Leaf**: node origin on the hinge axis at %s (the leaf\'s front-left edge). The leaf mesh runs '
                 'x %s..%s from it, so the hinge is on the viewer\'s left. `Leaf.rotation.y = -1.2` swings the free edge to '
                 '%s, toward the viewer (+Z): **negative rotation.y opens the door toward the audience**, positive swings it '
                 'away through the frame (no stop is modelled, both work). `Knob` is a child of `Leaf` at %s, so it swings with it.'
                 % (d['leaf'], f3(d['lo'][0]), f3(d['hi'][0]), v3(d['opened']), d['knob']))
    if 'button' in notes:
        L.append('- **bell / Button**: origin at the bottom of the button at %s; translate it -0.003 on Y to press it.' % notes['button'])
    if 'sheet' in notes:
        L.append('- **thunder_sheet / Sheet**: origin at the middle of the sheet\'s top edge %s; rotate about X to swing it on its '
                 'cords. `Handle` is a child of `Sheet` (local %s, the dowel centre), so shaking the handle shakes the sheet.'
                 % (notes['sheet']['sheet'], notes['sheet']['handle']))
    if 'slide' in notes:
        L.append('- **slide_whistle / Slide**: origin on the barrel axis at the open end %s; the slide moves along X '
                 '(translate -X up to 0.020 to push it in, +X to pull it out).' % notes['slide'])
    c = notes.get('clap')
    if c:
        L.append('- **clapperboard / Clap**: origin on the left hinge pin at %s. `Clap.rotation.z = +0.5` lifts the free '
                 'end to %s: **positive rotation.z opens the clapper**, 0 is shut.' % (c['pos'], v3(c['opened'])))
    if 'pair' in notes:
        L.append('- **coconut_pair**: `CoconutLeft` at %s and `CoconutRight` at %s (4 cm between rims); each is a full '
                 'coconut_half with its own origin at its base centre.' % notes['pair'])
    if 'spots' in notes:
        L.append('- **table / Spot1..Spot6**: spot centres on the table top (y = %.3f is the top surface; spots are 1.3 mm '
                 'paint discs, radius %.3f): %s. Spot1-3 are the back row (left to right), Spot4-6 the front row. Each spot '
                 'has its own material `SpotN` for highlighting.' % (TABLE['T'], TABLE['spot_r'], ', '.join(
                     'Spot%d %s' % (k + 1, p) for k, p in enumerate(notes['spots']))))
    zb = S['ledge_h'] + S['bot']
    L.append('- **screen_frame**: the opening is a through hole, x -%.3f..%.3f, y %.3f..%.3f (centre (0, %.3f)). The frame '
             'body is %.3f deep with its flat back face at z = -%.3f (the moulding bead comes forward to z = +0.020, the '
             'curtain to about +0.047, the footlight ledge to +0.065), so put the 0.80 x 0.45 video plane at z <= -%.3f. '
             'The curtain\'s lowest point is 5 mm above the opening and the tails stay outside it. Footlights (L, R) '
             'origins on the ledge at %s and %s, cans tilted 40 degrees back toward the screen.' % (
                 S['OW'] / 2, S['OW'] / 2, zb, zb + S['OH'], zb + S['OH'] / 2, S['depth'], S['depth'] / 2,
                 S['depth'] / 2 + 0.001, *notes.get('footlights', ('?', '?'))))
    L += ['- **glass_bag / Shards**: material `Glass` is exported with alphaMode %s (alpha 0.6).' % notes.get('glass_alpha'),
          '- Materials are Principled BSDF only, no textures or UVs; roughness 0.6 to 0.8 except `Steel` (0.35, metallic 0.6, '
          'as briefed) and `Glass` (0.3, so it reads as glass); `Brass` is metallic 0.6.',
          '- Curved parts are smooth shaded with hard edges kept sharp. Every mesh is a closed solid exported single sided '
          '(`doubleSided: false`) except `Curtain`, whose open drape surfaces are exported double sided.',
          '- Re-running the script rewrites identical bytes (deterministic: fixed seeds, no bmesh primitives with unstable '
          'face order).']
    with open(os.path.join(HERE, 'PROPS.md'), 'w') as fh:
        fh.write('\n'.join(L) + '\n')


# ================================================================ overview render
def import_glb(name, M):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(OUT, name + '.glb'))
    new = [o for o in bpy.data.objects if o not in before]
    for o in new:
        if o.parent is None:
            o.matrix_world = M @ o.matrix_world
    return {o.name.split('.')[0]: o for o in new}


def P(x, y, z=0.0, rz=0.0):
    return MT(x, y, z) @ MR('Z', rz)


def render_overview():
    purge()
    sc = bpy.context.scene
    floor = Builder()
    floor.add(slab(30.0, 30.0, 0.02, 0.0, 0.0), mat('Floor', mix_hex(PAL['beech'], PAL['beech_dark'], 0.55), 0.75), MT(0, 0, -0.02))
    floor.obj('Floor')
    import_glb('table', MT())
    top = TABLE['T'] + 0.0013
    sp = TABLE['spots']
    o = import_glb('door', P(sp[0][0], sp[0][1], top, 8))
    o['Leaf'].matrix_basis = o['Leaf'].matrix_basis @ MR('Z', -38)
    import_glb('thunder_sheet', P(sp[1][0], sp[1][1], top, -4))
    import_glb('glass_bag', P(sp[2][0], sp[2][1], top, -12))
    import_glb('coconut_pair', P(sp[3][0], sp[3][1], top, 6))
    import_glb('bell', P(sp[4][0], sp[4][1], top, 0))
    import_glb('slide_whistle', P(sp[5][0] - 0.01, sp[5][1], top, -10))
    o = import_glb('clapperboard', P(*[float(c) for c in arg('--clap', '0.46,-0.06,-22').split(',')][:2], 0, float(arg('--clap', '0.46,-0.06,-22').split(',')[2])))
    o['Clap'].matrix_basis = o['Clap'].matrix_basis @ MR('Y', -22)
    import_glb('coconut_half', P(*[float(c) for c in arg('--half', '-0.45,-0.15').split(',')], 0, 0))
    import_glb('hand_glove', P(*[float(c) for c in arg('--glove', '-0.47,0.04').split(',')], 0, 35))
    sy = float(arg('--sy', 0.50))
    import_glb('screen_frame', P(0, sy, 0))
    zb = SCREEN['ledge_h'] + SCREEN['bot']
    scr = Builder()
    scr.add(upright(0.84, 0.49, 0.004, 0.0, 0.0), mat('Screen', '#D8D3CA', 0.8), MT(0, sy + SCREEN['depth'] / 2 + 0.004, zb - 0.02))
    scr.obj('ScreenStandIn')

    sun = bpy.data.objects.new('Key', bpy.data.lights.new('Key', 'SUN'))
    sun.data.energy = float(arg('--sun', 2.6))
    sun.data.color = (1.0, 0.90, 0.78)
    sun.data.angle = math.radians(2.0)
    sun.rotation_euler = Vector((0.62, 0.55, -0.62)).to_track_quat('-Z', 'Y').to_euler()
    sc.collection.objects.link(sun)
    world = bpy.data.worlds.new('Sky')
    world.use_nodes = True
    nt = world.node_tree
    bg = nt.nodes['Background']
    tc, sep, rng, ramp = (nt.nodes.new(t) for t in ('ShaderNodeTexCoord', 'ShaderNodeSeparateXYZ',
                                                     'ShaderNodeMapRange', 'ShaderNodeValToRGB'))
    nt.links.new(tc.outputs['Generated'], sep.inputs[0])
    nt.links.new(sep.outputs['Z'], rng.inputs['Value'])
    rng.inputs['From Min'].default_value, rng.inputs['From Max'].default_value = -0.15, 0.8
    nt.links.new(rng.outputs['Result'], ramp.inputs['Fac'])
    ramp.color_ramp.elements[0].color = (0.42, 0.33, 0.24, 1.0)     # warm wooden ground bounce
    ramp.color_ramp.elements[1].color = (0.88, 0.92, 1.0, 1.0)      # cool sky fill against the warm key
    nt.links.new(ramp.outputs['Color'], bg.inputs['Color'])
    bg.inputs['Strength'].default_value = float(arg('--sky', 0.65))
    # camera rays see a warm canvas backdrop (tokens --canvas); lighting keeps the gradient
    lp, cbg, mix = (nt.nodes.new(t) for t in ('ShaderNodeLightPath', 'ShaderNodeBackground', 'ShaderNodeMixShader'))
    cbg.inputs['Color'].default_value = lin('#F3EBDD')
    cbg.inputs['Strength'].default_value = 1.0
    nt.links.new(lp.outputs['Is Camera Ray'], mix.inputs['Fac'])
    nt.links.new(bg.outputs['Background'], mix.inputs[1])
    nt.links.new(cbg.outputs['Background'], mix.inputs[2])
    nt.links.new(mix.outputs['Shader'], nt.nodes['World Output'].inputs['Surface'])
    sc.world = world

    cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam'))
    cam.data.lens = float(arg('--lens', 22))
    cam.location = Vector([float(c) for c in arg('--cam', '0.30,-0.80,0.62').split(',')])
    tgt = Vector([float(c) for c in arg('--tgt', '0.07,0.20,0.19').split(',')])
    cam.rotation_euler = (tgt - cam.location).to_track_quat('-Z', 'Y').to_euler()
    sc.collection.objects.link(cam)
    sc.camera = cam

    r = sc.render
    r.resolution_x, r.resolution_y, r.resolution_percentage = 1600, 900, int(arg('--pct', 100))
    r.filepath = arg('--out', os.path.join(HERE, 'overview.png'))
    r.image_settings.file_format = 'PNG'
    r.engine = 'BLENDER_EEVEE_NEXT'
    sc.eevee.taa_render_samples = int(arg('--samples', 16))
    sc.eevee.shadow_ray_count = int(arg('--rays', 1))
    sc.eevee.use_shadows = True
    sc.view_settings.view_transform = arg('--view', 'Standard')
    sc.view_settings.exposure = float(arg('--exposure', 0.12))
    t = time.time()
    bpy.ops.render.render(write_still=True)
    print('RENDER eevee %.1fs -> %s' % (time.time() - t, r.filepath))


# ================================================================ main
def main():
    os.makedirs(OUT, exist_ok=True)
    only = arg('--only')
    names = [n for n, _ in ASSETS if not only or n in only.split(',')]
    for name, fn in ASSETS:
        if name in names:
            purge()
            fn()
            export(name)
    print('BUILD+EXPORT %.1fs' % (time.time() - T0))
    rows, notes = verify(names)
    if not only:
        write_props(rows, notes)
    bad = [r['name'] for r in rows if not r['ok']]
    print('VERIFY done %.1fs; problems: %s' % (time.time() - T0, bad or 'none'))
    if not arg('--no-render'):
        render_overview()
    print('TOTAL %.1fs' % (time.time() - T0))


main()
