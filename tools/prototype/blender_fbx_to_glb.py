"""Headless Blender: import one FBX, report geometry/vertex-color/scale facts, export GLB.
Usage:
  blender --background --python blender_fbx_to_glb.py -- <in.fbx> <out.glb>
Tested with Blender 5.1 (FBX importer may be io_scene_fbx add-on or the new built-in wm.fbx_import).
"""
import sys, os, bpy

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
src, dst = argv[0], argv[1]

# start from an empty scene
bpy.ops.wm.read_factory_settings(use_empty=True)

# --- import (try legacy python add-on first, then the new native importer) ---
imported = None
for op_name, kwargs in (("import_scene.fbx", {}), ("wm.fbx_import", {})):
    mod, fn = op_name.split('.')
    op = getattr(getattr(bpy.ops, mod), fn, None)
    if op is None:
        continue
    try:
        res = op(filepath=src, **kwargs)
        imported = op_name
        print(f"[IMPORT] {op_name} -> {res}")
        break
    except Exception as e:
        print(f"[IMPORT] {op_name} failed: {e}")
if imported is None:
    raise SystemExit("no FBX importer available")

# --- report ---
print(f"[SCENE] unit_settings: system={bpy.context.scene.unit_settings.system} scale_length={bpy.context.scene.unit_settings.scale_length}")
total_v = total_f = 0
for ob in bpy.data.objects:
    if ob.type != 'MESH':
        print(f"[OBJ ] {ob.name:32s} type={ob.type} loc={tuple(round(v,4) for v in ob.location)} rot_euler_deg={tuple(round(v*57.29578,2) for v in ob.rotation_euler)} scale={tuple(round(v,4) for v in ob.scale)} parent={ob.parent.name if ob.parent else None}")
        continue
    me = ob.data
    total_v += len(me.vertices); total_f += len(me.polygons)
    cols = [f"{ca.name}({ca.domain},{ca.data_type})" for ca in me.color_attributes] if hasattr(me, 'color_attributes') else [vc.name for vc in me.vertex_colors]
    uvs = [uv.name for uv in me.uv_layers]
    dims = tuple(round(v, 4) for v in ob.dimensions)
    print(f"[MESH] {ob.name:32s} verts={len(me.vertices):6d} faces={len(me.polygons):6d} dims(world)={dims} loc={tuple(round(v,4) for v in ob.location)} scale={tuple(round(v,4) for v in ob.scale)} parent={ob.parent.name if ob.parent else None} colors={cols} uvs={uvs} mats={[m.name if m else None for m in me.materials]}")
    if me.color_attributes:
        ca = me.color_attributes[0]
        sample = [tuple(round(c,3) for c in ca.data[i].color) for i in range(min(3, len(ca.data)))]
        print(f"       first colors: {sample}")
print(f"[TOTAL] verts={total_v} faces={total_f}")

# --- bake scale into meshes (polyfish approach), then export ---
bpy.ops.object.select_all(action='SELECT')
try:
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    print("[OK] transform_apply(scale)")
except Exception as e:
    print(f"[WARN] transform_apply: {e}")

base = dict(filepath=dst, export_format='GLB', export_apply=True, export_animations=True, export_skins=True, export_yup=True)
attempts = [
    dict(export_vertex_color='ACTIVE', export_all_vertex_colors=True, export_active_vertex_color_when_no_material=True),
    dict(export_vertex_color='ACTIVE'),
    dict(export_colors=True),
    {},
]
for extra in attempts:
    try:
        bpy.ops.export_scene.gltf(**{**base, **extra})
        print(f"[EXPORT] ok with {extra or 'defaults'} -> {dst} ({os.path.getsize(dst)} bytes)")
        break
    except Exception as e:
        print(f"[EXPORT] attempt {extra} failed: {e}")
