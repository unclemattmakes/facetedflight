# tools/assets/convert-fbx.py — FBX to glTF, at the size Unity renders.
#
#   "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe" --background \
#       --python tools/assets/convert-fbx.py -- --out tools/prototype/out
#
# ── The bug this exists to not have ───────────────────────────────────────
#
# `hoverjet-cockpit.glb` shipped into this repo 100x too small, and the reason
# is a plausible-looking line in polyfish's converter:
#
#     bpy.ops.object.transform_apply(scale=True)   # "bake the unit scale"
#
# Blender's FBX importer assumes centimetres and puts a **0.01 scale on the
# imported object** to compensate. `transform_apply` then bakes that 0.01 INTO
# THE VERTICES — which does not remove the compensation, it makes it permanent.
# The mesh comes out a hundredth of its size.
#
# The HoverJet's FBX vertices are already in metres: raw local bounds are
# 6.82 x 2.12 x 6.17. So the correct move is to DISCARD the importer's 0.01,
# not to apply it. One line, opposite direction:
#
#     obj.scale = (1, 1, 1)
#
# The checkpoint ring survived the old converter only because its FBX happened
# to be authored in units where the round trip cancelled — which is why this
# looked like an asset problem rather than a tool problem for a whole session.
#
# The script therefore VERIFIES the exported size against what was asked for and
# fails loudly on a mismatch, rather than trusting that the maths went the right
# way this time.
#
# ── What it deliberately does NOT do ──────────────────────────────────────
#
# It does not bake the ship's -90 degree yaw. That rotation is authored on
# `Art/FirstPerson` in the SHIP PREFAB, not in the mesh — it is part of the rig,
# not of the asset — and `flight.ts` applies it as `SHIP_MODEL_YAW`. Baking it
# here would make the asset disagree with the prefab it came from. (DEV-009.)
#
# The legacy Unity project is READ-ONLY: this reads FBX from it and writes glTF
# only to `--out`.

import sys
from collections import Counter
from pathlib import Path

import math

import bmesh
import bpy
from mathutils import Matrix, Vector

# Blender runs this with its own interpreter and its own CWD, so `tools/` has to
# be put on the path by hand before `legacy_root` is importable.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from legacy_root import legacy_root  # noqa: E402

LEGACY = Path(legacy_root())
MESHES = LEGACY / "Assets/Faceted Flight/Meshes"

# FBX stem -> (shipped file name, expected longest dimension in metres).
#
# The size is a sanity check, and it is the FBX's own vertex bounds once the
# importer's centimetre compensation is discarded — never a number chosen to
# make the output look right.
#
#  * `hoverJet_w_cockpit` — cross-checked against the ship fitting through a
#    checkpoint ring and the prefab's own seat landing inside the canopy.
#
#  * `jumpGate_diamond` — 6.24 x 9.07 x 4.47 m of mesh, which the prefab then
#    scales by 3.885 to a 24 x 35 m gate. Cross-checked three ways against
#    `Prefabs/Checkpoint_Ring.prefab`: its 18 studs sit at x +-9.6 and
#    y -14.6..+15.5, inside the scaled frame's x +-12.1 and y +-17.6; and its
#    trigger sphere is `m_Radius 0.92` under a transform scaled 12.29, which is
#    11.31 m — exactly half the 22.6 m the level JSON carries at ring scale 2.
# ── The mirror nobody could see ───────────────────────────────────────────
#
# Unity's FBX importer converts a right-handed file into its own LEFT-handed
# space, and FF2's world is Unity's mirrored in z (`render/unity-space.ts`).
# Those two conversions do NOT cancel: measured against ground truth, a mesh
# that comes through this converter arrives MIRRORED IN X relative to the mesh
# Unity draws.
#
# It went unnoticed for three assets because every one of them is left-right
# symmetric — a cockpit, a hexagonal gate — and a mirror of a symmetric shape is
# the shape. CLAUDE.md predicted exactly this: "A fully mirrored world also
# renders 224/224 front-facing. The handedness test proves the PAIRING, not the
# absence of a mirror — check an asymmetric asset."
#
# `turnIndicator` is that asymmetric asset, and it is asymmetric in the one way
# that can measure this: it is a chevron, and its prefab carries four
# `glowyMaterial` bars whose transforms are UNITY-NATIVE — built-in cubes, pure
# Unity numbers, through no importer at all. They are ground truth.
#
# Composed against them, the two short end-cap bars land:
#
#     as exported     4.79 m and 4.43 m from the arrow's arm ends
#     mirrored in x   0.62 m and 0.59 m
#
# on a mesh 4.43 m wide. That is not a judgement call.
#
# So the mirror is undone HERE rather than in the renderer, for the same reason
# the vertex alpha is: the file on the bucket should be correct on its own terms.
# Mirroring reverses triangle winding, so the winding has to be put back or every
# face renders inside-out — and whether Blender's apply has already done that is
# MEASURED in `unmirror_x`, not assumed (it has, in 5.1; DEV-327). Three things
# ride along with the mirror and are handled beside it: the polygons are cut
# into triangles first (`triangulate_as_authored`), the apply touches only the
# one object, and the file's own normals are put back afterwards
# (`restore_file_normals`). DEV-328. `tests/unit/converted-winding.test.ts`
# holds every output of this file to positive signed volume.
#
#  * `turnIndicator` — 4.43 x 5.48 x 1.01 m, the chevron the prefab then scales
#    non-uniformly by (5.13, 4.87, 3.08) to a 22.7 x 26.7 m arrow. Note the mesh
#    inside is named `jumpGate_00_noPosRot:polySurface17` — it was modelled in
#    the gate's Maya file, one surface along from `polySurface16`, which is the
#    gate itself. Select by FILE, never by mesh name.
# name: (ship_as, expected longest dimension in metres, extra unit scale)
#
# The unit scale is 1 for everything whose FBX agrees with Unity about its own
# units — which is everything here except the logo. See `logo_polys` below.
JOBS = {
    "hoverJet_w_cockpit": ("hoverjet-cockpit", 6.82, 1.0),
    "jumpGate_diamond": ("checkpoint-ring", 9.0741, 1.0),
    "turnIndicator": ("turn-indicator", 5.4794, 1.0),
    # The title screen's logo. 2016's own, first-party. DEV-042.
    "logo_polys": ("title-logo", 17.97, 1.0),
    # The THIRD-PERSON ship - what the AI racers, the ghosts and the jet parked
    # on the holotable actually wear. `Art/ThirdPerson` in the shipped prefab,
    # and `playbackGhost/ThirdPerson (1)` for a ghost, which is exactly what
    # Matt remembered: *"that's the model i thought the ai/ghost ships + the
    # hoverjet as seen in the menus."*
    #
    # It needs no orientation constant of its own, and that is measured rather
    # than assumed. Imported beside `hoverJet_w_cockpit` and compared:
    #
    #     bounds x     -3.6535 .. 3.1623   IDENTICAL on both
    #     bounds y     -3.0827 .. 3.0827   IDENTICAL on both
    #     longest      6.8158 m            IDENTICAL on both
    #     width profile along x, 12 slabs:
    #       cockpit    0.40 0.87 3.03 4.49 1.81 6.17 5.37 5.78 2.51 2.40 0.91 0.66
    #       exterior   0.40 0.70 3.03 4.49 1.74 6.17 2.24 5.78 2.51 2.12 0.91 0.69
    #
    # Same frame, same silhouette, the interior removed - 246 verts against 619.
    # The prefab agrees: `ThirdPerson` carries the same -89.988 degree yaw and
    # the same (0.98, 0.98, 0.938) scale as `FirstPerson`, so `SHIP_MODEL_YAW`,
    # `ART_POSITION` and `ART_SCALE` all carry across untouched.
    "hoverJet_exterior_orange": ("hoverjet-exterior", 6.8158, 1.0),
}

# ── MESH jobs: the prefab points at the MESH, not at the model ─────────────
#
# A prefab can reference an FBX two ways. As a MODEL (an instance of the file's
# node tree, whose node transforms become GameObject transforms), or as a bare
# MESH (`MeshFilter.m_Mesh {fileID: 43xxxxx, guid: <the fbx>}` on a GameObject
# of its own). In the second case the FBX node's own Lcl transform NEVER reaches
# the screen: Unity's mesh asset holds the vertices in node-local space, and the
# prefab's GameObject supplies the transform.
#
# `sphere_fancy_lod_01` is that case, and the difference is 15x. Its only node,
# `pSolid2` (a Maya platonic-solid soccer ball, `lambert1`), carries
# `Lcl Scaling 15.2987`, which Blender puts on the object as 0.152987 (that
# times the importer's 0.01) — so the ordinary job, which only discards an
# EXACT 0.01, would bake it and export a 0.3 m ball. `EnergyOrb.prefab`'s
# MeshFilter names mesh 4300000 (`pSolid2` in the .meta) and scales the node
# 1.6284 itself. So the whole object scale goes, not just the unit
# compensation, and the vertices come out as the file wrote them.
#
# Those are METRES because the .meta is serializedVersion 16 with
# `globalScale: 1` and no `useFileScale` — the same era and settings as
# `hoverJet_w_cockpit`, whose file numbers ARE the 6.82 m ship. Every vertex of
# the file sits at radius 1.0000 (a 60-vertex truncated icosahedron, 12
# pentagons and 20 hexagons, flat normals), so the expected size is 2.0.
#
# The mirror (`unmirror_x`) is applied as for every JOB, and on this mesh it is
# a ROTATION: the vertex set is centrally symmetric, so negating x equals a
# half-turn about x followed by the inversion that maps the ball onto itself.
# `tests/unit/orb-art.test.ts` holds the symmetry and the outward winding on
# the exported GLB. DEV-327.
#
# stem: (ship_as, expected longest dimension in metres)
MESH_JOBS = {
    "sphere_fancy_lod_01": ("energy-orb", 2.0),
}

# ── ASSEMBLIES: an FBX that is several meshes under a group, in THREE space ──
#
# The JumpSeat's art is not one mesh. `jumpseat_rough_01.fbx` is a Maya group
# `jumpSeat` holding five mesh nodes (`seat`, `console_thing`, `botton`,
# `boxes`, `shell`), each at the group origin with the mesh's pivot stored as
# Maya `RotationPivot`/`ScalingPivot` properties; Unity turns those pivots into
# child GameObject positions and Blender ignores them and leaves the vertices
# where they are. The composed geometry is identical either way — the prefab's
# `seat` at (0.0025, 2.717, -0.9282) is the centroid of the vertices Blender
# imports — so every assembly is FLATTENED here (parent cleared, transform kept)
# and the submeshes stay separate nodes, because the port paints them by name.
#
# `keep` names the nodes the shipped prefab has LIVE. `jumpseat_rough_01`'s own
# `shell` submesh is dead art: the prefab's `shell` GameObject under that group
# was re-pointed at `jumpseat_rough_02.fbx` and then switched off
# (`m_IsActive: 0`), and the shell that ships is `jumpseat_shell_04.fbx`. A
# name that is not in the file FAILS the job, the way `keep_only` does.
#
# ── The half-turn, and why it is not `unmirror_x` ─────────────────────────
#
# Read the FBX pivots straight out of the file (`tools/extract/fbx-bounds.mjs`
# parses it): `seat` RotationPivot x = **-0.0025**, `console_thing` **+0.0272**.
# The shipped prefab's Unity import of the SAME file puts those two nodes at
# x = **+0.0025** and **-0.0272**. So it is Unity's importer that negates x on
# the way in, and Blender that reads the file as written. `unmirror_x` above
# therefore produces the mesh UNITY draws (x negated, winding restored) — and
# FF2's world is Unity's mirrored in z (`render/unity-space.ts`), so the frame
# every renderer placement in this port expects is Unity's with z negated too:
#
#     three = neg_z(unity) = neg_z(neg_x(fbx)) = R_y(180) · fbx
#
# Two negations are a ROTATION, determinant +1, winding untouched, no
# `flip_normals`. That is `unity_to_three` below, and for every asset in JOBS it
# is byte-for-byte the same geometry as `unmirror_x` — the cockpit is symmetric
# in its fore-aft mesh axis to five decimals, a hexagon and a chevron across
# their thickness — which is exactly why the difference went unmeasured through
# five assets. The JumpSeat is the first mesh the two rules disagree on: its seat
# sits 0.93 m BEHIND the art origin, and `unmirror_x` would have exported it
# 0.93 m in front, putting the seat 1.8 m ahead of the pilot's head. The
# guard is `tests/unit/jumpseat-art.test.ts`, which measures the seat against
# `collider_head` — a Unity-native box in the same prefab. DEV-114.
#
# stem: (ship_as, expected longest dimension in metres, unit scale, keep)
ASSEMBLY_JOBS = {
    # Seat, console, bottom plate and the two side boxes. 3.4741 m is `botton`'s
    # fore-aft extent, the longest of the four; the file's unit is centimetres
    # and the .meta's `globalScale: 100` cancels it, so the raw numbers ARE
    # metres — and the prefab agrees, node for node.
    "jumpseat_rough_01": ("jumpseat-body", 3.4741, 1.0, ("seat", "console_thing", "botton", "boxes")),
    # The orange shell. 5.8476 m fore-aft, on the same 100 x 0.01 unit rule.
    "jumpseat_shell_04": ("jumpseat-shell", 5.8476, 1.0, ("shell",)),
    # One pentagonal prism, 19.02 x 5.00 x 18.09 in the file, `globalScale: 10`
    # so Unity draws it at 0.1 -- 1.9021 m across. The prefab scales it per leg
    # (0.107 x 3.572 x 0.088 and 0.048 x 5.482 x 0.042 on `front_l`) into the
    # eight thin struts the legs are made of. `fbx-bounds.mjs` carries the
    # same 0.01 x 10 arithmetic for the finish gate, which is this mesh at 30 m.
    "hexTile": ("jumpseat-strut", 1.9021, 0.1, ("pCylinder1",)),
}

TOLERANCE = 0.02  # 2%


def argv_after_dashes():
    return sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []


def clear():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.collections):
        for item in list(block):
            block.remove(item)


def force_opaque_vertex_colors(mesh):
    """Unity `Color32` alpha decodes to 1/255, which renders a vertex-coloured
    mesh essentially invisible in any glTF consumer honouring `COLOR_0.a`.

    The runtime loader fixes this too, but fixing it at export means the file on
    the bucket is correct on its own terms rather than relying on a consumer.
    """
    for attr in mesh.color_attributes:
        if attr.data_type not in {"BYTE_COLOR", "FLOAT_COLOR"}:
            continue
        for datum in attr.data:
            colour = datum.color
            datum.color = (colour[0], colour[1], colour[2], 1.0)


def unmirror_x(obj):
    """Negate x, undoing the importer/handedness mirror, and leave every face
    wound the way it was — OUTWARD, if the file's was.

    A mirror reverses triangle winding, so a negated mesh needs its winding put
    back or it renders inside-out. This used to do that unconditionally with
    `mesh.flip_normals()` — and **Blender 5.1's `transform_apply` already does
    it**: applying a negative scale reverses the winding itself. Probed on
    `sphere_fancy_lod_01` (DEV-327): 32 of 32 faces outward as imported, 32 of
    32 after the negative-scale apply, **0 of 32** after the extra flip. So
    every mesh this function exported was inside-out — the gate, the turn
    indicator, the logo, both hulls: negative signed volume, normals agreeing
    with the inverted winding — and nobody saw, because every one of those
    GLBs carries `doubleSided: true` and three flips a back face's normal.

    So it MEASURES instead of assuming: each face's normal before, mirrored,
    against the same face's normal after. The face is flipped only if the apply
    did not already reverse it, and anything that disagrees afterwards fails.
    `transform_apply` bakes the -1 into the vertices so the exported file
    carries no negative scale of its own.

    **`transform_apply` acts on the SELECTION, not on `obj`** — and the FBX
    importer leaves every object it made selected. On `logo_polys` that is two
    parent empties and three meshes, and with the parents in the apply Blender
    re-derives each child's transform from a negative-determinant matrix: the
    data came out negated in x, y AND z, with a half-turn about x parked on the
    node to put the world back. The world geometry was right; the MESH-LOCAL
    comparison below was not measuring a mirror any more, and with a `> 0`
    threshold it passed 70 of `logo_bottom`'s 72 faces by coincidence — every
    face whose normal was not mostly along x. So only `obj` is selected, and
    the threshold is the one a real x-mirror meets: the two normals are equal
    or opposite, to rounding. Anything in between is not the operation this
    function thinks it did. DEV-328.
    """
    me = obj.data
    before = [p.normal.copy() for p in me.polygons]
    obj.scale.x = -obj.scale.x
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.select_set(False)

    def sides():
        me.update()
        # Mesh-local x was negated, so a face that kept its side now has
        # normal (-nx, ny, nz), and one that turned over has its opposite.
        kept = turned = 0
        for n0, p in zip(before, me.polygons):
            d = -n0.x * p.normal.x + n0.y * p.normal.y + n0.z * p.normal.z
            kept += d > 0.999
            turned += d < -0.999
        return kept, turned

    kept, turned = sides()
    if turned > kept:
        me.flip_normals()
        kept, turned = sides()
    print(f"[WIND] {obj.name}: {kept}/{len(before)} faces keep their side through the mirror")
    return kept == len(before)


def triangulate_as_authored(obj):
    """Split every polygon into triangles NOW, in the file's own loop order,
    before `unmirror_x` reverses that order.

    The glTF exporter triangulates whatever polygons it is handed, and for an
    n-gon Blender's triangulation is an ear clip that walks the loop — so the
    triangles depend on which WAY round the loop runs, not only on where the
    corners are. A mirror has to reverse every loop (that is what keeps a face
    outward), so exporting the mirrored n-gon cuts it along different diagonals
    from the file. On a flat polygon that is invisible. On a bent one it moves
    the surface: `hoverJet_w_cockpit` has two 9-gons 9.2 cm out of plane over
    1.93 m, and they folded the other way. The old double reversal (apply, then
    `flip_normals`) hid this by putting the loops back in the file's order, and
    with them the faces back inside-out. DEV-328.

    Quads are split 0-2 and n-gons ear-clipped from the first loop, which is
    what Blender's own tessellation does to an unmirrored polygon — and rather
    than trust that, the result is compared triangle by triangle with that
    tessellation and a mismatch fails the job.

    Returns, per triangle, the index of the file's polygon it came from (from
    `face_map`), which `restore_file_normals` needs; None on failure.
    """
    me = obj.data
    if all(len(p.vertices) == 3 for p in me.polygons):
        return list(range(len(me.polygons)))
    me.calc_loop_triangles()
    want = Counter(frozenset(lt.vertices) for lt in me.loop_triangles)

    bm = bmesh.new()
    bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    source = {f: f.index for f in bm.faces}
    result = bmesh.ops.triangulate(bm, faces=bm.faces[:], quad_method="FIXED", ngon_method="EAR_CLIP")
    face_map = result["face_map"]
    origin = [source[face_map.get(f, f)] for f in bm.faces]
    bm.to_mesh(me)
    bm.free()
    me.update()

    got = Counter(frozenset(p.vertices) for p in me.polygons)
    if got != want:
        print(f"[FAIL] {obj.name}: triangulation differs from Blender's tessellation in {sum((got - want).values())} triangles")
        return None
    print(f"[TRI]  {obj.name}: {len(me.polygons)} triangles, as the file's loop order cuts them")
    return origin


def file_normals(me):
    """(polygon index, vertex index) -> the file's normal at that corner."""
    return {
        (p.index, me.loops[li].vertex_index): me.corner_normals[li].vector.copy()
        for p in me.polygons
        for li in p.loop_indices
    }


def restore_file_normals(obj, normals, origin):
    """Put the file's own corner normals back, mirrored, after `unmirror_x`.

    The FBX carries explicit normals (Blender's `custom_normal`, int16 pairs
    ENCODED against each corner's fan of neighbouring faces), and every file
    here was imported by Unity with `normalImportMode: 0` — Import — so those
    are the normals 2016 drew. `transform_apply` with a negative scale does not
    carry them through: it re-encodes them against fans whose winding it has
    just reversed, and they come out bent. Measured through the mirror alone,
    worst corner against the file's own normal mirrored: 0.77 deg on the gate,
    0.74 on the cockpit, 11 on `logo_top`, 133 on 26 corners of
    `hoverJet_exterior_orange` — and more once `triangulate_as_authored` has
    added fans of its own. Every GLB this made before DEV-328 carried that.

    So they are set again from the numbers read before anything moved: x
    negated, which is what a mirror does to a normal that keeps its side. Then
    read back, and a corner more than a tenth of a degree out fails the job
    (the int16 encoding is good to about 0.04).
    """
    me = obj.data
    target = [None] * len(me.loops)
    for p in me.polygons:
        for li in p.loop_indices:
            n = normals[(origin[p.index], me.loops[li].vertex_index)]
            target[li] = (-n.x, n.y, n.z)
    me.normals_split_custom_set(target)
    me.update()
    worst = max(
        math.degrees(math.acos(max(-1.0, min(1.0, me.corner_normals[li].vector.dot(Vector(t))))))
        for li, t in enumerate(target)
    )
    print(f"[NORM] {obj.name}: {len(target)} corners, worst {worst:.3f} deg from the file's normal mirrored")
    return worst <= 0.1


def unity_to_three(obj):
    """Half-turn the MESH DATA about the vertical, so the file is in three space.

    See the ASSEMBLY_JOBS header. Applied to the mesh rather than the object:
    the FBX importer parks a +90 degree x rotation on the object to make the
    file's y-up into Blender's z-up, and the glTF exporter cancels exactly that
    on the way out, so the exported vertex frame IS the mesh-local frame, and
    the mesh-local y axis IS the file's vertical. A rotation of pi about it
    negates x and z, determinant +1 -- no winding flip, no `flip_normals`.
    """
    obj.data.transform(Matrix.Rotation(math.pi, 4, "Y"))


def convert_assembly(name, ship_as, expected_size, unit_scale, keep, out_dir):
    """Convert a multi-node FBX into one GLB of named submeshes, in THREE space."""
    fbx = MESHES / f"{name}.fbx"
    if not fbx.exists():
        print(f"[MISS] {fbx}")
        return False

    clear()
    bpy.ops.import_scene.fbx(filepath=str(fbx))

    names = {o.name for o in bpy.data.objects if o.type == "MESH"}
    missing = [k for k in keep if k not in names]
    if missing:
        print(f"[FAIL] {name}: nodes {missing} are not in the file. Have: {sorted(names)}")
        return False
    for obj in list(bpy.data.objects):
        if obj.type == "MESH" and obj.name not in keep:
            print(f"[DROP] {name}: {obj.name} (not live in the shipped prefab)")
            bpy.data.objects.remove(obj, do_unlink=True)

    # The centimetre compensation, discarded rather than baked -- on the group
    # empty as well as on a lone mesh, because these files carry it on the group.
    for obj in bpy.data.objects:
        if tuple(round(v, 6) for v in obj.scale) == (0.01, 0.01, 0.01):
            obj.scale = (1.0, 1.0, 1.0)
    if unit_scale != 1.0:
        for obj in bpy.data.objects:
            if obj.parent is None:
                obj.scale = tuple(v * unit_scale for v in obj.scale)
    bpy.context.view_layer.update()

    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    if not meshes:
        print(f"[FAIL] {name}: no mesh left after keep={keep}")
        return False

    # Flatten: the group's rotation and scale land on each mesh, the group goes.
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
    # Scale into the vertices (the unit scale, if any); rotation stays on the
    # object for the exporter to cancel, exactly as on a single-mesh job.
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in list(bpy.data.objects):
        if obj.type == "EMPTY":
            bpy.data.objects.remove(obj, do_unlink=True)
    bpy.context.view_layer.update()

    for obj in meshes:
        force_opaque_vertex_colors(obj.data)
        unity_to_three(obj)
    bpy.context.view_layer.update()

    biggest = max(max(o.dimensions) for o in meshes)
    print(f"[SIZE] {name}: longest dimension {biggest:.4f} m (expected {expected_size})")
    if abs(biggest - expected_size) / expected_size > TOLERANCE:
        print(
            f"[FAIL] {name}: {biggest:.4f} m is more than {TOLERANCE:.0%} from "
            f"{expected_size} m. The unit scale went the wrong way again."
        )
        return False
    for obj in meshes:
        b = [obj.matrix_world @ v.co for v in obj.data.vertices]
        lo = [min(p[i] for p in b) for i in range(3)]
        hi = [max(p[i] for p in b) for i in range(3)]
        print(
            f"[NODE] {name}/{obj.name}: {len(obj.data.vertices)} verts, blender-world bounds "
            f"x[{lo[0]:.4f},{hi[0]:.4f}] y[{lo[1]:.4f},{hi[1]:.4f}] z[{lo[2]:.4f},{hi[2]:.4f}]"
        )

    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{ship_as}.glb"
    bpy.ops.export_scene.gltf(
        filepath=str(out),
        export_format="GLB",
        export_apply=True,
        export_animations=False,
        export_skins=False,
        export_vertex_color="ACTIVE",
    )
    print(f"[OK]   {name} -> {out} ({out.stat().st_size:,} bytes)")
    return True


def convert(name, ship_as, expected_size, unit_scale, out_dir, mesh_only=False):
    fbx = MESHES / f"{name}.fbx"
    if not fbx.exists():
        print(f"[MISS] {fbx}")
        return False

    clear()
    bpy.ops.import_scene.fbx(filepath=str(fbx))

    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    if not meshes:
        print(f"[FAIL] {name}: no mesh in the FBX")
        return False

    if mesh_only:
        # See MESH_JOBS. The prefab references the mesh, so the node's whole
        # transform is dropped — refused, rather than guessed at, if the node
        # has anything but a scale on it (the importer's own axis rotation is
        # expected and the exporter cancels it).
        if len(bpy.data.objects) != 1:
            print(f"[FAIL] {name}: a MESH job wants one node, found {len(bpy.data.objects)}")
            return False
        obj = meshes[0]
        if any(abs(v) > 1e-6 for v in obj.location):
            print(f"[FAIL] {name}: the node is translated {tuple(obj.location)}; not a bare mesh")
            return False
        print(f"[NODE] {name}: dropping the node's own scale {tuple(round(v, 6) for v in obj.scale)}")
        obj.scale = (1.0, 1.0, 1.0)

    for obj in bpy.data.objects:
        # THE FIX. Discard the importer's centimetre compensation instead of
        # baking it. See the header.
        if tuple(round(v, 6) for v in obj.scale) == (0.01, 0.01, 0.01):
            obj.scale = (1.0, 1.0, 1.0)
        if unit_scale != 1.0:
            obj.scale = tuple(v * unit_scale for v in obj.scale)

    # `dimensions` is derived from the evaluated depsgraph, so it still reports
    # the old size until the view layer catches up. Without this the size check
    # below reads 0.0682 and fails on a conversion that actually worked — which
    # it did, the first time this ran.
    bpy.context.view_layer.update()

    for obj in meshes:
        force_opaque_vertex_colors(obj.data)
        normals = file_normals(obj.data)
        origin = triangulate_as_authored(obj)
        if origin is None:
            return False
        if not unmirror_x(obj):
            print(f"[FAIL] {name}/{obj.name}: faces changed side through the mirror")
            return False
        if not restore_file_normals(obj, normals, origin):
            print(f"[FAIL] {name}/{obj.name}: the file's normals did not survive the mirror")
            return False

    bpy.context.view_layer.update()

    biggest = max(max(o.dimensions) for o in meshes)
    print(f"[SIZE] {name}: longest dimension {biggest:.4f} m (expected {expected_size})")
    if abs(biggest - expected_size) / expected_size > TOLERANCE:
        print(
            f"[FAIL] {name}: {biggest:.4f} m is more than {TOLERANCE:.0%} from "
            f"{expected_size} m. The unit scale went the wrong way again."
        )
        return False

    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{ship_as}.glb"
    bpy.ops.export_scene.gltf(
        filepath=str(out),
        export_format="GLB",
        export_apply=True,
        export_animations=False,
        export_skins=False,
        # Blender 4.5+ takes a string enum here.
        export_vertex_color="ACTIVE",
    )
    print(f"[OK]   {name} -> {out} ({out.stat().st_size:,} bytes)")
    return True



def orient_prop(obj):
    """Axis conversion for the PROP fbx. A rotation, NOT a mirror.

    Calibrated, not reasoned. `GL-Palmtree-01` exists on both conversion paths
    -- as `Materialized Mesh/MM_GL-Palmtree-01/MM_GL-Palmtree-01.asset` and as
    `Geometric-Landscape-Tropic-Island/FBX/GL-Palmtree-01.fbx` -- so the Unity
    decode, which is the trusted one, is an independent target to hit. Four
    candidate transforms were swept against it:

        rotX+90, rotY180           centre (-0.03, -2.31, -0.72)   no
        rotX+90, mirror x          centre (-0.03,  2.31, -0.72)   no
        rotX-90, rotY180           centre (-0.03,  2.31,  0.72)   MATCH
        rotX+90, plain             centre ( 0.03,  2.31, -0.72)   no

    against the target's (-0.03, 2.31, 0.72). All four agree on the extent, so
    SIZE ALONE WOULD HAVE PASSED ANY OF THEM -- the sign of the centre is what
    separates them, which is why this is measured against a twin rather than
    checked for plausibility.

    The winner is `rotX-90` then `rotY180`: two rotations, determinant +1, so
    the source winding carries through untouched and there is no `flip_normals`
    here. **These props were never mirrored.**

    That is why this is a separate function from `unmirror_x`. `unmirror_x` is
    right for the SHIP meshes under `Assets/Faceted Flight/Meshes/` -- it was
    added because those really did arrive mirrored, and `turn-indicator.test.ts`
    guards it. Applying it here would have introduced the very bug it exists to
    fix. Different exporters, different conventions, two calibrations; neither
    generalises to the other, and the only way to know which you have is to
    measure against something whose orientation you already trust.
    """
    obj.rotation_euler = (-math.pi / 2, math.pi, 0.0)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    obj.select_set(False)


def keep_only(node):
    """Delete every object except `node`, for an FBX that is a CONTAINER.

    `trees_03.fbx` holds twenty trees at three LODs -- sixty meshes laid out
    across the region the artist arranged them in -- and a Unity prefab
    references exactly one of them by fileID. Exporting the whole file gave ten
    different tree prefabs one 549 KB GLB, and `load-props.ts` instances every
    mesh it finds, so each scatter point drew all sixty (DEV-099).

    Matched on the object NAME, which is Unity's own: the importer records
    fileID -> name in `<file>.fbx.meta` as `fileIDToRecycleName`, and
    `tools/extract/props.mjs` carries that name into the palette as `meshNode`.
    So the name is not a guess about Blender's import -- it is the same string
    Unity uses to identify the sub-mesh.

    Returns False if the name is not in the file, which must FAIL rather than
    silently export everything: that is the difference between this fix and the
    bug it replaces.
    """
    names = {o.name for o in bpy.data.objects}
    if node not in names:
        print(f"[FAIL] node '{node}' is not in the file. Have: {sorted(names)[:12]}")
        return False
    for obj in list(bpy.data.objects):
        if obj.name != node:
            bpy.data.objects.remove(obj, do_unlink=True)
    return True


def srgb_to_linear(c):
    """The sRGB transfer function's inverse, per channel. IEC 61966-2-1."""
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def bake_atlas_colours(meshes, atlas_path, tint):
    """One colour per FACE, read out of a texture atlas, into `COLOR_0`. DEV-447.

    For a pack whose look is a gradient ATLAS rather than vertex colour — the
    Geometric-Landscape art wears `GL-Tex-01.jpg`, twelve swatches — and a port
    whose register is *"one colour per face, and never a texture"*
    (ART_DIRECTION pillar 2). Each polygon takes the texel under the centroid of
    its UVs; nearest texel, because a swatch is a gradient and the centroid is
    already an average.

    **The colour is LINEAR, and that is 2016's own colour space, not a choice.**
    `ProjectSettings.asset` carries `m_ActiveColorSpace: 1`: 2016 rendered in
    Linear, so this material's albedo was `decode(texel) * decode(_Color)` —
    Unity decodes an sRGB texture on sampling and converts a material colour
    to linear before the shader sees it. `tint` arrives as the `.mat`'s own
    gamma-space numbers and is decoded here. (Vertex colours are the one input
    Unity did NOT decode, which is DEV-014; nothing here is a vertex colour
    until this function writes one, and it writes the value the shader saw.)

    `image.pixels` is the file's stored values over 255 — checked against PIL
    on three texels of `GL-Tex-01.jpg` to four places — so the decode is done
    here rather than by Blender's colour management. The UV maps and materials
    are removed afterwards, so the GLB carries no texture and no coordinates
    for one: nothing downstream can sample the atlas by accident.
    """
    img = bpy.data.images.load(str(atlas_path))
    width, height = img.size
    pixels = img.pixels[:]
    lin_tint = [srgb_to_linear(c) for c in tint]

    def texel(u, v):
        x = min(width - 1, max(0, int(math.floor((u % 1.0) * width))))
        y = min(height - 1, max(0, int(math.floor((v % 1.0) * height))))
        i = (y * width + x) * 4
        return [srgb_to_linear(pixels[i + k]) * lin_tint[k] for k in range(3)]

    for obj in meshes:
        me = obj.data
        if not me.uv_layers:
            print(f"[FAIL] {obj.name}: no UV map to read the atlas through")
            return False
        uv = me.uv_layers.active.data
        attr = me.color_attributes.new(name="AtlasFace", type="FLOAT_COLOR", domain="CORNER")
        for poly in me.polygons:
            loops = list(poly.loop_indices)
            cu = sum(uv[i].uv.x for i in loops) / len(loops)
            cv = sum(uv[i].uv.y for i in loops) / len(loops)
            r, g, b = texel(cu, cv)
            for i in loops:
                attr.data[i].color = (r, g, b, 1.0)
        me.color_attributes.active_color = attr
        while me.uv_layers:
            me.uv_layers.remove(me.uv_layers[0])
        me.materials.clear()
    return True


def convert_file(src, out, unit_scale=1.0, node=None, atlas=None, tint=(1.0, 1.0, 1.0)):
    """Convert one arbitrary FBX, same hardened path as `convert()`.

    Exists so `tools/assets/extract-props.mjs` can reuse THIS pipeline instead
    of `tools/prototype/blender_fbx_to_glb.py`, which is the raw prototype and
    does none of it. That distinction is not cosmetic: cross-checking
    `GL-Palmtree-01` through both converters showed the prototype negating x and
    swapping y/z against the Unity `.asset` decode of the same geometry. A
    mirror reverses winding, so those meshes were also inside-out — trap 22, the
    bug that shipped three assets mirrored for a session.

    No `expected_size` gate here: the props have no independently known
    dimension to check against. The caller is expected to verify differently —
    for props, against the Unity mesh's own recorded `localAABB`.
    """
    src = Path(src)
    if not src.exists():
        print(f"[MISS] {src}")
        return False

    clear()

    # TWO IMPORTERS, because the packs disagree about FBX version. `trees_03`
    # and the Quantum Theory spires are binary 7400 and the classic
    # `import_scene.fbx` add-on reads them. The Geometric-Landscape palms and
    # the AxeyWorks bushes are binary 6100 / ASCII, which that importer refuses
    # outright -- "Version 6100 unsupported, must be 7100 or later" -- and only
    # Blender 5's built-in `wm.fbx_import` will open. Eight of thirteen props
    # are in the second group, so this is not an edge case.
    imported = False
    errors = []
    for op_name in ("import_scene.fbx", "wm.fbx_import"):
        mod, _, op = op_name.partition(".")
        fn = getattr(getattr(bpy.ops, mod), op, None)
        if fn is None:
            continue
        try:
            fn(filepath=str(src))
            if [o for o in bpy.data.objects if o.type == "MESH"]:
                imported = True
                break
        except Exception as exc:  # noqa: BLE001 - report and try the next one
            errors.append(f"{op_name}: {exc}")
        clear()

    if not imported:
        print(f"[FAIL] {src.name}: no importer could read it -- {' | '.join(errors)}")
        return False

    # Before anything is measured or transformed: a container FBX is cut down
    # to the one sub-mesh the prefab asked for.
    if node and not keep_only(node):
        return False

    meshes = [o for o in bpy.data.objects if o.type == "MESH"]

    for obj in bpy.data.objects:
        if tuple(round(v, 6) for v in obj.scale) == (0.01, 0.01, 0.01):
            obj.scale = (1.0, 1.0, 1.0)

    # ── the unit scale goes on the ROOTS, exactly once ────────────────────
    #
    # Not on every object. The two importers disagree about where the
    # centimetre compensation lives, and it matters:
    #
    #   import_scene.fbx (binary 7400)  Spire_B   MESH  scale 0.01, no parent
    #   wm.fbx_import    (6100/ASCII)   Mesh1     MESH  scale 1.0
    #                                   Model     EMPTY scale 0.01, its PARENT
    #
    # Scaling "every object" multiplies the AxeyWorks meshes by 0.01 twice, once
    # through the empty and once through the mesh, and a 2.99 m bush comes out
    # at 0.03 m. Measured, not reasoned: the first cut of this fix did exactly
    # that. Roots only, and the parent chain carries it down once.
    if unit_scale != 1.0:
        for obj in bpy.data.objects:
            if obj.parent is None:
                obj.scale = tuple(v * unit_scale for v in obj.scale)

    bpy.context.view_layer.update()

    # Flatten, so the scale lands in the VERTICES rather than on a parent node.
    # `load-props.ts` instances `source.matrix` — the mesh's own local transform
    # — so anything left on an ancestor is silently dropped at load time. Every
    # prop that already worked is a single mesh at the root, which is why this
    # was never felt; the AxeyWorks pack is the one that arrives parented.
    if meshes:
        bpy.ops.object.select_all(action="DESELECT")
        for obj in meshes:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = meshes[0]
        bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
        bpy.ops.object.select_all(action="DESELECT")

    bpy.context.view_layer.update()

    # DEV-447: an atlas pack's colour, baked per face BEFORE the orientation,
    # which moves vertices and leaves face corners and their colours alone.
    if atlas and not bake_atlas_colours(meshes, atlas, tint):
        return False

    for obj in meshes:
        force_opaque_vertex_colors(obj.data)
        orient_prop(obj)

    bpy.context.view_layer.update()

    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(out),
        export_format="GLB",
        export_apply=True,
        export_animations=False,
        export_skins=False,
        export_vertex_color="ACTIVE",
    )
    print(f"[OK]   {src.name} -> {out} ({out.stat().st_size:,} bytes)")
    return True


def main():
    args = argv_after_dashes()

    # Generic single-file mode: --src <in.fbx> --dest <out.glb>
    if "--src" in args and "--dest" in args:
        src = args[args.index("--src") + 1]
        dest = args[args.index("--dest") + 1]
        scale = 1.0
        if "--unit-scale" in args:
            scale = float(args[args.index("--unit-scale") + 1])
        node = args[args.index("--node") + 1] if "--node" in args else None
        # DEV-447: `--atlas <image> [--tint r,g,b]` bakes a face colour per
        # polygon out of the pack's texture atlas. See `bake_atlas_colours`.
        atlas = args[args.index("--atlas") + 1] if "--atlas" in args else None
        tint = (1.0, 1.0, 1.0)
        if "--tint" in args:
            tint = tuple(float(v) for v in args[args.index("--tint") + 1].split(","))
        sys.exit(0 if convert_file(src, dest, scale, node, atlas, tint) else 1)

    out_dir = Path("tools/prototype/out")
    if "--out" in args:
        out_dir = Path(args[args.index("--out") + 1])

    # `--only a,b` runs a subset of the two tables. A re-export is a hash change
    # in `required-assets.json`, so converting everything to get one asset is
    # five spare chances to disturb a file whose bytes are already pinned.
    only = None
    if "--only" in args:
        only = set(args[args.index("--only") + 1].split(","))
        unknown = only - set(JOBS) - set(ASSEMBLY_JOBS) - set(MESH_JOBS)
        if unknown:
            print(f"[FAIL] --only names nothing in JOBS, ASSEMBLY_JOBS or MESH_JOBS: {sorted(unknown)}")
            sys.exit(2)

    failed = 0
    ran = 0
    for name, (ship_as, size, unit_scale) in JOBS.items():
        if only is not None and name not in only:
            continue
        ran += 1
        if not convert(name, ship_as, size, unit_scale, out_dir):
            failed += 1
    for name, (ship_as, size, unit_scale, keep) in ASSEMBLY_JOBS.items():
        if only is not None and name not in only:
            continue
        ran += 1
        if not convert_assembly(name, ship_as, size, unit_scale, keep, out_dir):
            failed += 1
    for name, (ship_as, size) in MESH_JOBS.items():
        if only is not None and name not in only:
            continue
        ran += 1
        if not convert(name, ship_as, size, 1.0, out_dir, mesh_only=True):
            failed += 1
    print(f"[DONE] {ran - failed}/{ran} converted")
    if failed:
        sys.exit(1)


main()
