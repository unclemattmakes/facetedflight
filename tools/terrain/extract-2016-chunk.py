#!/usr/bin/env python3
"""Extract ONE baked 2016 terrain chunk as a ground-truth oracle.

`oracle-sweep.py` answers "does every chunk agree?" with a row of summary
statistics each. This answers "why does *this* chunk disagree?" by handing back
the actual vertices, so a disagreement can be localised to a height band rather
than argued about.

The 2016 generator ran in the Unity editor and baked its output to
`<scene>/<name>_FacetedChunks.asset` — Unity's BINARY serialisation, not the
ForceText YAML the rest of the project uses, so the project's own YAML mesh
decoder cannot read it. Hence UnityPy, and hence `unity_mesh.py`, which carries
the two traps: `m_Vertices` is `None` (the data is in packed `m_VertexData`
streams) and the mesh names carry no chunk index.

Read-only. Output goes to the scratch area, NEVER the repo or the bucket.

Usage:
    python tools/terrain/extract-2016-chunk.py --chunk 9,13 --out <scratch>
    python tools/terrain/extract-2016-chunk.py --chunk 0,0 --lod 1 --out <scratch>
"""

from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import unity_mesh as um  # noqa: E402

BAKES = {
    "simonet.islands": "Assets/Faceted Flight/Scenes/environments/LevelArt_SimonetIslands/terrain_simonetIslands_FacetedChunks.asset",
    "simonet.ocean": "Assets/Faceted Flight/Scenes/environments/LevelArt_SimonetIslands/water_FacetedChunks.asset",
}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--terrain", default="simonet.islands")
    ap.add_argument("--asset", default=None)
    ap.add_argument("--chunk", required=True, help="grid coordinate, e.g. 9,13")
    ap.add_argument("--lod", type=int, default=0)
    ap.add_argument("--out", required=True, help="directory for the JSON dump")
    args = ap.parse_args()

    want = tuple(int(n) for n in args.chunk.split(","))
    params = um.terrain_constants(args.terrain)
    chunk_size = params["chunkSize"]
    asset = args.asset or os.path.join(um.LEGACY, BAKES[args.terrain])
    env = um.load_env(asset)

    for obj in env.objects:
        if obj.type.name != "Mesh":
            continue
        mesh, vertices, colors, _normals = um.decode(obj)
        name = getattr(mesh, "m_Name", "")
        # Unity renames the MAIN asset of a .asset file to the file's own
        # basename, so exactly one chunk is not called "LOD0". Filtering on the
        # name silently drops it — and it is chunk (0,0), the one everybody
        # spot-checks against.
        lod = int(name[3:]) if name.startswith("LOD") and name[3:].isdigit() else 0
        if lod != args.lod:
            continue
        if um.chunk_coord(vertices, chunk_size) != want:
            continue

        stats = um.stats(vertices)
        print(json.dumps({"name": name, "chunk": want, "lod": args.lod, **stats}, indent=2))
        os.makedirs(args.out, exist_ok=True)
        path = os.path.join(args.out, f"{args.terrain}_x{want[0]}_y{want[1]}_lod{args.lod}.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(
                {
                    "chunk": want,
                    "lod": args.lod,
                    "stats": stats,
                    "vertices": [list(v) for v in vertices],
                    "colors": [list(c) for c in colors] if colors else None,
                },
                fh,
            )
        print(f"wrote {path}")
        return

    sys.exit(f"no chunk {want} at lod {args.lod} — run oracle-sweep.py to see what exists")


if __name__ == "__main__":
    main()
