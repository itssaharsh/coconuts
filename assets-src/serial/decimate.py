"""blender -b --python assets-src/serial/decimate.py -- in.gltf out.glb target_tris
Merges by distance, dissolves coplanar faces, triangulates, collapse-decimates to ~target_tris, keeps UVs/material, flat shading."""
import bpy, bmesh, sys
a = sys.argv[sys.argv.index('--') + 1:]; src, dst, target = a[0], a[1], int(a[2])
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
for o in meshes:  # bake node transforms into the mesh so the file is one flat list
    me = o.data; me.transform(o.matrix_world); o.parent = None; o.matrix_world.identity()
for o in bpy.context.scene.objects: o.select_set(o.type == 'MESH')
bpy.context.view_layer.objects.active = meshes[0]
bpy.ops.object.join(); ob = bpy.context.view_layer.objects.active
bm = bmesh.new(); bm.from_mesh(ob.data)
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
bmesh.ops.dissolve_limit(bm, angle_limit=0.05, verts=bm.verts, edges=bm.edges, use_dissolve_boundaries=False)
bmesh.ops.triangulate(bm, faces=bm.faces)
bm.to_mesh(ob.data); bm.free()
n = len(ob.data.polygons)
if n > target:
    m = ob.modifiers.new('d', 'DECIMATE'); m.ratio = target / n; m.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier='d')
for p in ob.data.polygons: p.use_smooth = False
print('DECIMATED', n, '->', len(ob.data.polygons))
bpy.ops.export_scene.gltf(filepath=dst, export_format='GLB', use_selection=True, export_apply=True, export_image_format='AUTO')
