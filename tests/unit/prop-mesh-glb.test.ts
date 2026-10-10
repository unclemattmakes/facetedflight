// DEV-760 / DEV-761 (TL-9): the shared GLB writer's attribute set, pinned.
//
// The prop meshes are PUBLISHED with tangents, two UV sets and a VEC4 colour,
// and the shared writer used to emit only POSITION, NORMAL and a VEC3 colour.
// Moving `extract-props.mjs` onto it without these would have stripped UVs and
// tangents from every shipped prop GLB, and nothing structural would have said
// so: the positions are the same either way. So the set, the accessor types,
// the order in the buffer and the Unity -> glTF conversion are asserted here on
// a synthetic mesh, with no Unity project and no GPU needed.
//
// The other half of the evidence is not a unit test (it reads the legacy
// project): all sixteen `.asset` props were converted through the prototype and
// through this path and compared byte for byte, see
// docs/plan/code-reuse/progress/reuse-prop-mesh.md.

import { describe, expect, it } from 'vitest'
import { buildGlb } from '../../tools/assets/glb.mjs'
import { PROP_GLB_GENERATOR, propGlbFromMesh } from '../../tools/assets/prop-mesh-glb.mjs'
import type { DecodedMesh, ParsedMesh } from '../../tools/assets/unity-mesh-asset.mjs'

/** Just enough glTF reader: the JSON chunk and each accessor as a typed array. */
const readGlb = (buf: Buffer) => {
  expect(buf.readUInt32LE(0)).toBe(0x46546c67)
  const jsonLength = buf.readUInt32LE(12)
  // biome-ignore lint/suspicious/noExplicitAny: a parsed glTF document
  const json: any = JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8'))
  const binStart = 20 + jsonLength + 8
  const width: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 } as const
  const widthOf = (type: string): number => width[type] ?? Number.NaN
  const arrays = json.accessors.map(
    // biome-ignore lint/suspicious/noExplicitAny: an accessor of the glTF above
    (a: any) => {
      const view = json.bufferViews[a.bufferView]
      const Ctor = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array }[
        a.componentType as 5126 | 5123 | 5125
      ]
      const len = a.count * widthOf(a.type)
      const bytes = Buffer.from(
        buf.subarray(
          binStart + view.byteOffset,
          binStart + view.byteOffset + len * Ctor.BYTES_PER_ELEMENT,
        ),
      )
      return new Ctor(bytes.buffer, bytes.byteOffset, len)
    },
  )
  return { json, arrays }
}

// Two triangles, four vertices, every channel a prop carries. Unity space.
const parsed = {
  name: 'Synthetic',
  dialect: 'unity5',
  vertexCount: 4,
  channels: [
    { name: 'position', dimension: 3 },
    { name: 'normal', dimension: 3 },
    { name: 'color', dimension: 4 },
    { name: 'uv0', dimension: 2 },
    { name: 'uv1', dimension: 2 },
    { name: 'tangent', dimension: 4 },
  ],
  subMeshes: [
    { firstByte: 0, indexCount: 3, topology: 0, firstVertex: 0, vertexCount: 4 },
    { firstByte: 6, indexCount: 3, topology: 0, firstVertex: 0, vertexCount: 4 },
    { firstByte: 12, indexCount: 4, topology: 1, firstVertex: 0, vertexCount: 4 },
  ],
} as unknown as ParsedMesh

const mesh = {
  position: new Float32Array([0, 0, 1, 1, 0, 2, 0, 1, 3, 1, 1, 4]),
  normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 1, 0]),
  tangent: new Float32Array([1, 0, 0, 1, 1, 0, 2, -1, 1, 0, 0, 1, 0, 1, 0, 1]),
  uv0: new Float32Array([0, 0, 1, 0, 0, 0.25, 1, 1]),
  uv1: new Float32Array([0.5, 0.5, 0, 1, 1, 0, 0, 0]),
  colorFloat: new Float32Array([1, 0.5, 0.25, 1, 0, 0, 0, 0.5, 1, 1, 1, 1, 0.1, 0.2, 0.3, 0.4]),
  color: new Uint8Array(16),
  indices: new Uint16Array([0, 1, 2, 1, 3, 2, 0, 1, 2, 3]),
} as unknown as DecodedMesh

describe('the prop GLB attribute set (DEV-760)', () => {
  const { json, arrays } = readGlb(propGlbFromMesh(parsed, mesh))
  const primitive = json.meshes[0].primitives[0]

  it('is POSITION, NORMAL, TANGENT, TEXCOORD_0, TEXCOORD_1, COLOR_0, in that order', () => {
    expect(Object.keys(primitive.attributes)).toEqual([
      'POSITION',
      'NORMAL',
      'TANGENT',
      'TEXCOORD_0',
      'TEXCOORD_1',
      'COLOR_0',
    ])
  })

  it('types them VEC3, VEC3, VEC4, VEC2, VEC2, VEC4, all FLOAT, and names each accessor', () => {
    const named = Object.entries(primitive.attributes).map(([semantic, index]) => {
      const a = json.accessors[index as number]
      return [semantic, a.type, a.componentType, a.name]
    })
    expect(named).toEqual([
      ['POSITION', 'VEC3', 5126, 'POSITION'],
      ['NORMAL', 'VEC3', 5126, 'NORMAL'],
      ['TANGENT', 'VEC4', 5126, 'TANGENT'],
      ['TEXCOORD_0', 'VEC2', 5126, 'TEXCOORD_0'],
      ['TEXCOORD_1', 'VEC2', 5126, 'TEXCOORD_1'],
      ['COLOR_0', 'VEC4', 5126, 'COLOR_0'],
    ])
  })

  it('is one flat node named for the mesh, with the prototype generator string', () => {
    expect(json.nodes).toEqual([{ name: 'Synthetic', mesh: 0 }])
    expect(json.asset.generator).toBe(PROP_GLB_GENERATOR)
    expect(json.materials[0].name).toBe('vertexColor')
  })

  it('takes Unity to glTF: z negated (tangent z and w too), V flipped, colour as stored', () => {
    const at = (s: string) => arrays[primitive.attributes[s]]
    expect([...at('POSITION')]).toEqual([0, 0, -1, 1, 0, -2, 0, 1, -3, 1, 1, -4])
    expect([...at('NORMAL')]).toEqual([0, 0, -1, 0, 0, -1, 0, 0, 1, 0, 1, -0])
    expect([...at('TANGENT')]).toEqual([1, 0, -0, -1, 1, 0, -2, 1, 1, 0, -0, -1, 0, 1, -0, -1])
    expect([...at('TEXCOORD_0')]).toEqual([0, 1, 1, 1, 0, 0.75, 1, 0])
    expect([...at('TEXCOORD_1')]).toEqual([0.5, 0.5, 0, 0, 1, 1, 0, 1])
    expect([...at('COLOR_0')]).toEqual([...(mesh.colorFloat as Float32Array)])
  })

  it('reverses every winding, one primitive per TRIANGLE submesh, sharing the attributes', () => {
    expect(json.meshes[0].primitives).toHaveLength(2)
    expect(json.meshes[0].primitives[1].attributes).toEqual(primitive.attributes)
    expect([...arrays[primitive.indices]]).toEqual([0, 2, 1])
    expect([...arrays[json.meshes[0].primitives[1].indices]]).toEqual([1, 2, 3])
    expect(json.accessors[primitive.indices].componentType).toBe(5123)
  })
})

describe('buildGlb defaults are untouched (the five converters depend on them)', () => {
  const plain = readGlb(
    buildGlb({
      root: 'Root',
      parts: [
        {
          name: 'part',
          position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
          color: new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]),
          indices: new Uint16Array([0, 1, 2]),
          material: { name: 'm' },
        },
      ],
    }),
  )

  it('writes POSITION, NORMAL and a VEC3 COLOR_0, unnamed, under a root node', () => {
    const attributes = plain.json.meshes[0].primitives[0].attributes
    expect(Object.keys(attributes)).toEqual(['POSITION', 'NORMAL', 'COLOR_0'])
    expect(plain.json.accessors[attributes.COLOR_0].type).toBe('VEC3')
    expect(plain.json.accessors.some((a: { name?: string }) => 'name' in a)).toBe(false)
    expect(plain.json.nodes[0]).toMatchObject({ name: 'Root', children: [1] })
    expect(plain.json.asset.generator).toBe('tools/assets/convert-wings.mjs (DEV-322)')
  })

  it('writes a Uint32Array index buffer as UNSIGNED_INT and refuses a flat multi-part file', () => {
    const wide = readGlb(
      buildGlb({
        flat: true,
        parts: [
          {
            name: 'wide',
            position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
            indices: new Uint32Array([0, 1, 2]),
            material: {},
          },
        ],
      }),
    )
    expect(wide.json.accessors.at(-1).componentType).toBe(5125)
    expect(() =>
      buildGlb({
        flat: true,
        parts: [
          { name: 'a', position: new Float32Array(3), indices: new Uint16Array(0), material: {} },
          { name: 'b', position: new Float32Array(3), indices: new Uint16Array(0), material: {} },
        ],
      }),
    ).toThrow(/flat needs exactly one part/)
  })
})
