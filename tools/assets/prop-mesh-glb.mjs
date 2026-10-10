// tools/assets/prop-mesh-glb.mjs: a Unity `.asset` prop mesh -> the GLB the game loads.
//
// DEV-760 (TL-9, docs/plan/code-reuse/tools.md). `extract-props.mjs` used to
// shell out to `tools/prototype/unity_mesh_to_obj.js --glb` for every `MM_*`
// mesh. That prototype reads the Unity 5 slot table for EVERY file, so on a
// Unity 4 mesh it names the tangent `uv2` and reads the packed colour as one
// byte: no error, just wrong channels (unity-mesh-asset.mjs's header). The
// shipped props are all Unity 5 with a float colour, so the bug was latent; the
// point of this module is that it cannot become live. The slot table is chosen
// by the number of slots, the layout must account for `m_DataSize` exactly, and
// anything else throws.
//
// ── The output is the prototype's output, to the byte ───────────────────────
//
// The prop GLBs are published, and an unchanged byte means no re-export, no
// sha moving in required-assets.json and no push. So this reproduces the
// prototype's schema exactly: POSITION, NORMAL, TANGENT (VEC4), TEXCOORD_0,
// TEXCOORD_1 (the cacti), COLOR_0 (VEC4, floats), indices, one primitive per
// triangle submesh, the one `vertexColor` material, a flat single node, and
// the prototype's own `asset.generator` string, which stays because it is inside
// every published prop GLB (the same reason convert-wings's string stays).
// `tests/unit/prop-mesh-glb.test.ts` pins the attribute set, and the proof that
// all sixteen props are value-identical to the prototype is in
// docs/plan/code-reuse/progress/reuse-prop-mesh.md.
//
// The conversion, in Unity -> glTF terms (a change of handedness):
//   * z is negated on position and normal; the tangent's z AND w are negated;
//   * every triangle's winding is reversed (a, b, c) -> (a, c, b);
//   * V is flipped, `1 - v` (Unity's V is bottom-up, glTF's is top-down);
//   * a float colour is written as it is, a byte colour as `byte / 255` (the
//     decoder gives four components either way; a float colour of any other
//     dimension throws there).
//
// Read-only on the Unity project: it takes a path and returns bytes.

import { buildGlb } from './glb.mjs'
import { loadMeshAsset } from './unity-mesh-asset.mjs'

/** The prototype's string of record. It names the tool this replaced; see above. */
export const PROP_GLB_GENERATOR = 'unity_mesh_to_obj.js (FacetedFlight2 pipeline)'

/** One material for every prop: the colour comes from the vertices. */
const vertexColorMaterial = () => ({
  name: 'vertexColor',
  pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.9 },
  doubleSided: false,
})

/** `n * comps` floats with the component at `k` negated (and the rest copied). */
const negated = (src, comps, ...which) => {
  const out = new Float32Array(src.length)
  for (let i = 0; i < src.length; i++) out[i] = src[i]
  for (let v = 0; v < src.length / comps; v++) {
    for (const k of which) out[v * comps + k] = -src[v * comps + k]
  }
  return out
}

/** `n * 2` floats with V flipped. */
const flipV = (src) => {
  const out = new Float32Array(src.length)
  for (let i = 0; i < src.length; i += 2) {
    out[i] = src[i]
    out[i + 1] = 1 - src[i + 1]
  }
  return out
}

/**
 * Take an already-decoded mesh (`loadMeshAsset`'s result) to the GLB bytes.
 * Split from the file read so a test can hand it a synthetic mesh.
 */
export const propGlbFromMesh = (parsed, mesh) => {
  const n = parsed.vertexCount
  const dim = (name) => parsed.channels.find((c) => c.name === name)?.dimension ?? 0
  for (const name of ['normal', 'uv0', 'uv1']) {
    const want = name === 'normal' ? 3 : 2
    if (mesh[name] && dim(name) !== want) {
      throw new Error(`prop-mesh-glb: ${parsed.name} ${name} has ${dim(name)} components`)
    }
  }

  const part = {
    name: parsed.name,
    position: negated(mesh.position, 3, 2),
    normal: mesh.normal ? negated(mesh.normal, 3, 2) : null,
    material: vertexColorMaterial(),
  }

  if (mesh.tangent) {
    const d = dim('tangent')
    if (d === 4) {
      part.tangent = negated(mesh.tangent, 4, 2, 3)
    } else if (d === 3) {
      // A three-component tangent has no handedness: it gets w = 1, un-negated.
      const t = new Float32Array(n * 4)
      for (let v = 0; v < n; v++) {
        t[v * 4] = mesh.tangent[v * 3]
        t[v * 4 + 1] = mesh.tangent[v * 3 + 1]
        t[v * 4 + 2] = -mesh.tangent[v * 3 + 2]
        t[v * 4 + 3] = 1
      }
      part.tangent = t
    } else {
      throw new Error(`prop-mesh-glb: ${parsed.name} tangent has ${d} components`)
    }
  }
  if (mesh.uv0) part.uv0 = flipV(mesh.uv0)
  if (mesh.uv1) part.uv1 = flipV(mesh.uv1)

  if (mesh.color) {
    // `colorFloat` is the exact value when the file stored four floats; a byte
    // colour (Color32, both dialects) is `byte / 255`, which is what the
    // prototype computed, rounded to float32 by the typed array.
    const col = new Float32Array(n * 4)
    if (mesh.colorFloat) col.set(mesh.colorFloat)
    else for (let i = 0; i < col.length; i++) col[i] = mesh.color[i] / 255
    part.color = col
  }

  const sets = []
  for (const sm of parsed.subMeshes) {
    if (sm.topology !== 0) continue
    const start = sm.firstByte / 2
    const idx = n <= 65535 ? new Uint16Array(sm.indexCount) : new Uint32Array(sm.indexCount)
    for (let i = 0; i < sm.indexCount; i += 3) {
      idx[i] = mesh.indices[start + i]
      idx[i + 1] = mesh.indices[start + i + 2]
      idx[i + 2] = mesh.indices[start + i + 1]
    }
    sets.push(idx)
  }
  if (sets.length === 0) throw new Error(`prop-mesh-glb: ${parsed.name} has no triangle submesh`)
  part.indices = sets

  return buildGlb({
    parts: [part],
    flat: true,
    accessorNames: true,
    generator: PROP_GLB_GENERATOR,
  })
}

/** Read a `.asset` file from the Unity project and return its GLB bytes. */
export const propGlbFromAsset = (file) => {
  const { parsed, mesh } = loadMeshAsset(file)
  return propGlbFromMesh(parsed, mesh)
}
