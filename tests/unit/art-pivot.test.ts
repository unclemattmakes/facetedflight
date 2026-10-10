// tests/unit/art-pivot.test.ts — DEV-365: the cockpit leans about 2016's
// `art_pivot`, and by 2016's Euler.
//
// ── Test the geometry, not the rotation ────────────────────────────────────
//
// CLAUDE.md's orientation lesson: a quaternion assertion is your belief written
// twice. So the claim here is a DISTANCE: for a given lean, where does each
// point of the cockpit round the eye end up — through the game's own code
// (`hangShipArt`, `hangJumpSeatArt`, `onPivot`, `poseArtPivot`) — against where
// 2016 puts it, composed from pieces the game does not share:
//
//   * the pivot, recomposed from the shipped prefab's `m_Father` chain (never
//     `_unet`), to the GameObject that carries `Rotator_Input` — found by the
//     script's guid out of its own `.meta`, not by a name;
//   * the lean, as Unity's `Quaternion.Euler(x, y, z)` defines it — z about
//     forward, then x, then y, each about the PARENT's axes, R = Ry·Rx·Rz — built
//     from three axis-angle matrices, not from a three Euler order string;
//   * the handedness, as the conjugation by the z mirror S·R·S, not as the
//     game's "(-pitch, 0, +roll)".
//
// Until DEV-365 the port stood the pivot at the ship's origin with the whole
// offset on the art, and composed the lean as three's `'ZXY'`. Both SEPARATES
// cases are in the suite, so the measure is shown to tell them apart: at the
// full 4.8 degree pitch the old pivot puts the cockpit round the eye 9.8 cm from
// 2016's, and the old order alone is 7.5 mm off at the full diagonal.
//
// The disk work — the gitignored GLBs, the read-only Unity project — is inside
// each `it`, and the guarded halves have one loud counterpart.

import fs from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { onPivot, type PointLike, poseArtPivot } from '@/game/art-pivot'
import { createShakeSample } from '@/game/cockpit-shake'
import { ART_PIVOT, ART_POSITION, EYE, hangShipArt } from '@/game/flight'
import { buildJumpSeatArt, JUMPSEAT_ART_PIVOT } from '@/game/jumpseat-art'
import { hangJumpSeatArt, JUMPSEAT_EYE } from '@/game/jumpseat-flight'
import { HOVERJET, JUMPSEAT } from '@/generated/constants.generated'
import { createHud } from '@/render/hud'
import { DASH_POSE_2016, placeHudAt } from '@/render/hud-dash'
import { measureWingTips } from '@/render/wing-trails'
import { legacyAvailable, legacyPath } from '../../tools/legacy-root.mjs'

const SHIPS = 'public/assets/ships'
const GLB = {
  cockpit: `${SHIPS}/hoverjet-cockpit.glb`,
  exterior: `${SHIPS}/hoverjet-exterior.glb`,
  body: `${SHIPS}/jumpseat-body.glb`,
  shell: `${SHIPS}/jumpseat-shell.glb`,
  strut: `${SHIPS}/jumpseat-strut.glb`,
} as const
const haveGlbs = Object.values(GLB).every((f) => fs.existsSync(f))
const haveLegacy = legacyAvailable()

const PREFAB = {
  hoverjet: 'Assets/Faceted Flight/Resources/PlayerShip_SR14_Photon.prefab',
  jumpseat: 'Assets/Faceted Flight/Resources/JumpSeat_Photon.prefab',
} as const
const ROTATOR_INPUT_META = 'Assets/Faceted Flight/Scripts/Rotator_Input.cs.meta'

/** Both vehicles lean to the same ceilings — read, not typed. */
const PITCH = HOVERJET.artRotator.pitchMax
const ROLL = HOVERJET.artRotator.rollMax
/** Pitch alone, roll alone, the diagonals: every sign, and the case that separates the order. */
const LEANS: readonly (readonly [number, number])[] = [
  [PITCH, 0],
  [0, ROLL],
  [PITCH, ROLL],
  [-PITCH, -ROLL],
  [PITCH, -ROLL],
  [-PITCH, ROLL],
]
/** The cockpit ROUND THE EYE: what the pilot sees move. */
const NEAR = 1.0
/** Float64 all the way from the same rest positions: nothing to allow for but rounding. */
const EXACT = 1e-6

const ORIGIN: PointLike = { x: 0, y: 0, z: 0 }
const REST = createShakeSample()

// ── 2016's lean, composed independently ─────────────────────────────────────

const AXIS = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
}
const about = (axis: THREE.Vector3, deg: number) =>
  new THREE.Matrix4().makeRotationAxis(axis, THREE.MathUtils.degToRad(deg))
/** Unity's `Quaternion.Euler(x, y, z)` as a matrix: Ry·Rx·Rz. */
const unityEuler = (x: number, y: number, z: number): THREE.Matrix4 =>
  about(AXIS.y, y).multiply(about(AXIS.x, x)).multiply(about(AXIS.z, z))
/** Unity space <-> three space: z negated. Its own inverse. */
const MIRROR = new THREE.Matrix4().makeScale(1, 1, -1)

/**
 * Where a ship-frame point (THREE space) goes when 2016 leans the `art_pivot`
 * standing at `pivot` (THREE space) to `Quaternion.Euler(pitch, 0, roll)`.
 */
const lean2016 = (point: THREE.Vector3, pivot: PointLike, pitch: number, roll: number) => {
  const r = MIRROR.clone()
    .multiply(unityEuler(pitch, 0, roll))
    .multiply(MIRROR)
  const at = new THREE.Vector3(pivot.x, pivot.y, pivot.z)
  return point.clone().sub(at).applyMatrix4(r).add(at)
}

// ── the game's side ────────────────────────────────────────────────────────

/** A ship group with an art pivot, posed level by the game's own `poseArtPivot`. */
const rig = (pivot: PointLike) => {
  const ship = new THREE.Group()
  const artPivot = new THREE.Group()
  ship.add(artPivot)
  poseArtPivot(artPivot, pivot, 0, 0, REST)
  return { ship, artPivot }
}

/** Every vertex under `root`, in the frame of `ship`, as the scene now stands. */
const verticesIn = (ship: THREE.Object3D, root: THREE.Object3D): THREE.Vector3[] => {
  ship.updateMatrixWorld(true)
  const out: THREE.Vector3[] = []
  root.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    const pos = mesh.geometry.getAttribute('position')
    for (let i = 0; i < pos.count; i++) {
      out.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld))
    }
  })
  return out
}

/**
 * Lean the pivot through the game's own pose and measure every vertex under
 * `root` within `NEAR` of `eye` against 2016's: the farthest disagreement, and
 * how far 2016 itself moved them, metres.
 */
const leanAgainst2016 = (
  ship: THREE.Object3D,
  artPivot: THREE.Object3D,
  root: THREE.Object3D,
  pivotAt: PointLike,
  pivot2016: PointLike,
  eye: THREE.Vector3,
  pitch: number,
  roll: number,
) => {
  poseArtPivot(artPivot, pivotAt, 0, 0, REST)
  const rest = verticesIn(ship, root)
  const near = rest.map((p, i) => [p, i] as const).filter(([p]) => p.distanceTo(eye) <= NEAR)
  poseArtPivot(artPivot, pivotAt, pitch, roll, REST)
  const leant = verticesIn(ship, root)
  poseArtPivot(artPivot, pivotAt, 0, 0, REST)
  let miss = 0
  let moved = 0
  for (const [p, i] of near) {
    const want = lean2016(p, pivot2016, pitch, roll)
    miss = Math.max(miss, (leant[i] as THREE.Vector3).distanceTo(want))
    moved = Math.max(moved, want.distanceTo(p))
  }
  return { count: near.length, miss, moved }
}

const parse = async (file: string): Promise<THREE.Object3D> => {
  const bytes = fs.readFileSync(file)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(buffer as ArrayBuffer, '', (gltf) => resolve(gltf.scene), reject)
  })
}

// ── 1. the pivot is 2016's ─────────────────────────────────────────────────

/** Raw Unity YAML documents by fileID. Plain Transforms only on these chains. */
const readPrefab = (rel: string): Map<string, string> => {
  const docs = new Map<string, string>()
  for (const part of fs.readFileSync(legacyPath(rel), 'utf8').split(/^(?=--- !u!)/m)) {
    const m = part.match(/^--- !u!\d+ &(-?\d+)/)
    if (m?.[1]) docs.set(m[1], part)
  }
  return docs
}
const field = (doc: string | undefined, key: string): string | undefined =>
  doc?.match(new RegExp(`^\\s*${key}: (.*)$`, 'm'))?.[1]?.trim()
const idIn = (value: string | undefined): string | undefined => value?.match(/fileID: (-?\d+)/)?.[1]
const nums = (doc: string, key: string): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const pair of (field(doc, key) ?? '').replace(/[{}]/g, '').split(',')) {
    const [k, v] = pair.split(':').map((s) => s.trim())
    if (k && v !== undefined) out[k] = Number(v)
  }
  return out
}

interface Link {
  readonly name: string
  readonly position: Record<string, number>
  readonly rotation: Record<string, number>
  readonly scale: Record<string, number>
}

/** Root-to-leaf `m_Father` chain of a Transform, by fileID. */
const chainOf = (docs: Map<string, string>, transform: string): Link[] => {
  const chain: Link[] = []
  let at: string | undefined = transform
  while (at && at !== '0') {
    const doc = docs.get(at) as string
    expect(doc.startsWith('--- !u!4 '), `transform ${at} is a plain Transform`).toBe(true)
    chain.unshift({
      name: field(docs.get(idIn(field(doc, 'm_GameObject')) ?? ''), 'm_Name') ?? '?',
      position: nums(doc, 'm_LocalPosition'),
      rotation: nums(doc, 'm_LocalRotation'),
      scale: nums(doc, 'm_LocalScale'),
    })
    at = idIn(field(doc, 'm_Father'))
  }
  return chain
}

/** A chain composed to the root, three space. */
const composed = (chain: readonly Link[]): THREE.Vector3 => {
  const m = new THREE.Matrix4()
  for (const l of chain) {
    m.multiply(
      new THREE.Matrix4().compose(
        new THREE.Vector3(l.position.x, l.position.y, l.position.z),
        new THREE.Quaternion(l.rotation.x, l.rotation.y, l.rotation.z, l.rotation.w),
        new THREE.Vector3(l.scale.x, l.scale.y, l.scale.z),
      ),
    )
  }
  const p = new THREE.Vector3().setFromMatrixPosition(m)
  return new THREE.Vector3(p.x, p.y, -p.z)
}

/** Every Transform whose GameObject is named `name`. */
const transformsNamed = (docs: Map<string, string>, name: string): string[] => {
  const hits: string[] = []
  for (const [id, doc] of docs) {
    if (!doc.startsWith('--- !u!4 ')) continue
    if (field(docs.get(idIn(field(doc, 'm_GameObject')) ?? ''), 'm_Name') === name) hits.push(id)
  }
  expect(hits.length, `a ${name}`).toBeGreaterThan(0)
  return hits
}
/** The one Transform named `name`, refused if there are two. */
const transformNamed = (docs: Map<string, string>, name: string): string => {
  const hits = transformsNamed(docs, name)
  expect(hits, `one ${name}`).toHaveLength(1)
  return hits[0] as string
}
/** No rest rotation and unit scale: the link `onPivot`'s subtraction needs. */
const expectIdentity = (l: Link): void => {
  for (const k of ['x', 'y', 'z'] as const) {
    expect(Math.abs(l.rotation[k] ?? Number.NaN), `${l.name} rotation.${k}`).toBe(0)
    expect(l.scale[k], `${l.name} scale.${k}`).toBe(1)
  }
  expect(l.rotation.w, `${l.name} rotation.w`).toBe(1)
}

/** The Transform of the GameObject that carries `Rotator_Input`, found by its script guid. */
const rotatorTransform = (docs: Map<string, string>): { transform: string; name: string } => {
  const guid = fs
    .readFileSync(legacyPath(ROTATOR_INPUT_META), 'utf8')
    .match(/^guid: ([0-9a-f]+)/m)?.[1]
  expect(guid, 'Rotator_Input.cs.meta has a guid').toBeTruthy()
  const holders = [...docs.values()]
    .filter((d) => d.startsWith('--- !u!114 ') && d.includes(`guid: ${guid}`))
    .map((d) => idIn(field(d, 'm_GameObject')) as string)
  expect(holders, 'exactly one Rotator_Input').toHaveLength(1)
  const go = docs.get(holders[0] as string) as string
  // The GameObject's own Transform: `Rotator_Input` turns `transform.localRotation`.
  const transform = [...docs.entries()].find(
    ([, d]) => d.startsWith('--- !u!4 ') && idIn(field(d, 'm_GameObject')) === holders[0],
  )?.[0] as string
  return { transform, name: field(go, 'm_Name') ?? '?' }
}

describe.skipIf(!haveLegacy)('the pivot is 2016’s, recomposed from the shipped prefabs', () => {
  it('HoverJet: Rotator_Input lives on art_pivot, and art_pivot composes to ART_PIVOT', () => {
    const docs = readPrefab(PREFAB.hoverjet)
    const rot = rotatorTransform(docs)
    // The sheet names the same GameObject — and `ART_PIVOT` is typed, so this is its guard.
    expect(rot.name).toBe(HOVERJET.artRotator.gameObject)
    const chain = chainOf(docs, rot.transform)
    expect(chain.map((l) => l.name)).toEqual(['PlayerShip_SR14_Photon', 'shipOffset', 'art_pivot'])
    const at = composed(chain)
    expect(at.x).toBeCloseTo(ART_PIVOT.x, 6)
    expect(at.y).toBeCloseTo(ART_PIVOT.y, 6)
    expect(at.z).toBeCloseTo(ART_PIVOT.z, 6)
    // No rest rotation or scale on the way, so `onPivot` is a subtraction.
    for (const l of chain) expectIdentity(l)
  })

  it('HoverJet: the art is under the pivot, and the eye is not', () => {
    const docs = readPrefab(PREFAB.hoverjet)
    const art = chainOf(docs, transformNamed(docs, 'FirstPerson'))
    expect(art.map((l) => l.name)).toContain('art_pivot')
    // ART_POSITION is typed to three places.
    const a = composed(art)
    expect(a.distanceTo(ART_POSITION)).toBeLessThan(1e-3)
    const eye = chainOf(docs, transformNamed(docs, 'CameraRoot_FirstPerson'))
    expect(eye.map((l) => l.name)).not.toContain('art_pivot')
    expect(composed(eye).distanceTo(EYE)).toBeLessThan(1e-4)
  })

  it('JumpSeat: Rotator_Input lives on art_pivot (1), and it composes to JUMPSEAT_ART_PIVOT', () => {
    const docs = readPrefab(PREFAB.jumpseat)
    const rot = rotatorTransform(docs)
    expect(rot.name).toBe(JUMPSEAT.artRotator.gameObject)
    const chain = chainOf(docs, rot.transform)
    expect(chain.map((l) => l.name)).toEqual(['JumpSeat_Photon', 'offset', 'art_pivot (1)'])
    // `JUMPSEAT_ART_PIVOT` is read off the sheet; this is the sheet against the prefab.
    expect(composed(chain).distanceTo(JUMPSEAT_ART_PIVOT)).toBeLessThan(1e-5)
    for (const l of chain) expectIdentity(l)
  })

  it('JumpSeat: the legs hang beside the pivot, not under it; the engines under it', () => {
    const docs = readPrefab(PREFAB.jumpseat)
    for (const legs of ['legs_front', 'legs_back']) {
      const chain = chainOf(docs, transformNamed(docs, legs)).map((l) => l.name)
      expect(chain, legs).toContain('offset')
      expect(chain, legs).not.toContain(JUMPSEAT.artRotator.gameObject)
    }
    for (const id of transformsNamed(docs, 'hover_engine (1)')) {
      expect(chainOf(docs, id).map((l) => l.name)).toContain(JUMPSEAT.artRotator.gameObject)
    }
  })
})

// ── 2. the lean, about the pivot, by 2016's Euler — no assets needed ───────

/** The eye and six points half a metre round it: the neighbourhood the pilot sees. */
const aroundEye = (eye: THREE.Vector3): THREE.Vector3[] => [
  eye.clone(),
  ...[-0.5, 0.5].flatMap((d) => [
    eye.clone().add(new THREE.Vector3(d, 0, 0)),
    eye.clone().add(new THREE.Vector3(0, d, 0)),
    eye.clone().add(new THREE.Vector3(0, 0, d)),
  ]),
]

/** Markers hung on a pivot at `pivot` the way the flights hang the cabin: `onPivot`. */
const markers = (points: readonly THREE.Vector3[], pivot: PointLike) => {
  const { ship, artPivot } = rig(pivot)
  const nodes = points.map((p) => {
    const node = new THREE.Object3D()
    node.position.copy(onPivot(p, pivot))
    artPivot.add(node)
    return node
  })
  return { ship, artPivot, nodes }
}

const worldOf = (ship: THREE.Object3D, node: THREE.Object3D) => {
  ship.updateMatrixWorld(true)
  return node.getWorldPosition(new THREE.Vector3())
}

describe('the lean turns the cockpit about 2016’s pivot, by 2016’s Euler', () => {
  for (const [vehicle, pivot, eye] of [
    ['HoverJet', ART_PIVOT, EYE],
    ['JumpSeat', JUMPSEAT_ART_PIVOT, JUMPSEAT_EYE],
  ] as const) {
    it(`${vehicle}: hung with onPivot, everything sits where it did at rest`, () => {
      const points = aroundEye(eye)
      const { ship, nodes } = markers(points, pivot)
      nodes.forEach((n, i) => {
        expect(worldOf(ship, n).distanceTo(points[i] as THREE.Vector3)).toBeLessThan(EXACT)
      })
    })

    for (const [pitch, roll] of LEANS) {
      it(`${vehicle}: at pitch ${pitch}, roll ${roll}, every point round the eye is where 2016 puts it`, () => {
        const points = aroundEye(eye)
        const { ship, artPivot, nodes } = markers(points, pivot)
        poseArtPivot(artPivot, pivot, pitch, roll, REST)
        nodes.forEach((n, i) => {
          const want = lean2016(points[i] as THREE.Vector3, pivot, pitch, roll)
          expect(worldOf(ship, n).distanceTo(want)).toBeLessThan(EXACT)
        })
      })
    }
  }

  it('the eye does not move, because it is not on the pivot — the lean moves what is round it', () => {
    // The markers above are the cockpit; the eye is `Flight.render`'s, off the
    // ship group alone. What 2016 moves AT the eye is the cabin's point there.
    const { ship, artPivot, nodes } = markers([EYE], ART_PIVOT)
    poseArtPivot(artPivot, ART_PIVOT, PITCH, 0, REST)
    const moved = worldOf(ship, nodes[0] as THREE.Object3D).distanceTo(EYE)
    // 0.748 m from the pivot, 4.8 degrees: ~6.3 cm. The port's origin pivot, 1.534 m away, moved it ~12.
    expect(moved).toBeGreaterThan(0.05)
    expect(moved).toBeLessThan(0.07)
  })

  it('SEPARATES: the pivot the port stood at the ship’s origin until DEV-365', () => {
    // The old hierarchy through the game's own functions: a pivot at the
    // origin, the offset carried on what hangs from it.
    const points = aroundEye(EYE)
    const { ship, artPivot, nodes } = markers(points, ORIGIN)
    const miss = (pitch: number, roll: number) => {
      poseArtPivot(artPivot, ORIGIN, pitch, roll, REST)
      return Math.max(
        ...nodes.map((n, i) =>
          worldOf(ship, n).distanceTo(lean2016(points[i] as THREE.Vector3, ART_PIVOT, pitch, roll)),
        ),
      )
    }
    // (I - R)·(0, 0.12, 1.16): a pure pitch swings the whole cockpit 9.8 cm off
    // 2016's; a pure roll 1.1 cm, because the pivot is only 0.12 m off the roll axis.
    expect(miss(PITCH, 0)).toBeGreaterThan(0.09)
    expect(miss(0, ROLL)).toBeGreaterThan(0.01)
    expect(miss(PITCH, ROLL)).toBeGreaterThan(0.09)
  })

  it('SEPARATES: the Euler order the port used until DEV-365 (three’s ZXY)', () => {
    // The old line, verbatim, at the RIGHT pivot — so only the order differs.
    const points = aroundEye(EYE)
    const { ship, artPivot, nodes } = markers(points, ART_PIVOT)
    const d = THREE.MathUtils.degToRad
    artPivot.rotation.set(-d(PITCH), 0, d(ROLL), 'ZXY')
    const miss = Math.max(
      ...nodes.map((n, i) =>
        worldOf(ship, n).distanceTo(lean2016(points[i] as THREE.Vector3, ART_PIVOT, PITCH, ROLL)),
      ),
    )
    // A yaw of about pitch x roll (0.44 degrees): millimetres, and not zero.
    expect(miss).toBeGreaterThan(0.002)
    // And on one axis alone the two orders agree — the diagonal is the case.
    artPivot.rotation.set(-d(PITCH), 0, 0, 'ZXY')
    ship.updateMatrixWorld(true)
    const alone = worldOf(ship, nodes[1] as THREE.Object3D).distanceTo(
      lean2016(points[1] as THREE.Vector3, ART_PIVOT, PITCH, 0),
    )
    expect(alone).toBeLessThan(EXACT)
  })
})

// ── 3. the shipped meshes, hung by the game ────────────────────────────────

describe.skipIf(!haveGlbs)('the shipped cockpits round the eye, hung by the game', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('HoverJet: every cockpit vertex within a metre of the eye leans where 2016’s does', async () => {
    const cockpit = await parse(GLB.cockpit)
    const { ship, artPivot } = rig(ART_PIVOT)
    hangShipArt(cockpit, ART_PIVOT)
    artPivot.add(cockpit)
    for (const [pitch, roll] of LEANS) {
      const r = leanAgainst2016(ship, artPivot, cockpit, ART_PIVOT, ART_PIVOT, EYE, pitch, roll)
      expect(r.count, 'a cockpit round the eye to measure').toBeGreaterThan(500)
      expect(r.miss, `pitch ${pitch} roll ${roll}: off 2016, m`).toBeLessThan(EXACT)
      // It moved — a lean of nothing would pass the line above.
      expect(r.moved).toBeGreaterThan(0.05)
    }
  })

  it('SEPARATES, on the mesh: the old hierarchy is ~10 cm off 2016 round the eye', async () => {
    const cockpit = await parse(GLB.cockpit)
    const { ship, artPivot } = rig(ORIGIN)
    hangShipArt(cockpit, ORIGIN)
    artPivot.add(cockpit)
    const r = leanAgainst2016(ship, artPivot, cockpit, ORIGIN, ART_PIVOT, EYE, PITCH, ROLL)
    // Measured: 10.0 cm off, where 2016 itself moves these vertices up to 14.3.
    expect(r.miss).toBeGreaterThan(0.09)
    expect(r.moved).toBeGreaterThan(0.13)
    expect(r.moved).toBeLessThan(0.15)
  })

  it('HoverJet: the readout, placed from the eye in the pivot’s frame, lands on 2016’s pose', () => {
    // `flight.ts` places it with `placeHudAt(hud, p, onPivot(EYE, ART_PIVOT))`
    // on the pivot; `hud-recess.test.ts` measures the SHIP-frame pose against
    // the mesh. The two must be one pose at rest, or the panel left its bezel.
    const context = {
      clearRect: () => {},
      fillRect: () => {},
      fillText: () => {},
      setTransform: () => {},
      beginPath: () => {},
      roundRect: () => {},
      fill: () => {},
      stroke: () => {},
      measureText: (s: string) => ({ width: s.length * 8 }),
    }
    const element = { width: 0, height: 0, getContext: () => context }
    vi.stubGlobal('document', { createElement: () => element })
    const p = { offset: DASH_POSE_2016.offset, tilt: DASH_POSE_2016.tilt, scale: 1 }
    const onShip = createHud()
    placeHudAt(onShip.object, p, EYE)
    const { ship, artPivot } = rig(ART_PIVOT)
    const hung = createHud()
    placeHudAt(hung.object, p, onPivot(EYE, ART_PIVOT))
    artPivot.add(hung.object)
    ship.add(onShip.object)
    ship.updateMatrixWorld(true)
    const a = hung.object.getWorldPosition(new THREE.Vector3())
    const b = onShip.object.getWorldPosition(new THREE.Vector3())
    expect(a.distanceTo(b)).toBeLessThan(EXACT)
  })

  it('HoverJet: the wing tips, measured in the pivot’s frame, are the hull’s tips', async () => {
    // `measureWingTips` reads the frame the art hangs in; the trails map them
    // through the pivot. Hung at 2016's pivot, they must land where the same
    // hull's tips are in the ship's frame (the racers' way, with no pivot).
    const onPivotHull = await parse(GLB.exterior)
    hangShipArt(onPivotHull, ART_PIVOT)
    const onShipHull = await parse(GLB.exterior)
    hangShipArt(onShipHull, ORIGIN)
    const inPivot = measureWingTips(onPivotHull)
    const inShip = measureWingTips(onShipHull)
    for (const side of ['port', 'starboard'] as const) {
      const a = new THREE.Vector3(inPivot[side].x, inPivot[side].y, inPivot[side].z).add(ART_PIVOT)
      const b = new THREE.Vector3(inShip[side].x, inShip[side].y, inShip[side].z)
      expect(a.distanceTo(b), side).toBeLessThan(EXACT)
    }
  })

  it('JumpSeat: the seat round the eye leans where 2016’s does, and the legs do not lean', async () => {
    const [body, shell, strut] = await Promise.all([
      parse(GLB.body),
      parse(GLB.shell),
      parse(GLB.strut),
    ])
    const art = buildJumpSeatArt({ body, shell, strut })
    const ship = new THREE.Group()
    const artPivot = new THREE.Group()
    poseArtPivot(artPivot, JUMPSEAT_ART_PIVOT, 0, 0, REST)
    hangJumpSeatArt(ship, artPivot, art)
    ship.add(artPivot)
    expect(art.legs.parent, 'the legs are on the ship').toBe(ship)
    const legsAtRest = verticesIn(ship, art.legs)
    for (const [pitch, roll] of LEANS) {
      const r = leanAgainst2016(
        ship,
        artPivot,
        art.object,
        JUMPSEAT_ART_PIVOT,
        JUMPSEAT_ART_PIVOT,
        JUMPSEAT_EYE,
        pitch,
        roll,
      )
      expect(r.count, 'a seat round the eye to measure').toBeGreaterThan(50)
      expect(r.miss, `pitch ${pitch} roll ${roll}: off 2016, m`).toBeLessThan(EXACT)
      expect(r.moved).toBeGreaterThan(0.03)
      poseArtPivot(artPivot, JUMPSEAT_ART_PIVOT, pitch, roll, REST)
      const legs = verticesIn(ship, art.legs)
      const swing = Math.max(...legs.map((v, i) => v.distanceTo(legsAtRest[i] as THREE.Vector3)))
      expect(swing, 'the legs stand still under the lean').toBeLessThan(EXACT)
      poseArtPivot(artPivot, JUMPSEAT_ART_PIVOT, 0, 0, REST)
    }
  })
})

describe.skipIf(haveGlbs && haveLegacy)('the guarded halves of this file', () => {
  it('are skipped only because the ship GLBs or the Unity project are absent', () => {
    expect(haveGlbs && haveLegacy).toBe(false)
  })
})
