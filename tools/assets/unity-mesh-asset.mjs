// tools/assets/unity-mesh-asset.mjs — read a TEXT-YAML Unity `Mesh` asset.
//
// DEV-322. 2016's combined meshes (`Meshes/combined/Mesh*-Combined.asset`) are
// serialised as YAML with the vertex buffer as one hex string. **UnityPy returns
// nothing for these** — an empty parse, which in this codebase reads exactly
// like a missing file (CLAUDE.md's YAML-dialect trap, and the memory note
// `unitypy-returns-nothing-for-text-assets`). So this is a small reader of its
// own. Zero dependencies, READ-ONLY on the Unity project.
//
// ── Two dialects, and the old one reads as garbage rather than as absence ──
//
// Both are `Mesh serializedVersion: 8`, and they differ in the vertex layout:
//
//   * **Unity 4** (`Mesh1-Combined.asset`, written 2014-11-13): `m_Channels`
//     has SIX slots — position, normal, color, uv0, uv1, tangent — and a
//     `m_Streams` block gives each stream's stride. The colour is ONE packed
//     32-bit component: `format: 2, dimension: 1`.
//   * **Unity 5** (`Mesh2-Combined.asset`, 2015-07-22): EIGHT slots — position,
//     normal, color, uv0, uv1, uv2, uv3, tangent — and no `m_Streams`; the
//     stride is the sum of the live channels. The colour is FOUR bytes:
//     `format: 2, dimension: 4`.
//
// `tools/prototype/unity_mesh_to_obj.js` reads the Unity 5 slot table for both,
// so on a Unity 4 file it names the tangent `uv2` and reads the packed colour
// as one byte — no error, just wrong channels. Here the slot table is chosen by
// the NUMBER of slots, and anything that is neither six nor eight throws.
//
// **The layout is DECODED, never guessed.** Every channel's offset, format and
// dimension comes out of `m_Channels`, every stride out of `m_Streams` or the
// channels, and the parse is refused unless `stride x vertexCount` accounts for
// `m_DataSize` exactly and the hex decodes to that many bytes. That identity is
// the check that a layout was read right: a wrong stride cannot satisfy it.

import { readUnityText } from '../unity/yaml.mjs'

/** Unity 4's six vertex channels, in `m_Channels` order. */
export const UNITY4_SLOTS = Object.freeze(['position', 'normal', 'color', 'uv0', 'uv1', 'tangent'])
/** Unity 5's eight vertex channels, in `m_Channels` order. */
export const UNITY5_SLOTS = Object.freeze([
  'position',
  'normal',
  'color',
  'uv0',
  'uv1',
  'uv2',
  'uv3',
  'tangent',
])

/** `format` → bytes per component. `2` is a colour, 4 bytes whatever its dimension says. */
const componentBytes = (format) => {
  if (format === 0) return 4
  if (format === 1) return 2
  if (format === 2) return 1
  throw new Error(`unity-mesh-asset: unknown channel format ${format}`)
}

/** Bytes one channel occupies in a vertex. A colour is 4 in both dialects. */
const channelBytes = (c) => (c.format === 2 ? 4 : c.dimension * componentBytes(c.format))

/**
 * CRLF → LF and no BOM, BEFORE any line-anchored regex (the prototype's first bug). The one
 * reader is `tools/unity/yaml.mjs`'s `readUnityText`; this is its LF mode.
 */
const readLf = (file) => readUnityText(file, { lf: true })

const grab = (re, s) => {
  const m = s.match(re)
  return m ? m[1] : null
}

const grabNumber = (re, s, what) => {
  const v = grab(re, s)
  if (v === null) throw new Error(`unity-mesh-asset: no ${what}`)
  return Number(v)
}

/** `{x: 1, y: .5, z: -2}` — Unity writes `.5`, which `Number` reads fine. */
const vec3 = (s) => {
  const o = { x: 0, y: 0, z: 0 }
  for (const m of s.matchAll(/([xyz]):\s*(-?[\d.]+(?:[eE][-+]?\d+)?)/g)) o[m[1]] = Number(m[2])
  return o
}

/**
 * Parse the ONE `Mesh` document of a `.asset` file.
 *
 * Returns the layout as read, the raw vertex bytes and the index buffer. Throws
 * on anything it does not understand rather than returning less — an empty
 * result is the failure this module exists to prevent.
 */
export const parseMeshAsset = (text) => {
  const docs = text.split(/^--- !u!43 &-?\d+[^\n]*\n/m).slice(1)
  if (docs.length !== 1) {
    throw new Error(`unity-mesh-asset: expected exactly one Mesh document, found ${docs.length}`)
  }
  const body = docs[0]
  const name = (grab(/^\s*m_Name:\s*(.*)$/m, body) ?? '').trim()
  const compression = grabNumber(/^\s*m_MeshCompression:\s*(\d+)/m, body, 'm_MeshCompression')
  if (compression !== 0) {
    throw new Error(`unity-mesh-asset: ${name} is compressed (m_MeshCompression ${compression})`)
  }

  const subBlock = grab(/\n\s*m_SubMeshes:\n([\s\S]*?)\n\s*m_Shapes:/, body)
  if (!subBlock) throw new Error(`unity-mesh-asset: ${name} has no m_SubMeshes`)
  const subMeshes = subBlock
    .split(/^\s*- serializedVersion:.*$/m)
    .slice(1)
    .map((chunk) => ({
      firstByte: grabNumber(/firstByte:\s*(\d+)/, chunk, 'firstByte'),
      indexCount: grabNumber(/indexCount:\s*(\d+)/, chunk, 'indexCount'),
      topology: grabNumber(/topology:\s*(-?\d+)/, chunk, 'topology'),
      firstVertex: grabNumber(/firstVertex:\s*(\d+)/, chunk, 'firstVertex'),
      vertexCount: grabNumber(/vertexCount:\s*(\d+)/, chunk, 'vertexCount'),
    }))
  if (subMeshes.length === 0) throw new Error(`unity-mesh-asset: ${name} has no submeshes`)

  const vd = grab(/\n\s*m_VertexData:\n([\s\S]*?)\n\s*m_CompressedMesh:/, body)
  if (!vd) throw new Error(`unity-mesh-asset: ${name} has no m_VertexData`)
  const currentChannels = grabNumber(/m_CurrentChannels:\s*(\d+)/, vd, 'm_CurrentChannels')
  const vertexCount = grabNumber(/m_VertexCount:\s*(\d+)/, vd, 'm_VertexCount')
  const dataSize = grabNumber(/m_DataSize:\s*(\d+)/, vd, 'm_DataSize')
  const hex = grab(/_typelessdata:\s*([0-9a-fA-F]*)/, vd) ?? ''

  const channelBlock = grab(/m_Channels:\n([\s\S]*?)\n\s*(?:m_Streams|m_DataSize):/, vd)
  if (!channelBlock) throw new Error(`unity-mesh-asset: ${name} has no m_Channels`)
  const rawChannels = channelBlock
    .split(/^\s*- stream:/m)
    .slice(1)
    .map((c) => ({
      stream: Number(c.match(/^\s*(\d+)/)?.[1]),
      offset: grabNumber(/offset:\s*(\d+)/, c, 'offset'),
      format: grabNumber(/format:\s*(\d+)/, c, 'format'),
      dimension: grabNumber(/dimension:\s*(\d+)/, c, 'dimension'),
    }))
  const slots =
    rawChannels.length === 6 ? UNITY4_SLOTS : rawChannels.length === 8 ? UNITY5_SLOTS : null
  if (!slots) {
    throw new Error(
      `unity-mesh-asset: ${name} has ${rawChannels.length} channel slots; only Unity 4 (6) and Unity 5 (8) are known`,
    )
  }
  const dialect = rawChannels.length === 6 ? 'unity4' : 'unity5'
  const channels = rawChannels
    .map((c, slot) => ({ ...c, slot, name: slots[slot] }))
    .filter((c) => (currentChannels & (1 << c.slot)) !== 0 && c.dimension > 0)

  // Strides: `m_Streams` when the file has it (Unity 4), else the channels'.
  const streamBlock = grab(/m_Streams:\n([\s\S]*?)\n\s*m_DataSize:/, vd)
  const declaredStrides = streamBlock
    ? streamBlock
        .split(/^\s*- channelMask:/m)
        .slice(1)
        .map((s) => ({
          mask: Number(s.match(/^\s*(\d+)/)?.[1]),
          offset: grabNumber(/offset:\s*(\d+)/, s, 'stream offset'),
          stride: grabNumber(/stride:\s*(\d+)/, s, 'stride'),
        }))
    : null
  const streams = new Map()
  for (const c of channels) {
    const end = c.offset + channelBytes(c)
    streams.set(c.stream, Math.max(streams.get(c.stream) ?? 0, end))
  }
  if (declaredStrides) {
    for (const [s, computed] of streams) {
      const declared = declaredStrides[s]?.stride
      if (declared !== computed) {
        throw new Error(
          `unity-mesh-asset: ${name} stream ${s} declares stride ${declared} but its channels end at ${computed}`,
        )
      }
    }
  }
  // Streams are consecutive, each starting on a 16-byte boundary.
  const streamBase = new Map()
  let cursor = 0
  for (const s of [...streams.keys()].sort((a, b) => a - b)) {
    streamBase.set(s, cursor)
    cursor += streams.get(s) * vertexCount
    cursor = (cursor + 15) & ~15
  }
  const data = Buffer.from(hex, 'hex')
  const lastStream = Math.max(...streams.keys())
  const exact = streamBase.get(lastStream) + streams.get(lastStream) * vertexCount
  if (data.length !== dataSize) {
    throw new Error(
      `unity-mesh-asset: ${name} _typelessdata is ${data.length} bytes, m_DataSize says ${dataSize}`,
    )
  }
  if (exact !== dataSize) {
    throw new Error(
      `unity-mesh-asset: ${name} layout accounts for ${exact} bytes, m_DataSize says ${dataSize} — the channels were read wrong`,
    )
  }

  const indexBytes = Buffer.from(grab(/\n\s*m_IndexBuffer:\s*([0-9a-fA-F]*)/, body) ?? '', 'hex')
  const indices = new Uint16Array(indexBytes.length / 2)
  for (let i = 0; i < indices.length; i++) indices[i] = indexBytes.readUInt16LE(i * 2)
  const wantIndices = subMeshes.reduce((n, s) => n + s.indexCount, 0)
  if (indices.length !== wantIndices) {
    throw new Error(
      `unity-mesh-asset: ${name} has ${indices.length} indices, its submeshes say ${wantIndices}`,
    )
  }

  const aabb = grab(/\n\s*m_LocalAABB:\n([\s\S]*?)\n\s*m_MeshUsageFlags:/, body)
  const localAABB = aabb
    ? {
        center: vec3(grab(/m_Center:\s*(\{[^}]*\})/, aabb) ?? ''),
        extent: vec3(grab(/m_Extent:\s*(\{[^}]*\})/, aabb) ?? ''),
      }
    : null

  return {
    name,
    dialect,
    vertexCount,
    dataSize,
    channels,
    strides: Object.fromEntries(streams),
    streamBase: Object.fromEntries(streamBase),
    subMeshes,
    data,
    indices,
    localAABB,
  }
}

/**
 * Unpack the live channels into flat arrays, in UNITY space, untouched.
 *
 * `position` / `normal` are `Float32Array(n * 3)`, `color` is
 * `Uint8Array(n * 4)` in R, G, B, A byte order (Color32, both dialects), and a
 * channel the mesh does not carry is absent rather than zero-filled.
 */
export const decodeMesh = (parsed) => {
  const n = parsed.vertexCount
  const out = { indices: parsed.indices }
  for (const c of parsed.channels) {
    const stride = parsed.strides[c.stream]
    const base = parsed.streamBase[c.stream]
    if (c.name === 'color' && c.format === 0) {
      // ── A FLOAT colour: `format: 0, dimension: 4`, sixteen bytes ─────────
      //
      // DEV-430. VacuumShaders' Mesh Materializer writes its baked colour as
      // four float32s (`MM_*` meshes, e.g. `MM_MM_Commander_Table_01`). Read as
      // four BYTES — this reader's only colour path until then — it came out as
      // the low bytes of R's float: a rainbow with every alpha near 62, and
      // nothing threw, because the stride (which `channelBytes` already sized
      // at 16) was right. `colorFloat` is the exact value; `color` keeps the
      // byte contract every caller reads, quantised from it.
      if (c.dimension !== 4) {
        throw new Error(
          `unity-mesh-asset: ${parsed.name} has a float colour of dimension ${c.dimension}`,
        )
      }
      const flt = new Float32Array(n * 4)
      const col = new Uint8Array(n * 4)
      for (let v = 0; v < n; v++) {
        const at = base + v * stride + c.offset
        for (let k = 0; k < 4; k++) {
          const f = parsed.data.readFloatLE(at + 4 * k)
          flt[v * 4 + k] = f
          col[v * 4 + k] = Math.round(Math.min(1, Math.max(0, f)) * 255)
        }
      }
      out.colorFloat = flt
      out.color = col
      continue
    }
    if (c.name === 'color') {
      if (c.format !== 2) {
        throw new Error(`unity-mesh-asset: ${parsed.name} colour is format ${c.format}`)
      }
      const col = new Uint8Array(n * 4)
      for (let v = 0; v < n; v++) {
        const at = base + v * stride + c.offset
        for (let k = 0; k < 4; k++) col[v * 4 + k] = parsed.data[at + k]
      }
      out.color = col
      continue
    }
    if (c.format !== 0) {
      throw new Error(`unity-mesh-asset: ${parsed.name} ${c.name} is format ${c.format}, not float`)
    }
    const arr = new Float32Array(n * c.dimension)
    for (let v = 0; v < n; v++) {
      const at = base + v * stride + c.offset
      for (let k = 0; k < c.dimension; k++) {
        arr[v * c.dimension + k] = parsed.data.readFloatLE(at + 4 * k)
      }
    }
    out[c.name] = arr
  }
  if (!out.position) throw new Error(`unity-mesh-asset: ${parsed.name} has no position channel`)
  return out
}

/** Read and decode a `.asset` file in one call. */
export const loadMeshAsset = (file) => {
  const parsed = parseMeshAsset(readLf(file))
  return { parsed, mesh: decodeMesh(parsed) }
}

/**
 * Split a triangle list into its CONNECTED PARTS, welding by POSITION.
 *
 * A faceted mesh is a triangle soup — `Mesh1-Combined` has one vertex per
 * corner, 5,616 of each — so two triangles of one projector share no INDEX,
 * only a position. Vertices within `eps` metres are one node. Returns each
 * part's vertex indices, largest first.
 */
export const connectedParts = (positions, indices, eps = 1e-5) => {
  const n = positions.length / 3
  const key = (v) =>
    `${Math.round(positions[v * 3] / eps)},${Math.round(positions[v * 3 + 1] / eps)},${Math.round(positions[v * 3 + 2] / eps)}`
  const weld = new Map()
  const node = new Int32Array(n)
  for (let v = 0; v < n; v++) {
    const k = key(v)
    if (!weld.has(k)) weld.set(k, weld.size)
    node[v] = weld.get(k)
  }
  const parent = Array.from({ length: weld.size }, (_, i) => i)
  const find = (a) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]]
      a = parent[a]
    }
    return a
  }
  for (let i = 0; i < indices.length; i += 3) {
    const a = find(node[indices[i]])
    for (const k of [1, 2]) {
      const b = find(node[indices[i + k]])
      if (a !== b) parent[b] = a
    }
  }
  const parts = new Map()
  for (let v = 0; v < n; v++) {
    const r = find(node[v])
    if (!parts.has(r)) parts.set(r, [])
    parts.get(r).push(v)
  }
  return [...parts.values()].sort((a, b) => b.length - a.length)
}
