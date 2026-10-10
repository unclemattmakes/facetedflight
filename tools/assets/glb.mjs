// tools/assets/glb.mjs: the hull-frame maths and the minimal GLB writer the converters share.
//
// TL-9 (docs/plan/code-reuse/tools.md): five converters (wings, jumpseat cone, start deck, hangar
// art, life) imported a GLB writer from a file named after the wings. Moved here VERBATIM: the
// GLB's `asset.generator` still names convert-wings.mjs (DEV-322) because that string is inside
// every published converter GLB, so changing it would change the bytes of assets that are
// otherwise unchanged. `--check` on each converter proves it.
//
// DEV-760: the prop meshes use it too. `extract-props.mjs` used to shell out to
// `tools/prototype/unity_mesh_to_obj.js --glb`, which writes tangents, UVs and a VEC4 colour that
// this writer did not; those are now opt-in parts of `buildGlb` (see its doc), so the `.asset` props
// come out through the hardened decode in `unity-mesh-asset.mjs` and one writer.
// docs/plan/code-reuse/progress/reuse-prop-mesh.md has the equivalence proof.

/**
 * The inverse-transpose of the upper 3x3, ROW-major, for normals under a
 * non-uniform scale (`Mesh1-Combined`'s outer node is (1.0204, 1.0204, 1.066)).
 *
 * `(A^-1)^T = cof(A) / det(A)`. Dividing by the determinant rather than only
 * normalising keeps the SIGN right under a negative scale, which is the one
 * case where a normal transform silently turns a mesh inside out.
 */
const normalMatrix = (m) => {
  const a00 = m[0]
  const a10 = m[1]
  const a20 = m[2]
  const a01 = m[4]
  const a11 = m[5]
  const a21 = m[6]
  const a02 = m[8]
  const a12 = m[9]
  const a22 = m[10]
  const c00 = a11 * a22 - a12 * a21
  const c01 = -(a10 * a22 - a12 * a20)
  const c02 = a10 * a21 - a11 * a20
  const c10 = -(a01 * a22 - a02 * a21)
  const c11 = a00 * a22 - a02 * a20
  const c12 = -(a00 * a21 - a01 * a20)
  const c20 = a01 * a12 - a02 * a11
  const c21 = -(a00 * a12 - a02 * a10)
  const c22 = a00 * a11 - a01 * a10
  const det = a00 * c00 + a01 * c01 + a02 * c02
  return [c00, c01, c02, c10, c11, c12, c20, c21, c22].map((v) => v / det)
}

/**
 * Compose one mesh into the hull's frame and take it to three space.
 *
 * `matrix` is the Unity chain from the wing's parent to the mesh; the wing sits
 * at that parent's identity, so this is the HULL's frame. Then z is negated on
 * positions and normals and every triangle's winding is reversed.
 */
export const toThreeHullFrame = (mesh, matrix) => {
  const n = mesh.position.length / 3
  const position = new Float32Array(n * 3)
  const normal = mesh.normal ? new Float32Array(n * 3) : null
  const nm = normalMatrix(matrix)
  for (let v = 0; v < n; v++) {
    const [x, y, z] = [mesh.position[v * 3], mesh.position[v * 3 + 1], mesh.position[v * 3 + 2]]
    const px = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]
    const py = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]
    const pz = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]
    position[v * 3] = px
    position[v * 3 + 1] = py
    position[v * 3 + 2] = -pz
    if (normal) {
      const [a, b, c] = [mesh.normal[v * 3], mesh.normal[v * 3 + 1], mesh.normal[v * 3 + 2]]
      // `nm` is row-major: row r dotted with (a, b, c) is component r.
      const nx = nm[0] * a + nm[1] * b + nm[2] * c
      const ny = nm[3] * a + nm[4] * b + nm[5] * c
      const nz = nm[6] * a + nm[7] * b + nm[8] * c
      const len = Math.hypot(nx, ny, nz) || 1
      normal[v * 3] = nx / len
      normal[v * 3 + 1] = ny / len
      normal[v * 3 + 2] = -nz / len
    }
  }
  const indices = new Uint16Array(mesh.indices.length)
  for (let i = 0; i < indices.length; i += 3) {
    indices[i] = mesh.indices[i]
    indices[i + 1] = mesh.indices[i + 2]
    indices[i + 2] = mesh.indices[i + 1]
  }
  return { position, normal, indices }
}

/**
 * Every triangle's winding must agree with its stored normal.
 *
 * Returns the worst `1 - dot(face, normal)` over the mesh. A forgotten winding
 * flip gives 2 on every face; a forgotten normal flip gives something far from
 * 0 on any face that is not perpendicular to z.
 */
export const worstWindingDisagreement = ({ position, normal, indices }) => {
  let worst = 0
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]]
    const ux = position[b * 3] - position[a * 3]
    const uy = position[b * 3 + 1] - position[a * 3 + 1]
    const uz = position[b * 3 + 2] - position[a * 3 + 2]
    const wx = position[c * 3] - position[a * 3]
    const wy = position[c * 3 + 1] - position[a * 3 + 1]
    const wz = position[c * 3 + 2] - position[a * 3 + 2]
    const fx = uy * wz - uz * wy
    const fy = uz * wx - ux * wz
    const fz = ux * wy - uy * wx
    const len = Math.hypot(fx, fy, fz)
    if (len < 1e-12) continue
    for (const v of [a, b, c]) {
      const d = (fx * normal[v * 3] + fy * normal[v * 3 + 1] + fz * normal[v * 3 + 2]) / len
      worst = Math.max(worst, 1 - d)
    }
  }
  return worst
}

// ── GLB ────────────────────────────────────────────────────────────────────

const pad4 = (buf, fill = 0) => {
  const r = buf.length % 4
  return r === 0 ? buf : Buffer.concat([buf, Buffer.alloc(4 - r, fill)])
}

/** glTF accessor `type` by component count. */
const ACCESSOR_TYPE = ['', 'SCALAR', 'VEC2', 'VEC3', 'VEC4']

/**
 * A minimal, deterministic GLB: one buffer, one node per part, no textures.
 *
 * Each part is `{ name, position, normal?, color?, indices, material, extras? }`
 * (Float32Arrays, `indices` a Uint16Array). Everything below is OPT-IN, so a
 * caller that passes none of it gets the bytes it always got (the five
 * converters' `--check` modes are the proof):
 *
 *   part.tangent  Float32Array(n * 4)   TANGENT, VEC4
 *   part.uv0      Float32Array(n * 2)   TEXCOORD_0, VEC2
 *   part.uv1      Float32Array(n * 2)   TEXCOORD_1, VEC2
 *   part.color    Float32Array(n * 3 or n * 4): COLOR_0 is VEC3 or VEC4 by length
 *   part.indices  a Uint32Array is written as UNSIGNED_INT; an ARRAY of index
 *                 arrays is one primitive each, all sharing the part's attributes
 *                 and material (what a multi-submesh Unity mesh needs)
 *
 *   flat          one part and NO root node: the scene's node is the part's own
 *                 `{ name, mesh }`, which is what a single Unity mesh exports as
 *   accessorNames every attribute accessor carries `name` (its glTF semantic)
 *   generator     the `asset.generator` string
 *
 * The attribute order in the buffer is POSITION, NORMAL, TANGENT, TEXCOORD_0,
 * TEXCOORD_1, COLOR_0, then the indices. This is the set and the order the prop
 * meshes have always been published with (TL-9, DEV-760), written down here so a
 * change to it is a test failure and not a silent drop of UVs.
 */
export const buildGlb = ({
  parts,
  root,
  extras,
  flat = false,
  accessorNames = false,
  generator = 'tools/assets/convert-wings.mjs (DEV-322)',
}) => {
  if (flat && parts.length !== 1) throw new Error('buildGlb: flat needs exactly one part')
  const views = []
  const accessors = []
  const chunks = []
  let length = 0
  const view = (bytes, target) => {
    const b = pad4(bytes)
    views.push({ buffer: 0, byteOffset: length, byteLength: bytes.length, target })
    chunks.push(b)
    length += b.length
    return views.length - 1
  }
  const f32 = (array, comps, withBounds, name) => {
    const v = view(Buffer.from(array.buffer, array.byteOffset, array.byteLength), 34962)
    const acc = {
      bufferView: v,
      componentType: 5126,
      count: array.length / comps,
      type: ACCESSOR_TYPE[comps],
    }
    if (accessorNames) acc.name = name
    if (withBounds) {
      const min = [Infinity, Infinity, Infinity]
      const max = [-Infinity, -Infinity, -Infinity]
      for (let i = 0; i < array.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], array[i + k])
          max[k] = Math.max(max[k], array[i + k])
        }
      }
      acc.min = min
      acc.max = max
    }
    accessors.push(acc)
    return accessors.length - 1
  }
  const indexAccessor = (array) => {
    const wide = array instanceof Uint32Array
    const v = view(Buffer.from(array.buffer, array.byteOffset, array.byteLength), 34963)
    accessors.push({
      bufferView: v,
      componentType: wide ? 5125 : 5123,
      count: array.length,
      type: 'SCALAR',
    })
    return accessors.length - 1
  }
  const meshes = []
  const materials = []
  const nodes = flat ? [] : [{ name: root, children: parts.map((_, i) => i + 1), extras }]
  for (const [i, part] of parts.entries()) {
    const n = part.position.length / 3
    const attributes = { POSITION: f32(part.position, 3, true, 'POSITION') }
    if (part.normal) attributes.NORMAL = f32(part.normal, 3, false, 'NORMAL')
    if (part.tangent) attributes.TANGENT = f32(part.tangent, 4, false, 'TANGENT')
    if (part.uv0) attributes.TEXCOORD_0 = f32(part.uv0, 2, false, 'TEXCOORD_0')
    if (part.uv1) attributes.TEXCOORD_1 = f32(part.uv1, 2, false, 'TEXCOORD_1')
    if (part.color) {
      const comps = part.color.length / n
      if (comps !== 3 && comps !== 4) {
        throw new Error(`buildGlb: ${part.name} colour has ${comps} components per vertex`)
      }
      attributes.COLOR_0 = f32(part.color, comps, false, 'COLOR_0')
    }
    materials.push(part.material)
    const sets = Array.isArray(part.indices) ? part.indices : [part.indices]
    meshes.push({
      name: part.name,
      primitives: sets.map((set) => ({
        attributes,
        indices: indexAccessor(set),
        material: i,
        mode: 4,
      })),
    })
    nodes.push({ name: part.name, mesh: i, extras: part.extras })
  }
  const json = {
    asset: { version: '2.0', generator },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: length }],
  }
  const jsonBuf = pad4(Buffer.from(JSON.stringify(json), 'utf8'), 0x20)
  const binBuf = Buffer.concat(chunks)
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binBuf.length, 8)
  const jh = Buffer.alloc(8)
  jh.writeUInt32LE(jsonBuf.length, 0)
  jh.writeUInt32LE(0x4e4f534a, 4)
  const bh = Buffer.alloc(8)
  bh.writeUInt32LE(binBuf.length, 0)
  bh.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([header, jh, jsonBuf, bh, binBuf])
}
