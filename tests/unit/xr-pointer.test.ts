// tests/unit/xr-pointer.test.ts — the motion controller's laser. DEV-321.
//
// Matt, 2026-09-23: *"laser pointer from motion controller plz"* (NEXT.md #40).
// `input/pointer-hand.ts` picks the hand; `render/xr-pointer.ts` builds its
// ray and draws it. There is no headless WebXR worth maintaining (CLAUDE.md),
// so the headset here is object literals — the pattern `xr-head-pose.test.ts`
// and `xr-select.test.ts` already use.
//
// ── Why none of this compares the laser against another of our devices ────
//
// CLAUDE.md: *a test that compares two of your own devices has not tested
// either of them.* So the oracles are outside the port:
//
//   §1 the ray is worked BY HAND from three's documented conventions (a target
//      ray points down its −z; `rotation.y` yaws), and the HANGAR's own
//      exported layout — `tableGazeLocal`, `pickNearestSphere` — says which
//      table a ray is on. A pose aimed with three's own `Matrix4.lookAt` must
//      land on the table it was aimed at, while the level head lands on none.
//   §2 what is DRAWN is checked as geometry: the beam's far end, in world
//      space, sits where the ray says it hit — the property that stops what you
//      see and what you press drifting apart.
//   §3 the plate distance is checked against three's own `Raycaster`.
//   §5 the eye-layer rule reads `render/bloom.ts`'s own classifier.

import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  createPointerArbiter,
  DEFAULT_POINTER_HAND,
  type PointerHand,
  type PointerPullEvent,
  type PointerPullSource,
} from '@/input/pointer-hand'
import { isUiObject } from '@/render/bloom'
import {
  GAZE_RADIUS,
  pickNearestSphere,
  seatEyeLocal,
  TABLES_PER_PAGE,
  tableBearings,
  tableGazeLocal,
} from '@/render/hangar'
import {
  composeRay,
  createXrPointer,
  MISS_LENGTH,
  planeHitDistance,
  RETICLE_ANGLE,
  type XrPointerInputSource,
  type XrPoseSource,
} from '@/render/xr-pointer'
import { type HangarSpec, hangarSpecFor } from '@/sim/hangar'
import { appFileWith, appSource, codeOnly } from './helpers/app-source'
import { REPO as ROOT } from './helpers/repo-root'

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const pose = (position: THREE.Vector3, quaternion = new THREE.Quaternion()): THREE.Matrix4 =>
  new THREE.Matrix4().compose(position, quaternion, v(1, 1, 1))

/** Close in every component. `toBeCloseTo` per axis, named, so a failure says which. */
const expectVec = (got: THREE.Vector3, want: THREE.Vector3, what: string, digits = 9) => {
  expect(got.x, `${what}.x`).toBeCloseTo(want.x, digits)
  expect(got.y, `${what}.y`).toBeCloseTo(want.y, digits)
  expect(got.z, `${what}.z`).toBeCloseTo(want.z, digits)
}

/**
 * A running session's `renderer.xr`, made of literals: sources with a
 * handedness, a ray mode and a space, and a frame that knows each space's pose.
 * `bases` records every base space `getPose` was handed.
 */
const fakeXr = (
  sources: readonly (XrPointerInputSource & { pose: THREE.Matrix4 | null })[],
  opts: { presenting?: boolean; frame?: boolean } = {},
) => {
  const reference = { name: 'the reference space three uses for the head' }
  const bases: unknown[] = []
  const xr: XrPoseSource = {
    isPresenting: opts.presenting ?? true,
    getFrame: () =>
      opts.frame === false
        ? null
        : {
            getPose(space, base) {
              bases.push(base)
              const source = sources.find((s) => s.targetRaySpace === space)
              return source?.pose ? { transform: { matrix: source.pose.elements } } : null
            },
          },
    getReferenceSpace: () => reference,
    getSession: () => ({ inputSources: sources }),
  }
  return { xr, reference, bases }
}

const hand = (
  handedness: string,
  p: THREE.Matrix4 | null,
  targetRayMode = 'tracked-pointer',
): XrPointerInputSource & { pose: THREE.Matrix4 | null } => ({
  handedness,
  targetRayMode,
  targetRaySpace: { space: `${handedness}-${targetRayMode}` },
  pose: p,
})

// ────────────────────────────────────────────────────────────────────────────

describe('§1 the ray is the pose carried through the rig', () => {
  it('lands where a hand-worked rotation says, for a rig that is moved AND turned', () => {
    // The rig at (10, 2, −5), yawed +90° — the chair turned to face −x. A hand
    // 0.25 m right, 0.1 m down, 0.4 m ahead of the head, pointing straight on.
    //
    // By hand, from three's R_y(+90°): (x, y, z) -> (z, y, −x). So the hand's
    // offset (0.25, −0.1, −0.4) turns to (−0.4, −0.1, −0.25) and its −z forward
    // to (−1, 0, 0) — the way the chair faces. No matrix product is run here to
    // get the answer.
    const rig = new THREE.Group()
    rig.position.set(10, 2, -5)
    rig.rotation.set(0, Math.PI / 2, 0)
    const origin = new THREE.Vector3()
    const dir = new THREE.Vector3()
    const perUnit = composeRay(rig, pose(v(0.25, -0.1, -0.4)), origin, dir)
    expectVec(origin, v(9.6, 1.9, -5.25), 'origin')
    expectVec(dir, v(-1, 0, 0), 'direction')
    expect(perUnit, 'an unscaled rig: one metre per unit').toBeCloseTo(1, 12)
  })

  it('carries the hand’s own tilt, under the rig’s yaw', () => {
    // The same rig; the hand now points 30° DOWN. R_x(−30°) takes −z to
    // (0, −sin30, −cos30), and the rig's yaw then takes that to
    // (−cos30, −sin30, 0). Two rotations, each a line of trigonometry.
    const rig = new THREE.Group()
    rig.position.set(10, 2, -5)
    rig.rotation.set(0, Math.PI / 2, 0)
    const down = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 6, 0, 0))
    const dir = new THREE.Vector3()
    composeRay(rig, pose(v(0, 0, 0), down), new THREE.Vector3(), dir)
    expectVec(dir, v(-Math.cos(Math.PI / 6), -0.5, 0), 'direction')
    expect(dir.length(), 'a unit direction').toBeCloseTo(1, 12)
  })

  it('reads the rig where it is NOW, not where its stale matrixWorld left it', () => {
    // CLAUDE.md: `matrixWorld` is stale inside the XR frame callback until
    // `render()` runs — and the rig has just been MOVED this frame (the menu
    // puts it on the seat, the cockpit on the ship's eye). Compose once at A,
    // move to B without recomposing, and the ray must leave from B.
    const rig = new THREE.Group()
    rig.position.set(0, 0, 0)
    rig.updateMatrixWorld(true)
    rig.position.set(100, 50, -20)
    const origin = new THREE.Vector3()
    composeRay(rig, pose(v(0, 0, 0)), origin, new THREE.Vector3())
    expectVec(origin, v(100, 50, -20), 'origin after the rig moved')
  })

  it('includes the stage the rig hangs under', () => {
    // The rig is re-parented between the menu stage and the mission stage, so
    // the composition walks the parents too.
    const stage = new THREE.Group()
    stage.position.set(-2048, 0, -2048)
    const rig = new THREE.Group()
    rig.position.set(1, 2, 3)
    stage.add(rig)
    const origin = new THREE.Vector3()
    composeRay(rig, pose(v(0, 0, 0)), origin, new THREE.Vector3())
    expectVec(origin, v(-2047, 2, -2045), 'origin')
  })

  it('aims the table a hand points at, from the seat, while the level head aims none', () => {
    // The hangar's own layout is the oracle. The rig sits on the seat's eye,
    // level (DEV-264: the pitch is the neck's, never the rig's). A hand in the
    // lap is aimed at table 2's gaze sphere with three's own `lookAt` — which
    // turns −z onto the target — and the picker must say table 2. The head,
    // at the identity pose a headset starts in, looks level over every table:
    // that is what a neck is for, and it is what makes the LASER the thing
    // that reached the table in this test.
    const spec: HangarSpec = hangarSpecFor(9.35 / 2, 12)
    const bearings = tableBearings(TABLES_PER_PAGE)
    const centres: [number, number, number][] = bearings.map((b) => {
      const c = tableGazeLocal(spec, b)
      return [c.x, c.y, c.z]
    })
    const eye = seatEyeLocal(spec)
    const rig = new THREE.Group()
    rig.position.set(eye.x, eye.y, eye.z)

    const handAt = v(0.2, -0.45, -0.2)
    const target = 2
    const c = centres[target] as [number, number, number]
    // `lookAt(eye, target, up)` in the rig's space: the rig is unrotated, so
    // its space is the world less the eye.
    const aim = new THREE.Matrix4().lookAt(
      handAt,
      v(c[0] - eye.x, c[1] - eye.y, c[2] - eye.z),
      v(0, 1, 0),
    )
    const handPose = pose(handAt, new THREE.Quaternion().setFromRotationMatrix(aim))

    const origin = new THREE.Vector3()
    const dir = new THREE.Vector3()
    composeRay(rig, handPose, origin, dir)
    const pick = (o: THREE.Vector3, d: THREE.Vector3) =>
      pickNearestSphere(o.x, o.y, o.z, d.x, d.y, d.z, centres, GAZE_RADIUS)
    expect(pick(origin, dir), 'the table the hand points at').toBe(target)

    const headOrigin = new THREE.Vector3()
    const headDir = new THREE.Vector3()
    composeRay(rig, pose(v(0, 0, 0)), headOrigin, headDir)
    expect(pick(headOrigin, headDir), 'the level head is on nothing').toBe(-1)
  })
})

describe('§2 what is drawn is what is hit', () => {
  const rigged = (scale = 1) => {
    const rig = new THREE.Group()
    rig.position.set(3, 1.2, -7)
    rig.rotation.set(0, -0.7, 0)
    rig.scale.setScalar(scale)
    const pointer = createXrPointer()
    rig.add(pointer.object)
    const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.4, 0.3, 0.1))
    const { xr } = fakeXr([hand('right', pose(v(0.2, -0.3, -0.35), tilt))])
    pointer.sense(xr)
    return { rig, pointer }
  }

  const beamEnd = (pointer: ReturnType<typeof createXrPointer>): THREE.Vector3 => {
    const beam = pointer.object.getObjectByName('xr-pointer-beam') as THREE.Object3D
    return beam.localToWorld(v(0, 0, -1))
  }

  for (const scale of [1, 2]) {
    it(`the beam ends, and the reticle sits, where the ray hit — rig scale ${scale}`, () => {
      // Scale 2 is not a state this game reaches; it is the case where a beam
      // drawn in the rig's units and a distance measured in the world's would
      // part company, so it is the case that can tell whether they do.
      const { rig, pointer } = rigged(scale)
      const origin = new THREE.Vector3()
      const dir = new THREE.Vector3()
      expect(pointer.ray('right', rig, origin, dir)).toBe(true)
      const d = 1.37
      // The eye is NOT the hand: behind it and to one side, as a head is.
      const eye = origin.clone().add(v(-0.25, 0.3, 0.4))
      pointer.show('right', d, eye)
      const hit = origin.clone().addScaledVector(dir, d)
      expectVec(beamEnd(pointer), hit, 'beam end', 6)
      const reticle = pointer.object.getObjectByName('xr-pointer-reticle') as THREE.Object3D
      expect(reticle.visible, 'a hit shows the reticle').toBe(true)
      expectVec(reticle.getWorldPosition(new THREE.Vector3()), hit, 'reticle', 6)
      // The ring subtends the same ANGLE AT THE EYE at any distance: its outer
      // radius in world metres over the eye's distance is tan(RETICLE_ANGLE).
      // Sized from the hand instead, it came out a speck in the pinned photo.
      const edge = reticle.localToWorld(v(1, 0, 0))
      expect(edge.distanceTo(hit) / hit.distanceTo(eye)).toBeCloseTo(Math.tan(RETICLE_ANGLE), 6)
      expect(pointer.object.userData).toMatchObject({ hand: 'right', hit: true, distance: d })
    })
  }

  it('a miss draws a shorter dim beam and no reticle', () => {
    const { rig, pointer } = rigged()
    const origin = new THREE.Vector3()
    const dir = new THREE.Vector3()
    pointer.ray('right', rig, origin, dir)
    pointer.show('right', null, origin)
    expectVec(beamEnd(pointer), origin.clone().addScaledVector(dir, MISS_LENGTH), 'beam end', 6)
    const reticle = pointer.object.getObjectByName('xr-pointer-reticle') as THREE.Object3D
    expect(reticle.visible).toBe(false)
    expect(pointer.object.userData).toMatchObject({ hand: 'right', hit: false })
  })

  it('sense() starts the frame with the beam put away', () => {
    // The "no beam while flying" half: a frame in which no menu shows it has
    // none, without anybody having had to hide it.
    const { pointer } = rigged()
    pointer.show('right', 1, v(0, 0, 0))
    expect(pointer.object.visible).toBe(true)
    const { xr } = fakeXr([hand('right', pose(v(0, 0, 0)))])
    pointer.sense(xr)
    expect(pointer.object.visible, 'a new frame begins hidden').toBe(false)
    expect(pointer.object.userData.hand).toBe(null)
  })
})

describe('§2b which input sources can point', () => {
  it('only a tracked pointer with a pose, in a session, with a left or right hand', () => {
    const pointer = createXrPointer()
    const { xr, reference, bases } = fakeXr([
      hand('right', pose(v(0.2, 0, 0))),
      hand('left', pose(v(-0.2, 0, 0))),
      // Vision Pro's pinch: a ray only for the length of the pinch.
      hand('right', pose(v(0, 0, 0)), 'transient-pointer'),
      hand('none', pose(v(0, 0, 0)), 'gaze'),
      hand('none', pose(v(0, 0, 0))),
    ])
    expect([...pointer.sense(xr)].sort()).toEqual(['left', 'right'])
    // And the pose is asked for in the SAME space three reads the head in.
    expect(bases.length).toBeGreaterThan(0)
    for (const base of bases) expect(base).toBe(reference)
  })

  it('a transient pointer is not a laser, even when it is the only right hand', () => {
    // The separating sample. Above, the pinch shares its hand with a tracked
    // controller, so a filter that let it through would still produce
    // {left, right} — the first draft of this file used only that sample and
    // stayed green with the filter deleted.
    const pointer = createXrPointer()
    const { xr } = fakeXr([
      hand('right', pose(v(0, 0, 0)), 'transient-pointer'),
      hand('left', pose(v(-0.2, 0, 0))),
    ])
    expect([...pointer.sense(xr)]).toEqual(['left'])
  })

  it('a hand the runtime has lost is not a pointer', () => {
    const pointer = createXrPointer()
    const { xr } = fakeXr([hand('right', null), hand('left', pose(v(0, 0, 0)))])
    expect([...pointer.sense(xr)]).toEqual(['left'])
    expect(pointer.ray('right', new THREE.Group(), v(0, 0, 0), v(0, 0, 0))).toBe(false)
  })

  it('nothing points outside a session or before its first frame', () => {
    const pointer = createXrPointer()
    const sources = [hand('right', pose(v(0, 0, 0)))]
    expect(pointer.sense(fakeXr(sources, { presenting: false }).xr).size).toBe(0)
    expect(pointer.sense(fakeXr(sources, { frame: false }).xr).size).toBe(0)
    expect(pointer.sense(null).size).toBe(0)
  })
})

describe('§3 the pause plate: a distance, from the same plane pick uses', () => {
  it('agrees with three’s own Raycaster on a plate turned to face the eye', () => {
    // The plate stands like the pause plate does — a plane in its own z = 0,
    // turned with `lookAt` toward an eye above and to one side of it.
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.4))
    plate.position.set(0.3, 1.1, -0.9)
    plate.lookAt(v(0, 1.4, 0))
    plate.updateMatrixWorld(true)
    const raycaster = new THREE.Raycaster()
    for (const [ox, oy, oz, tx, ty] of [
      [0.25, 1.3, -0.35, 0.3, 1.1],
      [0, 1.4, 0, 0.4, 1.0],
      [-0.2, 1.2, -0.3, 0.2, 1.2],
    ] as const) {
      const origin = v(ox, oy, oz)
      const dir = v(tx, ty, -0.9).sub(origin).normalize()
      raycaster.set(origin, dir)
      const hit = raycaster.intersectObject(plate)[0]
      expect(hit, 'three hits the plate').toBeDefined()
      expect(planeHitDistance(origin, dir, plate)).toBeCloseTo(hit?.distance ?? Number.NaN, 9)
    }
  })

  it('is null behind the hand and along the plane', () => {
    const plate = new THREE.Object3D()
    plate.position.set(0, 0, -1)
    expect(planeHitDistance(v(0, 0, 0), v(0, 0, 1), plate), 'pointing away').toBe(null)
    expect(planeHitDistance(v(0, 0, 0), v(1, 0, 0), plate), 'parallel').toBe(null)
    expect(planeHitDistance(v(0, 0, 0), v(0, 0, -1), plate)).toBeCloseTo(1, 12)
  })
})

// ────────────────────────────────────────────────────────────────────────────

/** A fake session that can fire `select` from a given hand and ray mode. */
const pullSession = () => {
  const listeners = new Set<(event: PointerPullEvent) => void>()
  const session: PointerPullSource & {
    readonly listenerCount: number
    pull(handedness: string, targetRayMode?: string): void
  } = {
    addEventListener(type, listener) {
      if (type === 'select') listeners.add(listener)
    },
    removeEventListener(type, listener) {
      if (type === 'select') listeners.delete(listener)
    },
    get listenerCount() {
      return listeners.size
    },
    pull(handedness, targetRayMode = 'tracked-pointer') {
      for (const l of [...listeners]) l({ inputSource: { handedness, targetRayMode } })
    },
  }
  return session
}

const BOTH: ReadonlySet<PointerHand> = new Set<PointerHand>(['left', 'right'])
const LEFT_ONLY: ReadonlySet<PointerHand> = new Set<PointerHand>(['left'])
const NONE: ReadonlySet<PointerHand> = new Set<PointerHand>()

describe('§4 which hand points', () => {
  it('the right hand, when both can; the other when only it can; the head when none can', () => {
    const a = createPointerArbiter()
    expect(DEFAULT_POINTER_HAND).toBe('right')
    expect(a.choose(BOTH)).toBe('right')
    expect(a.choose(LEFT_ONLY)).toBe('left')
    expect(a.choose(NONE)).toBe(null)
  })

  it('the OTHER trigger takes the laser, and that pull confirms nothing', () => {
    const a = createPointerArbiter()
    const s = pullSession()
    a.follow(s)
    s.pull('left')
    expect(a.take(true, BOTH), 'the pull that moved the laser is spent').toBe(true)
    expect(a.choose(BOTH)).toBe('left')
    // Now it is the pointing hand, its next pull is the commit it looks like.
    s.pull('left')
    expect(a.take(true, BOTH), 'and the next one commits').toBe(false)
    expect(a.choose(BOTH)).toBe('left')
    // And back.
    s.pull('right')
    expect(a.take(true, BOTH)).toBe(true)
    expect(a.choose(BOTH)).toBe('right')
  })

  it('the pointing hand’s own pull is a commit', () => {
    const a = createPointerArbiter()
    const s = pullSession()
    a.follow(s)
    s.pull('right')
    expect(a.take(true, BOTH)).toBe(false)
    expect(a.choose(BOTH)).toBe('right')
  })

  it('in flight a pull moves nothing, and is not saved for the next menu', () => {
    // The left trigger is the BOOST. A pull in flight that moved the laser
    // would leave the plate opening on the hand you last boosted with; one that
    // sat in a buffer would move it the moment the plate came up.
    const a = createPointerArbiter()
    const s = pullSession()
    a.follow(s)
    s.pull('left')
    expect(a.take(false, BOTH)).toBe(false)
    expect(a.take(true, BOTH), 'spent in flight, not delivered to the menu').toBe(false)
    expect(a.choose(BOTH)).toBe('right')
  })

  it('a pull from a hand that cannot aim, or from a transient pointer, stays a commit', () => {
    const a = createPointerArbiter()
    const s = pullSession()
    a.follow(s)
    // Left asleep: there is no ray to hand the laser to.
    s.pull('left')
    expect(a.take(true, new Set<PointerHand>(['right']))).toBe(false)
    expect(a.choose(BOTH)).toBe('right')
    // A Vision Pro pinch is a commit and nothing else.
    s.pull('left', 'transient-pointer')
    expect(a.take(true, BOTH)).toBe(false)
    expect(a.choose(BOTH)).toBe('right')
    // With no hand pointing at all, the head aims and every pull commits.
    s.pull('left')
    expect(a.take(true, NONE)).toBe(false)
  })

  it('a sleeping pointer hands over and takes the laser back when it wakes', () => {
    const a = createPointerArbiter()
    expect(a.choose(LEFT_ONLY)).toBe('left')
    expect(a.preferred, 'the preference did not move').toBe('right')
    expect(a.choose(BOTH)).toBe('right')
  })

  it('follows the SESSION: one listener at 90 Hz, and a new session starts on the right', () => {
    const a = createPointerArbiter()
    const first = pullSession()
    for (let i = 0; i < 90; i++) a.follow(first)
    expect(first.listenerCount).toBe(1)
    first.pull('left')
    a.take(true, BOTH)
    expect(a.choose(BOTH)).toBe('left')
    // A pull that lands and then the session ends: it belonged to that session.
    first.pull('right')
    const second = pullSession()
    a.follow(second)
    expect(first.listenerCount, 'the old session let go').toBe(0)
    expect(a.choose(BOTH), 'a new session is a new player').toBe('right')
    expect(a.take(true, BOTH), 'and nothing carried over').toBe(false)
  })
})

describe('§5 it is UI, on both eyes', () => {
  it('every part is classified as UI and sits on no eye layer', () => {
    // Layers 1 and 2 are the WebXR EYES (DEV-141): an object on either is drawn
    // for one eye only. `isUiObject` is `render/bloom.ts`'s own classifier —
    // the thing that moves a surface onto UI_LAYER (3) — so it is the oracle
    // for "UI side of tone mapping's line", not a restatement of it.
    const pointer = createXrPointer()
    const meshes: THREE.Object3D[] = []
    pointer.object.traverse((o) => {
      expect(o.layers.isEnabled(1), `${o.name} is not on the left eye's layer`).toBe(false)
      expect(o.layers.isEnabled(2), `${o.name} is not on the right eye's layer`).toBe(false)
      if ((o as THREE.Mesh).isMesh) meshes.push(o)
    })
    expect(meshes.map((m) => m.name).sort()).toEqual(['xr-pointer-beam', 'xr-pointer-reticle'])
    for (const m of meshes) expect(isUiObject(m), `${m.name} is UI`).toBe(true)
  })

  it('is drawn OVER the pause plate — in three’s transparent list, after it', () => {
    // The first pinned photo: the beam reached the COMFORT row and the ring at
    // its end was missing. three draws the OPAQUE list before the TRANSPARENT
    // one whatever `renderOrder` says, and the plate (`render/pause.ts`) is
    // transparent and depth-test-off — so an opaque ring was drawn first and
    // painted over. The order is read out of three's own build, because it is
    // three's private arrangement and a version bump is when it would move.
    const build = fs.readFileSync(
      path.join(ROOT, 'node_modules/three/build/three.module.js'),
      'utf8',
    )
    const opaque = build.indexOf('if ( opaqueObjects.length > 0 ) renderObjects( opaqueObjects')
    const transparent = build.indexOf(
      'if ( transparentObjects.length > 0 ) renderObjects( transparentObjects',
      opaque,
    )
    expect(opaque, 'three renders an opaque list').toBeGreaterThan(-1)
    expect(transparent - opaque, 'and the transparent list right after it').toBeGreaterThan(0)
    expect(transparent - opaque).toBeLessThan(400)
    // And the plate is in that second list, which is what the pointer has to
    // join. Read from its source for the same reason: it is a canvas-texture
    // mesh that cannot be built in node.
    const plateFactory = fs.readFileSync(path.join(ROOT, 'src/render/ui-plate.ts'), 'utf8')
    expect(plateFactory).toMatch(/new THREE\.MeshBasicMaterial\(\{\s*map,\s*transparent: true,/)
    const pause = fs.readFileSync(path.join(ROOT, 'src/render/pause.ts'), 'utf8')
    const plateOrder = Number(/renderOrder: (\d+)/.exec(pause)?.[1])
    expect(plateOrder, 'the plate has a render order').toBeGreaterThan(0)

    const pointer = createXrPointer()
    for (const name of ['xr-pointer-beam', 'xr-pointer-reticle']) {
      const mesh = pointer.object.getObjectByName(name) as THREE.Mesh
      const material = mesh.material as THREE.Material
      expect(material.transparent, `${name} is in the transparent list`).toBe(true)
      expect(material.depthTest, `${name} ignores depth, like the plate`).toBe(false)
      expect(mesh.renderOrder, `${name} sorts after the plate`).toBeGreaterThan(plateOrder)
    }
  })
})

describe('§6 app.ts aims both menus with it, and spends the pulls every frame', () => {
  // Read inside each `it`: a describe body runs during collection (CLAUDE.md).
  // The whole boot tree, comments out (APP-SPLIT phase 0): "exactly one"
  // means one in the tree, not one in whichever file is read.
  const code = (): string => codeOnly(appSource())

  it('binds take() to a name and keeps the moving pull out of the confirm', () => {
    const src = code()
    const takes = [...src.matchAll(/^.*\bpointerArbiter\.take\s*\(.*$/gm)].map((m) => m[0])
    expect(takes, 'exactly one take() call site').toHaveLength(1)
    const line = takes[0] as string
    expect(line).toMatch(/(?:const|let)\s+\w+\s*=\s*pointerArbiter\.take\s*\(/)
    expect(line.includes('||'), 'not inside a || chain').toBe(false)
    const took = /(?:const|let)\s+(\w+)\s*=\s*pointerArbiter\.take/.exec(line)?.[1] as string
    // The select latch's result reaches the confirm only through a name that
    // has had the moving pull taken out of it.
    const committed = new RegExp(`(?:const|let)\\s+(\\w+)\\s*=\\s*xrSelected\\s*&&\\s*!${took}\\b`)
    const name = committed.exec(src)?.[1]
    expect(name, `xrSelected && !${took}, bound to a name`).toBeDefined()
    // The chain, from its declaration to the edge step that reads it.
    // The chain is sliced, so it is read out of the ONE file that holds it.
    const chainFile = codeOnly(appFileWith(/const confirm\s*=/).text)
    const confirm = /const confirm\s*=([\s\S]*?)\bconst confirmPressed\b/.exec(chainFile)?.[1] ?? ''
    expect(confirm.length, 'found the confirm chain').toBeGreaterThan(0)
    expect(confirm, 'the confirm reads the spent-aware name').toMatch(new RegExp(`\\b${name}\\b`))
    expect(/\bxrSelected\s*\|\|/.test(confirm), 'and not the raw latch').toBe(false)
  })

  it('senses the hands and follows the session, every frame', () => {
    const src = code()
    expect(src).toMatch(/xrPointer\.sense\(\s*render\.renderer\.xr\s*\)/)
    expect(src).toMatch(/pointerArbiter\.follow\(\s*render\.renderer\.xr\.getSession\(\)\s*\)/)
  })

  it('the tables and the pause rows are picked with the aimed ray, not the head alone', () => {
    const src = code()
    expect(src).toMatch(/hangar\.gaze\(\s*_aimOrigin,\s*_aimDirection\s*\)/)
    expect(src).toMatch(/flight\.pause\.pick\(\s*_aimOrigin,\s*_aimDirection,/)
    expect(/hangar\.gaze\(\s*cameraWorld/.test(src), 'no table picker left on the head').toBe(false)
    expect(/flight\.pause\.pick\(\s*cameraWorld/.test(src), 'no row picker left on the head').toBe(
      false,
    )
  })
})
