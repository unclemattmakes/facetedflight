// tests/unit/jumpseat-art.test.ts — the JumpSeat's meshes, measured against
// its own prefab.
//
// DEV-114. Two halves:
//
//  1. **The sheet.** `JUMPSEAT.art` is the extractor's walk of the shipped rig:
//     the chain to the art root, the pivots Unity gave each submesh, the three
//     engines, the eight leg struts, four colours. Asserted here against the
//     numbers the prefab and the `.mat` files SERIALISE — not against our own
//     arithmetic repeated — so a re-extraction that drifted fails on a reading.
//
//  2. **The files** (guarded, because assets are not in git). The orientation
//     lesson in full: every guard is a DISTANCE between converted geometry and
//     something Unity-native in the same prefab. Nothing here asserts a
//     quaternion, and each check also runs on the mirrored copy to record the
//     size of the signal it would see.
//
//     The asymmetry is fore-aft: the seat sits 0.93 m behind the art origin
//     and the shell's nose 3.0 m ahead of it. The converter's single-mesh rule
//     (`unmirror_x`) and its assembly rule (`unity_to_three`) agree on every
//     other asset in the game and put THIS seat 1.8 m apart — one under the
//     pilot's head, one in front of it. `collider_head` is a Unity-native box
//     and `camTarget_FirstPerson` a Unity-native point; both are the oracle.

import fs from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { describe, expect, it } from 'vitest'
import { buildJumpSeatArt, JUMPSEAT_ART_POSITION } from '@/game/jumpseat-art'
import { JUMPSEAT_EYE } from '@/game/jumpseat-flight'
import { JUMPSEAT } from '@/generated/constants.generated'

const ART = JUMPSEAT.art

describe('the rig, out of the sheet', () => {
  it('composes the art root to (0, -1.435, 0.88) with no rotation and no scale', () => {
    // FIND-jumpseat-05's numbers, by a different composer. Unity space.
    const c = ART.root.composed
    expect(c.position.x).toBeCloseTo(0, 6)
    expect(c.position.y).toBeCloseTo(-1.435, 6)
    expect(c.position.z).toBeCloseTo(0.88, 6)
    expect(c.rotation).toEqual({ w: 1, x: 0, y: 0, z: 0 })
    expect(c.scale).toEqual({ x: 1, y: 1, z: 1 })
    expect(ART.root.live).toBe(true)
    // Every link on the way down is active and unrotated: there is no yaw
    // anywhere for a SHIP_MODEL_YAW to come from.
    expect(ART.root.chain.map((n) => n.name)).toEqual([
      'offset',
      'art_pivot (1)',
      'art_firstPerson',
      'testArt (2)',
      'jumpseat_rough_01',
    ])
    for (const link of ART.root.chain) {
      expect(link.active, link.name).toBe(true)
      expect(link.local.rotation, link.name).toEqual({ w: 1, x: 0, y: 0, z: 0 })
      expect(link.local.scale, link.name).toEqual({ x: 1, y: 1, z: 1 })
    }
  })

  it('places the art in three space by the z-flip and nothing else', () => {
    // The relationship, not the value (trap 24).
    expect(JUMPSEAT_ART_POSITION.x).toBe(ART.root.composed.position.x)
    expect(JUMPSEAT_ART_POSITION.y).toBe(ART.root.composed.position.y)
    expect(JUMPSEAT_ART_POSITION.z).toBe(-ART.root.composed.position.z)
  })

  it('has five live submeshes and one dead one, and names which', () => {
    const live = ART.meshes
      .filter((m) => m.live)
      .map((m) => m.name)
      .sort()
    expect(live).toEqual(['botton', 'boxes', 'console_thing', 'seat', 'shell'])
    const dead = ART.meshes.filter((m) => !m.live)
    expect(dead).toHaveLength(1)
    // The dead `shell` is the one re-pointed at jumpseat_rough_02 and switched
    // off; the live one is jumpseat_shell_04's.
    expect(dead[0]?.mesh?.path).toBe('Assets/Faceted Flight/Meshes/jumpseat_rough_02.fbx')
    const liveShell = ART.meshes.find((m) => m.live && m.name === 'shell')
    expect(liveShell?.mesh?.path).toBe('Assets/Faceted Flight/Meshes/jumpseat_shell_04.fbx')
    expect(liveShell?.material?.path).toBe('Assets/SampleScenes/Materials/OrangeSmooth.mat')
  })

  it("carries Unity's OWN pivot for each submesh — the left-right oracle", () => {
    // Read off the FBX: seat RotationPivot x = -0.0025, console_thing +0.0272.
    // Unity's import of the same file puts them at +0.0025 and -0.0272. That is
    // the sign that tells the two importers apart, and it is what the file
    // tests below compare the converted GLB against.
    const seat = ART.meshes.find((m) => m.name === 'seat')
    const console = ART.meshes.find((m) => m.name === 'console_thing')
    expect(seat?.local.position.x).toBeCloseTo(0.002514, 6)
    expect(seat?.local.position.y).toBeCloseTo(2.716951, 6)
    expect(seat?.local.position.z).toBeCloseTo(-0.928156, 6)
    expect(console?.local.position.x).toBeCloseTo(-0.027232, 6)
  })

  it('puts 2016’s eye 12 cm below the port’s and 9 cm behind it, over the same seat', () => {
    // `camTarget_FirstPerson` (Unity) against `collider_head` (the port's eye,
    // three space). Same x; 0.121 m apart in y; 0.091 m apart in z — the
    // camera target sits at Unity z -0.051 and the head box's centre at +0.04.
    // Both are Unity-native points on the same seat, and either one pins the
    // fore-aft handedness of the converted mesh: 1.8 m of signal against 9 cm
    // of disagreement between the two.
    const eye = ART.eye.positionInShipRootSpace
    expect(ART.eye.live).toBe(true)
    expect(eye.x).toBeCloseTo(JUMPSEAT_EYE.x, 6)
    expect(Math.abs(-eye.z - JUMPSEAT_EYE.z)).toBeLessThan(0.1)
    expect(JUMPSEAT_EYE.y - eye.y).toBeCloseTo(0.121, 3)
  })

  it('has three live engines in an ASYMMETRIC triangle', () => {
    expect(ART.engines).toHaveLength(3)
    for (const e of ART.engines) {
      expect(e.live, e.name).toBe(true)
      expect(e.sphere?.builtinMesh, e.name).toBe(10207)
      expect(e.sphere?.material?.path).toBe('Assets/Faceted Flight/Materials/glowyMaterial.mat')
      // The cone around each disc is bought geometry and ships from R2 since
      // DEV-433; the files half below measures it against its disc.
      expect(e.projector?.mesh?.path).toContain('Projector04-Faceted')
      expect(e.projector?.live, e.name).toBe(true)
      expect(e.projector?.material?.path).toBe(
        'Assets/Faceted Flight/Meshes/Converted_Faceted_Meshes/Projector04_Mat.asset',
      )
    }
    const [aft, right, left] = ART.engines.map((e) => e.composed.position)
    // One aft on the centreline, two forward.
    expect(aft?.z).toBeLessThan(-0.9)
    expect(Math.abs(aft?.x ?? 1)).toBeLessThan(0.05)
    expect(right?.z).toBeCloseTo(left?.z as number, 3)
    // And the forward pair is NOT a mirror pair: +0.31 against -0.39.
    expect(right?.x).toBeGreaterThan(0.3)
    expect(left?.x).toBeLessThan(-0.38)
    expect(Math.abs((right?.x as number) + (left?.x as number))).toBeGreaterThan(0.07)
  })

  it('counts eight live hexTile struts, two per hinged leg', () => {
    const live = ART.legStruts.filter((s) => s.live)
    expect(live).toHaveLength(8)
    const perLeg = new Map<string, number>()
    for (const s of live) perLeg.set(s.leg, (perLeg.get(s.leg) ?? 0) + 1)
    expect([...perLeg.keys()].sort()).toEqual([
      'offset/legs_back/back_l',
      'offset/legs_back/back_r',
      'offset/legs_front/front_l',
      'offset/legs_front/front_r',
    ])
    for (const n of perLeg.values()) expect(n).toBe(2)
    // The ones that are counted and dead outnumber the live ones.
    expect(ART.legStruts.length).toBeGreaterThan(8)
  })

  it('carries each leg rigidbody’s FRAME, and it is the frame the struts are composed in', () => {
    // DEV-433. `legFrames` is the extractor's composition of the four HingeJoint
    // bodies; `legs[].composedPosition` and every strut's `composed` are two
    // other compositions of the same chains. They must agree — measured as
    // DISTANCES between points carried each way, not as quaternions.
    const trs = (t: {
      position: { x: number; y: number; z: number }
      rotation: { x: number; y: number; z: number; w: number }
      scale: { x: number; y: number; z: number }
    }) =>
      new THREE.Matrix4().compose(
        new THREE.Vector3(t.position.x, t.position.y, t.position.z),
        new THREE.Quaternion(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w),
        new THREE.Vector3(t.scale.x, t.scale.y, t.scale.z),
      )
    expect(ART.legFrames.map((f) => f.name).sort()).toEqual([
      'back_l',
      'back_r',
      'front_l',
      'front_r',
    ])
    for (const frame of ART.legFrames) {
      expect(frame.live, frame.name).toBe(true)
      expect(frame.composed.scale, frame.name).toEqual({ x: 1, y: 1, z: 1 })
      const joint = JUMPSEAT.legs.find((l) => l.name === frame.name)
      if (!joint) throw new Error(`no joint ${frame.name}`)
      const p = frame.composed.position
      const q = joint.composedPosition
      expect(Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z), frame.name).toBeLessThan(1e-6)
      const struts = ART.legStruts.filter((s) => s.live && s.leg === frame.path)
      expect(struts, frame.name).toHaveLength(2)
      for (const s of struts) {
        const viaFrame = trs(frame.composed).multiply(trs(s.local))
        const direct = trs(s.composed)
        // The prism's two axis ends (Unity mesh-local), carried both ways.
        for (const end of [
          new THREE.Vector3(0, 0.003, 0.0955),
          new THREE.Vector3(0, 0.503, 0.0955),
        ]) {
          const a = end.clone().applyMatrix4(viaFrame)
          const b = end.clone().applyMatrix4(direct)
          expect(a.distanceTo(b), `${frame.name}/${s.name}`).toBeLessThan(1e-4)
        }
      }
    }
    // Left and right are mirror images across the centreline: the prefab's
    // pairs are, and since DEV-530 so are the sim's (jumpseat-legs.test).
    const cap = (name: string): THREE.Vector3 => {
      const f = ART.legFrames.find((x) => x.name === name)
      if (!f) throw new Error(name)
      return new THREE.Vector3(0, -1.52, 0).applyMatrix4(trs(f.composed))
    }
    for (const [l, r] of [
      ['back_l', 'back_r'],
      ['front_l', 'front_r'],
    ] as const) {
      const a = cap(l)
      const b = cap(r)
      expect(a.x + b.x, `${l}/${r} x`).toBeCloseTo(0, 5)
      expect(a.y - b.y, `${l}/${r} y`).toBeCloseTo(0, 5)
      expect(a.z - b.z, `${l}/${r} z`).toBeCloseTo(0, 5)
    }
  })

  it('reads the four colours as the .mat files serialise them', () => {
    // Against Unity's files, not against our arithmetic: sRGB, as written.
    expect(ART.colors.darkGrey).toEqual([0.29104477, 0.29104477, 0.29104477, 1])
    expect(ART.colors.orangeSmooth).toEqual([1, 0.5966531, 0.28676468, 1])
    expect(ART.colors.lambert1Meshes).toEqual([0.9852941, 0.9852941, 0.9852941, 1])
    expect(ART.colors.grey).toEqual([0.5441177, 0.5441177, 0.5441177, 1])
  })
})

// ── Guarded, because the assets are not in git ───────────────────────────
//
// Same shape as `turn-indicator.test.ts`: the files are read inside the `it`,
// never at collection, and the block has a loud counterpart below.
const FILES = {
  body: 'public/assets/ships/jumpseat-body.glb',
  shell: 'public/assets/ships/jumpseat-shell.glb',
  strut: 'public/assets/ships/jumpseat-strut.glb',
  // DEV-433. Staged, not yet on R2: until it is pushed, a tree hydrated by
  // `pnpm assets:pull` alone skips this whole file's guarded half, loudly.
  cone: 'public/assets/ships/projector04-faceted.glb',
}
const AVAILABLE = Object.values(FILES).every((f) => fs.existsSync(f))

describe.skipIf(!AVAILABLE)('the files, against the prefab', () => {
  const parse = async (path: string): Promise<THREE.Object3D> => {
    const bytes = fs.readFileSync(path)
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    return new Promise((resolve, reject) => {
      new GLTFLoader().parse(buffer as ArrayBuffer, '', (gltf) => resolve(gltf.scene), reject)
    })
  }

  /** The art, built exactly as the game builds it, with world matrices ready. */
  const build = async (withCone = true) => {
    const [body, shell, strut, cone] = await Promise.all([
      parse(FILES.body),
      parse(FILES.shell),
      parse(FILES.strut),
      parse(FILES.cone),
    ])
    const art = buildJumpSeatArt({ body, shell, strut, cone: withCone ? cone : null })
    art.object.updateMatrixWorld(true)
    return art
  }
  const parseCone = () => parse(FILES.cone)

  /** Every vertex of the named node, in the SHIP frame (three space). */
  const verticesOf = (root: THREE.Object3D, name: string): THREE.Vector3[] => {
    const node = root.getObjectByName(name)
    if (!node) throw new Error(`no node '${name}'`)
    const out: THREE.Vector3[] = []
    node.traverse((n) => {
      const mesh = n as THREE.Mesh
      if (!mesh.isMesh) return
      const pos = mesh.geometry.getAttribute('position')
      for (let i = 0; i < pos.count; i++) {
        out.push(
          new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mesh.matrixWorld),
        )
      }
    })
    if (out.length === 0) throw new Error(`node '${name}' has no vertices`)
    return out
  }
  const centre = (pts: THREE.Vector3[]) => {
    const box = new THREE.Box3().setFromPoints(pts)
    return { box, mid: box.getCenter(new THREE.Vector3()), size: box.getSize(new THREE.Vector3()) }
  }
  /** The same geometry mirrored through the art root's plane, for the signal size. */
  const mirrored = (pts: THREE.Vector3[], axis: 'x' | 'z') =>
    pts.map((p) => {
      const q = p.clone().sub(JUMPSEAT_ART_POSITION)
      q[axis] = -q[axis]
      return q.add(JUMPSEAT_ART_POSITION)
    })

  it('puts the seat under the pilot’s head, not 1.8 m in front of it', async () => {
    const art = await build()
    const seat = verticesOf(art.object, 'seat')
    const { mid } = centre(seat)
    // Horizontal distance from the seat's centre to the head collider's centre.
    const horizontal = Math.hypot(mid.x - JUMPSEAT_EYE.x, mid.z - JUMPSEAT_EYE.z)
    expect(horizontal).toBeLessThan(0.2)
    // And the seat is BELOW the head: cushion-to-eye, a seated pilot.
    expect(JUMPSEAT_EYE.y - mid.y).toBeGreaterThan(0.4)
    expect(JUMPSEAT_EYE.y - mid.y).toBeLessThan(1.2)
    // The fore-aft mirror — what `unmirror_x` would have exported — is not a
    // rounding difference away; it is the seat in front of the pilot.
    const wrong = centre(mirrored(seat, 'z')).mid
    expect(Math.hypot(wrong.x - JUMPSEAT_EYE.x, wrong.z - JUMPSEAT_EYE.z)).toBeGreaterThan(1.5)
    art.dispose()
  })

  it('points the shell’s nose forward (three -z), well past the seat', async () => {
    const art = await build()
    const { box } = centre(verticesOf(art.object, 'shell'))
    const ahead = JUMPSEAT_EYE.z - box.min.z // metres of shell in front of the eye
    const behind = box.max.z - JUMPSEAT_EYE.z // metres of shell behind it
    expect(ahead).toBeGreaterThan(behind + 1.5)
    // The shell is an open seat's shell: it stops BELOW the eye.
    expect(box.max.y).toBeLessThan(JUMPSEAT_EYE.y)
    expect(JUMPSEAT_EYE.y - box.max.y).toBeGreaterThan(0.1)
    art.dispose()
  })

  it("lands each node's centre on the pivot Unity's import gave it — the left-right oracle", async () => {
    // `JUMPSEAT.art.meshes[].local.position` is Unity's reading of the FBX's
    // Maya pivots: for a node whose pivot was centred, it is the bounding-box
    // centre of the vertices Unity draws. `seat` is one (1,002 verts, centred
    // in all three axes) and `console_thing` is one in x. The GLB, placed by
    // the game, must agree in x and y as they are and in z to the flip.
    const art = await build()
    for (const name of ['seat', 'console_thing']) {
      const sheet = ART.meshes.find((m) => m.live && m.name === name)
      expect(sheet, name).toBeDefined()
      if (!sheet) continue
      const { mid } = centre(verticesOf(art.object, name))
      const local = mid.clone().sub(JUMPSEAT_ART_POSITION)
      expect(local.x, `${name} x`).toBeCloseTo(sheet.local.position.x, 3)
      if (name === 'seat') {
        expect(local.y, `${name} y`).toBeCloseTo(sheet.local.position.y, 3)
        expect(local.z, `${name} z`).toBeCloseTo(-sheet.local.position.z, 3)
      }
    }
    // The x-mirror — the state every asset shipped in once — misses the
    // console's pivot by twice its offset. Small, and not a rounding error.
    const consoleSheet = ART.meshes.find((m) => m.live && m.name === 'console_thing')
    const flipped = centre(mirrored(verticesOf(art.object, 'console_thing'), 'x')).mid
    const miss = Math.abs(
      flipped.x - JUMPSEAT_ART_POSITION.x - (consoleSheet?.local.position.x ?? 0),
    )
    expect(miss).toBeGreaterThan(0.05)
    art.dispose()
  })

  it('is the size Unity draws it: the file’s centimetres times globalScale 100', async () => {
    const art = await build()
    // `botton` is the longest node fore-aft, `shell` the longest overall.
    expect(centre(verticesOf(art.object, 'botton')).size.z).toBeCloseTo(3.4741, 2)
    expect(centre(verticesOf(art.object, 'shell')).size.z).toBeCloseTo(5.8476, 2)
    // And the seat is a seat: under a metre wide.
    expect(centre(verticesOf(art.object, 'seat')).size.x).toBeLessThan(1)
    art.dispose()
  })

  it('draws the three engine discs where the prefab’s spheres are', async () => {
    // Unity-native transforms, flipped by the same rule as the meshes. If the
    // discs and the body ever disagreed about the flip, the discs would sit
    // beside the hull instead of under it.
    const art = await build()
    const { box } = centre(verticesOf(art.object, 'botton'))
    for (const e of ART.engines) {
      const disc = art.object.getObjectByName(`engine_${e.name.replace(/\W+/g, '_')}`)
      expect(disc, e.name).toBeDefined()
      if (!disc || !e.sphere) continue
      expect(disc.position.x).toBeCloseTo(e.sphere.composed.position.x, 6)
      expect(disc.position.z).toBeCloseTo(-e.sphere.composed.position.z, 6)
      // Inside the bottom plate's footprint.
      expect(disc.position.x).toBeGreaterThan(box.min.x)
      expect(disc.position.x).toBeLessThan(box.max.x)
      expect(disc.position.z).toBeGreaterThan(box.min.z)
      expect(disc.position.z).toBeLessThan(box.max.z)
    }
    art.dispose()
  })

  it('stretches 2016’s prism, 0.5 m thick and 1.90 m across, into each leg', async () => {
    const art = await build()
    const leg =
      art.object.getObjectByName('leg_0_back_l') ??
      art.object.children.find((c) => c.name.startsWith('leg_'))
    expect(leg).toBeDefined()
    const strut = leg?.children[0] as THREE.Mesh
    strut.geometry.computeBoundingBox()
    const size = strut.geometry.boundingBox?.getSize(new THREE.Vector3())
    expect(size?.y).toBeCloseTo(0.5, 3)
    expect(size?.x).toBeCloseTo(1.9021, 3)
    art.dispose()
  })

  // ── DEV-433: the eight struts and the three cones ──────────────────────

  /** Every vertex of one mesh, in the ship's frame (three space). */
  const worldVerts = (mesh: THREE.Mesh): THREE.Vector3[] => {
    const pos = mesh.geometry.getAttribute('position')
    const out: THREE.Vector3[] = []
    for (let i = 0; i < pos.count; i++) {
      out.push(
        new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mesh.matrixWorld),
      )
    }
    return out
  }

  it('lands every leg’s real prisms on its own capsule, and the pair meets at a knee', async () => {
    // The orientation lesson's oracle for the legs: the leg's own
    // `CapsuleCollider`, a Unity-native primitive on the GameObject the struts
    // hang off (h 3.04, centred on the leg's origin, along its y) — with the
    // REAL prism, whose pentagon is not centred (z -1.00..0.81 in three space).
    // Measured in the leg's frame, from each prism's two end faces:
    //   foot end to the bottom cap   4.5 cm (back pair) · 11 cm (front)
    //   damper end off the axis     10 cm (back) · 1 cm (front), 1.66 / 2.30 m up
    const art = await build()
    for (const [i, joint] of JUMPSEAT.legs.entries()) {
      const leg = art.object.getObjectByName(`leg_${i}_${joint.name}`)
      if (!leg) throw new Error(`no leg ${joint.name}`)
      const toLeg = leg.matrixWorld.clone().invert()
      const struts = leg.children.filter((c) => c.name.startsWith('strut_')) as THREE.Mesh[]
      expect(struts, joint.name).toHaveLength(2)
      const ends = struts.map((s) => {
        const vs = worldVerts(s).map((v) => v.applyMatrix4(toLeg)) // leg frame, three space
        // The prism's long axis is the strut's own y; its end faces are the
        // vertices at the two extremes along it.
        const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(s.quaternion).normalize()
        const along = vs.map((v) => v.dot(axis))
        const faceAt = (t: number) =>
          new THREE.Box3()
            .setFromPoints(vs.filter((_, k) => Math.abs((along[k] as number) - t) < 1e-3))
            .getCenter(new THREE.Vector3())
        const a = faceAt(Math.min(...along))
        const b = faceAt(Math.max(...along))
        return a.y < b.y ? { low: a, high: b } : { low: b, high: a }
      })
      const [e1, e2] = ends
      if (!e1 || !e2) throw new Error('two struts')
      const [legStrut, damper] = e1.low.y < e2.low.y ? [e1, e2] : [e2, e1]
      const bottom = new THREE.Vector3(0, -1.52, 0)
      expect(legStrut.low.distanceTo(bottom), `${joint.name} foot on the cap`).toBeLessThan(0.12)
      expect(Math.hypot(damper.high.x, damper.high.z), `${joint.name} damper`).toBeLessThan(0.12)
      expect(damper.high.y, `${joint.name} damper above the hinge`).toBeGreaterThan(
        joint.anchor.y + 0.5,
      )
      // The damper's other end is 0.73 to 1.18 m off the leg's axis, fore or
      // aft: mirror it through the leg's own y-x plane — the handedness the
      // z-flip could still get wrong — and it lands 1.4 to 2.4 m away.
      const mirrored = damper.low.clone().setZ(-damper.low.z)
      expect(damper.low.distanceTo(mirrored), `${joint.name} mirror signal`).toBeGreaterThan(1.4)
    }
    art.dispose()
  })

  it('draws a cone round each engine disc, centred on it, the size 2016 draws it', async () => {
    // Each cone is placed from its OWN sheet row (`projector.composed`) and each
    // disc from ITS row (`sphere.composed`), so a cone sitting on its disc is two
    // independent Unity transforms agreeing. Measured: 1.2 cm between the disc's
    // centre and the cone's vertex centroid on all three, on a cone that reaches
    // 0.44 m from that centroid around a disc of radius 0.27.
    const art = await build()
    let cones = 0
    for (const e of ART.engines) {
      const key = e.name.replace(/\W+/g, '_')
      const disc = art.object.getObjectByName(`engine_${key}`) as THREE.Mesh | undefined
      const cone = art.object.getObjectByName(`cone_${key}`) as THREE.Mesh | undefined
      expect(disc, e.name).toBeDefined()
      expect(cone, e.name).toBeDefined()
      if (!disc || !cone) continue
      cones++
      const vs = worldVerts(cone)
      const centroid = vs
        .reduce((s, v) => s.add(v), new THREE.Vector3())
        .multiplyScalar(1 / vs.length)
      const centre = disc.getWorldPosition(new THREE.Vector3())
      expect(centre.distanceTo(centroid), e.name).toBeLessThan(0.03)
      // The disc is inside the cone: the cone reaches past the disc's rim.
      const reach = Math.max(...vs.map((v) => v.distanceTo(centroid)))
      const rim = 0.5 * Math.max(disc.scale.x, disc.scale.z)
      expect(reach, e.name).toBeGreaterThan(rim)
      expect(reach, e.name).toBeLessThan(2 * rim)
      // The fore-aft mirror of the cone — its z not negated — is nowhere near.
      expect(
        centre.distanceTo(centroid.clone().setZ(-centroid.z)),
        `${e.name} mirror`,
      ).toBeGreaterThan(0.2)
      // Projector04_Mat, built by the wing's own builder: vertex colour on.
      const m = cone.material as THREE.MeshStandardMaterial
      expect(m.name).toBe('Projector04_Mat')
      expect(m.vertexColors).toBe(true)
    }
    expect(cones).toBe(3)
    art.dispose()
  })

  it('exports the cone as Unity’s own mesh with z negated, against its m_LocalAABB', async () => {
    // `m_LocalAABB` is Unity's number, serialised in the .asset; the converter
    // carries it in the root node's extras. The mesh is off-centre in z by
    // 0.19, so the converted bounds centre must sit at -0.19: a converter that
    // forgot the negation would leave it at +0.19.
    const scene = await parseCone()
    const root = scene.getObjectByName('projector04-faceted')
    const aabb = (
      root?.userData as {
        unityLocalAABB?: {
          center: { x: number; y: number; z: number }
          extent: { x: number; y: number; z: number }
        }
      }
    )?.unityLocalAABB
    expect(aabb).toBeDefined()
    if (!aabb) return
    const mesh = scene.getObjectByName('cone') as THREE.Mesh
    mesh.geometry.computeBoundingBox()
    const box = mesh.geometry.boundingBox as THREE.Box3
    const c = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    expect(Math.abs(aabb.center.z)).toBeGreaterThan(0.15)
    expect(c.x).toBeCloseTo(aabb.center.x, 4)
    expect(c.y).toBeCloseTo(aabb.center.y, 4)
    expect(c.z).toBeCloseTo(-aabb.center.z, 4)
    expect(size.x).toBeCloseTo(2 * aabb.extent.x, 4)
    expect(size.y).toBeCloseTo(2 * aabb.extent.y, 4)
    expect(size.z).toBeCloseTo(2 * aabb.extent.z, 4)
  })

  it('draws the seat without its cones when the cone did not load', async () => {
    // `projector04-faceted.glb` reaches players only when it is pushed to R2; a
    // build ahead of the push must still draw the seat (loadJumpSeatArt).
    const art = await build(false)
    let found = 0
    art.object.traverse((o) => {
      if (o.name.startsWith('cone_')) found++
    })
    expect(found).toBe(0)
    expect(art.object.getObjectByName('engine_hover_engine_1_')).toBeDefined()
    art.dispose()
  })
})

describe.skipIf(AVAILABLE)('the files — assets not hydrated', () => {
  it('is skipped loudly rather than passing vacuously', () => {
    expect(AVAILABLE).toBe(false)
  })
})
