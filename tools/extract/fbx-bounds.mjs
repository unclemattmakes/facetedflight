/**
 * tools/extract/fbx-bounds.mjs -- the local bounds of a 2016 FBX mesh, measured.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * A Unity `MeshCollider` carries no size of its own: it is a mesh reference plus
 * the transform's scale, and the only place the mesh's extent exists is inside
 * the `.fbx`. Every other collider in this pipeline is numbers-in-YAML, so this
 * is the one shape the extractor could not read -- which is why the JumpSeat's
 * finish gate had no geometry and `level.finish` was null on six missions.
 *
 * The alternative was to take a size from prose. CLAUDE.md's rule about derived
 * numbers applies exactly: a figure computed in a scratch script and quoted in a
 * comment has none of the provenance the sheet gives an extracted one. So the
 * bytes get read.
 *
 * ── The unit-scale trap, which is trap #1 in CLAUDE.md's asset list ───────
 *
 * The vertices in the file are NOT metres. `hexTile.fbx`'s own AABB is
 * 19.02 x 5.00 x 18.09; the thing in the game is 30.3 x 5.7 x 28.9 m. Unity
 * applies an import scale of `fileScale * globalScale`, where `fileScale` comes
 * from the FBX's `UnitScaleFactor` (1 means centimetres, so 0.01) and
 * `globalScale` is in the `.fbx.meta`. For `hexTile` that is 0.01 * 10 = **0.1**.
 * Skip it and the gate is ten times too big, which on a 30 m slab is the
 * difference between a landing pad and a district.
 *
 * `useFileScale: 0` in the meta means Unity ignores the file's unit and uses
 * `globalScale` alone; both branches are implemented rather than assumed,
 * because the asset that eventually needs the other one will not announce itself.
 *
 * ── The reader ────────────────────────────────────────────────────────────
 *
 * Binary FBX 7.x only (`Kaydara FBX Binary  `), which is what the 2016 project
 * ships. Enough of the format to walk the node tree and pull `Geometry/Vertices`:
 * a record is [endOffset, numProperties, propertyListLen, nameLen, name, props,
 * children, 13-byte null terminator], and array properties are optionally
 * zlib-deflated. Anything it does not understand throws by name rather than
 * returning a plausible empty result.
 */

import fs from 'node:fs'
import zlib from 'node:zlib'
import { readUnityText } from '../unity/yaml.mjs'

const MAGIC = 'Kaydara FBX Binary  '

/** Parse a binary FBX into a node tree. Throws on ASCII FBX and on unknown property types. */
export function parseFbx(absPath) {
  const buf = fs.readFileSync(absPath)
  if (buf.subarray(0, MAGIC.length).toString('binary') !== MAGIC) {
    throw new Error(`fbx-bounds: ${absPath} is not a binary FBX (ASCII FBX is not supported)`)
  }
  const version = buf.readUInt32LE(23)
  // 7.5 widened the record header from 32-bit to 64-bit offsets.
  const wide = version >= 7500
  const headerLen = wide ? 25 : 13
  let pos = 27

  const readNode = () => {
    const endOffset = wide ? Number(buf.readBigUInt64LE(pos)) : buf.readUInt32LE(pos)
    const numProps = wide ? Number(buf.readBigUInt64LE(pos + 8)) : buf.readUInt32LE(pos + 4)
    const nameLen = buf.readUInt8(pos + (wide ? 24 : 12))
    let p = pos + headerLen
    const name = buf.subarray(p, p + nameLen).toString('utf8')
    p += nameLen
    if (endOffset === 0) return null // the null record that closes a child list
    const props = []
    for (let i = 0; i < numProps; i++) {
      const t = String.fromCharCode(buf.readUInt8(p))
      p += 1
      if (t === 'Y') {
        props.push(buf.readInt16LE(p))
        p += 2
      } else if (t === 'C') {
        props.push(buf.readUInt8(p) !== 0)
        p += 1
      } else if (t === 'I') {
        props.push(buf.readInt32LE(p))
        p += 4
      } else if (t === 'F') {
        props.push(buf.readFloatLE(p))
        p += 4
      } else if (t === 'D') {
        props.push(buf.readDoubleLE(p))
        p += 8
      } else if (t === 'L') {
        props.push(Number(buf.readBigInt64LE(p)))
        p += 8
      } else if (t === 'S' || t === 'R') {
        const len = buf.readUInt32LE(p)
        p += 4
        props.push(t === 'S' ? buf.subarray(p, p + len).toString('utf8') : buf.subarray(p, p + len))
        p += len
      } else if ('fdlib'.includes(t)) {
        const arrLen = buf.readUInt32LE(p)
        const encoding = buf.readUInt32LE(p + 4)
        const compressedLen = buf.readUInt32LE(p + 8)
        p += 12
        let data = buf.subarray(p, p + compressedLen)
        p += compressedLen
        if (encoding === 1) data = zlib.inflateSync(data)
        const stride = { f: 4, d: 8, l: 8, i: 4, b: 1 }[t]
        const out = new Array(arrLen)
        for (let k = 0; k < arrLen; k++) {
          const o = k * stride
          out[k] =
            t === 'f'
              ? data.readFloatLE(o)
              : t === 'd'
                ? data.readDoubleLE(o)
                : t === 'l'
                  ? Number(data.readBigInt64LE(o))
                  : t === 'i'
                    ? data.readInt32LE(o)
                    : data.readUInt8(o)
        }
        props.push(out)
      } else {
        throw new Error(`fbx-bounds: unknown FBX property type '${t}' at byte ${p} of ${absPath}`)
      }
    }
    const children = []
    while (p < endOffset - headerLen) {
      const outer = pos
      pos = p
      const child = readNode()
      p = pos
      pos = outer
      if (!child) break
      children.push(child)
    }
    pos = endOffset
    return { name, props, children }
  }

  const roots = []
  while (pos < buf.length - headerLen) {
    const node = readNode()
    if (!node) break
    roots.push(node)
  }
  return { version, roots }
}

/** Every node called `name`, depth-first. */
function findAll(nodes, name, out = []) {
  for (const n of nodes) {
    if (n.name === name) out.push(n)
    findAll(n.children, name, out)
  }
  return out
}

/** A `P` property row by its key, from anywhere in the tree. */
function propValue(roots, key) {
  for (const p of findAll(roots, 'P')) {
    if (String(p.props[0]) === key) return p.props[p.props.length - 1]
  }
  return null
}

/**
 * Unity's import scale for an FBX: `fileScale * globalScale`, from the `.meta`.
 *
 * `fileScale` is `UnitScaleFactor / 100` -- an FBX that says 1 is in
 * centimetres. `useFileScale: 0` drops that term. For `hexTile.fbx` the answer
 * is 0.01 * 10 = 0.1, and the arithmetic is checked against the shipped size in
 * `tests/unit/extract-finish.test.ts` rather than believed.
 */
export function unityImportScale(absFbxPath, unitScaleFactor) {
  const meta = `${absFbxPath}.meta`
  if (!fs.existsSync(meta)) {
    throw new Error(`fbx-bounds: no .meta beside ${absFbxPath}; the import scale is unknowable`)
  }
  const text = readUnityText(meta)
  const globalScale = Number(/^\s*globalScale:\s*([\d.eE+-]+)/m.exec(text)?.[1] ?? 1)
  const useFileScale = Number(/^\s*useFileScale:\s*(\d+)/m.exec(text)?.[1] ?? 1) !== 0
  const fileScale = useFileScale ? (unitScaleFactor ?? 1) / 100 : 1
  return { scale: fileScale * globalScale, globalScale, useFileScale, fileScale, unitScaleFactor }
}

const boundsCache = new Map()

/**
 * The mesh's axis-aligned bounds and its vertices, in UNITY LOCAL space -- that
 * is, file vertices times the import scale, still Unity-handed.
 *
 * `vertices` is returned because the colliders that need this are CONVEX mesh
 * colliders: the AABB is an over-approximation of a hull, and a caller that
 * wants the real shape should have the points. `hexTile` has ten of them.
 *
 * Errors rather than guessing when a file holds more than one mesh: "the first
 * Geometry node" is the sort of rule that is right until it is not.
 */
export function fbxMeshBounds(absFbxPath) {
  const key = absFbxPath.replace(/\\/g, '/')
  if (boundsCache.has(key)) return boundsCache.get(key)
  const { version, roots } = parseFbx(absFbxPath)
  const geometries = findAll(roots, 'Geometry').filter((g) =>
    g.children.some((c) => c.name === 'Vertices'),
  )
  if (geometries.length !== 1) {
    throw new Error(
      `fbx-bounds: ${absFbxPath} holds ${geometries.length} mesh geometries; ` +
        'this reader is only safe on a single-mesh file.',
    )
  }
  const raw = geometries[0].children.find((c) => c.name === 'Vertices').props[0]
  const unit = Number(propValue(roots, 'UnitScaleFactor') ?? 1)
  const imported = unityImportScale(absFbxPath, unit)
  const k = imported.scale

  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]
  const vertices = []
  for (let i = 0; i + 2 < raw.length; i += 3) {
    const v = [raw[i] * k, raw[i + 1] * k, raw[i + 2] * k]
    vertices.push(v)
    for (let a = 0; a < 3; a++) {
      if (v[a] < min[a]) min[a] = v[a]
      if (v[a] > max[a]) max[a] = v[a]
    }
  }
  const out = {
    fbxVersion: version,
    vertexCount: vertices.length,
    importScale: imported,
    vertices,
    min,
    max,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    center: [(max[0] + min[0]) / 2, (max[1] + min[1]) / 2, (max[2] + min[2]) / 2],
  }
  boundsCache.set(key, out)
  return out
}
