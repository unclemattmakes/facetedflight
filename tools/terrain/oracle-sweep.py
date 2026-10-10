#!/usr/bin/env python3
"""Dump per-chunk statistics for EVERY baked 2016 chunk, in one pass.

`extract-2016-chunk.py` answers "is this one chunk right?". That is a weaker
question than it sounds: chunk (0, 0) is a corner of the grid, so it exercises
the skirt on two sides and — on Simonet — open water in the middle. It cannot
catch an error that only appears inland, at a coastline, or at the far edge of
the heightmap. This walks all 256 chunks at all 3 LODs instead.

One pass, because the islands bake is 135 MB and the water bake is 589 MB;
reopening either per chunk is minutes of I/O for seconds of work.

Read-only oracle. Output goes to the scratch area, NEVER the repo or the
bucket — the bake is derived from World Machine output whose licence question
is still open (content/MANIFEST.md, D26).

Usage:
    python tools/terrain/oracle-sweep.py --out <scratch>/oracle/simonet.json
    python tools/terrain/oracle-sweep.py --terrain simonet.ocean --out ...
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import unity_mesh as um  # noqa: E402

BAKES = {
    "simonet.islands": "Assets/Faceted Flight/Scenes/environments/LevelArt_SimonetIslands/terrain_simonetIslands_FacetedChunks.asset",
    "simonet.ocean": "Assets/Faceted Flight/Scenes/environments/LevelArt_SimonetIslands/water_FacetedChunks.asset",
}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--terrain", default="simonet.islands")
    ap.add_argument("--asset", default=None, help="override the bake path")
    ap.add_argument("--lod", type=int, default=None, help="only this LOD level")
    ap.add_argument("--out", required=True)
    ap.add_argument(
        "--dump",
        default=None,
        help="also write full vertices for these chunks, e.g. 9,11:10,13:3,3",
    )
    ap.add_argument("--dump-dir", default=None)
    args = ap.parse_args()

    params = um.terrain_constants(args.terrain)
    chunk_size = params["chunkSize"]

    asset = args.asset or os.path.join(um.LEGACY, BAKES[args.terrain])
    started = time.time()
    env = um.load_env(asset)

    # Mesh name is only "LOD0"/"LOD1"/"LOD2"; grid position comes from bounds.
    wanted = (
        {tuple(int(n) for n in c.split(",")) for c in args.dump.split(":")}
        if args.dump
        else set()
    )
    chunks: dict[str, dict] = {}
    collisions: list[str] = []
    failures: list[str] = []
    done = 0

    for obj in env.objects:
        if obj.type.name != "Mesh":
            continue
        try:
            mesh, vertices, colors, normals = um.decode(obj)
        except RuntimeError as exc:
            failures.append(str(exc))
            continue

        name = getattr(mesh, "m_Name", "")
        # Unity renames the MAIN asset of a .asset file to the file's own
        # basename, so exactly one mesh in the bake is not called "LOD0" — and
        # it is chunk (0,0) LOD0, the chunk every spot-check uses. Treating an
        # unrecognised name as anything but LOD 0 silently drops it.
        lod = int(name[3:]) if name.startswith("LOD") and name[3:].isdigit() else 0
        if args.lod is not None and lod != args.lod:
            continue

        cx, cz = um.chunk_coord(vertices, chunk_size)
        key = f"{cx},{cz},lod{lod}"
        if key in chunks:
            collisions.append(key)
        chunks[key] = {
            "chunkX": cx,
            "chunkY": cz,
            "lod": lod,
            "hasColors": bool(colors),
            **um.stats(vertices),
        }
        if (cx, cz) in wanted and lod == 0 and args.dump_dir:
            os.makedirs(args.dump_dir, exist_ok=True)
            dpath = os.path.join(args.dump_dir, f"{args.terrain}_x{cx}_y{cz}_lod0.json")
            with open(dpath, "w", encoding="utf-8") as dfh:
                json.dump(
                    {
                        "chunk": [cx, cz],
                        "lod": 0,
                        "stats": um.stats(vertices),
                        "vertices": [list(v) for v in vertices],
                        "colors": [list(c) for c in colors] if colors else None,
                        "normals": [list(n) for n in normals] if normals else None,
                    },
                    dfh,
                )

        done += 1
        if done % 128 == 0:
            print(f"  {done} chunks in {time.time() - started:.0f}s...", flush=True)

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(
            {
                "terrain": args.terrain,
                "asset": asset,
                "assetBytes": os.path.getsize(asset),
                "chunkSize": chunk_size,
                "chunkPerSide": params["chunkPerSide"],
                "chunkCount": len(chunks),
                "duplicateCoords": collisions,
                "decodeFailures": failures,
                "chunks": chunks,
            },
            fh,
            indent=1,
        )

    print(f"wrote {args.out}")
    print(f"  {len(chunks)} chunks in {time.time() - started:.1f}s")
    if collisions:
        # Two meshes claiming one grid cell means chunk_coord is wrong, and
        # every diff built on it is comparing the wrong pair.
        print(f"  !! {len(collisions)} duplicate coordinates: {collisions[:8]}")
    if failures:
        print(f"  !! {len(failures)} meshes failed to decode")
        print(f"     {failures[0]}")


if __name__ == "__main__":
    main()
