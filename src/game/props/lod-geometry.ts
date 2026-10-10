// src/game/props/lod-geometry.ts — the coarser meshes a scatter prop's far
// rungs draw. DEV-338.
//
// ── Generated at load, from the one glTF every prop already is ────────────
//
// 2016 shipped real LODs for exactly one pack — `Tree Pack`'s prefabs carry a
// `LODGroup` over `tree10_LOD0/1/2` — and none for the ones that cost: the
// desert's `Bush_Grassland_02` is 1,520 triangles and seven of its thirteen
// palette slots, and the cacti are 988–1,566. So a port of 2016's LODs would
// leave the one environment that is still over budget exactly where it is.
// These are made here instead, from the mesh the renderer already loaded, by
// three's own `SimplifyModifier` (Melax's progressive mesh): no new dependency,
// no new asset on the bucket, and under 30 ms a mesh on this box — measured on
// the six heaviest props before this file was written.
//
// ── Simplify the SHAPE, then give every new face an old face's colour ─────
//
// The art is one colour per face (ART_DIRECTION pillar 2) and the meshes are
// split per face so the creases stay hard. Handed to a simplifier as they are,
// every colour border is an open edge it will not collapse across, and the
// reduction stalls; merged with the colour kept, the colours smear across the
// faces that survive. So the colour is taken OUT: the positions alone are
// welded and simplified, and each surviving triangle is then painted with the
// colour of the source triangle whose centroid is nearest its own. The result
// is still one colour per face, every colour is one the artist chose, and a
// coarser rung reads as the same prop folded from fewer, larger sheets —
// pillar 5's scale ladder, walked outward.
//
// The normals are recomputed flat. The material is `flatShading` anyway, which
// derives the facet normal in the fragment shader. Every other attribute the
// source carries is carried too, as zeros, so the rungs compile to the same
// program as the full mesh (see the comment at the end of the simplifier).

import * as THREE from 'three'
import { SimplifyModifier } from 'three/examples/jsm/modifiers/SimplifyModifier.js'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

/**
 * Below this many triangles a rung is not a prop, it is a shard. The previous
 * rung is drawn instead — see {@link simplifyPropGeometry}.
 */
export const MIN_RUNG_TRIANGLES = 4

/**
 * Weld tolerance, in the mesh's own units. Only has to tell "the same corner,
 * written twice because the faces around it are split" from "a different
 * corner"; every shipped prop's nearest distinct corners are orders of
 * magnitude apart from this.
 */
const WELD_TOLERANCE = 1e-4

const triangleCount = (g: THREE.BufferGeometry): number =>
  (g.index ? g.index.count : g.getAttribute('position').count) / 3

/** The three vertex indices of triangle `t`, indexed or not. */
const corner = (g: THREE.BufferGeometry, t: number, k: number): number =>
  g.index ? g.index.getX(t * 3 + k) : t * 3 + k

/**
 * A coarser copy of a prop's geometry, keeping about `keep` of its distinct
 * corners. Returns null when the result would have fewer than
 * {@link MIN_RUNG_TRIANGLES} triangles or is not actually smaller — the caller
 * then draws the previous rung's mesh for this one, which is a wasted draw call
 * and never a missing prop.
 *
 * Non-indexed, one colour per face when the source has colours, flat normals.
 */
export const simplifyPropGeometry = (
  source: THREE.BufferGeometry,
  keep: number,
): THREE.BufferGeometry | null => {
  const position = source.getAttribute('position') as THREE.BufferAttribute | undefined
  if (!position) return null
  const sourceTris = triangleCount(source)

  // ── the shape, alone ──────────────────────────────────────────────────
  const shape = new THREE.BufferGeometry()
  shape.setAttribute('position', position.clone())
  if (source.index) shape.setIndex(source.index.clone())
  const welded = mergeVertices(shape, WELD_TOLERANCE)
  shape.dispose()
  const corners = welded.getAttribute('position').count
  const remove = Math.floor(corners * (1 - keep))
  const simplified = new SimplifyModifier().modify(welded, remove)
  welded.dispose()
  const flat = simplified.index ? simplified.toNonIndexed() : simplified
  if (flat !== simplified) simplified.dispose()
  // Only the positions go on: the modifier carries nothing else here, and a
  // stray attribute would put the rung on a different program from rung 0.
  for (const name of Object.keys(flat.attributes)) {
    if (name !== 'position') flat.deleteAttribute(name)
  }

  const outTris = flat.getAttribute('position').count / 3
  if (outTris < MIN_RUNG_TRIANGLES || outTris >= sourceTris) {
    flat.dispose()
    return null
  }

  // ── the colour, face by face ─────────────────────────────────────────
  const colour = source.getAttribute('color') as THREE.BufferAttribute | undefined
  if (colour) {
    const size = colour.itemSize
    // Source centroids and per-face colours, once.
    const cx = new Float32Array(sourceTris)
    const cy = new Float32Array(sourceTris)
    const cz = new Float32Array(sourceTris)
    const faceColour = new Float32Array(sourceTris * size)
    for (let t = 0; t < sourceTris; t++) {
      for (let k = 0; k < 3; k++) {
        const v = corner(source, t, k)
        cx[t] = (cx[t] as number) + position.getX(v) / 3
        cy[t] = (cy[t] as number) + position.getY(v) / 3
        cz[t] = (cz[t] as number) + position.getZ(v) / 3
        for (let c = 0; c < size; c++) {
          faceColour[t * size + c] =
            (faceColour[t * size + c] as number) + colour.getComponent(v, c) / 3
        }
      }
    }
    const out = flat.getAttribute('position')
    const painted = new Float32Array(outTris * 3 * size)
    for (let t = 0; t < outTris; t++) {
      const x = (out.getX(t * 3) + out.getX(t * 3 + 1) + out.getX(t * 3 + 2)) / 3
      const y = (out.getY(t * 3) + out.getY(t * 3 + 1) + out.getY(t * 3 + 2)) / 3
      const z = (out.getZ(t * 3) + out.getZ(t * 3 + 1) + out.getZ(t * 3 + 2)) / 3
      let best = 0
      let bestD = Infinity
      for (let s = 0; s < sourceTris; s++) {
        const dx = (cx[s] as number) - x
        const dy = (cy[s] as number) - y
        const dz = (cz[s] as number) - z
        const d = dx * dx + dy * dy + dz * dz
        if (d < bestD) {
          bestD = d
          best = s
        }
      }
      for (let k = 0; k < 3; k++) {
        for (let c = 0; c < size; c++) {
          painted[(t * 3 + k) * size + c] = faceColour[best * size + c] as number
        }
      }
    }
    flat.setAttribute('color', new THREE.BufferAttribute(painted, size))
  }

  flat.computeVertexNormals()
  // ── the same attribute SET as the source, or a second program ─────────
  //
  // three picks a program partly from the GEOMETRY, not only the material:
  // `vertexUv1s` is `!!geometry.attributes.uv1`, `vertexAlphas` is the colour's
  // item size. `cactus-tall-03` carries a TEXCOORD_1, so a rung without one
  // would compile its own program the first time it drew — mid-flight, the
  // DEV-194 hitch. Anything the source has that the rung has no meaning for is
  // carried as zeros: nothing here samples a texture.
  for (const [name, attr] of Object.entries(source.attributes)) {
    if (flat.getAttribute(name)) continue
    flat.setAttribute(
      name,
      new THREE.BufferAttribute(new Float32Array(outTris * 3 * attr.itemSize), attr.itemSize),
    )
  }
  flat.computeBoundingBox()
  flat.computeBoundingSphere()
  return flat
}

/**
 * One geometry per rung for a prop: rung 0 is `source` itself, and rung `k` is
 * `source` kept to `keeps[k - 1]`. A rung that would not simplify reuses the
 * rung before it, so the list is always `keeps.length + 1` long and a caller
 * can index it by rung without a hole. The returned `owned` are the ones this
 * made, for the caller to dispose — never `source`.
 */
export const propRungGeometries = (
  source: THREE.BufferGeometry,
  keeps: readonly number[],
): { rungs: THREE.BufferGeometry[]; owned: THREE.BufferGeometry[] } => {
  const rungs: THREE.BufferGeometry[] = [source]
  const owned: THREE.BufferGeometry[] = []
  for (const keep of keeps) {
    const made = simplifyPropGeometry(source, keep)
    if (made) {
      owned.push(made)
      rungs.push(made)
    } else {
      rungs.push(rungs[rungs.length - 1] as THREE.BufferGeometry)
    }
  }
  return { rungs, owned }
}
