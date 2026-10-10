// tests/unit/checkpoint-ring-asset.test.ts — is the shipped gate the 2016 gate?
//
// ── Why an asset needs a test at all ──────────────────────────────────────
//
// Because `checkpoint-ring.glb` shipped for a while holding the WRONG MESH and
// nothing noticed. It was a 100-vertex, 72-triangle Maya pipe called `pPipe1`,
// from some other file entirely, while `Prefabs/Checkpoint_Ring.prefab` points
// at `Meshes/jumpGate_diamond.fbx` — a 1,698-vertex, 908-triangle hexagonal
// frame. Right filename, roughly ring-shaped, completely wrong. Matt spotted it
// in a screenshot: "your rings aren't the same jump gate things i was using."
//
// CLAUDE.md's rule about tracing provenance was written for numbers. This is
// the same failure applied to geometry, so it gets the same treatment: the
// prefab names the FBX, the sheet carries that path, and this asks the file on
// disk whether it agrees.
//
// ── The three things it checks ────────────────────────────────────────────
//
//  1. **Identity** — the node came out of `jumpGate_diamond.fbx`, and it has
//     the triangle count that file has.
//  2. **Orientation** — the gate stands UP. Maya authored the frame lying in
//     its XZ plane and the glTF carries a 90-degree X rotation on the node;
//     the loader used to drop it, and gates rendered flat like puddles. A
//     dropped rotation swaps the y and z extents, so measuring them catches it.
//  3. **Agreement with the prefab** — scaled by the frame's own 3.885, the
//     frame must contain all 18 studs. That is the check that ties the asset to
//     the sheet: two different-sized gates would each look plausible alone.
//
// The asset is gitignored (CLAUDE.md rule 7), so the skip is LOUD.

import fs from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { describe, expect, it } from 'vitest'
import { bakedGeometry } from '@/game/rings'
import { PROPS } from '@/generated/constants.generated'
import { createModeMark, gateMarkGeometry } from '@/render/mode-mark'
import { flipPosition, flipQuaternion, unityPose } from '@/render/unity-space'

const GLB = 'public/assets/props/checkpoint-ring.glb'
const available = fs.existsSync(GLB)

const RING = PROPS.checkpointRing

/** Parse the GLB straight out of the file, so no server or fetch is involved. */
const parse = async (): Promise<THREE.Object3D> => {
  const bytes = fs.readFileSync(GLB)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  return await new Promise((resolve, reject) => {
    new GLTFLoader().parse(buffer as ArrayBuffer, '', (gltf) => resolve(gltf.scene), reject)
  })
}

describe.skipIf(!available)('checkpoint-ring.glb is jumpGate_diamond', () => {
  it('came out of the FBX the prefab names', () => {
    // The sheet reads the mesh reference off the prefab, so this is the link in the chain that
    // says which file the asset pipeline should have converted.
    expect(RING.frame.mesh).toBe('Assets/Faceted Flight/Meshes/jumpGate_diamond.fbx')
    expect(RING.frame.active).toBe(true)
  })

  it('carries the node name and triangle count of that mesh, not a stand-in', () => {
    // `pPipe1` / 72 triangles was the wrong asset. `jumpGate_00_noPosRot:polySurface16` / 908 is
    // the right one. Naming both makes the failure message say which mistake happened.
    return parse().then((scene) => {
      const names: string[] = []
      let triangles = 0
      scene.traverse((node) => {
        const mesh = node as THREE.Mesh
        if (!mesh.isMesh) return
        names.push(node.name)
        const index = mesh.geometry.getIndex()
        triangles +=
          (index ? index.count : (mesh.geometry.getAttribute('position')?.count ?? 0)) / 3
      })
      expect(names.join(','), 'glTF node name').toMatch(/jumpGate/i)
      expect(triangles).toBe(908)
    })
  })

  it('stands UP once its node transform is baked', async () => {
    const geometry = bakedGeometry(await parse())
    expect(geometry).not.toBeNull()
    const box = new THREE.Box3().setFromBufferAttribute(
      (geometry as THREE.BufferGeometry).getAttribute('position') as THREE.BufferAttribute,
    )
    const size = box.getSize(new THREE.Vector3())

    // 6.24 wide, 9.07 tall, 4.47 deep. Drop the node's 90-degree X rotation and y and z swap —
    // 4.47 tall and 9.07 deep — which is a gate lying flat. Both are asserted, because asserting
    // only the height would pass on a mesh that is 9.07 in every direction.
    expect(size.x).toBeCloseTo(6.24, 1)
    expect(size.y).toBeCloseTo(9.07, 1)
    expect(size.z).toBeCloseTo(4.47, 1)
    // A gate is something you fly THROUGH, so it is taller than it is deep. This is the assertion
    // that would still hold if the mesh were ever re-authored.
    expect(size.y).toBeGreaterThan(size.z * 1.5)
  })

  it('is the frame the holotable draws, rolled WIDE and one unit tall (DEV-314, DEV-326)', async () => {
    // DEV-314 held a hand-computed `GATE_WIDTH_OVER_HEIGHT` (9.074 / 6.24) to
    // this mesh, because the table drew a torus stretched to it. DEV-326 draws
    // the mesh itself, so the constant is gone and the claim moves to the thing
    // the table actually draws: `gateMarkGeometry` of this very file.
    //
    // Asserted as a RELATIONSHIP with the raw bake, not as the frame chain
    // restated (trap 24): the prefab's 90-degree roll turns the baked HEIGHT
    // into the mark's WIDTH. Drop the roll and the ratio inverts (0.69 for
    // 1.45) — the gate on end, Matt's *"tall and skinny, i want them wide"*.
    const scene = await parse()
    const raw = new THREE.Box3()
      .setFromBufferAttribute(
        (bakedGeometry(scene) as THREE.BufferGeometry).getAttribute(
          'position',
        ) as THREE.BufferAttribute,
      )
      .getSize(new THREE.Vector3())
    const mark = gateMarkGeometry(scene) as THREE.BufferGeometry
    const box = new THREE.Box3().setFromBufferAttribute(
      mark.getAttribute('position') as THREE.BufferAttribute,
    )
    const size = box.getSize(new THREE.Vector3())
    expect(size.x, 'the gate came out taller than it is wide').toBeGreaterThan(size.y)
    expect(size.x / size.y).toBeCloseTo(raw.y / raw.x, 3)
    // Normalised: one unit tall, centred on its opening, so a table sizes it
    // with one number and turns it about its own middle (DEV-354).
    expect(size.y).toBeCloseTo(1, 6)
    expect(box.getCenter(new THREE.Vector3()).length()).toBeLessThan(1e-6)
    // And the thin axis is z — horizontal, so the flight-plan mark, which turns
    // about the vertical, shows its opening to the side on every turn.
    expect(size.z).toBeLessThan(size.y)
  })

  it('opens along z, so the table flies you THROUGH it (DEV-326)', async () => {
    // The orientation lesson: test the geometry, not the rotation. A frame is
    // an OPENING, so looked at down its through-axis the middle is empty —
    // DEV-314 counted zero vertices there on the baked mesh. The mark is posed
    // and rescaled, so the count is taken again on what the table draws: z must
    // be empty in the middle, and the other two projections must not be.
    const mark = gateMarkGeometry(await parse()) as THREE.BufferGeometry
    const pos = mark.getAttribute('position') as THREE.BufferAttribute
    const box = new THREE.Box3().setFromBufferAttribute(pos)
    const size = box.getSize(new THREE.Vector3())
    const half = [size.x / 4, size.y / 4, size.z / 4]
    /** Vertices inside the middle half of the projection ALONG `axis`. */
    const inMiddle = (axis: 0 | 1 | 2): number => {
      const [a, b] = [0, 1, 2].filter((k) => k !== axis) as [number, number]
      let n = 0
      for (let i = 0; i < pos.count; i++) {
        const v = [pos.getX(i), pos.getY(i), pos.getZ(i)]
        if (
          Math.abs(v[a] as number) < (half[a] as number) &&
          Math.abs(v[b] as number) < (half[b] as number)
        )
          n++
      }
      return n
    }
    expect(inMiddle(2), 'something stands in the opening, looking down z').toBe(0)
    expect(inMiddle(0)).toBeGreaterThan(100)
    expect(inMiddle(1)).toBeGreaterThan(100)
  })

  it('stands on a flight-plan table UPRIGHT, turning, in the sheet’s green (DEV-354)', async () => {
    // The two halves together, on the real mesh, as the flight-plan table
    // draws it: one gate, turned about the vertical to a random heading. At
    // EVERY heading the opening must be horizontal — clear along the frame's
    // own thin axis, measured on the drawn vertices — and it must wear
    // `checkpoint_enabled`'s colour. Swept over a quarter turn in eight steps,
    // because an opening facing the ceiling reads as clear from above at one
    // heading and blocked at another, and a single heading could land on either.
    const art = gateMarkGeometry(await parse()) as THREE.BufferGeometry
    const mark = createModeMark('ring', art, 0.52, 0.18)
    const mesh = mark.object.getObjectByName('mode-mark-gate') as THREE.Mesh
    for (let step = 0; step < 8; step++) {
      mark.update(90 / 27.5 / 8)
      mark.object.updateWorldMatrix(true, true)
      const pos = art.getAttribute('position') as THREE.BufferAttribute
      const pts: THREE.Vector3[] = []
      for (let i = 0; i < pos.count; i++) {
        pts.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld))
      }
      const box = new THREE.Box3().setFromPoints(pts)
      const c = box.getCenter(new THREE.Vector3())
      // The frame's through-axis, as drawn: its local z, carried by the matrix.
      const through = new THREE.Vector3(0, 0, 1).transformDirection(mesh.matrixWorld)
      expect(Math.abs(through.y), 'the gate is tipping over as it turns').toBeLessThan(1e-9)
      const across = new THREE.Vector3(0, 1, 0).cross(through).normalize()
      const offsets = pts.map((p) => p.clone().sub(c))
      /** The drawn extent along a direction — the frame's own, at this heading. */
      const extent = (dir: THREE.Vector3) => {
        const along = offsets.map((d) => d.dot(dir))
        return Math.max(...along) - Math.min(...along)
      }
      const high = extent(new THREE.Vector3(0, 1, 0))
      const wide = extent(across)
      const deep = extent(through)
      // Looking along the through-axis: the middle half of the opening is empty.
      let blocked = 0
      let edgeOn = 0
      for (const d of offsets) {
        const midY = Math.abs(d.y) < high / 4
        if (midY && Math.abs(d.dot(across)) < wide / 4) blocked++
        if (midY && Math.abs(d.dot(through)) < deep / 4) edgeOn++
      }
      expect(blocked, 'looking through the gate, the opening is blocked').toBe(0)
      // The control: seen across, edge-on, the side posts fill the middle.
      // Without it an empty mesh would pass the line above.
      expect(edgeOn, 'seen edge-on there is no frame at all').toBeGreaterThan(100)
    }
    const green = new THREE.Color().setRGB(
      RING.frameColor[0] as number,
      RING.frameColor[1] as number,
      RING.frameColor[2] as number,
      THREE.SRGBColorSpace,
    )
    const material = mesh.material as THREE.MeshStandardMaterial
    expect(material.color.r).toBeCloseTo(green.r, 6)
    expect(material.color.g).toBeCloseTo(green.g, 6)
    expect(material.color.b).toBeCloseTo(green.b, 6)
    expect(material.opacity).toBeCloseTo(RING.frameColor[3] as number, 6)
    mark.dispose()
  })

  it('contains all 18 studs once the prefab scale is applied', async () => {
    // The cross-check. A frame at the wrong scale looks perfectly reasonable on its own; it only
    // gives itself away next to the studs, which carry their own transforms and were always right.
    const geometry = bakedGeometry(await parse()) as THREE.BufferGeometry

    const pose = (p: readonly number[], r: readonly number[], s: readonly number[]) =>
      new THREE.Matrix4().compose(
        flipPosition(new THREE.Vector3(), {
          x: p[0] as number,
          y: p[1] as number,
          z: p[2] as number,
        }),
        flipQuaternion(new THREE.Quaternion(), {
          x: r[0] as number,
          y: r[1] as number,
          z: r[2] as number,
          w: r[3] as number,
        }),
        new THREE.Vector3(s[0] as number, s[1] as number, s[2] as number),
      )

    const framed = geometry.clone()
    framed.applyMatrix4(pose(RING.frame.position, RING.frame.rotation, RING.frame.scale))
    const box = new THREE.Box3().setFromBufferAttribute(
      framed.getAttribute('position') as THREE.BufferAttribute,
    )

    // 24 x 35 m of gate.
    const size = box.getSize(new THREE.Vector3())
    expect(size.x).toBeCloseTo(24.2, 0)
    expect(size.y).toBeCloseTo(35.2, 0)

    expect(RING.studs.length).toBe(18)
    const centre = new THREE.Vector3()
    for (const stud of RING.studs) {
      centre.setFromMatrixPosition(pose(stud.position, stud.rotation, stud.scale))
      expect(
        box.containsPoint(centre),
        `stud at ${centre.toArray().map((v) => v.toFixed(1))}`,
      ).toBe(true)
    }
  })

  it('leaves room for the trigger sphere the game actually tests against', async () => {
    // `m_Radius 0.92` under a transform scaled 12.29 is an 11.31 m sphere in prefab space, and the
    // level JSON carries 22.6 m at ring scale 2. So the aperture has to be at least that wide, or
    // the gate you can fly through is smaller than the gate that counts.
    const geometry = bakedGeometry(await parse()) as THREE.BufferGeometry
    const scale = RING.frame.scale[0] as number
    const box = new THREE.Box3().setFromBufferAttribute(
      geometry.getAttribute('position') as THREE.BufferAttribute,
    )
    const halfWidth = (box.getSize(new THREE.Vector3()).x / 2) * scale
    expect(halfWidth).toBeGreaterThan(11.31)
  })
})

describe.skipIf(available)('checkpoint ring asset — not hydrated', () => {
  it('is skipped loudly rather than passing vacuously', () => {
    expect(available).toBe(false)
  })
})

// ── The gate was standing on end, and the prefab always said so ───────────
//
// Matt, with a 2016 screenshot: *"right now the gates are 'upright' and should
// be rotated 90. (they're currently tall and skinny, i want them wide)"*
//
// Neither the frame nor the studs is a child of the ring root. Both hang under a
// node carrying `m_LocalEulerAnglesHint: {x: 0, y: 0, z: 90}`, and the port
// composed both straight onto the gate's world matrix — so every gate in the
// game was rolled 90 degrees from where the prefab put it.
//
// This is trap 11's lesson again and it is the reason it can be tested at all: a
// hexagonal frame is symmetric enough to look plausible either way, but the 18
// STUDS are Unity-native geometry in the same prefab, and a cage cannot be
// wider than it is tall and also taller than it is wide.
describe('the gate is WIDE, and the prefab is the oracle', () => {
  type Pivot = {
    readonly position: readonly number[]
    readonly rotation: readonly number[]
    readonly scale: readonly number[]
  }
  const chain = (pivots: readonly Pivot[]): THREE.Matrix4 => {
    const out = new THREE.Matrix4()
    for (const p of pivots) out.multiply(unityPose(p.position, p.rotation, p.scale))
    return out
  }

  it('carries a 90-degree roll about z on BOTH chains', () => {
    // The number that was missing. Not "a rotation" — this one, on both, or the
    // studs come off the frame.
    for (const [name, pivots] of [
      ['frame', RING.framePivots],
      ['studs', RING.studPivots],
    ] as const) {
      expect(pivots.length, name).toBeGreaterThan(0)
      const e = new THREE.Euler().setFromRotationMatrix(chain(pivots), 'XYZ')
      expect((e.x * 180) / Math.PI, `${name} x`).toBeCloseTo(0, 4)
      expect((e.y * 180) / Math.PI, `${name} y`).toBeCloseTo(0, 4)
      expect(Math.abs((e.z * 180) / Math.PI), `${name} z`).toBeCloseTo(90, 3)
    }
  })

  it('puts the stud cage WIDER than it is tall, which it was not', () => {
    // The whole bug, measured on geometry rather than on a rotation. Unrolled,
    // this cage is 19.0 wide and 30.1 tall; rolled, 30.1 by 19.0. Matt's 2016
    // screenshot shows a gate with a flat top and bottom, i.e. the second.
    const pivot = chain(RING.studPivots)
    const min = [Infinity, Infinity, Infinity]
    const max = [-Infinity, -Infinity, -Infinity]
    const v = new THREE.Vector3()
    for (const stud of RING.studs) {
      v.set(stud.position[0] as number, stud.position[1] as number, stud.position[2] as number)
      // Unity space -> three, then through the pivot, the way rings.ts does it.
      v.z = -v.z
      v.applyMatrix4(pivot)
      const c = [v.x, v.y, v.z]
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i] as number, c[i] as number)
        max[i] = Math.max(max[i] as number, c[i] as number)
      }
    }
    const width = (max[0] as number) - (min[0] as number)
    const height = (max[1] as number) - (min[1] as number)
    const depth = (max[2] as number) - (min[2] as number)
    expect(width).toBeGreaterThan(height)
    expect(width / height).toBeCloseTo(30.08 / 19.0, 1)
    // The through-axis stays the thin one, or the gate is not a gate any more.
    expect(depth).toBeLessThan(height)
  })

  it('rolls the FRAME the same way, so the cage still fits it', () => {
    // The frame and the studs hang off nodes at DIFFERENT depths — the studs
    // one deeper, under an identity `highlightCubes`. Assuming they shared a
    // parent is what the extractor's guard caught on its first run; this is the
    // consequence that would have shipped: a wide cage around a tall frame.
    const f = chain(RING.framePivots)
    const s = chain(RING.studPivots)
    for (let i = 0; i < 16; i++) {
      expect(f.elements[i], `element ${i}`).toBeCloseTo(s.elements[i] as number, 6)
    }
  })
})
