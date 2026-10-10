# Coordinate convention — measured, not asserted

`tools/extract/level.mjs` converts every Unity transform to three.js space with the
**negate-Z mirror**:

| | Unity (left-handed, Y-up, **+Z forward**) | three.js / glTF (right-handed, Y-up, **−Z forward**) |
|---|---|---|
| position | `(x, y, z)` | `(x, y, −z)` |
| quaternion | `(x, y, z, w)` | `(−x, −y, z, w)` |
| scale | `(x, y, z)` | unchanged |
| euler XYZ (deg) | `(x, y, z)` | `(−x, −y, z)` |
| triangle winding | CW | **reversed** — meshes only |
| UV | `(u, v)` | **`(u, 1−v)`** — meshes only |

The mapping has **determinant −1**: it is a mirror, not a rotation. That is why the last two
rows exist. A mesh converted this way and a transform converted this way stay consistent with
each other *only if both halves are applied*. Convert positions and forget the winding and every
surface faces inward. `level.mjs` emits transforms only, so it applies the first three rows; the
winding and UV halves belong to the terrain and prop pipelines, which must apply them.

## How it was validated

Not by counting front-facing triangles, and not by argument. `tools/prototype/axis_test.js`
takes a mesh exported from Unity YAML in **raw Unity coordinates** and the **same source FBX**
exported to glTF by Blender, centres both, and scores eight candidate axis mappings by how many
glTF vertices land on a Unity vertex.

```
$ node tools/prototype/axis_test.js out/<name>.obj out/<name>.glb
```

Run 2026-09-09 over four assets. Scores are `matched / total`:

| mapping (glTF → Unity) | chair-Faceted | rock1-Faceted | MM_TI_Old_Tree_05 | cliff-Faceted |
|---|---:|---:|---:|---:|
| identity `(x, y, z)` | 0.0 % | 0.0 % | 0.5 % | 0.0 % |
| negate X `(−x, y, z)` | 0.0 % | 0.0 % | 0.0 % | 0.0 % |
| **negate Z `(x, y, −z)`** | **100.0 %** | **100.0 %** | **100.0 %** | **100.0 %** |
| negate X,Z `(−x, y, −z)` | **100.0 %** | 0.0 % | 0.5 % | 0.5 % |
| negate Y `(x, −y, z)` | 0.0 % | 0.0 % | 0.0 % | 0.0 % |
| swap YZ `(x, z, y)` | 0.0 % | 0.0 % | 0.0 % | 0.0 % |
| swap YZ negZ `(x, z, −y)` | 0.0 % | 0.0 % | 0.3 % | 1.9 % |
| swap YZ negY `(x, −z, y)` | 0.6 % | 0.0 % | 0.0 % | 0.0 % |

Vertex counts were identical on both sides in all four cases (924, 672, 5 070, 1 242) and the
extent-derived scale factor was exactly 1.000000, so this is a pure axis question with no scale
or unit confusion mixed in.

**Verdict: negate-Z, uniquely.**

## The trap this run caught

`negate X,Z` also scores **100 % on the chair** — because the chair is symmetric about X, so a
mirror in X maps its vertex set onto itself. On `rock1-Faceted`, which is asymmetric, the same
mapping scores **0 %**. Validating against one symmetric asset would have left two mappings tied
and the tie would have been broken by whichever looked right in a screenshot.

This is the asymmetric-asset check the port plan calls S1. It is cheap and it is the reason the
convention is stated as measured rather than assumed: run it on something lopsided, and run it
on more than one thing.

## Reproduce

```
node tools/prototype/axis_test.js tools/prototype/out/rock1-Faceted.obj tools/prototype/out/rock1-Faceted.glb
node tools/prototype/axis_test.js tools/prototype/out/cliff-Faceted.obj  tools/prototype/out/cliff-Faceted.glb
```

`axis_test.js` is CommonJS and the repo's `package.json` declares `"type": "module"`, so run it
from a directory carrying `{"type":"commonjs"}` (or copy it plus `glb_inspect.js` to a scratch
directory with such a `package.json`, which is how the run above was done). `level.mjs` itself
sidesteps this by compiling the CommonJS prototype tools in an in-process sandbox — see
`requireCjs()` there.
