"""Decode baked 2016 terrain meshes, and work out which chunk each one is.

Shared by `extract-2016-chunk.py` and `oracle-sweep.py`. Two things here are
not obvious and both cost an afternoon:

**1. `Mesh.m_Vertices` is `None`.** Unity 5.4 packs positions, normals,
colours and UVs into interleaved `m_VertexData` streams. UnityPy exposes the
raw object faithfully, so the convenient-looking `m_Vertices` attribute exists
and is empty. `MeshHelper.MeshHandler` is what unpacks the streams. A tool
that reads the attribute directly does not fail loudly — it reads `None`.

**2. The mesh names carry no chunk index.** Every one of the 768 sub-assets is
called `LOD0`, `LOD1` or `LOD2`, and their order in the file is not grid
order — the second Mesh object in the Simonet bake is the chunk at grid
(3, 0). Identity has to come from the geometry: a chunk's vertices span its
own square of the world, so the bounds centre divided by `chunkSize` is the
grid coordinate.

Deriving it from bounds rather than trusting order is also the stronger check.
If the generator and the bake disagree about where a chunk *is*, that shows up
as an unmatched or duplicated coordinate instead of a silently mispaired diff.

Read-only. Nothing here writes to the Unity project.
"""

from __future__ import annotations

import json
import math
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from legacy_root import legacy_root  # noqa: E402

LEGACY = legacy_root()
CONSTANTS = os.path.join(REPO, "src", "generated", "constants.generated.json")


def terrain_constants(key: str) -> dict:
    """Look up a terrain's parameters in the generated sheet.

    CLAUDE.md rule 3: constants are generated, never hand-typed — and that
    applies to the oracle too. An oracle carrying its own copy of `chunkSize`
    would keep agreeing with the generator after someone corrected one of them.

    `key` is `"<environment>.<terrain>"`, e.g. `"simonet.islands"`.
    """
    if not os.path.exists(CONSTANTS):
        sys.exit(f"missing {CONSTANTS} — run `pnpm extract:constants` first")
    with open(CONSTANTS, encoding="utf-8") as fh:
        sheet = json.load(fh)
    env, _, name = key.partition(".")
    try:
        return sheet["terrain"][env]["terrains"][name]
    except KeyError:
        available = [
            f"{e}.{t}"
            for e, ev in sheet.get("terrain", {}).items()
            for t in ev.get("terrains", {})
        ]
        sys.exit(f"unknown terrain {key!r}. Available: {', '.join(sorted(available))}")


def load_env(path: str):
    try:
        import UnityPy
    except ImportError:
        sys.exit(
            "UnityPy is not installed. Build-time oracle only:\n"
            "    python -m pip install --user UnityPy"
        )
    if not os.path.exists(path):
        sys.exit(f"not found: {path}\nIs the legacy project mounted?")
    return UnityPy.load(path)


def decode(obj):
    """Return `(mesh, vertices, colors, normals)` with the streams unpacked.

    `vertices` is a list of (x, y, z) tuples; `colors` a list of (r, g, b, a)
    floats, or None; `normals` a list of (x, y, z) tuples, or None. Raises if
    the handler yields nothing, because a silently empty mesh is how the
    previous version of this tool reported a vertex count of zero for all 768
    chunks and looked like it had worked.

    Normals are here for the SKIRT. `FacetedTerrain.cs:1031-1038` stamps each
    skirt quad with the normal of the interior triangle sharing its boundary
    edge, and the port shipped without that for a while; the symptom was a pale
    dashed line down every LOD seam. Positions cannot see that error at all —
    the geometry is identical either way — so the bake's normals are the only
    oracle for it.
    """
    from UnityPy.helpers.MeshHelper import MeshHandler

    mesh = obj.read()
    handler = MeshHandler(mesh)
    handler.process()
    vertices = handler.m_Vertices
    if not vertices:
        raise RuntimeError(
            f"MeshHandler produced no vertices for {getattr(mesh, 'm_Name', '?')} "
            f"(m_VertexData.m_VertexCount = "
            f"{getattr(getattr(mesh, 'm_VertexData', None), 'm_VertexCount', '?')}). "
            "UnityPy's API may have moved."
        )
    return mesh, vertices, getattr(handler, "m_Colors", None), getattr(handler, "m_Normals", None)


def chunk_coord(vertices, chunk_size: float) -> tuple[int, int]:
    """Grid coordinate of a decoded chunk, from its bounds centre.

    The skirt ring hangs a little outside the chunk square on the outer edges,
    so `min // chunkSize` would be off by one there. The centre is unaffected:
    the skirt is a thin border on a `chunkSize`-wide tile, and the centre only
    has to land in the right cell.
    """
    xs = [v[0] for v in vertices]
    zs = [v[2] for v in vertices]
    cx = ((min(xs) + max(xs)) * 0.5) / chunk_size
    cz = ((min(zs) + max(zs)) * 0.5) / chunk_size
    return math.floor(cx), math.floor(cz)


def stats(vertices) -> dict:
    xs = [v[0] for v in vertices]
    ys = [v[1] for v in vertices]
    zs = [v[2] for v in vertices]
    n = len(vertices)
    return {
        "vertexCount": n,
        "min": [min(xs), min(ys), min(zs)],
        "max": [max(xs), max(ys), max(zs)],
        "heightMean": sum(ys) / n,
        # Skirt vertices sit at exactly y = 0 on the collapsed ring. Counting
        # them pins the skirt topology without comparing a jittered coordinate.
        "skirtVerts": sum(1 for y in ys if y == 0.0),
    }
